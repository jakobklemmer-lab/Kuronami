import { describe, expect, it } from "vitest";
import { ABSTAND_SKALA, ausMatrix, dauer, fahrt, lage, spalt, transform, wischer } from "./band.js";

const B = { breite: 1512, hoehe: 899 };

describe("das Band", () => {
  it("füllt im Stand mit Raum i die Bühne", () => {
    expect(lage(0, B)).toEqual({ x: -0, y: 0, s: 1 });
    expect(lage(2, B).x).toBe(-2 * (1512 + spalt(B)));
  });

  it("legt einen zurückgezogenen Raum waagrecht mittig und etwas über die Mitte", () => {
    const l = lage(3, B, ABSTAND_SKALA);
    const links = l.x + l.s * 3 * (B.breite + spalt(B));
    expect(links + (l.s * B.breite) / 2).toBeCloseTo(B.breite / 2, 6);
    const mitteY = l.y + (l.s * B.hoehe) / 2;
    expect(mitteY).toBeLessThan(B.hoehe / 2);
    expect(l.y).toBeGreaterThan(0);
  });

  it("zieht zurück, fährt und geht hinein; aus der Fahrt heraus ohne erneutes Zurückziehen", () => {
    const voll = fahrt(lage(0, B), 1, B, 0);
    expect(voll.map((k) => k.offset)).toEqual([0, 0.3, 0.68, 1]);
    expect(voll.at(-1)?.transform).toBe(transform(lage(1, B)));
    const weiter = fahrt(lage(1, B, ABSTAND_SKALA), 3, B, 1);
    expect(weiter).toHaveLength(3);
    expect(weiter[1]?.transform).toBe(transform(lage(3, B, ABSTAND_SKALA)));
  });

  it("braucht für ferne Räume länger, aber höchstens so lang wie für drei Schritte", () => {
    expect(dauer(0, 1)).toBeLessThan(dauer(0, 3));
    expect(dauer(0, 4)).toBe(dauer(0, 3));
  });

  it("liest die Lage aus der berechneten Matrix zurück", () => {
    expect(ausMatrix("matrix(0.52, 0, 0, 0.52, -120.5, 160)")).toEqual({
      x: -120.5,
      y: 160,
      s: 0.52,
    });
    expect(ausMatrix("none")).toEqual({ x: 0, y: 0, s: 1 });
    expect(ausMatrix("matrix3d(1)")).toBeNull();
  });
});

describe("Wischen", () => {
  it("wechselt einmal je Geste, erst über der Schwelle", () => {
    const w = wischer(140, 260);
    expect(w.rad(60, 0, 0)).toBe(0);
    expect(w.rad(60, 0, 16)).toBe(0);
    expect(w.rad(60, 0, 32)).toBe(1);
    expect(w.rad(200, 0, 48)).toBe(0);
    expect(w.rad(-200, 0, 400)).toBe(-1);
  });

  it("überhört senkrechtes Rollen", () => {
    const w = wischer();
    expect(w.rad(100, 120, 0)).toBe(0);
    expect(w.rad(100, 120, 16)).toBe(0);
  });
});
