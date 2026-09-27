import { describe, expect, it } from "vitest";
import { createSprechtaste, schreibtGerade } from "./sprechtaste.js";

class Ziel {
  hoerer = new Map<string, (e: unknown) => void>();
  addEventListener(typ: string, f: (e: unknown) => void) {
    this.hoerer.set(typ, f);
  }
  removeEventListener(typ: string) {
    this.hoerer.delete(typ);
  }
  taste(typ: "keydown" | "keyup", code = "Space", repeat = false) {
    let verhindert = false;
    this.hoerer.get(typ)?.({
      code,
      repeat,
      preventDefault: () => {
        verhindert = true;
      },
    });
    return verhindert;
  }
}

// Kein Browser in der Prüfung: `document.activeElement` gibt es nicht — also schreibt niemand.
(globalThis as { document?: unknown }).document ??= { activeElement: null };

describe("Sprechtaste", () => {
  const ton = new Int16Array([1000, -2000, 3000]).buffer;

  it("lässt Ton nur durch, solange die Leertaste unten ist — sonst Stille gleicher Länge", () => {
    const ziel = new Ziel();
    const wechsel: boolean[] = [];
    const t = createSprechtaste({
      aktiv: () => true,
      ziel: ziel as never,
      onWechsel: (o) => wechsel.push(o),
    });
    expect(new Int16Array(t.filtere(ton))).toEqual(new Int16Array([0, 0, 0]));
    expect(ziel.taste("keydown")).toBe(true);
    expect(new Int16Array(t.filtere(ton))).toEqual(new Int16Array([1000, -2000, 3000]));
    // Das Loslassen wird abgefangen — sonst klickte es den fokussierten Mikrofonknopf.
    expect(ziel.taste("keyup")).toBe(true);
    expect(t.offen).toBe(false);
    expect(wechsel).toEqual([true, false]);
  });

  it("schließt, wenn das Fenster den Fokus verliert, und lässt andere Tasten in Ruhe", () => {
    const ziel = new Ziel();
    const t = createSprechtaste({ aktiv: () => true, ziel: ziel as never });
    expect(ziel.taste("keydown", "KeyA")).toBe(false);
    ziel.taste("keydown");
    ziel.hoerer.get("blur")?.({});
    expect(t.offen).toBe(false);
  });

  it("ist abgeschaltet einfach durchlässig", () => {
    const ziel = new Ziel();
    const t = createSprechtaste({ aktiv: () => false, ziel: ziel as never });
    expect(ziel.taste("keydown")).toBe(false);
    expect(t.filtere(ton)).toBe(ton);
  });

  it("gehört beim Tippen im Chat dem Text, nicht dem Sprechen", () => {
    const ziel = new Ziel();
    const t = createSprechtaste({ aktiv: () => true, ziel: ziel as never });
    const doc = globalThis as unknown as { document: { activeElement: unknown } };
    const vorher = doc.document.activeElement;
    doc.document.activeElement = { tagName: "TEXTAREA" }; // Befehlsfeld der Welle, Bubble der Präsenz
    try {
      expect(ziel.taste("keydown")).toBe(false);
      expect(t.offen).toBe(false);
    } finally {
      doc.document.activeElement = vorher;
    }
    expect(schreibtGerade({ tagName: "INPUT", type: "text" } as never)).toBe(true);
    expect(schreibtGerade({ tagName: "INPUT", type: "checkbox" } as never)).toBe(false);
    expect(schreibtGerade({ tagName: "DIV", isContentEditable: true } as never)).toBe(true);
    expect(schreibtGerade({ tagName: "BUTTON" } as never)).toBe(false);
  });
});
