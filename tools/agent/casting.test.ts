import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CastingEntry, FIRST_CASTING, castingDraft } from "../../runtime/agents/besetzung.js";
import { type AgentProfile, checkAgentDraft } from "../../runtime/agents/types.js";
import { createPool } from "../../runtime/db/pool.js";
import { type EventRecord, readEvents } from "../../runtime/events/log.js";
import { type BuiltCatalog, buildCatalog } from "../../runtime/loop/api.js";
import type { ModelClient, ModelRequest, ModelResponse } from "../../runtime/model/types.js";
import { createOrResumeSession } from "../../runtime/session/manager.js";
import { readSessionState } from "../../runtime/session/state.js";
import type { JsonValue } from "../../runtime/steps/types.js";
import { type ToolRouterDeps, callTool } from "../router.js";
import { agentToolsHook } from "./policy.js";
import { runWorker } from "./worker.js";

/**
 * Die erste Besetzung im Betrieb (S20): jede der sieben Rollen bekommt eine einfache Aufgabe
 * **und** einen Werkzeug-Verstoß.
 *
 * Der Verstoß ist der eigentliche Gegenstand. "Werkzeug-Zugriff ist rollenspezifisch, nie
 * pauschal" (Abschnitt 14) ist erst dann eine Zusage, wenn ein Aufruf außerhalb der Liste
 * **abgelehnt** wird — nicht, wenn im Prompt steht, dass man es lassen soll. Geprüft werden
 * beide Tore, die das sicherstellen, und sie halten aus verschiedenen Gründen:
 *
 *   1. **Der Katalog.** Ein Arbeiter bekommt nur die Werkzeuge seines Profils; jedes andere
 *      ist für ihn ein unbekanntes Tool (S19).
 *   2. **Die Policy.** Ein Hook am Profil lehnt den Aufruf ab, auch wenn der Katalog ihn kennt
 *      (S20) — der Fall, der entsteht, wenn jemand `runWorker` künftig mit einem breiteren
 *      Katalog aufruft.
 */

const pool = createPool();
const sessionIds: string[] = [];
let sourceRoot: string;
let artifactRoot: string;
let built: BuiltCatalog;

const FIXED_USAGE = {
  inputTokens: 120,
  outputTokens: 30,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

/** Die einfache Aufgabe je Rolle: ein Werkzeug **aus** ihrer Liste. */
const PROBE: Record<string, { tool: string; input: Record<string, JsonValue> }> = {
  coder: { tool: "fs.read", input: { path: "probe.txt" } },
  visualizer: { tool: "fs.list", input: { path: "." } },
  "ui-designer": { tool: "fs.list", input: { path: "." } },
  "lore-writer": { tool: "fs.read", input: { path: "probe.txt" } },
  "trading-agent": { tool: "fs.read", input: { path: "probe.txt" } },
  "backtest-agent": { tool: "fs.list", input: { path: "." } },
  // Der Mail-Agent hat nur `mail.*`; ohne erreichbares n8n scheitert der Aufruf — aber er wird
  // **ausgeführt**, und genau darum geht es hier: die Werkzeugliste lässt ihn durch.
  "mail-agent": { tool: "mail.search", input: { query: "Rechnung", limit: 5 } },
};

/** Der Verstoß je Rolle: ein Werkzeug, das es im Katalog gibt, aber nicht in ihrer Liste. */
const VIOLATION: Record<string, { tool: string; input: Record<string, JsonValue> }> = {
  coder: { tool: "mail.search", input: { query: "irgendwas" } },
  visualizer: { tool: "fs.edit", input: { path: "probe.txt" } },
  "ui-designer": { tool: "mail.draft", input: { to: "a@b.de", subject: "x", body: "y" } },
  "lore-writer": { tool: "web.fetch", input: { url: "https://example.com" } },
  "trading-agent": { tool: "mail.draft", input: { to: "a@b.de", subject: "x", body: "y" } },
  "backtest-agent": { tool: "web.search", input: { query: "kurse" } },
  "mail-agent": { tool: "fs.read", input: { path: "probe.txt" } },
};

beforeAll(async () => {
  sourceRoot = await mkdtemp(path.join(tmpdir(), "kuronami-casting-"));
  artifactRoot = path.join(sourceRoot, "artifacts");
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, "probe.txt"), "Probeinhalt für die Besetzung.\n");
  await writeFile(path.join(sourceRoot, "AGENTS.md"), "# Konventionen\n\nKein ORM.\n");

  built = await buildCatalog({
    pool,
    artifactRoot,
    sourceRoot,
    n8n: { mail: true, cal: true, server: true },
    memory: { root: path.join(sourceRoot, "memory"), indexFile: ":memory:", git: false },
    skills: { root: path.join(sourceRoot, "skills") },
  });
});

