/**
 * Marktdaten über Yahoo Finance (Nachtrag 2026-09-16, Ablösung der Binance-Direktabfrage der
 * Trading-Ansicht). Ein Anbieter für alles, was der Nutzer suchen will — Aktien, Indizes, ETFs,
 * Devisen, Krypto —, ohne Schlüssel. Zwei öffentliche Endpunkte reichen:
 *
 *   * `/v1/finance/search?q=` — Symbolsuche nach Name oder Kürzel.
 *   * `/v8/finance/chart/<symbol>` — Kerzen **und** in `meta` der aktuelle Kurs samt Veränderung.
 *     Der eigene Kurs-Endpunkt (`/v7/finance/quote`) verlangt inzwischen einen Sitzungsausweis;
 *     der Chart-Endpunkt trägt dieselben Zahlen frei Haus, also gibt es hier nur einen Weg.
 *
 * Das ist eine **inoffizielle** Schnittstelle: kein Vertrag, keine Zusage. Die Abbildung in
 * eigene Formen (unten) ist deshalb tolerant gegenüber fehlenden Feldern, und die Oberfläche
 * zeigt einen benannten Fehler statt eines leeren Bildes, wenn Yahoo einmal nicht antwortet.
 * Läuft im Gateway, nicht im Browser: Yahoo setzt keine CORS-Kopfzeilen, und so bleibt ein
 * späterer Anbieterwechsel eine Änderung an dieser einen Datei.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface MarketSearchHit {
  symbol: string;
  name: string;
  exchange: string;
  /** Yahoos `quoteType`, z. B. EQUITY, ETF, INDEX, CRYPTOCURRENCY, CURRENCY. */
  type: string;
}

export interface MarketCandle {
  /** Unix-Sekunden. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /**
   * Gehandeltes Volumen, wenn die Quelle es liefert. Bei Indizes und Devisen fehlt es
   * regelmäßig — ein Volumenindikator (OBV) sagt dort nichts und meldet das auch.
   */
  volume?: number;
}

export interface MarketQuote {
  symbol: string;
  name: string;
  currency: string;
  exchange: string;
  price: number;
  change: number;
  changePct: number;
  /** Schlusskurse des Tages für die Mini-Linie; leer, wenn der Markt heute nicht handelte. */
  spark: number[];
  /**
   * 52-Wochen-Spanne, wenn Yahoo sie mitliefert.
   *
   * Optional, weil die Kurstafel sie nicht braucht — der Handelstisch schon: „+10 % auf ein
   * Mehrmonatshoch" und „immer noch 55 % unter dem Jahreshoch" sind dieselbe Bewegung, und
   * nur die zweite Zahl verrät, ob es eine Erholung im Abwärtstrend ist.
   */
  weekHigh52?: number;
  weekLow52?: number;
  /** Yahoos `instrumentType`: INDEX, EQUITY, ETF, CRYPTOCURRENCY, CURRENCY, FUTURE, … */
  typ?: string;
  /** Die Zeitzone des Handelsplatzes, z. B. `Europe/Berlin`. */
  zeitzone?: string;
  /** Die reguläre Sitzung des laufenden oder letzten Handelstags, Unix-Sekunden. */
  sitzung?: { start: number; ende: number };
  /** Zeitpunkt des letzten Kurses, Unix-Sekunden. */
  kursZeit?: number;
  /** Tageshoch, -tief und -volumen der laufenden oder letzten Sitzung. */
  tagHoch?: number;
  tagTief?: number;
  tagVolumen?: number;
  /** Der Vortagesschluss — nicht der Schluss vor dem Zeitraum, siehe `mapChartResponse`. */
  vortag?: number;
  /** Nachkommastellen, mit denen der Handelsplatz notiert (Devisen 4–5, Aktien 2). */
  stellen?: number;
}

export interface MarketChart extends MarketQuote {
  range: string;
  interval: string;
  candles: MarketCandle[];
}

export class MarketDataError extends Error {}

