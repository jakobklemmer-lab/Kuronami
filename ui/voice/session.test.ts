import { describe, expect, it } from "vitest";
import { createMicStateStore } from "../mic/state.js";
import {
  type VoiceApproval,
  type VoiceLatency,
  type VoiceSocketLike,
  createVoiceSession,
  parseVoiceMessage,
  toAgentState,
} from "./session.js";

/**
 * Der Sprach-Client ohne Browser und ohne Netz — derselbe Zuschnitt wie `ui/events/bus.test.ts`:
 * der Draht wird hereingereicht, die Nachrichten werden von Hand eingespeist.
 */

class FakeSocket implements VoiceSocketLike {
  binaryType = "";
  sent: (string | ArrayBufferLike | ArrayBufferView)[] = [];
  closed: { code?: number; reason?: string } | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.onclose?.({ code, reason });
  }
  /** Der Server schickt etwas. */
  emit(data: unknown): void {
    this.onmessage?.({ data });
  }
  emitJson(message: unknown): void {
    this.emit(JSON.stringify(message));
  }
  get texts(): string[] {
    return this.sent.filter((entry): entry is string => typeof entry === "string");
  }
}

function setup(extra: Partial<Parameters<typeof createVoiceSession>[0]> = {}) {
  const socket = new FakeSocket();
  const mic = createMicStateStore();
  const errors: string[] = [];
  const session = createVoiceSession({
    url: "ws://test/voice",
    token: "geheim",
    mic,
    socketFactory: () => socket,
    onError: (message) => errors.push(message),
    ...extra,
  });
  return { socket, mic, session, errors };
}

/** Nur die `ready`-Nachricht, ohne die Verbindung zu öffnen. */
function readyMessage(socket: FakeSocket): void {
  socket.emitJson({
    type: "ready",
    mode: "loopback",
    audio_in_sample_rate: 16000,
    audio_out_sample_rate: 24000,
    latency_budget_ms: 800,
  });
}

/** Verbindung offen **und** angemeldet — der übliche Ausgangspunkt. */
function ready(socket: FakeSocket): void {
  socket.onopen?.();
  readyMessage(socket);
}

describe("Anmeldung", () => {
  it("schickt das Geheimnis als erste Nachricht", () => {
    const { socket, session } = setup();
    session.connect();
    socket.onopen?.();
    expect(JSON.parse(socket.texts[0])).toEqual({ type: "hello", token: "geheim" });
  });

  it("kennt die Abtastraten erst, wenn der Server sie genannt hat", () => {
    const { socket, session } = setup();
    session.connect();
    socket.onopen?.();
    expect(session.audioOutSampleRate).toBeNull();
    readyMessage(socket);
    expect(session.status).toBe("ready");
    expect(session.audioInSampleRate).toBe(16000);
    expect(session.audioOutSampleRate).toBe(24000);
  });

  it("schickt kein Audio, bevor die Anmeldung durch ist", () => {
    const { socket, session } = setup();
    session.connect();
    socket.onopen?.();
    session.sendAudio(new Uint8Array([1, 2, 3, 4]));
    expect(socket.sent).toHaveLength(1); // nur das hello
    readyMessage(socket);
    session.sendAudio(new Uint8Array([1, 2, 3, 4]));
    expect(socket.sent).toHaveLength(2);
  });
});

describe("Zustände", () => {
  it("setzt die Zustandsquelle des Mic-Knopfes aus der Pipeline", () => {
    const { socket, mic, session } = setup();
    session.connect();
    ready(socket);

    socket.emitJson({ type: "state", state: "listening" });
    expect(mic.state).toBe("listening");
    socket.emitJson({ type: "state", state: "thinking" });
    expect(mic.state).toBe("thinking");
    socket.emitJson({ type: "state", state: "speaking" });
    expect(mic.state).toBe("speaking");
  });

  it("übernimmt keinen Zustand, den der Mic-Knopf nicht kennt", () => {
    const { socket, mic, session } = setup();
    session.connect();
    ready(socket);
    mic.set("thinking");
    socket.emitJson({ type: "state", state: "grübelnd" });
    expect(mic.state).toBe("thinking");
  });

  it("fällt beim Trennen auf idle zurück", () => {
    const { socket, mic, session } = setup();
    session.connect();
    ready(socket);
    mic.set("speaking");
    socket.onclose?.({ code: 1006 });
    expect(mic.state).toBe("idle");
    expect(session.status).toBe("closed");
  });

  it("verbindet sich nach einem Abriss nicht von selbst wieder", () => {
    let built = 0;
    const socket = new FakeSocket();
    const session = createVoiceSession({
      url: "ws://test/voice",
      token: "t",
      mic: createMicStateStore(),
      socketFactory: () => {
        built += 1;
        return socket;
      },
    });
    session.connect();
    socket.onclose?.({ code: 1006 });
    expect(built).toBe(1);
  });
});

