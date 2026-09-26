/**
 * Kerzen von Binance — die Quelle für alles, was feiner ist als eine Tageskerze.
 *
 * **Warum überhaupt eine zweite Quelle.** Yahoo trägt den Handelstisch bis zur Tageskerze und
 * keinen Schritt weiter. Nachgemessen am 2026-09-21 (`/v8/finance/chart` mit `period1`/`period2`):
 *
 *   | Intervall | wie weit zurück              | gemessen                          |
 *   |-----------|------------------------------|-----------------------------------|
 *   | 1m        | ~8 Kalendertage              | 1.951 Kerzen, ab 9 Tagen HTTP 422 |
 *   | 5m/15m/30m| 60 Tage                       | 5m/59 Tage = 3.121 Kerzen         |
 *   | 1h        | 730 Tage                      | 3.484 Kerzen                      |
 *   | 1d        | Jahrzehnte                    | 2006 geprüft                      |
 *
 * Ein Scalp auf 5 Minuten bekäme damit 60 Tage — ein einziges Marktregime, und die Teilung in
 * „geschraubt"/„ungesehen" wären 30 gegen 30 Tage. `MINDEST_HANDEL = 30` ließe sich formal
 * erfüllen und würde trotzdem nichts belegen. Deshalb hier eine Quelle, die Jahre echter
 * Minutenkerzen hergibt: BTCUSDT beginnt am 2017-08-17, kostenlos, ohne Schlüssel.
 *
 * **Und mit echtem Volumen** — das ist der eigentliche Grund für Binance und gegen die
 * naheliegenden Gratis-Alternativen für Aktien: ein VWAP aus einem Feed, der nur einen
 * Bruchteil des Handels sieht, ist eine hübsche Linie an der falschen Stelle.
 *
 * Preis der Wahl, offen benannt: Krypto handelt rund um die Uhr. Es gibt keine Börsensitzung,
 * an der ein VWAP von selbst ankert, und ein Zeitfenster ist hier eine Setzung statt einer
 * Öffnungszeit. `vwap()` in `indikatoren.ts` bekommt die Zone deshalb als Parameter und
 * verlässt sich auf nichts.
 */

import {
  type ChartInterval,
  type FetchLike,
  type MarketCandle,
  MarketDataError,
} from "./markets.js";

const BINANCE_BASE = "https://api.binance.com/api/v3";

/** Binance-Symbole sind Großbuchstaben und Ziffern, ohne Trennzeichen: BTCUSDT, ETHEUR. */
const SYMBOL_PATTERN = /^[A-Z0-9]{2,20}$/;

export function istBinanceSymbol(wert: string): boolean {
  return SYMBOL_PATTERN.test(wert);
}

/**
 * Unsere Intervalle auf Binance-Schreibweise. `1wk`/`1mo` heißen dort `1w`/`1M` — die
 * Groß-/Kleinschreibung ist bei `1M` (Monat) gegen `1m` (Minute) kein Schönheitsfehler,
 * sondern der Unterschied zwischen einem Monat und einer Minute.
 */
const INTERVALLE: Record<ChartInterval, string> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "1h",
  "1d": "1d",
  "1wk": "1w",
  "1mo": "1M",
};

/** Sekunden je Kerze — für die Seitenrechnung und die Lückenprüfung. */
export const SEKUNDEN_JE_KERZE: Record<ChartInterval, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "1d": 86_400,
  "1wk": 604_800,
  // Ein Monat ist keine feste Länge; 30 Tage ist hier nur eine Schrittweite für das Blättern,
  // keine Behauptung über den Kalender.
  "1mo": 2_592_000,
};

/**
 * Wie viele Kerzen ein Abruf höchstens liefert.
 *
 * **Gemessen, nicht der Doku entnommen:** `limit=1500` kam mit 1.000 Kerzen zurück, `limit=1501`
 * ebenso — ohne Fehler. Wer hier 1.500 annimmt und die Seite danach um 1.500 Kerzen weiterrückt,
 * überspringt bei jedem Abruf ein Drittel der Historie und merkt es nie: die Reihe sieht
 * lückenlos aus, weil jede Seite für sich lückenlos ist.
 */
export const SEITE_MAX = 1000;

