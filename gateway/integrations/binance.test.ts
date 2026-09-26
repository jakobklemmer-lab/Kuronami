import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SEITE_MAX, createBinanceQuelle, istBinanceSymbol } from "./binance.js";
import { MarketDataError } from "./markets.js";

/** Eine Binance-Kerzenreihe, wie sie über die Leitung kommt: alle Zahlen als Zeichenketten. */
function reihe(oeffnungMs: number, dauerMs: number, schluss: number, volumen = 1) {
  return [
    String(oeffnungMs),
    String(schluss - 1),
    String(schluss + 2),
    String(schluss - 3),
    String(schluss),
    String(volumen),
    String(oeffnungMs + dauerMs - 1),
    "0",
    10,
    "0",
    "0",
    "0",
  ];
}

const MINUTE = 60_000;
/** Ein fester „Jetzt"-Punkt, damit die Prüfung der laufenden Kerze nicht von der Uhr abhängt. */
const JETZT = 1_700_000_000_000;

describe("istBinanceSymbol", () => {
  it("lässt Binance-Paare durch und weist alles andere ab", () => {
    for (const ok of ["BTCUSDT", "ETHEUR", "SOLUSDC"]) expect(istBinanceSymbol(ok)).toBe(true);
    for (const bad of ["BTC-USD", "^GDAXI", "btcusdt", "", "A", "x".repeat(21)]) {
      expect(istBinanceSymbol(bad)).toBe(false);
    }
  });
});

