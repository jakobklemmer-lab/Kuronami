import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "../../runtime/db/pool.js";
import { readEvents } from "../../runtime/events/log.js";
import { createOrResumeSession } from "../../runtime/session/manager.js";
import { readSessionState, replaySession } from "../../runtime/session/state.js";
import type { SessionRecord } from "../../runtime/session/types.js";
import {
  UnknownAskOptionError,
  UserInputNotPendingError,
  UserInputRequiredError,
  answerUserInput,
  dismissUserInput,
} from "../../runtime/session/user-input.js";
import type { JsonValue } from "../../runtime/steps/types.js";
import { ToolRegistry } from "../registry.js";
import { type ToolRouterDeps, callTool } from "../router.js";
import type { ToolResult } from "../types.js";
import { createUserTools } from "./tools.js";

/**
 * `user.ask` durch den echten Router (in einem Prozess). Der Neustart-Nachweis steht in
 * `runtime/session/user-input.test.ts`; hier geht es um das Verhalten des Tools: es hält an,
 * es fragt nur einmal, und nach der Antwort läuft derselbe Aufruf durch.
 */

const pool = createPool();
const threadIds: string[] = [];

const catalog = new ToolRegistry().registerAll(createUserTools({ pool })).freeze();

function deps(): ToolRouterDeps {
  return { pool, artifactRoot: "/nicht/benutzt", catalog };
}

const OPTIONS = [
  { id: "opt_a", label: "Variante A" },
  { id: "opt_b", label: "Variante B" },
];

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

const ask = (callId: string, question = "Welche Variante?") => ({
  callId,
  name: "user.ask",
  input: { question, options: OPTIONS },
});

afterAll(async () => {
  if (threadIds.length > 0) {
    const sessions = "SELECT session_id FROM kuronami.sessions WHERE thread_id = ANY($1)";
    await pool.query(`DELETE FROM kuronami.events WHERE session_id IN (${sessions})`, [threadIds]);
    await pool.query(`DELETE FROM kuronami.steps WHERE session_id IN (${sessions})`, [threadIds]);
    await pool.query("DELETE FROM kuronami.sessions WHERE thread_id = ANY($1)", [threadIds]);
  }
  await pool.end();
});

describe("user.ask · Anhalten bei awaiting_user", () => {
  it("hält den Lauf an, ohne einen Schritt zu erzeugen", async () => {
    const session = await newSession();

    await expect(callTool(deps(), session, ask("c_x"))).rejects.toThrow(UserInputRequiredError);

    expect(await eventTypes(session.sessionId)).toEqual([
      "session.created",
      "tool.requested",
      "approval.requested",
    ]);

    const state = await readSessionState(pool, session.sessionId);
    expect(state.status).toBe("awaiting_user");
    expect(state.steps).toEqual([]);
    expect(state.pendingUserInput).toEqual([
      { askId: "ask:c_x", question: "Welche Variante?", options: OPTIONS },
    ]);
  });

  it("fragt nur einmal: ein zweiter Aufruf schreibt kein zweites approval.requested", async () => {
    const session = await newSession();
    await expect(callTool(deps(), session, ask("c_x"))).rejects.toThrow(UserInputRequiredError);
    await expect(callTool(deps(), session, ask("c_x"))).rejects.toThrow(UserInputRequiredError);

    const types = await eventTypes(session.sessionId);
    expect(types.filter((type) => type === "approval.requested")).toHaveLength(1);
    // Zwei Aufrufe, zwei tool.requested (wie zwei step.started bei einem Wiederholversuch).
    expect(types.filter((type) => type === "tool.requested")).toHaveLength(2);
  });
});

describe("user.ask · Antwort und Fortsetzung", () => {
  it("setzt nach der Antwort denselben Aufruf fort", async () => {
    const session = await newSession();
    await expect(callTool(deps(), session, ask("c_x"))).rejects.toThrow(UserInputRequiredError);

    const report = await answerUserInput(pool, session.sessionId, "ask:c_x", "opt_b", {
      decidedBy: "test",
    });
    expect(report).toEqual({ askId: "ask:c_x", choice: "opt_b", choiceLabel: "Variante B" });

    // Zwischen Antwort und Fortsetzung: der Lauf wartet nicht mehr.
    const mid = await readSessionState(pool, session.sessionId);
    expect(mid.status).toBe("running");
    expect(mid.pendingUserInput).toEqual([]);

    // Derselbe Aufruf, jetzt mit Antwort.
    const result = await callTool(deps(), session, ask("c_x"));
    expect(result.status).toBe("ok");
    expect(structured(result)).toMatchObject({
      ask_id: "ask:c_x",
      answered: true,
      choice: "opt_b",
      choice_label: "Variante B",
    });

    expect(await eventTypes(session.sessionId)).toEqual([
      "session.created",
      "tool.requested",
      "approval.requested",
      "approval.granted",
      "tool.requested",
      "tool.completed",
    ]);

    // Replay aus dem Protokoll ergibt denselben Zustand wie der Snapshot.
    expect(await replaySession(pool, session.sessionId)).toEqual(
      await readSessionState(pool, session.sessionId),
    );
  });

  it("weist eine Option ab, die nicht angeboten wurde", async () => {
    const session = await newSession();
    await expect(callTool(deps(), session, ask("c_y"))).rejects.toThrow(UserInputRequiredError);
    await expect(answerUserInput(pool, session.sessionId, "ask:c_y", "opt_c")).rejects.toThrow(
      UnknownAskOptionError,
    );
  });

  it("wirft, wenn zu einer ask_id keine offene Rückfrage steht", async () => {
    const session = await newSession();
    await expect(
      answerUserInput(pool, session.sessionId, "ask:gibtsnicht", "opt_a"),
    ).rejects.toThrow(UserInputNotPendingError);
  });

  it("meldet nach dismissUserInput eine abgewiesene Rückfrage", async () => {
    const session = await newSession();
    await expect(callTool(deps(), session, ask("c_z"))).rejects.toThrow(UserInputRequiredError);
    await dismissUserInput(pool, session.sessionId, "ask:c_z", "nicht jetzt");

    const result = await callTool(deps(), session, ask("c_z"));
    expect(result.status).toBe("ok");
    expect(structured(result)).toMatchObject({
      ask_id: "ask:c_z",
      answered: false,
      dismissed: true,
      reason: "nicht jetzt",
    });
    expect((await readSessionState(pool, session.sessionId)).status).toBe("running");
  });
});

describe("user.ask · Eingabeprüfung", () => {
  it("verlangt mindestens zwei strukturierte Optionen", async () => {
    const session = await newSession();
    const result = await callTool(deps(), session, {
      callId: "c_bad",
      name: "user.ask",
      input: { question: "Ja?", options: [{ id: "ja", label: "Ja" }] },
    });
    expect(result.status).toBe("error");
    expect(String(structured(result).error)).toMatch(/mindestens 2/);
  });

  it("weist Fließtext-Optionen ab", async () => {
    const session = await newSession();
    const result = await callTool(deps(), session, {
      callId: "c_bad2",
      name: "user.ask",
      input: { question: "Welche?", options: ["A", "B"] },
    });
    expect(result.status).toBe("error");
    expect(String(structured(result).error)).toMatch(/Objekt \{ id, label \}/);
  });
});
