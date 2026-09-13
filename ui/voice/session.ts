import { AGENT_STATES, type AgentState, type MicStateStore } from "../mic/state.js";

/**
 * Der Sprach-Client der Oberfläche (S30/S31) — die Gegenstelle des Python-Prozesses unter
 * `voice/`.
 *
 * Bis hierher war der Mic-Knopf eine Anzeige ohne Gegenstück: `ui/mic/state.ts` sagte selbst,
 * die sechs Zustände seien "vorerst gegen Mock schaltbar, bis eine echte Spracherkennung
 * (S30/S31) dahintersteht". Diese Datei ist das Dahinterstehen. Sie erfindet **keinen** Zustand:
 * `state`-Nachrichten kommen aus der Pipeline, und die Pipeline setzt sie an den Stellen, an
 * denen wirklich etwas passiert.
 *
 * **Vier der sechs Zustände kommen von dort** — `idle`, `listening`, `thinking`, `speaking`.
 * `executing` und `complete` bleiben, was sie waren: Zustände, die der Ereignisstrom (S21) viel
 * genauer kennt als ein Sprachprozess hinter einem HTTP-Aufruf. Wer sie hier fabrizierte, baute
 * eine Anzeige, die rät.
 *
 * **Zwei Sorten Nachricht auf dem Draht** (siehe `voice/pipeline/protocol.py`): Binärrahmen sind
 * rohes PCM, Textrahmen sind JSON mit einem `type`. Der Client kennt genau die Typen, die dort
 * aufgezählt sind, und **ignoriert alles andere** — dieselbe Haltung wie `signalFor` im
 * Ereignisbus: ein unbekannter Typ ist kein Fehler, er ist nur nichts.
 *
 * Wie überall in `ui/` ist der Draht austauschbar (`socketFactory`), damit dieses Modul ohne
 * Browser und ohne Netz prüfbar bleibt.
 */

export type VoiceStatus = "closed" | "connecting" | "open" | "ready";

export interface VoiceApprovalOption {
  id: string;
  label: string;
}

export interface VoiceApproval {
  askId: string;
  question: string;
  options: VoiceApprovalOption[];
}

export interface VoiceLatency {
  turnId: string;
  voiceLayerMs: number | null;
  totalMs: number | null;
  budgetMs: number;
  withinBudget: boolean | null;
}

/** Das Stück `WebSocket`, das dieser Client tatsächlich benutzt — inklusive `send`, anders als
 * beim nur lesenden Ereignisbus. */
export interface VoiceSocketLike {
  binaryType: string;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface VoiceSessionOptions {
  /** Vorgabe: `ws://<host des Dokuments>:8790`. */
  url?: string;
  /** Das gemeinsame Geheimnis der Sprachschicht (`VOICE_SESSION_TOKEN`). */
  token: string;
  /** Die eine Zustandsquelle des Mic-Knopfes. Wird von den `state`-Nachrichten gesetzt. */
  mic: MicStateStore;
  socketFactory?: (url: string) => VoiceSocketLike;
  onTranscript?: (text: string, final: boolean) => void;
  onReply?: (text: string) => void;
  onApproval?: (approval: VoiceApproval) => void;
  onLatency?: (latency: VoiceLatency) => void;
  onInterrupted?: () => void;
  onError?: (message: string) => void;
  onStatus?: (status: VoiceStatus) => void;
  /** Ein Audio-Block der Stimme, roh. Die Abtastrate steht in `audioOutSampleRate`. */
  onAudio?: (chunk: ArrayBuffer) => void;
}

export interface VoiceSession {
  connect(): void;
  close(): void;
  /** Mikrofon-PCM hinaus. Vor `ready` wird nichts geschickt — es hörte niemand zu. */
  sendAudio(chunk: ArrayBufferLike | ArrayBufferView): void;
  /** Eine Freigabe per Klick beantworten, statt sie zu sprechen. */
  answer(askId: string, choiceId: string): void;
  readonly status: VoiceStatus;
  /** Erst nach `ready` bekannt — vorher gibt es keinen ehrlichen Wert. */
  readonly audioInSampleRate: number | null;
  readonly audioOutSampleRate: number | null;
}

export const DEFAULT_VOICE_PORT = 8790;

function defaultUrl(): string {
  const host =
    typeof globalThis.location === "object" && globalThis.location !== null
      ? globalThis.location.hostname || "localhost"
      : "localhost";
  return `ws://${host}:${DEFAULT_VOICE_PORT}`;
}

/** Liest einen Textrahmen. Wirft nicht — was sich nicht lesen lässt, ist `null`. */
export function parseVoiceMessage(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;
  return typeof candidate.type === "string" && candidate.type.length > 0 ? candidate : null;
}

/** Ist das ein Zustand, den der Mic-Knopf kennt? Ein fremder Name wird nicht angezeigt. */
export function toAgentState(value: unknown): AgentState | null {
  return typeof value === "string" && (AGENT_STATES as readonly string[]).includes(value)
    ? (value as AgentState)
    : null;
}

function toApproval(message: Record<string, unknown>): VoiceApproval | null {
  const askId = message.askId;
  if (typeof askId !== "string") return null;
  const rawOptions = Array.isArray(message.options) ? message.options : [];
  return {
    askId,
    question: typeof message.question === "string" ? message.question : askId,
    options: rawOptions
      .filter(
        (entry): entry is VoiceApprovalOption =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as VoiceApprovalOption).id === "string",
      )
      .map((entry) => ({ id: entry.id, label: entry.label ?? entry.id })),
  };
}

