import { describe, expect, it } from "vitest";
import type { Strategie } from "./backtest.js";
import { bezugDerAnalyse, erwaehnt } from "./chart-routen.js";
import type { MarketCandle } from "./integrations/markets.js";
import { chartIndikatorFuer, regelInWorten, strategieImChart } from "./strategie-chart.js";
import type { StrategieEintrag } from "./strategien.js";

const regel: Strategie = {
  name: "Trendfolge-Pullback",
  richtung: "long",
  einstieg: [
    { links: { art: "kurs" }, vergleich: "ueber", rechts: { art: "sma", periode: 20 } },
    {
      links: { art: "rsi", periode: 14 },
      vergleich: "kreuzt_ueber",
      rechts: { art: "wert", wert: 40 },
    },
  ],
  stopAtr: 2,
  zielR: 3,
  maxKerzen: 30,
};

describe("Regel für den Chart", () => {
  it("übersetzt Regel-Indikatoren in die Schreibweise des Charts", () => {
    expect(chartIndikatorFuer({ art: "sma", periode: 200 })).toBe("sma:200");
    expect(chartIndikatorFuer({ art: "macd_signal", periode: 12, periode2: 26, periode3: 9 })).toBe(
      "macd:12:26:9",
    );
    expect(chartIndikatorFuer({ art: "bollinger_unten", periode: 20, faktor: 2 })).toBe("bb:20:2");
    expect(chartIndikatorFuer({ art: "di_plus", periode: 14 })).toBe("adx:14");
    expect(chartIndikatorFuer({ art: "kurs" })).toBeNull();
    expect(chartIndikatorFuer({ art: "wert", wert: 40 })).toBeNull();
  });

  it("schreibt die Regel in Sätzen", () => {
    expect(regelInWorten(regel)).toEqual([
      "Long-Einstieg, wenn Kurs über SMA 20 und RSI 14 kreuzt nach oben 40",
      "Stop 2 ATR, Ziel 3 R",
      "Spätestens nach 30 Kerzen raus",
    ]);
  });

  it("nennt einen Stop an einer Linie beim Namen", () => {
    const anLinie = { ...regel, stopAtr: undefined, stopAn: { art: "ema" as const, periode: 200 } };
    expect(regelInWorten(anLinie)[1]).toBe("Stop an EMA 200, Ziel 3 R");
  });
});

describe("strategieImChart", () => {
  // Ein Sägezahn mit Aufwärtstrend: die Regel findet darin regelmäßig Einstiege.
  const tag = 86_400;
  const start = Date.UTC(2024, 0, 1) / 1000;
  const kerzen: MarketCandle[] = Array.from({ length: 400 }, (_, i) => {
    const basis = 100 + i * 0.1 + 15 * Math.sin(i / 8);
    return {
      time: start + i * tag,
      open: basis,
      high: basis + 1.5,
      low: basis - 1.5,
      close: basis + 0.3,
    };
  });
  const eintrag = {
    id: "t1",
    zeit: "2024-10-01T00:00:00Z",
    name: "Test",
    wer: "stratege",
    symbol: "^GDAXI",
    intervall: "1d",
    von: "2024-01-01",
    bis: "2024-09-30",
    status: "geprueft",
    kennzahlen: null,
    warnungen: 0,
    strategie: regel,
    inSample: null,
    outOfSample: { von: "2024-06-01", bis: "2024-09-30", kennzahlen: {} },
    warnungstexte: [],
    bericht: "",
  } as unknown as StrategieEintrag;

  it("markiert, was nach der Ablage begann, und nennt die Teilung", () => {
    const bild = strategieImChart(eintrag, kerzen);
    const grenze = Date.UTC(2024, 9, 1) / 1000;
    expect(bild.handel.length).toBeGreaterThan(3);
    for (const h of bild.handel) expect(h.nachAblage).toBe(h.einstiegZeit >= grenze);
    expect(bild.seitAblage.anzahl).toBe(bild.handel.filter((h) => h.nachAblage).length);
    expect(bild.teilung).toBe(Date.UTC(2024, 5, 1) / 1000);
    expect(bild.indikatoren).toEqual(["sma:20", "rsi:14"]);
    expect(bild.abweichung).toBeUndefined();
  });

  it("sagt es, wenn der Neulauf mehr als einen Handel vom Archiv abweicht", () => {
    const anders = { ...eintrag, kennzahlen: { anzahl: 99 } } as unknown as StrategieEintrag;
    expect(strategieImChart(anders, kerzen).abweichung).toMatch(/Im Archiv stehen 99 Handel/);
  });
});

describe("erwaehnt", () => {
  it("findet Kürzel und ganze Namen, aber nicht Teile von Wörtern", () => {
    expect(erwaehnt("Setup im DAX heute", "^GDAXI", "DAX")).toBe(true);
    expect(erwaehnt("^GDAXI auf Tagesbasis", "^GDAXI", "DAX")).toBe(true);
    expect(erwaehnt("MDAX schwächer", "^GDAXI", "DAX")).toBe(false);
    expect(erwaehnt("Gold (GC=F) läuft", "GC=F", "Gold")).toBe(true);
  });
});

describe("bezugDerAnalyse", () => {
  const analyse = {
    id: "a1",
    zeit: "2026-09-22T06:39:50Z",
    wer: "boerse",
    dauerMs: 240_000,
    titel: "Bitcoin — Einschätzung",
  };
  it("verbindet über den Lauf, nicht über den Text", () => {
    const b = bezugDerAnalyse(
      analyse,
      [
        { id: "p1", angelegt: "2026-09-22T06:39:38Z", von: "boerse", symbol: "BTC-USD" },
        { id: "p2", angelegt: "2026-09-21T06:39:38Z", von: "boerse", symbol: "ETH-USD" },
        { id: "p3", angelegt: "2026-09-22T06:38:00Z", von: "jakob", symbol: "^GDAXI" },
      ],
      [],
    );
    expect(b).toEqual({ symbol: "BTC-USD", prognosen: ["p1"], strategien: [] });
  });

  it("nimmt sonst nur ein eindeutiges Kürzel aus dem Titel", () => {
    expect(
      bezugDerAnalyse({ ...analyse, titel: "Bitcoin (BTC-USD) — Einschätzung" }, [], []).symbol,
    ).toBe("BTC-USD");
    expect(
      bezugDerAnalyse({ ...analyse, titel: "Der ^GDAXI auf Wochenbasis" }, [], []).symbol,
    ).toBe("^GDAXI");
    expect(
      bezugDerAnalyse({ ...analyse, titel: "Hier der Überblick, Jakob:" }, [], []).symbol,
    ).toBeNull();
  });
});
