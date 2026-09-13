import { describe, expect, it } from "vitest";
import type { EventRecord } from "../runtime/events/log.js";
import {
  ORCHESTRATOR,
  type SessionEvents,
  dayKey,
  deriveAgentBySession,
  deriveAgentDaySpend,
  sumSpend,
} from "./costs.js";

let seq = 0;

function event(
  type: string,
  payload: Record<string, unknown>,
  createdAt: Date,
  sessionId = "s1",
): EventRecord {
  seq += 1;
  return {
    eventId: `e${seq}`,
    sessionId,
    seq,
    type,
    payload: payload as EventRecord["payload"],
    createdAt,
  };
}

function modelResponded(
  model: string,
  usage: Partial<Record<string, number>>,
  createdAt: Date,
  sessionId = "s1",
): EventRecord {
  return event(
    "model.responded",
    {
      model,
      usage: {
        input_tokens: usage.input ?? 0,
        output_tokens: usage.output ?? 0,
        cache_read_input_tokens: usage.cacheRead ?? 0,
        cache_creation_input_tokens: usage.cacheWrite ?? 0,
      },
    },
    createdAt,
    sessionId,
  );
}

/** Ein fester Zeitpunkt in lokaler Zeit — `dayKey` liest lokal, ein UTC-Literal wuerde je nach
 * Zeitzone auf den Vortag fallen und den Test ortsabhaengig machen. */
function localNoon(year: number, month: number, day: number): Date {
  return new Date(year, month - 1, day, 12, 0, 0);
}

describe("dayKey", () => {
  it("formatiert als YYYY-MM-DD", () => {
    expect(dayKey(localNoon(2026, 9, 13))).toBe("2026-09-13");
  });

  it("fuellt Monat und Tag auf zwei Stellen auf", () => {
    expect(dayKey(localNoon(2026, 1, 5))).toBe("2026-01-05");
  });
});

describe("deriveAgentBySession", () => {
  it("liest die Zuordnung aus agent.returned", () => {
    const sessions: SessionEvents[] = [
      {
        sessionId: "haupt",
        events: [
          event("agent.returned", { agent: "coder", worker_session: "w1" }, localNoon(2026, 9, 13)),
        ],
      },
    ];
    expect(deriveAgentBySession(sessions).get("w1")).toBe("coder");
  });

  it("ignoriert unvollstaendige Eintraege, statt zu werfen", () => {
    const sessions: SessionEvents[] = [
      {
        sessionId: "haupt",
        events: [event("agent.returned", { agent: "coder" }, localNoon(2026, 9, 13))],
      },
    ];
    expect(deriveAgentBySession(sessions).size).toBe(0);
  });
});

