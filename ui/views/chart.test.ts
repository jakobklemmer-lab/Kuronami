import { describe, expect, it } from "vitest";
import { circleCircumference, gaugeDashArray, sparklinePoints } from "./chart.js";

describe("sparklinePoints", () => {
  it("liefert fuer eine leere Reihe nichts", () => {
    expect(sparklinePoints([], 48, 16)).toBe("");
  });

  it("zeichnet eine einzelne Zahl als waagerechte Linie auf halber Hoehe", () => {
    expect(sparklinePoints([5], 48, 16)).toBe("0,8 48,8");
  });

  it("legt den kleinsten Wert unten und den groessten oben an", () => {
    const points = sparklinePoints([0, 10], 100, 20);
    expect(points).toBe("0,20 100,0");
  });

  it("verteilt die Punkte gleichmaessig ueber die Breite", () => {
    const xs = sparklinePoints([1, 2, 3], 100, 10)
      .split(" ")
      .map((point) => Number.parseFloat(point.split(",")[0] as string));
    expect(xs).toEqual([0, 50, 100]);
  });

  it("macht aus einer konstanten Reihe eine waagerechte Linie statt NaN", () => {
    const points = sparklinePoints([7, 7, 7], 60, 20);
    expect(points).toBe("0,10 30,10 60,10");
    expect(points).not.toContain("NaN");
  });

  it("bleibt fuer jede Reihe innerhalb der Zeichenflaeche", () => {
    const points = sparklinePoints([38, 34, 41, 36, 45, 42, 52, 58], 48, 16);
    for (const point of points.split(" ")) {
      const [x, y] = point.split(",").map(Number);
      expect(x as number).toBeGreaterThanOrEqual(0);
      expect(x as number).toBeLessThanOrEqual(48);
      expect(y as number).toBeGreaterThanOrEqual(0);
      expect(y as number).toBeLessThanOrEqual(16);
    }
  });
});

describe("gaugeDashArray", () => {
  it("fuellt bei 0 % nichts", () => {
    const [filled] = gaugeDashArray(0, 10).split(" ").map(Number);
    expect(filled).toBe(0);
  });

  it("fuellt bei 100 % den ganzen Umfang", () => {
    const [filled, rest] = gaugeDashArray(100, 10).split(" ").map(Number);
    expect(filled).toBeCloseTo(circleCircumference(10), 1);
    expect(rest).toBeCloseTo(0, 1);
  });

  it("fuellt bei 50 % die Haelfte", () => {
    const [filled] = gaugeDashArray(50, 10).split(" ").map(Number);
    expect(filled).toBeCloseTo(circleCircumference(10) / 2, 1);
  });

  it("begrenzt Werte ausserhalb von 0–100", () => {
    expect(gaugeDashArray(-20, 10)).toBe(gaugeDashArray(0, 10));
    expect(gaugeDashArray(140, 10)).toBe(gaugeDashArray(100, 10));
  });
});
