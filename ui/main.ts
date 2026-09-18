import { createApiClient } from "./api/client.js";
import { resolveBackendOrigin } from "./backend-origin.js";
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
import { createVoiceController } from "./voice/controller.js";

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

  // Der Port des Backends lässt sich über `?events=3005` überschreiben (S21 ff.); hinter dem
  // Reverse-Proxy (Nachtrag 2026-09-16) löst `resolveBackendOrigin` stattdessen die
  // gateway.-Subdomain auf, siehe dort.
  const params = new URLSearchParams(globalThis.location.search);
  const hostname = globalThis.location.hostname || "localhost";
  const isSecure = globalThis.location.protocol === "https:";
  const backend = resolveBackendOrigin(hostname, isSecure, params.get("events"));
  const bus = createEventBus({ url: backend.ws });
  const api = createApiClient({ baseUrl: backend.http, token: () => loadToken() });
  const mic = createMicStateStore();
  const composer = createComposer(composerEl, api, bus);

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

  /**
   * Die Sprachschicht (S30/S31). Der Mic-Knopf öffnet ab hier eine echte Sitzung zum
   * Pipecat-Prozess statt nur den Zustand umzuschalten; Adresse und Sitzungsgeheimnis kommen
   * bei **jedem** Druck frisch aus den Einstellungen, damit eine Änderung dort sofort gilt.
   *
   * Steht dort nichts (der Normalfall, Nachtrag 2026-09-16), richtet sich die Sitzung selbst
   * ein: die Adresse leitet `resolveBackendOrigin` aus dem eigenen Hostnamen ab, das
   * Sitzungsgeheimnis holt der Gateway aus seiner `.env` (`GET /channels/web/voice`). Es auf
   * jedem Gerät abzutippen wäre eine Hürde ohne Gegenwert — wer die Seite überhaupt bedienen
   * kann, hält bereits den mächtigeren Verbindungs-Token.
   *
   * Läuft kein Sprachprozess, sagt der Knopf das genauso ehrlich wie die Karten es tun, wenn
   * kein Gateway läuft — kein stiller Nichtstuer.
   */
  let voiceSessionToken: string | null = null;
  void api
    .get<{ configured: boolean; sessionToken: string | null }>("/channels/web/voice")
    .then((config) => {
      voiceSessionToken = config.sessionToken;
    })
    .catch(() => {
      // Kein Gateway, kein Token — der Mic-Knopf sagt es beim Druck. Ein Fehler beim Laden der
      // Seite wäre der falsche Ort dafür: die Sprachschicht ist nicht die Seite.
    });

  const voice = createVoiceController({
    mic,
    url: () => loadSettings().speech.endpoint ?? backend.voiceWs,
    token: () => loadSettings().speech.sessionToken ?? voiceSessionToken,
    notify: (message) => toast.show(message),
    onTranscript: (text, final) => {
      if (final && text.length > 0) toast.show(`Verstanden: „${text}"`);
    },
    onReply: (text) => toast.show(text),
    onApproval: (approval) => {
      const options = approval.options.map((option) => option.label).join(" / ");
      toast.show(`Freigabe: ${approval.question} (${options})`);
    },
  });

  const sidebar = mountSidebar(sidebarEl, { navigate, toast });
  mountMicButton(sidebar.micHost, mic, {
    stateTarget: sidebarEl,
    onToggle: () => voice.toggle(),
  });
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
