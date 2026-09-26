import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BinanceQuelle } from "./integrations/binance.js";
import { type MarketCandle, MarketDataError } from "./integrations/markets.js";
import { KerzenFehler, createKerzenquelle, formatiereHerkunft, trenneSymbol } from "./kerzen.js";

const START = Math.floor(Date.parse("2024-03-05T00:00:00Z") / 1000);

function kerzen(vonIndex: number, anzahl: number): MarketCandle[] {
  return Array.from({ length: anzahl }, (_, i) => {
    const n = vonIndex + i;
    return {
      time: START + n * 60,
      open: 100 + n,
      high: 102 + n,
      low: 99 + n,
      close: 101 + n,
      volume: 10,
    };
  });
}

/** Eine Binance-Quelle, die mitschreibt, wonach gefragt wurde. */
function attrappe(antwort: (von: number, bis: number) => MarketCandle[]): {
  quelle: BinanceQuelle;
  anfragen: [number, number][];
} {
  const anfragen: [number, number][] = [];
  return {
    anfragen,
    quelle: {
      async klines({ vonUnix, bisUnix }) {
        anfragen.push([vonUnix, bisUnix]);
        return antwort(vonUnix, bisUnix);
      },
    },
  };
}

describe("trenneSymbol", () => {
  it("trennt Anbieter und Symbol und weist Erfundenes ab", () => {
    expect(trenneSymbol("binance:BTCUSDT")).toEqual({ quelle: "binance", symbol: "BTCUSDT" });
    expect(trenneSymbol("^GDAXI")).toEqual({ quelle: "yahoo", symbol: "^GDAXI" });
    expect(trenneSymbol("yahoo:AAPL")).toEqual({ quelle: "yahoo", symbol: "AAPL" });
    expect(() => trenneSymbol("binance:BTC-USD")).toThrow(KerzenFehler);
    expect(() => trenneSymbol("kraken:BTCUSD")).toThrow(KerzenFehler);
  });
});

describe("Kerzenquelle", () => {
  let wurzel: string;
  beforeEach(async () => {
    wurzel = await mkdtemp(path.join(tmpdir(), "kuro-quelle-"));
  });
  afterEach(async () => {
    await rm(wurzel, { recursive: true, force: true });
  });

  it("holt beim ersten Mal alles und beim zweiten Mal nichts mehr", async () => {
    const { quelle, anfragen } = attrappe(() => kerzen(0, 100));
    const kq = createKerzenquelle({ workdir: wurzel, binance: quelle });

    const erste = await kq.hole({
      symbol: "binance:BTCUSDT",
      intervall: "1m",
      vonUnix: START,
      bisUnix: START + 100 * 60,
    });
    expect(erste.kerzen).toHaveLength(100);
    expect(erste.neuGeholt).toBe(100);
    expect(erste.ausSpeicher).toBe(0);
    expect(anfragen).toHaveLength(1);

    const zweite = await kq.hole({
      symbol: "binance:BTCUSDT",
      intervall: "1m",
      vonUnix: START,
      bisUnix: START + 100 * 60,
    });
    expect(zweite.kerzen).toHaveLength(100);
    expect(zweite.neuGeholt).toBe(0);
    expect(zweite.ausSpeicher).toBe(100);
    // Der Rand ist gedeckt, es wird nichts nachgefragt.
    expect(anfragen).toHaveLength(1);
  });

  it("lädt nur den fehlenden Rand nach, nicht den ganzen Zeitraum", async () => {
    const { quelle, anfragen } = attrappe((von, bis) => {
      // Der Anbieter antwortet auf jeden Rand mit genau den Kerzen, die hineinpassen.
      const abIndex = Math.ceil((von - START) / 60);
      const bisIndex = Math.ceil((bis - START) / 60);
      return kerzen(abIndex, bisIndex - abIndex);
    });
    const kq = createKerzenquelle({ workdir: wurzel, binance: quelle });

    await kq.hole({
      symbol: "binance:BTCUSDT",
      intervall: "1m",
      vonUnix: START,
      bisUnix: START + 50 * 60,
    });
    anfragen.length = 0;

    const erweitert = await kq.hole({
      symbol: "binance:BTCUSDT",
      intervall: "1m",
      vonUnix: START,
      bisUnix: START + 100 * 60,
    });
    expect(anfragen).toHaveLength(1);
    // Gefragt wird erst ab der letzten gespeicherten Kerze, nicht ab dem Anfang.
    expect(anfragen[0][0]).toBeGreaterThan(START);
    expect(erweitert.kerzen).toHaveLength(100);
    expect(erweitert.neuGeholt).toBe(50);
  });

  it("arbeitet mit dem Gespeicherten weiter, wenn der Anbieter den Rand verweigert", async () => {
    const { quelle } = attrappe(() => kerzen(0, 30));
    const kq = createKerzenquelle({ workdir: wurzel, binance: quelle });
    await kq.hole({
      symbol: "binance:BTCUSDT",
      intervall: "1m",
      vonUnix: START,
      bisUnix: START + 30 * 60,
    });

    // Yahoo weist zu alte Intraday-Fenster mit HTTP 422 ab; das darf den Lauf nicht killen.
    const stur = createKerzenquelle({
      workdir: wurzel,
      binance: {
        async klines() {
          throw new MarketDataError("5m data not available … within the last 60 days.");
        },
      },
    });
    const antwort = await stur.hole({
      symbol: "binance:BTCUSDT",
      intervall: "1m",
      vonUnix: START,
      bisUnix: START + 100 * 60,
    });
    expect(antwort.kerzen).toHaveLength(30);
    expect(antwort.neuGeholt).toBe(0);
  });

  it("fragt mit nurSpeicher gar nicht erst beim Anbieter nach", async () => {
    const { quelle, anfragen } = attrappe(() => kerzen(0, 10));
    const kq = createKerzenquelle({ workdir: wurzel, binance: quelle });
    const antwort = await kq.hole({
      symbol: "binance:BTCUSDT",
      intervall: "1m",
      vonUnix: START,
      bisUnix: START + 600,
      nurSpeicher: true,
    });
    expect(antwort.kerzen).toEqual([]);
    expect(anfragen).toHaveLength(0);
  });

  it("weist einen unsinnigen Zeitraum ab", async () => {
    const kq = createKerzenquelle({ workdir: wurzel, binance: attrappe(() => []).quelle });
    await expect(
      kq.hole({ symbol: "binance:BTCUSDT", intervall: "1m", vonUnix: START, bisUnix: START }),
    ).rejects.toThrow(KerzenFehler);
  });
});

describe("formatiereHerkunft", () => {
  it("nennt Berichtigungen und Lücken, statt sie zu verschweigen", () => {
    const text = formatiereHerkunft({
      kerzen: [],
      quelle: "binance",
      symbol: "BTCUSDT",
      intervall: "1m",
      ausSpeicher: 900,
      neuGeholt: 100,
      berichtigt: 3,
      luecken: [{ von: START, bis: START + 3600, fehlendeKerzen: 59 }],
    });
    expect(text).toContain("binance:BTCUSDT");
    expect(text).toContain("3 gespeicherte Kerzen sieht der Anbieter inzwischen anders");
    expect(text).toContain("59 fehlende Kerzen");
  });
});
