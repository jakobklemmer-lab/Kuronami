import { describe, expect, it } from "vitest";
import {
  bildpaar,
  deckung,
  fahrdauer,
  ladeReihenfolge,
  naechstesGeladenes,
  sanft,
  scrollFortschritt,
} from "./film-rechnung.js";

describe("bildpaar", () => {
  it("steht am Anfang auf dem ersten und am Ende auf dem letzten Bild", () => {
    expect(bildpaar(0, 121)).toEqual({ a: 0, b: 1, t: 0 });
    expect(bildpaar(1, 121)).toEqual({ a: 120, b: 120, t: 0 });
  });

  it("mischt zwischen zwei Nachbarn", () => {
    const p = bildpaar(0.5 / 120, 121);
    expect(p.a).toBe(0);
    expect(p.b).toBe(1);
    expect(p.t).toBeCloseTo(0.5);
  });

  it("verträgt Werte außerhalb des Films und einen Film aus einem Bild", () => {
    expect(bildpaar(-3, 10).a).toBe(0);
    expect(bildpaar(7, 10).a).toBe(9);
    expect(bildpaar(0.4, 1)).toEqual({ a: 0, b: 0, t: 0 });
  });
});

describe("ladeReihenfolge", () => {
  it("lädt jedes Bild genau einmal", () => {
    const reihe = ladeReihenfolge(121);
    expect(reihe).toHaveLength(121);
    expect(new Set(reihe).size).toBe(121);
  });

  it("beginnt mit der sichtbaren Stelle und legt erst ein grobes Raster über den Weg", () => {
    const reihe = ladeReihenfolge(121, 60);
    expect(reihe[0]).toBe(60);
    expect(reihe.slice(1, 5)).toEqual([0, 8, 16, 24]);
    // Das letzte Bild gehört zum groben Raster, sonst endete jede Fahrt nach draußen zu früh.
    expect(reihe.indexOf(120)).toBeLessThan(20);
  });
});

describe("naechstesGeladenes", () => {
  it("nimmt das Ziel, wenn es da ist, sonst den nächsten Nachbarn", () => {
    const geladen = [true, false, false, false, true];
    expect(naechstesGeladenes(0, geladen)).toBe(0);
    expect(naechstesGeladenes(1, geladen)).toBe(0);
    expect(naechstesGeladenes(3, geladen)).toBe(4);
  });

  it("sagt null, solange gar nichts geladen ist", () => {
    expect(naechstesGeladenes(2, [false, false, false])).toBeNull();
  });
});

describe("Fahrt", () => {
  it("fährt sanft an und kommt genau an", () => {
    expect(sanft(0)).toBe(0);
    expect(sanft(1)).toBe(1);
    expect(sanft(0.1)).toBeLessThan(0.1);
    expect(sanft(0.5)).toBeCloseTo(0.5);
  });

  it("braucht für kurze Wege weniger Zeit als für den ganzen", () => {
    expect(fahrdauer(0, 0.1)).toBeLessThan(fahrdauer(0, 1));
    expect(fahrdauer(1, 0)).toBe(fahrdauer(0, 1));
    expect(fahrdauer(0.3, 0.3)).toBe(700);
    expect(fahrdauer(0, 1)).toBe(2300);
  });
});

describe("deckung", () => {
  it("zeigt im Querformat die ganze Breite und schneidet oben und unten", () => {
    const [x, y] = deckung(2000, 800, 1280, 720);
    expect(x).toBe(1);
    expect(y).toBeCloseTo(0.711, 2);
  });

  it("zeigt auf dem hochkant gehaltenen Telefon die ganze Höhe", () => {
    const [x, y] = deckung(440, 956, 1280, 720);
    expect(y).toBe(1);
    expect(x).toBeCloseTo(0.259, 2);
  });

  it("stürzt bei einer leeren Fläche nicht ab", () => {
    expect(deckung(0, 0, 1280, 720)).toEqual([1, 1]);
  });
});

describe("scrollFortschritt", () => {
  it("geht von 0 oben bis 1 am Ende der Seite", () => {
    expect(scrollFortschritt(0, 3000, 1000)).toBe(0);
    expect(scrollFortschritt(1000, 3000, 1000)).toBe(0.5);
    expect(scrollFortschritt(2000, 3000, 1000)).toBe(1);
    expect(scrollFortschritt(2500, 3000, 1000)).toBe(1);
  });

  it("bleibt bei einer Seite ohne Scrollweg am Anfang", () => {
    expect(scrollFortschritt(0, 800, 1000)).toBe(0);
  });
});
