import type { Pool } from "pg";
import { loadConventions } from "../../context/system-prompt.js";
import type { PolicyEngine } from "../../policy/engine.js";
import {
  agentCreatedByCall,
  insertAgent,
  listAgents,
  readAgent,
} from "../../runtime/agents/store.js";
import {
  type AgentDraft,
  type AgentProfile,
  checkAgentDraft,
  needsExtraConfirmation,
} from "../../runtime/agents/types.js";
import { appendEvent } from "../../runtime/events/log.js";
import { resolveModelRouteConfig } from "../../runtime/model/router.js";
import type { ModelClient } from "../../runtime/model/types.js";
import { redactText } from "../../runtime/redaction/redact.js";
import type { AskOption } from "../../runtime/session/state.js";
import { UserInputRequiredError, askUserInput, peekAsk } from "../../runtime/session/user-input.js";
import type { JsonValue } from "../../runtime/steps/types.js";
import type { ToolCatalog, ToolDefinition, ToolInvocation, ToolOutput } from "../types.js";
import { buildAgentDraftPrompt, parseAgentDraft } from "./draft.js";
import { runWorker } from "./worker.js";

/**
 * `agent.create` und `agent.delegate` (S19) — die beiden Hälften von Abschnitt 14.
 *
 * `agent.delegate` steht seit Abschnitt 9 im Katalog der Kern-Primitive; `agent.create` kommt
 * aus Abschnitt 14: "Neue Rollen entstehen über `agent.create` per Sprach- oder Textbefehl,
 * nicht durch neuen Code pro Agent."
 *
 * ## Der Weg von einem Satz zu einem Agenten
 *
 *   1. Der Nutzer sagt, was er will ("erstelle einen Agenten, der alle 20 Minuten meine Mails
 *      checkt"). Das Modell reicht den Satz **unverändert** an `agent.create`.
 *   2. Ein Modellaufruf entwirft daraus ein Profil-JSON (`draft.ts`) — mit dem echten
 *      Werkzeugkatalog und den echten Modellnamen als Auswahl, nicht aus dem Gedächtnis.
 *   3. Die Runtime prüft den Entwurf (`checkAgentDraft`): Namensform, bekannte Werkzeuge,
 *      Risiko-Obergrenze über dem schärfsten Werkzeug, Schrittbudget, Cron-Ausdruck.
 *   4. Der Nutzer bestätigt ihn — als Rückfrage mit strukturierten Optionen, über denselben
 *      Haltepunkt wie `user.ask` (S10). **Erst danach** wird etwas eingetragen.
 *   5. Erlaubt das Profil hartes Schreiben oder Zerstörendes, folgt eine **zweite**, schärfere
 *      Frage. Siehe `needsExtraConfirmation`: was hier bestätigt wird, ist keine Aktion,
 *      sondern eine stehende Erlaubnis für jeden künftigen Lauf dieses Agenten.
 *   6. Eintrag in `kuronami.agents` samt `agent.created` — und bei gesetztem `schedule` ist der
 *      Eintrag zugleich die **Registrierung beim Heartbeat-Dienst**: der liest seine fälligen
 *      Agenten bei jedem Tick aus der Registry (`heartbeat/agents.ts`), nicht aus einer Liste
 *      im Speicher, die ein Neustart verlöre.
 *
 * Über allem liegt wie bei jedem Tool die Policy-Engine: `agent.create` ist `hard_write` (es
 * ändert die Datenbank, Abschnitt 10), die Bestätigung aus Schritt 4 ersetzt sie nicht. Zwei
 * Tore mit verschiedenen Fragen — "darf dieser Lauf so etwas überhaupt" und "ist *dieses*
 * Profil das, was du wolltest".
 */

export class AgentToolInputError extends Error {}
/** Der Arbeiter ist nicht fertig geworden. Trägt den Ausgang, nicht seine Glättung. */
export class AgentDelegationFailedError extends Error {}

/**
 * Werkzeuge, die ein Agent nie bekommt.
 *
 * `agent.*` — keine rekursiven Subagenten (Abschnitt 14). Das ist ohnehin schon eine
 * Eigenschaft der Bauart (der Katalog, den diese Tools zum Bauen eines Arbeiters benutzen,
 * kennt sie nicht, siehe `runtime/loop/api.ts`); die Liste hier ist die zweite Sicherung für
 * den Tag, an dem jemand die Registrierreihenfolge ändert.
 *
 * `user.ask` — ein Arbeiter hat kein Gegenüber. Den Vertrag mit dem Nutzer hält der
 * Hauptagent; ein Arbeiter, der fragt, hielte seinen Lauf an, bis ihn jemand abbricht.
 */
