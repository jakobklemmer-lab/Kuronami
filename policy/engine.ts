import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { appendEvent } from "../runtime/events/log.js";
import { redactText } from "../runtime/redaction/redact.js";
import { ApprovalRequiredError, findApprovalDecision, requestPolicyApproval } from "./approvals.js";
import { runHooks } from "./hooks.js";
import { describeResource, describeResourceForLog, subjectFor } from "./resource.js";
import { RISK_LEVELS, type RiskLevel, assertRiskLevel } from "./risk.js";
import { DEFAULT_RULES, evaluateRules } from "./rules.js";
import { classifySecret } from "./secrets.js";
import {
  type ApprovalRef,
  type PolicyDecision,
  type PolicyHook,
  type PolicyPathResolver,
  type PolicyRequest,
  type PolicyResource,
  type PolicyRule,
  type PolicyVerdict,
  strictest,
} from "./types.js";

/**
 * Die Policy-Engine. Vier Entscheidungsebenen aus Abschnitt 10, in dieser Reihenfolge:
 *
 *   1. **Hooks** — eigener Code vor der Ausführung (`hooks.ts`)
 *   2. **Statische Regeln** — Allow/Deny/Ask nach Tool, Pfad, Domain, Geheimnisklasse (`rules.ts`)
 *   3. **Sessionmodus** — `ask`, `accept_edits`, `bypass_in_sandbox`
 *   4. **Laufzeit-Rückfrage** — der Mensch entscheidet (`approvals.ts`)
 *
 * Darunter liegt die Risikostufe als **Boden**: was die Tabelle in Abschnitt 10 an Freigabe
 * verlangt, verlangt sie unabhängig davon, ob eine Regel geschrieben wurde. Ohne diesen Boden
 * wäre die Tabelle nur die Vorgabe für einen leeren Regelsatz, und "hartes Schreiben braucht
 * eine Freigabe" hinge daran, dass jemand die passende Regel nicht gelöscht hat.
 *
 * **Wie die Ebenen zusammengerechnet werden — die zentrale Entscheidung dieser Datei:**
 *
 *   * Es gewinnt die **schärfste** Aussage, nicht die letzte und nicht die spezifischste.
 *     `deny` schlägt `ask` schlägt `allow`.
 *   * Ein `allow` von Hook oder Regel ist damit eine **Abstention mit Namen**: es steht im
 *     Freigabepfad, damit später sichtbar ist, dass die Ebene lief und nichts einzuwenden
 *     hatte, aber es senkt nichts. Der Grund ist unangenehm konkret: könnte ein `allow` den
 *     Boden senken, wäre die stärkste Zusage des ganzen Systems ("hartes Schreiben nur mit
 *     Freigabe") genau einen zu breit geratenen Glob weit entfernt vom Verschwinden — und
 *     zwar lautlos, weil ein zu breites `allow` sich wie ein funktionierendes System anfühlt.
 *   * Die **einzige** Ebene, die senken darf, ist der Sessionmodus, und nur den Boden, nie
 *     das Wort einer anderen Ebene. Das ist die dokumentierte Ausnahme aus Abschnitt 10
 *     (`accept_edits`, `bypass_in_sandbox`) und sie ist eine Entscheidung des Menschen über
 *     die ganze Session, nicht eine Zeile in einer Regeldatei. Auch sie greift nie bei
 *     `destructive`.
 *
 * Der Router ruft die Engine, nicht umgekehrt (Abschnitt 4.7). Es gibt keinen zweiten
 * Aufrufer und keinen Weg an ihr vorbei: ein Tool-Handler bekommt seine Aufrufdaten nur mit
 * einer `PolicyGrant`, und die kann außerhalb dieser Datei niemand herstellen.
 */

/**
 * Die Freigabe für **einen** Aufruf, ausgestellt von der Engine.
 *
 * Die Klasse wird bewusst nicht als Wert exportiert, nur als Typ. Zusammen mit dem privaten
 * Feld macht das den Typ nominal: kein Objektliteral kann eine Freigabe vortäuschen, und
 * `ToolInvocation.policy` ist damit ein Beweis und keine Behauptung. Die Zusage aus
 * Abschnitt 4.7 — "Es gibt keinen Pfad, auf dem ein Tool ohne Policy-Prüfung ausgeführt
 * wird" — steht so im Typsystem und nicht in einem Kommentar über einem `if`.
 */
