import type { MicStateStore } from "../mic/state.js";
import {
  type MicrophoneHandle,
  type SpeakerHandle,
  createSpeaker,
  startMicrophone,
} from "./audio.js";
import { type VoiceApproval, type VoiceSession, createVoiceSession } from "./session.js";

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
  /** Adresse der Sprachschicht. Leer = die Vorgabe aus `session.ts`. */
  url?: string;
  /** `VOICE_SESSION_TOKEN`. Ohne ihn wird gar nicht erst verbunden. */
  token: () => string | null;
  /** Alles, was der Nutzer sehen soll: Fehler, Transkript, Antwort. */
  notify: (message: string) => void;
  onTranscript?: (text: string, final: boolean) => void;
  onReply?: (text: string) => void;
  onApproval?: (approval: VoiceApproval) => void;
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

  async function openDevices(current: VoiceSession): Promise<void> {
    const inRate = current.audioInSampleRate;
    const outRate = current.audioOutSampleRate;
    if (inRate === null || outRate === null) return;

    speaker = createSpeaker(outRate);
    try {
      microphone = await startMicrophone({
        sampleRate: inRate,
        onChunk: (pcm) => current.sendAudio(pcm),
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
        options.notify(
          "Kein Sitzungs-Token für die Sprachschicht hinterlegt — unter Einstellungen › Sprache eintragen.",
        );
        return;
      }

      starting = true;
      const created = createVoiceSession({
        url: options.url,
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
