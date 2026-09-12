import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertAgent, readAgent } from "../runtime/agents/store.js";
import { checkAgentDraft } from "../runtime/agents/types.js";
import { createPool } from "../runtime/db/pool.js";
import { type EventRecord, readEvents } from "../runtime/events/log.js";
import { type BuiltCatalog, buildCatalog, createRunner } from "../runtime/loop/api.js";
import { createScriptedModel } from "../runtime/loop/scripted.js";
import type { ModelClient } from "../runtime/model/types.js";
import { parseCron } from "../runtime/schedule/cron.js";
import { createOrResumeSession } from "../runtime/session/manager.js";
import type { DigestChannel } from "./delivery.js";
import { type Heartbeat, createHeartbeat } from "./service.js";

/**
 * Agenten mit Zeitplan, mit gestellter Uhr (S19).
 *
 * Das Fertig-Kriterium dahinter ist "Neuer Agent per Sprachbefehl anlegbar, **sofort aktiv**":
 * angelegt wird er in `tools/agent/tools.test.ts`, aktiv wird er hier — ohne dass jemand den
 * Dienst neu startet, allein dadurch, dass seine Zeile in der Registry steht.
 */

const pool = createPool();
const sessionIds: string[] = [];
const agentNames: string[] = [];
let sourceRoot: string;
let artifactRoot: string;
let built: BuiltCatalog;
let registrySessionId: string;

let clock = new Date(2026, 8, 9, 10, 0);
const delivered: string[] = [];
const channel: DigestChannel = {
  id: "test",
  async deliver(text: string) {
    delivered.push(text);
  },
};

/** Ein Arbeiter, der sofort meldet — ohne Werkzeugaufruf, der Lauf ist nach einem Zug fertig. */
function answeringModel(model: string, text: string): ModelClient {
  return {
    model,
    async complete() {
      return {
        model,
        stopReason: "end_turn",
        text,
        toolCalls: [],
        usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 },
        content: [{ type: "text", text }],
      };
    },
  };
}

const lautModel = answeringModel("modell-laut", "Zwei neue Mails, eine davon wichtig.");
const stillModel = answeringModel("modell-still", "STILL");

beforeAll(async () => {
  sourceRoot = await mkdtemp(path.join(tmpdir(), "kuronami-hb-agents-"));
  artifactRoot = path.join(sourceRoot, "artifacts");
  await mkdir(artifactRoot, { recursive: true });
  built = await buildCatalog({ pool, artifactRoot, sourceRoot, profile: "background" });

  const { session } = await createOrResumeSession(pool, {
    threadId: `thread_agents_registry_${randomUUID()}`,
    channel: "web",
  });
  registrySessionId = session.sessionId;
  sessionIds.push(registrySessionId);
});

