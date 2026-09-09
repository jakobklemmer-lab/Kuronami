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
import { type FetchLike, type N8nBridge, createN8nBridge } from "../n8n/bridge.js";
import { ToolRegistry } from "../registry.js";
import { type ToolRouterDeps, callTool } from "../router.js";
import type { ToolResult } from "../types.js";
import { SERVER_WEBHOOKS, createServerTools } from "./tools.js";

/**
 * `server.metrics` durch den **echten** Router, mit einem injizierten `fetch`, das den
 * `server-metrics`-Webhook nachbildet. Lesend, also: Zusammenfassung im Kontext, voller
 * Kennzahlen-Block als Artefakt, einheitliche Hülle.
 */

const pool = createPool();
const threadIds: string[] = [];
let artifactRoot: string;

function fakeServerN8n(
  handler: (input: Record<string, JsonValue>) => { status?: number; json?: unknown },
): FetchLike & { calls: number } {
  const impl = (async (_input: unknown, init?: RequestInit) => {
    impl.calls += 1;
    const parsed = JSON.parse((init?.body as string) ?? "{}") as Record<string, JsonValue>;
    const { status = 200, json = {} } = handler(parsed);
    return new Response(JSON.stringify(json), {
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
    .registerAll(createServerTools({ pool, artifactRoot, bridge }))
    .freeze();
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
  artifactRoot = await mkdtemp(path.join(tmpdir(), "kuronami-server-"));
});

afterAll(async () => {
  if (threadIds.length > 0) {
    const sessions = "SELECT session_id FROM kuronami.sessions WHERE thread_id = ANY($1)";
    await pool.query(
      `DELETE FROM kuronami.artifacts WHERE (source ->> 'session_id') IN (${sessions})`,
      [threadIds],
    );
    for (const table of ["steps", "events"]) {
      await pool.query(`DELETE FROM kuronami.${table} WHERE session_id IN (${sessions})`, [
        threadIds,
      ]);
    }
    await pool.query("DELETE FROM kuronami.sessions WHERE thread_id = ANY($1)", [threadIds]);
  }
  await pool.end();
  if (artifactRoot) await rm(artifactRoot, { recursive: true, force: true });
});

describe("server.metrics", () => {
  it("stellt genau ein Tool bereit (read) und einen eingefrorenen Webhook-Pfad", () => {
    const tools = createServerTools({
      pool,
      artifactRoot,
      bridge: bridgeWith(fakeServerN8n(() => ({}))),
    });
    expect(tools.map((tool) => tool.name)).toEqual(["server.metrics"]);
    expect(tools[0].risk).toBe("read");
    expect(Object.isFrozen(SERVER_WEBHOOKS)).toBe(true);
    expect(SERVER_WEBHOOKS.metrics).toBe("server-metrics");
  });

  it("legt den vollen Kennzahlen-Block als Artefakt ab, Zusammenfassung im Kontext", async () => {
    const deepMarker = `TIEF_${randomUUID()}`;
    const metrics = {
      host: "kuronami-server",
      cpu_percent: 37.4,
      memory_percent: 61,
      disk_percent: 55,
      load1: 0.82,
      uptime_seconds: 3 * 86_400 + 4 * 3_600,
      processes: Array.from({ length: 200 }, (_, i) => ({
        pid: i,
        cmd: `dienst-${i} ${deepMarker}`,
      })),
    };
    const fetchImpl = fakeServerN8n(() => ({ json: metrics }));
    const { deps, version } = routerDeps(bridgeWith(fetchImpl));
    const session = await newSession(version);

    const result = await callTool(deps, session, {
      callId: "call_metrics",
      name: "server.metrics",
      input: {},
    });

    expect(result.status).toBe("ok");
    const s = structured(result);
    expect(s.content_kind).toBe("server-metrics");
    const recognized = s.recognized as Record<string, JsonValue>;
    expect(recognized.host).toBe("kuronami-server");
    expect(recognized.cpu_percent).toBe(37.4);
    // Der Rohwert bleibt in `recognized`; die Zusammenfassung rundet große Prozente.
    expect(result.summary).toContain("CPU 37 %");
    expect(result.summary).toContain("kuronami-server");
    expect(String(s.metrics_artifact_uri)).toContain("artifact://");

    // Die 200 Prozesse mit dem Marker stehen nicht in der Hülle.
    expect(JSON.stringify(result)).not.toContain(deepMarker);
    expect(JSON.stringify(result).length).toBeLessThan(3_000);

    const stored = await readArtifact(pool, artifactRoot, result.artifact_refs[0]);
    const parsed = JSON.parse(stored.bytes.toString("utf8")) as {
      metrics: { processes: unknown[] };
    };
    expect(parsed.metrics.processes).toHaveLength(200);
    expect(stored.bytes.toString("utf8")).toContain(deepMarker);
    expect(stored.source).toMatchObject({ tool: "server.metrics", sessionId: session.sessionId });

    const types = await eventTypes(session.sessionId);
    expect(types).toEqual(
      expect.arrayContaining([
        "tool.requested",
        "policy.allowed",
        "step.started",
        "artifact.created",
        "step.completed",
        "tool.completed",
      ]),
    );
    expect(types).not.toContain("tool.failed");
    expect(await replaySession(pool, session.sessionId)).toEqual(
      await readSessionState(pool, session.sessionId),
    );
  });

  it("kommt auch mit einer unbekannten Feldform zurecht (synthetische Zusammenfassung)", async () => {
    const fetchImpl = fakeServerN8n(() => ({
      json: { region: "eu-central", queue_depth: 4, workers_online: 3 },
    }));
    const { deps, version } = routerDeps(bridgeWith(fetchImpl));
    const session = await newSession(version);

    const result = await callTool(deps, session, {
      callId: "call_metrics_unknown",
      name: "server.metrics",
      input: { window: "24h" },
    });

    expect(result.status).toBe("ok");
    expect(result.summary).toMatch(/Feld\(er\)/);
    expect(result.artifact_refs).toHaveLength(1);
  });

  it("macht eine leere oder nicht-objekt-Antwort zur Fehlerhülle", async () => {
    const fetchImpl = fakeServerN8n(() => ({ json: [] }));
    const { deps, version } = routerDeps(bridgeWith(fetchImpl));
    const session = await newSession(version);

    const result = await callTool(deps, session, {
      callId: "call_metrics_bad",
      name: "server.metrics",
      input: {},
    });

    expect(result.status).toBe("error");
    expect(structured(result).reason).toBe("handler_failed");
  });
});

describe("server.metrics · ausgelieferter Katalog", () => {
  it("bleibt draußen ohne Konfiguration, kommt mit n8n.server dazu", async () => {
    const base = await buildCatalog({ pool, artifactRoot });
    expect(base.catalog.version).toBe("v1-53a18ba0cb4e49c8");
    expect(base.catalog.get("server.metrics")).toBeUndefined();

    const withServer = await buildCatalog({ pool, artifactRoot, n8n: { server: true } });
    expect(withServer.catalog.get("server.metrics")?.risk).toBe("read");
  });
});
