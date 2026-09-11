import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPolicyEngine } from "../policy/engine.js";
import { createPool } from "../runtime/db/pool.js";
import { readEvents } from "../runtime/events/log.js";
import { type Runner, createRunner } from "../runtime/loop/api.js";
import type { ModelClient, ModelContentBlock } from "../runtime/model/types.js";
import type { JsonValue } from "../runtime/steps/types.js";
import { createCalTools } from "../tools/cal/tools.js";
import { createMailTools } from "../tools/mail/tools.js";
import { type MemoryStore, buildMemoryRoot, createMemoryStore } from "../tools/memory/store.js";
import { createMemoryTools } from "../tools/memory/tools.js";
import { type FetchLike, type N8nBridge, createN8nBridge } from "../tools/n8n/bridge.js";
import { ToolRegistry } from "../tools/registry.js";
import { type SkillCatalog, loadSkillCatalog } from "../tools/skill/catalog.js";
import { createSkillTools } from "../tools/skill/tools.js";
import type { ToolDefinition } from "../tools/types.js";
import { buildEgressPolicy } from "../tools/web/egress.js";
import { type WebSearchBackend, createWebTools } from "../tools/web/tools.js";

/**
 * S18d — die ersten eigenen Skills (Abschnitt 9, "Mail-Triage, Wochenrückblick,
 * Recherche-Ablauf"). Diese Datei prüft nicht den Skill-*Mechanismus* (das tut
 * `tools/skill/catalog.test.ts` und `tools/skill/tools.test.ts` seit S18c) — sie prüft, dass
 * die drei echten `skills/<name>/SKILL.md` aus diesem Verzeichnis lesbar sind und ihr Ablauf
 * mit Testdaten tatsächlich durchläuft: `skill.load`, dann genau die Werkzeugaufrufe, die die
 * jeweilige Anleitung vorschreibt, durch den echten Router und die echte Schleife.
 *
 * Wie bei jedem Fertig-Kriterium in diesem Projekt ist nur das Modell ein Drehbuch — es ruft
 * `skill.load` und danach die Werkzeuge in der von der Anleitung verlangten Reihenfolge auf.
 * Ein Drehbuch beweist nicht, dass ein echtes Modell dieselben Schritte wählte; es beweist,
 * dass der beschriebene Ablauf mit den echten Werkzeugen, der echten Policy und echten
 * Testdaten tatsächlich zum beschriebenen Ergebnis führt.
 */

const pool = createPool();
const threadIds: string[] = [];
const openRunners: Runner[] = [];
let artifactRoot: string;
let skillCatalog: SkillCatalog;

