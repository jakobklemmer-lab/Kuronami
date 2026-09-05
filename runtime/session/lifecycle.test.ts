import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPool } from "../db/pool.js";
import { readEvents } from "../events/log.js";
import {
  SessionCanceledError,
  type StepEffect,
  StepNotRepeatableError,
  executeStep,
} from "../steps/hull.js";
import { cancelSession, resumeSession } from "./lifecycle.js";
import { createOrResumeSession } from "./manager.js";
import { readStepSnapshot } from "./state.js";

const pool = createPool();
const threadIds: string[] = [];
const children: ChildProcess[] = [];

const CRASH_PROCESS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "crash-mid-step.process.ts",
);

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

async function newSession(): Promise<string> {
  const threadId = `thread_test_${randomUUID()}`;
  threadIds.push(threadId);
  const { session } = await createOrResumeSession(pool, { threadId, channel: "web" });
  return session.sessionId;
}

async function stepsOf(sessionId: string) {
  return readStepSnapshot(pool, sessionId);
}

/**
 * Startet den Absturzprozess und wartet, bis er den Schritt begonnen hat. Über `node
 * --import tsx` und nicht über die pnpm-Hülle: die ist unter Windows eine .cmd, und der
 * Umweg über eine Shell hätte einen zweiten Prozess zwischen Test und Ziel gestellt — den
 * hätte der Abschuss dann getroffen statt den richtigen.
 */
function startCrashProcess(
  sessionId: string,
  key: string,
  repeatable: boolean,
): Promise<{ child: ChildProcess; stepId: string }> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", CRASH_PROCESS, sessionId, key, String(repeatable)],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(child);

  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const match = out.match(/BEGUN (\S+)/);
      if (match) resolve({ child, stepId: match[1] });
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.on("exit", (code) =>
      reject(new Error(`Absturzprozess endete vorzeitig mit Code ${code}: ${err || out}`)),
    );
    child.on("error", reject);
  });
}

/** Hartes Beenden ohne Aufräumen. Unter Windows beendet Node den Prozess ohnehin sofort. */
function kill(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.removeAllListeners("exit");
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
  });
}

afterAll(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  if (threadIds.length > 0) {
    const sessions = "SELECT session_id FROM kuronami.sessions WHERE thread_id = ANY($1)";
    await pool.query(`DELETE FROM kuronami.steps WHERE session_id IN (${sessions})`, [threadIds]);
    await pool.query(`DELETE FROM kuronami.events WHERE session_id IN (${sessions})`, [threadIds]);
    await pool.query("DELETE FROM kuronami.sessions WHERE thread_id = ANY($1)", [threadIds]);
  }
  await pool.end();
});

