import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPolicyEngine } from "../../policy/engine.js";
import { createPool } from "../../runtime/db/pool.js";
import { readEvents } from "../../runtime/events/log.js";
import { createOrResumeSession } from "../../runtime/session/manager.js";
import type { SessionRecord } from "../../runtime/session/types.js";
import type { JsonValue } from "../../runtime/steps/types.js";
import { ToolRegistry } from "../registry.js";
import { type ToolRouterDeps, callTool } from "../router.js";
import type { ToolResult } from "../types.js";
import { loadSkillCatalog } from "./catalog.js";
import { createSkillTools } from "./tools.js";

/**
 * `skill.load` durch den echten Router (S18c, Abschnitt 9). `context/request.test.ts` prüft
 * die andere Hälfte (die Kurzliste im Prompt); hier geht es um das Tool selbst — dieselbe
 * Bauart wie `tools/tool/tools.test.ts` für `tool.load`: `execution: "runtime"`, kein Schritt,
 * und die zwei Ereignisse, die ein erfolgreicher Aufruf hinterlässt (`tool.completed` und das
 * eigene `skill.invoked`).
 */

const pool = createPool();
const threadIds: string[] = [];
let root: string;

async function writeSkill(name: string, body: string): Promise<void> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "SKILL.md"),
    `---\ntitel: ${name}\nbeschreibung: Testfähigkeit ${name}.\nwann: Im Test.\n---\n\n${body}\n`,
    "utf8",
  );
}

const policy = createPolicyEngine({
  resolvePath: async () => {
    throw new Error("Dieser Katalog kennt keine Pfad-Tools");
  },
});

function structured(result: ToolResult): Record<string, JsonValue> {
  return result.structured as Record<string, JsonValue>;
}

async function newSession(catalogVersion: string): Promise<SessionRecord> {
  const threadId = `thread_test_${randomUUID()}`;
  threadIds.push(threadId);
  const { session } = await createOrResumeSession(pool, {
    threadId,
    channel: "web",
    defaults: { toolCatalogVersion: catalogVersion },
  });
  return session;
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kuronami-skill-tools-"));
  // Zehn Dummy-Skills, wie im Sessionauftrag verlangt — hier reicht für den Router-Nachweis
  // eine Handvoll benannter, der Rest der Zehnerprobe steht in `catalog.test.ts`.
  for (let i = 1; i <= 10; i += 1) {
    await writeSkill(
      `dummy-${String(i).padStart(2, "0")}`,
      `Vollständige Anleitung für Dummy-Skill ${i}. Dieser Text steht erst nach skill.load im Kontext, MARKER-${i}.`,
    );
  }
});

afterAll(async () => {
  if (threadIds.length > 0) {
    const sessions = "SELECT session_id FROM kuronami.sessions WHERE thread_id = ANY($1)";
    await pool.query(`DELETE FROM kuronami.events WHERE session_id IN (${sessions})`, [threadIds]);
    await pool.query(`DELETE FROM kuronami.steps WHERE session_id IN (${sessions})`, [threadIds]);
    await pool.query("DELETE FROM kuronami.sessions WHERE thread_id = ANY($1)", [threadIds]);
  }
  await pool.end();
  await rm(root, { recursive: true, force: true });
});

