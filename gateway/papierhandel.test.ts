import { describe, expect, it } from "vitest";
import type { Strategie } from "./backtest.js";
import type { MarketCandle } from "./integrations/markets.js";
import {
  type PapierKonto,
  VORGABE_GRENZEN,
  grenzeGerissen,
  papierKennzahlen,
  verarbeite,
} from "./papierhandel.js";

/**
 * Der Papierhandel führt echtes Verhalten mit Buchgeld aus — geprüft wird hier, dass er
 * dieselben Regeln einhält wie der Backtest (Einstieg zur nächsten Eröffnung, Stop vor Ziel)
 * und dass die Bremse wirklich bremst.
 *
 * Die Kerzen sind synthetisch, weil nur dann feststeht, was herauskommen **muss**. Im Betrieb
 * holt `createPapierhandel` sie über `markets.zeitraum` aus derselben Quelle wie die
 * Kurstafel; das prüft der Lauf gegen den echten Dienst, nicht dieser Test.
 */

const TAG = 86_400;
const START = Math.floor(new Date("2026-01-01T00:00:00Z").getTime() / 1000);

function kerzen(schluss: number[], spanne = 0.5): MarketCandle[] {
  return schluss.map((close, i) => ({
    time: START + i * TAG,
    open: i === 0 ? close : schluss[i - 1],
    high: Math.max(close, i === 0 ? close : schluss[i - 1]) + spanne,
    low: Math.min(close, i === 0 ? close : schluss[i - 1]) - spanne,
    close,
  }));
}

const STRATEGIE: Strategie = {
  name: "Test",
  richtung: "long",
  einstieg: [
    { links: { art: "kurs" }, vergleich: "kreuzt_ueber", rechts: { art: "sma", periode: 3 } },
  ],
  stopProzent: 5,
  zielProzent: 5,
  gebuehrProzent: 0,
  schlupfProzent: 0,
};

function konto(ueberschreibe: Partial<PapierKonto> = {}): PapierKonto {
  return {
    strategieId: "aaaaaaaaaaaa",
    name: "Test",
    symbol: "TEST",
    intervall: "1d",
    seit: new Date(START * 1000).toISOString(),
    erwartetR: 0.4,
    gebuehrProzent: 0,
    schlupfProzent: 0,
    offen: null,
    wartetAufEinstieg: false,
    handel: [],
    standKerze: null,
    kapitalkurve: [1],
    gesperrt: false,
    zuletztGeprueft: new Date(START * 1000).toISOString(),
    ...ueberschreibe,
  };
}

describe("verarbeite", () => {
  it("fängt bei einem frischen Konto **jetzt** an und spielt keine Geschichte nach", () => {
    // Sonst stünde am ersten Tag ein Tagebuch voller Handel, die nie jemand eingegangen ist —
    // und die Kennzahlen des Betriebs wären wieder Backtest.
    const reihe = kerzen([...new Array(30).fill(100), 110, 111, 112], 0);
    const k = konto();
    verarbeite(k, STRATEGIE, reihe);

    expect(k.handel).toEqual([]);
    expect(k.standKerze).toBe(reihe[reihe.length - 2].time);
  });

  it("lässt die laufende Kerze außen vor", () => {
    const flach = kerzen(new Array(40).fill(100), 0);
    const k = konto();
    verarbeite(k, STRATEGIE, flach);
    // Die letzte gelieferte Kerze ist noch in Bewegung — der Stand steht auf der vorletzten.
    expect(k.standKerze).toBe(flach[flach.length - 2].time);
  });

  it("wartet nach einem Signal auf die nächste Eröffnung und steigt dort ein", () => {
    const reihe = kerzen([...new Array(30).fill(100), 110, 111, 112], 0);
    const k = konto({ standKerze: reihe[29].time });
    const { ereignisse } = verarbeite(k, STRATEGIE, reihe);

    expect(ereignisse.join(" ")).toMatch(/Signal/);
    expect(k.offen?.einstieg ?? 0).toBe(reihe[31].open);
  });

  it("verbucht den Stop mit −1 R, wenn keine Kosten anfallen", () => {
    const reihe = kerzen([...new Array(30).fill(100), 110, 111, 100, 90, 85], 0);
    const k = konto({ standKerze: reihe[29].time });
    verarbeite(k, STRATEGIE, reihe);

    expect(k.handel.length).toBeGreaterThan(0);
    expect(k.handel[0].grund).toBe("stop");
    expect(k.handel[0].r).toBeCloseTo(-1, 5);
  });

  it("rührt ein gesperrtes Konto nicht an", () => {
    const reihe = kerzen([...new Array(30).fill(100), 110, 111, 112], 0);
    const k = konto({ gesperrt: true, sperrgrund: "Test" });
    const { ereignisse } = verarbeite(k, STRATEGIE, reihe);

    expect(ereignisse).toEqual([]);
    expect(k.offen).toBeNull();
  });

  it("verarbeitet dieselben Kerzen nicht zweimal", () => {
    const reihe = kerzen([...new Array(30).fill(100), 110, 111, 112], 0);
    const k = konto({ standKerze: reihe[29].time });
    verarbeite(k, STRATEGIE, reihe);
    const stand = k.standKerze;
    const { ereignisse } = verarbeite(k, STRATEGIE, reihe);

    expect(ereignisse).toEqual([]);
    expect(k.standKerze).toBe(stand);
  });
});