export interface BinanceOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Wird zwischen den Seiten aufgerufen; im Test eingesetzt, damit nichts wirklich wartet. */
  warte?: (ms: number) => Promise<void>;
  /** Höchstzahl der Seiten je Aufruf — eine Bremse gegen eine Endlosschleife bei Fremdverhalten. */
  maxSeiten?: number;
}

export interface KlineAbruf {
  symbol: string;
  intervall: ChartInterval;
  /** Unix-Sekunden, einschließlich. */
  vonUnix: number;
  /** Unix-Sekunden, **ausschließlich**. */
  bisUnix: number;
}

export interface BinanceQuelle {
  klines(abruf: KlineAbruf): Promise<MarketCandle[]>;
}

function schlafe(ms: number): Promise<void> {
  return new Promise((fertig) => setTimeout(fertig, ms));
}

/**
 * Eine Kerze aus Binances Zahlenreihe.
 *
 * Die Felder kommen als **Zeichenketten** („68245.71000000"), weil Binance sich nicht auf die
 * Rundung fremder Gleitkommazahlen verlassen will. `Number()` ist hier richtig und die Prüfung
 * auf `Number.isFinite` Pflicht: eine stillschweigend zu `NaN` gewordene Kerze vergiftet jeden
 * Indikator, der über sie läuft, und `NaN` vergleicht sich gegen alles als `false` — die Regel
 * würde einfach nie auslösen.
 */
function kerzeAus(reihe: unknown): { kerze: MarketCandle; schlussMs: number } | null {
  if (!Array.isArray(reihe) || reihe.length < 7) return null;
  const oeffnungMs = Number(reihe[0]);
  const schlussMs = Number(reihe[6]);
  const open = Number(reihe[1]);
  const high = Number(reihe[2]);
  const low = Number(reihe[3]);
  const close = Number(reihe[4]);
  const volume = Number(reihe[5]);
  for (const wert of [oeffnungMs, schlussMs, open, high, low, close, volume]) {
    if (!Number.isFinite(wert)) return null;
  }
  return {
    kerze: { time: Math.floor(oeffnungMs / 1000), open, high, low, close, volume },
    schlussMs,
  };
}