class Grant {
  readonly #auditId: string;

  constructor(
    auditId: string,
    readonly declaredRisk: RiskLevel,
    readonly effectiveRisk: RiskLevel,
    readonly subject: string,
    readonly approval: ApprovalRef | null,
    readonly path: readonly PolicyVerdict[],
  ) {
    this.#auditId = auditId;
  }

  /** Die Kennung des Audit-Eintrags, der zu diesem Aufruf schon geschrieben wurde. */
  get auditId(): string {
    return this.#auditId;
  }
}

export type PolicyGrant = Grant;

export type PolicyOutcome =
  | { kind: "allow"; grant: PolicyGrant }
  | {
      kind: "deny";
      auditId: string;
      summary: string;
      effectiveRisk: RiskLevel;
      subject: string;
      path: PolicyVerdict[];
    };

export interface SandboxState {
  /**
   * Läuft dieser Prozess nachweislich in der Sandbox aus Abschnitt 4.6?
   *
   * Bewusst **nicht** aus der Umgebung gelesen. Eine Variable, die den Sessionmodus
   * `bypass_in_sandbox` scharf schaltet, wäre der Schalter, der irgendwann gesetzt ist —
   * beim Debuggen, "nur kurz", in genau dem Lauf, der danach etwas Hartes schreibt. Dasselbe
   * Argument wie beim nicht abschaltbaren Redaction-Filter (S07). Solange `exec.run` und der
   * Container nicht stehen, ist das hier `false`, und `bypass_in_sandbox` fällt sichtbar auf
   * `ask` zurück, statt still zu wirken.
   */
  active: boolean;
  reason: string;
}

export interface PolicyEngineConfig {
  /** Löst Pfade auf. Injiziert, damit `policy/` nicht auf `tools/fs/paths.ts` zeigt. */
  resolvePath: PolicyPathResolver;
  /** Vorgabe: `DEFAULT_RULES`. Eine leere Liste ist erlaubt — der Boden bleibt. */
  rules?: readonly PolicyRule[];
  hooks?: readonly PolicyHook[];
  sandbox?: SandboxState;
}

export interface PolicyEngine {
  readonly rules: readonly PolicyRule[];
  readonly hooks: readonly PolicyHook[];
  readonly sandbox: SandboxState;
  /**
   * Entscheidet über einen Aufruf. Drei Ausgänge, und nur einer davon führt zu einer
   * Ausführung:
   *
   *   * `allow` mit einer `PolicyGrant` — der Audit-Eintrag steht bereits im Protokoll;
   *   * `deny` — eine Antwort auf den Aufruf; der Router macht daraus eine Fehlerhülle, das
   *     Modell liest sie im selben Lauf und kann einen anderen Weg wählen (Abschnitt 7);
   *   * **wirft** `ApprovalRequiredError` — keine Antwort, sondern ein Haltepunkt. Die
   *     Rückfrage steht danach im Protokoll, die Session auf `awaiting_user`.
   *
   * Dass der dritte Fall wirft und nicht zurückkommt, ist Absicht: ein Rückgabewert
   * "bräuchte noch eine Freigabe" wäre einer, den ein Aufrufer versehentlich ignorieren kann.
   */
  check(pool: Pool, request: PolicyRequest): Promise<PolicyOutcome>;
}

/**
 * Der Boden aus der Tabelle in Abschnitt 10, ohne jede Regel und ohne Modus.
 *
 * `soft_write` steht hier auf `allow`, weil die Tabelle "automatisch **im
 * Arbeitsverzeichnis**" sagt: außerhalb davon ist es kein weiches Schreiben mehr, und genau
 * das hebt die Regel `write-outside-artifact-zone` auf `hard_write` an. Die Einschränkung
 * steht also in der Regel, nicht in einer zweiten Fassung dieser Tabelle.
 */
function floorFor(effectiveRisk: RiskLevel): PolicyDecision {
  switch (effectiveRisk) {
    case "read":
    case "soft_write":
      return "allow";
    case "hard_write":
    case "destructive":
      return "ask";
  }
}

