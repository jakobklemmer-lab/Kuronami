import { createApiClient } from "./api/client.js";
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
 * Die Wurzel des UI-Zwischenschubs — die einzige Datei der Oberfläche, die `document`/`window`
 * anfasst (dieselbe Haltung wie vor dem Umbau, siehe die alte Fassung in der Git-Historie): sie
 * baut die Hülle (Seitenleiste, Mic-Dock, Szene), verdrahtet den Router (genau eine aktive
 * Ansicht, Punkt 4a) und reicht `api`/`bus`/`mic`/`navigate`/`detach` als `ViewContext` an die
 * gemountete Ansicht durch. Jede Ansicht bleibt dadurch unabhängig von der Hülle testbar (auch
 * wenn `ui/` insgesamt bei DOM-Code auf Tests verzichtet, siehe `ui/views/types.ts`).
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
  const micDockEl = element<HTMLElement>("mic-dock");
  const toastEl = element<HTMLElement>("toast");

  const toast = createToast(toastEl);

  // Der Port des Backends lässt sich über `?events=3005` überschreiben (S21 ff.) — historisch
  // der Name für den Ereignisstrom, seit S22 auch die Basis für `/runs` und `/channels/*`.
  const params = new URLSearchParams(globalThis.location.search);
  const backendPort = params.get("events") ?? "3000";
  const hostname = globalThis.location.hostname || "localhost";
  const backendOrigin = `http://${hostname}:${backendPort}`;
  const bus = createEventBus({ url: `ws://${hostname}:${backendPort}/events` });
  const api = createApiClient({ baseUrl: backendOrigin, token: () => loadToken() });
  const mic = createMicStateStore();

  // ---------------------------------------------------------------------
  // Erscheinungsbild (Punkt 5): einmal beim Start, danach bei jeder Änderung aus der
  // Einstellungsseite (`settingsBus`) — die Hülle liegt ausserhalb jeder gerouteten Ansicht.
  // ---------------------------------------------------------------------
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

  const sidebar = mountSidebar(sidebarEl, { navigate, toast });
  mountMicButton(micDockEl, mic);
  bus.onStatus((status, attempts) => sidebar.setConnectionStatus(status, attempts));

  // ---------------------------------------------------------------------
  // Router (Punkt 4a): genau eine aktive Ansicht, adressiert über den Hash. Ein Wechsel räumt
  // die vorherige Ansicht über ihre eigene Aufräumfunktion auf, bevor die nächste mountet.
  // ---------------------------------------------------------------------
  let cleanupCurrentView: (() => void) | null = null;

  function renderRoute(): void {
    const parsed = parseHash(globalThis.location.hash);
    cleanupCurrentView?.();
    outletEl.innerHTML = "";
    sidebar.setActive(parsed.view);
    const ctx: ViewContext = { api, bus, mic, navigate, detach, section: parsed.section };
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
