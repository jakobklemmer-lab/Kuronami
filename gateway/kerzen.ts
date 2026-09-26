/**
 * Die eine Stelle, an der Kerzen herkommen — Speicher zuerst, Anbieter nur für das, was fehlt.
 *
 * Darunter liegen zwei Anbieter mit klar getrennten Aufgaben:
 *
 *   * **Yahoo** für alles, was an einer Börse notiert (Aktien, Indizes, Devisen, Futures) — aber
 *     nur bis zur Tageskerze brauchbar. Gemessen am 2026-09-21: 1m reicht acht Tage zurück,
 *     5m/15m/30m sechzig Tage, 1h zwei Jahre.
 *   * **Binance** für Krypto, adressiert als `binance:BTCUSDT` — Minutenkerzen ab 2017, mit
 *     echtem Volumen.
 *
 * **Das Präfix ist Absicht.** `BTC-USD` bei Yahoo und `BTCUSDT` bei Binance sind nicht
 * dasselbe: anderer Handelsplatz, anderes Volumen, andere Kerzen. Zwei Reihen unter einem Namen
 * zu mischen wäre die Sorte Fehler, die man erst bemerkt, wenn eine Strategie im Betrieb
 * anders läuft als im Backtest.
 */

import {
  type BinanceQuelle,
  SEKUNDEN_JE_KERZE,
  createBinanceQuelle,
  istBinanceSymbol,
} from "./integrations/binance.js";
import {
  type ChartInterval,
  type MarketCandle,
  MarketDataError,
  type MarketsClient,
  createYahooMarkets,
} from "./integrations/markets.js";
import {
  type Bestand,
  type Luecke,
  type Quelle,
  type SpeicherOrt,
  bestand,
  lade,
  luecken,
  sichere,
} from "./kerzenspeicher.js";

export interface KerzenAnfrage {
  /** `BTCUSDT` über Binance als `binance:BTCUSDT`, alles andere geht an Yahoo. */
  symbol: string;
  intervall: ChartInterval;
  /** Unix-Sekunden, einschließlich. */
  vonUnix: number;
  /** Unix-Sekunden, ausschließlich. */
  bisUnix: number;
  /** Nichts nachladen — nur, was schon im Speicher liegt. */
  nurSpeicher?: boolean;
}

export interface KerzenAntwort {
  kerzen: MarketCandle[];
  quelle: Quelle;
  /** Der Symbolname ohne Präfix, wie ihn der Anbieter kennt. */
  symbol: string;
  intervall: ChartInterval;
  /** Wie viele Kerzen aus dem Speicher kamen und wie viele neu geholt wurden. */
  ausSpeicher: number;
  neuGeholt: number;
  /** Wie viele gespeicherte Kerzen der Anbieter inzwischen anders sieht. */
  berichtigt: number;
  luecken: Luecke[];
}

export class KerzenFehler extends Error {}

/** `binance:BTCUSDT` → `{ quelle: "binance", symbol: "BTCUSDT" }`. */
export function trenneSymbol(eingabe: string): { quelle: Quelle; symbol: string } {
  const trimmed = eingabe.trim();
  const doppelpunkt = trimmed.indexOf(":");
  if (doppelpunkt === -1) return { quelle: "yahoo", symbol: trimmed };
  const praefix = trimmed.slice(0, doppelpunkt).toLowerCase();
  const rest = trimmed.slice(doppelpunkt + 1);
  if (praefix === "binance") {
    if (!istBinanceSymbol(rest)) {
      throw new KerzenFehler(
        `"${rest}" ist kein Binance-Paar. Erwartet werden Großbuchstaben ohne Trennzeichen, z. B. BTCUSDT oder ETHEUR.`,
      );
    }
    return { quelle: "binance", symbol: rest };
  }
  if (praefix === "yahoo") return { quelle: "yahoo", symbol: rest };
  throw new KerzenFehler(`Unbekannte Quelle "${praefix}". Es gibt "binance:" und "yahoo:".`);
}

export interface KerzenquelleDeps {
  /** Wurzel für den Speicher — üblicherweise das `workspace`-Verzeichnis. Ohne sie wird nichts abgelegt. */
  workdir?: string;
  markets?: MarketsClient;
  binance?: BinanceQuelle;
}

export interface Kerzenquelle {
  hole(anfrage: KerzenAnfrage): Promise<KerzenAntwort>;
  bestandVon(symbol: string, intervall: ChartInterval): Promise<Bestand>;
}

