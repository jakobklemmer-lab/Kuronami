import { describe, expect, it } from "vitest";
import { type Handel, pruefeStrategie } from "./backtest.js";
import {
  BOLLINGER_MIT_SWINGSTOP,
  BOLLINGER_VIDEO,
  MACD_MIT_SMA,
  MACD_VIDEO,
  SCALPING_VIDEO,
  vereine,
} from "./kalibrierung.js";

/**
 * Geprüft wird, dass die Regeln der Videos so dastehen, wie der Bericht sie beschreibt — eine
 * Kalibrierung, deren Regel still von ihrer Beschreibung abweicht, misst etwas anderes als
 * ihr Etikett.
 */

describe("Die Regeln der drei Videos", () => {
  const alle = [
    ...MACD_VIDEO.teile,
    ...MACD_MIT_SMA,
    ...BOLLINGER_VIDEO.teile,
    ...BOLLINGER_MIT_SWINGSTOP,
    ...SCALPING_VIDEO.teile,
  ];

  it("sind alle gültige Strategien des Backtests", () => {
    for (const t of alle) expect(() => pruefeStrategie(t.strategie)).not.toThrow();
  });

  it("MACD: Kreuzung unter null, Trend über der EMA 200, Stop an ihr, Ziel 1,5 R", () => {
    const long = MACD_VIDEO.teile[0].strategie;
    expect(long.einstieg.map((b) => `${b.links.art} ${b.vergleich} ${b.rechts.art}`)).toEqual([
      "macd kreuzt_ueber macd_signal",
      "macd unter wert",
      "kurs ueber ema",
    ]);
    expect(long.stopAn).toEqual({ art: "ema", periode: 200 });
    expect(long.zielR).toBe(1.5);
    expect(long.ausstieg).toBeUndefined();
  });

  it("Bollinger: Länge 30, RSI 13 unter 25, raus an der Mittellinie", () => {
    const long = BOLLINGER_VIDEO.teile[0].strategie;
    expect(long.einstieg[0].rechts).toEqual({ art: "bollinger_unten", periode: 30, faktor: 2 });
    expect(long.einstieg[1]).toEqual({
      links: { art: "rsi", periode: 13 },
      vergleich: "unter",
      rechts: { art: "wert", wert: 25 },
    });
    expect(long.ausstieg?.[0].rechts.art).toBe("bollinger_mitte");
    expect(long.zielR).toBeUndefined();
  });

  it("Scalping: zwei Zweige je Richtung, die sich über die Lage des Pfeils ausschließen", () => {
    const [flach, tief] = SCALPING_VIDEO.teile;
    expect(flach.strategie.stopAn).toEqual({ art: "sma", periode: 50 });
    expect(tief.strategie.stopAn).toEqual({ art: "sma", periode: 100 });
    // Zweig 1: Pfeil unter der 20er, über der 50er. Zweig 2: unter der 50er, über der 100er.
    expect(flach.strategie.einstieg.slice(2).map((b) => [b.vergleich, b.rechts.periode])).toEqual([
      ["unter", 20],
      ["ueber", 50],
    ]);
    expect(tief.strategie.einstieg.slice(2).map((b) => [b.vergleich, b.rechts.periode])).toEqual([
      ["unter", 50],
      ["ueber", 100],
    ]);
  });
});

function handel(von: number, bis: number, r: number, grund: Handel["grund"] = "ziel"): Handel {
  return {
    einstiegZeit: von,
    ausstiegZeit: bis,
    einstieg: 100,
    ausstieg: 100,
    stop: 99,
    ziel: 101.5,
    grund,
    renditeProzent: r,
    r,
    kerzen: bis - von,
  };
}

describe("vereine", () => {
  it("hält höchstens eine Position — ein Handel, der in einen laufenden fällt, fällt weg", () => {
    const long = [handel(1, 5, 1.5), handel(10, 12, -1, "stop")];
    const short = [handel(3, 4, 1.5), handel(5, 8, -1, "stop")];
    const v = vereine([long, short]);
    // (3–4) beginnt, während (1–5) läuft; (5–8) beginnt genau beim Ausstieg und bleibt.
    expect(v.anzahl).toBe(3);
    expect(v.weggefallen).toBe(1);
    expect(v.erwartungswertR).toBeCloseTo(-0.5 / 3, 10);
    expect(v.zielErreicht).toBeCloseTo(1 / 3, 10);
    expect(v.profitFaktor).toBeCloseTo(0.75, 10);
  });

  it('zählt Trefferquote nach Kosten und „Ziel erreicht" getrennt', () => {
    // Ein Ziel, das nach Kosten trotzdem Verlust ist — beim Scalping mit winzigem Risiko üblich.
    const v = vereine([[handel(1, 2, -3, "ziel"), handel(3, 4, -1, "stop")]]);
    expect(v.zielErreicht).toBe(0.5);
    expect(v.trefferquote).toBe(0);
  });
});
