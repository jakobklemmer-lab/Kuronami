import { DEFAULT_MODEL } from "./anthropic.js";
import type { ModelClient } from "./types.js";

/**
 * Modell-Routing (Abschnitt 11, Auftrag S18e): ein Routing-Schritt **vor dem eigentlichen
 * Lauf**, der grob zwischen zwei Klassen unterscheidet —
 *
 *   * **Routine** — "Klassifikation, Routing, Extraktion, 'ist das fertig?'" (Abschnitt 11):
 *     klein und günstig.
 *   * **Denkarbeit** — "Planen, mehrstufiges Reasoning, Formulieren" (Abschnitt 11): stark.
 *
 * und danach **eines** der beiden Modelle für den ganzen Lauf wählt. "Vor dem eigentlichen
 * Lauf" ist wörtlich gemeint: die Entscheidung fällt einmal, bevor eine Session existiert
 * (`runtime/loop/api.ts`, `createRunner`), nicht bei jedem Schritt neu — Abschnitt 7 verbietet
 * ausdrücklich, das Modell mitten in einer Session zu wechseln ("stattdessen Subagent
 * starten"). Ein Lauf trägt damit von Anfang bis Ende genau ein Modell, wie seit S12.
 *
 * ## Die Modellzuteilung ist eine Konfiguration, keine Registry
 *
 * `ModelRouteConfig` ist zwei Werte mit Startvorgabe, überschreibbar über zwei Umgebungs-
 * variablen — bewusst **keine** Tabelle mit einem Eintrag pro Agent oder Rolle. Genau das baut
 * erst S19 (`agent.create`, Agenten-Registry): dort bekommt jeder Agent seine eigene
 * Modellwahl, hier gibt es nur zwei globale Werte für die ganze Runtime. **Wenn S19 kommt,
 * ersetzt die Registry diese Datei** — `routeTask` bekäme ihre zwei Modelle dann aus einem
 * Registry-Eintrag statt aus `resolveModelRouteConfig`, aber der Aufrufer in
 * `runtime/loop/api.ts` bliebe unverändert: er reicht weiterhin nur zwei `ModelClient`s herein
 * und bekommt eine `RouteDecision` zurück.
 *
 * ## Der Router nutzt selbst das günstigste sinnvolle Modell
 *
 * Die Klassifikation ist selbst "Klassifikation" im Sinne der Tabelle oben — sie bekommt daher
 * keinen dritten, eigenen Modell-Client, sondern läuft über `routineModel`: dasselbe günstige
 * Modell, das auch für Routineaufgaben selbst läuft. Ein Klassifikationsschritt, der das starke
 * Modell bräuchte, widerspräche dem eigenen Zweck.
 */

export type TaskClass = "routine" | "thinking";

/** Startvorgabe für Routinearbeit — klein und günstig (Abschnitt 11). */
export const DEFAULT_ROUTINE_MODEL = "claude-haiku-4-5-20251001";

/**
 * Startvorgabe für Denkarbeit — dieselbe wie der Orchestrator (`DEFAULT_MODEL`, `anthropic.ts`).
 * Ohne Router ändert sich damit nichts: ein Lauf ohne `router`-Konfiguration bekommt weiterhin
 * genau das Modell, das er schon immer bekam.
 */
export const DEFAULT_THINKING_MODEL = DEFAULT_MODEL;

export interface ModelRouteConfig {
  routineModel: string;
  thinkingModel: string;
}

