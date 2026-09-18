import { describe, expect, it } from "vitest";
import type { EventPayload, EventRecord } from "../runtime/events/log.js";
import type { ModelContentBlock, ModelMessage } from "../runtime/model/types.js";
import {
  TranscriptError,
  assertReplayable,
  assertSendable,
  deriveLoopState,
  renderTurnOpening,
} from "./transcript.js";

/**
 * Die Faltung ohne Datenbank. Sie ist eine reine Funktion über Ereignisse, und genau deshalb
 * lässt sie sich so prüfen: jeder Fall, den ein abgeschossener Prozess hinterlässt, ist hier
 * ein Array von sechs Zeilen statt eines gespawnten Kindprozesses. Der echte Absturz wird
 * trotzdem gefahren (`loop-restart.test.ts`) — hier steht, was die Faltung daraus macht.
 */

const SESSION = "sess_test";
let seq = 0;

function ev(type: string, payload: EventPayload): EventRecord {
  seq += 1;
  return {
    eventId: `event_${seq}`,
    sessionId: SESSION,
    seq,
    type,
    payload,
    createdAt: new Date(1_700_000_000_000 + seq * 1000),
  };
}

function turnStarted(turnId: string, prompt: string): EventRecord {
  return ev("turn.started", { turn_id: turnId, input: prompt, prompt });
}

function modelResponded(
  turnId: string,
  calls: Array<{ callId: string; toolName: string }>,
  extra: ModelContentBlock[] = [],
): EventRecord {
  return ev("model.responded", {
    turn_id: turnId,
    stop_reason: calls.length > 0 ? "tool_use" : "end_turn",
    text: "",
    content: [
      ...extra,
      ...calls.map((call) => ({
        type: "tool_use",
        id: call.callId,
        name: call.toolName.replace(".", "__"),
        input: {},
      })),
    ],
    tool_calls: calls.map((call) => ({
      call_id: call.callId,
      tool_name: call.toolName,
      input: {},
    })),
  });
}

function stepCompleted(stepId: string, hull: unknown): EventRecord {
  return ev("step.completed", { step_id: stepId, result: hull });
}

function toolCompleted(callId: string, stepId: string | null, hull?: unknown): EventRecord {
  return ev("tool.completed", {
    call_id: callId,
    tool_name: "fs.write",
    step_id: stepId,
    summary: "ok",
    ...(stepId === null ? { result: hull } : {}),
  });
}

function toolFailed(callId: string, summary: string): EventRecord {
  return ev("tool.failed", {
    call_id: callId,
    tool_name: "fs.write",
    risk: "soft_write",
    summary,
    reason: "handler_failed",
    error: "Error: kaputt\n    at test",
  });
}

function okHull(summary: string, offloaded = false) {
  return {
    status: "ok",
    summary,
    structured: offloaded ? { offloaded: true, uri: "artifact://x/y" } : { done: true },
    artifact_refs: offloaded ? ["artifact://x/y"] : [],
    preview: [],
  };
}

function blocksOf(message: ModelMessage | undefined): ModelContentBlock[] {
  return message?.content ?? [];
}