export const CHART_RANGES = ["1d", "5d", "1mo", "3mo", "6mo", "1y", "5y", "max"] as const;
export const CHART_INTERVALS = ["1m", "5m", "15m", "30m", "1h", "1d", "1wk", "1mo"] as const;
export type ChartRange = (typeof CHART_RANGES)[number];
export type ChartInterval = (typeof CHART_INTERVALS)[number];

/** Yahoo-Symbole: Buchstaben, Ziffern, `.` (Börsenzusatz), `-` (Krypto-Paare), `^` (Indizes),
 * `=` (Devisen/Futures). Alles andere wird abgewiesen, bevor es in eine URL gerät. */
const SYMBOL_PATTERN = /^[A-Za-z0-9.^=\-]{1,20}$/;

export function isValidSymbol(value: string): boolean {
  return SYMBOL_PATTERN.test(value);
}

export function isChartRange(value: string): value is ChartRange {
  return (CHART_RANGES as readonly string[]).includes(value);
}

export function isChartInterval(value: string): value is ChartInterval {
  return (CHART_INTERVALS as readonly string[]).includes(value);
}

/** Welches Intervall zu einem Zeitraum passt, wenn der Aufrufer keins nennt. Yahoo lehnt zu
 * feine Intervalle für lange Zeiträume ab (Minuten gibt es nur für wenige Tage). */
export function defaultIntervalFor(range: ChartRange): ChartInterval {
  switch (range) {
    case "1d":
      return "5m";
    case "5d":
      return "30m";
    case "1mo":
    case "3mo":
      return "1d";
    case "6mo":
    case "1y":
      return "1d";
    case "5y":
    case "max":
      return "1wk";
  }
}

// ---------------------------------------------------------------------------
// Abbildung der Yahoo-Antworten — reine Funktionen, ohne Netz prüfbar.
// ---------------------------------------------------------------------------

interface YahooSearchResponse {
  quotes?: Array<{
    symbol?: unknown;
    shortname?: unknown;
    longname?: unknown;
    exchDisp?: unknown;
    exchange?: unknown;
    quoteType?: unknown;
  }>;
}

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      meta?: {
        symbol?: unknown;
        currency?: unknown;
        shortName?: unknown;
        longName?: unknown;
        fullExchangeName?: unknown;
        exchangeName?: unknown;
        regularMarketPrice?: unknown;
        regularMarketChangePercent?: unknown;
        chartPreviousClose?: unknown;
        previousClose?: unknown;
        fiftyTwoWeekHigh?: unknown;
        fiftyTwoWeekLow?: unknown;
        instrumentType?: unknown;
        exchangeTimezoneName?: unknown;
        regularMarketTime?: unknown;
        regularMarketDayHigh?: unknown;
        regularMarketDayLow?: unknown;
        regularMarketVolume?: unknown;
        priceHint?: unknown;
        dataGranularity?: unknown;
        currentTradingPeriod?: { regular?: { start?: unknown; end?: unknown } };
      };
      timestamp?: unknown;
      indicators?: {
        quote?: Array<{
          open?: unknown;
          high?: unknown;
          low?: unknown;
          close?: unknown;
          volume?: unknown;
        }>;
      };
    }>;
    error?: { description?: unknown } | null;
  };
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function mapSearchResponse(json: unknown): MarketSearchHit[] {
  const quotes = (json as YahooSearchResponse).quotes;
  if (!Array.isArray(quotes)) return [];
  const hits: MarketSearchHit[] = [];
  for (const entry of quotes) {
    const symbol = text(entry.symbol);
    if (!isValidSymbol(symbol)) continue;
    hits.push({
      symbol,
      name: text(entry.longname) || text(entry.shortname) || symbol,
      exchange: text(entry.exchDisp) || text(entry.exchange),
      type: text(entry.quoteType, "UNKNOWN"),
    });
  }
  return hits;
}

/**
 * Kurs, Veränderung und Kerzen aus einer Chart-Antwort. Lücken (Yahoo liefert `null` für
 * Handelspausen) fallen weg statt als Nullkerze zu erscheinen. Die Veränderung kommt aus
 * `regularMarketChangePercent`, sonst aus dem Vortagesschluss — Krypto-Antworten führen
 * manchmal nur den zweiten Wert.
 */
