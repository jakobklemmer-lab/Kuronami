import { describe, expect, it } from "vitest";
import { type Strategie, StrategieFehler, backtest, kerzenProJahr } from "./backtest.js";
import { atrReihe, ema, rollendesHoch, rollendesTief, rsi, sma, stdabw } from "./indikatoren.js";
import type { MarketCandle } from "./integrations/markets.js";

/**
 * Geprüft wird hier vor allem das, was einen Backtest zur Selbsttäuschung macht: der Blick in
 * die Zukunft, der günstige Zufall innerhalb einer Kerze und die vergessenen Kosten. Die
 * Kerzen sind deshalb von Hand gebaut, nicht aus dem Netz geholt — nur dann steht das
 * erwartete Ergebnis vorher fest.
 */

/** Kerzen aus Schlusskursen; Hoch/Tief eng anliegend, wenn nichts anderes gesagt ist. */
function kerzen(schluss: number[], spanne = 0.5): MarketCandle[] {
  return schluss.map((close, i) => ({
    time: 1_700_000_000 + i * 86_400,
    open: i === 0 ? close : schluss[i - 1],
    high: Math.max(close, i === 0 ? close : schluss[i - 1]) + spanne,
    low: Math.min(close, i === 0 ? close : schluss[i - 1]) - spanne,
    close,
    volume: 1000,
  }));
}

describe("Indikatoren", () => {
  it("sma beginnt erst, wenn die Periode voll ist", () => {
    const werte = [1, 2, 3, 4, 5];
    expect(sma(werte, 3)).toEqual([undefined, undefined, 2, 3, 4]);
  });

  it("ema startet auf dem sma der ersten Periode", () => {
    const reihe = ema([1, 2, 3, 4, 5], 3);
    expect(reihe[0]).toBeUndefined();
    expect(reihe[1]).toBeUndefined();
    expect(reihe[2]).toBe(2);
    expect(reihe[3]).toBeCloseTo(3);
  });

  it("rsi ist 100, wenn es nur aufwärts ging", () => {
    const reihe = rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], 14);
    expect(reihe[14]).toBe(100);
  });

  it("rollendes Hoch lässt die aktuelle Kerze aus", () => {
    // Die letzte Kerze ist die höchste; das rollende Hoch darf sie nicht kennen.
    const k = kerzen([10, 10, 10, 20], 0);
    expect(rollendesHoch(k, 3)[3]).toBe(10);
    expect(rollendesTief(k, 3)[3]).toBe(10);
  });

  it("atr mittelt die wahren Spannen und schweigt bei zu wenigen Kerzen", () => {
    expect(atrReihe(kerzen(new Array(20).fill(100), 1))[19]).toBeCloseTo(2);
    expect(atrReihe(kerzen([100, 101, 102]), 14)[2]).toBeUndefined();
  });

  it("stdabw einer flachen Reihe ist null", () => {
    expect(stdabw([5, 5, 5, 5], 4)[3]).toBe(0);
  });
});

const KREUZT_UEBER_SMA: Strategie = {
  name: "Test: Kurs kreuzt über SMA3",
  richtung: "long",
  einstieg: [
    { links: { art: "kurs" }, vergleich: "kreuzt_ueber", rechts: { art: "sma", periode: 3 } },
  ],
  stopProzent: 5,
  zielProzent: 5,
  gebuehrProzent: 0,
  schlupfProzent: 0,
};