export function createKerzenquelle(deps: KerzenquelleDeps = {}): Kerzenquelle {
  const markets = deps.markets ?? createYahooMarkets();
  const binance = deps.binance ?? createBinanceQuelle();
  const workdir = deps.workdir;

  function ort(quelle: Quelle, symbol: string, intervall: ChartInterval): SpeicherOrt | null {
    if (workdir === undefined) return null;
    return { wurzel: workdir, quelle, symbol, intervall };
  }

  async function vomAnbieter(
    quelle: Quelle,
    symbol: string,
    intervall: ChartInterval,
    vonUnix: number,
    bisUnix: number,
  ): Promise<MarketCandle[]> {
    if (bisUnix <= vonUnix) return [];
    if (quelle === "binance") {
      return binance.klines({ symbol, intervall, vonUnix, bisUnix });
    }
    const chart = await markets.zeitraum(symbol, vonUnix, bisUnix, intervall);
    return chart.candles;
  }

  return {
    async bestandVon(symbol, intervall) {
      const { quelle, symbol: rein } = trenneSymbol(symbol);
      const speicher = ort(quelle, rein, intervall);
      if (speicher === null) return { monate: [], kerzen: 0 };
      return bestand(speicher);
    },

    async hole(anfrage) {
      const { quelle, symbol } = trenneSymbol(anfrage.symbol);
      const { intervall, vonUnix, bisUnix } = anfrage;
      if (bisUnix <= vonUnix) {
        throw new KerzenFehler("Der Zeitraum ergibt keinen Sinn: das Ende liegt vor dem Anfang.");
      }
      const speicher = ort(quelle, symbol, intervall);

      // Ohne Speicher bleibt nur der direkte Weg — so verhält sich das Labor im Test.
      if (speicher === null) {
        const kerzen = await vomAnbieter(quelle, symbol, intervall, vonUnix, bisUnix);
        return {
          kerzen,
          quelle,
          symbol,
          intervall,
          ausSpeicher: 0,
          neuGeholt: kerzen.length,
          berichtigt: 0,
          luecken: luecken(kerzen, intervall),
        };
      }

      const vorhanden = await lade(speicher, vonUnix, bisUnix);
      let neuGeholt = 0;
      let berichtigt = 0;

      if (!anfrage.nurSpeicher) {
        // **Nur die Ränder werden nachgeladen, nicht die Löcher in der Mitte.** Eine Lücke
        // mitten in der Reihe ist meistens keine fehlende Kerze, sondern eine geschlossene
        // Börse — ein Wochenende, ein Feiertag, eine Wartung. Sie bei jedem Lauf erneut
        // abzufragen hieße, bei jedem Lauf dieselbe leere Antwort zu bezahlen. Fehlende Stücke
        // in der Mitte holt man mit einem eigenen Aufruf über genau diesen Zeitraum.
        const raender: [number, number][] = [];
        if (vorhanden.length === 0) {
          raender.push([vonUnix, bisUnix]);
        } else {
          // **Nur nachfragen, wenn überhaupt eine ganze Kerze hineinpasst.** Der Speicher endet
          // auf der Eröffnung der letzten Kerze, das Fenster ein paar Sekunden später — ohne
          // diese Prüfung ginge bei jedem einzelnen Lauf ein Abruf über den Rest der laufenden
          // Kerze hinaus, der nie etwas Neues bringt und trotzdem Zeit und Gewicht kostet.
          const schritt = SEKUNDEN_JE_KERZE[intervall];
          const erste = vorhanden[0].time;
          const letzte = vorhanden[vorhanden.length - 1].time;
          if (erste - schritt >= vonUnix) raender.push([vonUnix, erste]);
          if (letzte + schritt < bisUnix) raender.push([letzte + schritt, bisUnix]);
        }
        for (const [von, bis] of raender) {
          let frisch: MarketCandle[];
          try {
            frisch = await vomAnbieter(quelle, symbol, intervall, von, bis);
          } catch (fehler) {
            // Ein Anbieter, der für einen Randbereich nichts hergibt (Yahoo weist zu alte
            // Intraday-Fenster mit HTTP 422 ab), darf den Lauf nicht scheitern lassen —
            // gearbeitet wird dann mit dem, was im Speicher liegt, und die Lücke steht im
            // Ergebnis.
            if (fehler instanceof MarketDataError) continue;
            throw fehler;
          }
          if (frisch.length === 0) continue;
          const ergebnis = await sichere(speicher, frisch);
          neuGeholt += ergebnis.neu;
          berichtigt += ergebnis.berichtigt;
        }
      }

      const kerzen = await lade(speicher, vonUnix, bisUnix);
      return {
        kerzen,
        quelle,
        symbol,
        intervall,
        ausSpeicher: kerzen.length - neuGeholt,
        neuGeholt,
        berichtigt,
        luecken: luecken(kerzen, intervall),
      };
    },
  };
}

/** Der Bericht über einen Abruf — gehört an jeden Backtest, der darauf steht. */
export function formatiereHerkunft(a: KerzenAntwort): string {
  const zeilen = [
    `Kerzen: ${a.kerzen.length} à ${a.intervall} von ${a.quelle}:${a.symbol}` +
      ` (${a.ausSpeicher} aus dem Speicher, ${a.neuGeholt} neu geholt)`,
  ];
  if (a.berichtigt > 0) {
    zeilen.push(
      `  ⚠ ${a.berichtigt} gespeicherte Kerzen sieht der Anbieter inzwischen anders. Sie wurden ersetzt.`,
    );
  }
  if (a.luecken.length > 0) {
    const fehlend = a.luecken.reduce((summe, l) => summe + l.fehlendeKerzen, 0);
    const groesste = a.luecken.reduce((a, b) => (a.fehlendeKerzen > b.fehlendeKerzen ? a : b));
    const vonText = new Date(groesste.von * 1000).toISOString().slice(0, 16);
    const bisText = new Date(groesste.bis * 1000).toISOString().slice(0, 16);
    zeilen.push(
      `  ${a.luecken.length} Lücken, zusammen ${fehlend} fehlende Kerzen; die größte vom ${vonText} bis ${bisText}. Handelspausen sehen genauso aus — aber eine unbemerkte Lücke sieht auch so aus.`,
    );
  }
  return zeilen.join("\n");
}
