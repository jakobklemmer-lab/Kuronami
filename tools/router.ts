import type { Pool } from "pg";
import type { PolicyEngine, PolicyGrant } from "../policy/engine.js";
import { appendEvent } from "../runtime/events/log.js";
import type { SessionRecord } from "../runtime/session/types.js";
import { UserInputRequiredError } from "../runtime/session/user-input.js";
import {
  SessionCanceledError,
  type StepOutcome,
  describeError,
  executeStep,
} from "../runtime/steps/hull.js";
import type { JsonValue } from "../runtime/steps/types.js";
import {
  DEFAULT_OFFLOAD_THRESHOLD_TOKENS,
  ToolOutputError,
  ToolOutputTooLargeError,
  estimateResultTokens,
  materializeResult,
} from "./offload.js";
import type {
  ToolCatalog,
  ToolDefinition,
  ToolFieldType,
  ToolInputSchema,
  ToolOutput,
  ToolResult,
} from "./types.js";

/**
 * Der Tool-Router: das Tor zu allen Seiteneffekten. Jeder Tool-Aufruf geht hier durch.
 *
 * Was hier zusammenläuft und warum an genau dieser Stelle:
 *   * die **einheitliche Rückgabehülle** (Abschnitt 9) — der Router ist die einzige Stelle,
 *     die sie herstellt, deshalb kann kein Tool eine andere Form zurückgeben;
 *   * die **Ausführungshülle** aus S05 — jeder Aufruf mit externem Seiteneffekt ist ein
 *     Schritt mit Checkpoint davor und danach, mit Idempotenzschlüssel und Zeitfenster
 *     (Abschnitt 6);
 *   * die **automatische Auslagerung** (Abschnitt 4.5) — gemessen an der fertigen Hülle;
 *   * der **eingefrorene Katalog** — eine Session wird nur von dem Prozess bedient, der
 *     denselben Tool-Vertrag hält.
 *
 * `execution: "runtime"`-Tools (`task.*`, `user.ask`, seit S10) laufen die Katalog- und
 * Schema-Prüfung mit und bekommen `tool.requested`/`tool.completed`, aber **nicht** die
 * Ausführungshülle: sie haben keinen externen Seiteneffekt. Siehe `callRuntimeTool`.
 *
 * Seit S11 steht dazwischen die **Policy-Prüfung**, an der seit S07 vorgesehenen Stelle: nach
 * der Schema-Prüfung steht fest, *was* aufgerufen würde, und vor dem Schritt ist noch nichts
 * geschehen. Sie liegt **vor** der Weiche zwischen `executeStep` und `callRuntimeTool`, nicht
 * in einem der beiden Zweige — sonst gäbe es zwei Tore, und eines davon würde beim nächsten
 * neuen Ausführungsmodus vergessen. Der Router ruft die Engine, nicht umgekehrt
 * (Abschnitt 4.7).
 */

/** Die Session wurde unter einem anderen Tool-Katalog eröffnet als dem, der hier vorliegt. */
export class ToolCatalogMismatchError extends Error {}

export interface ToolRouterDeps {
  pool: Pool;
  /** Wurzel der Artefaktablage, für die Auslagerung. */
  artifactRoot: string;
  catalog: ToolCatalog;
  /**
   * Die Governance-Schicht (S11). **Pflichtfeld ohne Vorgabe.** Eine optionale Engine mit
   * einer nachsichtigen Vorgabe wäre genau der Pfad, den Abschnitt 4.7 ausschließt — und sie
   * entstünde nicht aus Nachlässigkeit, sondern beim ersten Test, dem die Verdrahtung zu
   * umständlich ist.
   */
  policy: PolicyEngine;
  /** Vorgabe: 8k Token-Äquivalent (Abschnitt 13). */
  offloadThresholdTokens?: number;
  /** Vorgabe: das Zeitfenster der Ausführungshülle, 60 s. */
  timeoutMs?: number;
  /** Abbruchsignal des laufenden Runtime-Prozesses (S05). */
  signal?: AbortSignal;
}