const FLOOR_REASON: Record<RiskLevel, string> = {
  read: "Lesen ist automatisch erlaubt (Abschnitt 10).",
  soft_write: "Weiches Schreiben ist im Arbeitsverzeichnis automatisch erlaubt (Abschnitt 10).",
  hard_write: "Hartes Schreiben braucht eine Freigabe (Abschnitt 10).",
  destructive: "Zerstörende Aktionen brauchen immer eine Freigabe (Abschnitt 10).",
};

/**
 * Ebene 3. Der Modus darf **nur den Boden** senken und nur in den beiden Fällen, die
 * Abschnitt 10 nennt. Gibt `undefined` zurück, wenn er nichts ändert — dann steht auch nichts
 * im Freigabepfad, was dort nichts zu suchen hat.
 */
function modeVerdict(
  request: PolicyRequest,
  resource: PolicyResource,
  effectiveRisk: RiskLevel,
  sandbox: SandboxState,
): PolicyVerdict | undefined {
  if (floorFor(effectiveRisk) !== "ask") return undefined;

  if (effectiveRisk === "destructive") {
    // Kein Modus hebt "immer Freigabe" auf. Wäre es anders, hinge das Löschen eines
    // Produktivbestands an einer Spalte, die irgendwann einmal gesetzt wurde.
    return request.approvalMode === "ask"
      ? undefined
      : {
          layer: "mode",
          id: request.approvalMode,
          decision: "ask",
          reason: `Sessionmodus "${request.approvalMode}" greift bei zerstörenden Aktionen nicht; die Freigabe wird trotzdem eingeholt.`,
        };
  }

  if (request.approvalMode === "accept_edits") {
    // "Edits akzeptieren" heißt: Dateiänderungen sind für diese Session vorab entschieden.
    // Es heißt nicht "hartes Schreiben allgemein" — eine Mail, eine Shell oder eine
    // Datenbankänderung hat keinen Pfad, und diese Bedingung ist genau die Trennlinie.
    if (resource.kind === "path") {
      return {
        layer: "mode",
        id: "accept_edits",
        decision: "allow",
        reason:
          "Sessionmodus accept_edits: Dateiänderungen sind für diese Session vorab entschieden.",
      };
    }
    return {
      layer: "mode",
      id: "accept_edits",
      decision: "ask",
      reason:
        "Sessionmodus accept_edits deckt nur Dateiänderungen; dieser Aufruf betrifft keinen Pfad.",
    };
  }

  if (request.approvalMode === "bypass_in_sandbox") {
    if (sandbox.active) {
      return {
        layer: "mode",
        id: "bypass_in_sandbox",
        decision: "allow",
        reason: `Sessionmodus bypass_in_sandbox und nachgewiesene Sandbox: ${sandbox.reason}`,
      };
    }
    return {
      layer: "mode",
      id: "bypass_in_sandbox",
      decision: "ask",
      reason: `Sessionmodus bypass_in_sandbox, aber kein Sandbox-Nachweis (${sandbox.reason}). Die Ausnahme greift nicht, es wird gefragt.`,
    };
  }

  return undefined;
}

function summarizeDenial(request: PolicyRequest, path: PolicyVerdict[]): string {
  const blocking = path.filter((entry) => entry.decision === "deny");
  const named = blocking.map((entry) => `${entry.layer}:${entry.id}`).join(", ");
  return `Policy hat "${request.toolName}" abgelehnt (${named || "kein Grund vermerkt"}).`;
}

const DEFAULT_SANDBOX: SandboxState = {
  active: false,
  reason: "keine Sandbox verdrahtet (exec.run und der Container stehen noch nicht)",
};

/**
 * Baut die Engine. Fabrik statt Modul-Singleton, wie `createPool` (S03) und
 * `artifactRootFromEnv` (S06): die Konfiguration bleibt beim Aufrufer, und ein Test kann
 * seinen eigenen Regelsatz stellen, ohne einen globalen Zustand zu verbiegen.
 */
