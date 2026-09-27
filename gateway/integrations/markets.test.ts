import { describe, expect, it } from "vitest";
import {
  MarketDataError,
  createYahooMarkets,
  defaultIntervalFor,
  isValidSymbol,
  mapChartResponse,
  mapSearchResponse,
} from "./markets.js";

const chartJson = {
  chart: {
    result: [
      {
        meta: {
          symbol: "AAPL",
          currency: "USD",
          shortName: "Apple Inc.",
          fullExchangeName: "NasdaqGS",
          regularMarketPrice: 227.48,
          chartPreviousClose: 226.25,
          regularMarketChangePercent: 0.5436,
        },
        timestamp: [1_758_000_000, 1_758_000_300, 1_758_000_600],
        indicators: {
          quote: [
            {
              open: [226.3, 226.9, null],
              high: [227.0, 227.5, 228.0],
              low: [226.1, 226.8, 227.2],
              close: [226.9, 227.48, 227.9],
            },
          ],
        },
      },
    ],
    error: null,
  },
};

describe("mapChartResponse über lange Fenster", () => {
  // Nachgebaut aus der echten Antwort vom 2026-09-27 (DAX, period1=0, 1d).
  const lang = {
    chart: {
      result: [
        {
          meta: {
            symbol: "^GDAXI",
            regularMarketPrice: 25408.64,
            regularMarketChangePercent: 0.562,
            chartPreviousClose: 1005.19,
            dataGranularity: "3mo",
            instrumentType: "INDEX",
            exchangeTimezoneName: "Europe/Berlin",
            priceHint: 2,
            currentTradingPeriod: { regular: { start: 1790319600, end: 1790350200 } },
          },
          timestamp: [],
          indicators: { quote: [{}] },
        },
      ],
      error: null,
    },
  };

  it("nimmt für die Veränderung den Vortag, nicht den Schluss vor dem Fenster", () => {
    const chart = mapChartResponse(lang, "max", "1d");
    expect(chart.changePct).toBeCloseTo(0.562);
    expect(chart.change).toBeCloseTo(142.0, 0);
    expect(chart.vortag).toBeCloseTo(25266.65, 1);
  });

  it("liest den Vortag bei Tageskerzen aus der Reihe, vor der laufenden Sitzung", () => {
    const start = 1790319600;
    const json = structuredClone(lang);
    const r = json.chart.result[0] as unknown as Record<string, unknown>;
    r.timestamp = [start - 2 * 86400, start - 86400, start];
    r.indicators = {
      quote: [
        { open: [1, 1, 1], high: [1, 1, 1], low: [1, 1, 1], close: [25100, 25266.53, 25408.64] },
      ],
    };
    const chart = mapChartResponse(json, "max", "1d");
    expect(chart.vortag).toBe(25266.53);
    expect(chart.change).toBeCloseTo(142.11, 2);
  });

  it("beschriftet mit dem, was geliefert wurde, und reicht die Marktangaben durch", () => {
    const chart = mapChartResponse(lang, "max", "1d");
    expect(chart.interval).toBe("3mo");
    expect(chart.typ).toBe("INDEX");
    expect(chart.zeitzone).toBe("Europe/Berlin");
    expect(chart.sitzung).toEqual({ start: 1790319600, ende: 1790350200 });
    expect(chart.stellen).toBe(2);
  });
});

describe("isValidSymbol", () => {
  it("lässt Yahoo-Formen durch und weist Fremdes ab", () => {
    for (const ok of ["AAPL", "SAP.DE", "BTC-USD", "^GDAXI", "EURUSD=X", "ES=F"]) {
      expect(isValidSymbol(ok)).toBe(true);
    }
    for (const bad of ["", "a b", "AAPL/x", "x".repeat(21), "<script>"]) {
      expect(isValidSymbol(bad)).toBe(false);
    }
  });
});

describe("mapChartResponse", () => {
  it("bildet Kurs, Veränderung und Kerzen ab und überspringt Lücken", () => {
    const chart = mapChartResponse(chartJson, "1d", "5m");
    expect(chart.symbol).toBe("AAPL");
    expect(chart.name).toBe("Apple Inc.");
    expect(chart.currency).toBe("USD");
    expect(chart.price).toBe(227.48);
    expect(chart.changePct).toBeCloseTo(0.5436);
    expect(chart.change).toBeCloseTo(1.23);
    expect(chart.candles).toHaveLength(2);
    expect(chart.candles[1]).toEqual({
      time: 1_758_000_300,
      open: 226.9,
      high: 227.5,
      low: 226.8,
      close: 227.48,
    });
    expect(chart.spark).toEqual([226.9, 227.48]);
  });

  it("rechnet die Veränderung aus dem Vortagesschluss, wenn Yahoo keine nennt", () => {
    const json = structuredClone(chartJson);
    // Der Schlüssel muss wirklich fehlen — genau das ist der Fall, den Yahoo liefert und den
    // der Test nachstellt. Ein `undefined` daneben wäre ein anderer Fall.
    // biome-ignore lint/performance/noDelete: siehe oben
    delete (json.chart.result[0].meta as Record<string, unknown>).regularMarketChangePercent;
    const chart = mapChartResponse(json, "1d", "5m");
    expect(chart.changePct).toBeCloseTo(((227.48 - 226.25) / 226.25) * 100);
  });

  it("wirft einen benannten Fehler bei Yahoos Fehlerform", () => {
    expect(() =>
      mapChartResponse(
        {
          chart: { result: null, error: { description: "No data found, symbol may be delisted" } },
        },
        "1d",
        "5m",
      ),
    ).toThrow(MarketDataError);
  });
});

