import { describe, expect, it } from "vitest";
import type { Arbeit } from "../welle/gespraech.js";
import { kuroZeile, uhrDauer } from "./kuro-zeile.js";

const ohne = new Map<string, Arbeit>();

describe("Kuros Zeile", () => {
  it("schweigt im Stand", () => {
    expect(kuroZeile("ruhe", null, ohne, 0)).toBeNull();
    expect(kuroZeile("offline", null, ohne, 0)).toBeNull();
  });

  it("sagt, was Kuro selbst gerade tut", () => {
    expect(kuroZeile("denken", null, ohne, 5)).toEqual({ text: "Kuro denkt nach", seit: 5 });
    expect(kuroZeile("arbeiten", "Liest die Post", ohne, 7)?.text).toBe("Liest die Post");
  });

  it("nennt die Sache eines Auftrags, nie den Bediensteten", () => {
    const arbeit = new Map<string, Arbeit>([
      ["boerse", { seit: 100, stand: "prüft den Trendfolge-Pullback am DAX", auftrag: null }],
    ]);
    const z = kuroZeile("arbeiten", "Börse arbeitet", arbeit, 0);
    expect(z).toEqual({ text: "Prüft den Trendfolge-Pullback am DAX", seit: 100 });
    expect(z?.text).not.toMatch(/börse/i);
  });

  it("nimmt den Auftrag, solange der Stand nur „übernimmt“ sagt, und zählt weitere", () => {
    const arbeit = new Map<string, Arbeit>([
      ["post", { seit: 50, stand: "liest", auftrag: null }],
      ["boerse", { seit: 90, stand: "übernimmt", auftrag: "Kerzen für DAX laden\nund prüfen" }],
    ]);
    expect(kuroZeile("ruhe", null, arbeit, 0)).toEqual({
      text: "Kerzen für DAX laden · und 1 weitere",
      seit: 90,
    });
  });
});

describe("uhrDauer", () => {
  it("zeigt Minuten und Sekunden, ab einer Stunde auch Stunden", () => {
    expect(uhrDauer(134_000)).toBe("2:14");
    expect(uhrDauer(3_734_000)).toBe("1:02:14");
    expect(uhrDauer(-5)).toBe("0:00");
  });
});