export const FORBIDDEN_AGENT_TOOLS = ["agent.create", "agent.delegate", "user.ask"] as const;

const CONFIRM_OPTIONS: AskOption[] = [
  { id: "anlegen", label: "Agent so anlegen" },
  { id: "abbrechen", label: "Nicht anlegen" },
];

const RISK_OPTIONS: AskOption[] = [
  { id: "verstanden", label: "Ja, diese Rechte bewusst erteilen" },
  { id: "abbrechen", label: "Nicht anlegen" },
];

export interface AgentToolDeps {
  pool: Pool;
  artifactRoot: string;
  /**
   * Der Katalog **ohne** die `agent.*`-Tools: die Quelle, aus der ein Profil seine Werkzeuge
   * wählen darf und aus der ein Arbeiter sie bekommt.
   */
  catalog: ToolCatalog;
  policy: PolicyEngine;
  /**
   * Das Modell, das ein Profil entwirft. Abschnitt 11 ordnet "Extraktion" der günstigsten
   * Klasse zu — ein Profil aus einem Satz zu formen ist genau das.
   */
  draftModel: ModelClient;
  /**
   * Das Modell zu einem Modellnamen aus der Registry (Abschnitt 11: "Modell pro Agent bewusst
   * wählen"). Ohne diese Fabrik läuft jeder Arbeiter auf `draftModel` — lauffähig, aber nicht
   * das, was im Profil steht; `agent.returned` hält das dann ausdrücklich fest.
   */
  modelFor?: (model: string) => ModelClient;
  /** Die Konventionen für Arbeitersessions. Ohne Angabe: einmalig aus AGENTS.md gelesen. */
  conventions?: string;
  /** Die Modellnamen für den Entwurfs-Prompt. Vorgabe: der Klassenname aus S18e bzw. `DEFAULT_MODEL`. */
  models?: { routine: string; thinking: string };
  maxDraftTokens?: number;
}

/** Wie lange ein Arbeiterlauf laufen darf (siehe `ToolDefinition.timeoutMs`). */
export const DELEGATION_TIMEOUT_MS = 10 * 60 * 1000;

function requireText(value: JsonValue | undefined, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AgentToolInputError(`Feld "${field}" muss eine nicht leere Zeichenkette sein.`);
  }
  return value.trim();
}

/** Die Frage, mit der ein Entwurf zur Bestätigung gestellt wird. */
export function confirmationQuestion(draft: AgentDraft): string {
  return [
    `Agent "${draft.name}" (${draft.role}) anlegen?`,
    draft.purpose,
    `Werkzeuge: ${draft.tools.join(", ")}. Obergrenze: ${draft.max_risk}. Modell: ${draft.model}.`,
    `Schritte je Lauf: ${draft.max_steps}. Zeitplan: ${draft.schedule ?? "keiner"}.`,
  ].join(" · ");
}

function riskQuestion(draft: AgentDraft): string {
  return [
    `"${draft.name}" soll bis "${draft.max_risk}" gehen dürfen — das ist eine stehende Erlaubnis`,
    "für jeden künftigen Lauf dieses Agenten, auch für die nach Zeitplan, bei denen niemand",
    `zusieht. Betroffene Werkzeuge: ${draft.tools.join(", ")}. Bewusst erteilen?`,
  ].join(" ");
}

function profileOutput(profile: AgentProfile, note: string): ToolOutput {
  const schedule = profile.schedule
    ? `Zeitplan "${profile.schedule}" — der Heartbeat-Dienst übernimmt ihn beim nächsten Tick.`
    : "Kein Zeitplan; er läuft nur auf Auftrag (agent.delegate).";
  return {
    summary: `${note}: "${profile.name}" (${profile.role}), Modell ${profile.model}, Werkzeuge ${profile.tools.join(", ")}, Obergrenze ${profile.maxRisk}, ${profile.maxSteps} Schritte je Lauf. ${schedule}`,
    structured: {
      agent_id: profile.agentId,
      name: profile.name,
      role: profile.role,
      purpose: profile.purpose,
      model: profile.model,
      tools: profile.tools,
      max_risk: profile.maxRisk,
      max_steps: profile.maxSteps,
      schedule: profile.schedule,
      status: profile.status,
      scheduled: profile.schedule !== null,
    },
    preview: [profile.purpose],
  };
}

function abortedOutput(reason: string): ToolOutput {
  return {
    summary: `Kein Agent angelegt: ${reason}`,
    structured: { created: false, reason },
  };
}