describe("backtest — die Regeln des Hauses", () => {
  it("kauft zur Eröffnung der Kerze NACH dem Signal, nie zum Signalkurs", () => {
    // Flach bei 100, dann ein Sprung auf 110: das Signal fällt auf die Sprungkerze, gekauft
    // wird zur Eröffnung der nächsten — und die ist hier 110, nicht 100.
    const reihe = [...new Array(40).fill(100), 110, ...new Array(20).fill(110)];
    const ergebnis = backtest(KREUZT_UEBER_SMA, kerzen(reihe, 0), { intervall: "1d" });

    expect(ergebnis.handel.length).toBeGreaterThan(0);
    expect(ergebnis.handel[0].einstieg).toBe(110);
  });

  it("zählt den Stop, wenn Stop und Ziel in derselben Kerze liegen", () => {
    const reihe = kerzen([...new Array(40).fill(100), 110, ...new Array(20).fill(110)], 0);
    // Die Kerze nach dem Einstieg reicht in beide Richtungen weit über Stop und Ziel hinaus.
    const nachEinstieg = 42;
    reihe[nachEinstieg] = { ...reihe[nachEinstieg], high: 200, low: 1 };
    const ergebnis = backtest(KREUZT_UEBER_SMA, reihe, { intervall: "1d" });

    expect(ergebnis.handel[0].grund).toBe("stop");
    expect(ergebnis.handel[0].r).toBeLessThan(0);
  });

  it("rechnet Gebühren und Schlupf mit — sie machen aus einem Gewinn einen Verlust", () => {
    const reihe = kerzen([...new Array(40).fill(100), 110, ...new Array(20).fill(110)], 0);
    const ohne = backtest(KREUZT_UEBER_SMA, reihe, { intervall: "1d" });
    const mit = backtest({ ...KREUZT_UEBER_SMA, gebuehrProzent: 1, schlupfProzent: 0.5 }, reihe, {
      intervall: "1d",
    });

    expect(mit.handel[0].renditeProzent).toBeLessThan(ohne.handel[0].renditeProzent);
  });

  it("stellt am Ende des Zeitraums glatt, statt den Handel verschwinden zu lassen", () => {
    const reihe = kerzen([...new Array(55).fill(100), 101, 102, 103], 0);
    const ergebnis = backtest({ ...KREUZT_UEBER_SMA, zielProzent: 50, stopProzent: 50 }, reihe, {
      intervall: "1d",
    });

    expect(ergebnis.handel[ergebnis.handel.length - 1].grund).toBe("ende");
  });

  it("hält höchstens eine Position gleichzeitig", () => {
    const reihe = kerzen(
      [...new Array(30).fill(100), ...Array.from({ length: 40 }, (_, i) => 100 + i)],
      0,
    );
    const ergebnis = backtest(KREUZT_UEBER_SMA, reihe, { intervall: "1d" });
    for (let i = 1; i < ergebnis.handel.length; i += 1) {
      expect(ergebnis.handel[i].einstiegZeit).toBeGreaterThanOrEqual(
        ergebnis.handel[i - 1].ausstiegZeit,
      );
    }
  });

  it("weist eine Strategie ohne Verlustbegrenzung ab", () => {
    expect(() =>
      backtest(
        { name: "x", richtung: "long", einstieg: KREUZT_UEBER_SMA.einstieg },
        kerzen(new Array(60).fill(100)),
      ),
    ).toThrow(/Verlustbegrenzung/);
  });

  it("weist eine Strategie ohne Einstiegsbedingung ab", () => {
    expect(() =>
      backtest(
        { name: "x", richtung: "long", einstieg: [], stopProzent: 2 },
        kerzen(new Array(60).fill(100)),
      ),
    ).toThrow(StrategieFehler);
  });

  it("weist zwei Stop-Angaben ab, statt sich eine auszusuchen", () => {
    expect(() =>
      backtest(
        { ...KREUZT_UEBER_SMA, stopAtr: 2, stopProzent: 3 },
        kerzen(new Array(60).fill(100)),
      ),
    ).toThrow(/nicht beides/);
  });

  it("weist einen zu kurzen Zeitraum ab", () => {
    expect(() => backtest(KREUZT_UEBER_SMA, kerzen(new Array(20).fill(100)))).toThrow(/Zufall/);
  });
});

describe("backtest — die Vorbehalte", () => {
  const steigend = kerzen(
    Array.from({ length: 300 }, (_, i) => 100 + i * 0.3 + Math.sin(i / 4) * 2),
    0.4,
  );

  it("meldet zu wenige Handel", () => {
    const ergebnis = backtest(KREUZT_UEBER_SMA, kerzen(new Array(80).fill(100), 0));
    expect(ergebnis.warnungen.join(" ")).toMatch(/Zufall|Kein einziger Handel/);
  });

  it("teilt in geschraubt und ungesehen und meldet beide getrennt", () => {
    const ergebnis = backtest(KREUZT_UEBER_SMA, steigend, { intervall: "1d" });
    expect(ergebnis.inSample.kennzahlen.anzahl + ergebnis.outOfSample.kennzahlen.anzahl).toBe(
      ergebnis.gesamt.anzahl,
    );
    expect(new Date(ergebnis.inSample.bis).getTime()).toBeLessThanOrEqual(
      new Date(ergebnis.outOfSample.bis).getTime(),
    );
  });

  it("warnt bei hoher Trefferquote mit winzigem Erwartungswert", () => {
    // Enges Ziel, weiter Stop: die Trefferquote wird schön, der Erwartungswert nicht.
    const ergebnis = backtest(
      { ...KREUZT_UEBER_SMA, zielProzent: 0.3, stopProzent: 15 },
      steigend,
      { intervall: "1d" },
    );
    if (ergebnis.gesamt.trefferquote >= 0.7) {
      expect(ergebnis.warnungen.join(" ")).toMatch(/kippt|Ausreißer/);
    }
    expect(ergebnis.gesamt.anzahl).toBeGreaterThan(0);
  });

  it("nennt Sharpe, Rückschlag und Profitfaktor", () => {
    const ergebnis = backtest(KREUZT_UEBER_SMA, steigend, { intervall: "1d" });
    expect(Number.isFinite(ergebnis.gesamt.sharpe)).toBe(true);
    expect(ergebnis.gesamt.maxDrawdownProzent).toBeGreaterThanOrEqual(0);
    expect(ergebnis.gesamt.profitFaktor).toBeGreaterThanOrEqual(0);
  });
});

describe("kerzenProJahr", () => {
  it("nimmt Handelstage, nicht Kalendertage", () => {
    expect(kerzenProJahr("1d")).toBe(252);
    expect(kerzenProJahr("1wk")).toBe(52);
    expect(kerzenProJahr("1h")).toBeGreaterThan(252);
  });
});
