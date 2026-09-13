/**
 * Der Einklapp-Zustand der Seitenleiste (S-Zwischenschub, Punkt 2), gespeichert in
 * `localStorage` — dasselbe Muster wie der Bearer-Token in `ui/settings.ts`: Speicher als
 * Parameter entgegennehmen (Vorgabe `localStorage`), damit ein Test ohne Browser läuft, und ein
 * privates Fenster oder blockierter Seitenspeicher zu einem stillen Vorgabewert statt zu einem
 * Absturz führt.
 */

export const SIDEBAR_COLLAPSED_KEY = "kuronami.sidebarCollapsed";

function storage(explicit?: Storage): Storage | null {
  if (explicit) return explicit;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadSidebarCollapsed(explicit?: Storage): boolean {
  const store = storage(explicit);
  if (!store) return false;
  try {
    return store.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveSidebarCollapsed(collapsed: boolean, explicit?: Storage): void {
  const store = storage(explicit);
  if (!store) return;
  try {
    store.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // Kein Speicherplatz oder kein Zugriff — der Zustand gilt dann nur für diese Sitzung.
  }
}
