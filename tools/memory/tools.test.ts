import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPolicyEngine } from "../../policy/engine.js";
import { BACKGROUND_RULES, DEFAULT_RULES } from "../../policy/rules.js";
import { createPool } from "../../runtime/db/pool.js";
import { readEvents } from "../../runtime/events/log.js";
import { createOrResumeSession } from "../../runtime/session/manager.js";
import { replaySession } from "../../runtime/session/state.js";
import type { SessionRecord } from "../../runtime/session/types.js";
import type { JsonValue } from "../../runtime/steps/types.js";
import { ToolRegistry } from "../registry.js";
import { type ToolRouterDeps, callTool } from "../router.js";
import type { ToolResult } from "../types.js";
import { type MemoryStore, NOTES_DIR, createMemoryStore, initMemoryRepo } from "./store.js";
import { createMemoryTools } from "./tools.js";

/**
 * `memory.search` / `memory.write` durch den **echten** Router: echte Datenbank, echte
 * Policy-Engine, echte Ausführungshülle, echte Rückgabehülle. Dazu der Nachweis der
 * Schreibgrenze für Hintergrundläufe, die S17 gefordert und S18 auf den Toolnamen erweitert
 * hat.
 */

const pool = createPool();
const threadIds: string[] = [];
let memoryRoot: string;
let artifactRoot: string;
let store: MemoryStore;

const LONG = "Eine Erkenntnis, die über den heutigen Lauf hinaus gilt und etwas aussagt.";

