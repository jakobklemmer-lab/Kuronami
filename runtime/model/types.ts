import type { JsonValue } from "../steps/types.js";

/**
 * Die Modellanbindung als **injizierter Vertrag** (S12).
 *
 * Warum eine Schnittstelle und nicht direkt das SDK an der Aufrufstelle: dieselbe Überlegung
 * wie bei `fetchImpl` in `web.fetch` (S09) und beim Suchanbieter dort. Ein Loop, der fest an
 * einem HTTP-Aufruf hängt, ist nicht prüfbar — er kostet Geld, braucht Netz und antwortet bei
 * jedem Lauf anders. Der Nachweis "Aufgabe mit 30 Schritten läuft durch, überlebt einen
 * Neustart und hält an einer Freigabestelle" verlangt aber genau das Gegenteil: einen
 * Gesprächspartner, der bei gleicher Vorgeschichte gleich antwortet. Also steht hier der
 * Vertrag, in `anthropic.ts` die echte Umsetzung, und der Test stellt seinen eigenen.
 *
 * Die Typen bilden die Messages-API ab und nicht eine eigene Zwischensprache. Eine eigene
 * wäre eine zweite Stelle, an der Blocktypen gepflegt werden müssten, und die erste
 * Abweichung fiele erst im Betrieb auf.
 */

/**
 * Ein Inhaltsblock, wie die API ihn versteht.
 *
 * Bewusst **keine geschlossene Union**. Eine Antwort kann Blöcke tragen, die diese Runtime
 * nicht deutet — `thinking` ist der praktische Fall: er trägt eine Signatur und muss bei der
 * Fortsetzung eines Werkzeuglaufs **unverändert** zurückgereicht werden. Eine Union über die
 * drei Typen, die der Loop selbst baut, hieße, alles Übrige beim Durchreichen zu verlieren,
 * und der Verlust wäre nicht als Fehler sichtbar, sondern als abgelehnte Anfrage später.
 */
export type ModelContentBlock = { type: string } & Record<string, JsonValue>;

export interface ModelMessage {
  role: "user" | "assistant";
  content: ModelContentBlock[];
  /**
   * Cache-Haltepunkt am letzten Block dieser Nachricht (Abschnitt 7). Steht im Typ und nicht
   * als Nebenwirkung im Client: wo der Präfix endet, ist eine Entscheidung des Kontext-Systems
   * und gehört dorthin, wo man sie beim Lesen findet.
   */
  cache?: boolean;
}

/** Ein Block des System-Prompts. `cache` setzt den Haltepunkt hinter diesen Block. */
export interface ModelSystemBlock {
  text: string;
  cache?: boolean;
}

/**
 * Ein Tool, wie die API es sieht. `name` ist der **API-Name** — ohne Punkt, siehe
 * `context/request.ts`. Die Übersetzung passiert im Kontext-System und nicht hier, damit der
 * Test-Client dieselben Namen sieht wie der echte.
 */
export interface ModelToolSpec {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, JsonValue>;
    required: string[];
    additionalProperties: false;
  };
  cache?: boolean;
}

export interface ModelRequest {
  system: ModelSystemBlock[];
  /**
   * Der Tool-Katalog dieser Session, unverändert über alle Züge. Er steht in der
   * Cache-Hierarchie ganz oben (Abschnitt 7): eine Änderung hier entwertet alles darunter.
   */
  tools: ModelToolSpec[];
  messages: ModelMessage[];
  maxTokens: number;
  signal?: AbortSignal;
  /**
   * Textstücke, sobald sie entstehen (Streaming, 2026-09-16). Gesetzt = der Client streamt und
   * ruft dies je Delta; ungesetzt = ein Aufruf, eine Antwort, wie bisher. Die `ModelResponse`
   * ist in beiden Fällen dieselbe — wer nur das Ergebnis braucht, merkt keinen Unterschied.
   */
  onTextDelta?: (text: string) => void;
}

/**
 * Was der Aufruf gekostet hat. `cacheReadTokens` und `cacheCreationTokens` sind die
 * Grundlage der Kennzahl "Cache-Trefferquote" (Abschnitt 12) — ohne sie wäre Prompt-Caching
 * eine Behauptung statt einer Messung.
 */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface ModelToolCall {
  /** `tool_use.id` der Antwort. Wird zur `call_id` und damit zum Idempotenzschlüssel (S07). */
  callId: string;
  /** API-Name, noch nicht zurückübersetzt. Der Loop macht daraus den Katalognamen. */
  name: string;
  input: Record<string, JsonValue>;
}

export interface ModelResponse {
  model: string;
  stopReason: string;
  /** Der Fließtext der Antwort, zusammengefasst über alle Textblöcke. */
  text: string;
  toolCalls: ModelToolCall[];
  usage: ModelUsage;
  /**
   * Die Antwort **so, wie sie kam**. Genau das geht ins `model.responded` und von dort
   * unverändert wieder in die nächste Anfrage: nur damit überlebt ein Werkzeuglauf mit
   * Denkblöcken den Prozessneustart. `text` und `toolCalls` sind Auszüge daraus, keine
   * zweite Wahrheit.
   */
  content: ModelContentBlock[];
}

export interface ModelClient {
  /** Steht im `model.requested`/`model.responded` und darf sich in einer Session nie ändern. */
  readonly model: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

/** Der Aufruf beim Anbieter ist gescheitert. Trägt den Wortlaut, nicht seine Glättung. */
export class ModelCallError extends Error {}

export function textBlock(text: string): ModelContentBlock {
  return { type: "text", text };
}

export function toolResultBlock(
  toolUseId: string,
  content: string,
  isError: boolean,
): ModelContentBlock {
  return { type: "tool_result", tool_use_id: toolUseId, content, is_error: isError };
}

export function isToolUseBlock(
  block: ModelContentBlock,
): block is ModelContentBlock & { id: string; name: string; input: Record<string, JsonValue> } {
  return (
    block.type === "tool_use" &&
    typeof block.id === "string" &&
    typeof block.name === "string" &&
    typeof block.input === "object" &&
    block.input !== null &&
    !Array.isArray(block.input)
  );
}
