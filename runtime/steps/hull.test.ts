import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPool } from "../db/pool.js";
import { readEvents } from "../events/log.js";
import { cancelSession } from "../session/lifecycle.js";
import { createOrResumeSession } from "../session/manager.js";
import {
  SessionCanceledError,
  StepAlreadyRunningError,
  StepAttemptsExhaustedError,
  type StepEffect,
  StepNotRepeatableError,
  beginStep,
  executeStep,
} from "./hull.js";

const pool = createPool();
const threadIds: string[] = [];

/**
 * Der Dummy-Seiteneffekt dieser Tests. Gezählt wird beim Eintritt in den Effekt, nicht bei
 * seinem Ende: ein Effekt, der am Zeitfenster scheitert, läuft weiter und dürfte sonst
 * später ein zweites Mal in die Zählung rutschen.
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

/** Kommt nie von selbst zurück. Endet nur, wenn das Signal fällt — Zeitfenster oder Abbruch. */
const hangingEffect: StepEffect = (context) =>
  new Promise((resolve) => {
    effects.calls += 1;
    effects.keys.push(context.idempotencyKey);
    context.signal.addEventListener("abort", () => resolve({ aborted: true }), { once: true });
  });

function throwingEffect(message: string): StepEffect {
  return async (context) => {
    effects.calls += 1;
    effects.keys.push(context.idempotencyKey);
    throw new Error(message);
  };
}

async function newSession(): Promise<string> {
  const threadId = `thread_test_${randomUUID()}`;
  threadIds.push(threadId);
  const { session } = await createOrResumeSession(pool, { threadId, channel: "web" });
  return session.sessionId;
}