const FIXED_USAGE = {
  inputTokens: 20,
  outputTokens: 10,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

beforeAll(async () => {
  artifactRoot = await mkdtemp(path.join(tmpdir(), "kuronami-skills-"));
  // Der echte Bestand aus `skills/` — keine Fixtur. Damit prüft diese Datei die tatsächlichen
  // SKILL.md-Dateien dieses Verzeichnisses, nicht eine Kopie davon.
  skillCatalog = await loadSkillCatalog(path.resolve(process.cwd(), "skills"));
});

afterAll(async () => {
  for (const runner of openRunners) await runner.stop("test-ende").catch(() => {});
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

it("lädt Mail-Triage, Wochenrückblick und Recherche-Ablauf aus dem echten Bestand", () => {
  const names = skillCatalog.skills.map((skill) => skill.name);
  expect(names).toEqual(
    expect.arrayContaining(["mail-triage", "wochenrueckblick", "recherche-ablauf"]),
  );
  for (const name of ["mail-triage", "wochenrueckblick", "recherche-ablauf"]) {
    const skill = skillCatalog.get(name);
    expect(skill?.title.length).toBeGreaterThan(0);
    expect(skill?.description.length).toBeGreaterThan(0);
    expect(skill?.when.length).toBeGreaterThan(0);
    expect(skill?.body.length).toBeGreaterThan(0);
  }
});

// ---------------------------------------------------------------------------
// Gemeinsames Drehbuch-Modell: skill.load, dann eine feste Aufrufkette, dann Text.
// ---------------------------------------------------------------------------

interface ScriptStep {
  toolName: string;
  input: Record<string, JsonValue>;
}

function sequenceModel(model: string, steps: ScriptStep[], finalText: string): ModelClient {
  let done = 0;
  return {
    model,
    async complete() {
      if (done < steps.length) {
        const step = steps[done];
        done += 1;
        const callId = `call_${done}`;
        const apiName = step.toolName.replace(".", "__");
        const text = `Schritt ${done}: ${step.toolName}.`;
        const toolUse: ModelContentBlock = {
          type: "tool_use",
          id: callId,
          name: apiName,
          input: step.input,
        };
        return {
          model,
          stopReason: "tool_use",
          text,
          toolCalls: [{ callId, name: apiName, input: step.input }],
          usage: FIXED_USAGE,
          content: [{ type: "text", text }, toolUse],
        };
      }
      return {
        model,
        stopReason: "end_turn",
        text: finalText,
        toolCalls: [],
        usage: FIXED_USAGE,
        content: [{ type: "text", text: finalText }],
      };
    },
  };
}

async function newSkillRunner(model: ModelClient, tools: ToolDefinition[]): Promise<Runner> {
  const threadId = `thread_test_${randomUUID()}`;
  threadIds.push(threadId);
  const catalog = new ToolRegistry()
    .registerAll(tools)
    .registerAll(createSkillTools({ catalog: skillCatalog, pool }))
    .freeze();
  const policy = createPolicyEngine({
    resolvePath: async () => {
      throw new Error("Dieser Katalog kennt keine Pfad-Tools");
    },
  });
  const runner = await createRunner({
    pool,
    threadId,
    channel: "web",
    artifactRoot,
    catalog,
    policy,
    model,
    conventions: "Kein ORM. Fehler nie verstecken.",
    skills: skillCatalog,
  });
  openRunners.push(runner);
  return runner;
}

async function eventTypes(sessionId: string): Promise<string[]> {
  return (await readEvents(pool, sessionId)).map((event) => event.type);
}

// ---------------------------------------------------------------------------
// Mail-Triage
// ---------------------------------------------------------------------------

type RouteReply = { status?: number; json?: unknown };
type Route = (input: Record<string, JsonValue>) => RouteReply;

function fakeMailN8n(routes: { search?: Route; read?: Route; draft?: Route }): FetchLike & {
  urls: string[];
} {
  const impl = (async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
    impl.urls.push(url);
    const body = JSON.parse((init?.body as string) ?? "{}") as Record<string, JsonValue>;
    const route = url.endsWith("/webhook/mail-search")
      ? routes.search
      : url.endsWith("/webhook/mail-read")
        ? routes.read
        : url.endsWith("/webhook/mail-draft")
          ? routes.draft
          : undefined;
    if (!route) return new Response(`kein Workflow für ${url}`, { status: 404 });
    const { status = 200, json = {} } = route(body);
    return new Response(JSON.stringify(json), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as FetchLike & { urls: string[] };
  impl.urls = [];
  return impl;
}

function bridgeWith(fetchImpl: FetchLike): N8nBridge {
  return createN8nBridge({ baseUrl: "http://n8n.test", fetchImpl, backoffBaseMs: 1 });
}

describe("Skill · Mail-Triage (S18d)", () => {
  it("triagiert fünf ungelesene Mails und entwirft Antworten nur für die zwei dringenden", async () => {
    const unread = [
      {
        id: "u1",
        subject: "Frist heute: Angebot bestätigen",
        from: "kunde@example.com",
        date: "2026-09-08T08:00:00Z",
        snippet: "Bitte heute noch bestätigen.",
        unread: true,
      },
      {
        id: "u2",
        subject: "Unser Newsletter im September",
        from: "news@example.com",
        date: "2026-09-08T08:05:00Z",
        snippet: "Neuigkeiten aus unserem Haus.",
        unread: true,
      },
      {
        id: "u3",
        subject: "Dringend: Vertrag unterschreiben",
        from: "partner@example.com",
        date: "2026-09-08T08:10:00Z",
        snippet: "Bitte um Unterschrift bis Freitag.",
        unread: true,
      },
      {
        id: "u4",
        subject: "Ihre Bestellung wurde versandt",
        from: "shop@example.com",
        date: "2026-09-08T08:15:00Z",
        snippet: "Versandbestätigung.",
        unread: true,
      },
      {
        id: "u5",
        subject: "Einladung: Webinar nächste Woche",
        from: "events@example.com",
        date: "2026-09-08T08:20:00Z",
        snippet: "Melden Sie sich an.",
        unread: true,
      },
    ];

    const fetchImpl = fakeMailN8n({
      search: () => ({ json: { messages: unread } }),
      read: (input) => {
        const mail = unread.find((m) => m.id === input.id);
        return {
          json: {
            id: input.id,
            subject: mail?.subject,
            from: mail?.from,
            to: "ich@example.com",
            date: mail?.date,
            body_text: `Voller Text zu ${String(input.id)}: ${mail?.snippet}`,
          },
        };
      },
      draft: (input) => ({
        json: { draft_id: `d_${String(input.in_reply_to)}`, mailbox: "Drafts", created: true },
      }),
    });

    const model = sequenceModel(
      "modell-mail-triage",
      [
        { toolName: "skill.load", input: { names: ["mail-triage"] } },
        { toolName: "mail.search", input: { unread_only: true } },
        { toolName: "mail.read", input: { id: "u1" } },
        { toolName: "mail.read", input: { id: "u3" } },
        {
          toolName: "mail.draft",
          input: {
            to: "kunde@example.com",
            subject: "Re: Frist heute: Angebot bestätigen",
            body: "Bestätigt, danke.",
            in_reply_to: "u1",
          },
        },
        {
          toolName: "mail.draft",
          input: {
            to: "partner@example.com",
            subject: "Re: Dringend: Vertrag unterschreiben",
            body: "Unterschrieben, geht raus.",
            in_reply_to: "u3",
          },
        },
      ],
      "Zwei von fünf ungelesenen Mails waren dringend, beide sind beantwortet (Entwürfe liegen in „Drafts“); die übrigen drei bleiben unbearbeitet liegen.",
    );

    const runner = await newSkillRunner(
      model,
      createMailTools({ pool, artifactRoot, bridge: bridgeWith(fetchImpl) }),
    );
    const result = await runner.run("Bitte den Posteingang triagieren.");

    expect(result.stop).toBe("done");

    const events = await readEvents(pool, runner.session.sessionId);
    const invoked = events.find((event) => event.type === "skill.invoked");
    expect(invoked?.payload.names).toEqual(["mail-triage"]);
    expect(
      (await eventTypes(runner.session.sessionId)).filter((t) => t === "tool.failed"),
    ).toHaveLength(0);

    // Nur die zwei dringenden wurden gelesen und beantwortet — die drei übrigen unangetastet.
    expect(fetchImpl.urls.filter((u) => u.endsWith("mail-read"))).toHaveLength(2);
    expect(fetchImpl.urls.filter((u) => u.endsWith("mail-draft"))).toHaveLength(2);
    // Kein Sende-Pfad — dasselbe zweite Fertig-Kriterium wie in S14.
    expect(fetchImpl.urls.some((u) => /send|smtp|submit|outbox|deliver/i.test(u))).toBe(false);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Wochenrückblick
// ---------------------------------------------------------------------------

describe("Skill · Wochenrückblick (S18d)", () => {
  it("liest Termine und eine ältere Notiz, legt eine neue Wochenrückblick-Notiz ab", async () => {
    const memoryRoot = await mkdtemp(path.join(tmpdir(), "kuronami-skills-memory-"));
    let memoryStore: MemoryStore | undefined;
    try {
      memoryStore = await createMemoryStore({
        root: await buildMemoryRoot(memoryRoot),
        indexFile: ":memory:",
        git: false,
      });
      await memoryStore.write({
        content:
          "Team-Sync am Dienstag auf Mittwoch verschoben, Kickoff für Projekt Atlas verabredet.",
        tags: ["team-sync"],
        kind: "ereignis",
        title: "Team-Sync verschoben",
      });
      expect(memoryStore.count()).toBe(1);

      const events = [
        {
          id: "e1",
          title: "Team-Sync",
          start: "2026-09-09T10:00:00Z",
          end: "2026-09-09T10:30:00Z",
        },
        {
          id: "e2",
          title: "Kickoff Projekt Atlas",
          start: "2026-09-10T14:00:00Z",
          end: "2026-09-10T15:00:00Z",
        },
      ];
      const fetchImpl = (async (input: unknown, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
        if (url.endsWith("/webhook/cal-list")) {
          return new Response(JSON.stringify({ events }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(`kein Workflow für ${url}`, { status: 404 });
      }) as FetchLike;

      const model = sequenceModel(
        "modell-wochenrueckblick",
        [
          { toolName: "skill.load", input: { names: ["wochenrueckblick"] } },
          { toolName: "cal.list", input: {} },
          { toolName: "memory.search", input: { query: "Team-Sync" } },
          {
            toolName: "memory.write",
            input: {
              content:
                "Wochenrückblick: Team-Sync auf Mittwoch verschoben, Kickoff für Projekt Atlas fand statt. Zwei Termine wahrgenommen, keine offenen Punkte.",
              tags: ["wochenrueckblick"],
              title: "Wochenrückblick",
              kind: "erkenntnis",
            },
          },
        ],
        "Diese Woche: Team-Sync verschoben, Kickoff für Projekt Atlas stattgefunden. Zusammenfassung im Gedächtnis abgelegt.",
      );

      const runner = await newSkillRunner(model, [
        ...createCalTools({ pool, artifactRoot, bridge: bridgeWith(fetchImpl) }),
        ...createMemoryTools({ store: memoryStore, pool }),
      ]);
      const result = await runner.run("Wie war meine Woche?");

      expect(result.stop).toBe("done");

      const sessionEvents = await readEvents(pool, runner.session.sessionId);
      const invoked = sessionEvents.find((event) => event.type === "skill.invoked");
      expect(invoked?.payload.names).toEqual(["wochenrueckblick"]);
      expect(sessionEvents.filter((event) => event.type === "tool.failed")).toHaveLength(0);

      // Die neue Notiz kam tatsächlich dazu — dieselbe Ablage, kein zweiter Speicher.
      expect(memoryStore.count()).toBe(2);
      expect(memoryStore.search("Wochenrückblick", 5).length).toBeGreaterThan(0);
    } finally {
      memoryStore?.close();
      await rm(memoryRoot, { recursive: true, force: true });
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Recherche-Ablauf
// ---------------------------------------------------------------------------

describe("Skill · Recherche-Ablauf (S18d)", () => {
  it("sucht, liest zwei Treffer und beantwortet mit Quellenangabe", async () => {
    const hits = [
      {
        title: "Kuronami – Architektur",
        url: "https://example.com/architektur",
        snippet: "Übersicht über die Kuronami-Architektur.",
      },
      {
        title: "Kuronami – Skills",
        url: "https://example.com/skills",
        snippet: "Progressive Offenlegung von Fähigkeiten.",
      },
      {
        title: "Unrelated Ergebnis",
        url: "https://example.com/unrelated",
        snippet: "Betrifft ein anderes Thema.",
      },
    ];
    const search: WebSearchBackend = async () => ({
      provider: "fake",
      hits,
      raw: { echoed: hits.length },
    });

    const pages: Record<string, string> = {
      "https://example.com/architektur":
        "<html><body><p>Kuronami trennt Runtime, Tools und Policy strikt.</p></body></html>",
      "https://example.com/skills":
        "<html><body><p>Skills laden ihre volle Anleitung erst bei Bedarf nach.</p></body></html>",
    };
    const fetchImpl = (async (input: unknown) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
      const body = pages[url];
      if (!body) return new Response("nicht gefunden", { status: 404 });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }) as FetchLike;

    const model = sequenceModel(
      "modell-recherche",
      [
        { toolName: "skill.load", input: { names: ["recherche-ablauf"] } },
        { toolName: "web.search", input: { query: "kuronami architektur skills" } },
        { toolName: "web.fetch", input: { url: "https://example.com/architektur" } },
        { toolName: "web.fetch", input: { url: "https://example.com/skills" } },
      ],
      "Kuronami trennt Runtime, Tools und Policy strikt (example.com/architektur) und lädt Skills erst bei Bedarf vollständig nach (example.com/skills).",
    );

    const tools = createWebTools({
      pool,
      artifactRoot,
      egress: buildEgressPolicy({ allowlist: ["example.com"] }),
      fetchImpl,
      search,
    });
    const runner = await newSkillRunner(model, tools);
    const result = await runner.run("Wie ist Kuronami aufgebaut und wie funktionieren die Skills?");

    expect(result.stop).toBe("done");

    const events = await readEvents(pool, runner.session.sessionId);
    const invoked = events.find((event) => event.type === "skill.invoked");
    expect(invoked?.payload.names).toEqual(["recherche-ablauf"]);
    expect(events.filter((event) => event.type === "tool.failed")).toHaveLength(0);
    expect(
      events.filter(
        (event) => event.type === "tool.completed" && event.payload.tool_name === "web.fetch",
      ),
    ).toHaveLength(2);
    expect(result.text).toContain("architektur");
    expect(result.text).toContain("skills");
  }, 30_000);
});