/**
 * `agent.create`. `execution: "runtime"` wie `user.ask`: der Aufruf hält für einen Menschen an,
 * und ein Schritt, der stundenlang auf `running` steht, während jemand überlegt, wäre eine
 * Falschaussage über den Lauf (S10). Seine Idempotenz kommt deshalb aus dem Protokoll und
 * nicht aus einem Schlüssel — an drei Stellen:
 *
 *   * das eigene `agent.created` zur selben `call_id` (dann ist der Agent schon da),
 *   * die offene oder entschiedene Rückfrage zur selben `ask_id` (dann steht der Entwurf schon
 *     und wird **nicht** neu entworfen),
 *   * der UNIQUE-Index auf dem Namen (dann entscheidet die Datenbank, nicht die Reihenfolge).
 */
async function createHandler(deps: AgentToolDeps, inv: ToolInvocation): Promise<ToolOutput> {
  const request = requireText(inv.input.request, "request");

  // 1. Hat genau dieser Aufruf schon einen Agenten angelegt? Dann ist das sein Ergebnis.
  const already = await agentCreatedByCall(deps.pool, inv.sessionId, inv.callId);
  if (already)
    return profileOutput(already, "Agent stand aus diesem Aufruf bereits in der Registry");

  const askId = `ask:${inv.callId}`;
  const riskAskId = `ask:${inv.callId}:risk`;

  // 2. Der Entwurf. Steht die Rückfrage schon, kommt er von dort — der Modellaufruf läuft
  //    genau einmal, und was eingetragen wird, ist nachweislich das, was der Nutzer gesehen hat.
  let resolution = await peekAsk(deps.pool, inv.sessionId, askId);
  if (!resolution) {
    const draft = await draftProfile(deps, request);
    resolution = await askUserInput(deps.pool, inv.sessionId, {
      askId,
      kind: "agent_create",
      question: confirmationQuestion(draft),
      options: CONFIRM_OPTIONS,
      // Das Profil geht durch denselben Filter wie jeder Text, der ins Protokoll wandert
      // (AGENTS.md) — `checkAgentDraft` hat es geprüft, `redactDraft` macht es ablagefähig.
      details: { profile: redactDraft(draft) as unknown as JsonValue },
    });
  }

  if (resolution.status === "pending") {
    throw new UserInputRequiredError(askId, questionOf(resolution.details), CONFIRM_OPTIONS);
  }
  if (resolution.status === "dismissed") {
    return abortedOutput(`die Rückfrage wurde abgewiesen (${resolution.reason || "ohne Grund"}).`);
  }
  if (resolution.choice !== "anlegen") {
    return abortedOutput("der Nutzer hat den Entwurf abgelehnt.");
  }

  // 3. Der bestätigte Entwurf, noch einmal geprüft. Was aus dem Protokoll kommt, ist Nutzdaten
  //    wie alles andere: zwischen Rückfrage und Antwort kann der Katalog ein anderer sein.
  const draft = checkAgentDraft(resolution.details?.profile, {
    catalog: deps.catalog,
    forbiddenTools: FORBIDDEN_AGENT_TOOLS,
  });

  // 4. Risikostufen-Validierung: hartes Schreiben oder Zerstörendes verlangt eine zweite,
  //    ausdrückliche Bestätigung.
  if (needsExtraConfirmation(draft.max_risk)) {
    let riskResolution = await peekAsk(deps.pool, inv.sessionId, riskAskId);
    if (!riskResolution) {
      riskResolution = await askUserInput(deps.pool, inv.sessionId, {
        askId: riskAskId,
        kind: "agent_create",
        question: riskQuestion(draft),
        options: RISK_OPTIONS,
        details: {
          agent: draft.name,
          max_risk: draft.max_risk,
          tools: draft.tools,
        },
      });
    }
    if (riskResolution.status === "pending") {
      throw new UserInputRequiredError(riskAskId, riskQuestion(draft), RISK_OPTIONS);
    }
    if (riskResolution.status === "dismissed" || riskResolution.choice !== "verstanden") {
      return abortedOutput(
        `die Zusatzbestätigung für "${draft.max_risk}" wurde nicht erteilt. Ein Profil mit niedrigerer Obergrenze wäre der nächste Versuch.`,
      );
    }
  }

  // 5. Eintrag. Ab hier ist der Agent aktiv — und bei gesetztem Zeitplan registriert.
  const profile = await insertAgent(deps.pool, inv.sessionId, draft, {
    createdBy: resolution.decidedBy,
    callId: inv.callId,
  });
  return profileOutput(profile, "Agent angelegt und aktiv");
}

