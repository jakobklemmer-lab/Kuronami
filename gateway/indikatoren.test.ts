import { describe, expect, it } from "vitest";
import {
  ZeitzoneFehler,
  fraktale,
  hatVolumen,
  imFenster,
  minuteAus,
  ortszeit,
  swingHoch,
  swingTief,
  vwap,
} from "./indikatoren.js";
import type { MarketCandle } from "./integrations/markets.js";

/** Eine Kerze ohne Spanne: Hoch = Tief = Schluss, damit der typische Kurs genau `kurs` ist. */
function punkt(iso: string, kurs: number, volume?: number): MarketCandle {
  return {
    time: Math.floor(new Date(iso).getTime() / 1000),
    open: kurs,
    high: kurs,
    low: kurs,
    close: kurs,
    ...(volume !== undefined ? { volume } : {}),
  };
}

describe("ortszeit", () => {
  it("rechnet in echter Ortszeit, nicht mit einem festen Stundenversatz", () => {
    // Derselbe Börsenmoment — die Eröffnung um 09:30 in New York — steht im Sommer auf 13:30
    // UTC und im Winter auf 14:30 UTC. Genau daran scheitert jede von Hand gerechnete
    // Stundenverschiebung, und zwar ein halbes Jahr lang unbemerkt.
    const sommer = ortszeit(
      Math.floor(Date.parse("2024-07-01T13:30:00Z") / 1000),
      "America/New_York",
    );
    const winter = ortszeit(
      Math.floor(Date.parse("2024-01-02T14:30:00Z") / 1000),
      "America/New_York",
    );
    expect(sommer).toEqual({ tag: "2024-07-01", minute: 570 });
    expect(winter).toEqual({ tag: "2024-01-02", minute: 570 });
  });

  it("legt den Tageswechsel in die Zone, nicht nach UTC", () => {
    // 04:00 UTC ist in New York noch der Vorabend — für einen Sitzungsanker ist das der
    // Unterschied zwischen einer und zwei Sitzungen.
    const zeit = Math.floor(Date.parse("2024-03-05T04:00:00Z") / 1000);
    expect(ortszeit(zeit, "America/New_York").tag).toBe("2024-03-04");
    expect(ortszeit(zeit, "UTC").tag).toBe("2024-03-05");
  });

  it("weist eine erfundene Zeitzone ab, statt still auf UTC zu fallen", () => {
    expect(() => ortszeit(0, "Europa/Berlin")).toThrow(ZeitzoneFehler);
  });
});

describe("minuteAus", () => {
  it("liest HH:MM und weist alles andere ab", () => {
    expect(minuteAus("09:30")).toBe(570);
    expect(minuteAus("00:00")).toBe(0);
    expect(minuteAus(" 23:59 ")).toBe(1439);
    for (const falsch of ["9:30", "24:00", "09:60", "halb zehn", ""]) {
      expect(() => minuteAus(falsch)).toThrow(ZeitzoneFehler);
    }
  });
});

describe("imFenster", () => {
  const zeit = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

  it("schließt den Beginn ein und das Ende aus", () => {
    const von = minuteAus("09:30");
    const bis = minuteAus("11:00");
    expect(imFenster(zeit("2024-07-01T13:30:00Z"), "America/New_York", von, bis)).toBe(true);
    expect(imFenster(zeit("2024-07-01T14:55:00Z"), "America/New_York", von, bis)).toBe(true);
    expect(imFenster(zeit("2024-07-01T15:00:00Z"), "America/New_York", von, bis)).toBe(false);
    expect(imFenster(zeit("2024-07-01T13:25:00Z"), "America/New_York", von, bis)).toBe(false);
  });

  it("lässt ein Fenster über Mitternacht laufen, statt es für einen Fehler zu halten", () => {
    // Die asiatische Sitzung und der Kryptohandel brauchen das; ein Ende vor dem Anfang ist
    // hier eine Angabe, keine Verwechslung.
    const von = minuteAus("22:00");
    const bis = minuteAus("02:00");
    expect(imFenster(zeit("2024-07-01T23:00:00Z"), "UTC", von, bis)).toBe(true);
    expect(imFenster(zeit("2024-07-02T01:00:00Z"), "UTC", von, bis)).toBe(true);
    expect(imFenster(zeit("2024-07-02T03:00:00Z"), "UTC", von, bis)).toBe(false);
  });
});

describe("hatVolumen", () => {
  it("erkennt eine Reihe ohne brauchbares Volumen", () => {
    expect(hatVolumen([punkt("2024-03-05T00:00:00Z", 100)])).toBe(false);
    expect(hatVolumen([punkt("2024-03-05T00:00:00Z", 100, 0)])).toBe(false);
    expect(hatVolumen([punkt("2024-03-05T00:00:00Z", 100, 5)])).toBe(true);
  });
});

