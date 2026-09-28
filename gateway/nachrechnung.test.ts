import { describe, expect, it } from "vitest";
import type { Handel } from "./backtest.js";
import { konfidenz } from "./konfidenz.js";
import { pruefeMehrfach, strengeHuerde, urteile, zeileAus } from "./nachrechnung.js";

function handel(r: number, zeit: number): Handel {
  return {
    einstiegZeit: zeit,
    ausstiegZeit: zeit + 1,
    einstieg: 100,
    ausstieg: 100 + r,
    stop: 99,
    ziel: 101,
    grund: r > 0 ? "ziel" : "stop",
    renditeProzent: r,
    r,
    kerzen: 1,
  };
}

/** `n` Handel mit `anteil` Gewinnern zu `gewinn` R, der Rest −1 R, im Abstand von 10 Sekunden. */
function reihe(n: number, anteil: number, gewinn: number, start = 0): Handel[] {
  return Array.from({ length: n }, (_, i) =>
    handel(Math.floor((i + 1) * anteil) > Math.floor(i * anteil) ? gewinn : -1, start + i * 10),
  );
}

describe("urteile", () => {
  it("urteilt erst ab 200 Handeln, wie die Ablage", () => {
    const r = reihe(199, 0.6, 1).map((h) => h.r);
    expect(urteile(199, konfidenz(r), 0.2)).toBe("zu wenig Handel");
  });

  it("verlangt für „belegt“ auch ein Plus im ungesehenen Teil", () => {
    const k = konfidenz(reihe(400, 0.6, 1).map((h) => h.r));
    expect(urteile(400, k, 0.2)).toBe("belegt");
    expect(urteile(400, k, -0.1)).toBe("nicht belegt");
  });

  it("widerlegt nur, wenn das Intervall ganz unter null liegt", () => {
    expect(urteile(400, konfidenz(reihe(400, 0.3, 1).map((h) => h.r)), -0.4)).toBe("widerlegt");
    expect(urteile(400, konfidenz(reihe(400, 0.5, 1).map((h) => h.r)), 0)).toBe("nicht belegt");
  });
});

describe("strengeHuerde", () => {
  it("ist bei einem Versuch die übliche 1,96 und wächst mit der Zahl der Versuche", () => {
    expect(strengeHuerde(1)).toBeCloseTo(1.96, 2);
    expect(strengeHuerde(80)).toBeCloseTo(3.42, 1);
    expect(strengeHuerde(80)).toBeGreaterThan(strengeHuerde(10));
  });
});

describe("zeileAus", () => {
  const lauf = {
    symbol: "TEST",
    wochen: 10,
    ungesehenAb: 2000,
    teile: [
      { richtung: "long" as const, mit: reihe(300, 0.6, 1), ohne: reihe(300, 0.6, 1.1) },
      { richtung: "short" as const, mit: reihe(100, 0.3, 1), ohne: reihe(100, 0.3, 1) },
    ],
  };
  const kopf = { regel: "Test", intervall: "15m" as const, sitzung: "ganzer Tag" };
  const flach = {
    ...lauf,
    teile: [{ richtung: "long" as const, mit: reihe(300, 0.5, 1), ohne: reihe(300, 0.5, 1) }],
  };

  it("rechnet long und short getrennt und in einem Konto ohne Überschneidung", () => {
    const long = zeileAus({ ...kopf, richtung: "long" }, [lauf]);
    expect(long.anzahl).toBe(300);
    expect(long.erwartungswertR).toBeCloseTo(0.2, 5);
    expect(long.ohneKostenR).toBeGreaterThan(long.erwartungswertR);
    const short = zeileAus({ ...kopf, richtung: "short" }, [lauf]);
    expect(short.anzahl).toBe(100);
    // In einem Konto fällt ein Short weg, der beginnt, solange ein Long noch läuft.
    const beide = zeileAus({ ...kopf, richtung: "beide" }, [lauf]);
    // Jeder Short beginnt hier zugleich mit einem Long — keiner kommt ins Konto.
    expect(beide.anzahl).toBe(300);
  });

  it("zählt Handel je Woche und die Märkte im Plus", () => {
    const long = zeileAus({ ...kopf, richtung: "long" }, [lauf, { ...lauf, symbol: "ZWEI" }]);
    expect(long.jeWoche).toBeCloseTo(600 / 20, 5);
    expect(long.maerktePositiv).toBe(2);
    expect(long.urteil).toBe("belegt");
  });

  it("setzt „streng“ erst nach der Zahl der Versuche", () => {
    const zeilen = [zeileAus({ ...kopf, richtung: "long" }, [lauf])];
    pruefeMehrfach(zeilen);
    expect(zeilen[0].streng).toBe(true);
    // Dieselbe Zeile unter 1000 knapp gescheiterten Varianten wäre nicht mehr streng.
    const viele = [
      ...zeilen,
      ...Array.from({ length: 1000 }, () => zeileAus({ ...kopf, richtung: "long" }, [flach])),
    ];
    const { versuche } = pruefeMehrfach(viele);
    expect(versuche).toBe(1001);
    expect(viele[0].urteil).toBe("belegt");
    expect(viele[0].streng).toBe(false);
  });
});
