import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPool } from "../db/pool.js";
import { readEvents } from "../events/log.js";
import { type StepEffect, executeStep } from "../steps/hull.js";
import { cancelSession } from "./lifecycle.js";
import { createOrResumeSession } from "./manager.js";
import { readSessionState, readStepSnapshot, replaySession } from "./state.js";

const pool = createPool();
const threadIds: string[] = [];

/**
 * Der Seiteneffekt-Zähler. Er steht für alles, was ein Schritt draußen anrichtet: eine
 * verschickte Mail, eine geschriebene Datei, ein abgesetzter Auftrag. Gezählt wird beim
 * Eintritt in den Effekt, damit auch ein Effekt, der am Zeitfenster scheitert und
 * weiterläuft, genau einmal in der Zählung steht.
 */
const effects = { calls: 0, keys: [] as string[] };

beforeEach(() => {
  effects.calls = 0;
  effects.keys = [];
});

function dummyEffect(value: Record<string, unknown>): StepEffect {
  return async (context) => {
    effects.calls += 1;
    effects.keys.push(context.idempotencyKey);
    return { ...value, attempt: context.attempt } as never;
  };
}

function failingEffect(message: string): StepEffect {
  return async (context) => {
    effects.calls += 1;
    effects.keys.push(context.idempotencyKey);
    throw new Error(message);
  };
}

const hangingEffect: StepEffect = (context) =>
  new Promise((resolve) => {
    effects.calls += 1;
    effects.keys.push(context.idempotencyKey);
    context.signal.addEventListener("abort", () => resolve({ aborted: true }), { once: true });
  });

async function newSession(channel: "web" | "telegram" = "web"): Promise<string> {
  const threadId = `thread_test_${randomUUID()}`;
  threadIds.push(threadId);
  const { session } = await createOrResumeSession(pool, { threadId, channel });
  return session.sessionId;
}

afterAll(async () => {
  if (threadIds.length > 0) {
    const sessions = "SELECT session_id FROM kuronami.sessions WHERE thread_id = ANY($1)";
    await pool.query(`DELETE FROM kuronami.steps WHERE session_id IN (${sessions})`, [threadIds]);
    await pool.query(`DELETE FROM kuronami.events WHERE session_id IN (${sessions})`, [threadIds]);
    await pool.query("DELETE FROM kuronami.sessions WHERE thread_id = ANY($1)", [threadIds]);
  }
  await pool.end();
});