/** Die Frage aus der stehenden Rückfrage — für den Wartezustand, den der Loop meldet. */
function questionOf(details: Record<string, JsonValue> | null): string {
  const profile = details?.profile;
  if (profile && typeof profile === "object" && !Array.isArray(profile)) {
    return confirmationQuestion(profile as unknown as AgentDraft);
  }
  return "Agentenprofil bestätigen?";
}

function redactDraft(draft: AgentDraft): AgentDraft {
  return {
    ...draft,
    role: redactText(draft.role),
    purpose: redactText(draft.purpose),
    system_prompt: redactText(draft.system_prompt),
    tools: [...draft.tools],
  };
}

/** Der Modellaufruf, der aus dem Satz des Nutzers ein Profil macht. */
async function draftProfile(deps: AgentToolDeps, request: string): Promise<AgentDraft> {
  // Ohne ausdrückliche Angabe dieselben zwei Namen, zwischen denen der Modell-Router seit S18e
  // wählt — keine zweite Liste von Modellnamen daneben.
  const route = resolveModelRouteConfig();
  const models = deps.models ?? { routine: route.routineModel, thinking: route.thinkingModel };

  const response = await deps.draftModel.complete({
    system: [{ text: "Du entwirfst Profile für Subagenten eines persönlichen Assistenten." }],
    tools: [],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: buildAgentDraftPrompt({
              request,
              catalog: deps.catalog,
              forbiddenTools: FORBIDDEN_AGENT_TOOLS,
              models,
            }),
          },
        ],
      },
    ],
    maxTokens: deps.maxDraftTokens ?? 1_500,
  });

  // Beide Fehler — unlesbares JSON, unbrauchbares Profil — laufen als Ausnahme zum Router und
  // werden dort zur Fehlerhülle mit vollem Wortlaut. Das Modell liest sie im selben Zug und
  // kann `agent.create` mit einem klareren Auftrag erneut aufrufen.
  return checkAgentDraft(parseAgentDraft(response.text), {
    catalog: deps.catalog,
    forbiddenTools: FORBIDDEN_AGENT_TOOLS,
  });
}

/** So viel Ergebnistext geht in die `summary`. Der volle Text steht in `structured`. */
const SUMMARY_CHARS = 400;

/**
 * `agent.delegate`. Läuft **mit** Ausführungshülle (`execution: "step"`, `repeatable: false`):
 * ein Arbeiterlauf ist ein externer Seiteneffekt im Sinn von Abschnitt 6 — er kostet
 * Modellaufrufe und kann Werkzeuge benutzen. Ein Absturz mitten darin darf ihn nicht ein
 * zweites Mal starten, und genau dafür ist der Idempotenzschlüssel `tool:<call_id>` da.
 */
async function delegateHandler(deps: AgentToolDeps, inv: ToolInvocation): Promise<ToolOutput> {
  const name = requireText(inv.input.agent, "agent");
  const task = requireText(inv.input.task, "task");
  const context = typeof inv.input.context === "string" ? inv.input.context : undefined;

  const profile = await readAgent(deps.pool, name);
  if (!profile) {
    const known = (await listAgents(deps.pool)).map((entry) => entry.name);
    throw new AgentToolInputError(
      `Es gibt keinen Agenten "${name}". Bekannt und aktiv: ${known.join(", ") || "keiner"}. Neue Rollen entstehen über agent.create.`,
    );
  }
  if (profile.status !== "active") {
    throw new AgentToolInputError(
      `Agent "${name}" steht auf "${profile.status}" und nimmt keine Aufträge an.`,
    );
  }

  const model = deps.modelFor?.(profile.model) ?? deps.draftModel;
  const conventions = deps.conventions ?? (await cachedConventions());

  await appendEvent(deps.pool, inv.sessionId, "agent.delegated", {
    call_id: inv.callId,
    step_id: inv.stepId,
    agent: profile.name,
    agent_id: profile.agentId,
    task,
    tools: profile.tools,
    model: model.model,
    // Sichtbar machen, wenn der Arbeiter **nicht** auf dem Modell seines Profils läuft: sonst
    // sähe ein teurer Lauf aus wie ein günstiger (Abschnitt 11/12).
    model_from_profile: model.model === profile.model,
    max_steps: profile.maxSteps,
    max_risk: profile.maxRisk,
  });

  const run = await runWorker(
    {
      pool: deps.pool,
      artifactRoot: deps.artifactRoot,
      catalog: deps.catalog,
      policy: deps.policy,
      model,
      conventions,
      signal: inv.signal,
    },
    {
      profile,
      task,
      context,
      // Stabil aus dem Aufruf: derselbe Auftrag trifft dieselbe Arbeitersession, auch nach
      // einem Neustart. Der Name steht mit drin, damit man im Protokoll sieht, wer lief.
      threadId: `thread_agent_${profile.name}_${inv.callId}`,
    },
  );

  await appendEvent(deps.pool, inv.sessionId, "agent.returned", {
    call_id: inv.callId,
    step_id: inv.stepId,
    agent: profile.name,
    worker_session: run.sessionId,
    stop: run.stop,
    reason: run.reason,
    tool_calls: run.toolCalls,
    artifact_refs: run.artifactRefs,
    // Was der Lauf verbraucht hat, wenn das Profil ein Budget trägt (S20). Eine Kennzahl, keine
    // Abrechnung — die ist S21.
    tokens_spent: run.tokensSpent,
    token_budget: profile.tokenBudget,
    // Der Ergebnistext steht in der Tool-Hülle und im Schritt; hier nur seine Länge — dasselbe
    // Maßhalten wie bei `offloaded` in `tool.completed` (S07).
    text_length: run.text.length,
  });

  if (run.stop !== "done") {
    throw new AgentDelegationFailedError(
      `Der Arbeiter "${profile.name}" ist nicht fertig geworden (${run.stop}): ${run.reason}. Sein Protokoll steht in Session ${run.sessionId}.`,
    );
  }

  const text = run.text.trim();
  return {
    summary: `${profile.name}: ${text.slice(0, SUMMARY_CHARS)}${text.length > SUMMARY_CHARS ? " …" : ""}`,
    structured: {
      agent: profile.name,
      worker_session: run.sessionId,
      tool_calls: run.toolCalls,
      text,
      artifact_refs: run.artifactRefs,
    },
    artifact_refs: run.artifactRefs,
  };
}

