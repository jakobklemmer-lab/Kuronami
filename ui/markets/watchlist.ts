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

/**
 * „Im Chart zeigen" aus den Strategien und Analysen (2026-09-27): welcher Wert und was von
 * Kuros Arbeit darauf eingeblendet werden soll. Wie das Symbol oben eine Absicht für den
 * nächsten Aufbau der Märkte, die dabei verbraucht wird.
 */
export interface ChartAbsicht {
  symbol: string;
  strategie?: string;
  prognose?: string;
}

const ABSICHT_KEY = "kuronami.trading.absicht";

export function merkeChartAbsicht(absicht: ChartAbsicht): void {
  try {
    globalThis.sessionStorage?.setItem(ABSICHT_KEY, JSON.stringify(absicht));
    globalThis.sessionStorage?.setItem(SELECTED_KEY, absicht.symbol);
  } catch {
    // Ohne Sitzungsspeicher öffnen die Märkte eben ohne Einblendung.
  }
}

export function holeChartAbsicht(): ChartAbsicht | null {
  try {
    const roh = globalThis.sessionStorage?.getItem(ABSICHT_KEY);
    if (!roh) return null;
    globalThis.sessionStorage?.removeItem(ABSICHT_KEY);
    const a = JSON.parse(roh) as Partial<ChartAbsicht>;
    return typeof a.symbol === "string" ? (a as ChartAbsicht) : null;
  } catch {
    return null;
  }
}

/**
 * Welches Yahoo-Symbol der Chart für ein Symbol aus dem Labor zeigt. `binance:BTCUSDT` gibt es
 * bei Yahoo nicht; der nächste Wert ist `BTC-USD` — ein anderer Handelsplatz, deshalb sagt die
 * Ansicht dazu, dass die Handel auf Binance-Kerzen gerechnet sind.
 */
export function chartSymbolFuer(symbol: string): { symbol: string; anderePlattform: boolean } {
  const ohne = symbol.replace(/^yahoo:/i, "");
  const binance = /^binance:([A-Z0-9]+?)(USDT|USDC|BUSD|USD)$/i.exec(ohne);
  if (binance) return { symbol: `${binance[1]?.toUpperCase()}-USD`, anderePlattform: true };
  return { symbol: ohne.toUpperCase(), anderePlattform: false };
}
