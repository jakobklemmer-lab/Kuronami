import { describe, expect, it } from "vitest";
import { OFFENE_HOECHSTENS, liesOffene, oeffneChart, schliesseChart } from "./offene-charts.js";

describe("offene Charts", () => {
  it("hängt einen neuen Wert hinten an und lässt einen offenen, wo er ist", () => {
    expect(oeffneChart(["^GDAXI"], "BTC-USD")).toEqual(["^GDAXI", "BTC-USD"]);
    expect(oeffneChart(["^GDAXI", "BTC-USD"], "^GDAXI")).toEqual(["^GDAXI", "BTC-USD"]);
  });

  it("lässt bei zu vielen den ältesten fallen, nie den neuen", () => {
    const voll = Array.from({ length: OFFENE_HOECHSTENS }, (_, i) => `W${i}`);
    const neu = oeffneChart(voll, "NEU");
    expect(neu).toHaveLength(OFFENE_HOECHSTENS);
    expect(neu[0]).toBe("W1");
    expect(neu.at(-1)).toBe("NEU");
  });

  it("rückt beim Schließen des gezeigten den rechten Nachbarn nach, am Ende den linken", () => {
    expect(schliesseChart(["A", "B", "C"], "B", "B")).toEqual({
      offen: ["A", "C"],
      naechster: "C",
    });
    expect(schliesseChart(["A", "B", "C"], "C", "C")).toEqual({
      offen: ["A", "B"],
      naechster: "B",
    });
    expect(schliesseChart(["A", "B", "C"], "A", "C")).toEqual({
      offen: ["B", "C"],
      naechster: null,
    });
  });

  it("behält den letzten Reiter", () => {
    expect(schliesseChart(["A"], "A", "A")).toEqual({ offen: ["A"], naechster: null });
  });

  it("liest nur Kürzel, ohne Doppelte, und verträgt Kaputtes", () => {
    expect(liesOffene('["^gdaxi", "^GDAXI", 3, "", "btc-usd"]')).toEqual(["^GDAXI", "BTC-USD"]);
    expect(liesOffene("{kaputt")).toEqual([]);
    expect(liesOffene(null)).toEqual([]);
    expect(liesOffene('{"a":1}')).toEqual([]);
  });
});
