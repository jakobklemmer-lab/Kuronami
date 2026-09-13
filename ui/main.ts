import { createApiClient } from "./api/client.js";
import { createComposer } from "./compose.js";
import { createEventBus } from "./events/bus.js";
import { mountMicButton } from "./mic/button.js";
import { createMicStateStore } from "./mic/state.js";
import { detachView } from "./router/detach.js";
import {
  DEFAULT_ROUTE,
  type RouteId,
  type SettingsSectionId,
  hashFor,
  parseHash,
} from "./router/router.js";
import { loadToken } from "./settings.js";
import { loadSettings, settingsBus } from "./settings/store.js";
import { applyAppearance, settingsView } from "./settings/view.js";
import { mountSidebar } from "./sidebar/view.js";
import { createToast } from "./toast.js";
import { calendarView } from "./views/calendar.js";
import { filesView } from "./views/files.js";
import { homeView } from "./views/home.js";
import { mailView } from "./views/mail.js";
import { researchView } from "./views/research.js";
import { systemView } from "./views/system.js";
import { tradingView } from "./views/trading.js";
import type { View, ViewContext } from "./views/types.js";

/**
 * Die Wurzel der Oberfläche — die einzige Datei, die `document`/`window` direkt anfasst und
 * alles zusammensteckt: Hülle (Seitenleiste mit Mic-Pille, Szene), Router (genau eine aktive
 * Ansicht) und der `ViewContext`, den jede Ansicht bekommt.
 */

const VIEWS: Record<RouteId, View> = {
  home: homeView,
  mail: mailView,
  calendar: calendarView,
  trading: tradingView,
  research: researchView,
  files: filesView,
  system: systemView,
  settings: settingsView,
};

function element<T extends Element>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`Das Grundgerüst hat kein Element mit der id "${id}".`);
  return found as unknown as T;
}

function main(): void {
  const sceneEl = element<HTMLElement>("scene");
  const sidebarEl = element<HTMLElement>("sidebar");
  const outletEl = element<HTMLElement>("view-outlet");
  const toastEl = element<HTMLElement>("toast");
  const composerEl = element<HTMLElement>("composer-host");

  const toast = createToast(toastEl);

  // Der Port des Backends lässt sich über `?events=3005` überschreiben (S21 ff.).
  const params = new URLSearchParams(globalThis.location.search);
  const backendPort = params.get("events") ?? "3000";
  const hostname = globalThis.location.hostname || "localhost";
  const backendOrigin = `http://${hostname}:${backendPort}`;
  const bus = createEventBus({ url: `ws://${hostname}:${backendPort}/events` });
  const api = createApiClient({ baseUrl: backendOrigin, token: () => loadToken() });
  const mic = createMicStateStore();
  const composer = createComposer(composerEl, api);

  void applyAppearance(loadSettings(), sceneEl);
  settingsBus.subscribe((settings) => void applyAppearance(settings, sceneEl));

  function navigate(route: RouteId, section?: SettingsSectionId): void {
    globalThis.location.hash = hashFor(route, section);
  }

  function detach(route: RouteId, section?: SettingsSectionId): void {
    detachView(route, {
      section,
      onBlocked: () =>
        toast.show("Das Fenster wurde vom Browser blockiert — Popups für diese Seite erlauben."),
    });
  }

  /** Fokus-Modus: Seitenleiste und Karten treten zurück, die Uhr bleibt. Eine echte,
   * abgeschlossene Oberflächen-Funktion — kein Knopf, der nur so aussieht. */
  function toggleFocus(): void {
    const on = document.body.dataset.focus === "on";
    document.body.dataset.focus = on ? "off" : "on";
  }

  const sidebar = mountSidebar(sidebarEl, { navigate, toast });
  mountMicButton(sidebar.micHost, mic, sidebarEl);
  bus.onStatus((status, attempts) => sidebar.setConnectionStatus(status, attempts));

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.body.dataset.focus === "on") toggleFocus();
  });

  let cleanupCurrentView: (() => void) | null = null;

  function renderRoute(): void {
    const parsed = parseHash(globalThis.location.hash);
    cleanupCurrentView?.();
    outletEl.innerHTML = "";
    sidebar.setActive(parsed.view);
    const ctx: ViewContext = {
      api,
      bus,
      mic,
      navigate,
      detach,
      compose: () => composer.open(),
      toggleFocus,
      section: parsed.section,
    };
    cleanupCurrentView = VIEWS[parsed.view].mount(outletEl, ctx);
  }

  globalThis.addEventListener("hashchange", renderRoute);
  if (globalThis.location.hash.length === 0) {
    globalThis.location.hash = hashFor(DEFAULT_ROUTE);
  } else {
    renderRoute();
  }

  bus.connect();
}

main();