export function mapChartResponse(json: unknown, range: string, interval: string): MarketChart {
  const chart = (json as YahooChartResponse).chart;
  const result = chart?.result?.[0];
  if (!result || !result.meta) {
    const description = text(chart?.error?.description);
    throw new MarketDataError(
      description ? `Yahoo Finance: ${description}` : "Yahoo Finance: leere Antwort.",
    );
  }
  const meta = result.meta;
  const price = num(meta.regularMarketPrice);
  if (price === null) {
    throw new MarketDataError("Yahoo Finance: kein Kurs in der Antwort.");
  }
  // **Der Vortag ist nicht `chartPreviousClose`.** Das ist der Schluss vor dem *Zeitraum* —
  // bei einem Tagesfenster derselbe Wert, bei `period1=0` der DAX von 1987 (1.005,19): die
  // Oberfläche zeigte über „Max" eine Veränderung von +24.403 Punkten neben +0,56 %.
  // Gemessen am 2026-09-27. Deshalb zuerst `previousClose`, dann der Rückschluss aus der
  // Tagesveränderung in Prozent, und `chartPreviousClose` nur, wenn es nichts anderes gibt.
  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const quote = result.indicators?.quote?.[0] ?? {};
  const opens = Array.isArray(quote.open) ? quote.open : [];
  const highs = Array.isArray(quote.high) ? quote.high : [];
  const lows = Array.isArray(quote.low) ? quote.low : [];
  const closes = Array.isArray(quote.close) ? quote.close : [];
  const volumes = Array.isArray(quote.volume) ? quote.volume : [];

  const candles: MarketCandle[] = [];
  for (let i = 0; i < timestamps.length; i += 1) {
    const time = num(timestamps[i]);
    const open = num(opens[i]);
    const high = num(highs[i]);
    const low = num(lows[i]);
    const close = num(closes[i]);
    if (time === null || open === null || high === null || low === null || close === null) {
      continue;
    }
    const volume = num(volumes[i]);
    candles.push({ time, open, high, low, close, ...(volume !== null ? { volume } : {}) });
  }

  const hoch52 = num(meta.fiftyTwoWeekHigh);
  const tief52 = num(meta.fiftyTwoWeekLow);
  const regulaer = meta.currentTradingPeriod?.regular;
  const sitzungStart = num(regulaer?.start);
  const sitzungEnde = num(regulaer?.end);

  // Bei Tageskerzen steht der Vortag in der Reihe selbst: der Schluss der letzten Kerze vor
  // der laufenden Sitzung. Genauer als der Rückschluss aus der Prozentzahl, die Yahoo auf drei
  // Stellen rundet (DAX: +142,00 statt +142,11).
  let vortagKerze: number | null = null;
  if (interval === "1d" && sitzungStart !== null) {
    for (let i = candles.length - 1; i >= 0; i -= 1) {
      if (candles[i].time < sitzungStart) {
        if (candles[i].time > sitzungStart - 7 * 86_400) vortagKerze = candles[i].close;
        break;
      }
    }
  }
  const pct = num(meta.regularMarketChangePercent);
  const vortag =
    num(meta.previousClose) ??
    vortagKerze ??
    (pct !== null && pct !== -100 ? price / (1 + pct / 100) : num(meta.chartPreviousClose));
  const changePct =
    pct ?? (vortag !== null && vortag !== 0 ? ((price - vortag) / vortag) * 100 : 0);
  const change = vortag !== null ? price - vortag : (price * changePct) / 100;
  const optional = {
    ...(text(meta.instrumentType) ? { typ: text(meta.instrumentType) } : {}),
    ...(text(meta.exchangeTimezoneName) ? { zeitzone: text(meta.exchangeTimezoneName) } : {}),
    ...(sitzungStart !== null && sitzungEnde !== null
      ? { sitzung: { start: sitzungStart, ende: sitzungEnde } }
      : {}),
    ...(num(meta.regularMarketTime) !== null
      ? { kursZeit: num(meta.regularMarketTime) as number }
      : {}),
    ...(num(meta.regularMarketDayHigh) !== null
      ? { tagHoch: num(meta.regularMarketDayHigh) as number }
      : {}),
    ...(num(meta.regularMarketDayLow) !== null
      ? { tagTief: num(meta.regularMarketDayLow) as number }
      : {}),
    ...(num(meta.regularMarketVolume)
      ? { tagVolumen: num(meta.regularMarketVolume) as number }
      : {}),
    ...(vortag !== null ? { vortag } : {}),
    ...(num(meta.priceHint) !== null ? { stellen: num(meta.priceHint) as number } : {}),
  };
  // Was Yahoo wirklich geliefert hat. Bei `range=max` sind das Quartalskerzen, egal was
  // angefragt war — und das Etikett soll sagen, was in der Tabelle steht.
  const geliefert = text(meta.dataGranularity);

  return {
    symbol: text(meta.symbol),
    name: text(meta.longName) || text(meta.shortName) || text(meta.symbol),
    currency: text(meta.currency),
    exchange: text(meta.fullExchangeName) || text(meta.exchangeName),
    price,
    change,
    changePct,
    spark: candles.map((candle) => candle.close),
    ...(hoch52 !== null ? { weekHigh52: hoch52 } : {}),
    ...(tief52 !== null ? { weekLow52: tief52 } : {}),
    ...optional,
    range,
    interval: geliefert || interval,
    candles,
  };
}