function toLatency(message: Record<string, unknown>): VoiceLatency {
  const number = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  return {
    turnId: typeof message.turn_id === "string" ? message.turn_id : "",
    voiceLayerMs: number(message.voice_layer_ms),
    totalMs: number(message.total_ms),
    budgetMs: number(message.budget_ms) ?? 0,
    withinBudget: typeof message.within_budget === "boolean" ? message.within_budget : null,
  };
}

export function createVoiceSession(options: VoiceSessionOptions): VoiceSession {
  const url = options.url ?? defaultUrl();
  const socketFactory =
    options.socketFactory ??
    ((target: string) => new WebSocket(target) as unknown as VoiceSocketLike);

  let socket: VoiceSocketLike | null = null;
  let status: VoiceStatus = "closed";
  let audioIn: number | null = null;
  let audioOut: number | null = null;

  function setStatus(next: VoiceStatus): void {
    if (next === status) return;
    status = next;
    options.onStatus?.(next);
  }

  function handle(message: Record<string, unknown>): void {
    switch (message.type) {
      case "ready": {
        audioIn =
          typeof message.audio_in_sample_rate === "number" ? message.audio_in_sample_rate : null;
        audioOut =
          typeof message.audio_out_sample_rate === "number" ? message.audio_out_sample_rate : null;
        setStatus("ready");
        break;
      }
      case "state": {
        const state = toAgentState(message.state);
        if (state) options.mic.set(state);
        break;
      }
      case "transcript":
        options.onTranscript?.(
          typeof message.text === "string" ? message.text : "",
          message.final === true,
        );
        break;
      case "reply":
        if (typeof message.text === "string" && message.text.length > 0) {
          options.onReply?.(message.text);
        }
        break;
      case "approval": {
        const approval = toApproval(message);
        if (approval) options.onApproval?.(approval);
        break;
      }
      case "latency":
        options.onLatency?.(toLatency(message));
        break;
      case "interrupted":
        options.onInterrupted?.();
        break;
      case "error":
        // Ein Fehler wird gezeigt, nicht zu "lädt …" geglättet (AGENTS.md).
        options.onError?.(typeof message.message === "string" ? message.message : "Unbekannt.");
        break;
      default:
        // Unbekannter Typ: nichts. Raten wäre schlimmer als schweigen.
        break;
    }
  }

  return {
    connect(): void {
      if (socket !== null) return;
      setStatus("connecting");
      const next = socketFactory(url);
      next.binaryType = "arraybuffer";
      socket = next;

      next.onopen = () => {
        setStatus("open");
        // Die Anmeldung ist die erste Nachricht. Bis sie durch ist, nimmt die Brücke kein
        // Transkript an (`voice/pipeline/bridge.py`).
        next.send(JSON.stringify({ type: "hello", token: options.token }));
      };
      next.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          options.onAudio?.(event.data);
          return;
        }
        const message = parseVoiceMessage(event.data);
        if (message !== null) handle(message);
      };
      next.onclose = () => {
        socket = null;
        audioIn = null;
        audioOut = null;
        setStatus("closed");
        // **Keine** Wiederverbindung, anders als beim Ereignisbus. Der Strom dort ist eine
        // Anzeige, die von selbst zurückkommen soll; eine Sprachsitzung ist eine Handlung des
        // Nutzers — sie ungefragt neu aufzumachen hieße, das Mikrofon ohne Auftrag wieder
        // einzuschalten.
        options.mic.set("idle");
      };
      next.onerror = () => {
        options.onError?.(`Die Sprachschicht unter ${url} ist nicht erreichbar.`);
      };
    },

    close(): void {
      const open = socket;
      socket = null;
      audioIn = null;
      audioOut = null;
      open?.close(1000, "Sprachsitzung beendet.");
      setStatus("closed");
      options.mic.set("idle");
    },

    sendAudio(chunk): void {
      if (socket === null || status !== "ready") return;
      socket.send(chunk);
    },

    answer(askId, choiceId): void {
      if (socket === null || status !== "ready") return;
      socket.send(JSON.stringify({ type: "answer", askId, choiceId }));
    },

    get status(): VoiceStatus {
      return status;
    },
    get audioInSampleRate(): number | null {
      return audioIn;
    },
    get audioOutSampleRate(): number | null {
      return audioOut;
    },
  };
}
