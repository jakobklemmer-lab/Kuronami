import { type RouteId, type SettingsSectionId, hashFor } from "./router.js";

/**
 * Abdocken (S-Zwischenschub, Punkt 4): ein Sidebar-Eintrag, aus der App herausgezogen und
 * außerhalb losgelassen, öffnet seine Route als eigenes Fenster.
 *
 * **Diese Funktion ist die einzige Stelle im Browser-Client, die `window.open` kennt.** Der
 * Rest der App (Sidebar-Drag-Handler, künftige Aufrufer) ruft ausschließlich `detachView(route)`
 * auf. Kommt später der Tauri-Client (S29), wird **nur hier** `window.open` gegen
 * `WebviewWindow.create` (oder das Tauri-Äquivalent) getauscht — kein zweiter Ort im Baum, an
 * dem das nachgezogen werden müsste.
 */

export const DEFAULT_WINDOW_FEATURES = "width=520,height=760,noopener,noreferrer";

export interface DetachOptions {
  /** Abschnitt, falls die Route `settings` ist. */
  section?: SettingsSectionId;
  /** Vorgabe: `window.open`. Injizierbar für Tests und für den künftigen Tauri-Tausch. */
  opener?: (url: string, target: string, features: string) => Window | null;
  /** Vorgabe: `${location.origin}${location.pathname}`. Injizierbar für Tests. */
  baseUrl?: () => string;
  /** Fenstermaße/-merkmale für `window.open`. */
  windowFeatures?: string;
  /** Aufgerufen, wenn der Browser das Fenster blockiert hat (der Aufrufer zeigt dafür einen
   * Hinweis — siehe `ui/shell.ts`). */
  onBlocked?: () => void;
}

function defaultBaseUrl(): string {
  return `${globalThis.location.origin}${globalThis.location.pathname}`;
}

function defaultOpener(url: string, target: string, features: string): Window | null {
  return globalThis.open(url, target, features);
}

/** Öffnet `route` als eigenes Fenster. Gibt `true` zurück, wenn das Fenster tatsächlich
 * entstanden ist — `false`, wenn der Browser es blockiert hat (Popup-Blocker). */
export function detachView(route: RouteId, options: DetachOptions = {}): boolean {
  const opener = options.opener ?? defaultOpener;
  const baseUrl = options.baseUrl ?? defaultBaseUrl;
  const url = `${baseUrl()}${hashFor(route, options.section)}`;
  const features = options.windowFeatures ?? DEFAULT_WINDOW_FEATURES;
  const target = `kuronami-${route}`;

  const win = opener(url, target, features);
  if (win === null) {
    options.onBlocked?.();
    return false;
  }
  win.focus?.();
  return true;
}

/**
 * Die Abdock-Entscheidung selbst, als reine Funktion: ein natives HTML5-Drag, das auf keiner
 * registrierten Dropzone innerhalb der App gelandet ist, meldet beim `dragend`
 * `dataTransfer.dropEffect === "none"` — das, und nur das, gilt als Abdocken. Ein Drop *auf* der
 * Seitenleiste selbst (der Eintrag fällt zurück auf sich selbst oder auf einen Nachbarn) setzt
 * `dropEffect` auf etwas anderes als `"none"` und ist kein Abdocken, sondern ein Abbruch der
 * Geste.
 */
export function shouldDetachOnDragEnd(dropEffect: string): boolean {
  return dropEffect === "none";
}