export interface ToolCall {
  /**
   * Kennung des Aufrufs, wie sie der Aufrufer (später das Modell) vergibt. Wird zum
   * Idempotenzschlüssel des Schritts: derselbe Aufruf zweimal abgeschickt heißt derselbe
   * Schritt, und der Seiteneffekt läuft genau einmal.
   */
  callId: string;
  name: string;
  input?: Record<string, JsonValue>;
  /**
   * Wer den Aufruf abgesetzt hat — der "Auslöser" aus Abschnitt 10, erste der fünf Angaben,
   * die jede ausgeführte Aktion hinterlassen muss. Vorgabe `"model"`, weil das der Normalfall
   * ist; ein Betreiber, ein Heartbeat (S17) oder ein Test setzt etwas anderes.
   *
   * Die Herkunft ändert die Entscheidung **nicht**. Ein direkt abgesetzter Aufruf bekommt
   * dieselben vier Ebenen wie einer aus dem Modell — sonst wäre "ohne Modell aufrufen" der
   * Weg, an der Governance vorbeizukommen, und genau das prüft das Fertig-Kriterium von S11.
   */
  origin?: string;
}

function matchesType(value: JsonValue, type: ToolFieldType): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

function describeType(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Prüft die Eingabe gegen das Schema und gibt **alle** Beanstandungen zurück, nicht nur die
 * erste: das Modell soll seinen Aufruf in einem Zug reparieren können und nicht in fünf.
 *
 * Unbekannte Felder werden abgewiesen. Sie stillschweigend fallen zu lassen hieße, einen
 * Aufruf auszuführen, den so niemand gemeint hat — das Modell glaubt, es habe `recursive`
 * mitgegeben, das Tool hat es nie gesehen, und beide halten das Ergebnis für richtig.
 */
export function validateToolInput(
  schema: ToolInputSchema,
  input: Record<string, JsonValue>,
): string[] {
  const problems: string[] = [];

  for (const [name, field] of Object.entries(schema.fields)) {
    const value = input[name];
    if (value === undefined || value === null) {
      if (field.required) problems.push(`Pflichtfeld "${name}" (${field.type}) fehlt`);
      continue;
    }
    if (!matchesType(value, field.type)) {
      problems.push(`Feld "${name}" ist ${describeType(value)}, erwartet wird ${field.type}`);
    }
  }

  const known = new Set(Object.keys(schema.fields));
  for (const name of Object.keys(input)) {
    if (!known.has(name)) {
      problems.push(
        `Unbekanntes Feld "${name}" (erlaubt: ${[...known].sort().join(", ") || "keine"})`,
      );
    }
  }

  return problems;
}

/**
 * Ist das, was als `result` des Schritts zurückkam, wirklich eine Hülle?
 *
 * Die Frage stellt sich, weil ein wiederaufgenommener Schritt sein gespeichertes Ergebnis
 * zurückgibt, ohne den Effekt noch einmal zu starten (S05). Träfe ein Idempotenzschlüssel
 * auf einen Schritt, den nicht dieser Router angelegt hat, käme irgendein JSON zurück und
 * würde als Tool-Ergebnis weitergereicht.
 */
function isToolResult(value: JsonValue | null): value is ToolResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, JsonValue>;
  return (
    (candidate.status === "ok" || candidate.status === "error") &&
    typeof candidate.summary === "string" &&
    Array.isArray(candidate.artifact_refs) &&
    Array.isArray(candidate.preview) &&
    candidate.structured !== undefined
  );
}

function errorResult(summary: string, structured: JsonValue): ToolResult {
  return { status: "error", summary, structured, artifact_refs: [], preview: [] };
}

/**
 * Liegt das Ergebnis (auch) hinter einem Handle statt vollständig im Kontext?
 *
 * Zwei Wege führen dorthin, und die Kennzahl aus Abschnitt 12 meint beide: der Router lagert
 * eine zu große Hülle aus (`materializeResult` setzt `structured.offloaded`), oder das Tool
 * hat es selbst getan und gibt einen Ausschnitt plus Handle zurück — so machen es `fs.read`
 * (S08) und `web.fetch` (S09), und ihre Hüllen bleiben deshalb absichtlich unter der
 * Router-Schwelle. Nur den Router zu zählen ergäbe für einen Lauf, der eine 400-KB-Datei
 * liest, einen Anteil von null: die Auslagerung fand statt, nur eben eine Ebene tiefer.
 */