describe("Die Bremse", () => {
  it("sperrt bei zu großem Rückschlag", () => {
    const k = konto({ kapitalkurve: [1, 1.2, 0.9] });
    expect(grenzeGerissen(k)).toMatch(/Rückschlag/);
  });

  it("sperrt bei einer Verlustserie", () => {
    const k = konto({
      handel: new Array(VORGABE_GRENZEN.maxVerlustserie).fill({ r: -1 }) as never,
    });
    expect(grenzeGerissen(k)).toMatch(/Verluste in Folge/);
  });

  it("sperrt, wenn der Betrieb deutlich hinter dem Backtest zurückbleibt", () => {
    const k = konto({
      erwartetR: 0.5,
      handel: new Array(20).fill({ r: 0.01 }) as never,
    });
    expect(grenzeGerissen(k)).toMatch(/statt der 0.50 R/);
  });

  it("schweigt, solange zu wenige Handel für einen Vergleich vorliegen", () => {
    const k = konto({ erwartetR: 0.5, handel: new Array(5).fill({ r: 0.01 }) as never });
    expect(grenzeGerissen(k)).toBeNull();
  });

  it("greift im Lauf und hält das Konto danach an", () => {
    // Eine Strategie, die verlässlich ausgestoppt wird: Kurs fällt nach jedem Einstieg.
    const auf = [100, 101, 102, 103];
    const ab = [95, 90, 85, 90];
    const reihe = kerzen(
      [...new Array(20).fill(100), ...auf, ...ab, ...auf, ...ab, ...auf, ...ab],
      0,
    );
    const k = konto({ erwartetR: 1, standKerze: reihe[19].time });
    verarbeite(k, { ...STRATEGIE, zielProzent: 50 }, reihe, {
      ...VORGABE_GRENZEN,
      maxVerlustserie: 2,
    });

    expect(k.gesperrt).toBe(true);
    expect(k.sperrgrund ?? "").toMatch(/Verluste in Folge/);
  });
});

describe("papierKennzahlen", () => {
  it("rechnet Trefferquote, Erwartungswert und Profitfaktor", () => {
    const k = konto({
      handel: [{ r: 2 }, { r: -1 }, { r: -1 }] as never,
      kapitalkurve: [1, 1.1, 1.05, 1],
    });
    const z = papierKennzahlen(k);

    expect(z.anzahl).toBe(3);
    expect(z.trefferquote).toBeCloseTo(1 / 3);
    expect(z.erwartungswertR).toBeCloseTo(0);
    expect(z.profitFaktor).toBeCloseTo(1);
  });
});