describe("deriveAgentDaySpend", () => {
  it("fuehrt eine Session ohne agent.returned unter ORCHESTRATOR", () => {
    const spend = deriveAgentDaySpend([
      {
        sessionId: "s1",
        events: [modelResponded("claude-opus-5", { input: 1_000_000 }, localNoon(2026, 9, 13))],
      },
    ]);
    expect(spend).toHaveLength(1);
    expect(spend[0]?.agent).toBe(ORCHESTRATOR);
    expect(spend[0]?.costUsd).toBeCloseTo(5, 10);
  });

  it("ordnet einen Arbeiter-Lauf seinem Agenten zu", () => {
    const spend = deriveAgentDaySpend([
      {
        sessionId: "haupt",
        events: [
          event("agent.returned", { agent: "coder", worker_session: "w1" }, localNoon(2026, 9, 13)),
        ],
      },
      {
        sessionId: "w1",
        events: [
          modelResponded("claude-sonnet-5", { input: 1_000_000 }, localNoon(2026, 9, 13), "w1"),
        ],
      },
    ]);
    expect(spend).toHaveLength(1);
    expect(spend[0]?.agent).toBe("coder");
    expect(spend[0]?.costUsd).toBeCloseTo(2, 10);
  });

  it("trennt nach Tag und nach Agent", () => {
    const spend = deriveAgentDaySpend([
      {
        sessionId: "haupt",
        events: [
          event("agent.returned", { agent: "coder", worker_session: "w1" }, localNoon(2026, 9, 13)),
          modelResponded("claude-opus-5", { input: 1_000_000 }, localNoon(2026, 9, 13), "haupt"),
          modelResponded("claude-opus-5", { input: 2_000_000 }, localNoon(2026, 9, 12), "haupt"),
        ],
      },
      {
        sessionId: "w1",
        events: [
          modelResponded("claude-sonnet-5", { input: 1_000_000 }, localNoon(2026, 9, 13), "w1"),
        ],
      },
    ]);
    expect(spend).toHaveLength(3);
    // Neueste Tage zuerst.
    expect(spend[0]?.day).toBe("2026-09-13");
    expect(spend[2]?.day).toBe("2026-09-12");
    const heute = spend.filter((entry) => entry.day === "2026-09-13");
    expect(heute.map((entry) => entry.agent).sort()).toEqual(["coder", ORCHESTRATOR]);
  });

  it("summiert mehrere Aufrufe desselben Tages und Agenten", () => {
    const spend = deriveAgentDaySpend([
      {
        sessionId: "s1",
        events: [
          modelResponded("claude-opus-5", { input: 1_000_000 }, localNoon(2026, 9, 13)),
          modelResponded("claude-opus-5", { output: 1_000_000 }, localNoon(2026, 9, 13)),
        ],
      },
    ]);
    expect(spend).toHaveLength(1);
    expect(spend[0]?.modelCalls).toBe(2);
    expect(spend[0]?.inputTokens).toBe(1_000_000);
    expect(spend[0]?.outputTokens).toBe(1_000_000);
    expect(spend[0]?.costUsd).toBeCloseTo(30, 10);
  });

  it("zaehlt ein unbepreistes Modell bei den Token mit, aber nicht beim Betrag", () => {
    const spend = deriveAgentDaySpend([
      {
        sessionId: "s1",
        events: [
          modelResponded("claude-opus-5", { input: 1_000_000 }, localNoon(2026, 9, 13)),
          modelResponded("ein-fremdes-modell", { input: 9_000_000 }, localNoon(2026, 9, 13)),
        ],
      },
    ]);
    expect(spend[0]?.costUsd).toBeCloseTo(5, 10);
    expect(spend[0]?.inputTokens).toBe(10_000_000);
    expect(spend[0]?.unpricedCalls).toBe(1);
    expect(spend[0]?.unpricedModels).toEqual(["ein-fremdes-modell"]);
  });

  it("nennt einen Aufruf ohne Modellangabe beim Namen, statt ihn zu verschlucken", () => {
    const spend = deriveAgentDaySpend([
      {
        sessionId: "s1",
        events: [event("model.responded", { usage: {} }, localNoon(2026, 9, 13))],
      },
    ]);
    expect(spend[0]?.unpricedCalls).toBe(1);
    expect(spend[0]?.unpricedModels).toEqual(["(ohne Modellangabe)"]);
  });

  it("liefert nichts fuer ein Protokoll ohne Modellaufrufe", () => {
    const spend = deriveAgentDaySpend([
      { sessionId: "s1", events: [event("turn.started", {}, localNoon(2026, 9, 13))] },
    ]);
    expect(spend).toEqual([]);
  });

  it("kommt mit einem fehlenden usage-Feld zurecht", () => {
    const spend = deriveAgentDaySpend([
      {
        sessionId: "s1",
        events: [event("model.responded", { model: "claude-opus-5" }, localNoon(2026, 9, 13))],
      },
    ]);
    expect(spend[0]?.modelCalls).toBe(1);
    expect(spend[0]?.costUsd).toBe(0);
  });
});

describe("sumSpend", () => {
  it("summiert Betrag, Aufrufe und unbepreiste Aufrufe", () => {
    const spend = deriveAgentDaySpend([
      {
        sessionId: "s1",
        events: [
          modelResponded("claude-opus-5", { input: 1_000_000 }, localNoon(2026, 9, 13)),
          modelResponded("fremd", { input: 1_000_000 }, localNoon(2026, 9, 12)),
        ],
      },
    ]);
    expect(sumSpend(spend)).toEqual({
      costUsd: expect.closeTo(5, 10),
      modelCalls: 2,
      unpricedCalls: 1,
    });
  });

  it("summiert eine leere Liste zu null", () => {
    expect(sumSpend([])).toEqual({ costUsd: 0, modelCalls: 0, unpricedCalls: 0 });
  });
});