/**
 * Schneidet die Kerzen auf das angefragte Fenster zurück.
 *
 * **Das ist keine Vorsichtsmaßnahme, sondern die Antwort auf ein gemessenes Verhalten.** Yahoo
 * hängt bei feinen Intervallen an *jedes* historische Fenster eine Kerze der **letzten
 * Sitzung** an — nachgemessen am 2026-09-21: ein 1h-Fenster vom 21.–31.10.2024 kam mit 57
 * Kerzen zurück, 56 davon aus dem Fenster und die letzte vom 18.09.2026, 20:00, mit
 * `open = high = low = close = 336,13` und `volume = 0`. Es ist der aktuelle Kurs als
 * Scheinkerze. Bei `1d` passiert das nicht, deshalb ist es bisher niemandem aufgefallen:
 * alles, was dieses Haus bisher gerechnet hat, lief auf Tageskerzen.
 *
 * Für den Rückblick ist das die schlimmste denkbare Verunreinigung — `labor.ts` verspricht
 * „die Zukunft ist nicht geladen", und die letzte Kerze wäre der heutige Kurs. Ein Replay
 * zeigte dem Analysten am Ende von 2024 den Stand von heute, ein Backtest stellte den letzten
 * Handel zum heutigen Kurs glatt. Beides sähe plausibel aus.
 *
 * Das Ende ist ausschließlich: eine Kerze, die genau auf `bisUnix` beginnt, gehört schon in
 * das folgende Fenster.
 */
export function beschneide(chart: MarketChart, vonUnix: number, bisUnix: number): MarketChart {
  const candles = chart.candles.filter((k) => k.time >= vonUnix && k.time < bisUnix);
  if (candles.length === chart.candles.length) return chart;
  return { ...chart, candles, spark: candles.map((k) => k.close) };
}

// ---------------------------------------------------------------------------
// Der Client
// ---------------------------------------------------------------------------

