import { describe, expect, it } from "vitest";
import type { EventPayload, EventRecord } from "../events/log.js";
import { deriveSessionState } from "./state.js";

/**
 * Die Faltung direkt, ohne Datenbank und ohne Replay-Mechanismus. Der Test in
 * `replay.test.ts` vergleicht zwei unabhängig geschriebene Wege (UPDATE gegen Faltung) und
 * ist damit ein Korrektheitsvergleich; er kann aber nur Protokolle prüfen, die die Hülle
 * gerade erzeugt. Hier steht das Protokoll von Hand, samt der Fälle, die im Normalbetrieb
 * selten oder gar nicht vorkommen. Das ist die eigentliche Fehlerfläche der Herleitung.
 */

const SESSION_ID = "sess_test";
const T0 = new Date("2026-09-05T10:00:00.000Z");

/** Sekunden nach T0, damit die Reihenfolge im Test sichtbar statt gewürfelt ist. */
function at(seconds: number): Date {
  return new Date(T0.getTime() + seconds * 1_000);
}

function log(...entries: Array<[type: string, payload: EventPayload, seconds?: number]>) {
  return entries.map(([type, payload, seconds], index) => ({
    eventId: `event_${index + 1}`,
    sessionId: SESSION_ID,
    seq: index + 1,
    type,
    payload,
    createdAt: at(seconds ?? index),
  })) satisfies EventRecord[];
}

function started(stepId: string, attempt = 1, overrides: EventPayload = {}): EventPayload {
  return {
    step_id: stepId,
    idempotency_key: `key:${stepId}`,
    kind: "tool_call",
    tool_name: "dummy.effect",
    repeatable: true,
    attempt,
    timeout_ms: 60_000,
    ...overrides,
  };
}

