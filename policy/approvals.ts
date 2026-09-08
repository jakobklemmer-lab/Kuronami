import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { type EventRecord, appendEventInTx, readEvents } from "../runtime/events/log.js";
import { redactText, redactValue } from "../runtime/redaction/redact.js";
import { lockSession, optionsOf, traceAsk } from "../runtime/session/approval-log.js";
import type { AskOption } from "../runtime/session/state.js";
import type { JsonValue } from "../runtime/steps/types.js";
import { type ApprovalScope, type RiskLevel, scopesFor } from "./risk.js";
import type { ApprovalRef, PolicyVerdict } from "./types.js";

/**
 * Freigaben: erteilen, wiederfinden, überdauern.
 *
 * Zwei Darstellungen, in **einer** Transaktion geschrieben — dasselbe Muster wie Schritt und
 * `step.*` (S05), Artefaktzeile und `artifact.created` (S06), Aufgabe und `task.*` (S10):
 *
 *   * das **Ereignis** (`approval.granted`/`approval.denied`) ist die Wahrheit. Weil es im
 *     Protokoll steht, ist eine sessiongebundene Freigabe nach einem Neustart einfach wieder
 *     da: sie lag nie im Speicher. Genau das verlangt Abschnitt 10 ("Freigaben der Form 'für
 *     diese Session erlauben' werden gespeichert und bei Wiederaufnahme wiederhergestellt").
 *   * die **Zeile** in `kuronami.approvals` ist der abgeleitete Schnappschuss und der einzige
 *     Weg, an eine **dauerhafte** Freigabe zu kommen: die gilt über Sessiongrenzen hinweg,
 *     und das Protokoll ist je Session geführt. `derivePolicyApprovals` faltet die
 *     sessiongebundenen unabhängig aus dem Protokoll — die beiden müssen übereinstimmen, und
 *     ein Test hält das fest.
 *
 * Diese Datei ist zugleich das **vierte Schreibtor des Redaction-Filters** (nach Protokoll,
 * Artefaktmetadaten und Prompt-Aufbau, S07): `kuronami.approvals` trägt mit
 * `requested_input` die Eingabe des freigegebenen Aufrufs, und die kann ein Geheimnis
 * enthalten. Der Filter läuft hier an der einzigen Stelle, die in diese Tabelle schreibt.
 */

/**
 * Die Entscheidung steht aus. Der Router lässt diesen Fehler durch — wie
 * `UserInputRequiredError` (S10) und `ToolCatalogMismatchError` (S07): der Lauf ist nicht
 * fehlgeschlagen, er wartet. Die Session steht danach auf `awaiting_user`, und ein frisch
 * gestarteter Prozess liest das aus dem Protokoll.
 */
export class ApprovalRequiredError extends Error {
  constructor(
    readonly askId: string,
    readonly subject: string,
    readonly toolName: string,
    readonly effectiveRisk: RiskLevel,
    readonly options: AskOption[],
  ) {
    super(
      `Freigabe erforderlich für "${toolName}" (${effectiveRisk}, ${subject}): ${askId} wartet auf eine Entscheidung`,
    );
    this.name = "ApprovalRequiredError";
  }
}

/** Zu dieser `ask_id` steht keine offene Freigabe-Rückfrage. */
export class ApprovalNotPendingError extends Error {}
/** Die gewählte Option gehört nicht zu den angebotenen. */
export class UnknownApprovalChoiceError extends Error {}

/** Das Ergebnis der Suche nach einer bereits gefallenen Entscheidung. */
export type ApprovalLookup =
  | { status: "none" }
  | { status: "granted"; ref: ApprovalRef }
  | { status: "denied"; ref: ApprovalRef; reason: string };

export interface ApprovalDecisionReport {
  approvalId: string;
  askId: string;
  subject: string;
  scope: ApprovalScope;
  status: "granted" | "denied";
}

/** Was der Aufrufer über einen offenen Antrag wissen muss, um die Rückfrage zu stellen. */
export interface ApprovalRequestSpec {
  sessionId: string;
  callId: string;
  toolName: string;
  declaredRisk: RiskLevel;
  effectiveRisk: RiskLevel;
  subject: string;
  resource: Record<string, unknown>;
  /** Der Freigabepfad bis hierher — warum überhaupt gefragt wird. */
  path: PolicyVerdict[];
}

/** Die `ask_id` einer Freigabe-Rückfrage. Stabil aus der Aufrufkennung, wie `ask:` in S10. */
export function policyAskId(callId: string): string {
  return `policy:${callId}`;
}

const OPTION_LABELS: Record<ApprovalScope | "deny", string> = {
  once: "Nur dieses eine Mal erlauben",
  session: "Für diese Session erlauben",
  always: "Dauerhaft erlauben",
  deny: "Ablehnen",
};

