import { describe, expect, it } from "vitest";
import type { EventPayload, EventRecord } from "../events/log.js";
import { type RunStatus, deriveRunStatus } from "./run-status.js";
import { deriveSessionState } from "./state.js";

const SESSION_ID = "sess_test";

function log(...entries: Array<[type: string, payload?: EventPayload]>): EventRecord[] {
  return entries.map(([type, payload], index) => ({
    eventId: `event_${index + 1}`,
    sessionId: SESSION_ID,
    seq: index + 1,
    type,
    payload: payload ?? {},
    createdAt: new Date(2026, 8, 12, 10, 0, index),
  }));
}

function statusOf(events: EventRecord[]): RunStatus {
  return deriveRunStatus(events, deriveSessionState(SESSION_ID, events));
}

describe("deriveRunStatus", () => {
  it("ist queued, solange kein Prozess die Session aufgenommen hat", () => {
    expect(statusOf(log(["session.created"]))).toBe("queued");
  });

  it("ist ready, wenn ein Prozess angehängt ist, aber noch kein Zug begann", () => {
    expect(statusOf(log(["session.created"], ["runtime.started"]))).toBe("ready");
  });

  it("ist running, sobald ein Zug begonnen hat", () => {
    expect(statusOf(log(["session.created"], ["runtime.started"], ["turn.started"]))).toBe(
      "running",
    );
  });

  it("ist blocked, solange eine Delegation ohne agent.returned offensteht", () => {
    const events = log(
      ["session.created"],
      ["runtime.started"],
      ["turn.started"],
      ["agent.delegated", { call_id: "call_1" }],
    );
    expect(statusOf(events)).toBe("blocked");
  });

  it("kehrt nach agent.returned zu running zurück", () => {
    const events = log(
      ["session.created"],
      ["runtime.started"],
      ["turn.started"],
      ["agent.delegated", { call_id: "call_1" }],
      ["agent.returned", { call_id: "call_1" }],
    );
    expect(statusOf(events)).toBe("running");
  });

  it("ist awaiting_user, solange eine Rückfrage offensteht — auch vor jedem Zug", () => {
    const events = log(
      ["session.created"],
      [
        "approval.requested",
        { ask_id: "ask:1", question: "Welche?", options: [{ id: "a", label: "A" }] },
      ],
    );
    expect(statusOf(events)).toBe("awaiting_user");
  });

  it("lässt einen Terminalzustand über jede offene Delegation gewinnen", () => {
    const events = log(
      ["session.created"],
      ["runtime.started"],
      ["turn.started"],
      ["agent.delegated", { call_id: "call_1" }],
      ["session.canceled"],
    );
    expect(statusOf(events)).toBe("canceled");
  });

  it("gibt completed und failed unverändert aus SessionStatus weiter", () => {
    expect(statusOf(log(["session.created"], ["session.completed"]))).toBe("completed");
    expect(statusOf(log(["session.created"], ["session.failed"]))).toBe("failed");
  });
});