describe("Herleitung des Zustands aus dem Protokoll", () => {
  it("liest den Sessionstatus aus den Sessionereignissen", () => {
    const running = deriveSessionState(SESSION_ID, log(["session.created", {}]));
    expect(running.status).toBe("running");
    expect(running.sessionId).toBe(SESSION_ID);

    expect(
      deriveSessionState(SESSION_ID, log(["session.created", {}], ["session.completed", {}]))
        .status,
    ).toBe("completed");
    expect(
      deriveSessionState(SESSION_ID, log(["session.created", {}], ["session.failed", {}])).status,
    ).toBe("failed");
    expect(
      deriveSessionState(SESSION_ID, log(["session.created", {}], ["session.canceled", {}])).status,
    ).toBe("canceled");

    // Eine Wiederaufnahme setzt den Lauf zurück auf laufend. Für einen abgebrochenen Lauf
    // kommt diese Folge nicht vor — `resumeSession` weist ihn ab —, aber die Herleitung
    // darf an einem Protokoll nicht scheitern, das sie nicht selbst erzeugt hat.
    expect(
      deriveSessionState(
        SESSION_ID,
        log(["session.created", {}], ["session.failed", {}], ["session.resumed", {}]),
      ).status,
    ).toBe("running");
  });

  it("hält einen Schritt von seinem Start bis zum Abschluss fest", () => {
    const state = deriveSessionState(
      SESSION_ID,
      log(
        ["session.created", {}],
        ["step.started", started("step_a")],
        ["step.completed", { step_id: "step_a", attempt: 1, result: { bytes: 12 } }],
      ),
    );

    expect(state.steps).toHaveLength(1);
    expect(state.steps[0]).toEqual({
      stepId: "step_a",
      sessionId: SESSION_ID,
      idempotencyKey: "key:step_a",
      kind: "tool_call",
      toolName: "dummy.effect",
      status: "completed",
      attempt: 1,
      repeatable: true,
      result: { bytes: 12 },
      error: null,
      artifactRefs: [],
      createdAt: at(1),
      startedAt: at(1),
      endedAt: at(2),
    });
  });

  it("setzt beim zweiten Versuch Ergebnis, Fehler und Ende zurück, behält aber die Entstehung", () => {
    const state = deriveSessionState(
      SESSION_ID,
      log(
        ["session.created", {}],
        ["step.started", started("step_a", 1)],
        ["step.failed", { step_id: "step_a", attempt: 1, error: "Netzwerk weg" }],
        ["step.started", started("step_a", 2)],
        ["step.completed", { step_id: "step_a", attempt: 2, result: { bytes: 7 } }],
      ),
    );

    const step = state.steps[0];
    expect(step.status).toBe("completed");
    expect(step.attempt).toBe(2);
    expect(step.result).toEqual({ bytes: 7 });
    // Der Fehler des ersten Versuchs gilt nicht mehr, genau wie RETRY_STEP_SQL ihn löscht.
    expect(step.error).toBeNull();
    // Entstanden ist der Schritt beim ersten Start, begonnen zuletzt beim zweiten.
    expect(step.createdAt).toEqual(at(1));
    expect(step.startedAt).toEqual(at(3));
    expect(step.endedAt).toEqual(at(4));
  });

  it("zeigt einen laufenden zweiten Versuch ohne die Spuren des ersten", () => {
    // Das Protokoll endet auf einem step.started ohne Gegenstück: so sieht es aus, wenn ein
    // Prozess während des zweiten Versuchs abgeschossen wird. Nur in diesem Fenster ist das
    // Zurücksetzen bei step.started überhaupt beobachtbar — sobald ein Terminalereignis
    // folgt, überschreibt es Ergebnis und Fehler ohnehin. Genau hier muss die Herleitung
    // mit RETRY_STEP_SQL übereinstimmen, das error, result und ended_at leert; täte sie es
    // nicht, trüge die Wiederaufnahme den Fehler des ersten Versuchs weiter.
    const state = deriveSessionState(
      SESSION_ID,
      log(
        ["session.created", {}],
        ["step.started", started("step_a", 1)],
        ["step.failed", { step_id: "step_a", attempt: 1, error: "Netzwerk weg" }],
        ["step.started", started("step_a", 2)],
      ),
    );

    const step = state.steps[0];
    expect(step.status).toBe("running");
    expect(step.attempt).toBe(2);
    expect(step.error).toBeNull();
    expect(step.result).toBeNull();
    expect(step.endedAt).toBeNull();
    expect(step.createdAt).toEqual(at(1));
    expect(step.startedAt).toEqual(at(3));
  });

  it("nimmt das letzte Schritt-Ereignis, wenn ein Abbruch überholt wurde", () => {
    // Der Abbruch schließt einen laufenden Schritt, dessen Ausführer danach noch seinen
    // zweiten Checkpoint erreicht. Beides steht im Protokoll; das Spätere gilt, weil der
    // Schritt tatsächlich zu Ende lief. Das Protokoll behält recht, nicht der Abbruch.
    const state = deriveSessionState(
      SESSION_ID,
      log(
        ["session.created", {}],
        ["step.started", started("step_a")],
        ["session.canceled", { reason: "user_request" }],
        ["step.canceled", { step_id: "step_a", attempt: 1, error: "Session abgebrochen" }],
        [
          "step.completed",
          { step_id: "step_a", attempt: 1, result: { sent: true }, after_cancel: true },
        ],
      ),
    );

    expect(state.status).toBe("canceled");
    expect(state.steps[0].status).toBe("completed");
    expect(state.steps[0].result).toEqual({ sent: true });
    expect(state.steps[0].error).toBeNull();
  });

  it("übernimmt artifact_refs aus dem Ereignis, sobald sie darin stehen", () => {
    // Heute schreibt sie niemand, die Vorgabe ist die leere Liste. Ab S06 füllt der
    // Artefaktspeicher die Spalte; kommen sie dann nicht ins Ereignis, läuft der Snapshot
    // der Herleitung davon. Der Weg steht schon, damit das auffällt statt still zu bleiben.
    const ohne = deriveSessionState(
      SESSION_ID,
      log(["step.started", started("step_a")], ["step.completed", { step_id: "step_a" }]),
    );
    expect(ohne.steps[0].artifactRefs).toEqual([]);

    const mit = deriveSessionState(
      SESSION_ID,
      log(
        ["step.started", started("step_a")],
        ["step.completed", { step_id: "step_a", artifact_refs: ["artifact://notiz.md"] }],
      ),
    );
    expect(mit.steps[0].artifactRefs).toEqual(["artifact://notiz.md"]);
  });

  it("überspringt Ereignisse, die nichts über Schritte oder Sessionzustand sagen", () => {
    const state = deriveSessionState(
      SESSION_ID,
      log(
        ["session.created", {}],
        ["runtime.started", { runtime_id: "run_1" }],
        ["turn.started", {}],
        ["model.requested", {}],
        ["tool.completed", {}],
        ["policy.allowed", {}],
        // Ein Typ, den es heute nicht gibt. Die Taxonomie wächst, und eine Herleitung, die
        // an einem unbekannten Typ scheiterte, machte jeden neuen Typ zum Bruch.
        ["kuenftig.erfunden", { irgendwas: true }],
        ["runtime.stopped", { runtime_id: "run_1" }],
      ),
    );

    expect(state.status).toBe("running");
    expect(state.steps).toEqual([]);
  });

  it("sortiert Schritte nach Entstehung und entscheidet Gleichstand über die step_id", () => {
    const state = deriveSessionState(
      SESSION_ID,
      log(
        ["step.started", started("step_c"), 5],
        // Gleicher Zeitstempel wie step_b: ohne zweites Kriterium hinge die Reihenfolge an
        // der Laune der Datenbank statt an einer Regel.
        ["step.started", started("step_z"), 1],
        ["step.started", started("step_b"), 1],
      ),
    );

    expect(state.steps.map((step) => step.stepId)).toEqual(["step_b", "step_z", "step_c"]);
  });

  it("wirft, wenn ein Schritt-Ereignis keinen Start im Protokoll hat", () => {
    expect(() =>
      deriveSessionState(
        SESSION_ID,
        log(["session.created", {}], ["step.completed", { step_id: "step_geist" }]),
      ),
    ).toThrow(/kein step\.started/);
  });

  it("wirft, wenn ein Schritt-Ereignis die Felder nicht trägt, aus denen der Zustand folgt", () => {
    expect(() => deriveSessionState(SESSION_ID, log(["step.started", { attempt: 1 }]))).toThrow(
      /ohne verwertbares Feld "step_id"/,
    );
    expect(() =>
      deriveSessionState(SESSION_ID, log(["step.started", { step_id: "step_a", attempt: 1 }])),
    ).toThrow(/ohne verwertbares Feld "idempotency_key"/);
    expect(() =>
      deriveSessionState(
        SESSION_ID,
        log(["step.started", started("step_a")], ["step.failed", { error: "weg" }]),
      ),
    ).toThrow(/ohne verwertbares Feld "step_id"/);
  });
});