describe("Nachrichten", () => {
  it("reicht Zwischen- und Endstand des Transkripts weiter", () => {
    const seen: [string, boolean][] = [];
    const { socket, session } = setup({
      onTranscript: (text, final) => seen.push([text, final]),
    });
    session.connect();
    ready(socket);
    socket.emitJson({ type: "transcript", text: "Was steht", final: false });
    socket.emitJson({ type: "transcript", text: "Was steht heute an?", final: true });
    expect(seen).toEqual([
      ["Was steht", false],
      ["Was steht heute an?", true],
    ]);
  });

  it("reicht eine Freigabeanfrage mit ihren Optionen weiter", () => {
    const seen: VoiceApproval[] = [];
    const { socket, session } = setup({ onApproval: (approval) => seen.push(approval) });
    session.connect();
    ready(socket);
    socket.emitJson({
      type: "approval",
      askId: "policy:call-1",
      question: "Darf ich?",
      options: [
        { id: "ja", label: "Ja" },
        { id: "nein", label: "Nein" },
      ],
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].askId).toBe("policy:call-1");
    expect(seen[0].options.map((option) => option.id)).toEqual(["ja", "nein"]);
  });

  it("beantwortet eine Freigabe per Klick", () => {
    const { socket, session } = setup();
    session.connect();
    ready(socket);
    session.answer("policy:call-1", "ja");
    expect(JSON.parse(socket.texts.at(-1) as string)).toEqual({
      type: "answer",
      askId: "policy:call-1",
      choiceId: "ja",
    });
  });

  it("liest den Latenzbericht in die Form der Oberfläche", () => {
    const seen: VoiceLatency[] = [];
    const { socket, session } = setup({ onLatency: (latency) => seen.push(latency) });
    session.connect();
    ready(socket);
    socket.emitJson({
      type: "latency",
      turn_id: "t1",
      voice_layer_ms: 312.5,
      total_ms: 2100.0,
      budget_ms: 800,
      within_budget: true,
    });
    expect(seen[0]).toEqual({
      turnId: "t1",
      voiceLayerMs: 312.5,
      totalMs: 2100,
      budgetMs: 800,
      withinBudget: true,
    });
  });

  it("meldet einen unvollständigen Latenzbericht als unvollständig", () => {
    const seen: VoiceLatency[] = [];
    const { socket, session } = setup({ onLatency: (latency) => seen.push(latency) });
    session.connect();
    ready(socket);
    socket.emitJson({
      type: "latency",
      turn_id: "t1",
      voice_layer_ms: null,
      total_ms: null,
      budget_ms: 800,
      within_budget: null,
    });
    expect(seen[0].withinBudget).toBeNull();
    expect(seen[0].totalMs).toBeNull();
  });

  it("gibt einen Fehler weiter, statt ihn zu verschlucken", () => {
    const { socket, session, errors } = setup();
    session.connect();
    ready(socket);
    socket.emitJson({ type: "error", message: "Das Sitzungsgeheimnis stimmt nicht." });
    expect(errors).toEqual(["Das Sitzungsgeheimnis stimmt nicht."]);
  });

  it("meldet die Unterbrechung an die Wiedergabe", () => {
    let interrupted = 0;
    const { socket, session } = setup({
      onInterrupted: () => {
        interrupted += 1;
      },
    });
    session.connect();
    ready(socket);
    socket.emitJson({ type: "interrupted" });
    expect(interrupted).toBe(1);
  });

  it("reicht Audio als rohen Puffer weiter", () => {
    const chunks: ArrayBuffer[] = [];
    const { socket, session } = setup({ onAudio: (chunk) => chunks.push(chunk) });
    session.connect();
    ready(socket);
    socket.emit(new Uint8Array([1, 2, 3, 4]).buffer);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].byteLength).toBe(4);
  });

  it("ignoriert einen unbekannten Nachrichtentyp", () => {
    const { socket, session, errors } = setup();
    session.connect();
    ready(socket);
    socket.emitJson({ type: "vollmond", phase: "zunehmend" });
    expect(errors).toEqual([]);
    expect(session.status).toBe("ready");
  });
});

describe("Rahmen lesen", () => {
  it("liest gültiges JSON mit Typ", () => {
    expect(parseVoiceMessage('{"type":"state","state":"idle"}')).toEqual({
      type: "state",
      state: "idle",
    });
  });

  it("gibt bei kaputtem JSON null zurück, statt zu werfen", () => {
    expect(parseVoiceMessage("{kaputt")).toBeNull();
  });

  it("verlangt einen Typ", () => {
    expect(parseVoiceMessage('{"state":"idle"}')).toBeNull();
  });

  it("erkennt nur die sechs bekannten Zustände", () => {
    expect(toAgentState("speaking")).toBe("speaking");
    expect(toAgentState("complete")).toBe("complete");
    expect(toAgentState("dozing")).toBeNull();
    expect(toAgentState(42)).toBeNull();
  });
});
