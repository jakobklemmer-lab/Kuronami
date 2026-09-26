import { describe, expect, it } from "vitest";
import {
  CARD_BASE_ALPHA,
  CARD_MAX_ALPHA,
  type RGB,
  blend,
  clampSaturation,
  contrastRatio,
  deriveDominantColors,
  derivePalette,
  ensureContrast,
  hslToRgb,
  minimalOverlayAlpha,
  relativeLuminance,
  rgbToHsl,
  toHex,
  toRgba,
} from "./palette.js";

const WHITE: RGB = { r: 255, g: 255, b: 255 };
const BLACK: RGB = { r: 0, g: 0, b: 0 };
const MID_GRAY: RGB = { r: 128, g: 128, b: 128 };

function parseHexToken(token: string): RGB {
  return {
    r: Number.parseInt(token.slice(1, 3), 16),
    g: Number.parseInt(token.slice(3, 5), 16),
    b: Number.parseInt(token.slice(5, 7), 16),
  };
}

function parseRgbaToken(token: string): { color: RGB; alpha: number } {
  const parts = token
    .slice(token.indexOf("(") + 1, token.lastIndexOf(")"))
    .split(",")
    .map((part) => Number.parseFloat(part.trim()));
  return {
    color: { r: parts[0] as number, g: parts[1] as number, b: parts[2] as number },
    alpha: parts[3] as number,
  };
}

/** Eine sehr dunkle, deckende Ebene — der typische Fall für `minimalOverlayAlpha`. */
const DUNKLE_EBENE: RGB = { r: 3, g: 5, b: 11 };

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
    const fgRgb = parseHexToken(tokens["--fg"] as string);
    const { color: panel, alpha: panelAlpha } = parseRgbaToken(tokens["--bg-panel"] as string);
    // Dieselbe Rechnung wie in derivePalette: der Massstab ist die Kartenflaeche, wie sie ueber
    // dem hellsten Bildausschnitt tatsaechlich entsteht.
    const effectiveBg = blend(panel, panelAlpha, { r: 255, g: 255, b: 255 });
    expect(contrastRatio(fgRgb, effectiveBg)).toBeGreaterThanOrEqual(4.5);
  });

  it("laesst ein dunkles Bild sichtbar — die Karte bleibt bei der Grundvorgabe", () => {
    // Ein Bild wie der Raum der Präsenz: durchgehend dunkel, nur ein schwacher Lichtschein.
    const darkImage: RGB[] = [
      ...Array.from({ length: 60 }, () => ({ r: 12, g: 16, b: 28 })),
      { r: 96, g: 108, b: 132 },
    ];
    const tokens = derivePalette(darkImage);
    const { alpha: panelAlpha } = parseRgbaToken(tokens["--bg-panel"] as string);
    expect(panelAlpha).toBeCloseTo(CARD_BASE_ALPHA, 5);
  });

  it("hebt die Kartendeckkraft nur bei einem hellen Bild an", () => {
    const dark = derivePalette(Array.from({ length: 20 }, () => ({ r: 10, g: 12, b: 20 })));
    const bright = derivePalette(Array.from({ length: 20 }, () => ({ r: 255, g: 255, b: 255 })));
    const darkAlpha = parseRgbaToken(dark["--bg-panel"] as string).alpha;
    const brightAlpha = parseRgbaToken(bright["--bg-panel"] as string).alpha;
    expect(brightAlpha).toBeGreaterThan(darkAlpha);
    // ... aber nie bis zur Undurchsichtigkeit: das Glas-Motiv der Vorlage bleibt erhalten.
    expect(brightAlpha).toBeLessThanOrEqual(CARD_MAX_ALPHA);
  });

  it("rechnet keine Tokens mehr fuer die archivierte Hülle", () => {
    const tokens = derivePalette(Array.from({ length: 20 }, () => ({ r: 30, g: 40, b: 60 })));
    expect(tokens).not.toHaveProperty("--bg-sidebar");
    expect(tokens).not.toHaveProperty("--scrim-top");
    expect(tokens).not.toHaveProperty("--scrim-bottom");
  });

  it("bleibt dunkel (niedrige Helligkeit von --bg), auch bei einem hellen Quellbild", () => {
    const brightImage: RGB[] = Array.from({ length: 50 }, () => ({ r: 255, g: 255, b: 255 }));
    const tokens = derivePalette(brightImage);
    expect(rgbToHsl(parseHexToken(tokens["--bg"] as string)).l).toBeLessThan(20);
  });
});

describe("minimalOverlayAlpha", () => {
  const FG: RGB = { r: 237, g: 240, b: 245 };

  it("verlangt ueber einem dunklen Hintergrund keine Abdunklung ueber die Untergrenze hinaus", () => {
    const alpha = minimalOverlayAlpha(DUNKLE_EBENE, { r: 10, g: 14, b: 24 }, FG, 4.5, 0.12, 0.62);
    expect(alpha).toBeCloseTo(0.12, 5);
  });

  it("verlangt ueber einem hellen Hintergrund mehr Deckkraft", () => {
    const alpha = minimalOverlayAlpha(DUNKLE_EBENE, WHITE, FG, 4.5, 0.12, 0.95);
    expect(alpha).toBeGreaterThan(0.12);
    expect(contrastRatio(FG, blend(DUNKLE_EBENE, alpha, WHITE))).toBeGreaterThanOrEqual(4.5);
  });

  it("liefert das Ergebnis, das die Schwelle tatsaechlich erreicht (nicht knapp darunter)", () => {
    for (const backdrop of [WHITE, MID_GRAY, { r: 200, g: 120, b: 60 }] as RGB[]) {
      const alpha = minimalOverlayAlpha(DUNKLE_EBENE, backdrop, FG, 4.5, 0, 1);
      expect(contrastRatio(FG, blend(DUNKLE_EBENE, alpha, backdrop))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("ist monoton: ein hellerer Hintergrund verlangt nie weniger Deckkraft", () => {
    const dunkel = minimalOverlayAlpha(DUNKLE_EBENE, { r: 40, g: 40, b: 40 }, FG, 4.5, 0, 1);
    const hell = minimalOverlayAlpha(DUNKLE_EBENE, { r: 220, g: 220, b: 220 }, FG, 4.5, 0, 1);
    expect(hell).toBeGreaterThanOrEqual(dunkel);
  });

  it("bleibt bei einer unerreichbaren Schwelle an der Obergrenze stehen, statt zu haengen", () => {
    const alpha = minimalOverlayAlpha(DUNKLE_EBENE, WHITE, FG, 21, 0.1, 0.4);
    expect(alpha).toBe(0.4);
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
