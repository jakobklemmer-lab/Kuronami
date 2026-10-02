import { describe, expect, it } from "vitest";
import { orbVor, scheibeIm } from "./fensterbild.js";

describe("fensterbild", () => {
  it("findet die rechte Scheibe in einem breiten Ausschnitt", () => {
    // 1000 × 500 ist breiter als das Bild: es füllt die Breite, oben und unten wird beschnitten.
    const s = scheibeIm({ links: 0, oben: 0, breite: 1000, hoehe: 500 });
    expect(s.links).toBeCloseTo(365, 0);
    expect(s.breite).toBeCloseTo(461, 0);
    expect(s.oben).toBeCloseTo(39.9, 0);
    expect(s.hoehe).toBeCloseTo(333.2, 0);
  });

  it("verschiebt mit dem Kasten und beschneidet seitlich, wenn er schmal ist", () => {
    const s = scheibeIm({ links: 100, oben: 50, breite: 500, hoehe: 500 });
    // Maßstab nach der Höhe: das Bild ist 895,7 breit, links fallen 55 % des Überstands weg.
    expect(s.links).toBeCloseTo(100 + (500 - 895.7) * 0.55 + 0.365 * 895.7, 0);
    expect(s.oben).toBeCloseTo(50 + 0.109 * 500, 0);
  });

  it("stellt den Kern auf den Horizont, er füllt drei Viertel der Scheibe", () => {
    const o = orbVor({ links: 0, oben: 0, breite: 1000, hoehe: 500 });
    expect(o.x).toBeCloseTo(575, 0);
    expect(o.y).toBeCloseTo(244.2, 0);
    expect(o.breite * 0.46).toBeCloseTo(0.75 * 333.2, 0);
    // Der Kern steht bei 44 % der Höhe des Kastens.
    expect(o.oben).toBeCloseTo(o.y - 0.44 * o.breite, 3);
    expect(o.links).toBeCloseTo(o.x - o.breite / 2, 3);
  });

  it("hält die Unterschrift über dem Gruß und den Kasten vor dem Gespräch", () => {
    const kasten = { links: 0, oben: 0, breite: 1000, hoehe: 500 };
    const o = orbVor(kasten, { rechts: 1000, unten: 400 });
    expect(o.y + 1.2 * 0.23 * o.breite + 64).toBeCloseTo(400, 0);
    expect(orbVor(kasten, { rechts: 800, unten: 2000 }).breite).toBeCloseTo(2 * (800 - 575), 0);
  });

  it("bleibt im sichtbaren Ausschnitt, wenn die Scheibe höher ist als er", () => {
    const o = orbVor({ links: 0, oben: 0, breite: 3000, hoehe: 600 }, { rechts: 9e3, unten: 9e3 });
    expect(o.y).toBeGreaterThan(0.3 * 600 - 1);
    expect(o.y).toBeLessThan(0.7 * 600 + 1);
    expect(o.breite * 0.46).toBeCloseTo(400, 0);
  });
});
