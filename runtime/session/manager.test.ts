import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "../db/pool.js";
import { readEvents } from "../events/log.js";
import { type SessionCriteria, createOrResumeSession, startRuntime } from "./manager.js";

/** Pool nur für Prüfungen und Aufräumen, getrennt von den Pools der Läufe im Test. */
const pool = createPool();
const threadIds: string[] = [];

function newThreadId(): string {
  const threadId = `thread_test_${randomUUID()}`;
  threadIds.push(threadId);
  return threadId;
}

/**
 * Ein Prozesslauf: eigener Pool, eigene Verbindungen, am Ende geschlossen. Das ist der
 * Neustart, den dieser Test nachstellt — zwei Läufe teilen nichts außer der Datenbank.
 */
async function inRun<T>(work: (runPool: Pool) => Promise<T>): Promise<T> {
  const runPool = createPool();
  try {
    return await work(runPool);
  } finally {
    await runPool.end();
  }
}

async function countSessions(threadId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "SELECT count(*) AS count FROM kuronami.sessions WHERE thread_id = $1",
    [threadId],
  );
  return Number(result.rows[0].count);
}

afterAll(async () => {
  if (threadIds.length > 0) {
    await pool.query(
      `DELETE FROM kuronami.events
       WHERE session_id IN (SELECT session_id FROM kuronami.sessions WHERE thread_id = ANY($1))`,
      [threadIds],
    );
    await pool.query("DELETE FROM kuronami.sessions WHERE thread_id = ANY($1)", [threadIds]);
  }
  await pool.end();
});

describe("Session über einen Prozess-Neustart", () => {
  it("findet nach dem Neustart dieselbe Session wieder und legt keine zweite an", async () => {
    const criteria: SessionCriteria = { threadId: newThreadId(), channel: "web" };

    const first = await inRun(async (runPool) => {
      const runtime = await startRuntime(runPool, criteria);
      await runtime.stop("test");
      return runtime;
    });

    // Alles, was der erste Lauf im Speicher hielt, ist mit seinem Pool verschwunden.
    const second = await inRun(async (runPool) => {
      const runtime = await startRuntime(runPool, criteria);
      await runtime.stop("test");
      return runtime;
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.session.sessionId).toBe(first.session.sessionId);
    expect(await countSessions(criteria.threadId)).toBe(1);

    // Die beiden Läufe sind unterschiedliche Prozess-Inkarnationen derselben Session.
    expect(second.runtimeId).not.toBe(first.runtimeId);
  });

  it("liest den Neustart aus dem Protokoll: eine Entstehung, zwei Läufe", async () => {
    const criteria: SessionCriteria = { threadId: newThreadId(), channel: "telegram" };

    await inRun(async (runPool) => {
      const runtime = await startRuntime(runPool, criteria);
      await runtime.stop("test");
    });
    const second = await inRun(async (runPool) => {
      const runtime = await startRuntime(runPool, criteria);
      await runtime.stop("test");
      return runtime;
    });

    const events = await readEvents(pool, second.session.sessionId);

    expect(events.map((event) => event.type)).toEqual([
      "session.created",
      "runtime.started",
      "runtime.stopped",
      "session.resumed",
      "runtime.started",
      "runtime.stopped",
    ]);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(events[4].payload.resumed).toBe(true);
    expect(events[1].payload.runtime_id).not.toBe(events[4].payload.runtime_id);
  });

  it("schreibt genau ein session.created, wenn viele Prozesse gleichzeitig starten", async () => {
    const criteria: SessionCriteria = { threadId: newThreadId(), channel: "heartbeat" };
    const count = 10;

    // Der Neustart oben ist der Normalfall; das hier ist der Grenzfall, in dem ein
    // vorgeschaltetes SELECT durchfiele: alle sähen nichts und legten alle an.
    const resolved = await Promise.all(
      Array.from({ length: count }, () =>
        inRun((runPool) => createOrResumeSession(runPool, criteria)),
      ),
    );

    const sessionIds = new Set(resolved.map((entry) => entry.session.sessionId));
    expect(sessionIds.size).toBe(1);
    expect(resolved.filter((entry) => entry.created)).toHaveLength(1);
    expect(await countSessions(criteria.threadId)).toBe(1);

    const events = await readEvents(pool, [...sessionIds][0]);
    expect(events.filter((event) => event.type === "session.created")).toHaveLength(1);
    expect(events.filter((event) => event.type === "session.resumed")).toHaveLength(count - 1);
  });

  it("hält Sessions verschiedener Fäden und verschiedener Kanäle auseinander", async () => {
    const threadId = newThreadId();
    const otherThreadId = newThreadId();

    const web = await createOrResumeSession(pool, { threadId, channel: "web" });
    const voice = await createOrResumeSession(pool, { threadId, channel: "voice" });
    const other = await createOrResumeSession(pool, { threadId: otherThreadId, channel: "web" });

    const ids = [web, voice, other].map((entry) => entry.session.sessionId);
    expect(new Set(ids).size).toBe(3);
    expect([web, voice, other].every((entry) => entry.created)).toBe(true);
  });

  it("übernimmt Startwerte nur bei der Neuanlage und schreibt sie beim Wiederfinden nicht um", async () => {
    const criteria: SessionCriteria = { threadId: newThreadId(), channel: "mail" };

    const created = await createOrResumeSession(pool, {
      ...criteria,
      defaults: { modelProfile: "worker-cheap", approvalMode: "accept_edits" },
    });
    const resumed = await createOrResumeSession(pool, {
      ...criteria,
      defaults: { modelProfile: "orchestrator-default", approvalMode: "ask" },
    });

    expect(created.session.modelProfile).toBe("worker-cheap");
    expect(resumed.session.modelProfile).toBe("worker-cheap");
    expect(resumed.session.approvalMode).toBe("accept_edits");
    expect(resumed.session.createdAt).toEqual(created.session.createdAt);
  });

  it("füllt die Startwerte aus Abschnitt 5, wenn keine übergeben werden", async () => {
    const { session } = await createOrResumeSession(pool, {
      threadId: newThreadId(),
      channel: "web",
    });

    expect(session.sessionId).toMatch(/^sess_/);
    expect(session.mode).toBe("execute");
    expect(session.modelProfile).toBe("orchestrator-default");
    expect(session.toolCatalogVersion).toBe("v1");
    expect(session.approvalMode).toBe("ask");
    expect(session.contextState).toEqual({});
    expect(session.createdAt).toBeInstanceOf(Date);
  });

  it("protokolliert einen Stop genau einmal, auch wenn zwei Signale ihn auslösen", async () => {
    const { session } = await inRun(async (runPool) => {
      const runtime = await startRuntime(runPool, {
        threadId: newThreadId(),
        channel: "web",
      });
      await runtime.stop("SIGINT");
      await runtime.stop("SIGTERM");
      return runtime;
    });

    const stopped = (await readEvents(pool, session.sessionId)).filter(
      (event) => event.type === "runtime.stopped",
    );

    expect(stopped).toHaveLength(1);
    expect(stopped[0].payload.reason).toBe("SIGINT");
  });
});