function isOffloadedResult(result: ToolResult): boolean {
  if (result.artifact_refs.length > 0) return true;
  const structured = result.structured;
  return (
    typeof structured === "object" &&
    structured !== null &&
    !Array.isArray(structured) &&
    structured.offloaded === true
  );
}

/**
 * Der Katalog ist pro Session eingefroren (Anti-Muster 2, Abschnitt 7). Diese Prüfung ist
 * die einzige Stelle im Router, die **wirft** statt eine Fehlerhülle zurückzugeben, und das
 * mit Absicht: eine Katalogabweichung ist nichts, was das Modell mit einem anderen Aufruf
 * beheben könnte. Sie sagt, dass dieser Prozess diese Session nicht bedienen darf — eine
 * Lage für den Betreiber, keine Tool-Antwort. Dieselbe Trennlinie wie in der
 * Ausführungshülle (S05): das Ergebnis eines Laufs kommt zurück, die Weigerung zu laufen
 * fliegt.
 */
function assertFrozenCatalog(session: SessionRecord, catalog: ToolCatalog): void {
  if (session.toolCatalogVersion !== catalog.version) {
    throw new ToolCatalogMismatchError(
      `Session ${session.sessionId} wurde mit Tool-Katalog "${session.toolCatalogVersion}" eröffnet, dieser Prozess hält "${catalog.version}". Der Katalog wird innerhalb einer Session nicht ausgetauscht; für den neuen Toolsatz braucht es eine neue Session.`,
    );
  }
}

/**
 * Ruft ein Tool auf und liefert immer die einheitliche Hülle.
 *
 * **Fehler kommen als Ergebnis zurück, nicht als Ausnahme** (Auftrag S07, Abschnitt 7
 * "Fehler nicht verstecken"): ein unbekannter Toolname, eine Schema-Verletzung, ein
 * geworfener Handler und auch eine Weigerung der Ausführungshülle werden zu
 * `status: "error"` mit vollem Fehlertext. Das ist kein Verschlucken, sondern das Gegenteil:
 * der Fehler landet im Verlauf, wo ihn das Modell im selben Lauf noch lesen und beantworten
 * kann. Geglättet wird nichts — `structured.error` trägt den Wortlaut samt Stacktrace.
 *
 * Ereignisse: `tool.requested` vor dem Aufruf, danach `tool.completed` oder `tool.failed`.
 * Die Taxonomie aus Abschnitt 4.4 wird bewusst nicht um `tool.called`/`tool.returned`
 * erweitert — siehe die Abweichungsnotiz in progress.md zu S07.
 *
 * Diese drei Ereignisse liegen **nicht** in der Transaktion des Schritts. Ein Absturz
 * dazwischen hinterlässt ein `tool.requested` ohne Gegenstück, so wie ein abgeschossener
 * Prozess seit S04 ein `runtime.started` ohne `runtime.stopped` hinterlässt. Das ist
 * hinnehmbar, weil die maßgebliche Aussage — lief der Seiteneffekt oder nicht — im
 * Schritt-Paar steht, und das ist transaktional.
 */
