import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  CHART_INTERVALS,
  CHART_RANGES,
  type ChartInterval,
  type ChartRange,
  type MarketChart,
  type MarketSearchHit,
  type MarketsClient,
  createYahooMarkets,
  defaultIntervalFor,
} from "./integrations/markets.js";

/**
 * Kursdaten für den Handelstisch — dieselbe Quelle wie die Oberfläche, ohne Umweg über ein
 * Modell.
 *
 * Vorher holten die Analysten ihre Zahlen mit `WebFetch` von Yahoo. Das sieht aus wie ein
 * Abruf, ist aber keiner: `WebFetch` schickt die Antwort durch ein Zusammenfassungsmodell,
 * und das bekam am 2026-09-20 reihenweise Daten falsch — „182 Tage ab 21. November 2024" für
 * einen Sechs-Monats-Abruf, und vier Abfragen mit vier verschiedenen, allesamt falschen
 * Zeiträumen. Der Chefanalyst hat es beide Male selbst gemerkt („das ist kein Marktbefund,
 * das ist ein kaputter Abruf") und die Rohdaten nachgeholt — dabei gingen an dem Tag über
 * vier Minuten allein für dreizehn einzelne `date`-Aufrufe drauf, nur um Unix-Zeitstempel in
 * Datumsangaben umzurechnen.
 *
 * Bei Handelsideen mit echtem Geld ist eine halluzinierte Zahl kein Schönheitsfehler. Deshalb
 * geht der Abruf hier durch `integrations/markets.ts` — denselben geprüften Weg, den die
 * Kurstafel benutzt — und kommt als fertige Tabelle mit echten Datumsangaben zurück. Kein
 * Modell dazwischen, keine Umrechnung, nichts zu glauben.
 */

/** So viele Kerzen gehen höchstens in eine Antwort; die jüngsten zuerst abgeschnitten. */
const MAX_KERZEN = 200;

export interface KurseDeps {
  /** Der Marktdaten-Client. Vorgabe: Yahoo. In Tests wird hier eine Attrappe gereicht. */
  markets?: MarketsClient;
}

function iso(unixSekunden: number, mitUhrzeit: boolean): string {
  const d = new Date(unixSekunden * 1000);
  const tag = d.toISOString().slice(0, 10);
  if (!mitUhrzeit) return tag;
  return `${tag} ${d.toISOString().slice(11, 16)}`;
}

/** Feiner als ein Tag? Dann braucht die Zeile eine Uhrzeit, sonst stehen fünf gleiche Daten da. */
function istIntraday(interval: string): boolean {
  return interval.endsWith("m") || interval.endsWith("h");
}

function zahl(wert: number): string {
  const betrag = Math.abs(wert);
  const stellen = betrag >= 1000 ? 2 : betrag >= 1 ? 3 : 6;
  return wert.toFixed(stellen);
}

/**
 * Der Kursverlauf als Text, den ein Analyst ohne Umrechnung lesen kann.
 *
 * Steht hier als eigene Funktion und nicht im Werkzeugrumpf, weil genau **das** die Stelle
 * ist, die geprüft gehört: ein Datum, das nicht zum Zeitstempel passt, ist der Fehler, gegen
 * den dieses Modul überhaupt gebaut wurde.
 */
export function formatiereVerlauf(chart: MarketChart): string {
  const alle = chart.candles;
  const kerzen = alle.slice(-MAX_KERZEN);
  const mitUhrzeit = istIntraday(chart.interval);

  // **Zwei Bewegungen, nicht eine.** Yahoo liefert in `regularMarketChangePercent` die
  // Tagesveränderung, im `chartPreviousClose` aber den Schluss **vor dem Zeitraum** — bei
  // range=1y also den Kurs von vor einem Jahr. Beides in eine Zeile zu setzen ergibt Unsinn:
  // „-0,28 % (4482,27 zuvor)" bei einem Kurs von 2637 stand hier zuerst und ist in sich
  // widersprüchlich. Ein Analyst, der so etwas liest, rechnet entweder falsch weiter oder
  // verliert das Vertrauen in die Quelle. Also getrennt, und die Zeitraum-Bewegung aus den
  // Kerzen, die darunter stehen — nachrechenbar.
  const kopf = [
    `${chart.symbol} — ${chart.name}${chart.currency ? ` (${chart.currency})` : ""}`,
    `Kurs ${zahl(chart.price)}, ${chart.changePct >= 0 ? "+" : ""}${chart.changePct.toFixed(2)} % zum Vortagesschluss`,
  ];
  if (chart.weekHigh52 !== undefined && chart.weekLow52 !== undefined) {
    kopf.push(`52 Wochen: Hoch ${zahl(chart.weekHigh52)}, Tief ${zahl(chart.weekLow52)}`);
  }
  if (kerzen.length === 0) {
    kopf.push(`Zeitraum ${chart.range}/${chart.interval}: keine Kerzen geliefert.`);
    return kopf.join("\n");
  }
  const erste = kerzen[0];
  const letzte = kerzen[kerzen.length - 1];
  kopf.push(
    `Zeitraum ${chart.range}, Intervall ${chart.interval}, ${kerzen.length} Kerzen (${iso(erste.time, mitUhrzeit)} bis ${iso(letzte.time, mitUhrzeit)}, UTC)${alle.length > kerzen.length ? `, ältere ${alle.length - kerzen.length} gekürzt` : ""}`,
  );
  if (erste.close !== 0) {
    const ueberZeitraum = ((letzte.close - erste.close) / erste.close) * 100;
    kopf.push(
      `Über den Zeitraum: ${zahl(erste.close)} → ${zahl(letzte.close)} ` +
        `(${ueberZeitraum >= 0 ? "+" : ""}${ueberZeitraum.toFixed(2)} %)`,
    );
  }

  const zeilen = kerzen.map((k) =>
    [iso(k.time, mitUhrzeit), zahl(k.open), zahl(k.high), zahl(k.low), zahl(k.close)].join("  "),
  );
  return `${kopf.join("\n")}\n\nDatum  Open  High  Low  Close\n${zeilen.join("\n")}`;
}

