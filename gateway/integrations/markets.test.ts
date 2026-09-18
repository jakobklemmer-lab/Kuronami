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

  it("weist ungültige Symbole ab, bevor eine Anfrage entsteht", async () => {
    const client = createYahooMarkets({
      fetchImpl: async () => {
        throw new Error("darf nicht aufgerufen werden");
      },
    });
    await expect(client.chart("a b", "1d", "5m")).rejects.toThrow(MarketDataError);
  });
});