function envModel(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

/**
 * Liest die Modellzuteilung aus `MODEL_ROUTINE`/`MODEL_THINKING`, mit Startwerten. Das ist die
 * ganze Konfiguration (Auftrag S18e: "einfache Konfigurationsdatei/Env-Var, keine
 * Registry-Tabelle").
 */
export function resolveModelRouteConfig(overrides?: Partial<ModelRouteConfig>): ModelRouteConfig {
  return {
    routineModel: overrides?.routineModel ?? envModel("MODEL_ROUTINE", DEFAULT_ROUTINE_MODEL),
    thinkingModel: overrides?.thinkingModel ?? envModel("MODEL_THINKING", DEFAULT_THINKING_MODEL),
  };
}

export interface ModelRouterDeps {
  /** Für Routineaufgaben **und** für die Klassifikation selbst. */
  routineModel: ModelClient;
  /** Für Denkarbeit. */
  thinkingModel: ModelClient;
  signal?: AbortSignal;
}

export interface RouteDecision {
  taskClass: TaskClass;
  /** Die Begründung des Klassifikators, unverändert — landet im Ereignisprotokoll. */
  reason: string;
  /** Das für den Lauf gewählte Modell. */
  model: ModelClient;
  /** Welches Modell klassifiziert hat — immer `routineModel.model` (siehe Moduldoku). */
  classifierModel: string;
}

const CLASSIFIER_SYSTEM_PROMPT = [
  "Du bist ein Modell-Router. Du triffst keine inhaltliche Entscheidung, sondern ordnest die",
  "folgende Aufgabe in genau eine von zwei Klassen ein:",
  "",
  "ROUTINE — kurze, mechanische Arbeit ohne mehrstufiges Planen oder Abwägen: Status abfragen,",
  "etwas nachschlagen, eine feste Vorlage ausfüllen, eine einfache Ja/Nein-Entscheidung.",
  "THINKING — mehrstufiges Planen, Abwägen zwischen mehreren vertretbaren Wegen, Entwerfen,",
  "Formulieren, alles mit inhaltlicher Unsicherheit.",
  "",
  "Antworte in genau dieser Form, eine Zeile, sonst nichts:",
  "KLASSE: kurze Begründung in einem Satz",
  "KLASSE ist ROUTINE oder THINKING, großgeschrieben.",
].join("\n");

const CLASSIFICATION_PATTERN = /^(ROUTINE|THINKING)\s*[:\-]?\s*(.*)$/is;

/** Cheap: die Antwort ist eine Klassenmarke plus ein Satz Begründung, kein Fließtext. */
const CLASSIFIER_MAX_TOKENS = 128;

function parseClassification(text: string): { taskClass: TaskClass; reason: string } {
  const trimmed = text.trim();
  const match = CLASSIFICATION_PATTERN.exec(trimmed);
  if (match) {
    const taskClass: TaskClass = match[1].toUpperCase() === "ROUTINE" ? "routine" : "thinking";
    return { taskClass, reason: match[2].trim() || trimmed };
  }
  // Uneindeutige Antwort: sicherer Fallback ist die stärkere Klasse, nicht die günstigere — eine
  // unterversorgte Denkaufgabe kostet mehr (falsches Ergebnis) als eine überversorgte
  // Routineaufgabe (unnötige Kosten für einen Lauf).
  return {
    taskClass: "thinking",
    reason: `Antwort des Klassifikators nicht eindeutig ("${trimmed.slice(0, 200)}"), sicherer Fallback auf Denkarbeit.`,
  };
}

/**
 * Klassifiziert `input` über `deps.routineModel` und wählt danach das passende Modell. Wirft,
 * wenn der Klassifikationsaufruf selbst scheitert (Netz, Anbieter) — kein stiller Fallback
 * (AGENTS.md: "Fehler nie verstecken oder glätten"). Anders als bei der Kompaktierung (S18a,
 * die bei einem gescheiterten Modellaufruf mit der unkompaktierten Historie weiterläuft) gibt
 * es hier keine sinnvolle Rückfalloption: welches Modell den ganzen Lauf trägt, ist keine
 * Bequemlichkeit, die man auslassen könnte.
 */
export async function routeTask(deps: ModelRouterDeps, input: string): Promise<RouteDecision> {
  const response = await deps.routineModel.complete({
    system: [{ text: CLASSIFIER_SYSTEM_PROMPT }],
    tools: [],
    messages: [{ role: "user", content: [{ type: "text", text: input }] }],
    maxTokens: CLASSIFIER_MAX_TOKENS,
    signal: deps.signal,
  });

  const { taskClass, reason } = parseClassification(response.text);
  return {
    taskClass,
    reason,
    model: taskClass === "routine" ? deps.routineModel : deps.thinkingModel,
    classifierModel: deps.routineModel.model,
  };
}
