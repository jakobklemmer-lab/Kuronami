import { describe, expect, it } from "vitest";
import {
  CrvEingabeFehler,
  atr,
  behauptetCrv,
  crvVermerk,
  formatiereCrv,
  rechneCrv,
} from "./crv.js";
import type { MarketCandle, MarketChart } from "./integrations/markets.js";

/**
 * Die Rechnung, auf die Jakob echtes Geld setzt. Geprüft wird hier nicht, ob eine Idee gut ist —
 * das entscheidet die Gegenprüfung —, sondern ob die Zahl stimmt und ob Unsinn als Unsinn
 * zurückkommt statt als hübsches Ergebnis.
 */

function kerzen(schlusskurse: number[], spanne = 2): MarketCandle[] {
  return schlusskurse.map((close, i) => ({
    time: 1_750_000_000 + i * 86_400,
    open: close,
    high: close + spanne / 2,
    low: close - spanne / 2,
    close,
    volume: 1000,
  }));
}

describe("rechneCrv", () => {
  it("rechnet Long: Risiko, CRV je Ziel und die Trefferquote, ab der es trägt", () => {
    const e = rechneCrv({ richtung: "long", einstieg: 100, stop: 95, ziele: [110, 120] });

    expect(e.risikoJeEinheit).toBe(5);
    expect(e.stopAbstandProzent).toBeCloseTo(5);
    expect(e.ziele.map((z) => z.crv)).toEqual([2, 4]);
    expect(e.ziele[0].breakevenTrefferquote).toBeCloseTo(1 / 3);
    expect(e.ziele[1].breakevenTrefferquote).toBeCloseTo(1 / 5);
  });

  it("rechnet Short spiegelbildlich", () => {
    const e = rechneCrv({ richtung: "short", einstieg: 100, stop: 105, ziele: [90] });

    expect(e.risikoJeEinheit).toBe(5);
    expect(e.ziele[0].crv).toBe(2);
    expect(e.ziele[0].abstandProzent).toBeCloseTo(10);
  });

  it("sortiert die Ziele in der Reihenfolge, in der sie erreicht würden", () => {
    const lang = rechneCrv({ richtung: "long", einstieg: 100, stop: 95, ziele: [130, 110, 120] });
    expect(lang.ziele.map((z) => z.ziel)).toEqual([110, 120, 130]);

    const kurz = rechneCrv({ richtung: "short", einstieg: 100, stop: 105, ziele: [70, 90, 80] });
    expect(kurz.ziele.map((z) => z.ziel)).toEqual([90, 80, 70]);
  });

  it("trifft den Fall aus dem Bericht vom 20.09. — 0,86:1, nachgerechnet", () => {
    const e = rechneCrv({ richtung: "long", einstieg: 108, stop: 101, ziele: [114] });

    expect(e.ziele[0].crv).toBeCloseTo(0.857, 3);
    // Unter 1: die Trefferquote muss über die Hälfte liegen, damit das auf Dauer trägt.
    expect(e.ziele[0].breakevenTrefferquote).toBeGreaterThan(0.5);
  });

  it("weist einen Stop auf der falschen Seite ab, statt eine Zahl zu erfinden", () => {
    expect(() => rechneCrv({ richtung: "long", einstieg: 100, stop: 105, ziele: [110] })).toThrow(
      CrvEingabeFehler,
    );
    expect(() => rechneCrv({ richtung: "short", einstieg: 100, stop: 95, ziele: [90] })).toThrow(
      CrvEingabeFehler,
    );
  });

  it("weist ein Ziel auf der falschen Seite ab", () => {
    expect(() => rechneCrv({ richtung: "long", einstieg: 100, stop: 95, ziele: [99] })).toThrow(
      /kein Gewinnziel/,
    );
  });

  it("weist eine fehlende Zahl ab, statt sie als 0 zu rechnen", () => {
    expect(() => rechneCrv({ richtung: "long", einstieg: 100, stop: 0, ziele: [110] })).toThrow(
      CrvEingabeFehler,
    );
    expect(() => rechneCrv({ richtung: "long", einstieg: 100, stop: 95, ziele: [] })).toThrow(
      /Ohne Kursziel/,
    );
  });

  it("rechnet die Positionsgröße aus Kapital und Risikoanteil", () => {
    const e = rechneCrv({
      richtung: "long",
      einstieg: 100,
      stop: 95,
      ziele: [110],
      kapital: 10_000,
      risikoProzent: 1,
    });

    expect(e.position).toEqual({
      kapital: 10_000,
      risikoProzent: 1,
      risikoBetrag: 100,
      stueck: 20,
      positionswert: 2000,
      positionsanteilProzent: 20,
    });
  });

  it("rät den zweiten Wert nicht, wenn nur einer genannt ist", () => {
    expect(() =>
      rechneCrv({ richtung: "long", einstieg: 100, stop: 95, ziele: [110], kapital: 10_000 }),
    ).toThrow(/beides/);
  });
});

