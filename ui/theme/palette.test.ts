import { describe, expect, it } from "vitest";
import {
  type RGB,
  blend,
  clampSaturation,
  contrastRatio,
  deriveDominantColors,
  derivePalette,
  ensureContrast,
  hslToRgb,
  relativeLuminance,
  rgbToHsl,
  toHex,
  toRgba,
} from "./palette.js";

const WHITE: RGB = { r: 255, g: 255, b: 255 };
const BLACK: RGB = { r: 0, g: 0, b: 0 };
const MID_GRAY: RGB = { r: 128, g: 128, b: 128 };

describe("rgbToHsl/hslToRgb", () => {
  it("rundet Schwarz, Weiss und reine Farbtoene korrekt", () => {
    expect(rgbToHsl(BLACK)).toEqual({ h: 0, s: 0, l: 0 });
    expect(rgbToHsl(WHITE)).toEqual({ h: 0, s: 0, l: 100 });
    const red = rgbToHsl({ r: 255, g: 0, b: 0 });
    expect(red.h).toBeCloseTo(0, 0);
    expect(red.s).toBeCloseTo(100, 0);
    expect(red.l).toBeCloseTo(50, 0);
  });

  it("ist annaehernd die Umkehrung von hslToRgb", () => {
    const original: RGB = { r: 97, g: 150, b: 205 };
    const roundTripped = hslToRgb(rgbToHsl(original));
    expect(roundTripped.r).toBeCloseTo(original.r, -1);
    expect(roundTripped.g).toBeCloseTo(original.g, -1);
    expect(roundTripped.b).toBeCloseTo(original.b, -1);
  });
});

describe("clampSaturation", () => {
  it("laesst eine Saettigung unterhalb der Grenze unveraendert", () => {
    expect(clampSaturation({ h: 200, s: 20, l: 50 }, 45)).toEqual({ h: 200, s: 20, l: 50 });
  });

  it("deckelt eine zu hohe Saettigung auf die Grenze — nie Neonton", () => {
    expect(clampSaturation({ h: 200, s: 100, l: 50 }, 45)).toEqual({ h: 200, s: 45, l: 50 });
  });
});

describe("relativeLuminance/contrastRatio", () => {
  it("Schwarz gegen Weiss ergibt das maximale Kontrastverhaeltnis 21:1", () => {
    expect(relativeLuminance(BLACK)).toBe(0);
    expect(relativeLuminance(WHITE)).toBeCloseTo(1, 5);
    expect(contrastRatio(BLACK, WHITE)).toBeCloseTo(21, 1);
  });

  it("ist symmetrisch in der Reihenfolge der Argumente", () => {
    expect(contrastRatio(BLACK, MID_GRAY)).toBeCloseTo(contrastRatio(MID_GRAY, BLACK), 10);
  });
});

describe("blend", () => {
  it("mischt vollstaendig deckend als reines top", () => {
    expect(blend(WHITE, 1, BLACK)).toEqual({ r: 255, g: 255, b: 255 });
  });

  it("mischt vollstaendig durchsichtig als reines bottom", () => {
    expect(blend(WHITE, 0, BLACK)).toEqual({ r: 0, g: 0, b: 0 });
  });
});

