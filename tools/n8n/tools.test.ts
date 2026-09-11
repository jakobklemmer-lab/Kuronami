import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPolicyEngine } from "../../policy/engine.js";
import { readArtifact } from "../../runtime/artifacts/store.js";
import { createPool } from "../../runtime/db/pool.js";
import { readEvents } from "../../runtime/events/log.js";
import { buildCatalog } from "../../runtime/loop/api.js";
import { createOrResumeSession } from "../../runtime/session/manager.js";
import { readSessionState, replaySession } from "../../runtime/session/state.js";
import type { SessionRecord } from "../../runtime/session/types.js";
import type { JsonValue } from "../../runtime/steps/types.js";
import { ToolRegistry } from "../registry.js";
import { type ToolRouterDeps, callTool } from "../router.js";
import type { ToolResult } from "../types.js";
import { type FetchLike, type N8nBridge, createN8nBridge } from "./bridge.js";
import { UPPERCASE_WORKFLOW, createN8nTools } from "./workflows.js";

/**
 * Die n8n-Brücke durch den **echten** Router (mit Datenbank, echter Policy, echter
 * Ausführungshülle). Hier steht das Fertig-Kriterium von S13: der Workflow "uppercase" ist
 * aus der Runtime als Tool aufrufbar und antwortet in der einheitlichen Rückgabehülle.
 * `fetch` ist injiziert und bildet einen n8n-Webhook nach (Muster aus `web/tools.test.ts`).
 */

const pool = createPool();
const threadIds: string[] = [];
let artifactRoot: string;

