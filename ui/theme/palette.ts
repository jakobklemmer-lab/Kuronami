/**
 * Farbableitung aus einem Hintergrundbild (S-Zwischenschub, Punkt 5) — reine Farbmathematik,
 * ohne `document`/`canvas`/`Image`. Die DOM-Seite (Bild laden, auf eine kleine Fläche
 * herunterrechnen, Pixel lesen) steht in `ui/theme/background.ts`; diese Datei nimmt nur ein
 * fertiges Pixel-Array entgegen und bleibt dadurch ohne Browser prüfbar — dasselbe Prinzip wie
 * `signalFor` in `ui/events/bus.ts`.
 *
 * Drei Pflichten aus dem Auftrag, jede als eigener, benannter Schritt statt vermischt:
 * 1. Saettigung gedeckelt (`clampSaturation`) — nie Neontoene.
 * 2. Kontrast der Textfarbe gegen die tatsaechliche Hintergrundflaeche geprueft und bei Bedarf
 *    korrigiert (`ensureContrast`), mindestens 4,5:1 (WCAG-Formel, `contrastRatio`).
 * 3. Eine deckende Ebene hinter Inhaltsflaechen (`SCRIM_COLOR`/`SCRIM_ALPHA`) — der Massstab, an
 *    dem Schritt 2 tatsaechlich prueft, ist die Flaeche *nach* diesem Scrim, nicht das rohe Foto.
 */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface HSL {
  h: number;
  s: number;
  l: number;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

export function toHex(color: RGB): string {
  const byte = (value: number) => clampByte(value).toString(16).padStart(2, "0");
  return `#${byte(color.r)}${byte(color.g)}${byte(color.b)}`;
}

export function toRgba(color: RGB, alpha: number): string {
  return `rgba(${clampByte(color.r)}, ${clampByte(color.g)}, ${clampByte(color.b)}, ${alpha})`;
}

export function rgbToHsl({ r, g, b }: RGB): HSL {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;

  if (max === min) return { h: 0, s: 0, l: l * 100 };

  const delta = max - min;
  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let h: number;
  switch (max) {
    case rn:
      h = ((gn - bn) / delta + (gn < bn ? 6 : 0)) * 60;
      break;
    case gn:
      h = ((bn - rn) / delta + 2) * 60;
      break;
    default:
      h = ((rn - gn) / delta + 4) * 60;
  }
  return { h, s: s * 100, l: l * 100 };
}

export function hslToRgb({ h, s, l }: HSL): RGB {
  const sn = Math.max(0, Math.min(100, s)) / 100;
  const ln = Math.max(0, Math.min(100, l)) / 100;
  if (sn === 0) {
    const v = clampByte(ln * 255);
    return { r: v, g: v, b: v };
  }
  const hn = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
  const m = ln - c / 2;
  let [r1, g1, b1] = [0, 0, 0];
  if (hn < 60) [r1, g1, b1] = [c, x, 0];
  else if (hn < 120) [r1, g1, b1] = [x, c, 0];
  else if (hn < 180) [r1, g1, b1] = [0, c, x];
  else if (hn < 240) [r1, g1, b1] = [0, x, c];
  else if (hn < 300) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  return {
    r: clampByte((r1 + m) * 255),
    g: clampByte((g1 + m) * 255),
    b: clampByte((b1 + m) * 255),
  };
}

/** Deckelt die Saettigung eines Farbtons — Schritt 1 der Pflichten. */
export function clampSaturation(color: HSL, maxSaturation: number): HSL {
  return { ...color, s: Math.min(color.s, maxSaturation) };
}

function srgbChannelToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Relative Leuchtdichte nach WCAG 2.x. */
export function relativeLuminance(color: RGB): number {
  const r = srgbChannelToLinear(color.r);
  const g = srgbChannelToLinear(color.g);
  const b = srgbChannelToLinear(color.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Kontrastverhaeltnis nach WCAG 2.x, immer >= 1. */
export function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Mischt `top` mit `alpha` ueber `bottom` — die Berechnung hinter der deckenden Ebene
 * (Schritt 3). */
export function blend(top: RGB, alpha: number, bottom: RGB): RGB {
  const a = Math.max(0, Math.min(1, alpha));
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
  };
}

/**
 * Hellt oder dunkelt `fg` ab, bis der Kontrast gegen `bg` mindestens `minRatio` erreicht —
 * Schritt 2 der Pflichten. Fuer jeden moeglichen Hintergrund gibt es eine erreichbare Richtung
 * (Weiss erreicht 4,5:1 gegen jeden Hintergrund mit Leuchtdichte <= ~0.183, Schwarz gegen jeden
 * mit Leuchtdichte >= ~0.175 — die beiden Bereiche ueberlappen und decken zusammen [0,1] komplett
 * ab), die Schleife bricht deshalb immer vor Erreichen des Randes ab, nicht erst dort.
 */
export function ensureContrast(fg: RGB, bg: RGB, minRatio = 4.5): RGB {
  if (contrastRatio(fg, bg) >= minRatio) return fg;

  const hsl = rgbToHsl(fg);

  // Welche Richtung traegt, haengt nicht am Mittelpunkt der Helligkeitsskala, sondern am
  // WCAG-Kreuzungspunkt: reines Weiss erreicht 4,5:1 nur gegen einen Hintergrund mit
  // Leuchtdichte <= ~0,183, reines Schwarz nur gegen einen mit Leuchtdichte >= ~0,175 — ein
  // fester 0,5-Schwellwert waere fuer die meisten Hintergruende falsch. Deshalb wird beides
  // ausprobiert statt eine Richtung zu raten.
  function search(step: 1 | -1): RGB | null {
    let l = hsl.l;
    for (let i = 0; i < 100; i += 1) {
      const nextL = Math.max(0, Math.min(100, l + step));
      if (nextL === l) break;
      l = nextL;
      const candidate = hslToRgb({ ...hsl, l });
      if (contrastRatio(candidate, bg) >= minRatio) return candidate;
    }
    return null;
  }

  return (
    search(1) ??
    search(-1) ??
    // Rand erreicht, ohne die Schwelle zu treffen — nur moeglich bei einer Anforderung ueber
    // 4,5:1, fuer die es keinen erreichbaren Punkt gibt. Das jeweils bessere Extrem ist dann die
    // bestmoegliche Annaeherung.
    hslToRgb({ ...hsl, l: relativeLuminance(bg) > 0.5 ? 0 : 100 })
  );
}

const FALLBACK_DOMINANT: RGB = { r: 97, g: 150, b: 205 };
const FALLBACK_MUTED: RGB = { r: 18, g: 22, b: 34 };

export interface DominantColors {
  /** Der auffaelligste Farbton (per Saettigung gewichteter Mehrheits-Farbton). */
  dominant: RGB;
  /** Der Durchschnitt des ganzen Bildes — die Grundlage fuer einen gedaempften Hintergrundton. */
  muted: RGB;
  /** Der hellste Einzelpixel — der ungünstigste Fall fuer die Kontrastpruefung. */
  brightest: RGB;
}

/** Bestimmt dominanten und gedaempften Farbton aus einer Pixelliste (z. B. von einem
 * heruntergerechneten Bild). Farbtoene werden in zwoelf 30-Grad-Eimer sortiert, gewichtet nach
 * Saettigung — ein Bild ohne jede Farbe (reines Graustufenfoto) faellt auf einen neutralen
 * Vorgabe-Farbton zurueck, statt einen zufaelligen Eimer zu waehlen. */
export function deriveDominantColors(pixels: readonly RGB[]): DominantColors {
  if (pixels.length === 0) {
    return { dominant: FALLBACK_DOMINANT, muted: FALLBACK_MUTED, brightest: FALLBACK_MUTED };
  }

  const bucketCount = 12;
  const buckets = Array.from({ length: bucketCount }, () => ({
    weight: 0,
    r: 0,
    g: 0,
    b: 0,
  }));

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let brightest = pixels[0] as RGB;
  let brightestLum = relativeLuminance(brightest);

  for (const pixel of pixels) {
    sumR += pixel.r;
    sumG += pixel.g;
    sumB += pixel.b;

    const lum = relativeLuminance(pixel);
    if (lum > brightestLum) {
      brightest = pixel;
      brightestLum = lum;
    }

    const { h, s } = rgbToHsl(pixel);
    const weight = s;
    if (weight <= 0) continue;
    const index = Math.floor(h / (360 / bucketCount)) % bucketCount;
    const bucket = buckets[index] as { weight: number; r: number; g: number; b: number };
    bucket.weight += weight;
    bucket.r += pixel.r * weight;
    bucket.g += pixel.g * weight;
    bucket.b += pixel.b * weight;
  }

  const muted: RGB = {
    r: sumR / pixels.length,
    g: sumG / pixels.length,
    b: sumB / pixels.length,
  };

  const topBucket = buckets.reduce((best, bucket) => (bucket.weight > best.weight ? bucket : best));
  const dominant: RGB =
    topBucket.weight > 0
      ? {
          r: topBucket.r / topBucket.weight,
          g: topBucket.g / topBucket.weight,
          b: topBucket.b / topBucket.weight,
        }
      : FALLBACK_DOMINANT;

  return { dominant, muted, brightest };
}

export type PaletteTokens = Record<string, string>;

export interface DerivePaletteOptions {
  /** Obergrenze der Saettigung in Prozent — Schritt 1. Vorgabe 45. */
  maxSaturation?: number;
  /** Mindest-Kontrastverhaeltnis fuer Text gegen die tatsaechliche Flaeche — Schritt 2.
   * Vorgabe 4.5 (WCAG AA fuer Fliesstext). */
  minContrast?: number;
}

/** Die Farbe der deckenden Ebene (Schritt 3) — sehr dunkel, unabhaengig vom Bild, dieselbe
 * Rolle wie der bisherige feste Verlauf in `.scene` (`ui/styles/layout.css`). */
export const SCRIM_COLOR: RGB = { r: 3, g: 4, b: 9 };
export const SCRIM_ALPHA = 0.72;

const BASE_FG: RGB = { r: 232, g: 232, b: 232 };

/**
 * Leitet ein vollstaendiges Token-Set aus einer Pixelliste ab. Reine Funktion — `pixels` kommt
 * von `ui/theme/background.ts` (echtes Bild) oder direkt aus einem Test (erfundene Pixel).
 */
export function derivePalette(
  pixels: readonly RGB[],
  options: DerivePaletteOptions = {},
): PaletteTokens {
  const maxSaturation = options.maxSaturation ?? 45;
  const minContrast = options.minContrast ?? 4.5;

  const { dominant, muted, brightest } = deriveDominantColors(pixels);

  const dominantHsl = rgbToHsl(dominant);
  const accentHsl = clampSaturation(
    { h: dominantHsl.h, s: Math.max(dominantHsl.s, 20), l: 58 },
    maxSaturation,
  );
  const accent = hslToRgb(accentHsl);

  const mutedHsl = rgbToHsl(muted);
  const bgHsl = clampSaturation({ h: mutedHsl.h, s: mutedHsl.s, l: 6 }, 30);
  const bg = hslToRgb(bgHsl);
  const bgDeep = hslToRgb({ ...bgHsl, l: 3 });
  const bgPanelSolid = hslToRgb({ ...bgHsl, l: 10 });

  // Schritt 3: die Flaeche, gegen die Schritt 2 tatsaechlich prueft, ist der hellste
  // Bildausschnitt *nach* der deckenden Ebene — der ungünstigste realistische Fall.
  const effectiveWorstBg = blend(SCRIM_COLOR, SCRIM_ALPHA, brightest);
  const fg = ensureContrast(BASE_FG, effectiveWorstBg, minContrast);

  return {
    "--bg": toHex(bg),
    "--bg-deep": toHex(bgDeep),
    // Undurchsichtig, nicht "Glas" (Punkt 7: kein flaechendeckender Blur/Glas-Look) — ein Panel
    // muss auf jedem Hintergrundbild lesbar bleiben, nicht nur auf dem ruhigen Vorgabefoto.
    "--bg-panel": toHex(bgPanelSolid),
    "--bg-panel-solid": toHex(bgPanelSolid),
    "--bg-sidebar": toHex(bgDeep),
    "--fg": toHex(fg),
    "--fg-muted": toRgba(fg, 0.62),
    "--fg-faint": toRgba(fg, 0.38),
    "--accent": toHex(accent),
    "--accent-strong": toRgba(accent, 0.35),
    "--border": toRgba(fg, 0.1),
    "--scrim": toRgba(SCRIM_COLOR, SCRIM_ALPHA),
  };
}
