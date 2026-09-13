import type { BackgroundChoice } from "../settings/store.js";
import { type PaletteTokens, type RGB, derivePalette } from "./palette.js";
import { computeFitDimensions } from "./resize.js";

/**
 * Die DOM-Seite der Hintergrund-/Farbableitung (S-Zwischenschub, Punkt 5) — laedt ein Bild,
 * rechnet es auf eine kleine Flaeche herunter, liest die Pixel und reicht sie an die reine
 * Funktion `derivePalette` (`ui/theme/palette.ts`) weiter. Bewusst getrennt von der Farb-
 * mathematik: diese Datei bleibt ungetestet (braucht `document`/`canvas`/`Image`), die
 * eigentliche Ableitung ist vollstaendig geprueft.
 */

const VOID_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360">' +
  '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
  '<stop offset="0" stop-color="#0b0f1a"/><stop offset="1" stop-color="#1d2436"/>' +
  "</linearGradient></defs>" +
  '<rect width="640" height="360" fill="url(#g)"/></svg>';

export const BUILTIN_BACKGROUNDS: Record<"lake" | "void", { label: string; url: string }> = {
  lake: { label: "See", url: "./assets/lake.jpg" },
  void: { label: "Leere", url: `data:image/svg+xml;utf8,${encodeURIComponent(VOID_SVG)}` },
};

export function backgroundUrl(choice: BackgroundChoice): string {
  return choice.kind === "builtin" ? BUILTIN_BACKGROUNDS[choice.id].url : choice.dataUrl;
}

/**
 * Macht aus einer moeglicherweise relativen Adresse eine absolute.
 *
 * **Warum das noetig ist:** ein `url()` in einer CSS Custom Property wird gegen das Stylesheet
 * aufgeloest, das die Variable *einsetzt* — hier `ui/styles/layout.css` — und nicht gegen das
 * Dokument. Aus `./assets/lake.jpg` wurde dadurch `/styles/assets/lake.jpg`, und das
 * Hintergrundfoto fehlte still und ohne Fehlermeldung. Eine aufgeloeste Adresse hat diese
 * Mehrdeutigkeit nicht. `data:`-Adressen (eigenes Bild) bleiben unveraendert.
 */
export function absoluteUrl(url: string): string {
  if (url.startsWith("data:")) return url;
  return new URL(url, document.baseURI).href;
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Bild liess sich nicht laden: ${url}`));
    img.src = url;
  });
}

const SAMPLE_SIZE = 32;

/** Wie viel des Bildes oben bzw. unten als eigenes Band gemessen wird — dort steht Text direkt
 * auf dem Foto (Kopfzeile mit Uhr/Wetter, Fusszeile). Der Rest des Bildes bleibt davon
 * unberuehrt, damit ein heller Fleck in der Bildmitte nicht die ganze Kopfzeile abdunkelt. */
const BAND_FRACTION = 0.3;

function samplePixels(img: HTMLImageElement): { all: RGB[]; top: RGB[]; bottom: RGB[] } {
  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE_SIZE;
  canvas.height = SAMPLE_SIZE;
  const context = canvas.getContext("2d");
  if (!context) return { all: [], top: [], bottom: [] };
  context.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  const { data } = context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);

  const all: RGB[] = [];
  const top: RGB[] = [];
  const bottom: RGB[] = [];
  const bandRows = Math.max(1, Math.round(SAMPLE_SIZE * BAND_FRACTION));
  for (let i = 0; i < data.length; i += 4) {
    const pixel = { r: data[i] as number, g: data[i + 1] as number, b: data[i + 2] as number };
    all.push(pixel);
    const row = Math.floor(i / 4 / SAMPLE_SIZE);
    if (row < bandRows) top.push(pixel);
    else if (row >= SAMPLE_SIZE - bandRows) bottom.push(pixel);
  }
  return { all, top, bottom };
}

export function applyPaletteToRoot(
  tokens: PaletteTokens,
  root: HTMLElement = document.documentElement,
): void {
  for (const [key, value] of Object.entries(tokens)) root.style.setProperty(key, value);
}

export interface ApplyBackgroundOptions {
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

/** Setzt das Hintergrundbild auf `.scene` und leitet die Palette daraus ab — die eine Funktion,
 * die "Hintergrund waehlen" und "Farbgebung zieht mit" verbindet (Punkt 5). Ein Bild, das sich
 * nicht laden laesst (z. B. eine beschaedigte, von Hand eingetragene Adresse), laesst die
 * zuletzt gesetzten Tokens stehen statt abzustuerzen. */
export async function applyBackground(
  choice: BackgroundChoice,
  sceneEl: HTMLElement,
  options: ApplyBackgroundOptions = {},
): Promise<void> {
  const url = absoluteUrl(backgroundUrl(choice));
  sceneEl.style.setProperty("--scene-image", `url("${url}")`);
  const img = await loadImage(url);
  const { all, top, bottom } = samplePixels(img);
  const tokens = derivePalette(all, {
    ...options,
    topBandPixels: top,
    bottomBandPixels: bottom,
  });
  applyPaletteToRoot(tokens);
  document.dispatchEvent(new CustomEvent(PALETTE_APPLIED_EVENT));
}

export function readImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Datei liess sich nicht lesen."));
    reader.readAsDataURL(file);
  });
}

const UPLOAD_MAX_DIMENSION = 1600;

/** Rechnet ein hochgeladenes Bild vor dem Speichern herunter (`ui/theme/resize.ts`) — ohne
 * Deckel koennte ein einzelnes Kamerafoto das `localStorage`-Kontingent sprengen. */
export async function resizeImageDataUrl(
  dataUrl: string,
  maxDimension = UPLOAD_MAX_DIMENSION,
): Promise<string> {
  const img = await loadImage(dataUrl);
  const { width, height } = computeFitDimensions(img.naturalWidth, img.naturalHeight, maxDimension);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return dataUrl;
  context.drawImage(img, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", 0.85);
}
