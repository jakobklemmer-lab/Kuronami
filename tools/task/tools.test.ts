import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPolicyEngine } from "../../policy/engine.js";
import { createPool } from "../../runtime/db/pool.js";
import { readEvents } from "../../runtime/events/log.js";
import { createOrResumeSession } from "../../runtime/session/manager.js";
import { readSessionState, replaySession } from "../../runtime/session/state.js";
import type { SessionRecord } from "../../runtime/session/types.js";
import type { JsonValue } from "../../runtime/steps/types.js";
import { readPlanSnapshot, replayPlan } from "../../runtime/tasks/store.js";
import { ToolRegistry } from "../registry.js";
import { type ToolRouterDeps, callTool } from "../router.js";
import type { ToolResult } from "../types.js";
import { createTaskTools } from "./tools.js";

/**
 * `task.set` / `task.update` durch den echten Router. Der Kern: ein `execution: "runtime"`-
 * Tool bekommt `tool.requested`/`tool.completed`, aber **keinen Schritt** — kein
 * `step.started` steht im Protokoll.
 */

const pool = createPool();
const threadIds: string[] = [];

const catalog = new ToolRegistry().registerAll(createTaskTools({ pool })).freeze();

// `task.*` ist soft_write ohne Pfad und ohne Adresse: die Policy lässt es durch, der
// Resolver wird nie gerufen (S11). Wichtig ist trotzdem, dass die Prüfung überhaupt
// stattfindet — auch der `execution: "runtime"`-Zweig läuft durch dasselbe Tor.
const policy = createPolicyEngine({
  resolvePath: async () => {
    throw new Error("Dieser Katalog kennt keine Pfad-Tools");
  },
});

function deps(): ToolRouterDeps {
  return { pool, artifactRoot: "/nicht/benutzt", catalog, policy };
}

async function newSession(): Promise<SessionRecord> {
  const threadId = `thread_test_${randomUUID()}`;
  threadIds.push(threadId);
  const { session } = await createOrResumeSession(pool, {
    threadId,
    channel: "web",
    defaults: { toolCatalogVersion: catalog.version },
  });
  return session;
}

function structured(result: ToolResult): Record<string, JsonValue> {
  return result.structured as Record<string, JsonValue>;
}

async function eventTypes(sessionId: string): Promise<string[]> {
  return (await readEvents(pool, sessionId)).map((event) => event.type);
}

afterAll(async () => {
  if (threadIds.length > 0) {
    const sessions = "SELECT session_id FROM kuronami.sessions WHERE thread_id = ANY($1)";
    await pool.query(`DELETE FROM kuronami.tasks WHERE session_id IN (${sessions})`, [threadIds]);
    await pool.query(`DELETE FROM kuronami.events WHERE session_id IN (${sessions})`, [threadIds]);
    await pool.query(`DELETE FROM kuronami.steps WHERE session_id IN (${sessions})`, [threadIds]);
    await pool.query("DELETE FROM kuronami.sessions WHERE thread_id = ANY($1)", [threadIds]);
  }
  await pool.end();
});

describe("task.set / task.update über den Router", () => {
  it("setzt einen Plan, ohne einen Schritt zu erzeugen", async () => {
    const session = await newSession();

    const result = await callTool(deps(), session, {
      callId: "c_set",
      name: "task.set",
      input: {
        tasks: [
          { id: "recherche", title: "Quellen sichten", status: "in_progress" },
          { id: "bericht", title: "Bericht schreiben", dependencies: ["recherche"] },
        ],
      },
    });

    expect(result.status).toBe("ok");
    const plan = structured(result).plan as Record<string, JsonValue>[];
    expect(plan.map((task) => task.task_id)).toEqual(["recherche", "bericht"]);
    expect(plan[0].status).toBe("in_progress");
    expect(structured(result).created).toEqual(["recherche", "bericht"]);

    // Runtime-Tool: tool.* umklammert die task.*-Ereignisse, aber es gibt keinen Schritt.
    expect(await eventTypes(session.sessionId)).toEqual([
      "session.created",
      "tool.requested",
      "policy.allowed",
      "task.created",
      "task.created",
      "tool.completed",
    ]);
    expect((await readSessionState(pool, session.sessionId)).steps).toEqual([]);

    // Plan-Snapshot == Plan-Faltung.
    expect(await replayPlan(pool, session.sessionId)).toEqual(
      await readPlanSnapshot(pool, session.sessionId),
    );
  });

  it("ändert eine Aufgabe über task.update", async () => {
    const session = await newSession();
    await callTool(deps(), session, {
      callId: "c_set2",
      name: "task.set",
      input: {
        tasks: [
          { id: "t1", title: "Eins" },
          { id: "t2", title: "Zwei" },
        ],
      },
    });

    const result = await callTool(deps(), session, {
      callId: "c_upd",
      name: "task.update",
      input: { task_id: "t1", status: "done", blockers: [] },
    });

    expect(result.status).toBe("ok");
    const plan = structured(result).plan as Record<string, JsonValue>[];
    expect(plan.find((task) => task.task_id === "t1")?.status).toBe("done");
    expect(structured(result).updated).toEqual(["t1"]);

    const types = await eventTypes(session.sessionId);
    expect(types.filter((type) => type.startsWith("step."))).toEqual([]);
    expect(types.filter((type) => type === "task.updated")).toHaveLength(1);
  });

  it("gibt einen ungültigen Status als Fehlerhülle zurück, nicht als Ausnahme", async () => {
    const session = await newSession();
    const result = await callTool(deps(), session, {
      callId: "c_badstatus",
      name: "task.update",
      input: { task_id: "gibtsnicht", status: "erledigt" },
    });

    // task.update trifft zuerst den Status-Check (vor dem DB-Zugriff).
    expect(result.status).toBe("error");
    expect(structured(result).reason).toBe("handler_failed");
    expect(String(structured(result).error)).toMatch(/queued, ready, in_progress/);
  });

  it("weist ein unbekanntes Feld in einer Aufgabe ab", async () => {
    const session = await newSession();
    const result = await callTool(deps(), session, {
      callId: "c_unknownfield",
      name: "task.set",
      input: { tasks: [{ id: "t1", title: "X", prioritaet: "hoch" }] },
    });
    expect(result.status).toBe("error");
    expect(String(structured(result).error)).toMatch(/unbekanntes Feld "prioritaet"/);
    // Nichts geschrieben.
    expect(await readPlanSnapshot(pool, session.sessionId)).toEqual([]);
  });

  it("führt denselben task.set-Aufruf zweimal aus (Runtime-Tool, keine Schritt-Idempotenz)", async () => {
    const session = await newSession();
    const call = {
      callId: "c_twice",
      name: "task.set",
      input: { tasks: [{ id: "t1", title: "Einmalig?" }] },
    };
    await callTool(deps(), session, call);
    const second = await callTool(deps(), session, call);

    // Zweiter Lauf: deklarativ derselbe Plan → kein neues Ereignis, aber der Aufruf läuft.
    expect(second.status).toBe("ok");
    const types = await eventTypes(session.sessionId);
    expect(types.filter((type) => type === "tool.completed")).toHaveLength(2);
    expect(types.filter((type) => type === "task.created")).toHaveLength(1);
  });
});