export interface YahooMarketsOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export interface MarketsClient {
  search(query: string, limit?: number): Promise<MarketSearchHit[]>;
  chart(symbol: string, range: ChartRange, interval: ChartInterval): Promise<MarketChart>;
  /**
   * Kerzen für einen **festen Zeitraum** (Unix-Sekunden, Ende ausschließlich).
   *
   * Der Unterschied zu `chart` ist nicht Bequemlichkeit, sondern die Voraussetzung für einen
   * ehrlichen Rückblick: „Wie sah es am 1. Juni aus" lässt sich mit `range` nicht fragen, und
   * eine Antwort, die die Wochen danach enthält, verdirbt jede Auswertung einer damaligen
   * Einschätzung. Siehe `gateway/labor.ts`.
   */
  zeitraum(
    symbol: string,
    vonUnix: number,
    bisUnix: number,
    interval: ChartInterval,
  ): Promise<MarketChart>;
  /** Kurse mehrerer Symbole parallel; ein Fehler bei einem Symbol lässt die anderen stehen. */
  quotes(symbols: readonly string[]): Promise<{ quotes: MarketQuote[]; failed: string[] }>;
}

const YAHOO_BASE = "https://query1.finance.yahoo.com";

export function createYahooMarkets(options: YahooMarketsOptions = {}): MarketsClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 10_000;

  async function getJson(path: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${YAHOO_BASE}${path}`, {
        signal: controller.signal,
        // Yahoo weist Anfragen ohne Browser-artige Kennung ab; die Kennung nennt trotzdem, wer
        // hier fragt.
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; Kuronami/1.0)",
          accept: "application/json",
        },
      });
      if (!response.ok) {
        throw new MarketDataError(`Yahoo Finance antwortet mit HTTP ${response.status}.`);
      }
      return await response.json();
    } catch (error) {
      if (error instanceof MarketDataError) throw error;
      throw new MarketDataError(
        `Yahoo Finance nicht erreichbar: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function chart(symbol: string, range: ChartRange, interval: ChartInterval) {
    if (!isValidSymbol(symbol)) throw new MarketDataError(`Ungültiges Symbol "${symbol}".`);
    // `range=max` liefert bei Yahoo **Quartalskerzen**, gleich welches Intervall angefragt
    // ist (gemessen am 2026-09-27: DAX 157 Kerzen, `dataGranularity: 3mo`, auch bei 1d und
    // 1wk). Dieselbe Historie in der angefragten Größe gibt es über `period1=0`.
    const fenster =
      range === "max" ? `period1=0&period2=${Math.floor(Date.now() / 1000)}` : `range=${range}`;
    const json = await getJson(
      `/v8/finance/chart/${encodeURIComponent(symbol)}?${fenster}&interval=${interval}`,
    );
    return mapChartResponse(json, range, interval);
  }

  async function zeitraum(
    symbol: string,
    vonUnix: number,
    bisUnix: number,
    interval: ChartInterval,
  ) {
    if (!isValidSymbol(symbol)) throw new MarketDataError(`Ungültiges Symbol "${symbol}".`);
    if (!Number.isFinite(vonUnix) || !Number.isFinite(bisUnix) || bisUnix <= vonUnix) {
      throw new MarketDataError("Der Zeitraum ergibt keinen Sinn: das Ende liegt vor dem Anfang.");
    }
    const json = await getJson(
      `/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${Math.floor(vonUnix)}&period2=${Math.floor(bisUnix)}&interval=${interval}`,
    );
    const chart = mapChartResponse(
      json,
      `${new Date(vonUnix * 1000).toISOString().slice(0, 10)}…${new Date(bisUnix * 1000).toISOString().slice(0, 10)}`,
      interval,
    );
    return beschneide(chart, vonUnix, bisUnix);
  }

  return {
    async search(query, limit = 8) {
      const trimmed = query.trim();
      if (trimmed === "") return [];
      const json = await getJson(
        `/v1/finance/search?q=${encodeURIComponent(trimmed)}&quotesCount=${limit}&newsCount=0`,
      );
      return mapSearchResponse(json).slice(0, limit);
    },
    chart,
    zeitraum,
    async quotes(symbols) {
      const results = await Promise.allSettled(symbols.map((symbol) => chart(symbol, "1d", "5m")));
      const quotes: MarketQuote[] = [];
      const failed: string[] = [];
      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          const { candles: _candles, range: _range, interval: _interval, ...quote } = result.value;
          quotes.push(quote);
        } else {
          failed.push(symbols[index] ?? "?");
        }
      });
      return { quotes, failed };
    },
  };
}