export function createPolicyEngine(config: PolicyEngineConfig): PolicyEngine {
  const rules = config.rules ?? DEFAULT_RULES;
  const hooks = config.hooks ?? [];
  const sandbox = config.sandbox ?? DEFAULT_SANDBOX;

  return {
    rules,
    hooks,
    sandbox,

    async check(pool: Pool, request: PolicyRequest): Promise<PolicyOutcome> {
      const auditId = `audit_${randomUUID()}`;
      const path: PolicyVerdict[] = [];

      // Stufe 0: die Zuordnung selbst. "Jedes Tool bekommt eine Stufe, kein Tool ohne
      // Zuordnung" — hier ist die zweite der beiden Prüfungen (die erste steht in der
      // Registry). Eine fehlende Stufe wird nicht mit einer Vorgabe gefüllt: geraten sähe
      // aus wie entschieden.
      try {
        assertRiskLevel(request.risk, `Tool "${request.toolName}"`);
      } catch (error) {
        path.push({
          layer: "risk",
          id: "unassigned",
          decision: "deny",
          reason: error instanceof Error ? error.message : String(error),
        });
        return await denied(pool, request, auditId, request.risk, `${request.toolName}|-`, path);
      }

      const resource = await describeResource(request, config.resolvePath, classifySecret);
      if (resource.kind === "unresolvable") {
        // Fail closed. Der Aufruf scheiterte gleich darauf ohnehin am Tool selbst — aber
        // dann stünde im Protokoll eine Freigabe für etwas, das die Policy nie eingeordnet
        // hat, und der Audit-Eintrag behauptete eine Prüfung, die nicht stattfand.
        path.push({
          layer: "rule",
          id: "unresolvable-resource",
          decision: "deny",
          reason: `Die betroffene Ressource ließ sich nicht einordnen: ${resource.error}`,
        });
        return await denied(
          pool,
          request,
          auditId,
          request.risk,
          subjectFor(request.toolName, resource),
          path,
        );
      }

      // Ebene 1: Hooks.
      const hookVerdicts = await runHooks(hooks, request, resource);
      path.push(...hookVerdicts);

      // Ebene 2: statische Regeln. Sie liefern zugleich die wirksame Risikostufe.
      const { verdicts: ruleVerdicts, effectiveRisk } = evaluateRules(rules, request, resource);
      path.push(...ruleVerdicts);

      const subject = subjectFor(request.toolName, resource);

      // Der Subjektschlüssel ist eine **Identität**, wie `idempotency_key` (S05) und
      // `task_id` (S10): er wird geschrieben und später wieder nachgeschlagen. Verändert ihn
      // der Redaction-Filter auf dem Weg ins Protokoll, findet das Nachschlagen die erteilte
      // Freigabe nie wieder — und der Lauf fragt bei jedem Aufruf erneut, ohne dass jemand
      // den Zusammenhang mit einer Redaction herstellt. Deshalb wird hier abgewiesen statt
      // einen kaputten Schlüssel entstehen zu lassen; dieselbe Haltung wie bei `task_id`.
      if (redactText(subject) !== subject) {
        path.push({
          layer: "rule",
          id: "subject-redacted",
          decision: "deny",
          reason: `Der Subjektschlüssel "${subject}" wird vom Redaction-Filter verändert und wäre als Freigabeschlüssel unbrauchbar.`,
        });
        return await denied(pool, request, auditId, effectiveRisk, subject, path);
      }

      // Der Boden.
      const floor = floorFor(effectiveRisk);
      path.push({
        layer: "risk",
        id: effectiveRisk,
        decision: floor,
        reason: FLOOR_REASON[effectiveRisk],
      });

      // Ebene 3: Sessionmodus. Senkt höchstens den Boden.
      const mode = modeVerdict(request, resource, effectiveRisk, sandbox);
      if (mode) path.push(mode);
      const base = mode?.decision === "allow" ? "allow" : floor;

      // Zusammenrechnen: die schärfste Aussage gewinnt. Der Modus ist schon in `base`
      // eingerechnet und steht deshalb nicht noch einmal in dieser Reduktion — sonst hätte
      // sein eigenes `allow` gegen den Boden, den es gerade gesenkt hat, keine Wirkung.
      let decision: PolicyDecision = base;
      for (const verdict of [...hookVerdicts, ...ruleVerdicts]) {
        decision = strictest(decision, verdict.decision);
      }

      if (decision === "deny") {
        return await denied(pool, request, auditId, effectiveRisk, subject, path);
      }

      let approval: ApprovalRef | null = null;

      if (decision === "ask") {
        // Ebene 4. Zuerst nachsehen, ob die Entscheidung schon gefallen ist — eine
        // sessiongebundene oder dauerhafte Freigabe erspart die Rückfrage, und genau darin
        // besteht ihr Zweck. Sie kommt aus der Datenbank und nicht aus einem Speicher im
        // Prozess: deshalb ist sie nach einem Neustart einfach wieder da.
        const found = await findApprovalDecision(pool, {
          sessionId: request.sessionId,
          subject,
          callId: request.callId,
          effectiveRisk,
        });

        if (found.status === "denied") {
          path.push({
            layer: "approval",
            id: found.ref.approvalId,
            decision: "deny",
            reason: `Der Mensch hat diesen Aufruf abgelehnt (${found.ref.decidedBy}, ${found.ref.decidedAt}): ${found.reason}`,
          });
          return await denied(pool, request, auditId, effectiveRisk, subject, path);
        }

        if (found.status === "granted") {
          approval = found.ref;
          path.push({
            layer: "approval",
            id: found.ref.approvalId,
            decision: "allow",
            reason: `Freigabe "${found.ref.scope}" von ${found.ref.decidedBy} (${found.ref.decidedAt}), erteilt in Session ${found.ref.grantedInSession}.`,
          });
        } else {
          const asked = await requestPolicyApproval(pool, {
            sessionId: request.sessionId,
            callId: request.callId,
            toolName: request.toolName,
            declaredRisk: request.risk,
            effectiveRisk,
            subject,
            resource: describeResourceForLog(resource),
            path,
          });
          throw new ApprovalRequiredError(
            asked.askId,
            subject,
            request.toolName,
            effectiveRisk,
            asked.options,
          );
        }
      }

      await appendEvent(pool, request.sessionId, "policy.allowed", {
        audit_id: auditId,
        call_id: request.callId,
        tool_name: request.toolName,
        origin: request.origin,
        declared_risk: request.risk,
        effective_risk: effectiveRisk,
        approval_mode: request.approvalMode,
        subject,
        resource: describeResourceForLog(resource),
        approval,
        path,
      });

      if (resource.kind === "path" && resource.secretClass) {
        // "Zugriff protokollieren" aus dem Auftrag von S11. Der Eintrag sagt: ein Aufruf mit
        // Geheimnisbezug wurde freigegeben und läuft gleich. Ob er durchlief, sagt das
        // `tool.completed`/`tool.failed` unter derselben `call_id` — das hier vorzuziehen ist
        // die vorsichtige Seite: ein Zugriff, der protokolliert ist und nicht stattfand, ist
        // harmlos; einer, der stattfand und nicht protokolliert ist, ist der Fall, den es zu
        // verhindern gilt.
        await appendEvent(pool, request.sessionId, "policy.secret_accessed", {
          audit_id: auditId,
          call_id: request.callId,
          tool_name: request.toolName,
          secret_class: resource.secretClass,
          path: resource.path.display,
          approval,
        });
      }

      return {
        kind: "allow",
        grant: new Grant(auditId, request.risk, effectiveRisk, subject, approval, path),
      };
    },
  };
}

async function denied(
  pool: Pool,
  request: PolicyRequest,
  auditId: string,
  effectiveRisk: RiskLevel,
  subject: string,
  path: PolicyVerdict[],
): Promise<PolicyOutcome> {
  const summary = summarizeDenial(request, path);
  await appendEvent(pool, request.sessionId, "policy.denied", {
    audit_id: auditId,
    call_id: request.callId,
    tool_name: request.toolName,
    origin: request.origin,
    declared_risk: request.risk,
    // Im Fall "keine gültige Stufe" trägt `effectiveRisk` genau den unbrauchbaren Wert, der
    // zur Ablehnung geführt hat. Er gehört in den Freigabepfad, nicht in dieses Feld.
    effective_risk: (RISK_LEVELS as readonly string[]).includes(effectiveRisk)
      ? effectiveRisk
      : null,
    approval_mode: request.approvalMode,
    subject,
    path,
  });
  return { kind: "deny", auditId, summary, effectiveRisk, subject, path };
}
