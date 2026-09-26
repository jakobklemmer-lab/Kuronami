import { createApiClient } from "../api/client.js";
import { holeLage } from "../auth/anmeldung.js";
import { resolveBackendOrigin } from "../backend-origin.js";
import { createEventBus } from "../events/bus.js";
import { createMicStateStore } from "../mic/state.js";
import { oberflaecheZiel } from "../oberflaeche.js";
import { loadToken, saveToken } from "../settings.js";
import { loadSettings } from "../settings/store.js";
import { createVoiceController } from "../voice/controller.js";
import { mountWelle } from "./app.js";
import { oeffneGespraech } from "./gespraech.js";
import { zeigeTuer } from "./tuer.js";

/**
 * Der Einstieg der Welle — die einzige Datei hier, die `document` und `location` von Grund auf
 * anfasst: Tür, Gateway-Adresse, Ereignisstrom, Sprachschicht, und dann die Welle selbst.
 *
 * Dieselbe Reihenfolge wie in der Präsenz (`ui/main.ts`): kein Ticket im Browser **und** ein
 * Gateway, der eine Anmeldung verlangt — dann zuerst die Tür. Der Seitenspeicher ist derselbe
 * (`kuronami.webToken`), wer in der Präsenz angemeldet ist, ist es hier auch.
 */

const POSTER = "./film/poster.jpg";

function element(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Die Seite der Welle hat kein Element mit der id "${id}".`);
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

function starteWelle(backend: ReturnType<typeof resolveBackendOrigin>): void {
  const toast = toaster(element("w-toast"));
  const bus = createEventBus({ url: backend.ws });

  // Läuft die Sitzung ab, antwortet jeder Aufruf mit 401. Dann kommt die Tür zurück — einmal,
  // nicht einmal je Tafel.
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

  // Die Sprachschicht wie in der Präsenz: Adresse und Sitzungsgeheimnis bei jedem Druck frisch
  // aus den Einstellungen, sonst selbst abgeleitet bzw. vom Gateway.
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
    token: () => loadSettings().speech.sessionToken ?? sprachToken,
    notify: toast,
    // Was Jakob sagt, steht als seine Frage im Gespräch; Kuros Antwort kommt über den Strom.
    onTranscript: (text, final) => {
      if (final && text.length > 0) gespraech.gesprochen(text);
    },
    onReply: (text) => gespraech.nachtrag(text),
    onApproval: (freigabe) => {
      toast(`Kuro fragt: ${freigabe.question}`);
    },
  });

  mountWelle({
    root: element("welle"),
    api,
    bus,
    mic,
    gespraech,
    voice: { toggle: () => stimme.toggle() },
    toast,
  });
  bus.connect();
}

async function start(): Promise<void> {
  // Ist in den Einstellungen „Standard" gewählt, gilt die Präsenz unter `/`.
  const ziel = oberflaecheZiel(
    globalThis.location.pathname,
    globalThis.location.hash,
    loadSettings().appearance.oberflaeche,
  );
  if (ziel) {
    globalThis.location.replace(ziel);
    return;
  }
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
          starteWelle(backend);
        },
      });
      return;
    }
  }
  starteWelle(backend);
}

void start();