afterAll(async () => {
  built?.memory?.close();
  if (sessionIds.length > 0) {
    await pool.query("DELETE FROM kuronami.artifacts WHERE (source ->> 'session_id') = ANY($1)", [
      sessionIds,
    ]);
    for (const table of ["approvals", "tasks", "steps", "events"]) {
      await pool.query(`DELETE FROM kuronami.${table} WHERE session_id = ANY($1)`, [sessionIds]);
    }
    await pool.query("DELETE FROM kuronami.sessions WHERE session_id = ANY($1)", [sessionIds]);
  }
  await pool.end();
  if (sourceRoot) await rm(sourceRoot, { recursive: true, force: true });
});

/**
 * Ein Profil aus der Besetzung, ohne Zeile in der Registry: `runWorker` bekommt das Profil
 * übergeben und schlägt nichts nach. Der Weg über die Tabelle ist in
 * `runtime/agents/besetzung.test.ts` geprüft; hier geht es um das Verhalten im Lauf.
 */
function profileOf(entry: CastingEntry): AgentProfile {
  const draft = checkAgentDraft(castingDraft(entry), { catalog: built.catalog });
  return {
    agentId: `agent_test_${draft.name}`,
    name: draft.name,
    role: draft.role,
    purpose: draft.purpose,
    systemPrompt: draft.system_prompt,
    model: draft.model,
    tools: draft.tools,
    maxRisk: draft.max_risk,
    maxSteps: draft.max_steps,
    tokenBudget: draft.token_budget,
    schedule: draft.schedule,
    status: "active",
    createdBy: "test",
    createdInSession: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** Ein Modell, das genau einen Aufruf macht und danach fertig antwortet. */
function oneCallModel(tool: string, input: Record<string, JsonValue>): ModelClient {
  const model = "modell-besetzung";
  return {
    model,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const done = request.messages.some((message) =>
        message.content.some((block) => block.type === "tool_result"),
      );
      if (done) {
        const text = "FERTIG: Auftrag ausgeführt.";
        return {
          model,
          stopReason: "end_turn",
          text,
          toolCalls: [],
          usage: FIXED_USAGE,
          content: [{ type: "text", text }],
        };
      }
      const apiName = tool.replace(".", "__");
      return {
        model,
        stopReason: "tool_use",
        text: "Ich fange an.",
        toolCalls: [{ callId: "call_probe", name: apiName, input }],
        usage: FIXED_USAGE,
        content: [
          { type: "text", text: "Ich fange an." },
          { type: "tool_use", id: "call_probe", name: apiName, input },
        ],
      };
    },
  };
}

async function runOnce(
  profile: AgentProfile,
  step: { tool: string; input: Record<string, JsonValue> },
  task: string,
) {
  const run = await runWorker(
    {
      pool,
      artifactRoot,
      catalog: built.catalog,
      policy: built.policy,
      model: oneCallModel(step.tool, step.input),
      conventions: "# Konventionen\n\nKein ORM.",
    },
    { profile, task, threadId: `thread_agent_${profile.name}_${randomUUID()}` },
  );
  sessionIds.push(run.sessionId);
  return run;
}

function toolEvents(events: EventRecord[], type: "tool.completed" | "tool.failed"): EventRecord[] {
  return events.filter((event) => event.type === type);
}

describe("Erste Besetzung · jede Rolle erledigt eine einfache Aufgabe", () => {
  for (const entry of FIRST_CASTING) {
    it(`${entry.name} läuft mit seinen eigenen Werkzeugen`, async () => {
      const profile = profileOf(entry);
      const probe = PROBE[entry.name];
      expect(profile.tools).toContain(probe.tool);

      const run = await runOnce(profile, probe, `Sieh einmal nach: ${probe.tool}.`);
      expect(run.stop).toBe("done");
      expect(run.text).toContain("FERTIG");
      expect(run.tokensSpent).toBeGreaterThan(0);

      const events = await readEvents(pool, run.sessionId);
      // Der Aufruf wurde ausgeführt — nicht als unbekannt und nicht von der Policy abgelehnt.
      const failed = toolEvents(events, "tool.failed");
      for (const event of failed) {
        expect(event.payload.reason).not.toBe("unknown_tool");
        expect(event.payload.reason).not.toBe("policy_denied");
      }
      const requested = events.find((event) => event.type === "tool.requested");
      expect(requested?.payload.tool_name).toBe(probe.tool);

      // Die Werkzeugliste der Anfrage ist genau das Profil — nicht der Katalog des Prozesses.
      const session = await readSessionState(pool, run.sessionId);
      expect(session.status).toBe("completed");
    });
  }
});

describe("Erste Besetzung · jede Rolle weist einen Werkzeug-Verstoß ab", () => {
  for (const entry of FIRST_CASTING) {
    it(`${entry.name} lehnt ${VIOLATION[entry.name].tool} ab`, async () => {
      const profile = profileOf(entry);
      const violation = VIOLATION[entry.name];
      // Das Werkzeug gibt es — im Katalog des Prozesses, aber nicht in diesem Profil.
      expect(built.catalog.get(violation.tool)).toBeDefined();
      expect(profile.tools).not.toContain(violation.tool);

      const run = await runOnce(profile, violation, `Ruf einmal ${violation.tool} auf.`);
      // Der Lauf bricht nicht ab: eine Ablehnung ist eine Auskunft, kein Absturz (Abschnitt 7).
      expect(run.stop).toBe("done");

      const events = await readEvents(pool, run.sessionId);
      const failed = toolEvents(events, "tool.failed");
      expect(failed).toHaveLength(1);
      // In der Schreibweise, in der das Modell es versucht hat: der Katalog des Arbeiters kennt
      // den Namen nicht, also übersetzt ihn auch niemand zurück (`toolNameDecoder`, S07 —
      // ein unbekannter Name wird nicht stillschweigend umgeschrieben).
      expect(failed[0].payload.tool_name).toBe(violation.tool.replace(".", "__"));
      expect(failed[0].payload.reason).toBe("unknown_tool");
      // Und die Ablehnung sagt, was **erlaubt** gewesen wäre: genau die Liste des Profils.
      expect(failed[0].payload.known_tools).toEqual([...profile.tools].sort());
      // Kein Seiteneffekt: das verbotene Werkzeug lief nicht.
      expect(toolEvents(events, "tool.completed")).toHaveLength(0);
    });
  }
});

describe("Erste Besetzung · das zweite Tor: die Policy hängt am Profil, nicht am Katalog", () => {
  it("lehnt ein Werkzeug außerhalb der Liste auch dann ab, wenn der Katalog es kennt", async () => {
    const profile = profileOf(FIRST_CASTING[0]);
    const { session } = await createOrResumeSession(pool, {
      threadId: `thread_agent_hook_${randomUUID()}`,
      channel: "agent",
      defaults: { toolCatalogVersion: built.catalog.version },
    });
    sessionIds.push(session.sessionId);

    // Absichtlich der **volle** Katalog — der Fall, gegen den der Hook absichert.
    const router: ToolRouterDeps = {
      pool,
      artifactRoot,
      catalog: built.catalog,
      policy: built.policy.withHooks([agentToolsHook(profile)]),
    };

    const result = await callTool(router, session, {
      callId: `call_${randomUUID()}`,
      name: "mail.search",
      input: { query: "irgendwas" },
      origin: "model",
    });

    expect(result.status).toBe("error");
    const structured = result.structured as Record<string, unknown>;
    expect(structured.reason).toBe("policy_denied");
    expect(JSON.stringify(structured.policy_path)).toContain(`agent-toolset:${profile.name}`);
    expect(result.summary).toContain("abgelehnt");

    // Dieselbe Engine ohne den Hook ließe den Aufruf durch — der Hook ist der Unterschied und
    // nicht eine ohnehin geltende Regel.
    const events = await readEvents(pool, session.sessionId);
    const denied = events.find((event) => event.type === "policy.denied");
    expect(JSON.stringify(denied?.payload)).toContain("Werkzeugliste ist abschließend");
  });

  it("lässt ein Werkzeug aus der Liste durch (der Hook verschärft nur)", async () => {
    const profile = profileOf(FIRST_CASTING[0]);
    const { session } = await createOrResumeSession(pool, {
      threadId: `thread_agent_hook_ok_${randomUUID()}`,
      channel: "agent",
      defaults: { toolCatalogVersion: built.catalog.version },
    });
    sessionIds.push(session.sessionId);

    const result = await callTool(
      {
        pool,
        artifactRoot,
        catalog: built.catalog,
        policy: built.policy.withHooks([agentToolsHook(profile)]),
      },
      session,
      {
        callId: `call_${randomUUID()}`,
        name: "fs.list",
        input: { path: "." },
        origin: "model",
      },
    );

    expect(result.status).toBe("ok");
  });
});