export function createBinanceQuelle(options: BinanceOptions = {}): BinanceQuelle {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 20_000;
  const warte = options.warte ?? schlafe;
  const maxSeiten = options.maxSeiten ?? 20_000;

  async function hole(pfad: string): Promise<{ json: unknown; kopf: Headers }> {
    // Binance beantwortet zu viele Anfragen mit 429 und sperrt bei Sturheit mit 418. Beides
    // trägt `Retry-After` in Sekunden; die Zahl wird befolgt, nicht geraten. Wer hier blind
    // weiterfragt, holt sich eine IP-Sperre von Minuten bis Stunden — mitten im Herunterladen
    // einer mehrjährigen Reihe.
    for (let versuch = 0; ; versuch += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let antwort: Response;
      try {
        antwort = await fetchImpl(`${BINANCE_BASE}${pfad}`, {
          signal: controller.signal,
          headers: { "user-agent": "Kuronami/1.0", accept: "application/json" },
        });
      } catch (fehler) {
        throw new MarketDataError(
          `Binance nicht erreichbar: ${fehler instanceof Error ? fehler.message : String(fehler)}`,
        );
      } finally {
        clearTimeout(timer);
      }

      if (antwort.status === 429 || antwort.status === 418) {
        if (versuch >= 4) {
          throw new MarketDataError(
            `Binance drosselt (HTTP ${antwort.status}) und gibt nach ${versuch + 1} Versuchen nicht nach.`,
          );
        }
        const kopfwert = Number(antwort.headers.get("retry-after"));
        const sekunden = Number.isFinite(kopfwert) && kopfwert > 0 ? kopfwert : 2 ** versuch;
        await warte(Math.min(sekunden, 60) * 1000);
        continue;
      }
      if (!antwort.ok) {
        const text = await antwort.text().catch(() => "");
        throw new MarketDataError(
          `Binance antwortet mit HTTP ${antwort.status}${text ? `: ${text.slice(0, 200)}` : ""}.`,
        );
      }
      return { json: await antwort.json(), kopf: antwort.headers };
    }
  }

  return {
    async klines({ symbol, intervall, vonUnix, bisUnix }) {
      if (!istBinanceSymbol(symbol)) {
        throw new MarketDataError(
          `"${symbol}" ist kein Binance-Symbol. Erwartet werden Großbuchstaben ohne Trennzeichen, z. B. BTCUSDT.`,
        );
      }
      if (!Number.isFinite(vonUnix) || !Number.isFinite(bisUnix) || bisUnix <= vonUnix) {
        throw new MarketDataError(
          "Der Zeitraum ergibt keinen Sinn: das Ende liegt vor dem Anfang.",
        );
      }
      const schritt = SEKUNDEN_JE_KERZE[intervall];
      const jetztMs = Date.now();
      const bisMs = Math.min(bisUnix * 1000, jetztMs);

      const kerzen: MarketCandle[] = [];
      let startMs = Math.floor(vonUnix) * 1000;
      let gewicht = "";

      for (let seite = 0; seite < maxSeiten; seite += 1) {
        if (startMs >= bisMs) break;
        const { json, kopf } = await hole(
          `/klines?symbol=${symbol}&interval=${INTERVALLE[intervall]}` +
            `&startTime=${startMs}&endTime=${bisMs - 1}&limit=${SEITE_MAX}`,
        );
        gewicht = kopf.get("x-mbx-used-weight-1m") ?? gewicht;
        if (!Array.isArray(json)) {
          throw new MarketDataError("Binance liefert keine Kerzenliste.");
        }
        if (json.length === 0) break;

        let letzteOeffnungMs = startMs;
        for (const reihe of json) {
          const gelesen = kerzeAus(reihe);
          if (gelesen === null) continue;
          letzteOeffnungMs = Math.max(letzteOeffnungMs, gelesen.kerze.time * 1000);
          // **Nur abgeschlossene Kerzen.** Die letzte Kerze eines Abrufs, der bis jetzt reicht,
          // läuft noch — ihr Hoch, Tief und Schluss ändern sich bis zum Ablauf des Intervalls.
          // Eine laufende Kerze in einem Backtest ist dieselbe Selbsttäuschung wie Yahoos
          // angehängte Scheinkerze (siehe `beschneide` in markets.ts), nur von vorn: die Regel
          // sähe einen Schlusskurs, den es an der Börse noch nicht gab.
          if (gelesen.schlussMs >= jetztMs) continue;
          if (gelesen.kerze.time * 1000 >= bisMs) continue;
          kerzen.push(gelesen.kerze);
        }

        // Die nächste Seite beginnt **hinter** der letzten gelesenen Kerze. Nicht um
        // `SEITE_MAX * schritt` weiterrücken: Binance liefert bei Ausfällen weniger Kerzen als
        // angefragt, und eine feste Schrittweite risse dann eine Lücke, die keiner sieht.
        const naechsterStart = letzteOeffnungMs + schritt * 1000;
        if (naechsterStart <= startMs) break;
        startMs = naechsterStart;
        if (json.length < SEITE_MAX) break;
        // Das Gewichtsbudget sind 1.200 je Minute, ein Abruf mit `limit=1000` kostet 10. Eine
        // Fünftelsekunde Pause hält uns bei rund 3.000 je Minute — deshalb ist die Pause an
        // das gemeldete Gewicht gekoppelt statt an ein Bauchgefühl.
        const verbraucht = Number(gewicht);
        await warte(Number.isFinite(verbraucht) && verbraucht > 900 ? 5_000 : 200);
      }

      kerzen.sort((a, b) => a.time - b.time);
      // Doppelte kommen vor, wenn eine Seite an der Grenze überlappt. Die spätere Fassung
      // derselben Kerze ist die vollständigere, deshalb gewinnt sie.
      const entdoppelt: MarketCandle[] = [];
      for (const kerze of kerzen) {
        const vorherige = entdoppelt[entdoppelt.length - 1];
        if (vorherige !== undefined && vorherige.time === kerze.time) {
          entdoppelt[entdoppelt.length - 1] = kerze;
          continue;
        }
        entdoppelt.push(kerze);
      }
      return entdoppelt;
    },
  };
}
