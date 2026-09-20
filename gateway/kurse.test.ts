import { describe, expect, it } from "vitest";
import type { MarketChart } from "./integrations/markets.js";
import { formatiereTreffer, formatiereVerlauf } from "./kurse.js";

/**
 * Warum es diese Tests gibt: das Werkzeug ersetzt einen Abruf, der **falsche Zahlen**
 * geliefert hat (WebFetch durch ein Zusammenfassungsmodell, 2026-09-20 — „182 Tage ab
 * 21. November 2024" für einen Sechs-Monats-Abruf). Ein Ersatz, der selbst still danebenliegt,
 * wäre schlimmer als das Problem. Danebenliegen hieße hier vor allem: ein Datum, das nicht
 * zu seinem Zeitstempel gehört.
 */

/** 2026-09-18, -19, -20, jeweils 00:00 UTC. */
const T = [1789689600, 1789776000, 1789862400];

function chart(ueberschreibe: Partial<MarketChart> = {}): MarketChart {
  return {
    symbol: "SOL-USD",
    name: "Solana USD",
    currency: "USD",
    exchange: "CCC",
    price: 108.61,
    change: 9.87,
    changePct: 10,
    spark: [],
    weekHigh52: 241.8,
    weekLow52: 57.74,
    range: "5d",
    interval: "1d",
    candles: T.map((time, i) => ({
      time,
      open: 98 + i,
      high: 115 + i,
      low: 97 + i,
      close: 107 + i,
    })),
    ...ueberschreibe,
  };
}

describe("formatiereVerlauf", () => {
  it("nennt zu jeder Kerze das Datum, das zu ihrem Zeitstempel gehört", () => {
    const text = formatiereVerlauf(chart());
    expect(text).toContain("2026-09-18  98.000");
    expect(text).toContain("2026-09-19  99.000");
    expect(text).toContain("2026-09-20  100.000");
  });

  it("nennt den Zeitraum mit erster und letzter Kerze und sagt UTC dazu", () => {
    expect(formatiereVerlauf(chart())).toContain(
      "Zeitraum 5d, Intervall 1d, 3 Kerzen (2026-09-18 bis 2026-09-20, UTC)",
    );
  });

  it("nennt Kurs, Veränderung und die 52-Wochen-Spanne", () => {
    const text = formatiereVerlauf(chart());
    expect(text).toContain("Kurs 108.610, +10.00 % zum Vortagesschluss");
    expect(text).toContain("52 Wochen: Hoch 241.800, Tief 57.740");
  });

  /**
   * Yahoo mischt hier zwei Bezugspunkte: `regularMarketChangePercent` ist die Bewegung des
   * Tages, `chartPreviousClose` der Schluss **vor dem Zeitraum**. In einer Zeile zusammen
   * ergibt das bei range=1y „-0,28 % (4482,27 zuvor)" neben einem Kurs von 2637 — in sich
   * widersprüchlich, und genau die Sorte Zahl, gegen die dieses Modul gebaut ist.
   */
  it("wirft Tagesbewegung und Zeitraumbewegung nicht zusammen", () => {
    const jahr = chart({
      range: "1y",
      interval: "1wk",
      price: 2637.31,
      change: 2637.31 - 4482.27,
      changePct: -0.28,
      candles: [
        { time: T[0], open: 4450, high: 4510, low: 4447, close: 4451.33 },
        { time: T[2], open: 2650, high: 2660, low: 2600, close: 2637.31 },
      ],
    });
    const text = formatiereVerlauf(jahr);
    expect(text).toContain("Kurs 2637.31, -0.28 % zum Vortagesschluss");
    expect(text).toContain("Über den Zeitraum: 4451.33 → 2637.31 (-40.75 %)");
    expect(text).not.toContain("zuvor)");
  });

  it("lässt die 52-Wochen-Zeile weg, wenn Yahoo sie nicht mitschickt", () => {
    const ohne = chart();
    ohne.weekHigh52 = undefined;
    ohne.weekLow52 = undefined;
    expect(formatiereVerlauf(ohne)).not.toContain("52 Wochen");
  });

  it("schreibt bei feinen Intervallen die Uhrzeit dazu", () => {
    expect(formatiereVerlauf(chart({ interval: "15m" }))).toContain("2026-09-18 00:00");
  });

  it("kürzt lange Reihen hinten heraus und sagt, wie viel fehlt", () => {
    const viele = chart({
      range: "1y",
      candles: Array.from({ length: 260 }, (_, i) => ({
        time: T[0] + i * 86_400,
        open: 1,
        high: 2,
        low: 0.5,
        close: 1.5,
      })),
    });
    const text = formatiereVerlauf(viele);
    expect(text).toContain("200 Kerzen");
    expect(text).toContain("ältere 60 gekürzt");
  });

  it("sagt es, wenn keine Kerzen kommen, statt eine leere Tabelle zu bauen", () => {
    const text = formatiereVerlauf(chart({ candles: [] }));
    expect(text).toContain("keine Kerzen geliefert");
    expect(text).not.toContain("Datum  Open");
  });

  it("gibt kleinen Kursen mehr Nachkommastellen als großen", () => {
    expect(formatiereVerlauf(chart({ price: 0.00042 }))).toContain("Kurs 0.000420");
    expect(formatiereVerlauf(chart({ price: 25304.06 }))).toContain("Kurs 25304.06");
  });
});

describe("formatiereTreffer", () => {
  it("nennt Symbol und Namen, damit niemand raten muss", () => {
    const text = formatiereTreffer(
      [{ symbol: "SOL-USD", name: "Solana USD", exchange: "CCC", type: "CRYPTOCURRENCY" }],
      "Solana",
    );
    expect(text).toBe("SOL-USD — Solana USD (CRYPTOCURRENCY, CCC)");
  });

  it("sagt klar, wenn nichts gefunden wurde", () => {
    expect(formatiereTreffer([], "Xyzzy")).toContain("Nichts gefunden");
  });
});