/** Suchtreffer als Liste. Ein geratenes Symbol liefert stillschweigend den falschen Wert. */
export function formatiereTreffer(treffer: readonly MarketSearchHit[], begriff: string): string {
  if (treffer.length === 0) return `Nichts gefunden zu "${begriff}".`;
  return treffer
    .map((t) => `${t.symbol} — ${t.name} (${t.type}${t.exchange ? `, ${t.exchange}` : ""})`)
    .join("\n");
}

export function createKurse(deps: KurseDeps = {}) {
  const markets = deps.markets ?? createYahooMarkets();

  const verlauf = tool(
    "verlauf",
    [
      "Kursverlauf eines Wertes abrufen — Tabelle mit Datum, Eröffnung, Hoch, Tief, Schluss.",
      "",
      "Nimm dieses Werkzeug für **jede** Kurszahl. Nicht WebFetch auf Yahoo: dort läuft die",
      "Antwort durch ein Zusammenfassungsmodell und die Datumsangaben stimmen dann nicht.",
      "",
      "Symbole wie bei Yahoo: ^GDAXI (DAX), ^GSPC (S&P 500), BTC-USD, ETH-USD, SOL-USD,",
      "EURUSD=X, GC=F (Gold), AAPL. Wenn du ein Symbol nicht kennst, nimm zuerst `suche`.",
      "",
      "Zeiträume: 1d, 5d, 1mo, 3mo, 6mo, 1y, 5y, max. Das Intervall wählt sich passend zum",
      "Zeitraum, wenn du keins nennst — für Daytrading 5d mit 15m.",
      "",
      "Alle Zeitangaben sind UTC. Die Antwort nennt außerdem den aktuellen Kurs, die",
      "Veränderung zum Vortagesschluss und das 52-Wochen-Hoch und -Tief.",
    ].join("\n"),
    {
      symbol: z.string().min(1).max(20).describe("Yahoo-Symbol, z. B. ^GDAXI, BTC-USD, AAPL."),
      zeitraum: z.enum(CHART_RANGES).default("3mo").describe("Zeitraum des Verlaufs."),
      intervall: z
        .enum(CHART_INTERVALS)
        .optional()
        .describe("Kerzengröße. Weglassen wählt die zum Zeitraum passende."),
    },
    async ({ symbol, zeitraum, intervall }) => {
      const range = zeitraum as ChartRange;
      const interval = (intervall as ChartInterval | undefined) ?? defaultIntervalFor(range);
      try {
        const chart = await markets.chart(symbol, range, interval);
        return { content: [{ type: "text" as const, text: formatiereVerlauf(chart) }] };
      } catch (error) {
        const grund = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text" as const, text: `Kursabruf fehlgeschlagen: ${grund}` }] };
      }
    },
    { annotations: { title: "Kursverlauf abrufen", readOnlyHint: true } },
  );

  const suche = tool(
    "suche",
    "Das Yahoo-Symbol zu einem Namen finden, wenn du es nicht sicher weißt. Rate kein Symbol — " +
      "ein falsches liefert stillschweigend die Kurse eines anderen Wertes.",
    {
      begriff: z
        .string()
        .min(1)
        .max(60)
        .describe("Name oder Teil davon, z. B. Solana oder Rheinmetall."),
    },
    async ({ begriff }) => {
      try {
        return {
          content: [
            {
              type: "text" as const,
              text: formatiereTreffer(await markets.search(begriff, 8), begriff),
            },
          ],
        };
      } catch (error) {
        const grund = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text" as const, text: `Suche fehlgeschlagen: ${grund}` }] };
      }
    },
    { annotations: { title: "Symbol suchen", readOnlyHint: true } },
  );

  return createSdkMcpServer({
    name: "kurse",
    version: "1",
    instructions:
      "Kursdaten aus erster Hand. `verlauf` gibt dir den Kursverlauf als Tabelle mit echten " +
      "Datumsangaben, `suche` findet ein Symbol. Hol jede Zahl hier — nicht über WebFetch.",
    tools: [verlauf, suche],
  });
}

/** Die Werkzeugnamen, wie sie in `allowedTools` stehen müssen. */
export const KURSE_TOOLS = ["mcp__kurse__verlauf", "mcp__kurse__suche"];
