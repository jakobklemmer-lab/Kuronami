import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ApprovalRequiredError,
  decidePolicyApproval,
  policyAskId,
} from "../../policy/approvals.js";
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
import { CAL_WEBHOOKS, createCalTools } from "./tools.js";

/**
 * `cal.*` durch den **echten** Router (Datenbank, echte Policy, echte Ausführungshülle), mit
 * einem injizierten `fetch`, das die drei Kalender-Webhooks nachbildet. Hier steht der erste
 * S15-Testpunkt (Termine dieser Woche lesen) und die Freigabe-Pause der schreibenden Tools.
 */

const pool = createPool();
const threadIds: string[] = [];
let artifactRoot: string;

type RouteReply = { status?: number; json?: unknown };
type Route = (input: Record<string, JsonValue>) => RouteReply;

/** Ein `fetch`, das die drei Kalender-Webhooks nachbildet und jede URL samt Körper mitschreibt. */
function fakeCalN8n(routes: { list?: Route; create?: Route; update?: Route }): FetchLike & {
  calls: number;
  urls: string[];
  bodies: Record<string, JsonValue>[];
} {
  const impl = (async (input: unknown, init?: RequestInit) => {
    impl.calls += 1;
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
    impl.urls.push(url);
    const body = JSON.parse((init?.body as string) ?? "{}") as Record<string, JsonValue>;
    impl.bodies.push(body);
    const route = url.endsWith(`/webhook/${CAL_WEBHOOKS.list}`)
      ? routes.list
      : url.endsWith(`/webhook/${CAL_WEBHOOKS.create}`)
        ? routes.create
        : url.endsWith(`/webhook/${CAL_WEBHOOKS.update}`)
          ? routes.update
          : undefined;
    if (!route) return new Response(`kein Workflow für ${url}`, { status: 404 });
    const { status = 200, json = {} } = route(body);
    return new Response(JSON.stringify(json), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as FetchLike & { calls: number; urls: string[]; bodies: Record<string, JsonValue>[] };
  impl.calls = 0;
  impl.urls = [];
  impl.bodies = [];
  return impl;
}

function bridgeWith(fetchImpl: FetchLike): N8nBridge {
  return createN8nBridge({ baseUrl: "http://n8n.test", fetchImpl, backoffBaseMs: 1 });
}

function routerDeps(bridge: N8nBridge): { deps: ToolRouterDeps; version: string } {
  const catalog = new ToolRegistry()
    .registerAll(createCalTools({ pool, artifactRoot, bridge }))
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
  artifactRoot = await mkdtemp(path.join(tmpdir(), "kuronami-cal-"));
});

afterAll(async () => {
  if (threadIds.length > 0) {
    const sessions = "SELECT session_id FROM kuronami.sessions WHERE thread_id = ANY($1)";
    await pool.query(
      `DELETE FROM kuronami.artifacts WHERE (source ->> 'session_id') IN (${sessions})`,
      [threadIds],
    );
    for (const table of ["approvals", "tasks", "steps", "events"]) {
      await pool.query(`DELETE FROM kuronami.${table} WHERE session_id IN (${sessions})`, [
        threadIds,
      ]);
    }
    await pool.query("DELETE FROM kuronami.sessions WHERE thread_id = ANY($1)", [threadIds]);
  }
  await pool.end();
  if (artifactRoot) await rm(artifactRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Aufbau
// ---------------------------------------------------------------------------

describe("cal.* · Aufbau", () => {
  it("stellt genau drei Tools bereit, list ist read, create/update sind hard_write", () => {
    const tools = createCalTools({ pool, artifactRoot, bridge: bridgeWith(fakeCalN8n({})) });
    expect(tools.map((tool) => tool.name).sort()).toEqual(["cal.create", "cal.list", "cal.update"]);
    expect(tools.find((tool) => tool.name === "cal.list")?.risk).toBe("read");
    expect(tools.find((tool) => tool.name === "cal.create")?.risk).toBe("hard_write");
    expect(tools.find((tool) => tool.name === "cal.update")?.risk).toBe("hard_write");
  });

  it("CAL_WEBHOOKS ist eingefroren, drei Pfade, kein Lösch-Pfad", () => {
    expect(Object.isFrozen(CAL_WEBHOOKS)).toBe(true);
    const paths = Object.values(CAL_WEBHOOKS).sort();
    expect(paths).toEqual(["cal-create", "cal-list", "cal-update"]);
    expect(paths.some((entry) => /delete|remove|destroy/i.test(entry))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cal.list — Termine lesen
// ---------------------------------------------------------------------------

describe("cal.list", () => {
  it("legt die volle Terminliste als Artefakt ab und lässt nur knappe Zeilen im Kontext", async () => {
    const deepMarker = `TIEF_${randomUUID()}`;
    const events = Array.from({ length: 30 }, (_, i) => ({
      id: `evt-${i}`,
      title: `Termin ${i}`,
      start: `2026-09-${String((i % 27) + 1).padStart(2, "0")}T09:00:00Z`,
      end: `2026-09-${String((i % 27) + 1).padStart(2, "0")}T10:00:00Z`,
      location: `Raum ${i}`,
      // Lange Beschreibung mit einem Marker weit hinten — er darf nicht in den Kontext.
      description: `${"Agenda-Punkt. ".repeat(60)}${deepMarker}`,
      attendees: ["a@example.com", "b@example.com"],
      organizer_email: "chef@example.com",
      raw_ical: `BEGIN:VEVENT ${deepMarker} END:VEVENT`,
    }));
    const fetchImpl = fakeCalN8n({ list: () => ({ json: { events } }) });
    const { deps, version } = routerDeps(bridgeWith(fetchImpl));
    const session = await newSession(version);

    const result = await callTool(deps, session, {
      callId: "call_list",
      name: "cal.list",
      input: { start: "2026-09-07T00:00:00Z", end: "2026-09-14T00:00:00Z" },
    });

    expect(result.status).toBe("ok");
    const s = structured(result);
    expect(s.result_count_total).toBe(30);

    const shown = s.events as Record<string, JsonValue>[];
    expect(shown.length).toBe(25); // CAL_LIST_CONTEXT_MAX
    for (const row of shown) {
      expect(Object.keys(row).sort()).toEqual([
        "all_day",
        "calendar",
        "end",
        "id",
        "location",
        "start",
        "status",
        "summary",
        "title",
      ]);
    }
    // Kein roher Anhang aus dem Workflow im Kontext.
    expect(JSON.stringify(result)).not.toContain("organizer_email");
    expect(JSON.stringify(result)).not.toContain(deepMarker);
    expect(result.summary).toContain("Vollständige Liste im Artefakt");
    expect(result.artifact_refs).toHaveLength(1);

    // Das Artefakt trägt alle 30 Termine mit ihren vollen Feldern.
    const stored = await readArtifact(pool, artifactRoot, result.artifact_refs[0]);
    const parsed = JSON.parse(stored.bytes.toString("utf8")) as { events: unknown[] };
    expect(parsed.events).toHaveLength(30);
    expect(stored.bytes.toString("utf8")).toContain(deepMarker);
    expect(stored.bytes.toString("utf8")).toContain("organizer_email");
    expect(stored.source).toMatchObject({ tool: "cal.list", sessionId: session.sessionId });

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

  it("nimmt ohne Bereich die laufende Woche (Montag–Montag, sieben Tage)", async () => {
    const fetchImpl = fakeCalN8n({ list: () => ({ json: { events: [] } }) });
    const { deps, version } = routerDeps(bridgeWith(fetchImpl));
    const session = await newSession(version);

    await callTool(deps, session, {
      callId: "call_list_week",
      name: "cal.list",
      input: {},
    });

    expect(fetchImpl.bodies).toHaveLength(1);
    const sent = fetchImpl.bodies[0];
    expect(typeof sent.start).toBe("string");
    expect(typeof sent.end).toBe("string");
    const start = new Date(sent.start as string);
    const end = new Date(sent.end as string);
    expect(end.getTime() - start.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
    expect(start.getDay()).toBe(1); // Montag
    // Um Mitternacht lokaler Zeit ausgerichtet.
    expect(start.getHours() + start.getMinutes() + start.getSeconds()).toBe(0);
  });

  it("macht eine Antwort ohne events-Array zur Fehlerhülle", async () => {
    const fetchImpl = fakeCalN8n({ list: () => ({ json: { termine: 3 } }) });
    const { deps, version } = routerDeps(bridgeWith(fetchImpl));
    const session = await newSession(version);

    const result = await callTool(deps, session, {
      callId: "call_list_bad",
      name: "cal.list",
      input: {},
    });

    expect(result.status).toBe("error");
    expect(structured(result).reason).toBe("handler_failed");
    expect(String(structured(result).error)).toContain("events");
  });
});

// ---------------------------------------------------------------------------
// cal.create / cal.update — pausieren immer für eine Freigabe
// ---------------------------------------------------------------------------

describe("cal.create", () => {
  it("pausiert für eine Freigabe: n8n nicht berührt, Session awaiting_user", async () => {
    const fetchImpl = fakeCalN8n({ create: () => ({ json: { event_id: "x" } }) });
    const { deps, version } = routerDeps(bridgeWith(fetchImpl));
    const session = await newSession(version);

    await expect(
      callTool(deps, session, {
        callId: "call_create_pause",
        name: "cal.create",
        input: {
          title: "Zahnarzt",
          start: "2026-09-10T08:00:00Z",
          end: "2026-09-10T08:30:00Z",
        },
      }),
    ).rejects.toThrow(ApprovalRequiredError);

    const types = await eventTypes(session.sessionId);
    expect(types).toContain("approval.requested");
    expect(types).not.toContain("step.started");
    expect(fetchImpl.calls).toBe(0);
    expect((await readSessionState(pool, session.sessionId)).status).toBe("awaiting_user");
  });

  it("legt den Termin nach der Freigabe an", async () => {
    const fetchImpl = fakeCalN8n({
      create: (input) => ({
        json: {
          event_id: "GCAL-77",
          html_link: "https://calendar.example/evt/GCAL-77",
          calendar: String(input.calendar ?? "primär"),
        },
      }),
    });
    const { deps, version } = routerDeps(bridgeWith(fetchImpl));
    const session = await newSession(version);

    const call = {
      callId: "call_create_ok",
      name: "cal.create",
      input: {
        title: "Team-Sync",
        start: "2026-09-11T13:00:00Z",
        end: "2026-09-11T13:30:00Z",
        calendar: "Arbeit",
      },
    };

    await expect(callTool(deps, session, call)).rejects.toThrow(ApprovalRequiredError);
    await decidePolicyApproval(pool, session.sessionId, policyAskId("call_create_ok"), "once", {
      decidedBy: "test",
    });

    const result = await callTool(deps, session, call);
    expect(result.status).toBe("ok");
    const s = structured(result);
    expect(s.created).toBe(true);
    expect(s.event_id).toBe("GCAL-77");
    expect(s.calendar).toBe("Arbeit");
    expect(fetchImpl.urls).toEqual(["http://n8n.test/webhook/cal-create"]);

    const types = await eventTypes(session.sessionId);
    expect(types).toEqual(
      expect.arrayContaining([
        "approval.requested",
        "approval.granted",
        "policy.allowed",
        "step.started",
        "step.completed",
        "tool.completed",
      ]),
    );
    expect(await replaySession(pool, session.sessionId)).toEqual(
      await readSessionState(pool, session.sessionId),
    );
  });
});

describe("cal.update", () => {
  it("pausiert ebenfalls für eine Freigabe", async () => {
    const fetchImpl = fakeCalN8n({ update: () => ({ json: { ok: true } }) });
    const { deps, version } = routerDeps(bridgeWith(fetchImpl));
    const session = await newSession(version);

    await expect(
      callTool(deps, session, {
        callId: "call_update_pause",
        name: "cal.update",
        input: { event_id: "GCAL-77", start: "2026-09-11T14:00:00Z" },
      }),
    ).rejects.toThrow(ApprovalRequiredError);

    expect(fetchImpl.calls).toBe(0);
    expect(await eventTypes(session.sessionId)).toContain("approval.requested");
  });

  it("weist einen Aufruf ohne zu änderndes Feld ab — nach der Freigabe", async () => {
    const fetchImpl = fakeCalN8n({ update: () => ({ json: { ok: true } }) });
    const { deps, version } = routerDeps(bridgeWith(fetchImpl));
    const session = await newSession(version);
    const call = {
      callId: "call_update_noop",
      name: "cal.update",
      input: { event_id: "GCAL-1" },
    };

    await expect(callTool(deps, session, call)).rejects.toThrow(ApprovalRequiredError);
    await decidePolicyApproval(pool, session.sessionId, policyAskId("call_update_noop"), "once", {
      decidedBy: "test",
    });

    const result = await callTool(deps, session, call);
    expect(result.status).toBe("error");
    expect(structured(result).reason).toBe("handler_failed");
    expect(fetchImpl.calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Verdrahtung in den Katalog
// ---------------------------------------------------------------------------

describe("cal.* · ausgelieferter Katalog", () => {
  it("bleibt draußen, solange nichts konfiguriert ist — Fingerabdruck unverändert", async () => {
    const base = await buildCatalog({ pool, artifactRoot });
    // Seit S18b trägt der ausgelieferte Katalog immer `tool.load` (verzögertes Tool-Laden,
    // Abschnitt 9) — deshalb 11 statt der 10 Tools und ein anderer Fingerabdruck als vor S18b.
    expect(base.catalog.version).toBe("v1-127776df761f8134");
    expect(base.catalog.tools).toHaveLength(11);
    expect(base.catalog.get("cal.list")).toBeUndefined();
  });

  it("kommt mit n8n.cal in den Katalog, cal.create/update als hard_write", async () => {
    const withCal = await buildCatalog({ pool, artifactRoot, n8n: { cal: true } });
    expect(withCal.catalog.version).not.toBe("v1-127776df761f8134");
    expect(withCal.catalog.get("cal.list")?.risk).toBe("read");
    expect(withCal.catalog.get("cal.create")?.risk).toBe("hard_write");
    expect(withCal.catalog.get("cal.update")?.risk).toBe("hard_write");
  });
});