describe("Historie · Faltung über das Protokoll", () => {
  it("macht aus turn.started die Eröffnungsnachricht mit Zustand und Eingabe", () => {
    const prompt = renderTurnOpening("Plan (1 Aufgaben):\n- [queued] a: A", "Mach A");
    const state = deriveLoopState([turnStarted("turn_1", prompt)]);

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].role).toBe("user");
    expect(blocksOf(state.messages[0])[0]).toEqual({ type: "text", text: prompt });
    // Beide Abschnitte des Auftrags stehen in der Nachricht, nicht im System-Prompt.
    expect(prompt).toContain("<session_state>");
    expect(prompt).toContain("<user_input>");
    expect(prompt.indexOf("<session_state>")).toBeLessThan(prompt.indexOf("<user_input>"));
    expect(state.turnId).toBe("turn_1");
  });

  it("reicht die Blöcke einer Modellantwort unverändert durch, samt Denkblock", () => {
    const thinking: ModelContentBlock = {
      type: "thinking",
      thinking: "",
      signature: "Ab3/cD4+eF5=",
    };
    const state = deriveLoopState([
      turnStarted("turn_1", "los"),
      modelResponded("turn_1", [{ callId: "call_1", toolName: "fs.write" }], [thinking]),
    ]);

    const assistant = state.messages[1];
    expect(assistant.role).toBe("assistant");
    // Genau so, wie er kam. Ein Denkblock trägt eine Signatur, die der Anbieter beim
    // Zurückreichen prüft — würde die Faltung ihn neu bauen, bräche der nächste Zug.
    expect(blocksOf(assistant)[0]).toEqual(thinking);
    expect(blocksOf(assistant)[1]).toMatchObject({ type: "tool_use", id: "call_1" });
  });

  it("holt die Hülle eines Schritt-Tools aus dem step.completed", () => {
    const hull = okHull("Datei geschrieben");
    const state = deriveLoopState([
      turnStarted("turn_1", "los"),
      modelResponded("turn_1", [{ callId: "call_1", toolName: "fs.write" }]),
      stepCompleted("step_1", hull),
      toolCompleted("call_1", "step_1"),
    ]);

    const result = blocksOf(state.messages[2])[0];
    expect(result.type).toBe("tool_result");
    expect(result.tool_use_id).toBe("call_1");
    expect(result.is_error).toBe(false);
    expect(JSON.parse(result.content as string)).toEqual(hull);
  });

  it("holt die Hülle eines Runtime-Tools aus dem tool.completed, das keinen Schritt hat", () => {
    const hull = okHull("Antwort: Variante A");
    const state = deriveLoopState([
      turnStarted("turn_1", "los"),
      modelResponded("turn_1", [{ callId: "call_1", toolName: "user.ask" }]),
      toolCompleted("call_1", null, hull),
    ]);

    expect(JSON.parse(blocksOf(state.messages[2])[0].content as string)).toEqual(hull);
  });

  it("hält einen fehlgeschlagenen Aufruf im Kontext sichtbar, mit Grund und Stacktrace", () => {
    const state = deriveLoopState([
      turnStarted("turn_1", "los"),
      modelResponded("turn_1", [{ callId: "call_1", toolName: "fs.write" }]),
      toolFailed("call_1", "Pfad verlässt die erlaubten Zonen"),
    ]);

    const result = blocksOf(state.messages[2])[0];
    expect(result.is_error).toBe(true);
    const hull = JSON.parse(result.content as string);
    expect(hull.status).toBe("error");
    expect(hull.summary).toBe("Pfad verlässt die erlaubten Zonen");
    // Nicht geglättet (AGENTS.md): Grund und Wortlaut stehen dem Modell zur Verfügung.
    expect(hull.structured.reason).toBe("handler_failed");
    expect(hull.structured.error).toContain("kaputt");
    expect(state.consecutiveErrors).toBe(1);
  });

  it("fasst mehrere Ergebnisse zu genau einer Nachricht zusammen", () => {
    const state = deriveLoopState([
      turnStarted("turn_1", "los"),
      modelResponded("turn_1", [
        { callId: "call_1", toolName: "fs.write" },
        { callId: "call_2", toolName: "fs.write" },
      ]),
      stepCompleted("step_1", okHull("eins")),
      toolCompleted("call_1", "step_1"),
      stepCompleted("step_2", okHull("zwei")),
      toolCompleted("call_2", "step_2"),
    ]);

    // Zwei Ergebnisse, eine Nachricht. Sie auf zwei zu verteilen brächte dem Modell bei,
    // keine nebenläufigen Aufrufe mehr zu machen.
    expect(state.messages).toHaveLength(3);
    expect(blocksOf(state.messages[2])).toHaveLength(2);
    expect(state.toolCalls).toBe(2);
  });

  it("nennt genau die Aufrufe offen, zu denen kein Ergebnis im Protokoll steht", () => {
    const state = deriveLoopState([
      turnStarted("turn_1", "los"),
      modelResponded("turn_1", [
        { callId: "call_1", toolName: "fs.write" },
        { callId: "call_2", toolName: "fs.read" },
        { callId: "call_3", toolName: "fs.list" },
      ]),
      stepCompleted("step_1", okHull("eins")),
      toolCompleted("call_1", "step_1"),
    ]);

    // Genau der Zustand nach einem Absturz mitten in einer Runde nebenläufiger Aufrufe.
    expect(state.pending.map((entry) => entry.callId)).toEqual(["call_2", "call_3"]);
    expect(state.pending[0].toolName).toBe("fs.read");
  });

  it("setzt Zähler und offene Aufrufe bei einem neuen Zug zurück", () => {
    const state = deriveLoopState([
      turnStarted("turn_1", "erst"),
      modelResponded("turn_1", [{ callId: "call_1", toolName: "fs.write" }]),
      toolFailed("call_1", "kaputt"),
      ev("turn.completed", { turn_id: "turn_1", stop: "error_rate" }),
      turnStarted("turn_2", "dann"),
    ]);

    expect(state.turnId).toBe("turn_2");
    expect(state.toolCalls).toBe(0);
    expect(state.consecutiveErrors).toBe(0);
    expect(state.pending).toEqual([]);
    // Die Historie bleibt vollständig: der alte Fehlschlag ist weiterhin sichtbar.
    expect(state.messages).toHaveLength(4);
  });

  it("zählt Fehler in Folge und setzt sie bei einem Erfolg zurück", () => {
    const state = deriveLoopState([
      turnStarted("turn_1", "los"),
      modelResponded("turn_1", [
        { callId: "call_1", toolName: "fs.write" },
        { callId: "call_2", toolName: "fs.write" },
        { callId: "call_3", toolName: "fs.write" },
      ]),
      toolFailed("call_1", "eins"),
      stepCompleted("step_2", okHull("zwei")),
      toolCompleted("call_2", "step_2"),
      toolFailed("call_3", "drei"),
    ]);

    expect(state.toolCalls).toBe(3);
    // Zwei Fehler insgesamt, aber nur einer am Stück — genau die Unterscheidung, an der die
    // Abbruchbedingung "Fehlerhäufung" hängt.
    expect(state.consecutiveErrors).toBe(1);
  });

  it("zählt ausgelagerte Ergebnisse für die Kennzahl aus Abschnitt 12", () => {
    const state = deriveLoopState([
      turnStarted("turn_1", "los"),
      modelResponded("turn_1", [
        { callId: "call_1", toolName: "fs.read" },
        { callId: "call_2", toolName: "fs.read" },
      ]),
      stepCompleted("step_1", okHull("groß", true)),
      toolCompleted("call_1", "step_1"),
      stepCompleted("step_2", okHull("klein")),
      toolCompleted("call_2", "step_2"),
    ]);

    expect(state.offloadedResults).toBe(1);
  });

  it("überspringt unbekannte Ereignistypen", () => {
    const state = deriveLoopState([
      turnStarted("turn_1", "los"),
      ev("policy.allowed", { call_id: "call_1" }),
      ev("artifact.created", { uri: "artifact://a/b" }),
      ev("agent.delegated", { agent: "x" }),
    ]);
    expect(state.messages).toHaveLength(1);
  });

  it("überspringt einen Aufruf ohne vorangehenden tool_use (Nachlauf-Zusammenfassung)", () => {
    // Der Fall aus dem Betrieb (2026-09-16): `summarizeRun` schreibt nach `turn.completed` eine
    // Notiz über `memory.write` (origin run_summary, call_id `memory_summary_<turn>`). Das
    // erzeugt ein `tool.completed`, das zu keinem `tool_use` des Modells gehört. Ohne die
    // pending-Prüfung landete es als verwaistes `tool_result` in der Historie und die nächste
    // Anfrage scheiterte mit 400.
    const state = deriveLoopState([
      turnStarted("turn_1", "los"),
      modelResponded("turn_1", [{ callId: "call_1", toolName: "fs.write" }]),
      stepCompleted("step_1", okHull("geschrieben")),
      toolCompleted("call_1", "step_1"),
      modelResponded("turn_1", []),
      ev("turn.completed", { turn_id: "turn_1", stop: "end_turn" }),
      // Nach dem Zug: die Zusammenfassung. Kein tool_use ging ihr voraus.
      ev("tool.requested", {
        call_id: "memory_summary_turn_1",
        tool_name: "memory.write",
        origin: "run_summary",
      }),
      toolCompleted("memory_summary_turn_1", null, okHull("Notiz abgelegt")),
      turnStarted("turn_2", "weiter"),
    ]);

    const hasOrphan = state.messages.some((message) =>
      message.content.some(
        (block) =>
          (block as { type?: string }).type === "tool_result" &&
          (block as { tool_use_id?: string }).tool_use_id === "memory_summary_turn_1",
      ),
    );
    expect(hasOrphan).toBe(false);
    expect(() => assertSendable(state.messages)).not.toThrow();
  });

  it("wirft, wenn ein tool.completed auf einen Schritt ohne Ergebnis zeigt", () => {
    expect(() =>
      deriveLoopState([
        turnStarted("turn_1", "los"),
        modelResponded("turn_1", [{ callId: "call_1", toolName: "fs.write" }]),
        toolCompleted("call_1", "step_verschwunden"),
      ]),
    ).toThrow(TranscriptError);
  });

  it("wirft, wenn eine Modellantwort ohne Inhaltsblöcke im Protokoll steht", () => {
    expect(() =>
      deriveLoopState([
        turnStarted("turn_1", "los"),
        ev("model.responded", { turn_id: "turn_1", text: "hallo" }),
      ]),
    ).toThrow(/Inhaltsblöcke/);
  });
});