function memoryDeps(background = false): { deps: ToolRouterDeps; version: string } {
  const catalog = new ToolRegistry().registerAll(createMemoryTools({ store, pool })).freeze();
  const policy = createPolicyEngine({
    // memory.* nimmt weder `path` noch `url` entgegen — der Resolver wird nie gerufen. Dass er
    // wirft, hält das fest (Muster aus `tools/notes/tools.test.ts`).
    resolvePath: async () => {
      throw new Error("Dieser Katalog kennt keine Pfad-Tools");
    },
    rules: background ? [...BACKGROUND_RULES, ...DEFAULT_RULES] : undefined,
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
  memoryRoot = await mkdtemp(path.join(tmpdir(), "kuronami-memtool-"));
  artifactRoot = await mkdtemp(path.join(tmpdir(), "kuronami-memtool-art-"));
  await initMemoryRepo(memoryRoot, { git: false });
  store = await createMemoryStore({
    root: { root: memoryRoot },
    indexFile: ":memory:",
    git: false,
  });
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
  store.close();
  const opts = { recursive: true, force: true, maxRetries: 10, retryDelay: 50 } as const;
  await rm(memoryRoot, opts);
  await rm(artifactRoot, opts);
});

// ---------------------------------------------------------------------------
// Aufbau
// ---------------------------------------------------------------------------

describe("memory.* · Aufbau", () => {
  it("stellt genau zwei Tools bereit: search liest, write schreibt weich", () => {
    const tools = createMemoryTools({ store, pool });
    expect(tools.map((tool) => tool.name).sort()).toEqual(["memory.search", "memory.write"]);
    expect(tools.find((tool) => tool.name === "memory.search")?.risk).toBe("read");
    // `soft_write` und nicht `hard_write` wie `notes.write` (S15): das Gedächtnis ist die
    // eigene Ablage dieses Systems, sie liegt in Git, und ein Assistent, der für jede Notiz
    // nachfragen muss, führt kein Gedächtnis.
    expect(tools.find((tool) => tool.name === "memory.write")?.risk).toBe("soft_write");
  });

  it("nimmt kein Pfadfeld entgegen — der Ort folgt aus Datum und Titel", () => {
    // Mit einem `path`-Feld liefe der Aufruf über den fs-Zonen-Resolver, der `memory/` als
    // Quellzone sähe und auf `hard_write` anhöbe. Dieselbe Überlegung wie beim Feld `note`
    // in S15.
    for (const tool of createMemoryTools({ store, pool })) {
      expect(Object.keys(tool.inputSchema.fields)).not.toContain("path");
      expect(Object.keys(tool.inputSchema.fields)).not.toContain("url");
    }
  });
});

// ---------------------------------------------------------------------------
// memory.write
// ---------------------------------------------------------------------------

describe("memory.write", () => {
  it("legt eine Notiz ab, ohne für eine Freigabe zu pausieren", async () => {
    const { deps, version } = memoryDeps();
    const session = await newSession(version);

    const result = await callTool(deps, session, {
      callId: `call_${randomUUID()}`,
      name: "memory.write",
      input: {
        content: "Der n8n-Workflow für Kalender liefert keine Wiederholungsregeln mit.",
        tags: ["cal", "n8n"],
        title: "Kalender-Workflow ohne Wiederholungen",
      },
    });

    expect(result.status).toBe("ok");
    const noteId = structured(result).id as string;
    expect(noteId).toContain("kalender-workflow-ohne-wiederholungen");

    // Die Datei liegt wirklich, mit Frontmatter und Herkunft.
    const onDisk = await readFile(path.join(memoryRoot, NOTES_DIR, `${noteId}.md`), "utf8");
    expect(onDisk).toContain("art: erkenntnis");
    expect(onDisk).toContain("tags: [cal, n8n]");
    expect(onDisk).toContain(`quelle: session ${session.sessionId}`);

    // Kein Halt an einer Freigabe: der Lauf ist durchgelaufen.
    const types = await eventTypes(session.sessionId);
    expect(types).toContain("policy.allowed");
    expect(types).toContain("tool.completed");
    expect(types).not.toContain("approval.requested");

    // Und der Schnappschuss ist aus dem Protokoll herleitbar (Muster seit S05).
    const replayed = await replaySession(pool, session.sessionId);
    expect(replayed.steps.map((step) => step.status)).toEqual(["completed"]);
  });

  it("weist eine Notiz ohne Tags als Fehlerhülle ab, ohne eine Datei zu hinterlassen", async () => {
    const { deps, version } = memoryDeps();
    const session = await newSession(version);
    const before = store.count();

    const result = await callTool(deps, session, {
      callId: `call_${randomUUID()}`,
      name: "memory.write",
      input: { content: LONG, tags: [] },
    });

    expect(result.status).toBe("error");
    expect(result.summary).toContain("fehlgeschlagen");
    expect(JSON.stringify(structured(result))).toContain("keine Tags");
    expect(store.count()).toBe(before);
  });

  it("weist eine Notizart ab, die es nicht gibt, und nennt AGENTS.md", async () => {
    const { deps, version } = memoryDeps();
    const session = await newSession(version);

    const result = await callTool(deps, session, {
      callId: `call_${randomUUID()}`,
      name: "memory.write",
      input: { content: LONG, tags: ["stil"], kind: "konvention" },
    });

    expect(result.status).toBe("error");
    expect(JSON.stringify(structured(result))).toContain("AGENTS.md");
  });

  it("weist ein supersedes ins Leere ab, statt es stumm zu übergehen", async () => {
    // Ein Verweis auf eine Notiz, die es nicht gibt, sähe im Ergebnis aus wie eine erledigte
    // Korrektur und wäre keine.
    const { deps, version } = memoryDeps();
    const session = await newSession(version);

    const result = await callTool(deps, session, {
      callId: `call_${randomUUID()}`,
      name: "memory.write",
      input: { content: LONG, tags: ["x"], supersedes: ["2020-01-01-gibt-es-nicht"] },
    });

    expect(result.status).toBe("error");
    expect(JSON.stringify(structured(result))).toContain("gibt es nicht");
  });

  it("schreibt memory.conflicted, wenn eine Notiz einer älteren widerspricht", async () => {
    const { deps, version } = memoryDeps();
    const session = await newSession(version);

    const alt = await callTool(deps, session, {
      callId: `call_${randomUUID()}`,
      name: "memory.write",
      input: {
        content: "Die Mail-Brücke liefert Anhänge immer vollständig mit.",
        tags: ["mail", "anhang"],
        title: "Anhänge kommen vollständig",
      },
    });
    const altId = structured(alt).id as string;

    const neu = await callTool(deps, session, {
      callId: `call_${randomUUID()}`,
      name: "memory.write",
      input: {
        content: "Nachgeprüft: Anhänge über zehn Megabyte kommen nur als Verweis.",
        tags: ["mail", "anhang"],
        title: "Große Anhänge kommen als Verweis",
        supersedes: [altId],
      },
    });

    expect(neu.status).toBe("ok");
    expect(structured(neu).ersetzt).toEqual([altId]);
    expect(neu.summary).toContain("Widerspruch vermerkt");

    const events = await readEvents(pool, session.sessionId);
    const conflicted = events.filter((event) => event.type === "memory.conflicted");
    // Genau eines: die erste Notiz traf auf keine älteren zu diesen Tags und hat deshalb zu
    // Recht kein Ereignis ausgelöst. Ein Widerspruchsereignis ohne Widerspruch wäre Lärm.
    expect(conflicted).toHaveLength(1);
    expect(conflicted[0].payload.supersedes).toEqual([altId]);
    expect(conflicted[0].payload.note_id).toBe(structured(neu).id);

    // Beide Notizen stehen weiter da, die alte mit dem Verweis auf die neue.
    expect(store.get(altId)?.supersededBy).toEqual([structured(neu).id]);
    expect(store.get(structured(neu).id as string)).not.toBeNull();
  });

  it("meldet den bloßen Verdacht im summary, ohne einen Widerspruch zu behaupten", async () => {
    const { deps, version } = memoryDeps();
    const session = await newSession(version);

    await callTool(deps, session, {
      callId: `call_${randomUUID()}`,
      name: "memory.write",
      input: {
        content: "Der Server meldet die Auslastung im Fünf-Minuten-Mittel.",
        tags: ["metrik"],
        title: "Auslastung im Mittel",
      },
    });
    const zweite = await callTool(deps, session, {
      callId: `call_${randomUUID()}`,
      name: "memory.write",
      input: {
        content: "Die Plattenbelegung steht in Prozent, nicht in Gigabyte.",
        tags: ["metrik"],
        title: "Platte in Prozent",
      },
    });

    expect(zweite.status).toBe("ok");
    expect(zweite.summary).toContain("ältere Notiz");
    expect(zweite.summary).toContain("supersedes");
    expect(structured(zweite).ersetzt).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// memory.search
// ---------------------------------------------------------------------------

describe("memory.search", () => {
  it("findet eine abgelegte Notiz über eine Frage in natürlicher Sprache", async () => {
    const { deps, version } = memoryDeps();
    const session = await newSession(version);

    await callTool(deps, session, {
      callId: `call_${randomUUID()}`,
      name: "memory.write",
      input: {
        content: "Das Vorgabefenster von cal.list rechnet in der Zeitzone des Läufers.",
        tags: ["zeitzone", "cal"],
        title: "Kalenderfenster ist lokale Zeit",
      },
    });

    const result = await callTool(deps, session, {
      callId: `call_${randomUUID()}`,
      name: "memory.search",
      input: { query: "Wie war das nochmal mit der Zeitzone im Kalender?" },
    });

    expect(result.status).toBe("ok");
    const hits = structured(result).treffer as { titel: string }[];
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((hit) => hit.titel)).toContain("Kalenderfenster ist lokale Zeit");
    expect(result.summary).toContain("passen zu");
  });

  it("antwortet auf einen Fehlschlag mit einer Auskunft, nicht mit einem Fehler", async () => {
    const { deps, version } = memoryDeps();
    const session = await newSession(version);

    const result = await callTool(deps, session, {
      callId: `call_${randomUUID()}`,
      name: "memory.search",
      input: { query: "Ergebnisse der Fußballbundesliga" },
    });

    expect(result.status).toBe("ok");
    expect(structured(result).gefunden).toBe(0);
    expect(result.summary).toContain("kein Fehler");
  });

  it("weist eine leere Anfrage ab", async () => {
    const { deps, version } = memoryDeps();
    const session = await newSession(version);

    const result = await callTool(deps, session, {
      callId: `call_${randomUUID()}`,
      name: "memory.search",
      input: { query: "   " },
    });
    expect(result.status).toBe("error");
  });

  it("kennzeichnet einen Treffer, dem eine neuere Notiz widerspricht", async () => {
    const { deps, version } = memoryDeps();
    const session = await newSession(version);

    const alt = await callTool(deps, session, {
      callId: `call_${randomUUID()}`,
      name: "memory.write",
      input: {
        content: "Die Egress-Liste wird beim Start aus der Umgebung gelesen.",
        tags: ["egress"],
        title: "Egress kommt aus der Umgebung",
      },
    });
    const altId = structured(alt).id as string;
    const neu = await callTool(deps, session, {
      callId: `call_${randomUUID()}`,
      name: "memory.write",
      input: {
        content:
          "Genauer: die Egress-Liste kommt aus der Katalogkonfiguration, nicht der Umgebung.",
        tags: ["egress"],
        title: "Egress kommt aus dem Katalog",
        supersedes: [altId],
      },
    });

    const result = await callTool(deps, session, {
      callId: `call_${randomUUID()}`,
      name: "memory.search",
      input: { query: "Egress-Liste" },
    });

    const hits = structured(result).treffer as {
      id: string;
      ersetzt_durch: string[];
    }[];
    const alteZeile = hits.find((hit) => hit.id === altId);
    expect(alteZeile?.ersetzt_durch).toEqual([structured(neu).id]);
    expect(result.summary).toContain("bestritten");
  });
});

// ---------------------------------------------------------------------------
// Die Schreibgrenze für Hintergrundläufe
// ---------------------------------------------------------------------------

describe("memory.* · Schreibgrenze im Hintergrundlauf", () => {
  it("lehnt memory.write ab, ohne eine Datei anzulegen und ohne zu hängen", async () => {
    // Der Auftrag von S17, mit dem Werkzeug aus S18: ein Lauf ohne Menschen am anderen Ende
    // schreibt nicht ins Gedächtnis. `deny` und nicht `ask` — ein `ask` wäre hier ein `hang`,
    // und eine sessionweite Freigabe wäre die Lücke, durch die die Automatik doch schriebe.
    const { deps, version } = memoryDeps(true);
    const session = await newSession(version);
    const before = store.count();

    const result = await callTool(deps, session, {
      callId: `call_${randomUUID()}`,
      name: "memory.write",
      input: { content: LONG, tags: ["hintergrund"], title: "Sollte nicht entstehen" },
    });

    expect(result.status).toBe("error");
    expect(structured(result).reason).toBe("policy_denied");
    expect(JSON.stringify(structured(result))).toContain("background-memory-tool-write");
    expect(store.count()).toBe(before);

    // Die Ausführungshülle wurde nie betreten: kein Schritt, keine Datei, kein Hänger.
    const types = await eventTypes(session.sessionId);
    expect(types).toContain("policy.denied");
    expect(types).not.toContain("step.started");
    expect(types).not.toContain("approval.requested");
  });

  it("lässt memory.search im Hintergrundlauf zu — lesen ist erlaubt und erwünscht", async () => {
    // Ein Digest, der nicht weiß, was letzte Woche entschieden wurde, wiederholt sich.
    const { deps, version } = memoryDeps(true);
    const session = await newSession(version);

    const result = await callTool(deps, session, {
      callId: `call_${randomUUID()}`,
      name: "memory.search",
      input: { query: "Zeitzone Kalender" },
    });

    expect(result.status).toBe("ok");
    expect(await eventTypes(session.sessionId)).toContain("policy.allowed");
  });

  it("Gegenprobe: mit dem Standardregelsatz geht derselbe Aufruf durch", async () => {
    // Die Sperre ist der Zusatzregelsatz, nicht der Router. Muster aus
    // `heartbeat/background.test.ts`.
    const { deps, version } = memoryDeps(false);
    const session = await newSession(version);

    const result = await callTool(deps, session, {
      callId: `call_${randomUUID()}`,
      name: "memory.write",
      input: { content: LONG, tags: ["hintergrund"], title: "Im Vordergrund erlaubt" },
    });

    expect(result.status).toBe("ok");
    expect(await eventTypes(session.sessionId)).toContain("tool.completed");
  });
});