describe("Wiederaufnahme mitten im Lauf", () => {
  it(
    "setzt nach einem abgeschossenen Prozess am offenen Schritt fort",
    async () => {
      const sessionId = await newSession();
      const key = "web.fetch:mitten-drin";

      // Erster Schritt läuft normal durch, damit der Abbruch wirklich mitten im Lauf liegt.
      await executeStep(
        pool,
        { sessionId, idempotencyKey: "web.search:davor", kind: "tool_call", repeatable: true },
        dummyEffect({ hits: 3 }),
      );

      const { child, stepId } = await startCrashProcess(sessionId, key, true);
      await kill(child);

      // Der abgeschossene Prozess hinterlässt genau die Lücke aus Abschnitt 6: Checkpoint
      // davor geschrieben, Checkpoint danach nie.
      const open = (await stepsOf(sessionId)).find((step) => step.stepId === stepId);
      expect(open?.status).toBe("running");
      expect(open?.attempt).toBe(1);
      expect((await readEvents(pool, sessionId)).map((event) => event.type)).toEqual([
        "session.created",
        "step.started",
        "step.completed",
        "step.started",
      ]);

      const report = await resumeSession(pool, sessionId);

      expect(report.resolved).toHaveLength(1);
      expect(report.resolved[0].stepId).toBe(stepId);
      expect(report.resolved[0].decision).toBe("repeat");

      const resolved = (await stepsOf(sessionId)).find((step) => step.stepId === stepId);
      expect(resolved?.status).toBe("failed");
      expect(resolved?.error).toMatch(/unbekannten Ausgang/);

      // Und weiter: derselbe Schlüssel darf einen zweiten Versuch machen, weil die
      // Aufrufstelle das beim Start zugesagt hat.
      const continued = await executeStep(
        pool,
        { sessionId, idempotencyKey: key, kind: "tool_call", repeatable: true },
        dummyEffect({ bytes: 99 }),
      );

      expect(continued.status).toBe("ok");
      expect(continued.step.stepId).toBe(stepId);
      expect(continued.step.attempt).toBe(2);
      expect(effects.calls).toBe(2);

      expect((await readEvents(pool, sessionId)).map((event) => event.type)).toEqual([
        "session.created",
        "step.started",
        "step.completed",
        "step.started",
        "session.resumed",
        "step.failed",
        "step.started",
        "step.completed",
      ]);
    },
    { timeout: 40_000 },
  );

  it(
    "wiederholt einen nicht wiederholbaren Schritt nach dem Absturz nicht",
    async () => {
      const sessionId = await newSession();
      const key = "mail.send:einmalig";

      const { child, stepId } = await startCrashProcess(sessionId, key, false);
      await kill(child);

      const report = await resumeSession(pool, sessionId);

      expect(report.resolved).toHaveLength(1);
      // Nicht geraten: die Zusage beim Start entscheidet, nicht die Lage danach. Ob die
      // Mail draußen ist, weiß hier niemand — und genau deshalb wird sie nicht noch einmal
      // verschickt.
      expect(report.resolved[0].decision).toBe("failed_final");

      const failed = (await stepsOf(sessionId)).find((step) => step.stepId === stepId);
      expect(failed?.status).toBe("failed");
      expect(failed?.error).toMatch(/Entscheidung von außen/);

      await expect(
        executeStep(
          pool,
          { sessionId, idempotencyKey: key, kind: "tool_call", repeatable: false },
          dummyEffect({ sent: true }),
        ),
      ).rejects.toThrow(StepNotRepeatableError);
      expect(effects.calls).toBe(0);
    },
    { timeout: 40_000 },
  );

  it("lässt eine Wiederaufnahme ohne offene Schritte den Bestand unangetastet", async () => {
    const sessionId = await newSession();
    await executeStep(
      pool,
      { sessionId, idempotencyKey: "fs.read:eins", kind: "tool_call", repeatable: true },
      dummyEffect({ lines: 4 }),
    );

    const before = await stepsOf(sessionId);
    const report = await resumeSession(pool, sessionId);

    expect(report.resolved).toEqual([]);
    expect(await stepsOf(sessionId)).toEqual(before);
    expect((await readEvents(pool, sessionId)).at(-1)?.type).toBe("session.resumed");
  });

  it("nimmt eine Session über thread_id genauso wieder auf wie über ihre Kennung", async () => {
    const threadId = `thread_test_${randomUUID()}`;
    threadIds.push(threadId);
    const { session } = await createOrResumeSession(pool, { threadId, channel: "telegram" });

    const { child, stepId } = await startCrashProcess(session.sessionId, "exec.run:offen", true);
    await kill(child);

    // Der Weg aus S04: ein neuer Prozess kennt nur Faden und Kanal. Auch der muss den
    // offenen Schritt auflösen, sonst gäbe es zwei Arten der Wiederaufnahme und nur eine
    // davon räumte auf.
    await createOrResumeSession(pool, { threadId, channel: "telegram" });

    const resolved = (await stepsOf(session.sessionId)).find((step) => step.stepId === stepId);
    expect(resolved?.status).toBe("failed");
    expect(resolved?.error).toMatch(/unbekannten Ausgang/);
  }, 40_000);
});

describe("Abbruch", () => {
  it("beendet den Lauf und schließt die offenen Schritte", async () => {
    const sessionId = await newSession();
    await executeStep(
      pool,
      { sessionId, idempotencyKey: "fs.read:vorher", kind: "tool_call", repeatable: true },
      dummyEffect({ lines: 2 }),
    );
    const { child, stepId } = await startCrashProcess(sessionId, "exec.run:laeuft", true);

    const report = await cancelSession(pool, sessionId, "user_request");
    await kill(child);

    expect(report.alreadyCanceled).toBe(false);
    expect(report.canceled).toHaveLength(1);
    expect(report.canceled[0].stepId).toBe(stepId);
    expect(report.canceled[0].previousStatus).toBe("running");

    const steps = await stepsOf(sessionId);
    expect(steps.map((step) => step.status)).toEqual(["completed", "canceled"]);
    expect(steps[1].error).toMatch(/Session abgebrochen \(user_request\)/);

    expect((await readEvents(pool, sessionId)).map((event) => event.type)).toEqual([
      "session.created",
      "step.started",
      "step.completed",
      "step.started",
      "session.canceled",
      "step.canceled",
    ]);
  }, 40_000);

  it("schreibt einen zweiten Abbruch nicht noch einmal", async () => {
    const sessionId = await newSession();

    const first = await cancelSession(pool, sessionId, "user_request");
    const second = await cancelSession(pool, sessionId, "user_request");

    expect(first.alreadyCanceled).toBe(false);
    expect(second.alreadyCanceled).toBe(true);
    const canceled = (await readEvents(pool, sessionId)).filter(
      (event) => event.type === "session.canceled",
    );
    expect(canceled).toHaveLength(1);
  });

  it("nimmt eine abgebrochene Session nicht wieder auf", async () => {
    const sessionId = await newSession();
    await cancelSession(pool, sessionId, "user_request");

    // Der Abbruch ist eine Entscheidung des Nutzers. Sie zu überschreiben, wäre keine
    // Wiederaufnahme, sondern eine Übergehung. Weiterarbeiten heißt: neue Session.
    await expect(resumeSession(pool, sessionId)).rejects.toThrow(SessionCanceledError);
  });
});