/**
 * Die angebotenen Optionen. Strukturiert, nicht als Fließtext (Abschnitt 10) — und bei
 * `destructive` fehlen `session` und `always`, weil die Tabelle dort "immer Freigabe" sagt
 * (siehe `scopesFor`). Die Einschränkung steht damit in den Optionen selbst und nicht nur in
 * einer Prüfung dahinter: was nicht angeboten wird, kann auch nicht versehentlich gewählt
 * werden.
 */
export function approvalOptions(effectiveRisk: RiskLevel): AskOption[] {
  const scopes = scopesFor(effectiveRisk);
  return [...scopes, "deny" as const].map((id) => ({ id, label: OPTION_LABELS[id] }));
}

interface ApprovalRow {
  approval_id: string;
  session_id: string;
  subject: string;
  scope: ApprovalScope;
  status: "pending" | "granted" | "denied";
  decided_by: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
}

function toRef(row: ApprovalRow): ApprovalRef {
  return {
    approvalId: row.approval_id,
    scope: row.scope,
    subject: row.subject,
    decidedBy: row.decided_by ?? "unbekannt",
    decidedAt: row.decided_at?.toISOString() ?? "",
    grantedInSession: row.session_id,
  };
}

/**
 * Sucht eine bereits gefallene Entscheidung zu diesem Subjekt.
 *
 * Reihenfolge der Bevorzugung: erst die an **diesen Aufruf** gebundene Entscheidung, dann die
 * breiteren Freigaben. Das ist nicht Geschmack — eine Ablehnung wird als `once` an die
 * `call_id` gebunden, und läge sie hinter einer sessionweiten Freigabe, liefe ein ausdrücklich
 * abgelehnter Aufruf beim nächsten Versuch doch durch.
 *
 * `broad` ist bei `destructive` falsch: dort zählen ausschließlich Einmalfreigaben.
 */
export async function findApprovalDecision(
  pool: Pool,
  opts: { sessionId: string; subject: string; callId: string; effectiveRisk: RiskLevel },
): Promise<ApprovalLookup> {
  const broad = scopesFor(opts.effectiveRisk).includes("session");

  const found = await pool.query<ApprovalRow>(
    `
    SELECT approval_id, session_id, subject, scope, status, decided_by, decided_at, decision_reason
    FROM kuronami.approvals
    WHERE subject = $1
      AND status IN ('granted', 'denied')
      AND (
            (scope = 'once' AND session_id = $2 AND call_id = $3)
         OR ($4::boolean AND status = 'granted' AND scope = 'session' AND session_id = $2)
         OR ($4::boolean AND status = 'granted' AND scope = 'always')
      )
    ORDER BY (scope = 'once') DESC, decided_at DESC
    LIMIT 1
    `,
    [opts.subject, opts.sessionId, opts.callId, broad],
  );

  const row = found.rows[0];
  if (!row) return { status: "none" };
  return row.status === "granted"
    ? { status: "granted", ref: toRef(row) }
    : { status: "denied", ref: toRef(row), reason: row.decision_reason ?? "" };
}

/**
 * Stellt die Freigabe-Rückfrage — genau einmal je `ask_id`. Ein zweiter Aufruf mit derselben
 * Kennung (ein wiederaufgenommener Lauf, der denselben Plan noch einmal abarbeitet) findet
 * die offene Anfrage und schreibt kein zweites `approval.requested`. Die Idempotenz kommt aus
 * dem Protokoll, wie bei `user.ask` (S10), nicht aus einem Speicher im Prozess.
 */
export async function requestPolicyApproval(
  pool: Pool,
  spec: ApprovalRequestSpec,
): Promise<{ askId: string; options: AskOption[]; alreadyOpen: boolean }> {
  const askId = policyAskId(spec.callId);
  const options = approvalOptions(spec.effectiveRisk);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockSession(client, spec.sessionId);

    const trace = traceAsk(await readEvents(pool, spec.sessionId), askId);
    if (trace.request && !trace.decision) {
      await client.query("COMMIT");
      return { askId, options: optionsOf(trace.request), alreadyOpen: true };
    }

    await appendEventInTx(client, spec.sessionId, "approval.requested", {
      ask_id: askId,
      kind: "policy",
      question: `"${spec.toolName}" braucht eine Freigabe (${spec.effectiveRisk}). Betroffen: ${spec.subject}.`,
      options,
      call_id: spec.callId,
      tool_name: spec.toolName,
      declared_risk: spec.declaredRisk,
      effective_risk: spec.effectiveRisk,
      subject: spec.subject,
      resource: spec.resource,
      // Warum gefragt wird. Ohne den Pfad wäre die Rückfrage eine Ja/Nein-Frage ohne
      // Grundlage, und der Mensch entschiede genau das Gegenteil von informiert.
      path: spec.path,
    });

    await client.query("COMMIT");
    return { askId, options, alreadyOpen: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Die Eingabe des Aufrufs, zu dem die Freigabe gehört — aus dem `tool.requested` derselben `call_id`. */
function inputOfCall(events: EventRecord[], callId: string): JsonValue {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.type === "tool.requested" && event.payload.call_id === callId) {
      return (event.payload.input as JsonValue | undefined) ?? {};
    }
  }
  // Die Eingabe steht im Protokoll, weil der Router `tool.requested` vor der Policy-Prüfung
  // schreibt. Sie hier noch einmal mitzuschleppen hätte sie verdoppelt — bei `fs.write` wäre
  // das der komplette Dateiinhalt ein zweites Mal.
  return {};
}

