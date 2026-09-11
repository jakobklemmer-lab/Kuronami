import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPolicyEngine } from "../../policy/engine.js";
import { createPool } from "../../runtime/db/pool.js";
import { readEvents } from "../../runtime/events/log.js";
import { createOrResumeSession } from "../../runtime/session/manager.js";
import type { SessionRecord } from "../../runtime/session/types.js";
import type { JsonValue } from "../../runtime/steps/types.js";
import { ToolRegistry } from "../registry.js";
import { type ToolRouterDeps, callTool } from "../router.js";
import type { ToolResult } from "../types.js";
import { createToolIntrospectionTools } from "./tools.js";

/**
 * `tool.load` durch den echten Router — das verzögerte Tool-Laden (S18b, Abschnitt 9).
 * `context/request.test.ts` prüft die andere Hälfte (was in der Werkzeugliste der Anfrage
 * steht); hier geht es um das Tool selbst: `execution: "runtime"` wie `task.set`, kein Schritt,
 * und die Ergebnisform, die `deriveLoadedToolNames` zurückliest.
 */

const pool = createPool();
const threadIds: string[] = [];

const prelim = new ToolRegistry()
  .register({
    name: "fs.read",
    description: "Liest eine Datei.",
    risk: "read",
    repeatable: true,
    inputSchema: {
      fields: { path: { type: "string", required: true, description: "Pfad der Datei." } },
    },
    handler: async () => ({ summary: "ok" }),
  })
  .register({
    name: "mail.search",
    description: "Durchsucht das Postfach.",
    risk: "read",
    repeatable: true,
    deferred: true,
    inputSchema: {
      fields: { query: { type: "string", required: false, description: "Suchbegriff." } },
    },
    handler: async () => ({ summary: "ok" }),
  })
  .freeze();

const catalog = new ToolRegistry()
  .registerAll(prelim.tools)
  .registerAll(createToolIntrospectionTools({ catalog: prelim }))
  .freeze();

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

afterAll(async () => {
  if (threadIds.length > 0) {
    const sessions = "SELECT session_id FROM kuronami.sessions WHERE thread_id = ANY($1)";
    await pool.query(`DELETE FROM kuronami.events WHERE session_id IN (${sessions})`, [threadIds]);
    await pool.query(`DELETE FROM kuronami.steps WHERE session_id IN (${sessions})`, [threadIds]);
    await pool.query("DELETE FROM kuronami.sessions WHERE thread_id = ANY($1)", [threadIds]);
  }
  await pool.end();
});

describe("tool.load über den Router", () => {
  it("lädt das Schema eines bekannten Tools, ohne einen Schritt zu erzeugen", async () => {
    const session = await newSession();

    const result = await callTool(deps(), session, {
      callId: "c_load",
      name: "tool.load",
      input: { names: ["mail.search"] },
    });

    expect(result.status).toBe("ok");
    expect(structured(result).loaded).toEqual(["mail.search"]);
    expect(structured(result).not_found).toEqual([]);
    const schemas = structured(result).schemas as Record<string, JsonValue>;
    expect(schemas["mail.search"]).toMatchObject({
      description: "Durchsucht das Postfach.",
      risk: "read",
    });

    // Kein Schritt: dasselbe Muster wie task.set/task.update (S10). `policy.allowed` steht
    // trotzdem da — die Policy-Prüfung liegt vor der Weiche zwischen Ausführungshülle und
    // Runtime-Tool, nicht in einem der beiden Zweige (S11).
    const types = (await readEvents(pool, session.sessionId)).map((event) => event.type);
    expect(types).toEqual([
      "session.created",
      "tool.requested",
      "policy.allowed",
      "tool.completed",
    ]);
  });

  it("meldet unbekannte Namen, ohne die bekannten darunter fallen zu lassen", async () => {
    const session = await newSession();

    const result = await callTool(deps(), session, {
      callId: "c_load_mixed",
      name: "tool.load",
      input: { names: ["mail.search", "erfunden.tool"] },
    });

    expect(result.status).toBe("ok");
    expect(structured(result).loaded).toEqual(["mail.search"]);
    expect(structured(result).not_found).toEqual(["erfunden.tool"]);
  });

  it("weist eine leere oder falsch geformte Namensliste ab", async () => {
    const session = await newSession();

    const result = await callTool(deps(), session, {
      callId: "c_load_leer",
      name: "tool.load",
      input: { names: [] },
    });

    expect(result.status).toBe("error");
    expect(structured(result).reason).toBe("handler_failed");
  });
});