export async function callTool(
  deps: ToolRouterDeps,
  session: SessionRecord,
  call: ToolCall,
): Promise<ToolResult> {
  assertFrozenCatalog(session, deps.catalog);

  const input = call.input ?? {};
  const tool = deps.catalog.get(call.name);
  const origin = call.origin ?? "model";

  // Auch der Aufruf eines Tools, das es nicht gibt, wird protokolliert: die Kennzahl
  // "Tool-Auswahlgenauigkeit" (Abschnitt 12) besteht genau aus diesen Fällen.
  await appendEvent(deps.pool, session.sessionId, "tool.requested", {
    call_id: call.callId,
    tool_name: call.name,
    known: tool !== undefined,
    risk: tool?.risk ?? null,
    origin,
    tool_catalog_version: deps.catalog.version,
    input,
  });

  if (!tool) {
    return await failTool(deps, session, call, undefined, `Unbekanntes Tool "${call.name}"`, {
      reason: "unknown_tool",
      known_tools: deps.catalog.tools.map((entry) => entry.name),
    });
  }

  const problems = validateToolInput(tool.inputSchema, input);
  if (problems.length > 0) {
    return await failTool(
      deps,
      session,
      call,
      tool,
      `Eingabe für "${tool.name}" passt nicht zum Schema: ${problems.join("; ")}`,
      { reason: "invalid_input", problems },
    );
  }

  // ---- Die Policy-Prüfung (S11). Ein Tor für beide Ausführungswege. ----
  //
  // `check` hat drei Ausgänge: Freigabe, Ablehnung, Haltepunkt. Der Haltepunkt kommt als
  // geworfener `ApprovalRequiredError` und läuft hier bewusst **durch** — wie
  // `UserInputRequiredError` (S10) und `ToolCatalogMismatchError` (S07): der Lauf ist nicht
  // fehlgeschlagen, er wartet auf einen Menschen. Ein `tool.failed` dafür zu schreiben wäre
  // eine Falschaussage, und die Fehlerhülle im Verlauf brächte das Modell dazu, es mit einem
  // anderen Aufruf zu versuchen, statt die Antwort abzuwarten.
  const verdict = await deps.policy.check(deps.pool, {
    sessionId: session.sessionId,
    callId: call.callId,
    toolName: tool.name,
    risk: tool.risk,
    input,
    approvalMode: session.approvalMode,
    origin,
  });

  if (verdict.kind === "deny") {
    // Eine Ablehnung ist dagegen eine Antwort auf den Aufruf: sie steht endgültig fest, das
    // Modell soll sie im selben Lauf lesen und einen anderen Weg wählen (Abschnitt 7).
    return await failTool(deps, session, call, tool, verdict.summary, {
      reason: "policy_denied",
      audit_id: verdict.auditId,
      effective_risk: verdict.effectiveRisk,
      subject: verdict.subject,
      policy_path: verdict.path as unknown as JsonValue,
    });
  }

  const grant = verdict.grant;

  // `execution: "runtime"`-Tools (task.*, user.ask) laufen ohne die Ausführungshülle: kein
  // externer Seiteneffekt, kein Schritt, keine Auslagerung. Der Katalog und das Schema sind
  // schon geprüft, `tool.requested` steht schon im Protokoll, die Policy hat entschieden.
  if (tool.execution === "runtime") {
    return await callRuntimeTool(deps, session, call, tool, input, grant);
  }

  let outcome: StepOutcome;
  try {
    outcome = await executeStep(
      deps.pool,
      {
        sessionId: session.sessionId,
        // Der Aufruf ist die Arbeit, nicht die Zeile. Ein wiederaufnehmender Prozess leitet
        // denselben Schlüssel aus derselben Aufrufkennung wieder her (S05, Migration 0004).
        idempotencyKey: `tool:${call.callId}`,
        kind: "tool_call",
        toolName: tool.name,
        repeatable: tool.repeatable,
        timeoutMs: deps.timeoutMs,
        signal: deps.signal,
      },
      async (context) => {
        const output = await tool.handler({
          input,
          sessionId: session.sessionId,
          callId: call.callId,
          stepId: context.stepId,
          attempt: context.attempt,
          signal: context.signal,
          policy: grant,
        });
        // Die Auslagerung läuft im Schritt, weil sie dessen `step_id` als Herkunft braucht
        // (S06) und weil ihr Artefakt zum Ergebnis dieses Versuchs gehört: bricht der Schritt
        // danach ab, gehört auch das Artefakt zu dem, was nicht gilt.
        return await materializeResult(
          deps.pool,
          deps.artifactRoot,
          {
            toolName: tool.name,
            sessionId: session.sessionId,
            stepId: context.stepId,
            thresholdTokens: deps.offloadThresholdTokens ?? DEFAULT_OFFLOAD_THRESHOLD_TOKENS,
          },
          output,
        );
      },
    );
  } catch (error) {
    // Ein Abbruch der Session ist **keine** Antwort auf diesen Aufruf, sondern die Aussage,
    // dass der Lauf vorbei ist. Er läuft deshalb seit S12 durch — wie
    // `ToolCatalogMismatchError`, `UserInputRequiredError` und `ApprovalRequiredError`.
    //
    // Bis S12 wurde er zur Fehlerhülle, und das war falsch, wenn auch nicht sichtbar falsch:
    // das Modell las "Schritt nicht ausgeführt", wählte einen anderen Weg, bekam dieselbe
    // Auskunft — und der Lauf verbrannte nach dem Abbruch durch den Nutzer noch so viele
    // Modellaufrufe, bis die Fehlerhäufung griff. Der Loop-Test hat genau das gefunden.
    if (error instanceof SessionCanceledError) throw error;

    // Die übrigen Weigerungen der Hülle bleiben Fehlerhüllen: offener Schritt, nicht
    // wiederholbar, Versuche verbraucht. Für den Aufrufer sind sie eine Antwort auf seinen
    // Aufruf, und der Vertrag "immer die Hülle" gilt gerade hier. `refused` benennt die Lage
    // maschinenlesbar, damit die Schleife ein erschöpftes Wiederholungsbudget von einem
    // Schemafehler unterscheiden kann, ohne im Text zu suchen.
    return await failTool(deps, session, call, tool, describeRefusal(error), {
      reason: "step_refused",
      audit_id: grant.auditId,
      refused: error instanceof Error ? error.constructor.name : "unknown",
      error: describeError(error),
    });
  }

  if (outcome.status === "error") {
    return await failTool(deps, session, call, tool, `Tool "${tool.name}" ist fehlgeschlagen`, {
      reason: "handler_failed",
      audit_id: grant.auditId,
      step_id: outcome.step.stepId,
      error: outcome.error,
    });
  }

  if (!isToolResult(outcome.result)) {
    return await failTool(
      deps,
      session,
      call,
      tool,
      `Schritt ${outcome.step.stepId} zum Schlüssel "tool:${call.callId}" trägt kein Tool-Ergebnis`,
      {
        reason: "foreign_step_result",
        audit_id: grant.auditId,
        step_id: outcome.step.stepId,
        result: outcome.result,
      },
    );
  }

  const result = outcome.result;
  await appendEvent(deps.pool, session.sessionId, "tool.completed", {
    call_id: call.callId,
    tool_name: tool.name,
    risk: tool.risk,
    // Verbindet den Ausgang mit dem Freigabepfad, den die Engine vor dem Lauf geschrieben
    // hat. Ohne die Kennung ließen sich die beiden Hälften des Audit-Eintrags nur über die
    // `call_id` und die Reihenfolge zusammensuchen (policy/audit.ts).
    audit_id: grant.auditId,
    step_id: outcome.step.stepId,
    attempt: outcome.step.attempt,
    // false, wenn der Schlüssel schon abgeschlossen war: das Ergebnis kam aus der Zeile,
    // der Seiteneffekt lief kein zweites Mal (S05).
    executed: outcome.executed,
    summary: result.summary,
    artifact_refs: result.artifact_refs,
    // Kennzahl "Anteil ausgelagerter Tool-Ergebnisse" (Abschnitt 12). Ein Auszug wie
    // `summary` und `artifact_refs`, kein zweites Ergebnis: die Auskunft *dass* ausgelagert
    // wurde, ohne dafür die Hülle des Schritts aufmachen zu müssen.
    offloaded: isOffloadedResult(result),
    // Die vollständige Hülle steht im `result` des zugehörigen step.completed. Sie hier zu
    // wiederholen verdoppelte das Protokoll, ohne etwas herzuleiten — die Faltung der
    // Historie (S12) verbindet beide über die `step_id`.
  });

  return result;
}

