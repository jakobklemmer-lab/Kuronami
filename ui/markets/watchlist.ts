import { loadSettings, settingsBus, updateSettingsSection } from "../settings/store.js";

/**
 * Die Beobachtungsliste der Trading-Ansicht (Nachtrag 2026-09-16) — Yahoo-Symbole, gespeichert
 * in `settings.markets.watchlist`, damit Startseite und Trading-Seite dieselbe Liste zeigen und
 * sie den Neustart des Browsers überlebt. Die reinen Listenoperationen stehen getrennt vom
 * Speichern, damit sie ohne `localStorage` prüfbar sind.
 */

export const MAX_WATCHLIST = 30;

/** Fügt hinten an; Groß-/Kleinschreibung zählt nicht doppelt, Yahoo kennt Symbole groß. */
export function addSymbol(list: readonly string[], symbol: string): string[] {
  const normalized = symbol.trim().toUpperCase();
  if (normalized === "") return [...list];
  if (list.some((entry) => entry.toUpperCase() === normalized)) return [...list];
  if (list.length >= MAX_WATCHLIST) return [...list];
  return [...list, normalized];
}

export function removeSymbol(list: readonly string[], symbol: string): string[] {
  const normalized = symbol.trim().toUpperCase();
  return list.filter((entry) => entry.toUpperCase() !== normalized);
}

export function hasSymbol(list: readonly string[], symbol: string): boolean {
  const normalized = symbol.trim().toUpperCase();
  return list.some((entry) => entry.toUpperCase() === normalized);
}

export function loadWatchlist(): string[] {
  return [...loadSettings().markets.watchlist];
}

export function saveWatchlist(list: readonly string[]): string[] {
  const next = updateSettingsSection("markets", { watchlist: [...list] });
  settingsBus.emit(next);
  return [...next.markets.watchlist];
}

/**
 * Welches Symbol die Trading-Seite beim nächsten Öffnen zeigen soll — gesetzt von der
 * Markets-Karte der Startseite, wenn der Nutzer eine Zeile anklickt. Sitzungsgebunden: es ist
 * eine Absicht für den nächsten Klick, keine Einstellung.
 */
const SELECTED_KEY = "kuronami.trading.symbol";

export function rememberSelectedSymbol(symbol: string): void {
  try {
    globalThis.sessionStorage?.setItem(SELECTED_KEY, symbol);
  } catch {
    // Kein Sitzungsspeicher — dann öffnet die Trading-Seite eben das erste Symbol.
  }
}

export function recallSelectedSymbol(): string | null {
  try {
    return globalThis.sessionStorage?.getItem(SELECTED_KEY) ?? null;
  } catch {
    return null;
  }
}