describe("mapSearchResponse", () => {
  it("nimmt Langnamen vor Kurznamen und lässt ungültige Symbole weg", () => {
    const hits = mapSearchResponse({
      quotes: [
        {
          symbol: "AAPL",
          shortname: "Apple",
          longname: "Apple Inc.",
          exchDisp: "NASDAQ",
          quoteType: "EQUITY",
        },
        { symbol: "bad symbol", shortname: "x" },
        {
          symbol: "BTC-USD",
          shortname: "Bitcoin USD",
          exchange: "CCC",
          quoteType: "CRYPTOCURRENCY",
        },
      ],
    });
    expect(hits).toEqual([
      { symbol: "AAPL", name: "Apple Inc.", exchange: "NASDAQ", type: "EQUITY" },
      { symbol: "BTC-USD", name: "Bitcoin USD", exchange: "CCC", type: "CRYPTOCURRENCY" },
    ]);
  });
});

describe("defaultIntervalFor", () => {
  it("wird mit dem Zeitraum gröber", () => {
    expect(defaultIntervalFor("1d")).toBe("5m");
    expect(defaultIntervalFor("1y")).toBe("1d");
    expect(defaultIntervalFor("max")).toBe("1wk");
  });
});

describe("createYahooMarkets", () => {
  it("ruft Suche und Chart mit Browser-Kennung ab und lässt bei quotes() Ausfälle einzeln stehen", async () => {
    const calls: string[] = [];
    const client = createYahooMarkets({
      fetchImpl: async (url, init) => {
        calls.push(url);
        expect((init?.headers as Record<string, string>)["user-agent"]).toMatch(/Mozilla/);
        if (url.includes("/chart/FAIL")) return new Response("nope", { status: 404 });
        if (url.includes("/chart/")) return Response.json(chartJson);
        return Response.json({
          quotes: [{ symbol: "AAPL", longname: "Apple Inc.", quoteType: "EQUITY" }],
        });
      },
    });
    const hits = await client.search("apple", 3);
    expect(hits[0]?.symbol).toBe("AAPL");
    expect(calls[0]).toContain("/v1/finance/search?q=apple&quotesCount=3");

    const { quotes, failed } = await client.quotes(["AAPL", "FAIL"]);
    expect(quotes.map((q) => q.symbol)).toEqual(["AAPL"]);
    expect(failed).toEqual(["FAIL"]);
    expect("candles" in (quotes[0] ?? {})).toBe(false);
  });

  it("schneidet bei zeitraum() die angehängte Kerze der letzten Sitzung ab", async () => {
    // Nachgebaut aus einer echten Antwort (2026-09-21): Yahoo hängt bei feinen Intervallen
    // hinter das angefragte Fenster eine Scheinkerze mit dem aktuellen Kurs (O=H=L=C, Volumen 0).
    const von = 1_700_000_000;
    const bis = 1_700_086_400;
    const heute = 1_789_761_600;
    const client = createYahooMarkets({
      fetchImpl: async (url) => {
        expect(url).toContain(`period1=${von}`);
        expect(url).toContain(`period2=${bis}`);
        return Response.json({
          chart: {
            result: [
              {
                meta: { symbol: "AAPL", regularMarketPrice: 336.13, chartPreviousClose: 335 },
                timestamp: [von, von + 3600, heute],
                indicators: {
                  quote: [
                    {
                      open: [100, 101, 336.13],
                      high: [102, 103, 336.13],
                      low: [99, 100, 336.13],
                      close: [101, 102, 336.13],
                      volume: [1000, 1200, 0],
                    },
                  ],
                },
              },
            ],
            error: null,
          },
        });
      },
    });
    const chart = await client.zeitraum("AAPL", von, bis, "1h");
    expect(chart.candles.map((k) => k.time)).toEqual([von, von + 3600]);
    expect(chart.spark).toEqual([101, 102]);
  });

  it("fragt max über period1=0 an, weil range=max Quartalskerzen liefert", async () => {
    const urls: string[] = [];
    const client = createYahooMarkets({
      fetchImpl: async (url) => {
        urls.push(url);
        return Response.json(chartJson);
      },
    });
    await client.chart("AAPL", "max", "1wk");
    await client.chart("AAPL", "5y", "1wk");
    expect(urls[0]).toContain("period1=0&period2=");
    expect(urls[0]).not.toContain("range=");
    expect(urls[1]).toContain("range=5y");
  });

  it("weist ungültige Symbole ab, bevor eine Anfrage entsteht", async () => {
    const client = createYahooMarkets({
      fetchImpl: async () => {
        throw new Error("darf nicht aufgerufen werden");
      },
    });
    await expect(client.chart("a b", "1d", "5m")).rejects.toThrow(MarketDataError);
  });
});
