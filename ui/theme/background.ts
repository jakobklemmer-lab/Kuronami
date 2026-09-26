import { type PaletteTokens, type RGB, derivePalette } from "./palette.js";

/**
 * Die DOM-Seite der Farbableitung (S-Zwischenschub, Punkt 5) — lädt das Bild des Raums, rechnet
 * es auf eine kleine Fläche herunter, liest die Pixel und reicht sie an die reine Funktion
 * `derivePalette` (`ui/theme/palette.ts`) weiter. Bewusst getrennt von der Farbmathematik: diese
 * Datei bleibt ungetestet (braucht `document`/`canvas`/`Image`), die eigentliche Ableitung ist
 * vollständig geprüft.
 *
 * **Seit S47 aus dem Bild, das man sieht.** Bis dahin kam die Palette aus dem Hintergrund der
 * klassischen Hülle (`lake.jpg` oder ein eigenes Bild, in den Einstellungen wählbar) — auch
 * dann, als dieser längst unsichtbar hinter dem Raum der Präsenz lag. Die Kontrastrechnung für
 * Karten und Bänder lief damit gegen ein Foto, das niemand sah. Mit der klassischen Hülle ist
 * auch die Wahl ins Archiv gegangen; gemessen wird jetzt der Raum.
 */

/** Dasselbe Bild wie `--p-bild` in `ui/styles/praesenz.css`. */
export const RAUM_BILD = "/assets/praesenz.jpg";

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Bild liess sich nicht laden: ${url}`));
    img.src = url;
  });
}

const SAMPLE_SIZE = 32;

function samplePixels(img: HTMLImageElement): RGB[] {
  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE_SIZE;
  canvas.height = SAMPLE_SIZE;
  const context = canvas.getContext("2d");
  if (!context) return [];
  context.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  const { data } = context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  const pixels: RGB[] = [];
  for (let i = 0; i < data.length; i += 4) {
    pixels.push({ r: data[i] as number, g: data[i + 1] as number, b: data[i + 2] as number });
  }
  return pixels;
}

export function applyPaletteToRoot(
  tokens: PaletteTokens,
  root: HTMLElement = document.documentElement,
): void {
  for (const [key, value] of Object.entries(tokens)) root.style.setProperty(key, value);
}

export interface ApplyPaletteOptions {
  maxSaturation?: number;
  minContrast?: number;
}

/** Das Ereignis, mit dem eine gerade gemountete Ansicht (z. B. die Einstellungsseite, Abschnitt
 * Erscheinungsbild) erfaehrt, dass eine Ableitung fertig ist — das Laden des Bildes ist
 * asynchron, eine Ansicht kann also schon stehen, bevor `--accent` & Co. den abgeleiteten Wert
 * tragen. Ein eigenes Ereignis statt `settingsBus`: `applyAppearance` wird *von* einem
 * `settingsBus`-Abonnenten aufgerufen (`ui/main.ts`) — ein erneutes `settingsBus.emit` hier
 * würde sich selbst wieder auslösen. */
export const PALETTE_APPLIED_EVENT = "kuronami:palette-applied";

/** Leitet die Palette aus dem Bild des Raums ab und schreibt sie auf `:root`. Ein Bild, das sich
 * nicht laden lässt, lässt die zuletzt gesetzten Tokens stehen — der Fehler geht als
 * abgelehntes Versprechen an den Aufrufer. */
export async function leitePaletteAusDemRaum(options: ApplyPaletteOptions = {}): Promise<void> {
  const img = await loadImage(RAUM_BILD);
  const tokens = derivePalette(samplePixels(img), options);
  applyPaletteToRoot(tokens);
  document.dispatchEvent(new CustomEvent(PALETTE_APPLIED_EVENT));
}
