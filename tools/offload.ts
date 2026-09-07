import type { Pool } from "pg";
import { writeArtifact } from "../runtime/artifacts/store.js";
import type { ToolOutput, ToolResult } from "./types.js";

/**
 * Die automatische Auslagerung aus Abschnitt 4.5 und Kontextstufe 1: "Große Ergebnisse
 * sofort auslagern, nur Zusammenfassung plus Handle zurück".
 */

/**
 * Grobe Umrechnung von Bytes in Token. Die Architektur sagt bewusst "Token-Äquivalent" und
 * nicht "Token": der genaue Wert hängt am Tokenizer des jeweiligen Modells, und ihn hier
 * exakt bestimmen zu wollen hieße, den Aktionsraum an ein Modell zu binden. Vier Bytes je
 * Token ist die übliche Näherung für lateinische Schrift; für deutschen Text und für JSON
 * mit vielen Trennzeichen schätzt sie eher zu niedrig, die Schwelle greift also eher zu
 * spät als zu früh — deshalb steht der Startwert am unteren Ende der Spanne.
 */
export const TOKEN_EQUIVALENT_BYTES = 4;

/** Untere Grenze der Spanne "8k bis 16k Token-Äquivalent" aus Abschnitt 13. */
export const DEFAULT_OFFLOAD_THRESHOLD_TOKENS = 8_000;

/** Ein Handler hat eine Ausgabe geliefert, die den Vertrag aus Abschnitt 9 verletzt. */
export class ToolOutputError extends Error {}

/**
 * Auch nach der Auslagerung passt die Hülle nicht unter die Schwelle. Dann sind `summary`
 * oder `preview` selbst zu groß, und das ist ein Fehler des Tools (Kontextstufe 0:
 * "Tool-Ergebnisse von vornherein knapp"), kein Fall für eine stille Kürzung.
 */
export class ToolOutputTooLargeError extends Error {}

export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / TOKEN_EQUIVALENT_BYTES);
}

/** Gemessen wird, was tatsächlich in den Kontext ginge: die serialisierte Hülle. */
export function estimateResultTokens(result: ToolResult): number {
  return estimateTokens(JSON.stringify(result));
}

export interface OffloadContext {
  toolName: string;
  sessionId: string;
  /** Der Schritt, in dem der Aufruf läuft. Wird zur Herkunft des Artefakts (S06). */
  stepId: string;
  thresholdTokens: number;
}

function assertOutput(context: OffloadContext, output: ToolOutput): void {
  if (typeof output?.summary !== "string" || output.summary.trim() === "") {
    throw new ToolOutputError(
      `Tool "${context.toolName}" hat keine summary geliefert. Sie ist das Feld, das statt der Bytes in den Modellkontext geht, und deshalb Pflicht (Abschnitt 9).`,
    );
  }
}

/**
 * Baut aus der Ausgabe eines Handlers die vollständige Hülle und lagert sie aus, sobald sie
 * die Schwelle überschreitet.
 *
 * Ausgelagert wird `structured` — der einzige unbegrenzte Teil der Hülle. `summary`,
 * `preview` und die Handles bleiben im Kontext; genau sie sind der Grund, warum eine
 * Auslagerung nichts kostet: das Modell sieht weiter, *was* da ist, und kann die Bytes über
 * das Handle nachladen, wenn es sie braucht.
 *
 * Die Entscheidung fällt an der gemessenen Größe und nicht am Tool. Ein Tool, das seine
 * Ausgabe für klein hält, sie aber nicht ist, wird trotzdem ausgelagert — Anti-Muster 3
 * ("Rohe Tool-Ausgaben in den Kontext fluten lassen") lässt sich nicht dadurch vermeiden,
 * dass man jedem Tool zutraut, sich selbst zu bremsen.
 */
export async function materializeResult(
  pool: Pool,
  artifactRoot: string,
  context: OffloadContext,
  output: ToolOutput,
): Promise<ToolResult> {
  assertOutput(context, output);

  const direct: ToolResult = {
    status: "ok",
    summary: output.summary,
    structured: output.structured ?? {},
    artifact_refs: [...(output.artifact_refs ?? [])],
    preview: [...(output.preview ?? [])],
  };

  if (estimateResultTokens(direct) <= context.thresholdTokens) return direct;

  const bytes = JSON.stringify(direct.structured, null, 2);
  const meta = await writeArtifact(pool, artifactRoot, {
    content: bytes,
    mimeType: "application/json",
    summary: output.summary,
    source: { tool: context.toolName, sessionId: context.sessionId, stepId: context.stepId },
  });

  const offloaded: ToolResult = {
    ...direct,
    // Was im Kontext bleibt: die Auskunft, dass ausgelagert wurde, und alles, womit sich das
    // Handle beurteilen lässt, ohne es aufzulösen — dieselben Felder, die `headArtifact`
    // ohne Dateizugriff liefert (S06).
    structured: {
      offloaded: true,
      uri: meta.uri,
      mime_type: meta.mimeType,
      size_bytes: meta.sizeBytes,
      sha256: meta.sha256,
    },
    artifact_refs: [...direct.artifact_refs, meta.uri],
  };

  const remaining = estimateResultTokens(offloaded);
  if (remaining > context.thresholdTokens) {
    // Nicht stillschweigend kürzen. Eine gekürzte summary sähe aus wie eine echte, und das
    // Modell hätte keine Möglichkeit zu merken, dass ihm etwas fehlt. Das Handle steht im
    // Fehlertext, die Bytes sind also nicht verloren.
    throw new ToolOutputTooLargeError(
      `Tool "${context.toolName}": auch nach der Auslagerung bleibt die Hülle bei ~${remaining} Token über der Schwelle von ${context.thresholdTokens}. summary oder preview sind selbst zu groß (Kontextstufe 0). Die Bytes liegen unter ${meta.uri}.`,
    );
  }

  return offloaded;
}