describe("vwap", () => {
  it("gewichtet mit dem Volumen und setzt sich je Sitzung zurück", () => {
    const reihe = [
      punkt("2024-03-05T10:00:00Z", 100, 1),
      punkt("2024-03-05T11:00:00Z", 102, 3),
      // Neuer Tag: der Anker fällt zurück, der erste Wert ist der Kurs selbst.
      punkt("2024-03-06T10:00:00Z", 200, 5),
    ];
    const { vwap: linie } = vwap(reihe, "UTC");
    expect(linie[0]).toBeCloseTo(100, 10);
    // (100·1 + 102·3) / 4 = 101,5 — nicht 101, das wäre der ungewichtete Mittelwert.
    expect(linie[1]).toBeCloseTo(101.5, 10);
    expect(linie[2]).toBeCloseTo(200, 10);
  });

  it("ankert an der Zone, nicht am UTC-Tag", () => {
    // Beide Kerzen liegen in New York am selben Abend; nach UTC wären es zwei Tage.
    const reihe = [punkt("2024-03-05T23:00:00Z", 100, 1), punkt("2024-03-06T00:00:00Z", 200, 1)];
    expect(vwap(reihe, "America/New_York").vwap[1]).toBeCloseTo(150, 10);
    // Nach UTC fällt dazwischen ein Tageswechsel — der zweite Wert steht dann allein.
    expect(vwap(reihe, "UTC").vwap[1]).toBeCloseTo(200, 10);
  });

  it("gibt ohne Volumen eine Reihe aus undefined zurück, statt eine Linie zu erfinden", () => {
    const reihe = [punkt("2024-03-05T10:00:00Z", 100), punkt("2024-03-05T11:00:00Z", 102)];
    const ergebnis = vwap(reihe, "UTC");
    expect(ergebnis.vwap).toEqual([undefined, undefined]);
    expect(ergebnis.oben).toEqual([undefined, undefined]);
  });

  it("legt die Bänder auf die volumengewichtete Streuung", () => {
    // Zwei gleich gewichtete Kurse 100 und 102: Mittel 101, Streuung 1.
    const reihe = [punkt("2024-03-05T10:00:00Z", 100, 1), punkt("2024-03-05T11:00:00Z", 102, 1)];
    const ergebnis = vwap(reihe, "UTC", 1);
    expect(ergebnis.vwap[1]).toBeCloseTo(101, 10);
    expect(ergebnis.oben[1]).toBeCloseTo(102, 10);
    expect(ergebnis.unten[1]).toBeCloseTo(100, 10);
    // Bei nur einem Kurs gibt es keine Streuung — die Bänder liegen auf der Linie.
    expect(ergebnis.oben[0]).toBeCloseTo(100, 10);
    expect(ergebnis.unten[0]).toBeCloseTo(100, 10);
  });
});

/** Kerzen aus Tief- und Hochwerten; Eröffnung und Schluss liegen in der Mitte. */
function spannen(werte: ReadonlyArray<[number, number]>): MarketCandle[] {
  return werte.map(([tief, hoch], i) => ({
    time: 1_700_000_000 + i * 60,
    open: (tief + hoch) / 2,
    high: hoch,
    low: tief,
    close: (tief + hoch) / 2,
  }));
}

describe("swingTief / swingHoch", () => {
  it("schließt die aktuelle Kerze ein — sonst läge ein Stop nach neuem Tief über dem Kurs", () => {
    const k = spannen([
      [10, 12],
      [9, 11],
      [11, 13],
      [7, 10],
    ]);
    expect(swingTief(k, 3)).toEqual([undefined, undefined, 9, 7]);
    expect(swingHoch(k, 2)).toEqual([undefined, 12, 13, 13]);
  });
});

describe("fraktale", () => {
  // Ein Tief bei Index 2, umgeben von je zwei höheren Tiefs.
  const k = spannen([
    [10, 14],
    [9, 13],
    [7, 12],
    [8, 13],
    [9, 15],
    [9.5, 14],
  ]);

  it("setzt das Fraktal erst auf die Kerze, auf der es feststeht (n Kerzen später)", () => {
    const { tief } = fraktale(k, 2);
    // Gezeichnet würde der Pfeil bei TradingView unter Index 2 — bekannt ist er erst bei 4.
    expect(tief[2]).toBeUndefined();
    expect(tief[3]).toBeUndefined();
    expect(tief[4]).toBe(7);
    expect(tief.filter((w) => w !== undefined)).toHaveLength(1);
  });

  it("schaut nie in die Zukunft: ohne die zweite Kerze danach gibt es kein Fraktal", () => {
    const { tief } = fraktale(k.slice(0, 4), 2);
    expect(tief.every((w) => w === undefined)).toBe(true);
  });

  it("verlangt rechts strikt höhere Tiefs, lässt links gleich tiefe zu wie TradingView", () => {
    const zweiGleiche = spannen([
      [10, 14],
      [9, 13],
      [7, 12],
      [7, 13],
      [9, 15],
      [9, 15],
    ]);
    const { tief } = fraktale(zweiGleiche, 2);
    // Index 2 hat rechts ein gleich tiefes Tief — kein Fraktal, bei Index 4 steht nichts.
    expect(tief[4]).toBeUndefined();
    // Index 3 schon: links ein gleich tiefes (Index 2), dahinter zwei höhere. Fest bei 5.
    expect(tief[5]).toBe(7);
  });

  it("erkennt ein Hoch gespiegelt", () => {
    const { hoch } = fraktale(k, 2);
    // Das Hoch bei Index 4 (15) hat rechts nur eine Kerze — noch kein Fraktal.
    expect(hoch.every((w) => w === undefined)).toBe(true);
    const mitHoch = spannen([
      [5, 10],
      [5, 11],
      [5, 15],
      [5, 12],
      [5, 11],
    ]);
    expect(fraktale(mitHoch, 2).hoch[4]).toBe(15);
  });
});
