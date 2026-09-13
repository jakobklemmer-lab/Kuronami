/**
 * Reine Skalierungs-Mathematik fuer ein hochgeladenes Hintergrundbild (S-Zwischenschub,
 * Punkt 5) — getrennt von `ui/theme/background.ts`, das die Leinwand tatsaechlich zeichnet, aus
 * demselben Grund wie ueberall in `ui/`: eine reine Funktion bleibt ohne Browser pruefbar.
 *
 * Ein hochgeladenes Bild wird vor dem Speichern in `localStorage` verkleinert — ohne Deckel
 * koennte ein einzelnes Foto aus einer modernen Kamera den Speicher fuer die ganze Oberflaeche
 * sprengen (typische Kontingente liegen bei 5–10 MB je Ursprung).
 */

export interface Dimensions {
  width: number;
  height: number;
}

/** Skaliert `width`x`height` so herunter, dass keine Seite `maxDimension` ueberschreitet, unter
 * Beibehaltung des Seitenverhaeltnisses. Ein Bild, das schon kleiner ist, bleibt unveraendert —
 * es wird nie hochskaliert. */
export function computeFitDimensions(
  width: number,
  height: number,
  maxDimension: number,
): Dimensions {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  if (width <= maxDimension && height <= maxDimension) {
    return { width: Math.round(width), height: Math.round(height) };
  }
  const scale = width >= height ? maxDimension / width : maxDimension / height;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
