import { type RouteId, type SettingsSectionId, hashFor } from "./router.js";

/**
 * Abdocken (UI-Zwischenschub Punkt 4, S29): ein Sidebar-Eintrag, aus der App herausgezogen und
 * außerhalb losgelassen, öffnet seine Route als eigenes Fenster.
 *
 * **Diese Datei ist die einzige Stelle der Oberfläche, die überhaupt weiß, wie ein Fenster
 * entsteht.** Der Rest der App ruft nur `detachView(route)`. Genau dafür war sie so gebaut — und
 * mit S29 ist der angekündigte Tausch eingelöst: unter Tauri entsteht ein echtes
 * `WebviewWindow`, im Browser weiterhin ein `window.open`. Kein zweiter Ort im Baum musste dafür
 * angefasst werden.
 *
 * **Warum die globale Tauri-API und kein `@tauri-apps/api`-Import:** `ui/` wird ohne Bundler
 * ausgeliefert (`ui/build.ts`, "kein Bundling, kein Minifizieren"). Ein npm-Import ließe sich im
 * Browser nicht auflösen. `withGlobalTauri: true` (`src-tauri/tauri.conf.json`) stellt dieselbe
 * API als `window.__TAURI__` bereit — dieselbe Disziplin wie überall sonst hier: kein Werkzeug
 * dazunehmen, wenn der vorhandene Weg trägt.
 */

export const DEFAULT_WINDOW_FEATURES = "width=520,height=760,noopener,noreferrer";
export const DETACHED_WINDOW_SIZE = { width: 520, height: 760 } as const;

/** Wo diese Oberfläche gerade läuft — im Browser oder im Desktop-Fenster. */
export type DetachTarget = "browser" | "tauri";

/** Der Ausschnitt der globalen Tauri-API, den diese Datei benutzt. Bewusst schmal gehalten,
 * dieselbe Haltung wie `SocketLike` in `ui/events/bus.ts`: nur so viel, dass ein Test einen
 * Ersatz einsetzen kann. */
export interface TauriGlobal {
  webviewWindow?: {
    WebviewWindow: new (
      label: string,
      options: { url: string; title?: string; width?: number; height?: number },
    ) => unknown;
  };
}

/**
 * Erkennt, ob die globale Tauri-API bereitsteht. Reine Prüfung auf einem übergebenen Objekt,
 * damit sie ohne Browser und ohne Tauri prüfbar ist.
 */
export function detectDetachTarget(
  scope: { __TAURI__?: TauriGlobal } = globalThis as { __TAURI__?: TauriGlobal },
): DetachTarget {
  return typeof scope.__TAURI__?.webviewWindow?.WebviewWindow === "function" ? "tauri" : "browser";
}

export interface DetachOptions {
  /** Abschnitt, falls die Route `settings` ist. */
  section?: SettingsSectionId;
  /** Vorgabe: `window.open`. Injizierbar für Tests. */
  opener?: (url: string, target: string, features: string) => Window | null;
  /** Vorgabe: `${location.origin}${location.pathname}`. Injizierbar für Tests. */
  baseUrl?: () => string;
  /** Fenstermaße/-merkmale für `window.open`. */
  windowFeatures?: string;
  /** Aufgerufen, wenn der Browser das Fenster blockiert hat (Popup-Blocker). Unter Tauri gibt es
   * keinen Popup-Blocker — dort wird dieser Weg nie beschritten. */
  onBlocked?: () => void;
  /** Vorgabe: `globalThis`. Injizierbar, damit ein Test die Tauri-Seite prüfen kann. */
  scope?: { __TAURI__?: TauriGlobal };
}

function defaultBaseUrl(): string {
  return `${globalThis.location.origin}${globalThis.location.pathname}`;
}

function defaultOpener(url: string, target: string, features: string): Window | null {
  return globalThis.open(url, target, features);
}

/** Öffnet `route` als eigenes Fenster. Gibt `true` zurück, wenn das Fenster entstanden ist —
 * `false` nur im Browser, wenn der Popup-Blocker es verhindert hat. */
export function detachView(route: RouteId, options: DetachOptions = {}): boolean {
  const baseUrl = options.baseUrl ?? defaultBaseUrl;
  const url = `${baseUrl()}${hashFor(route, options.section)}`;
  const target = `kuronami-${route}`;
  const scope = options.scope ?? (globalThis as { __TAURI__?: TauriGlobal });

  if (detectDetachTarget(scope) === "tauri") {
    const Webview = scope.__TAURI__?.webviewWindow?.WebviewWindow;
    if (Webview) {
      try {
        new Webview(target, {
          url,
          title: `Kuronami — ${route}`,
          width: DETACHED_WINDOW_SIZE.width,
          height: DETACHED_WINDOW_SIZE.height,
        });
      } catch {
        // Ein Fenster mit diesem Label gibt es schon — der Eintrag ist also bereits abgedockt.
        // Das ist kein Fehlschlag, sondern der gewünschte Zustand.
      }
      return true;
    }
  }

  const opener = options.opener ?? defaultOpener;
  const features = options.windowFeatures ?? DEFAULT_WINDOW_FEATURES;
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
 * Seitenleiste selbst setzt `dropEffect` auf etwas anderes als `"none"` und ist kein Abdocken,
 * sondern ein Abbruch der Geste.
 */
export function shouldDetachOnDragEnd(dropEffect: string): boolean {
  return dropEffect === "none";
}