afterAll(async () => {
  if (agentNames.length > 0) {
    await pool.query("DELETE FROM kuronami.agents WHERE name = ANY($1)", [agentNames]);
  }
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

async function registerAgent(overrides: Record<string, unknown>): Promise<string> {
  const name = `hb-agent-${randomUUID().slice(0, 8)}`;
  agentNames.push(name);
  const draft = checkAgentDraft(
    {
      name,
      role: "Prüf-Agent",
      purpose: "Sieht nach und meldet.",
      system_prompt: "Du siehst nach und meldest knapp.",
      model: "modell-laut",
      // `fs.list` steht im Hintergrundkatalog (S17) — ein Agent kann nicht mehr bekommen, als
      // der Prozess hat, der ihn laufen lässt.
      tools: ["fs.list"],
      max_risk: "read",
      max_steps: 3,
      schedule: "*/20 * * * *",
      ...overrides,
    },
    { catalog: built.catalog },
  );
  await insertAgent(pool, registrySessionId, draft, {
    createdBy: "test",
    status: (overrides.status as "active" | "paused" | undefined) ?? "active",
  });
  return name;
}

async function makeHeartbeat(): Promise<Heartbeat> {
  const hb = await createHeartbeat({
    pool,
    artifactRoot,
    catalog: built.catalog,
    policy: built.policy,
    model: lautModel,
    modelFor: (name) => (name === "modell-still" ? stillModel : lautModel),
    channel,
    conventions: "# Test",
    maxRunsPerDay: 20,
    digestCron: IDLE_DIGEST_CRON,
    pollMs: 10_000_000,
    diaryThread: `thread_heartbeat_agents_${randomUUID()}`,
    now: () => clock,
  });
  sessionIds.push(hb.diarySessionId);
  return hb;
}

/**
 * Ein Digest-Zeitplan, der in diesem Test nie feuert (1. Januar, 03:00): hier geht es um die
 * Agenten, nicht um den Morgen-Digest.
 */
const IDLE_DIGEST_CRON = parseCron("0 3 1 1 *");

/** Die Läufe **dieses** Agenten im Diarium. Die Registry ist global, die Zählung nicht. */
function runsOf(events: EventRecord[], agent: string): EventRecord[] {
  for (const event of events) {
    const runSession = (event.payload as { run_session?: string }).run_session;
    if (runSession && !sessionIds.includes(runSession)) sessionIds.push(runSession);
  }
  return events.filter(
    (event) =>
      event.type === "heartbeat.ran" &&
      (event.payload as { kind?: string; agent?: string }).kind === "agent" &&
      (event.payload as { agent?: string }).agent === agent,
  );
}

describe("Heartbeat · Agenten mit Zeitplan", () => {
  it("lässt einen fälligen Agenten genau einmal je Anlass laufen und stellt seine Meldung zu", async () => {
    const name = await registerAgent({});
    const hb = await makeHeartbeat();
    delivered.length = 0;

    // 10:00 ist ein Anlass des Ausdrucks "*/20 * * * *".
    clock = new Date(2026, 8, 9, 10, 0);
    await hb.tickAgents();
    let events = await readEvents(pool, hb.diarySessionId);
    expect(runsOf(events, name)).toHaveLength(1);
    expect(delivered.filter((text) => text.startsWith(`[${name}]`))).toHaveLength(1);
    expect(delivered.find((text) => text.startsWith(`[${name}]`))).toContain("Zwei neue Mails");

    // Zwei weitere Ticks im selben Anlass: kein zweiter Lauf.
    clock = new Date(2026, 8, 9, 10, 5);
    await hb.tickAgents();
    clock = new Date(2026, 8, 9, 10, 19);
    await hb.tickAgents();
    events = await readEvents(pool, hb.diarySessionId);
    expect(runsOf(events, name)).toHaveLength(1);

    // Ein **Neustart** des Dienstes ändert daran nichts: die Buchführung steht im Protokoll.
    const restarted = await createHeartbeat({
      pool,
      artifactRoot,
      catalog: built.catalog,
      policy: built.policy,
      model: lautModel,
      channel,
      conventions: "# Test",
      maxRunsPerDay: 20,
      digestCron: IDLE_DIGEST_CRON,
      pollMs: 10_000_000,
      diaryThread: (
        await pool.query<{ thread_id: string }>(
          "SELECT thread_id FROM kuronami.sessions WHERE session_id = $1",
          [hb.diarySessionId],
        )
      ).rows[0].thread_id,
      now: () => clock,
    });
    await restarted.tickAgents();
    expect(runsOf(await readEvents(pool, hb.diarySessionId), name)).toHaveLength(1);

    // 10:20: neuer Anlass, neuer Lauf.
    clock = new Date(2026, 8, 9, 10, 20);
    await hb.tickAgents();
    const runs = runsOf(await readEvents(pool, hb.diarySessionId), name);
    expect(runs).toHaveLength(2);
    expect(runs[0].payload.ok).toBe(true);
    expect(runs[0].payload.delivered).toBe(true);
    expect(runs[0].payload.model).toBe("modell-laut");
    expect(runs[0].payload.model_from_profile).toBe(true);
  });

  it("meldet sich nicht, wenn es nichts zu melden gibt", async () => {
    const name = await registerAgent({ model: "modell-still" });
    const hb = await makeHeartbeat();
    delivered.length = 0;

    clock = new Date(2026, 8, 9, 11, 0);
    await hb.tickAgents();

    const events = await readEvents(pool, hb.diarySessionId);
    expect(runsOf(events, name)).toHaveLength(1);
    expect(runsOf(events, name)[0].payload.delivered).toBe(false);
    expect(
      events.filter(
        (event) =>
          event.type === "heartbeat.silent" && (event.payload as { agent?: string }).agent === name,
      ),
    ).toHaveLength(1);
    expect(delivered.filter((text) => text.startsWith(`[${name}]`))).toHaveLength(0);
  });

  it("lässt einen pausierten Agenten nicht laufen", async () => {
    const name = await registerAgent({ status: "paused" });
    const hb = await makeHeartbeat();

    clock = new Date(2026, 8, 9, 12, 0);
    await hb.tickAgents();

    expect(runsOf(await readEvents(pool, hb.diarySessionId), name)).toHaveLength(0);
  });

  it("Fertig-Kriterium: per Sprachbefehl angelegt, ohne Neustart sofort fällig", async () => {
    // 1. Der Nutzer sagt einen Satz. Der Hauptagent ruft `agent.create` — über die echte
    //    Schleife, den echten Router und die echte Policy; nur die Modelle sind Doubles.
    const name = `hb-agent-${randomUUID().slice(0, 8)}`;
    agentNames.push(name);
    const profile = JSON.stringify({
      name,
      role: "Mail-Agent",
      purpose: "Sieht alle 20 Minuten nach neuen Mails und meldet, was wichtig ist.",
      system_prompt: "Du siehst nach neuen Mails und meldest nur, was wirklich wichtig ist.",
      model: "modell-laut",
      tools: ["fs.list"],
      max_risk: "read",
      max_steps: 3,
      schedule: "*/20 * * * *",
    });

    const full = await buildCatalog({
      pool,
      artifactRoot,
      sourceRoot,
      agents: { model: answeringModel("modell-entwurf", profile), conventions: "# Test" },
    });

    const threadId = `thread_agent_create_${randomUUID()}`;
    const runner = await createRunner({
      pool,
      threadId,
      channel: "web",
      artifactRoot,
      catalog: full.catalog,
      policy: full.policy,
      model: createScriptedModel({
        steps: 1,
        step: () => ({
          toolName: "agent.create",
          input: { request: "erstelle einen Agenten, der alle 20 Minuten meine Mails checkt" },
        }),
        finalText: "Der Agent steht.",
      }),
      conventions: "# Test",
    });
    sessionIds.push(runner.session.sessionId);

    try {
      const first = await runner.run(
        "erstelle einen Agenten, der alle 20 Minuten meine Mails checkt",
      );
      // Halt 1: die Policy (agent.create ist hartes Schreiben).
      expect(first.stop).toBe("awaiting_user");
      await runner.answer(first.pendingUserInput[0].askId, "once");

      // Halt 2: die Bestätigung des Profils.
      const second = await runner.run();
      expect(second.stop).toBe("awaiting_user");
      const confirm = second.pendingUserInput[0];
      expect(confirm.question).toContain(name);
      expect(confirm.question).toContain("*/20 * * * *");
      await runner.answer(confirm.askId, "anlegen");

      const third = await runner.run();
      expect(third.stop).toBe("done");
    } finally {
      await runner.stop("test-ende").catch(() => {});
    }

    const created = await readAgent(pool, name);
    expect(created?.status).toBe("active");
    expect(created?.schedule).toBe("*/20 * * * *");

    // 2. **Ohne Neustart** irgendeines Dienstes: der Heartbeat findet ihn beim nächsten Tick in
    //    der Registry und lässt ihn laufen. Das ist "sofort aktiv".
    const hb = await makeHeartbeat();
    delivered.length = 0;
    clock = new Date(2026, 8, 9, 14, 0);
    await hb.tickAgents();

    const runs = runsOf(await readEvents(pool, hb.diarySessionId), name);
    expect(runs).toHaveLength(1);
    expect(runs[0].payload.ok).toBe(true);
    expect(runs[0].payload.fire).toBe(new Date(2026, 8, 9, 14, 0).toISOString());
    expect(delivered.find((text) => text.startsWith(`[${name}]`))).toContain("Zwei neue Mails");
  });

  it("meldet einen Agenten, dessen Werkzeuge dieser Prozess nicht hat, als Fehlschlag", async () => {
    // `web.fetch` steht im Hintergrundkatalog — `user.ask` nicht, und `mail.search` ohne n8n
    // auch nicht. Der Agent wird an einem Katalog geprüft, der beides kennt, und läuft dann in
    // einem Prozess, der es nicht tut.
    const name = `hb-agent-${randomUUID().slice(0, 8)}`;
    agentNames.push(name);
    await pool.query(
      `INSERT INTO kuronami.agents
         (agent_id, name, role, purpose, system_prompt, model, tools, max_risk, max_steps,
          schedule, status, created_by)
       VALUES ($1, $2, 'Prüf-Agent', 'Sieht nach.', 'Du siehst nach.', 'modell-laut',
               '["mail.search"]'::jsonb, 'read', 3, '*/20 * * * *', 'active', 'test')`,
      [`agent_${randomUUID()}`, name],
    );

    const hb = await makeHeartbeat();
    clock = new Date(2026, 8, 9, 13, 0);
    const runs = await hb.tickAgents();

    const mine = runs.find((run) => run.agent === name);
    expect(mine?.status).toBe("failed");
    expect(mine?.reason).toContain("mail.search");

    const events = await readEvents(pool, hb.diarySessionId);
    expect(runsOf(events, name)[0].payload.ok).toBe(false);
  });
});