/** Ein `fetch`, das einen n8n-Webhook nachbildet: liest den JSON-Körper, ruft `handler`. */
function fakeN8n(
  handler: (input: Record<string, JsonValue>) => { status?: number; body?: unknown },
): FetchLike & { calls: number } {
  const impl = (async (_input: unknown, init?: RequestInit) => {
    impl.calls += 1;
    const parsed = JSON.parse((init?.body as string) ?? "{}") as Record<string, JsonValue>;
    const { status = 200, body = {} } = handler(parsed);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as FetchLike & { calls: number };
  impl.calls = 0;
  return impl;
}

function bridgeWith(fetchImpl: FetchLike): N8nBridge {
  return createN8nBridge({ baseUrl: "http://n8n.test", fetchImpl, backoffBaseMs: 1 });
}

function routerDeps(bridge: N8nBridge): { deps: ToolRouterDeps; version: string } {
  const catalog = new ToolRegistry()
    .registerAll(createN8nTools({ bridge, workflows: [UPPERCASE_WORKFLOW] }))
    .freeze();
  // `dev.uppercase` ist `read` und nimmt keinen Pfad und keine Adresse entgegen; der
  // Resolver wird nie gerufen. Dass er wirft, hält das fest (wie in `router.test.ts`).
  const policy = createPolicyEngine({
    resolvePath: async () => {
      throw new Error("Dieser Katalog kennt keine Pfad-Tools");
    },
  });
  return { deps: { pool, artifactRoot, catalog, policy }, version: catalog.version };
}

async function newSession(version: string): Promise<SessionRecord> {
  const threadId = `thread_test_${randomUUID()}`;
  threadIds.push(threadId);
  const { session } = await createOrResumeSession(pool, {
    threadId,
    channel: "web",
    defaults: { toolCatalogVersion: version },
  });
  return session;
}

function structured(result: ToolResult): Record<string, JsonValue> {
  return result.structured as Record<string, JsonValue>;
}

async function eventTypes(sessionId: string): Promise<string[]> {
  return (await readEvents(pool, sessionId)).map((event) => event.type);
}

beforeAll(async () => {
  artifactRoot = await mkdtemp(path.join(tmpdir(), "kuronami-n8n-"));
});

afterAll(async () => {
  if (threadIds.length > 0) {
    const sessions = "SELECT session_id FROM kuronami.sessions WHERE thread_id = ANY($1)";
    await pool.query(
      `DELETE FROM kuronami.artifacts WHERE (source ->> 'session_id') IN (${sessions})`,
      [threadIds],
    );
    await pool.query(`DELETE FROM kuronami.events WHERE session_id IN (${sessions})`, [threadIds]);
    await pool.query(`DELETE FROM kuronami.steps WHERE session_id IN (${sessions})`, [threadIds]);
    await pool.query("DELETE FROM kuronami.sessions WHERE thread_id = ANY($1)", [threadIds]);
  }
  await pool.end();
  if (artifactRoot) await rm(artifactRoot, { recursive: true, force: true });
});

describe("n8n-Brücke · Fertig-Kriterium", () => {
  it("ruft den Workflow 'uppercase' aus der Runtime als Tool auf und antwortet in der Hülle", async () => {
    const fetchImpl = fakeN8n((input) => ({
      // n8n gibt oft ein Array je Durchlauf zurück — die Brücke packt ein einzelnes aus.
      body: [
        {
          text: String(input.text).toUpperCase(),
          summary: `n8n hat ${String(input.text).length} Zeichen großgeschrieben`,
        },
      ],
    }));
    const { deps, version } = routerDeps(bridgeWith(fetchImpl));
    const session = await newSession(version);

    const result = await callTool(deps, session, {
      callId: "call_up",
      name: "dev.uppercase",
      input: { text: "hallo welt" },
    });

    expect(result.status).toBe("ok");
    expect(result.summary).toBe("n8n hat 10 Zeichen großgeschrieben");
    expect(structured(result).workflow).toBe("dev.uppercase");
    expect(structured(result).http_status).toBe(200);
    expect(structured(result).body).toEqual({
      text: "HALLO WELT",
      summary: "n8n hat 10 Zeichen großgeschrieben",
    });
    expect(result.artifact_refs).toEqual([]);
    expect(fetchImpl.calls).toBe(1);

    const types = await eventTypes(session.sessionId);
    expect(types).toEqual(
      expect.arrayContaining([
        "tool.requested",
        "policy.allowed",
        "step.started",
        "step.completed",
        "tool.completed",
      ]),
    );
    expect(types).not.toContain("tool.failed");

    // Replay ergibt denselben Zustand wie der Schnappschuss (S05).
    const snapshot = await readSessionState(pool, session.sessionId);
    const replay = await replaySession(pool, session.sessionId);
    expect(replay).toEqual(snapshot);
  });

  it("lagert eine große Workflow-Antwort automatisch als Artefakt aus", async () => {
    const rows = Array.from({ length: 900 }, (_, i) => ({
      i,
      v: `Zeile ${i}: Fuelltext fuer den Auslagerungstest, damit die Antwort Substanz hat.`,
    }));
    const fetchImpl = fakeN8n(() => ({ body: { note: "gross", rows } }));
    const { deps, version } = routerDeps(bridgeWith(fetchImpl));
    const session = await newSession(version);

    const result = await callTool(deps, session, {
      callId: "call_big",
      name: "dev.uppercase",
      input: { text: "x" },
    });

    expect(result.status).toBe("ok");
    expect(result.artifact_refs).toHaveLength(1);
    expect(structured(result).offloaded).toBe(true);
    // Was in den Kontext ginge, ist klein — der Punkt der Übung.
    expect(JSON.stringify(result).length).toBeLessThan(2_000);

    const stored = await readArtifact(pool, artifactRoot, result.artifact_refs[0]);
    const parsed = JSON.parse(stored.bytes.toString("utf8")) as { body: { rows: unknown[] } };
    expect(parsed.body.rows).toHaveLength(900);
    expect(stored.source).toMatchObject({
      tool: "dev.uppercase",
      sessionId: session.sessionId,
    });
  });

  it("macht einen dauerhaften Workflow-Fehler zur Fehlerhülle (nach Brücken-Retries)", async () => {
    const fetchImpl = fakeN8n(() => ({ status: 503 }));
    const { deps, version } = routerDeps(bridgeWith(fetchImpl));
    const session = await newSession(version);

    const result = await callTool(deps, session, {
      callId: "call_503",
      name: "dev.uppercase",
      input: { text: "x" },
    });

    expect(result.status).toBe("error");
    expect(structured(result).reason).toBe("handler_failed");
    expect(String(structured(result).error)).toContain("503");
    // `dev.uppercase` ist wiederholbar → die Brücke hat drei Anläufe gemacht.
    expect(fetchImpl.calls).toBe(3);

    const types = await eventTypes(session.sessionId);
    expect(types).toEqual(
      expect.arrayContaining(["tool.requested", "step.started", "step.failed", "tool.failed"]),
    );
  });

  it("wiederholt einen Workflow-500 nicht (der Workflow lief und ist gescheitert)", async () => {
    const fetchImpl = fakeN8n(() => ({ status: 500, body: { message: "boom im Workflow" } }));
    const { deps, version } = routerDeps(bridgeWith(fetchImpl));
    const session = await newSession(version);

    const result = await callTool(deps, session, {
      callId: "call_500",
      name: "dev.uppercase",
      input: { text: "x" },
    });

    expect(result.status).toBe("error");
    expect(String(structured(result).error)).toContain("HTTP 500");
    expect(fetchImpl.calls).toBe(1);
  });

  it("weist einen Schemafehler ab, ohne die Brücke zu rufen", async () => {
    const fetchImpl = fakeN8n(() => ({ body: {} }));
    const { deps, version } = routerDeps(bridgeWith(fetchImpl));
    const session = await newSession(version);

    const result = await callTool(deps, session, {
      callId: "call_bad",
      name: "dev.uppercase",
      input: {},
    });

    expect(result.status).toBe("error");
    expect(structured(result).reason).toBe("invalid_input");
    expect(fetchImpl.calls).toBe(0);

    const types = await eventTypes(session.sessionId);
    expect(types).toContain("tool.failed");
    expect(types).not.toContain("step.started");
  });
});

describe("n8n-Brücke · ausgelieferter Katalog", () => {
  it("führt keinen Workflow, solange keiner konfiguriert ist — Fingerabdruck unverändert", async () => {
    const base = await buildCatalog({ pool, artifactRoot });
    // Seit S18b trägt der ausgelieferte Katalog immer `tool.load` (verzögertes Tool-Laden,
    // Abschnitt 9) — deshalb 11 statt der 10 Tools und ein anderer Fingerabdruck als vor S18b.
    expect(base.catalog.version).toBe("v1-127776df761f8134");
    expect(base.catalog.tools).toHaveLength(11);
    expect(base.catalog.get("dev.uppercase")).toBeUndefined();
  });

  it("nimmt einen konfigurierten Workflow als Tool in den Katalog auf", async () => {
    const withN8n = await buildCatalog({
      pool,
      artifactRoot,
      n8n: { workflows: [UPPERCASE_WORKFLOW] },
    });
    expect(withN8n.catalog.version).not.toBe("v1-127776df761f8134");
    expect(withN8n.catalog.tools).toHaveLength(12);
    expect(withN8n.catalog.get("dev.uppercase")?.risk).toBe("read");
  });
});
