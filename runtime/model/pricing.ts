import type { ModelUsage } from "./types.js";

/**
 * Was ein Modellaufruf kostet (S28, Abschnitt 11/12: "Kosten-Tracking").
 *
 * ## Warum eine Tabelle im Quelltext und keine Abfrage
 *
 * Preise sind eine Vereinbarung mit dem Anbieter, keine Laufzeitgröße: sie ändern sich selten,
 * und wenn, dann als Ereignis, das jemand mitbekommen soll. Eine Tabelle in einer versionierten
 * Datei macht jede Änderung zu einem sichtbaren Commit — dieselbe Haltung wie bei der Musterliste
 * in `runtime/redaction/patterns.ts` ("die Reichweite ändert man über eine sichtbare Änderung an
 * einer versionierten Datei"). Ein Abruf beim Anbieter wäre eine Netzabhängigkeit für eine Zahl,
 * die sich in Monaten nicht bewegt.
 *
 * ## Ein unbekanntes Modell bekommt keinen geratenen Preis
 *
 * `priceOf` liefert `null` statt einer Näherung. Eine geratene Zahl sähe in einer Kostenübersicht
 * aus wie eine gemessene — dasselbe Argument wie bei den Risikostufen in AGENTS.md ("keine
 * Vorgabe für ein Tool, das keine angibt: eine geratene Stufe sieht aus wie eine entschiedene").
 * Die Faltung in `context/costs.ts` trägt unbepreiste Modelle deshalb namentlich heraus, statt
 * sie stillschweigend als 0 zu zählen.
 */

/** Preis je Million Token, in US-Dollar. */
export interface ModelPrice {
  input: number;
  output: number;
  /** Lesen aus dem Cache. Vorgabe der Anbieterdokumentation: ein Zehntel des Eingabepreises. */
  cacheRead: number;
  /** Schreiben in den Cache (5-Minuten-Fenster): das 1,25-fache des Eingabepreises. */
  cacheWrite: number;
}

/** Faktoren aus der Anbieterdokumentation, aus denen sich die beiden Cache-Preise ergeben. */
export const CACHE_READ_FACTOR = 0.1;
export const CACHE_WRITE_FACTOR = 1.25;

function price(input: number, output: number): ModelPrice {
  return {
    input,
    output,
    cacheRead: input * CACHE_READ_FACTOR,
    cacheWrite: input * CACHE_WRITE_FACTOR,
  };
}

/**
 * Stand der Tabelle. Steht in der Ausgabe der Kostenansicht, damit ein Betrachter sieht, wie alt
 * die Grundlage ist — eine Kostenzahl ohne Preisstand ist eine Behauptung ohne Datum.
 */
export const PRICING_AS_OF = "2026-06-24";

/**
 * Listenpreise der Anthropic-API je Million Token (Stand siehe `PRICING_AS_OF`).
 * Partnerplattformen (Bedrock, Vertex) rechnen eigenständig ab und stehen bewusst nicht hier.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-fable-5-1": price(10, 50),
  "claude-fable-5": price(10, 50),
  "claude-mythos-5-1": price(10, 50),
  "claude-opus-5": price(5, 25),
  "claude-opus-4-8": price(5, 25),
  "claude-opus-4-7": price(5, 25),
  "claude-opus-4-6": price(5, 25),
  "claude-sonnet-5": price(2, 10),
  "claude-sonnet-4-6": price(3, 15),
  "claude-haiku-4-5": price(1, 5),
};

/**
 * Der Preis eines Modells, oder `null`, wenn die Tabelle es nicht kennt.
 *
 * Ein Modellname aus dem Protokoll kann eine datierte Fassung sein (`claude-opus-5-20260401`)
 * oder ein Anbieter-Präfix tragen (`anthropic.claude-opus-5` auf Bedrock). Beides wird auf den
 * Grundnamen zurückgeführt, bevor aufgegeben wird — sonst stünde ein Lauf ohne Preis da, obwohl
 * die Tabelle sein Modell kennt.
 */
export function priceOf(model: string): ModelPrice | null {
  const direct = MODEL_PRICES[model];
  if (direct) return direct;

  const withoutVendor = model.includes(".") ? (model.split(".").pop() as string) : model;
  const byVendor = MODEL_PRICES[withoutVendor];
  if (byVendor) return byVendor;

  // Datierte Fassung: `…-20260401` bzw. `…@20260401` abschneiden.
  const undated = withoutVendor.replace(/[-@]\d{8}$/, "");
  return MODEL_PRICES[undated] ?? null;
}

/** Was dieser eine Aufruf kostet, in US-Dollar — oder `null` bei unbekanntem Modell. */
export function costOf(model: string, usage: ModelUsage): number | null {
  const rates = priceOf(model);
  if (rates === null) return null;
  return (
    (usage.inputTokens * rates.input +
      usage.outputTokens * rates.output +
      usage.cacheReadTokens * rates.cacheRead +
      usage.cacheCreationTokens * rates.cacheWrite) /
    1_000_000
  );
}