describe("ensureContrast", () => {
  it("laesst eine bereits ausreichend kontrastierende Farbe unveraendert", () => {
    expect(ensureContrast(WHITE, BLACK, 4.5)).toEqual(WHITE);
  });

  it("hellt eine Vordergrundfarbe aussichtsreich auf, wenn der Hintergrund dunkel ist", () => {
    const fg = ensureContrast({ r: 60, g: 60, b: 60 }, BLACK, 4.5);
    expect(contrastRatio(fg, BLACK)).toBeGreaterThanOrEqual(4.5);
  });

  it("dunkelt eine Vordergrundfarbe ab, wenn der Hintergrund hell ist", () => {
    const fg = ensureContrast({ r: 200, g: 200, b: 200 }, WHITE, 4.5);
    expect(contrastRatio(fg, WHITE)).toBeGreaterThanOrEqual(4.5);
    expect(relativeLuminance(fg)).toBeLessThan(relativeLuminance({ r: 200, g: 200, b: 200 }));
  });

  it("erreicht 4,5:1 auch gegen einen mittelgrauen Hintergrund (Grenzfall)", () => {
    const fg = ensureContrast(MID_GRAY, MID_GRAY, 4.5);
    expect(contrastRatio(fg, MID_GRAY)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("deriveDominantColors", () => {
  it("faellt bei leerer Liste auf einen definierten Vorgabewert zurueck", () => {
    const result = deriveDominantColors([]);
    expect(result.dominant).toBeDefined();
    expect(result.muted).toBeDefined();
  });

  it("erkennt den ueberwiegenden Farbton einer klar dominierten Pixelmenge", () => {
    const blue: RGB = { r: 30, g: 80, b: 200 };
    const pixels: RGB[] = Array.from({ length: 100 }, () => blue);
    const { dominant } = deriveDominantColors(pixels);
    const hsl = rgbToHsl(dominant);
    expect(hsl.h).toBeGreaterThan(180);
    expect(hsl.h).toBeLessThan(260);
  });

  it("findet den hellsten Pixel", () => {
    const dark: RGB = { r: 10, g: 10, b: 10 };
    const bright: RGB = { r: 250, g: 250, b: 250 };
    const { brightest } = deriveDominantColors([dark, dark, bright, dark]);
    expect(brightest).toEqual(bright);
  });

  it("berechnet muted als schlichten Durchschnitt", () => {
    const { muted } = deriveDominantColors([
      { r: 0, g: 0, b: 0 },
      { r: 100, g: 100, b: 100 },
    ]);
    expect(muted).toEqual({ r: 50, g: 50, b: 50 });
  });
});

describe("derivePalette", () => {
  it("liefert ein Token-Set mit allen erwarteten Schluesseln", () => {
    const tokens = derivePalette([{ r: 90, g: 140, b: 190 }]);
    for (const key of ["--bg", "--bg-deep", "--fg", "--accent", "--border"]) {
      expect(tokens).toHaveProperty(key);
    }
  });

  it("deckelt die Saettigung des Akzents auf die uebergebene Grenze", () => {
    const saturated: RGB = { r: 0, g: 255, b: 255 };
    const tokens = derivePalette(
      Array.from({ length: 20 }, () => saturated),
      { maxSaturation: 30 },
    );
    const accentHex = tokens["--accent"] as string;
    const accentRgb = {
      r: Number.parseInt(accentHex.slice(1, 3), 16),
      g: Number.parseInt(accentHex.slice(3, 5), 16),
      b: Number.parseInt(accentHex.slice(5, 7), 16),
    };
    expect(rgbToHsl(accentRgb).s).toBeLessThanOrEqual(30 + 0.5);
  });

  it("garantiert einen Textkontrast von mindestens 4,5:1 selbst gegen ein sehr helles Bild", () => {
    const brightImage: RGB[] = Array.from({ length: 50 }, () => ({ r: 255, g: 255, b: 255 }));
    const tokens = derivePalette(brightImage);
    const fgHex = tokens["--fg"] as string;
    const fgRgb: RGB = {
      r: Number.parseInt(fgHex.slice(1, 3), 16),
      g: Number.parseInt(fgHex.slice(3, 5), 16),
      b: Number.parseInt(fgHex.slice(5, 7), 16),
    };
    // Dieselbe Rechnung wie in derivePalette: der Massstab ist die Flaeche nach dem Scrim.
    const scrim = { r: 3, g: 4, b: 9 };
    const effectiveBg = blend(scrim, 0.72, { r: 255, g: 255, b: 255 });
    expect(contrastRatio(fgRgb, effectiveBg)).toBeGreaterThanOrEqual(4.5);
  });

  it("bleibt dunkel (niedrige Helligkeit von --bg), auch bei einem hellen Quellbild", () => {
    const brightImage: RGB[] = Array.from({ length: 50 }, () => ({ r: 255, g: 255, b: 255 }));
    const tokens = derivePalette(brightImage);
    const bgHex = tokens["--bg"] as string;
    const bgRgb: RGB = {
      r: Number.parseInt(bgHex.slice(1, 3), 16),
      g: Number.parseInt(bgHex.slice(3, 5), 16),
      b: Number.parseInt(bgHex.slice(5, 7), 16),
    };
    expect(rgbToHsl(bgRgb).l).toBeLessThan(20);
  });
});

describe("toHex/toRgba", () => {
  it("formatiert als sechsstelliges Hex mit Fuehrungsraute", () => {
    expect(toHex({ r: 0, g: 0, b: 0 })).toBe("#000000");
    expect(toHex({ r: 255, g: 255, b: 255 })).toBe("#ffffff");
  });

  it("formatiert rgba() mit dem uebergebenen Alpha-Wert", () => {
    expect(toRgba({ r: 1, g: 2, b: 3 }, 0.5)).toBe("rgba(1, 2, 3, 0.5)");
  });
});
