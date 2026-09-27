import type { MicStateStore } from "../mic/state.js";
import {
  type MicrophoneHandle,
  type SpeakerHandle,
  createSpeaker,
  startMicrophone,
} from "./audio.js";
import { type VoiceApproval, type VoiceSession, createVoiceSession } from "./session.js";
import { type Sprechtaste, createSprechtaste, hatTastatur } from "./sprechtaste.js";

/**
 * Der Knopf und die Sprachschicht, zusammengesteckt (S30/S31).
 *
 * Diese Datei hält den einen Zustand, den es dabei zu halten gibt — läuft eine Sitzung oder
 * nicht — und sorgt dafür, dass zu einer Sitzung immer **drei** Dinge gehören: die Verbindung,
 * das offene Mikrofon und der Lautsprecher. Zwei davon ohne das dritte ist jedes Mal ein Fehler:
 * eine Verbindung ohne Mikrofon hört nichts, ein Mikrofon ohne Verbindung nimmt auf, ohne dass
 * es jemand bestellt hat.
 *
 * Das Mikrofon geht **erst nach `ready`** auf, also nach der Anmeldung. Der Browser fragt dann
 * zwar zweimal kurz hintereinander (Verbindung, dann Erlaubnis), aber ein Mikrofon, das
 * aufgeht, bevor klar ist, ob die Gegenstelle einen überhaupt hereinlässt, wäre die falsche
 * Reihenfolge.
 */

export interface VoiceControllerOptions {
  mic: MicStateStore;
  /**
   * Adresse der Sprachschicht, bei jedem Druck neu gefragt — wie `token`. Ein Wert, der beim
   * Start eingefroren wird, wäre falsch, sobald er aus einer Quelle kommt, die später eintrifft
   * (die Selbstkonfiguration vom Gateway) oder sich ändert (die Einstellungen).
   */
  url: () => string | null;
  /** `VOICE_SESSION_TOKEN`. Ohne ihn wird gar nicht erst verbunden. */
  token: () => string | null;
  /** Alles, was der Nutzer sehen soll: Fehler, Transkript, Antwort. */
  notify: (message: string) => void;
  onTranscript?: (text: string, final: boolean) => void;
  onReply?: (text: string) => void;
  onApproval?: (approval: VoiceApproval) => void;
  /** Nur zuhören, solange die Leertaste gedrückt ist — die Einstellung, bei jedem Block gefragt. */
  sprechtaste?: () => boolean;
}

export interface VoiceController {
  /** Startet oder beendet die Sitzung — der Handgriff hinter dem Mic-Knopf. */
  toggle(): void;
  stop(): void;
  readonly running: boolean;
  /** Die laufende Sitzung, solange es eine gibt. Für die Freigabe per Klick. */
  readonly session: VoiceSession | null;
}

export function createVoiceController(options: VoiceControllerOptions): VoiceController {
  let session: VoiceSession | null = null;
  let microphone: MicrophoneHandle | null = null;
  let speaker: SpeakerHandle | null = null;
  let starting = false;
  let taste: Sprechtaste | null = null;
  const tasteGilt = () => (options.sprechtaste?.() ?? false) && hatTastatur();

  async function openDevices(current: VoiceSession): Promise<void> {
    const inRate = current.audioInSampleRate;
    const outRate = current.audioOutSampleRate;
    if (inRate === null || outRate === null) return;

    speaker = createSpeaker(outRate);
    const t = createSprechtaste({
      aktiv: tasteGilt,
      // Nur die Anzeige; den Zustand von Kuro (hört, denkt, spricht) setzt weiter die Pipeline.
      onWechsel: (offen) => document.body.classList.toggle("ist-sprechtaste", offen),
    });
    taste = t;
    if (tasteGilt())
      options.notify("Leertaste halten zum Sprechen — Kuro hört nur, solange sie gedrückt ist.");
    try {
      microphone = await startMicrophone({
        sampleRate: inRate,
        onChunk: (pcm) => current.sendAudio(t.filtere(pcm)),
      });
    } catch (error) {
      // Abgelehnte Mikrofonerlaubnis ist kein Absturz, aber auch keine laufende Sitzung.
      options.notify(
        `Kein Zugriff auf das Mikrofon: ${error instanceof Error ? error.message : String(error)}`,
      );
      stop();
    }
  }

  function stop(): void {
    const openSession = session;
    const openMic = microphone;
    const openSpeaker = speaker;
    taste?.beende();
    taste = null;
    session = null;
    microphone = null;
    speaker = null;
    openSession?.close();
    void openMic?.stop();
    void openSpeaker?.close();
    options.mic.set("idle");
  }

  return {
    toggle(): void {
      if (session !== null || starting) {
        stop();
        starting = false;
        return;
      }

      const token = options.token();
      if (token === null || token.length === 0) {
        // Normalerweise kommt der Token vom Gateway, ohne dass jemand etwas eintippt. Fehlt er
        // trotzdem, ist die Sprachschicht serverseitig nicht eingerichtet — dann hilft ein
        // eigener Wert in den Einstellungen, nicht der Hinweis, dass einer fehlt.
        options.notify(
          "Die Sprachschicht ist nicht eingerichtet (kein VOICE_SESSION_TOKEN am Gateway). Ein eigener Wert steht unter Einstellungen › Sprache.",
        );
        return;
      }

      starting = true;
      const created = createVoiceSession({
        url: options.url() ?? undefined,
        token,
        mic: options.mic,
        onTranscript: options.onTranscript,
        onReply: options.onReply,
        onApproval: options.onApproval,
        onError: options.notify,
        onInterrupted: () => speaker?.flush(),
        onAudio: (chunk) => speaker?.play(chunk),
        onStatus: (status) => {
          if (status === "ready") {
            starting = false;
            void openDevices(created);
          }
          if (status === "closed" && session === created) stop();
        },
      });
      session = created;
      created.connect();
    },

    stop,

    get running(): boolean {
      return session !== null;
    },
    get session(): VoiceSession | null {
      return session;
    },
  };
}