describe("skill.load über den Router", () => {
  it("lädt die vollständige Anleitung eines bekannten Skills, ohne einen Schritt zu erzeugen", async () => {
    const catalog = await loadSkillCatalog(root);
    const toolCatalog = new ToolRegistry()
      .registerAll(createSkillTools({ catalog, pool }))
      .freeze();
    const deps: ToolRouterDeps = {
      pool,
      artifactRoot: "/nicht/benutzt",
      catalog: toolCatalog,
      policy,
    };
    const session = await newSession(toolCatalog.version);

    const result = await callTool(deps, session, {
      callId: "c_load",
      name: "skill.load",
      input: { names: ["dummy-05"] },
    });

    expect(result.status).toBe("ok");
    expect(structured(result).loaded).toEqual(["dummy-05"]);
    expect(structured(result).not_found).toEqual([]);
    const skills = structured(result).skills as Record<string, JsonValue>;
    const loaded = skills["dummy-05"] as Record<string, JsonValue>;
    expect(loaded.titel).toBe("dummy-05");
    // Der volle Rumpf, nicht nur die Kurzbeschreibung — genau das ist "vollständig geladen".
    expect(loaded.inhalt).toContain("MARKER-5");

    // Kein Schritt: dasselbe Muster wie tool.load (S18b). `skill.invoked` steht zusätzlich zum
    // generischen `tool.completed` da — das eigene Ereignis für "welcher Skill wurde benutzt".
    const types = (await readEvents(pool, session.sessionId)).map((event) => event.type);
    expect(types).toEqual([
      "session.created",
      "tool.requested",
      "policy.allowed",
      "skill.invoked",
      "tool.completed",
    ]);
  });

  it("schreibt skill.invoked mit dem geladenen Namen und Pfad", async () => {
    const catalog = await loadSkillCatalog(root);
    const toolCatalog = new ToolRegistry()
      .registerAll(createSkillTools({ catalog, pool }))
      .freeze();
    const deps: ToolRouterDeps = {
      pool,
      artifactRoot: "/nicht/benutzt",
      catalog: toolCatalog,
      policy,
    };
    const session = await newSession(toolCatalog.version);

    await callTool(deps, session, {
      callId: "c_invoked",
      name: "skill.load",
      input: { names: ["dummy-01", "dummy-02"] },
    });

    const invoked = (await readEvents(pool, session.sessionId)).find(
      (event) => event.type === "skill.invoked",
    );
    expect(invoked?.payload.names).toEqual(["dummy-01", "dummy-02"]);
    const skills = invoked?.payload.skills as { name: string; path: string }[];
    expect(skills.map((entry) => entry.path)).toEqual(["dummy-01/SKILL.md", "dummy-02/SKILL.md"]);
  });

  it("meldet unbekannte Namen, ohne die bekannten darunter fallen zu lassen", async () => {
    const catalog = await loadSkillCatalog(root);
    const toolCatalog = new ToolRegistry()
      .registerAll(createSkillTools({ catalog, pool }))
      .freeze();
    const deps: ToolRouterDeps = {
      pool,
      artifactRoot: "/nicht/benutzt",
      catalog: toolCatalog,
      policy,
    };
    const session = await newSession(toolCatalog.version);

    const result = await callTool(deps, session, {
      callId: "c_mixed",
      name: "skill.load",
      input: { names: ["dummy-01", "erfunden-skill"] },
    });

    expect(result.status).toBe("ok");
    expect(structured(result).loaded).toEqual(["dummy-01"]);
    expect(structured(result).not_found).toEqual(["erfunden-skill"]);

    // Kein Treffer heißt kein skill.invoked — es wurde ja etwas geladen (dummy-01), also doch
    // eines; die Gegenprobe (ausschließlich unbekannte Namen) steht im nächsten Fall.
  });

  it("schreibt kein skill.invoked, wenn kein einziger Name bekannt ist", async () => {
    const catalog = await loadSkillCatalog(root);
    const toolCatalog = new ToolRegistry()
      .registerAll(createSkillTools({ catalog, pool }))
      .freeze();
    const deps: ToolRouterDeps = {
      pool,
      artifactRoot: "/nicht/benutzt",
      catalog: toolCatalog,
      policy,
    };
    const session = await newSession(toolCatalog.version);

    const result = await callTool(deps, session, {
      callId: "c_unknown_only",
      name: "skill.load",
      input: { names: ["nie-gehoert"] },
    });

    expect(result.status).toBe("ok");
    expect(structured(result).loaded).toEqual([]);
    const types = (await readEvents(pool, session.sessionId)).map((event) => event.type);
    expect(types).not.toContain("skill.invoked");
  });

  it("weist eine leere oder falsch geformte Namensliste ab", async () => {
    const catalog = await loadSkillCatalog(root);
    const toolCatalog = new ToolRegistry()
      .registerAll(createSkillTools({ catalog, pool }))
      .freeze();
    const deps: ToolRouterDeps = {
      pool,
      artifactRoot: "/nicht/benutzt",
      catalog: toolCatalog,
      policy,
    };
    const session = await newSession(toolCatalog.version);

    const result = await callTool(deps, session, {
      callId: "c_leer",
      name: "skill.load",
      input: { names: [] },
    });

    expect(result.status).toBe("error");
    expect(structured(result).reason).toBe("handler_failed");
  });
});