describe("Rückfragen an den Nutzer (awaiting_user)", () => {
  const OPTIONS = [
    { id: "a", label: "Variante A" },
    { id: "b", label: "Variante B" },
  ];

  function requested(askId: string, question = "Welche Variante?"): EventPayload {
    return { ask_id: askId, kind: "user_ask", question, options: OPTIONS };
  }

  it("faltet einen offenen approval.requested zu awaiting_user samt der Frage", () => {
    const state = deriveSessionState(
      SESSION_ID,
      log(["session.created", {}], ["approval.requested", requested("ask:1")]),
    );

    expect(state.status).toBe("awaiting_user");
    expect(state.pendingUserInput).toEqual([
      { askId: "ask:1", question: "Welche Variante?", options: OPTIONS },
    ]);
    // Kein Schritt: user.ask läuft nicht über die Hülle.
    expect(state.steps).toEqual([]);
  });

  it("kehrt nach approval.granted zu running zurück", () => {
    const state = deriveSessionState(
      SESSION_ID,
      log(
        ["session.created", {}],
        ["approval.requested", requested("ask:1")],
        ["approval.granted", { ask_id: "ask:1", choice: "b", choice_label: "Variante B" }],
      ),
    );

    expect(state.status).toBe("running");
    expect(state.pendingUserInput).toEqual([]);
  });

  it("kehrt auch nach approval.denied zu running zurück", () => {
    const state = deriveSessionState(
      SESSION_ID,
      log(
        ["session.created", {}],
        ["approval.requested", requested("ask:1")],
        ["approval.denied", { ask_id: "ask:1", reason: "verworfen" }],
      ),
    );
    expect(state.status).toBe("running");
    expect(state.pendingUserInput).toEqual([]);
  });

  it("führt mehrere offene Rückfragen, sortiert nach ask_id", () => {
    const state = deriveSessionState(
      SESSION_ID,
      log(
        ["session.created", {}],
        ["approval.requested", requested("ask:z", "Zuerst?")],
        ["approval.requested", requested("ask:a", "Dann?")],
      ),
    );
    expect(state.pendingUserInput.map((entry) => entry.askId)).toEqual(["ask:a", "ask:z"]);
    expect(state.status).toBe("awaiting_user");
  });

  it("lässt einen Terminalzustand gewinnen: eine abgebrochene Session wartet nicht", () => {
    const state = deriveSessionState(
      SESSION_ID,
      log(
        ["session.created", {}],
        ["approval.requested", requested("ask:1")],
        ["session.canceled", { reason: "user_request" }],
      ),
    );
    // Der Status ist canceled, nicht awaiting_user — aber die offene Rückfrage bleibt sichtbar.
    expect(state.status).toBe("canceled");
    expect(state.pendingUserInput).toHaveLength(1);
  });

  it("verträgt ein approval.granted ohne vorheriges approval.requested", () => {
    const state = deriveSessionState(
      SESSION_ID,
      log(["session.created", {}], ["approval.granted", { ask_id: "ask:weg", choice: "a" }]),
    );
    expect(state.status).toBe("running");
    expect(state.pendingUserInput).toEqual([]);
  });

  it("wirft, wenn ein approval.requested die Felder für eine Rückfrage nicht trägt", () => {
    expect(() =>
      deriveSessionState(
        SESSION_ID,
        log(["approval.requested", { question: "?", options: OPTIONS }]),
      ),
    ).toThrow(/ohne verwertbares Feld "ask_id"/);
    expect(() =>
      deriveSessionState(
        SESSION_ID,
        log(["approval.requested", { ask_id: "ask:1", options: OPTIONS }]),
      ),
    ).toThrow(/ohne verwertbares Feld "question"/);
    // Fließtext-Optionen sind keine strukturierten Optionen (Abschnitt 10).
    expect(() =>
      deriveSessionState(
        SESSION_ID,
        log(["approval.requested", { ask_id: "ask:1", question: "?", options: ["a", "b"] }]),
      ),
    ).toThrow(/verwertbare "options"/);
  });
});
