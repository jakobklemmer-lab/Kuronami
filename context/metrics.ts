import type { EventRecord } from "../runtime/events/log.js";

/**
 * Die Kennzahlen des Harness (Abschnitt 12), gefaltet aus dem Protokoll.
 *
 * "Nicht nur das Modell instrumentieren, sondern das Harness." Und: sie werden **nicht extra
 * für die Oberfläche erfunden** — deshalb gibt es hier keine eigene Tabelle und keinen
 * Zähler im Prozess, sondern eine Faltung über dieselben Ereignisse, aus denen auch der
 * Zustand kommt. Ein Zähler im Speicher wäre nach einem Neustart bei null und behauptete
 * eine Trefferquote, die nur die des letzten Prozesses ist.
 *
 * Vier der Kennzahlen aus Abschnitt 12 stehen hier; die übrigen (Freigaben pro Aufgabe,
 * Wartezeit auf Freigabe, Tool-Latenz) brauchen Zeitmessungen über Ereignispaare hinweg und
 * gehören zur Beobachtbarkeits-Session, nicht hierher.
 */

export interface RunMetrics {
  /** Modellaufrufe mit Antwort. */
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /**
   * **Cache-Trefferquote.** Anteil der Eingabe-Token, die aus dem Cache kamen, an allen
   * Eingabe-Token.
   *
   * Der Nenner ist bewusst die gesamte Eingabe und nicht nur der zwischengespeicherte Teil:
   * gemessen werden soll, wie viel des Prompts der Cache trägt, nicht wie oft ein Treffer
   * gelang. Ein Lauf, dessen Präfix zu kurz für den Cache ist, hat damit eine Quote von 0 —
   * und das ist die richtige Auskunft, nicht "kein Datenpunkt".
   */
  cacheHitRate: number;
  toolCalls: number;
  failedToolCalls: number;
  /** Anteil ausgelagerter Tool-Ergebnisse (Kontextstufe 1) an allen erfolgreichen Aufrufen. */
  offloadedResults: number;
  offloadShare: number;
  approvalsRequested: number;
  /**
   * "Kompaktierungshäufigkeit" (Abschnitt 12): wie oft Kontextstufe 2 oder 3 in diesem Lauf
   * gegriffen hat (S18a, `context/compaction.ts`). Gezählt wird das Ereignis, nicht sein
   * Inhalt — dieselbe Kennzahl, die auch `turn.completed` als `context_compactions` trägt.
   */
  contextCompactions: number;
  /**
   * Wie oft Kontextstufe 4 gegriffen hat (S18b, `context/section.ts`) — absichtlich getrennt
   * von `contextCompactions` und nicht mitgezählt: ein frischer Abschnitt ist kein weiterer
   * Fall von "Kompaktierung greift zu oft", sondern das Gegenteil, ein proaktiver Neuanfang, und
   * der bestehende 110-Schritte-Nachweis aus S18a prüft `context_compactions` auf einen exakten
   * Wert (`stage2.length + stage3.length`) — eine dritte Ereignisart in dieselbe Zahl zu falten
   * hätte diesen Nachweis brechen können, ohne dass sich am Verhalten etwas geändert hätte.
   */
  freshSections: number;
}

function share(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole;
}

export function deriveRunMetrics(events: EventRecord[]): RunMetrics {
  let modelCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let toolCalls = 0;
  let failedToolCalls = 0;
  let offloadedResults = 0;
  let approvalsRequested = 0;
  let contextCompactions = 0;
  let freshSections = 0;

  for (const event of events) {
    switch (event.type) {
      case "model.responded": {
        modelCalls += 1;
        const usage = event.payload.usage;
        if (typeof usage === "object" && usage !== null && !Array.isArray(usage)) {
          const entry = usage as Record<string, unknown>;
          inputTokens += typeof entry.input_tokens === "number" ? entry.input_tokens : 0;
          outputTokens += typeof entry.output_tokens === "number" ? entry.output_tokens : 0;
          cacheReadTokens +=
            typeof entry.cache_read_input_tokens === "number" ? entry.cache_read_input_tokens : 0;
          cacheCreationTokens +=
            typeof entry.cache_creation_input_tokens === "number"
              ? entry.cache_creation_input_tokens
              : 0;
        }
        break;
      }
      case "tool.completed":
        toolCalls += 1;
        if (event.payload.offloaded === true) offloadedResults += 1;
        break;
      case "tool.failed":
        toolCalls += 1;
        failedToolCalls += 1;
        break;
      case "approval.requested":
        approvalsRequested += 1;
        break;
      case "context.compacted":
        contextCompactions += 1;
        break;
      case "context.section_started":
        freshSections += 1;
        break;
      default:
        break;
    }
  }

  const totalInput = inputTokens + cacheReadTokens + cacheCreationTokens;
  return {
    modelCalls,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheHitRate: share(cacheReadTokens, totalInput),
    toolCalls,
    failedToolCalls,
    offloadedResults,
    offloadShare: share(offloadedResults, toolCalls - failedToolCalls),
    approvalsRequested,
    contextCompactions,
    freshSections,
  };
}

/** Eine Zeile für das Protokoll des Betreibers. Kennzahlen, die niemand sieht, gibt es nicht. */
export function formatRunMetrics(metrics: RunMetrics): string {
  const percent = (value: number): string => `${(value * 100).toFixed(1)} %`;
  return [
    `${metrics.modelCalls} Modellaufrufe`,
    `${metrics.toolCalls} Tool-Aufrufe (${metrics.failedToolCalls} fehlgeschlagen)`,
    `Cache-Trefferquote ${percent(metrics.cacheHitRate)} (${metrics.cacheReadTokens} von ${
      metrics.inputTokens + metrics.cacheReadTokens + metrics.cacheCreationTokens
    } Eingabe-Token)`,
    `ausgelagert ${metrics.offloadedResults} (${percent(metrics.offloadShare)})`,
    `${metrics.approvalsRequested} Rückfragen`,
    `${metrics.contextCompactions} Kompaktierungen`,
    `${metrics.freshSections} frische Abschnitte`,
  ].join(", ");
}