async function typesOf(sessionId: string): Promise<string[]> {
  return (await readEvents(pool, sessionId)).map((event) => event.type);
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

describe("Ausführungshülle", () => {
  it("führt den Seiteneffekt einmal aus, auch wenn derselbe Schlüssel zweimal kommt", async () => {
    const sessionId = await newSession();
    const spec = {
      sessionId,
      idempotencyKey: "mail.send:weekly-digest",
      kind: "tool_call" as const,
      toolName: "mail.send",
      repeatable: false,
    };

    const first = await executeStep(pool, spec, dummyEffect({ sent: true }));
    const second = await executeStep(pool, spec, dummyEffect({ sent: true }));

    expect(effects.calls).toBe(1);
    expect(first.executed).toBe(true);
    expect(second.executed).toBe(false);
    expect(second.result).toEqual(first.result);
    expect(second.step.stepId).toBe(first.step.stepId);
    expect(second.step.attempt).toBe(1);

    // Der zweite Aufruf hat nichts verändert und schreibt deshalb auch nichts.
    expect(await typesOf(sessionId)).toEqual(["session.created", "step.started", "step.completed"]);
  });

  it("beendet einen hängenden Schritt am Zeitfenster, statt auf ihn zu warten", async () => {
    const sessionId = await newSession();
    const started = Date.now();

    const outcome = await executeStep(
      pool,
      {
        sessionId,
        idempotencyKey: "web.fetch:hangs",
        kind: "tool_call",
        toolName: "web.fetch",
        repeatable: true,
        timeoutMs: 80,
      },
      hangingEffect,
    );

    // Ohne Zeitfenster käme dieser Aufruf nie zurück; der Test hinge, statt zu scheitern.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(outcome.status).toBe("error");
    expect(outcome.step.status).toBe("failed");
    expect(outcome.error).toMatch(/Zeitfenster von 80 ms/);

    const failed = (await readEvents(pool, sessionId)).at(-1);
    expect(failed?.type).toBe("step.failed");
    expect(failed?.payload.reason).toBe("timeout");
    // Ein Timeout ist kein sauberer Fehler: der Effekt läuft weiter, sein Ausgang draußen
    // ist unbekannt. Das steht im Protokoll, statt beschönigt zu werden.
    expect(failed?.payload.effect_outcome).toBe("unknown");
    expect(failed?.payload.effect_still_running).toBe(true);
  });

  it("hält den Fehlertext samt Stacktrace fest, in Zeile und Ereignis gleich", async () => {
    const sessionId = await newSession();

    const outcome = await executeStep(
      pool,
      {
        sessionId,
        idempotencyKey: "exec.run:kaputt",
        kind: "tool_call",
        toolName: "exec.run",
        repeatable: true,
      },
      throwingEffect("Kommando nicht gefunden: obsidian-cli"),
    );

    expect(outcome.status).toBe("error");
    expect(outcome.error).toContain("Kommando nicht gefunden: obsidian-cli");
    expect(outcome.error).toContain("at ");

    const failed = (await readEvents(pool, sessionId)).at(-1);
    expect(failed?.payload.error).toBe(outcome.step.error);
    expect(failed?.payload.reason).toBe("error");
  });

  it("lässt einen wiederholbaren Schritt einen zweiten Versuch machen", async () => {
    const sessionId = await newSession();
    const spec = {
      sessionId,
      idempotencyKey: "web.fetch:flaky",
      kind: "tool_call" as const,
      toolName: "web.fetch",
      repeatable: true,
    };

    const failed = await executeStep(pool, spec, throwingEffect("Netzwerk weg"));
    const passed = await executeStep(pool, spec, dummyEffect({ bytes: 12 }));

    expect(failed.status).toBe("error");
    expect(passed.status).toBe("ok");
    expect(passed.step.stepId).toBe(failed.step.stepId);
    expect(passed.step.attempt).toBe(2);
    expect(passed.result).toEqual({ bytes: 12, attempt: 2 });
    // Der zweite Versuch löscht das Ergebnis des ersten, hier also den Fehlertext.
    expect(passed.step.error).toBeNull();
    expect(effects.calls).toBe(2);
  });

  it("verweigert den zweiten Versuch eines nicht wiederholbaren Schritts", async () => {
    const sessionId = await newSession();
    const spec = {
      sessionId,
      idempotencyKey: "mail.send:einmalig",
      kind: "tool_call" as const,
      toolName: "mail.send",
      repeatable: false,
    };

    await executeStep(pool, spec, throwingEffect("Verbindung abgebrochen"));

    // Auch ein Effekt, der eine Ausnahme wirft, kann vorher die Mail verschickt haben. Ob
    // ein zweiter Versuch gefahrlos wäre, weiß die Hülle nicht und rät es auch nicht.
    await expect(executeStep(pool, spec, dummyEffect({ sent: true }))).rejects.toThrow(
      StepNotRepeatableError,
    );
    expect(effects.calls).toBe(1);
    expect(await typesOf(sessionId)).toEqual(["session.created", "step.started", "step.failed"]);
  });

  it("hält die Obergrenze der Versuche aus Abschnitt 13 ein", async () => {
    const sessionId = await newSession();
    const spec = {
      sessionId,
      idempotencyKey: "web.fetch:immer-kaputt",
      kind: "tool_call" as const,
      toolName: "web.fetch",
      repeatable: true,
      maxAttempts: 2,
    };

    await executeStep(pool, spec, throwingEffect("weg"));
    await executeStep(pool, spec, throwingEffect("weg"));

    await expect(executeStep(pool, spec, throwingEffect("weg"))).rejects.toThrow(
      StepAttemptsExhaustedError,
    );
    expect(effects.calls).toBe(2);
  });

  it("startet nach dem Abbruch der Session keinen Schritt mehr", async () => {
    const sessionId = await newSession();
    await cancelSession(pool, sessionId, "test");

    await expect(
      executeStep(
        pool,
        {
          sessionId,
          idempotencyKey: "fs.write:danach",
          kind: "tool_call",
          toolName: "fs.write",
          repeatable: true,
        },
        dummyEffect({ written: true }),
      ),
    ).rejects.toThrow(SessionCanceledError);

    expect(effects.calls).toBe(0);
    const steps = await pool.query("SELECT 1 FROM kuronami.steps WHERE session_id = $1", [
      sessionId,
    ]);
    expect(steps.rowCount).toBe(0);
  });

  it("übernimmt einen offenen Schritt nicht nebenbei", async () => {
    const sessionId = await newSession();
    const spec = {
      sessionId,
      idempotencyKey: "exec.run:offen",
      kind: "tool_call" as const,
      toolName: "exec.run",
      repeatable: true,
    };

    // Nur der Checkpoint vor dem Seiteneffekt. Genau das hinterlässt ein abgestürzter Lauf.
    await beginStep(pool, spec);

    await expect(executeStep(pool, spec, dummyEffect({ ok: true }))).rejects.toThrow(
      StepAlreadyRunningError,
    );
    expect(effects.calls).toBe(0);
  });

  it("bricht den laufenden Seiteneffekt ab, wenn ein Signal von außen fällt", async () => {
    const sessionId = await newSession();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const outcome = await executeStep(
      pool,
      {
        sessionId,
        idempotencyKey: "web.fetch:abbruch",
        kind: "tool_call",
        toolName: "web.fetch",
        repeatable: true,
        timeoutMs: 30_000,
        signal: controller.signal,
      },
      hangingEffect,
    );

    expect(outcome.status).toBe("error");
    const failed = (await readEvents(pool, sessionId)).at(-1);
    expect(failed?.payload.reason).toBe("aborted");
  });
});
