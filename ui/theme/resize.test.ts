import { describe, expect, it } from "vitest";
import { computeFitDimensions } from "./resize.js";

describe("computeFitDimensions", () => {
  it("laesst ein Bild unter dem Deckel unveraendert", () => {
    expect(computeFitDimensions(800, 600, 1600)).toEqual({ width: 800, height: 600 });
  });

  it("skaliert ein zu breites Bild proportional herunter", () => {
    expect(computeFitDimensions(4000, 2000, 1000)).toEqual({ width: 1000, height: 500 });
  });

  it("skaliert ein zu hohes Bild proportional herunter", () => {
    expect(computeFitDimensions(2000, 4000, 1000)).toEqual({ width: 500, height: 1000 });
  });

  it("skaliert nie hoch", () => {
    expect(computeFitDimensions(100, 50, 1000)).toEqual({ width: 100, height: 50 });
  });

  it("behandelt ein Quadrat an der Grenze exakt", () => {
    expect(computeFitDimensions(1000, 1000, 1000)).toEqual({ width: 1000, height: 1000 });
  });

  it("liefert 0x0 fuer ungueltige Eingaben, statt zu werfen", () => {
    expect(computeFitDimensions(0, 500, 1000)).toEqual({ width: 0, height: 0 });
    expect(computeFitDimensions(500, -1, 1000)).toEqual({ width: 0, height: 0 });
  });
});