describe("createBinanceQuelle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(JETZT);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("blättert über mehrere Seiten und rückt hinter die letzte gelesene Kerze, nicht um eine feste Schrittweite", async () => {
    const start = JETZT - 3000 * MINUTE;
    const urls: string[] = [];
    const quelle = createBinanceQuelle({
      warte: async () => {},
      fetchImpl: async (url) => {
        urls.push(url);
        const treffer = /startTime=(\d+)/.exec(url);
        const von = Number(treffer?.[1]);
        // Zweite Seite liefert **weniger** als angefragt, ohne dass die Reihe endet — genau der
        // Fall, in dem eine feste Schrittweite eine unsichtbare Lücke risse.
        const anzahl = urls.length === 2 ? 400 : SEITE_MAX;
        const kerzen = Array.from({ length: anzahl }, (_, i) =>
          reihe(von + i * MINUTE, MINUTE, 100 + i),
        );
        return Response.json(kerzen);
      },
    });

    const kerzen = await quelle.klines({
      symbol: "BTCUSDT",
      intervall: "1m",
      vonUnix: start / 1000,
      bisUnix: JETZT / 1000,
    });

    // Seite 2 endete früh, also hört das Blättern dort auf: 1000 + 400 Kerzen.
    expect(kerzen.length).toBe(1400);
    expect(urls).toHaveLength(2);
    // Die zweite Anfrage beginnt genau eine Minute hinter der letzten Kerze der ersten Seite.
    expect(urls[1]).toContain(`startTime=${start + SEITE_MAX * MINUTE}`);
    // Lückenlos und aufsteigend.
    for (let i = 1; i < kerzen.length; i += 1) {
      expect(kerzen[i].time - kerzen[i - 1].time).toBe(60);
    }
  });

  it("nimmt die eben geschlossene Kerze und lässt die noch laufende weg", async () => {
    // Die Grenze ist der **Schluss**, nicht die Eröffnung. Die dritte Kerze hat gerade eben
    // geschlossen und zählt; die vierte läuft noch (sie öffnete vor 20 Sekunden und schließt
    // in 40) — ihr Schlusskurs steht noch nicht fest und würde einem Backtest einen Kurs
    // zeigen, den es an der Börse nie gab.
    const quelle = createBinanceQuelle({
      warte: async () => {},
      fetchImpl: async () =>
        Response.json([
          reihe(JETZT - 3 * MINUTE, MINUTE, 100),
          reihe(JETZT - 2 * MINUTE, MINUTE, 101),
          reihe(JETZT - 1 * MINUTE, MINUTE, 102),
          reihe(JETZT - 20_000, MINUTE, 103),
        ]),
    });
    const kerzen = await quelle.klines({
      symbol: "BTCUSDT",
      intervall: "1m",
      vonUnix: (JETZT - 10 * MINUTE) / 1000,
      bisUnix: (JETZT + 10 * MINUTE) / 1000,
    });
    expect(kerzen.map((k) => k.close)).toEqual([100, 101, 102]);
  });

  it("schneidet Kerzen ab dem angefragten Ende ab und entdoppelt Überlappungen", async () => {
    const start = JETZT - 100 * MINUTE;
    const ende = JETZT - 90 * MINUTE;
    let seite = 0;
    const quelle = createBinanceQuelle({
      warte: async () => {},
      fetchImpl: async () => {
        seite += 1;
        if (seite > 1) return Response.json([]);
        return Response.json([
          reihe(start, MINUTE, 10),
          reihe(start, MINUTE, 11), // dieselbe Kerze ein zweites Mal, vollständiger
          reihe(start + MINUTE, MINUTE, 12),
          reihe(ende, MINUTE, 99), // liegt genau auf dem Ende: gehört schon ins nächste Fenster
        ]);
      },
    });
    const kerzen = await quelle.klines({
      symbol: "BTCUSDT",
      intervall: "1m",
      vonUnix: start / 1000,
      bisUnix: ende / 1000,
    });
    expect(kerzen.map((k) => k.close)).toEqual([11, 12]);
  });

  it("befolgt Retry-After statt stur weiterzufragen", async () => {
    const pausen: number[] = [];
    let ruf = 0;
    const quelle = createBinanceQuelle({
      warte: async (ms) => {
        pausen.push(ms);
      },
      fetchImpl: async () => {
        ruf += 1;
        if (ruf === 1) {
          return new Response("too many", { status: 429, headers: { "retry-after": "7" } });
        }
        return Response.json([reihe(JETZT - 5 * MINUTE, MINUTE, 50)]);
      },
    });
    const kerzen = await quelle.klines({
      symbol: "BTCUSDT",
      intervall: "1m",
      vonUnix: (JETZT - 10 * MINUTE) / 1000,
      bisUnix: (JETZT - 1 * MINUTE) / 1000,
    });
    expect(pausen[0]).toBe(7000);
    expect(kerzen).toHaveLength(1);
  });

  it("weist fremde Symbole und unsinnige Zeiträume ab, bevor eine Anfrage entsteht", async () => {
    const quelle = createBinanceQuelle({
      fetchImpl: async () => {
        throw new Error("darf nicht aufgerufen werden");
      },
    });
    await expect(
      quelle.klines({ symbol: "BTC-USD", intervall: "1m", vonUnix: 1, bisUnix: 2 }),
    ).rejects.toThrow(MarketDataError);
    await expect(
      quelle.klines({ symbol: "BTCUSDT", intervall: "1m", vonUnix: 500, bisUnix: 500 }),
    ).rejects.toThrow(MarketDataError);
  });

  it("überspringt unlesbare Kerzen statt NaN in die Reihe zu lassen", async () => {
    const quelle = createBinanceQuelle({
      warte: async () => {},
      fetchImpl: async () =>
        Response.json([
          reihe(JETZT - 5 * MINUTE, MINUTE, 50),
          [String(JETZT - 4 * MINUTE), "nicht", "zu", "lesen", "hier", "auch", String(JETZT)],
          reihe(JETZT - 3 * MINUTE, MINUTE, 52),
        ]),
    });
    const kerzen = await quelle.klines({
      symbol: "BTCUSDT",
      intervall: "1m",
      vonUnix: (JETZT - 10 * MINUTE) / 1000,
      bisUnix: (JETZT - 1 * MINUTE) / 1000,
    });
    expect(kerzen.map((k) => k.close)).toEqual([50, 52]);
    expect(kerzen.every((k) => Number.isFinite(k.close))).toBe(true);
  });
});