function describeRefusal(error: unknown): string {
  return error instanceof Error
    ? `Der Schritt wurde nicht ausgeführt: ${error.message}`
    : `Der Schritt wurde nicht ausgeführt: ${String(error)}`;
}

/**
 * Führt ein `execution: "runtime"`-Tool aus: Handler direkt, ohne Schritt, ohne Auslagerung.
 *
 * `UserInputRequiredError` (aus `user.ask`, wenn die Rückfrage noch offen ist) läuft hier
 * **durch** — wie `ToolCatalogMismatchError` in `callTool`: der Lauf ist nicht
 * fehlgeschlagen, er hält an. Kein `tool.completed`, kein `tool.failed`; das schon
 * geschriebene `tool.requested` bleibt ohne Gegenstück stehen, so wie ein `step.started`
 * eines abgestürzten Prozesses (S07). Der nächste Aufruf mit derselben `call_id` findet die
 * Antwort und schreibt dann `tool.completed`.
 *
 * Jeder andere geworfene Fehler wird zur Fehlerhülle (`handler_failed`), Wortlaut und
 * Stacktrace bleiben erhalten (AGENTS.md).
 */
async function callRuntimeTool(
  deps: ToolRouterDeps,
  session: SessionRecord,
  call: ToolCall,
  tool: ToolDefinition,
  input: Record<string, JsonValue>,
  grant: PolicyGrant,
): Promise<ToolResult> {
  let output: ToolOutput;
  try {
    output = await tool.handler({
      input,
      sessionId: session.sessionId,
      callId: call.callId,
      // Kein Schritt: ein Runtime-Tool schreibt kein Artefakt (dafür fehlte die Herkunft).
      stepId: null,
      attempt: 1,
      signal: deps.signal ?? new AbortController().signal,
      policy: grant,
    });
  } catch (error) {
    if (error instanceof UserInputRequiredError) throw error;
    return await failTool(deps, session, call, tool, `Tool "${tool.name}" ist fehlgeschlagen`, {
      reason: "handler_failed",
      audit_id: grant.auditId,
      error: describeError(error),
    });
  }

  if (typeof output?.summary !== "string" || output.summary.trim() === "") {
    throw new ToolOutputError(
      `Runtime-Tool "${tool.name}" hat keine summary geliefert (Abschnitt 9, Pflichtfeld).`,
    );
  }

  const result: ToolResult = {
    status: "ok",
    summary: output.summary,
    structured: output.structured ?? {},
    artifact_refs: [...(output.artifact_refs ?? [])],
    preview: [...(output.preview ?? [])],
  };

  // Ein Runtime-Tool wird nicht ausgelagert (kein Schritt als Artefaktherkunft). Gibt es
  // trotzdem eine übergroße Hülle zurück, ist das ein Fehler des Tools und keine Stelle für
  // stilles Kürzen — dieselbe Haltung wie in `materializeResult` (S07).
  const threshold = deps.offloadThresholdTokens ?? DEFAULT_OFFLOAD_THRESHOLD_TOKENS;
  if (estimateResultTokens(result) > threshold) {
    throw new ToolOutputTooLargeError(
      `Runtime-Tool "${tool.name}": die Hülle liegt über der Schwelle von ${threshold} Token. Ein Runtime-Tool muss von vornherein knapp bleiben (Kontextstufe 0).`,
    );
  }

  await appendEvent(deps.pool, session.sessionId, "tool.completed", {
    call_id: call.callId,
    tool_name: tool.name,
    risk: tool.risk,
    audit_id: grant.auditId,
    // Kein Schritt, keine Wiederaufnahme: ein Runtime-Tool läuft bei jedem Aufruf.
    step_id: null,
    executed: true,
    summary: result.summary,
    artifact_refs: result.artifact_refs,
    // Ein Runtime-Tool wird nie ausgelagert (siehe oben, kein Schritt als Herkunft).
    offloaded: false,
    // **Hier** steht die vollständige Hülle, und nur hier: zu diesem Aufruf gibt es keinen
    // Schritt, der sie tragen könnte. Die Regel ist damit in beiden Zweigen dieselbe — die
    // Hülle steht genau einmal im Protokoll, nämlich in dem Ereignis, das den Ausgang trägt.
    // Ohne sie verlöre die Historie nach einem Neustart die Antwort eines `user.ask`.
    result,
  });

  return result;
}

async function failTool(
  deps: ToolRouterDeps,
  session: SessionRecord,
  call: ToolCall,
  tool: ToolDefinition | undefined,
  summary: string,
  structured: Record<string, JsonValue>,
): Promise<ToolResult> {
  await appendEvent(deps.pool, session.sessionId, "tool.failed", {
    call_id: call.callId,
    tool_name: call.name,
    risk: tool?.risk ?? null,
    summary,
    ...structured,
  });
  return errorResult(summary, structured);
}
