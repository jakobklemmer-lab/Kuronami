import { describe, expect, it } from "vitest";
import { formatiereKonfidenz, konfidenz, nullEingeschlossen } from "./konfidenz.js";

/**
 * Eine R-Reihe mit vorgegebenem Muster: Gewinne zu `gewinn` R, der Rest −1 R, gleichmäßig
 * verteilt. Gleichmäßig und nicht blockweise, damit der Anteil auch bei kurzen Reihen stimmt.
 */
function rReihe(anzahl: number, trefferAnteil: number, gewinn: number): number[] {
  return Array.from({ length: anzahl }, (_, i) =>
    Math.floor((i + 1) * trefferAnteil) > Math.floor(i * trefferAnteil) ? gewinn : -1,
  );
}

describe("konfidenz", () => {
  it("schweigt unter zehn Handeln, statt Genauigkeit vorzutäuschen", () => {
    expect(konfidenz([1, -1, 1, -1, 1])).toBeUndefined();
    expect(konfidenz(rReihe(9, 0.5, 2))).toBeUndefined();
    expect(konfidenz(rReihe(10, 0.5, 2))).toBeDefined();
  });

  it("liefert bei gleichen Eingaben dasselbe Ergebnis", () => {
    const werte = rReihe(60, 0.4, 2);
    const a = konfidenz(werte);
    const b = konfidenz(werte);
    expect(a).toEqual(b);
  });

  it("schließt bei einer dünnen Stichprobe die Null ein", () => {
    // 35 Handel, 40 % Treffer zu 2 R: Erwartungswert +0,2 R — und trotzdem nicht belegt.
    const k = konfidenz(rReihe(35, 0.4, 2));
    expect(k).toBeDefined();
    if (!k) return;
    expect(nullEingeschlossen(k)).toBe(true);
    expect(k.unten).toBeLessThan(0);
    expect(k.oben).toBeGreaterThan(0);
    // Und sagt, wie viele es bräuchte — mehr als vorhanden, sonst wäre die Antwort sinnlos.
    expect(k.noetigeHandel).toBeGreaterThan(35);
  });

  it("verlässt die Null, wenn die Stichprobe groß genug ist", () => {
    const k = konfidenz(rReihe(1200, 0.4, 2));
    expect(k).toBeDefined();
    if (!k) return;
    expect(nullEingeschlossen(k)).toBe(false);
    expect(k.unten).toBeGreaterThan(0);
    expect(k.anteilNegativ).toBe(0);
  });

  it("legt das Intervall um den Erwartungswert", () => {
    const werte = rReihe(400, 0.4, 2);
    const mittel = werte.reduce((a, b) => a + b, 0) / werte.length;
    const k = konfidenz(werte);
    expect(k).toBeDefined();
    if (!k) return;
    expect(k.unten).toBeLessThan(mittel);
    expect(k.oben).toBeGreaterThan(mittel);
  });

  it("nennt bei negativem Erwartungswert keine nötige Handelszahl", () => {
    // „Wie viele Handel bis zum Beweis" ergibt bei einer verlierenden Regel keinen Sinn.
    const k = konfidenz(rReihe(200, 0.2, 2));
    expect(k?.noetigeHandel).toBeUndefined();
  });

  it("schreibt den Befund in einen Satz, den man abschreiben kann", () => {
    const duenn = konfidenz(rReihe(35, 0.4, 2));
    const dick = konfidenz(rReihe(1200, 0.4, 2));
    expect(duenn && formatiereKonfidenz(duenn, 0.2)).toContain("nicht von null zu unterscheiden");
    expect(duenn && formatiereKonfidenz(duenn, 0.2)).toMatch(/rund \d+ Handel/);
    expect(dick && formatiereKonfidenz(dick, 0.2)).toContain("Null liegt außerhalb");
  });
});
