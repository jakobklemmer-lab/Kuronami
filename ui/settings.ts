/**
 * Der Bearer-Token der Oberfläche (S22), gespeichert in `localStorage`.
 *
 * Weder `/runs` noch `/channels/web/*` haben eine eigene Anmeldung — sie tragen denselben
 * Token wie jeder andere Aufrufer des Gateways (`GATEWAY_WEB_TOKEN`). Diese Datei hält ihn nur
 * fest, damit der Betreiber ihn nicht bei jedem Neuladen erneut eintippt. `localStorage` ist
 * je Browserprofil, nie geteilt und nie an Kuronami selbst gerichtet — genau die richtige
 * Reichweite für ein Betreiber-Geheimnis, das nur dieser Rechner kennen muss.
 *
 * Liest und schreibt nie direkt `window.localStorage`, sondern nimmt den Speicher als
 * Parameter entgegen (Vorgabe: `localStorage`) — dasselbe Muster wie `socketFactory` in
 * `ui/events/bus.ts`, hier, damit ein Test ohne Browser einen Speicher ohne Netz einsetzen
 * kann.
 */

export const TOKEN_STORAGE_KEY = "kuronami.webToken";

function storage(explicit?: Storage): Storage | null {
  if (explicit) return explicit;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Ein privates Fenster oder blockierter Seitenspeicher wirft statt `undefined`
    // zurückzugeben — beides heißt hier: kein gespeicherter Token, kein Absturz.
    return null;
  }
}

export function loadToken(explicit?: Storage): string | null {
  const store = storage(explicit);
  if (!store) return null;
  try {
    const value = store.getItem(TOKEN_STORAGE_KEY);
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function saveToken(token: string, explicit?: Storage): void {
  const store = storage(explicit);
  if (!store) return;
  try {
    if (token.length === 0) store.removeItem(TOKEN_STORAGE_KEY);
    else store.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // Kein Speicherplatz oder kein Zugriff — der Token gilt dann nur für diese Sitzung im
    // Arbeitsspeicher des Aufrufers, nicht darüber hinaus. Kein Absturz dafür.
  }
}
