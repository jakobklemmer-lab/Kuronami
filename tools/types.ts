import type { JsonValue } from "../runtime/steps/types.js";

/**
 * Was ein Tool ist und was es zurückgibt — unabhängig davon, wer es registriert (Registry)
 * und wer es aufruft (Router). Beide Seiten hängen an diesen Typen, keine an der anderen.
 */

/**
 * Erlaubte Namensräume (Abschnitt 4.8). `dev` ist seit S07 dabei und in Abschnitt 4.8 der
 * Architektur begründet: Prüf-Tools des Harness, die nie in einem echten Tool-Katalog
 * stehen. Ein neuer Namensraum braucht eine Begründung in `docs/` (AGENTS.md).
 */
export const TOOL_NAMESPACES = [
  "fs",
  "web",
  "exec",
  "task",
  "user",
  "agent",
  "mail",
  "cal",
  "notes",
  "github",
  "server",
  "dev",
] as const;

export type ToolNamespace = (typeof TOOL_NAMESPACES)[number];

/** Risikostufen aus Abschnitt 10. Entspricht `kuronami.risk_level` aus Migration 0001. */
export type RiskLevel = "read" | "soft_write" | "hard_write" | "destructive";

export type ToolFieldType = "string" | "number" | "boolean" | "object" | "array";

export interface ToolField {
  type: ToolFieldType;
  required: boolean;
  /** Geht so in den Tool-Katalog des Modells. Kein Kommentar, sondern Teil des Vertrags. */
  description: string;
}

/**
 * Bewusst winzig und ohne Bibliothek. Ein vollständiges JSON-Schema samt Validator wäre eine
 * neue Abhängigkeit für einen Aktionsraum, der laut Grundprinzip 4 klein und stabil bleibt;
 * was hier fehlt (verschachtelte Schemata, Aufzählungen, Wertebereiche), fehlt sichtbar und
 * lässt sich nachrüsten, wenn ein echtes Tool es braucht.
 */
export interface ToolInputSchema {
  fields: Record<string, ToolField>;
}

/**
 * Die einheitliche Rückgabehülle aus Abschnitt 9, verbindlich für **jedes** Tool. Feldnamen
 * in snake_case, weil das hier kein internes TypeScript-Objekt ist, sondern ein
 * Übertragungsformat: es geht als `result` durch jsonb, ins Ereignisprotokoll und in den
 * Modellkontext.
 */
export type ToolResult = {
  status: "ok" | "error";
  /** Kurz und für das Modell gedacht. Bei `error` der Grund, nicht die Beschönigung. */
  summary: string;
  /** Maschinenlesbares Ergebnis. Wird ausgelagert, sobald die Hülle zu groß wird. */
  structured: JsonValue;
  artifact_refs: string[];
  preview: string[];
  // Ein `type` und kein `interface`: nur ein Typalias bekommt in TypeScript die implizite
  // Indexsignatur, mit der die Hülle als `JsonValue` durchgeht. Und genau das muss sie —
  // sie ist das `result` eines Schritts und geht als jsonb durch die Datenbank.
};

/**
 * Was ein Handler zurückgibt. `status` fehlt mit Absicht: ob ein Aufruf geglückt ist,
 * entscheidet der Router an der Frage, ob der Handler zurückkam oder geworfen hat — nicht
 * das Tool über ein Feld, das es auch falsch setzen könnte.
 */
export interface ToolOutput {
  summary: string;
  structured?: JsonValue;
  artifact_refs?: string[];
  preview?: string[];
}

/** Was ein Handler über seinen eigenen Aufruf weiß. */
export interface ToolInvocation {
  readonly input: Record<string, JsonValue>;
  readonly sessionId: string;
  /** Der Schritt, in dem dieser Aufruf läuft. Wird zur Herkunft eines Artefakts. */
  readonly stepId: string;
  readonly attempt: number;
  /** Bricht bei Zeitüberschreitung und bei Abbruch von außen (S05). */
  readonly signal: AbortSignal;
}

export type ToolHandler = (invocation: ToolInvocation) => Promise<ToolOutput>;

export interface ToolDefinition {
  /** `namensraum.aktion`, kleingeschrieben, Punkt als Trenner (Abschnitt 4.8). */
  name: string;
  /** Was das Tool tut, in der Fassung, die das Modell zu lesen bekommt. */
  description: string;
  inputSchema: ToolInputSchema;
  risk: RiskLevel;
  /**
   * Darf ein unterbrochener Aufruf wiederholt werden? Pflichtfeld ohne Vorgabewert, aus
   * demselben Grund wie in `StepSpec` (S05): das ist eine Aussage über die Außenwelt, und
   * treffen kann sie nur, wer das Tool schreibt. Aus der Risikostufe abzuleiten wäre
   * naheliegend und falsch — ein `soft_write` legt beim zweiten Lauf ein zweites Artefakt an.
   */
  repeatable: boolean;
  handler: ToolHandler;
}

/** Ein Tool, wie es im Prompt-Katalog erscheint. Deckt sich mit `ToolStub` in `context/`. */
export interface ToolStub {
  name: string;
  description: string;
  risk: RiskLevel;
}

/**
 * Der eingefrorene Katalog einer Session. Es gibt keinen Weg, ihm nachträglich ein Tool
 * hinzuzufügen: `ToolRegistry.freeze()` gibt diese Sicht zurück, und sie hat keine
 * schreibende Methode. Den Toolsatz mitten in der Session umzubauen ist Anti-Muster 2 und
 * entwertet nach Abschnitt 7 den gesamten Cache darunter.
 */
export interface ToolCatalog {
  /** Aus dem Inhalt abgeleitet, siehe `registry.ts`. */
  readonly version: string;
  /** Nach Namen sortiert, damit die Serialisierung nicht an der Registrierreihenfolge hängt. */
  readonly tools: readonly ToolDefinition[];
  get(name: string): ToolDefinition | undefined;
  stubs(): ToolStub[];
}