describe("Replay", () => {
  it("stellt den Endzustand aus dem Protokoll her, ohne einen Seiteneffekt auszulösen", async () => {
    const sessionId = await newSession();

    // Ein Lauf mit allen Ausgängen, die ein Schritt nehmen kann. Nur den Sonnenschein-Pfad
    // nachzuspielen, bewiese wenig: gerade Fehlschlag, Wiederholung und Zeitfenster sind
    // die Stellen, an denen Snapshot und Protokoll auseinanderlaufen könnten.
    await executeStep(
      pool,
      { sessionId, idempotencyKey: "web.search:quellen", kind: "tool_call", repeatable: true },
      dummyEffect({ hits: 7 }),
    );
    await executeStep(
      pool,
      {
        sessionId,
        idempotencyKey: "fs.write:notiz",
        kind: "tool_call",
        toolName: "fs.write",
        repeatable: true,
      },
      dummyEffect({ bytes: 214 }),
    );

    // Fehlschlag und danach ein zweiter Versuch am selben Schlüssel.
    const flaky = {
      sessionId,
      idempotencyKey: "web.fetch:wackelig",
      kind: "tool_call" as const,
      toolName: "web.fetch",
      repeatable: true,
    };
    await executeStep(pool, flaky, failingEffect("Verbindung zurückgesetzt"));
    await executeStep(pool, flaky, dummyEffect({ bytes: 4096 }));

    // Ein Schritt, der endgültig scheitert.
    await executeStep(
      pool,
      {
        sessionId,
        idempotencyKey: "exec.run:kaputt",
        kind: "tool_call",
        toolName: "exec.run",
        repeatable: false,
      },
      failingEffect("Kommando nicht gefunden"),
    );

    // Und einer, den das Zeitfenster beendet.
    await executeStep(
      pool,
      {
        sessionId,
        idempotencyKey: "web.fetch:haengt",
        kind: "tool_call",
        toolName: "web.fetch",
        repeatable: true,
        timeoutMs: 60,
      },
      hangingEffect,
    );

    // Ein Aufruf am schon abgeschlossenen Schlüssel: der Seiteneffekt entfällt.
    await executeStep(pool, flaky, dummyEffect({ bytes: 4096 }));

    expect(effects.calls).toBe(6);
    const live = await readSessionState(pool, sessionId);
    expect(live.steps.map((step) => step.status)).toEqual([
      "completed",
      "completed",
      "completed",
      "failed",
      "failed",
    ]);
    expect(live.steps.map((step) => step.attempt)).toEqual([1, 1, 2, 1, 1]);

    // Ab hier zählt jeder Seiteneffekt, der noch losgeht.
    effects.calls = 0;
    effects.keys = [];

    const replayed = await replaySession(pool, sessionId);

    expect(effects.calls).toBe(0);
    expect(effects.keys).toEqual([]);
    expect(replayed).toEqual(live);

    // Die eigentliche Aussage steckt in den Schritten: dort stehen zwei unabhängig
    // geschriebene Wege nebeneinander — die Zeilen, die der Lauf per UPDATE hinterlassen
    // hat, und die Faltung über das Protokoll. Fehlte im Protokoll auch nur ein Feld,
    // ginge diese Gleichheit verloren.
    expect(replayed.steps).toEqual(await readStepSnapshot(pool, sessionId));
    expect(replayed.steps.map((step) => step.result)).toEqual([
      { hits: 7, attempt: 1 },
      { bytes: 214, attempt: 1 },
      { bytes: 4096, attempt: 2 },
      null,
      null,
    ]);
    expect(replayed.steps[3].error).toContain("Kommando nicht gefunden");
    expect(replayed.steps[4].error).toContain("Zeitfenster von 60 ms");

    // "Wiederholung muss deterministisch sein" (Abschnitt 6, Regel 2): dieselbe Faltung
    // über dasselbe Protokoll ergibt dasselbe Ergebnis, beliebig oft.
    expect(await replaySession(pool, sessionId)).toEqual(replayed);
    expect(effects.calls).toBe(0);
  });

  it("stellt auch einen abgebrochenen Lauf her, ohne einen Seiteneffekt auszulösen", async () => {
    const sessionId = await newSession("telegram");

    await executeStep(
      pool,
      { sessionId, idempotencyKey: "fs.read:eins", kind: "tool_call", repeatable: true },
      dummyEffect({ lines: 12 }),
    );
    await cancelSession(pool, sessionId, "user_request");

    expect(effects.calls).toBe(1);
    const live = await readSessionState(pool, sessionId);

    effects.calls = 0;
    effects.keys = [];
    const replayed = await replaySession(pool, sessionId);

    expect(effects.calls).toBe(0);
    expect(replayed.status).toBe("canceled");
    expect(live.status).toBe("canceled");
    expect(replayed).toEqual(live);
  });

  it("leitet den Zustand aus dem Protokoll ab und nicht aus der Schritt-Tabelle", async () => {
    const sessionId = await newSession();
    await executeStep(
      pool,
      { sessionId, idempotencyKey: "fs.write:beleg", kind: "tool_call", repeatable: true },
      dummyEffect({ bytes: 3 }),
    );

    const beforeDrop = await replaySession(pool, sessionId);
    // Gegenprobe: der Snapshot ist abgeleitet und entbehrlich, das Protokoll ist es nicht
    // (Abschnitt 4.4). Ohne die Zeilen muss dieselbe Herleitung dasselbe ergeben.
    await pool.query("DELETE FROM kuronami.steps WHERE session_id = $1", [sessionId]);

    expect(await readStepSnapshot(pool, sessionId)).toEqual([]);
    expect(await replaySession(pool, sessionId)).toEqual(beforeDrop);
    expect(effects.calls).toBe(1);
  });

  it("ignoriert Ereignisse, die nichts über Schritte sagen", async () => {
    const sessionId = await newSession();
    await executeStep(
      pool,
      { sessionId, idempotencyKey: "fs.read:zwei", kind: "tool_call", repeatable: true },
      dummyEffect({ lines: 1 }),
    );

    const types = (await readEvents(pool, sessionId)).map((event) => event.type);
    expect(types).toContain("session.created");

    // runtime.*, turn.*, model.* und die übrigen Namensräume tragen nichts zum Zustand bei.
    // Die Herleitung muss sie überspringen, ohne daran zu scheitern — die Taxonomie wächst.
    const state = await replaySession(pool, sessionId);
    expect(state.steps).toHaveLength(1);
    expect(state.status).toBe("running");
  });
});