describe("Historie · Sendbarkeit", () => {
  it("weist eine Historie mit einem Aufruf ohne Ergebnis ab", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: "los" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "fs__write", input: {} }],
      },
    ];
    expect(() => assertSendable(messages)).toThrow(/ohne Ergebnis/);
    expect(() => assertSendable(messages)).toThrow(/call_1/);
  });

  it("lässt eine vollständige Historie durch", () => {
    expect(() =>
      assertSendable([
        { role: "user", content: [{ type: "text", text: "los" }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "fs__write", input: {} }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_1", content: "{}", is_error: false }],
        },
      ]),
    ).not.toThrow();
  });
});

describe("Historie · Unverändertheit nach dem Redaction-Filter", () => {
  const sent: ModelContentBlock[] = [
    { type: "thinking", thinking: "", signature: "sig-abc" },
    { type: "text", text: "Schlüssel ist sk-ant-api03-XXXXXXXXXXXXXXXXXXXX" },
    { type: "tool_use", id: "call_1", name: "fs__write", input: { path: "a" } },
  ];

  it("lässt einen ersetzten Text durch — dafür ist der Filter da", () => {
    const stored = [
      sent[0],
      { type: "text", text: "Schlüssel ist [redacted:anthropic-api-key]" },
      sent[2],
    ];
    expect(() => assertReplayable(sent, stored)).not.toThrow();
  });

  it("weist eine veränderte Signatur ab", () => {
    const stored = [{ ...sent[0], signature: "[redacted:credential-field]" }, sent[1], sent[2]];
    expect(() => assertReplayable(sent, stored)).toThrow(/signature/);
  });

  it("weist eine veränderte Aufrufkennung ab", () => {
    const stored = [sent[0], sent[1], { ...sent[2], id: "anders" }];
    // Die Kennung wird zum Idempotenzschlüssel. Verändert, liefe derselbe Seiteneffekt
    // zweimal — der Bruch fiele erst beim nächsten Zug auf.
    expect(() => assertReplayable(sent, stored)).toThrow(/id/);
  });

  it("weist eine veränderte Blockzahl ab", () => {
    expect(() => assertReplayable(sent, [sent[0], sent[1]])).toThrow(/Blöcke/);
  });
});