describe("atr", () => {
  it("mittelt die wahren Spannen über 14 Kerzen", () => {
    // Konstante Spanne von 2, keine Lücken: die wahre Spanne ist jeden Tag genau 2.
    expect(atr(kerzen(new Array(20).fill(100), 2))).toBeCloseTo(2);
  });

  it("zählt die Kurslücke zur Spanne", () => {
    const mitLuecke = kerzen(
      [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100],
      2,
    );
    // Letzte Kerze springt auf 110: High 111, Vorschluss 100 → wahre Spanne 11 statt 2.
    mitLuecke[14] = { ...mitLuecke[14], open: 110, high: 111, low: 109, close: 110 };
    const ohne = atr(kerzen(new Array(15).fill(100), 2)) ?? 0;
    expect(atr(mitLuecke) ?? 0).toBeGreaterThan(ohne);
  });

  it("gibt nichts zurück, wenn zu wenige Kerzen da sind", () => {
    expect(atr(kerzen(new Array(10).fill(100)))).toBeUndefined();
  });
});

function chart(price: number, candles: MarketCandle[]): MarketChart {
  return {
    symbol: "SOL-USD",
    name: "Solana USD",
    currency: "USD",
    exchange: "CCC",
    price,
    change: 1,
    changePct: 1,
    spark: [],
    weekHigh52: 200,
    weekLow52: 80,
    range: "6mo",
    interval: "1d",
    candles,
  };
}

describe("formatiereCrv", () => {
  const idee = rechneCrv({ richtung: "long", einstieg: 108, stop: 101, ziele: [114, 120] });

  it("schreibt das CRV je Ziel und sagt, dass gerechnet wurde", () => {
    const text = formatiereCrv(idee);

    expect(text).toContain("0,86:1");
    expect(text).toContain("1,71:1");
    expect(text).toContain("Gerechnet, nicht geschätzt");
  });

  it("nennt den Stop in Tagesspannen und warnt, wenn er darunter liegt", () => {
    // ATR 14 bei einer Tagesspanne von 10: der Stop (7 Punkte) liegt darunter.
    const text = formatiereCrv(idee, { chart: chart(108, kerzen(new Array(20).fill(108), 10)) });

    expect(text).toContain("ATR 14");
    expect(text).toContain("0,70 Tagesspannen");
    expect(text).toContain("gewöhnliches Rauschen nimmt ihn mit");
  });

  it("schweigt über das Rauschen, wenn der Stop weiter liegt als ein Tag", () => {
    const text = formatiereCrv(idee, { chart: chart(108, kerzen(new Array(20).fill(108), 2)) });

    expect(text).toContain("3,50 Tagesspannen");
    expect(text).not.toContain("gewöhnliches Rauschen");
  });

  it("sagt es, wenn der Kurs den Stop längst unterschritten hat", () => {
    const text = formatiereCrv(idee, { chart: chart(95, kerzen(new Array(20).fill(100), 2)) });

    expect(text).toContain("bereits jenseits des Stops");
  });

  it("sagt es, wenn der Kurs den Einstieg schon durchlaufen hat", () => {
    const text = formatiereCrv(idee, { chart: chart(112, kerzen(new Array(20).fill(110), 2)) });

    expect(text).toContain("Einstieg schon durchlaufen");
  });

  it("lässt die Tagesspanne weg, statt sie aus drei Kerzen zu erfinden", () => {
    const text = formatiereCrv(idee, { chart: chart(108, kerzen([108, 109, 110], 2)) });

    expect(text).toContain("zu wenige Kerzen");
    expect(text).not.toContain("ATR 14");
  });

  it("schreibt die Positionsgröße hin, wenn sie gerechnet wurde", () => {
    const mitGeld = rechneCrv({
      richtung: "long",
      einstieg: 100,
      stop: 95,
      ziele: [110],
      kapital: 10_000,
      risikoProzent: 1,
    });

    expect(formatiereCrv(mitGeld)).toContain("Positionswert");
  });
});

describe("behauptetCrv", () => {
  it("erkennt eine Kennzahl mit Zahl", () => {
    expect(behauptetCrv("CRV 0,86:1 — dünn.")).toBe(true);
    expect(behauptetCrv("Das Chance-Risiko-Verhältnis liegt bei 1,8.")).toBe(true);
    expect(behauptetCrv("Chance/Risiko 2:1")).toBe(true);
    expect(behauptetCrv("Risk-Reward von 3")).toBe(true);
  });

  it("lässt eine Einschätzung ohne Zahl in Ruhe", () => {
    expect(behauptetCrv("Die Chance-Risiko-Lage ist schwach.")).toBe(false);
    expect(behauptetCrv("Einstieg 108, Stop 101, Ziel 114.")).toBe(false);
  });
});

describe("crvVermerk", () => {
  const bericht = "Long SOL, Einstieg 108, Stop 101, Ziel 114. CRV 0,86:1.";

  it("markiert eine Zahl, die niemand gerechnet hat", () => {
    expect(crvVermerk(bericht, false)).toContain("nicht gerechnet");
  });

  it("lässt den Bericht unberührt, wenn gerechnet wurde", () => {
    expect(crvVermerk(bericht, true)).toBe(bericht);
  });

  it("lässt einen Bericht ohne Kennzahl unberührt", () => {
    const ohne = "Heute nichts: der Markt läuft seitwärts.";
    expect(crvVermerk(ohne, false)).toBe(ohne);
  });
});