/**
 * Die Konventionen für Arbeitersessions, einmal gelesen und dann gehalten — dieselbe Zusage
 * wie in `createRunner` (S12): innerhalb eines Prozesses derselbe Text, sonst bräche der
 * Cache-Präfix jedes Arbeiters bei einer Bearbeitung von AGENTS.md mitten im Betrieb.
 */
let conventionsPromise: Promise<string> | undefined;
function cachedConventions(): Promise<string> {
  conventionsPromise ??= loadConventions();
  return conventionsPromise;
}

export function createAgentTools(deps: AgentToolDeps): ToolDefinition[] {
  return [
    {
      name: "agent.create",
      description:
        "Legt einen neuen Subagenten an: entwirft aus dem Auftrag des Nutzers ein Profil " +
        "(Rolle, Anweisung, Modell, Werkzeuge, Risiko-Obergrenze, optionaler Zeitplan), legt es " +
        "dem Nutzer zur Bestätigung vor und trägt es danach in die Registry ein. Gib den Wunsch " +
        "des Nutzers unverändert weiter — das Profil entsteht hier, nicht in deiner Antwort.",
      risk: "hard_write",
      repeatable: true,
      execution: "runtime",
      inputSchema: {
        fields: {
          request: {
            type: "string",
            required: true,
            description:
              'Was der Nutzer gesagt hat, wörtlich (z. B. "alle 20 Minuten meine Mails checken").',
          },
        },
      },
      handler: (inv) => createHandler(deps, inv),
    },
    {
      name: "agent.delegate",
      description:
        "Gibt einen engen Auftrag an einen Agenten aus der Registry ab. Der Arbeiter läuft in " +
        "einer eigenen Session mit eigenem Kontext, nur mit den Werkzeugen seines Profils, und " +
        "liefert am Ende sein Ergebnis samt Artefakt-Handles zurück — keine Gesprächshistorie. " +
        "Alles, was er wissen muss, gehört in task bzw. context.",
      risk: "hard_write",
      // Ein halb gelaufener Arbeiter wird nicht wiederholt: er hat unterwegs womöglich schon
      // Werkzeuge benutzt, und ein zweiter Anlauf täte es noch einmal (S05).
      repeatable: false,
      timeoutMs: DELEGATION_TIMEOUT_MS,
      inputSchema: {
        fields: {
          agent: {
            type: "string",
            required: true,
            description: "Name des Agenten aus der Registry.",
          },
          task: {
            type: "string",
            required: true,
            description:
              "Der Auftrag, eng und vollständig. Der Arbeiter sieht deine Unterhaltung nicht.",
          },
          context: {
            type: "string",
            required: false,
            description:
              "Was der Arbeiter zusätzlich wissen muss (Namen, Handles, Vorgaben). Der einzige Weg, wie Kontext zu ihm gelangt.",
          },
        },
      },
      handler: (inv) => delegateHandler(deps, inv),
    },
  ];
}
