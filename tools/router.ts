import type { Pool } from "pg";
import { appendEvent } from "../runtime/events/log.js";
import type { SessionRecord } from "../runtime/session/types.js";
import { type StepOutcome, describeError, executeStep } from "../runtime/steps/hull.js";
import type { JsonValue } from "../runtime/steps/types.js";
import { DEFAULT_OFFLOAD_THRESHOLD_TOKENS, materializeResult } from "./offload.js";
import type {
  ToolCatalog,
  ToolDefinition,
  ToolFieldType,
  ToolInputSchema,
  ToolResult,
} from "./types.js";

/**
 * Der Tool-Router: das Tor zu allen Seiteneffekten. Jeder Tool-Aufruf geht hier durch.
 *
 * Was hier zusammenläuft und warum an genau dieser Stelle:
 *   * die **einheitliche Rückgabehülle** (Abschnitt 9) — der Router ist die einzige Stelle,
 *     die sie herstellt, deshalb kann kein Tool eine andere Form zurückgeben;
 *   * die **Ausführungshülle** aus S05 — jeder Aufruf ist ein Schritt mit Checkpoint davor
 *     und danach, mit Idempotenzschlüssel und Zeitfenster (Abschnitt 6);
 *   * die **automatische Auslagerung** (Abschnitt 4.5) — gemessen an der fertigen Hülle;
 *   * der **eingefrorene Katalog** — eine Session wird nur von dem Prozess bedient, der
 *     denselben Tool-Vertrag hält.
 *
 * Die Policy-Engine kommt mit S11 hierher und nicht andersherum (Abschnitt 4.7: "Der
 * Tool-Router ruft die Policy-Engine, nicht umgekehrt"). Der Platz dafür ist zwischen der
 * Schema-Prüfung und `executeStep`: nach der Prüfung steht fest, *was* aufgerufen würde,
 * und vor dem Schritt ist noch nichts geschehen.
 */

/** Die Session wurde unter einem anderen Tool-Katalog eröffnet als dem, der hier vorliegt. */
export class ToolCatalogMismatchError extends Error {}

export interface ToolRouterDeps {
  pool: Pool;
  /** Wurzel der Artefaktablage, für die Auslagerung. */
  artifactRoot: string;
  catalog: ToolCatalog;
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

  // Auch der Aufruf eines Tools, das es nicht gibt, wird protokolliert: die Kennzahl
  // "Tool-Auswahlgenauigkeit" (Abschnitt 12) besteht genau aus diesen Fällen.
  await appendEvent(deps.pool, session.sessionId, "tool.requested", {
    call_id: call.callId,
    tool_name: call.name,
    known: tool !== undefined,
    risk: tool?.risk ?? null,
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
          stepId: context.stepId,
          attempt: context.attempt,
          signal: context.signal,
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
    // Die Hülle hat sich geweigert zu starten: Session abgebrochen, Schritt offen, nicht
    // wiederholbar, Versuche verbraucht. Für den Aufrufer des Routers ist auch das eine
    // Antwort auf seinen Aufruf, und der Vertrag "immer die Hülle" gilt gerade hier.
    // `refused` benennt die Lage maschinenlesbar, damit die Schleife (S12) einen Abbruch von
    // einem erschöpften Wiederholungsbudget unterscheiden kann, ohne im Text zu suchen.
    return await failTool(deps, session, call, tool, describeRefusal(error), {
      reason: "step_refused",
      refused: error instanceof Error ? error.constructor.name : "unknown",
      error: describeError(error),
    });
  }

  if (outcome.status === "error") {
    return await failTool(deps, session, call, tool, `Tool "${tool.name}" ist fehlgeschlagen`, {
      reason: "handler_failed",
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
    step_id: outcome.step.stepId,
    attempt: outcome.step.attempt,
    // false, wenn der Schlüssel schon abgeschlossen war: das Ergebnis kam aus der Zeile,
    // der Seiteneffekt lief kein zweites Mal (S05).
    executed: outcome.executed,
    summary: result.summary,
    artifact_refs: result.artifact_refs,
    // Die vollständige Hülle steht im `result` des zugehörigen step.completed. Sie hier zu
    // wiederholen verdoppelte das Protokoll, ohne etwas herzuleiten.
  });

  return result;
}

function describeRefusal(error: unknown): string {
  return error instanceof Error
    ? `Der Schritt wurde nicht ausgeführt: ${error.message}`
    : `Der Schritt wurde nicht ausgeführt: ${String(error)}`;
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
