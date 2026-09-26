import { describe, expect, it } from "vitest";
import { DauerFehler, dauerText, formatiereHaltedauer, messeHaltedauer } from "./haltedauer.js";
import type { MarketCandle } from "./integrations/markets.js";

const TAG = 86_400;

/** Kerzen aus Schlusskursen; Hoch und Tief liegen `spanne/2` darüber und darunter. */
function kerzen(schluesse: readonly number[], spanne = 1): MarketCandle[] {
  return schluesse.map((close, i) => ({
    time: 1_700_000_000 + i * TAG,
    open: close,
    high: close + spanne / 2,
    low: close - spanne / 2,
    close,
  }));
}

describe("messeHaltedauer", () => {
  it("zählt die Kerzen bis zum Ziel und rechnet sie in verstrichene Zeit um", () => {
    // Der Kurs steigt um genau 1 je Kerze, die wahre Spanne ist damit überall 1,5 (Hoch gegen
    // den Vorschluss). Bei ATR 1,5 liegt ein Ziel von 2,25 ATR = 3,375 über dem Einstieg, und
    // das Hoch der dritten Kerze danach (Einstieg + 3,5) erreicht es als erstes.
    const reihe = kerzen(Array.from({ length: 120 }, (_, i) => 100 + i));
    const einstieg = reihe[reihe.length - 1].close;
    const ergebnis = messeHaltedauer({
      kerzen: reihe,
      richtung: "long",
      einstieg,
      stop: einstieg - 1.5 * 1.5,
      ziel: einstieg + 2.25 * 1.5,
    });

    expect(ergebnis.stopInAtr).toBeCloseTo(1.5, 6);
    expect(ergebnis.zielInAtr).toBeCloseTo(2.25, 6);
    expect(ergebnis.medianKerzen).toBe(3);
    expect(ergebnis.medianSekunden).toBe(3 * TAG);
    // Ein stur steigender Kurs erreicht immer das Ziel und nie den Stop.
    expect(ergebnis.nullpunktTrefferquote).toBe(1);
    expect(ergebnis.anteilOffen).toBe(0);
  });

  it("lässt den Stop gewinnen, wenn Ziel und Stop in dieselbe Kerze fallen", () => {
    // Flacher Kurs mit Spanne 1 (ATR 1), dann eine einzige Kerze, deren Hoch und Tief beide
    // Marken überspannt. Aus einer Kerze ist nicht ablesbar, was zuerst kam — gewertet wird
    // die ungünstige Möglichkeit.
    const flach = kerzen(new Array(60).fill(100));
    const weit: MarketCandle = {
      time: flach[flach.length - 1].time + TAG,
      open: 100,
      high: 110,
      low: 90,
      close: 100,
    };
    const ergebnis = messeHaltedauer({
      kerzen: [...flach, weit, { ...weit, time: weit.time + TAG }],
      richtung: "long",
      einstieg: 100,
      stop: 98.5,
      ziel: 102.25,
      maxKerzen: 3,
    });
    expect(ergebnis.aufgeloest).toBeGreaterThan(0);
    expect(ergebnis.nullpunktTrefferquote).toBe(0);
  });

  it("weist eine Geometrie ab, die keinen Handel beschreibt", () => {
    const reihe = kerzen(Array.from({ length: 60 }, (_, i) => 100 + i * 0.1));
    const gemeinsam = { kerzen: reihe, richtung: "long" as const, einstieg: 100 };
    expect(() => messeHaltedauer({ ...gemeinsam, stop: 101, ziel: 105 })).toThrow(DauerFehler);
    expect(() => messeHaltedauer({ ...gemeinsam, stop: 98, ziel: 97 })).toThrow(DauerFehler);
  });

  it("meldet eine zu kurze Reihe, statt aus drei Kerzen einen ATR zu schätzen", () => {
    expect(() =>
      messeHaltedauer({
        kerzen: kerzen([100, 101, 102]),
        richtung: "long",
        einstieg: 100,
        stop: 99,
        ziel: 103,
      }),
    ).toThrow(DauerFehler);
  });

  it("sagt es, wenn die Geometrie zum Intervall nicht passt, statt eine Zahl zu erfinden", () => {
    // Ein Kurs, der sich kaum bewegt, erreicht binnen weniger Kerzen weder Ziel noch Stop.
    const reihe = kerzen(new Array(80).fill(100));
    expect(() =>
      messeHaltedauer({
        kerzen: reihe,
        richtung: "long",
        einstieg: 100,
        stop: 90,
        ziel: 120,
        maxKerzen: 5,
      }),
    ).toThrow(DauerFehler);
  });

  it("dünnt lange Reihen aus, statt Millionen Startpunkte zu prüfen", () => {
    const reihe = kerzen(Array.from({ length: 5000 }, (_, i) => 100 + i));
    const ergebnis = messeHaltedauer({
      kerzen: reihe,
      richtung: "long",
      einstieg: reihe[reihe.length - 1].close,
      stop: reihe[reihe.length - 1].close - 2.25,
      ziel: reihe[reihe.length - 1].close + 3.375,
      maxStarts: 500,
    });
    expect(ergebnis.faelle).toBeLessThanOrEqual(500);
    expect(ergebnis.faelle).toBeGreaterThan(400);
  });
});

describe("dauerText", () => {
  it("nennt die Spanne so, wie ein Mensch sie sagt", () => {
    expect(dauerText(600)).toBe("10 Min");
    expect(dauerText(3600)).toBe("60 Min");
    expect(dauerText(5 * 3600)).toBe("5.0 Std");
    expect(dauerText(3 * TAG)).toBe("3.0 Tage");
    expect(dauerText(90 * TAG)).toBe("3.0 Monate");
    expect(dauerText(Number.NaN)).toBe("unbekannt");
  });
});

describe("formatiereHaltedauer", () => {
  it("nennt die Baseline als das, was sie ist", () => {
    const reihe = kerzen(
      Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 3) * 5 + i * 0.1),
    );
    const text = formatiereHaltedauer(
      messeHaltedauer({ kerzen: reihe, richtung: "long", einstieg: 110, stop: 105, ziel: 120 }),
      "1d",
    );
    expect(text).toContain("Voraussichtliche Haltedauer (1d-Kerzen)");
    expect(text).toContain("Baseline ohne Einstiegsregel");
    expect(text).toContain("Erwartungswert");
  });
});