function requireString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== "string" || value === "") {
    throw new ApprovalNotPendingError(
      `approval.requested ohne verwertbares Feld "${field}": ${JSON.stringify(payload)}`,
    );
  }
  return value;
}

/**
 * Der Mensch entscheidet (Abschnitt 10, Ebene 4). Bis zum Gateway (S16) ruft das der
 * Betreiber bzw. der Test direkt, wie schon `answerUserInput` in S10.
 *
 * Zeile und Ereignis entstehen in einer Transaktion. Die Reihenfolge ist dabei nicht beliebig:
 * gäbe es die Zeile ohne das Ereignis, hielte die Engine eine Freigabe für erteilt, die im
 * Protokoll nie vorkam — und der Freigabepfad, den Abschnitt 10 verlangt, wäre eine Zeile
 * ohne Herkunft.
 */
export async function decidePolicyApproval(
  pool: Pool,
  sessionId: string,
  askId: string,
  choiceId: string,
  opts: { decidedBy?: string; reason?: string } = {},
): Promise<ApprovalDecisionReport> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockSession(client, sessionId);

    const events = await readEvents(pool, sessionId);
    const trace = traceAsk(events, askId);
    if (!trace.request || trace.decision) {
      throw new ApprovalNotPendingError(
        `Zu ask_id "${askId}" steht in Session ${sessionId} keine offene Freigabe-Rückfrage${
          trace.decision ? " (sie ist bereits entschieden)" : ""
        }.`,
      );
    }
    if (trace.request.payload.kind !== "policy") {
      throw new ApprovalNotPendingError(
        `ask_id "${askId}" gehört zu einer Rückfrage der Art "${String(trace.request.payload.kind)}" und nicht zu einer Freigabe. Für user.ask ist answerUserInput zuständig.`,
      );
    }

    const option = optionsOf(trace.request).find((entry) => entry.id === choiceId);
    if (!option) {
      throw new UnknownApprovalChoiceError(
        `Option "${choiceId}" gehört nicht zu ask_id "${askId}" (angeboten: ${optionsOf(
          trace.request,
        )
          .map((entry) => entry.id)
          .join(", ")}).`,
      );
    }

    const payload = trace.request.payload;
    const callId = requireString(payload, "call_id");
    const subject = requireString(payload, "subject");
    const toolName = requireString(payload, "tool_name");
    const effectiveRisk = requireString(payload, "effective_risk") as RiskLevel;

    const granted = option.id !== "deny";

    // Eine dauerhafte Freigabe gibt es je Subjekt genau einmal — das sichert der partielle
    // UNIQUE-Index aus 0007 zu. Zwei gleichzeitig offene Rückfragen zum selben Subjekt, beide
    // mit "dauerhaft" beantwortet, liefen sonst in einen Constraint-Fehler, den der Betreiber
    // als Absturz sähe, obwohl seine Entscheidung völlig in Ordnung war. Stattdessen wird die
    // bestehende Freigabe benutzt: sie ist genau die, die diesen Aufruf jetzt deckt, und das
    // Ereignis nennt ihre Kennung. Kein zweiter Eintrag, keine Frage, welcher von beiden gilt.
    if (granted && option.id === "always") {
      const existing = await client.query<ApprovalRow>(
        `
        SELECT approval_id, session_id, subject, scope, status, decided_by, decided_at, decision_reason
        FROM kuronami.approvals
        WHERE subject = $1 AND scope = 'always' AND status = 'granted'
        LIMIT 1
        `,
        [subject],
      );
      const row = existing.rows[0];
      if (row) {
        await appendEventInTx(client, sessionId, "approval.granted", {
          ask_id: askId,
          kind: "policy",
          approval_id: row.approval_id,
          choice: option.id,
          choice_label: option.label,
          subject,
          scope: "always",
          call_id: callId,
          tool_name: toolName,
          risk_level: effectiveRisk,
          decided_by: opts.decidedBy ?? "operator",
          reason: `Es besteht bereits eine dauerhafte Freigabe für dieses Subjekt (${row.approval_id}, erteilt von ${row.decided_by ?? "unbekannt"}).`,
          reused: true,
        });
        await client.query("COMMIT");
        return {
          approvalId: row.approval_id,
          askId,
          subject,
          scope: "always",
          status: "granted",
        };
      }
    }

    // Eine Ablehnung wird an den Aufruf gebunden, nicht ans Subjekt: sie soll genau diesen
    // Aufruf abweisen — auch nach einem Neustart, der ihn erneut versucht —, aber sie soll
    // nicht als stille Dauersperre über allem Weiteren liegen. Wer dauerhaft sperren will,
    // schreibt eine Regel; die steht in einer versionierten Datei und nicht in einer Zeile.
    const scope: ApprovalScope = granted ? (option.id as ApprovalScope) : "once";
    const approvalId = `appr_${randomUUID()}`;
    const decidedBy = opts.decidedBy ?? "operator";
    const reason = opts.reason ?? option.label;

    await client.query(
      `
      INSERT INTO kuronami.approvals
        (approval_id, session_id, tool_name, risk_level, scope, status,
         requested_input, decision_reason, decided_at, subject, call_id, decided_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, now(), $9, $10, $11)
      `,
      [
        approvalId,
        sessionId,
        toolName,
        effectiveRisk,
        scope,
        granted ? "granted" : "denied",
        // Das vierte Schreibtor des Redaction-Filters. `kuronami.approvals` ist die einzige
        // Tabelle außer `artifacts`, in die Nutzdaten aus einem Tool-Aufruf gelangen.
        JSON.stringify(redactValue(inputOfCall(events, callId))),
        redactText(reason),
        subject,
        callId,
        decidedBy,
      ],
    );

    await appendEventInTx(client, sessionId, granted ? "approval.granted" : "approval.denied", {
      ask_id: askId,
      kind: "policy",
      approval_id: approvalId,
      choice: option.id,
      choice_label: option.label,
      subject,
      scope,
      call_id: callId,
      tool_name: toolName,
      risk_level: effectiveRisk,
      decided_by: decidedBy,
      reason,
    });

    await client.query("COMMIT");
    return {
      approvalId,
      askId,
      subject,
      scope,
      status: granted ? "granted" : "denied",
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export interface DerivedApproval {
  approvalId: string;
  subject: string;
  scope: ApprovalScope;
  status: "granted" | "denied";
  callId: string;
  toolName: string;
  decidedBy: string;
}

/**
 * Faltet die Freigaben dieser Session aus dem Protokoll — ohne einen Blick in
 * `kuronami.approvals`. Das ist der Nachweis, dass eine sessiongebundene Freigabe nicht an
 * der Tabelle hängt: nimmt man ihr die Zeilen weg, steht sie immer noch da. Nimmt sie
 * jemand aus dem Protokoll, ist sie weg — das Protokoll ist die Wahrheit (Abschnitt 4.4).
 *
 * Nimmt Ereignisse entgegen und sonst nichts, wie `deriveSessionState` (S05): es gibt keinen
 * Parameter, über den ein Seiteneffekt hereinkäme.
 */
export function derivePolicyApprovals(events: EventRecord[]): DerivedApproval[] {
  const found: DerivedApproval[] = [];
  for (const event of events) {
    if (event.type !== "approval.granted" && event.type !== "approval.denied") continue;
    if (event.payload.kind !== "policy") continue;
    found.push({
      approvalId: String(event.payload.approval_id),
      subject: String(event.payload.subject),
      scope: event.payload.scope as ApprovalScope,
      status: event.type === "approval.granted" ? "granted" : "denied",
      callId: String(event.payload.call_id),
      toolName: String(event.payload.tool_name),
      decidedBy: String(event.payload.decided_by),
    });
  }
  return found;
}

/** Die Freigaben dieser Session, wie sie in `kuronami.approvals` stehen. Reiner Schnappschuss. */
export async function readApprovalSnapshot(
  pool: Pool,
  sessionId: string,
): Promise<DerivedApproval[]> {
  const rows = await pool.query<{
    approval_id: string;
    subject: string;
    scope: ApprovalScope;
    status: "pending" | "granted" | "denied";
    call_id: string | null;
    tool_name: string | null;
    decided_by: string | null;
  }>(
    `
    SELECT approval_id, subject, scope, status, call_id, tool_name, decided_by
    FROM kuronami.approvals
    WHERE session_id = $1
    ORDER BY created_at, approval_id
    `,
    [sessionId],
  );

  return rows.rows
    .filter((row) => row.status !== "pending")
    .map((row) => ({
      approvalId: row.approval_id,
      subject: row.subject,
      scope: row.scope,
      status: row.status as "granted" | "denied",
      callId: row.call_id ?? "",
      toolName: row.tool_name ?? "",
      decidedBy: row.decided_by ?? "",
    }));
}
