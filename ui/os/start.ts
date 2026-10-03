import { createApiClient } from "../api/client.js";
import { holeLage } from "../auth/anmeldung.js";
import { resolveBackendOrigin } from "../backend-origin.js";
import { createEventBus } from "../events/bus.js";
import { meldeAlarme } from "../markets/alarm-melden.js";
import { createMicStateStore } from "../mic/state.js";
import { loadToken, saveToken } from "../settings.js";
import { loadSettings } from "../settings/store.js";
import { createVoiceController } from "../voice/controller.js";
import { oeffneGespraech } from "../welle/gespraech.js";
import { zeigeTuer } from "../welle/tuer.js";
import { mountOs } from "./os.js";

/**
 * Der Einstieg von Kuro OS: Tür, Gateway, Ereignisstrom, Sprachschicht — wie in der Welle
 * (`ui/welle/start.ts`), dazu die Brücke zur Desktop-App, wenn die Seite in ihr läuft.
 */

const POSTER = "../welle/film/poster.jpg";

/** Was die Desktop-App der Seite bereitstellt (`desktop/preload.cjs`). */
interface KuroDesktop {
  plattform: string;
  beiSprechtaste(rueckruf: (an: boolean) => void): void;
  beiInselOeffnen(rueckruf: () => void): void;
}
declare global {
  interface Window {
    kuroDesktop?: KuroDesktop;
  }
}

/** Nach so langer Stille legt die Desktop-App die Sprachsitzung schlafen — Deepgram zählt Nullen mit. */
const SPRACHE_SCHLAEFT_NACH_MS = 3 * 60_000;

function element(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Kuro OS hat kein Element mit der id "${id}".`);
  return el;
}

function seitenspeicher(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function toaster(el: HTMLElement): (text: string) => void {
  let uhr: ReturnType<typeof setTimeout> | null = null;
  return (text) => {
    el.textContent = text;
    el.hidden = false;
    el.classList.remove("ist-weg");
    if (uhr !== null) globalThis.clearTimeout(uhr);
    uhr = globalThis.setTimeout(() => {
      el.classList.add("ist-weg");
      uhr = globalThis.setTimeout(() => {
        el.hidden = true;
      }, 300);
    }, 4200);
  };
}

function starte(backend: ReturnType<typeof resolveBackendOrigin>): void {
  const toast = toaster(element("w-toast"));
  const bus = createEventBus({ url: backend.ws });
  meldeAlarme(bus, toast);

  let tuerOffen = false;
  const api = createApiClient({
    baseUrl: backend.http,
    token: () => loadToken(),
    onUnauthorized: () => {
      if (tuerOffen) return;
      tuerOffen = true;
      saveToken("");
      void holeLage(backend.http).then((lage) => {
        zeigeTuer(document.body, {
          baseUrl: backend.http,
          benutzer: lage.benutzer,
          grund: "Die Sitzung ist abgelaufen. Bitte noch einmal aufschließen.",
          poster: POSTER,
          onOffen: (token) => {
            saveToken(token);
            globalThis.location.reload();
          },
        });
      });
    },
  });
  const mic = createMicStateStore();
  const gespraech = oeffneGespraech({ api, bus, mic, speicher: seitenspeicher() });

  let sprachToken: string | null = null;
  void api
    .get<{ configured: boolean; sessionToken: string | null }>("/channels/web/voice")
    .then((c) => {
      sprachToken = c.sessionToken;
    })
    .catch(() => {
      // Kein Gateway, kein Geheimnis — der Mikrofonknopf sagt es beim Druck.
    });
  const stimme = createVoiceController({
    mic,
    url: () => loadSettings().speech.endpoint ?? backend.voiceWs,
    sprechtaste: () => loadSettings().speech.sprechtaste,
    token: () => loadSettings().speech.sessionToken ?? sprachToken,
    notify: toast,
    onTranscript: (text, final) => {
      if (final && text.length > 0) gespraech.gesprochen(text);
    },
    onReply: (text) => gespraech.nachtrag(text),
    onApproval: (freigabe) => {
      toast(`Kuro fragt: ${freigabe.question}`);
    },
  });

  mountOs({
    root: element("os"),
    api,
    bus,
    mic,
    gespraech,
    voice: { toggle: () => stimme.toggle() },
    toast,
  });
  bus.connect();

  const desktop = globalThis.window?.kuroDesktop;
  if (desktop) verbindeDesktop(desktop, stimme);
}

/**
 * In der Desktop-App: die Sprechtaste wirkt systemweit. Der erste Druck öffnet die Sprachsitzung,
 * nach drei Minuten Stille schläft sie wieder, und Antworten dürfen als Mitteilung kommen. Den
 * Begleiter auf dem Schreibtisch speist eine eigene Seite (`begleiter.ts`).
 */
function verbindeDesktop(
  desktop: KuroDesktop,
  stimme: ReturnType<typeof createVoiceController>,
): void {
  document.body.classList.add("ist-desktop", `ist-${desktop.plattform}`);
  let zuletzt = 0;
  let vonTaste = false;
  let gehalten = false;
  desktop.beiSprechtaste((an) => {
    gehalten = an;
    zuletzt = Date.now();
    if (gehalten && !stimme.running) {
      vonTaste = true;
      stimme.toggle();
    }
    // Die Sprechtaste (`voice/sprechtaste.ts`) und Kuros Platz hören auf dieses Ereignis.
    globalThis.dispatchEvent(new CustomEvent("kuro:sprechtaste", { detail: { an } }));
  });
  desktop.beiInselOeffnen(() => globalThis.dispatchEvent(new Event("kuro:insel")));
  globalThis.setInterval(() => {
    if (
      vonTaste &&
      stimme.running &&
      !gehalten &&
      Date.now() - zuletzt > SPRACHE_SCHLAEFT_NACH_MS
    ) {
      vonTaste = false;
      stimme.stop();
    }
  }, 20_000);

  if (typeof Notification !== "undefined" && Notification.permission === "default") {
    void Notification.requestPermission();
  }
}

async function start(): Promise<void> {
  const params = new URLSearchParams(globalThis.location.search);
  const backend = resolveBackendOrigin(
    globalThis.location.hostname || "localhost",
    globalThis.location.protocol === "https:",
    params.get("events"),
  );
  if (loadToken() === null) {
    const lage = await holeLage(backend.http);
    if (lage.anmeldung) {
      document.body.classList.add("ist-vor-der-tuer");
      zeigeTuer(document.body, {
        baseUrl: backend.http,
        benutzer: lage.benutzer,
        poster: POSTER,
        onOffen: (token) => {
          saveToken(token);
          document.body.classList.remove("ist-vor-der-tuer");
          starte(backend);
        },
      });
      return;
    }
  }
  starte(backend);
}

void start();
