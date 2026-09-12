import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApprovalRequiredError, decidePolicyApproval } from "../../policy/approvals.js";
import { createPolicyEngine } from "../../policy/engine.js";
import { insertAgent, readAgent } from "../../runtime/agents/store.js";
import { checkAgentDraft } from "../../runtime/agents/types.js";
import { createPool } from "../../runtime/db/pool.js";
import { readEvents } from "../../runtime/events/log.js";
import { type Runner, createRunner } from "../../runtime/loop/api.js";
import { createScriptedModel } from "../../runtime/loop/scripted.js";
import type {
  ModelClient,
  ModelContentBlock,
  ModelRequest,
  ModelResponse,
} from "../../runtime/model/types.js";
import { createOrResumeSession } from "../../runtime/session/manager.js";
import type { SessionRecord } from "../../runtime/session/types.js";
import { UserInputRequiredError, answerUserInput } from "../../runtime/session/user-input.js";
import { DEV_TOOLS } from "../dummies.js";
import { buildFsZones, policyResolver } from "../fs/paths.js";
import { createFsTools } from "../fs/tools.js";
import { ToolRegistry } from "../registry.js";
import { type ToolRouterDeps, callTool } from "../router.js";
import { createTaskTools } from "../task/tools.js";
import type { ToolCatalog, ToolDefinition } from "../types.js";
import { createUserTools } from "../user/tools.js";
import { createAgentTools } from "./tools.js";

/**
 * `agent.create` und `agent.delegate` gegen die echte Datenbank, den echten Router und die
 * echte Policy-Engine. Nur die Modelle sind Doubles — das Entwurfsmodell antwortet mit einem
 * festen Profil-JSON, das Arbeitermodell nach Drehbuch.
 *
 * Was hier bewiesen wird und was nicht: dass der **Weg** hält (Entwurf genau einmal, Eintrag
 * erst nach der Bestätigung, Zusatzbestätigung bei harter Schreibstufe, isolierter Kontext und
 * enge Werkzeugliste beim Arbeiter). Ob ein echtes Modell aus "alle 20 Minuten meine Mails
 * checken" ein sinnvolles Profil formt, hängt an semantischem Verständnis und ist ohne
 * `ANTHROPIC_API_KEY` nicht prüfbar — derselbe offene Befund wie überall seit S18a.
 */

const pool = createPool();
const sessionIds: string[] = [];
const threadIds: string[] = [];
const agentNames: string[] = [];
const openRunners: Runner[] = [];

const FIXED_USAGE = {
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

/** Ein Prüf-Tool mit harter Schreibstufe, für die Zusatzbestätigung. */
const DEV_PUSH: ToolDefinition = {
  name: "dev.push",
  description: "Prüf-Tool mit harter Schreibstufe.",
  risk: "hard_write",
  repeatable: false,
  inputSchema: { fields: {} },
  handler: async () => ({ summary: "gepusht" }),
};

let sourceRoot: string;
let artifactRoot: string;
let catalog: ToolCatalog;
let policy: ReturnType<typeof createPolicyEngine>;
let router: ToolRouterDeps;

/** Was das Entwurfsmodell als Nächstes antwortet, und wie oft es gefragt wurde. */
let draftAnswer = "{}";
let draftCalls = 0;
let lastDraftPrompt = "";

const draftModel: ModelClient = {
  model: "modell-entwurf",
  async complete(request: ModelRequest) {
    draftCalls += 1;
    lastDraftPrompt = String(request.messages[0].content[0].text ?? "");
    return {
      model: "modell-entwurf",
      stopReason: "end_turn",
      text: draftAnswer,
      toolCalls: [],
      usage: FIXED_USAGE,
      content: [{ type: "text", text: draftAnswer }],
    };
  },
};

/** Was der Arbeiter wirklich zu sehen bekam. */
const workerRequests: ModelRequest[] = [];
const workerModel: ModelClient = {
  model: "modell-arbeiter",
  async complete(request: ModelRequest): Promise<ModelResponse> {
    workerRequests.push(request);
    const done = request.messages.some((message) =>
      message.content.some((block) => block.type === "tool_result"),
    );
    if (!done) {
      const input = { message: "gezaehlt" };
      const toolUse: ModelContentBlock = {
        type: "tool_use",
        id: "call_worker_1",
        name: "dev__echo",
        input,
      };
      return {
        model: "modell-arbeiter",
        stopReason: "tool_use",
        text: "Ich sehe nach.",
        toolCalls: [{ callId: "call_worker_1", name: "dev__echo", input }],
        usage: FIXED_USAGE,
        content: [{ type: "text", text: "Ich sehe nach." }, toolUse],
      };
    }
    const text = "ERGEBNIS-DES-ARBEITERS: drei Dateien, nichts Auffälliges.";
    return {
      model: "modell-arbeiter",
      stopReason: "end_turn",
      text,
      toolCalls: [],
      usage: FIXED_USAGE,
      content: [{ type: "text", text }],
    };
  },
};

beforeAll(async () => {
  sourceRoot = await mkdtemp(path.join(tmpdir(), "kuronami-agent-"));
  artifactRoot = path.join(sourceRoot, "artifacts");
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, "AGENTS.md"), "# Konventionen\n\nKein ORM.\n");

  const zones = await buildFsZones({ sourceRoot, artifactRoot });
  policy = createPolicyEngine({ resolvePath: policyResolver(zones) });

  const registry = new ToolRegistry()
    .registerAll(createFsTools({ pool, artifactRoot, zones }))
    .registerAll(createTaskTools({ pool }))
    .registerAll(createUserTools({ pool }))
    .registerAll([...DEV_TOOLS, DEV_PUSH]);

  // Derselbe Zweischritt wie in `runtime/loop/api.ts`: die Agenten-Tools bekommen den Katalog,
  // wie er **vor** ihnen aussah — daraus kann kein Profil und kein Arbeiter `agent.*` ziehen.
  const withoutAgentTools = registry.freeze();
  catalog = registry
    .registerAll(
      createAgentTools({
        pool,
        artifactRoot,
        catalog: withoutAgentTools,
        policy,
        draftModel,
        modelFor: (name) => (name === "modell-arbeiter" ? workerModel : draftModel),
        conventions: "# Konventionen\n\nKein ORM.",
        models: { routine: "modell-guenstig", thinking: "modell-stark" },
      }),
    )
    .freeze();

  router = { pool, artifactRoot, catalog, policy };
});

afterAll(async () => {
  for (const runner of openRunners) await runner.stop("test-ende").catch(() => {});
  if (agentNames.length > 0) {
    await pool.query("DELETE FROM kuronami.agents WHERE name = ANY($1)", [agentNames]);
  }
  if (threadIds.length > 0) {
    const rows = await pool.query<{ session_id: string }>(
      "SELECT session_id FROM kuronami.sessions WHERE thread_id = ANY($1)",
      [threadIds],
    );
    for (const row of rows.rows)
      if (!sessionIds.includes(row.session_id)) sessionIds.push(row.session_id);
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

async function newSession(): Promise<SessionRecord> {
  const threadId = `thread_agent_test_${randomUUID()}`;
  threadIds.push(threadId);
  const { session } = await createOrResumeSession(pool, {
    threadId,
    channel: "web",
    defaults: { toolCatalogVersion: catalog.version },
  });
  sessionIds.push(session.sessionId);
  return session;
}

function profileJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: `mail-waechter-${randomUUID().slice(0, 6)}`,
    role: "Mail-Agent",
    purpose: "Sieht alle 20 Minuten nach neuen Mails und meldet, was wichtig ist.",
    system_prompt: "Du siehst nach neuen Mails und meldest nur, was wirklich wichtig ist.",
    model: "modell-guenstig",
    tools: ["dev.echo"],
    max_risk: "read",
    max_steps: 6,
    schedule: "*/20 * * * *",
    ...overrides,
  });
}

describe("agent.create · Fertig-Kriterium: neuer Agent per Sprachbefehl, sofort aktiv", () => {
  it("entwirft, fragt nach und legt erst nach der Bestätigung an", async () => {
    const session = await newSession();
    const callId = `call_${randomUUID()}`;
    draftAnswer = profileJson();
    const name = JSON.parse(draftAnswer).name as string;
    agentNames.push(name);
    const before = draftCalls;

    const call = {
      callId,
      name: "agent.create",
      input: { request: "erstelle einen Agenten, der alle 20 Minuten meine Mails checkt" },
    };

    // 1. Die Policy zuerst: `agent.create` ist hartes Schreiben (es ändert die Datenbank).
    await expect(callTool(router, session, call)).rejects.toThrow(ApprovalRequiredError);
    expect(await readAgent(pool, name)).toBeNull();
    expect(draftCalls).toBe(before);

    await decidePolicyApproval(pool, session.sessionId, `policy:${callId}`, "once");

    // 2. Jetzt entwirft das Modell — und der Lauf hält an der Bestätigung an.
    await expect(callTool(router, session, call)).rejects.toThrow(UserInputRequiredError);
    expect(draftCalls).toBe(before + 1);
    expect(await readAgent(pool, name)).toBeNull();

    // Der Entwurfs-Prompt trägt den echten Katalog samt Risikostufen — nicht das Gedächtnis
    // des Modells.
    expect(lastDraftPrompt).toContain("dev.echo (read)");
    expect(lastDraftPrompt).toContain("alle 20 Minuten meine Mails checkt");
    // Verbotene Werkzeuge stehen gar nicht erst in der Auswahl.
    expect(lastDraftPrompt).not.toContain("agent.delegate");
    expect(lastDraftPrompt).not.toContain("user.ask");

    // Die Frage steht mit strukturierten Optionen im Protokoll, samt Profil.
    const events = await readEvents(pool, session.sessionId);
    const ask = events.find(
      (event) => event.type === "approval.requested" && event.payload.kind === "agent_create",
    );
    expect(ask).toBeDefined();
    expect((ask?.payload.options as { id: string }[]).map((option) => option.id)).toEqual([
      "anlegen",
      "abbrechen",
    ]);
    expect((ask?.payload.details as { profile: { schedule: string } }).profile.schedule).toBe(
      "*/20 * * * *",
    );

    // 3. Der Nutzer bestätigt.
    await answerUserInput(pool, session.sessionId, `ask:${callId}`, "anlegen");
    const result = await callTool(router, session, call);

    expect(result.status).toBe("ok");
    const structured = result.structured as Record<string, unknown>;
    expect(structured.name).toBe(name);
    expect(structured.schedule).toBe("*/20 * * * *");
    expect(structured.scheduled).toBe(true);
    expect(structured.status).toBe("active");

    // Der Modellaufruf lief **genau einmal**, obwohl der Handler dreimal lief: der Entwurf kam
    // beim Fortsetzen aus der Rückfrage.
    expect(draftCalls).toBe(before + 1);

    const profile = await readAgent(pool, name);
    expect(profile?.status).toBe("active");
    expect(profile?.tools).toEqual(["dev.echo"]);
    expect(profile?.createdInSession).toBe(session.sessionId);

    const after = await readEvents(pool, session.sessionId);
    expect(after.filter((event) => event.type === "agent.created")).toHaveLength(1);
    // Die Antwort trägt die Art der Frage, nicht die des Schreibwegs.
    const granted = after.find(
      (event) => event.type === "approval.granted" && event.payload.ask_id === `ask:${callId}`,
    );
    expect(granted?.payload.kind).toBe("agent_create");

    // 4. Derselbe Aufruf noch einmal (Wiederaufnahme): kein zweiter Agent, kein zweiter Entwurf.
    const again = await callTool(router, session, call);
    expect(again.status).toBe("ok");
    expect((again.structured as Record<string, unknown>).name).toBe(name);
    expect(draftCalls).toBe(before + 1);
    expect(
      (await readEvents(pool, session.sessionId)).filter((event) => event.type === "agent.created"),
    ).toHaveLength(1);
  });

  it("verlangt bei harter Schreibstufe eine Zusatzbestätigung", async () => {
    const session = await newSession();
    const callId = `call_${randomUUID()}`;
    draftAnswer = profileJson({
      tools: ["dev.echo", "dev.push"],
      max_risk: "hard_write",
      schedule: null,
    });
    const name = JSON.parse(draftAnswer).name as string;
    agentNames.push(name);

    const call = { callId, name: "agent.create", input: { request: "einen Agenten, der pusht" } };

    await expect(callTool(router, session, call)).rejects.toThrow(ApprovalRequiredError);
    await decidePolicyApproval(pool, session.sessionId, `policy:${callId}`, "once");
    await expect(callTool(router, session, call)).rejects.toThrow(UserInputRequiredError);
    await answerUserInput(pool, session.sessionId, `ask:${callId}`, "anlegen");

    // Die erste Bestätigung reicht **nicht**: es folgt die zweite, schärfere Frage.
    await expect(callTool(router, session, call)).rejects.toThrow(UserInputRequiredError);
    expect(await readAgent(pool, name)).toBeNull();

    const events = await readEvents(pool, session.sessionId);
    const riskAsk = events.find(
      (event) =>
        event.type === "approval.requested" && event.payload.ask_id === `ask:${callId}:risk`,
    );
    expect(riskAsk).toBeDefined();
    expect(String(riskAsk?.payload.question)).toContain("stehende Erlaubnis");
    expect((riskAsk?.payload.details as { max_risk: string }).max_risk).toBe("hard_write");

    await answerUserInput(pool, session.sessionId, `ask:${callId}:risk`, "verstanden");
    const result = await callTool(router, session, call);
    expect(result.status).toBe("ok");
    expect((await readAgent(pool, name))?.maxRisk).toBe("hard_write");
  });

  it("legt nichts an, wenn die Zusatzbestätigung verweigert wird", async () => {
    const session = await newSession();
    const callId = `call_${randomUUID()}`;
    draftAnswer = profileJson({
      tools: ["dev.push"],
      max_risk: "hard_write",
      schedule: null,
    });
    const name = JSON.parse(draftAnswer).name as string;
    agentNames.push(name);

    const call = { callId, name: "agent.create", input: { request: "einen Agenten, der pusht" } };
    await expect(callTool(router, session, call)).rejects.toThrow(ApprovalRequiredError);
    await decidePolicyApproval(pool, session.sessionId, `policy:${callId}`, "once");
    await expect(callTool(router, session, call)).rejects.toThrow(UserInputRequiredError);
    await answerUserInput(pool, session.sessionId, `ask:${callId}`, "anlegen");
    await expect(callTool(router, session, call)).rejects.toThrow(UserInputRequiredError);
    await answerUserInput(pool, session.sessionId, `ask:${callId}:risk`, "abbrechen");

    const result = await callTool(router, session, call);
    expect(result.status).toBe("ok");
    expect((result.structured as Record<string, unknown>).created).toBe(false);
    expect(await readAgent(pool, name)).toBeNull();
  });

  it("legt nichts an, wenn der Entwurf abgelehnt wird", async () => {
    const session = await newSession();
    const callId = `call_${randomUUID()}`;
    draftAnswer = profileJson({ schedule: null });
    const name = JSON.parse(draftAnswer).name as string;
    agentNames.push(name);

    const call = { callId, name: "agent.create", input: { request: "irgendeinen Agenten" } };
    await expect(callTool(router, session, call)).rejects.toThrow(ApprovalRequiredError);
    await decidePolicyApproval(pool, session.sessionId, `policy:${callId}`, "once");
    await expect(callTool(router, session, call)).rejects.toThrow(UserInputRequiredError);
    await answerUserInput(pool, session.sessionId, `ask:${callId}`, "abbrechen");

    const result = await callTool(router, session, call);
    expect(result.status).toBe("ok");
    expect((result.structured as Record<string, unknown>).created).toBe(false);
    expect(await readAgent(pool, name)).toBeNull();
  });

  it("meldet ein unbrauchbares Profil als Fehlerhülle statt es einzutragen", async () => {
    const session = await newSession();
    draftAnswer = profileJson({ tools: ["mail.send"] });
    const callId = `call_${randomUUID()}`;
    const call = { callId, name: "agent.create", input: { request: "einen Mail-Versender" } };

    await expect(callTool(router, session, call)).rejects.toThrow(ApprovalRequiredError);
    await decidePolicyApproval(pool, session.sessionId, `policy:${callId}`, "once");

    const result = await callTool(router, session, call);
    expect(result.status).toBe("error");
    expect(result.summary).toContain("agent.create");
    expect(JSON.stringify(result.structured)).toContain("steht nicht im Katalog");
  });
});

describe("agent.delegate · Orchestrator-Worker mit isoliertem Kontext", () => {
  it("gibt den Auftrag ab, hält den Kontext getrennt und liefert nur das Ergebnis zurück", async () => {
    const name = `zaehler-${randomUUID().slice(0, 6)}`;
    agentNames.push(name);
    const session = await newSession();
    await insertAgent(
      pool,
      session.sessionId,
      checkAgentDraft(
        {
          name,
          role: "Zähler",
          purpose: "Zählt Dateien und meldet die Zahl.",
          system_prompt: "ROLLENTEXT-DES-AGENTEN: Du zählst und meldest knapp.",
          model: "modell-arbeiter",
          tools: ["dev.echo"],
          max_risk: "read",
          max_steps: 4,
          schedule: null,
        },
        { catalog },
      ),
      { createdBy: "test" },
    );

    workerRequests.length = 0;

    // Der Hauptagent läuft über die echte Schleife — nur so entsteht eine Historie, von der
    // sich zeigen lässt, dass der Arbeiter sie **nicht** sieht.
    const threadId = `thread_agent_test_${randomUUID()}`;
    threadIds.push(threadId);
    const runner = await createRunner({
      pool,
      threadId,
      channel: "web",
      artifactRoot,
      catalog,
      policy,
      model: createScriptedModel({
        steps: 1,
        step: () => ({
          toolName: "agent.delegate",
          input: { agent: name, task: "Zähl die Dateien im Arbeitsverzeichnis." },
        }),
        finalText: "Der Arbeiter hat geantwortet.",
      }),
      conventions: "# Konventionen\n\nKein ORM.",
    });
    openRunners.push(runner);
    sessionIds.push(runner.session.sessionId);

    const first = await runner.run("GEHEIMWORT-DES-HAUPTAGENTEN: bitte delegieren.");
    expect(first.stop).toBe("awaiting_user");
    await runner.answer(first.pendingUserInput[0].askId, "once");
    const second = await runner.run();
    expect(second.stop).toBe("done");

    const events = await readEvents(pool, runner.session.sessionId);
    const delegated = events.find((event) => event.type === "agent.delegated");
    const returned = events.find((event) => event.type === "agent.returned");
    expect(delegated?.payload.agent).toBe(name);
    expect(delegated?.payload.tools).toEqual(["dev.echo"]);
    expect(delegated?.payload.model_from_profile).toBe(true);
    expect(returned?.payload.stop).toBe("done");
    expect(returned?.payload.tool_calls).toBe(1);

    // Eine eigene Session auf dem Kanal `agent` — das ist der isolierte Kontext.
    const workerSessionId = String(returned?.payload.worker_session);
    expect(workerSessionId).not.toBe(runner.session.sessionId);
    sessionIds.push(workerSessionId);
    const workerSession = await pool.query<{ channel: string; mode: string }>(
      "SELECT channel, mode FROM kuronami.sessions WHERE session_id = $1",
      [workerSessionId],
    );
    expect(workerSession.rows[0].channel).toBe("agent");
    expect(workerSession.rows[0].mode).toBe("worker");

    // Was der Arbeiter zu sehen bekam: seine Rolle, seinen Auftrag — und nichts aus der
    // Unterhaltung des Hauptagenten.
    expect(workerRequests.length).toBeGreaterThan(0);
    const firstRequest = workerRequests[0];
    const systemText = firstRequest.system.map((block) => block.text).join("\n");
    expect(systemText).toContain("ROLLENTEXT-DES-AGENTEN");
    const history = JSON.stringify(firstRequest.messages);
    expect(history).toContain("Zähl die Dateien");
    expect(history).not.toContain("GEHEIMWORT-DES-HAUPTAGENTEN");

    // Explizite Tool-Beschränkung, und keine rekursiven Subagenten: genau das eine Werkzeug
    // aus dem Profil steht in der Werkzeugliste.
    for (const request of workerRequests) {
      expect(request.tools.map((tool) => tool.name)).toEqual(["dev__echo"]);
    }

    // Zurück kommt nur das Ergebnis — es steht in der Historie des Hauptagenten.
    const completed = events.find(
      (event) => event.type === "tool.completed" && event.payload.tool_name === "agent.delegate",
    );
    expect(String(completed?.payload.summary)).toContain("ERGEBNIS-DES-ARBEITERS");

    // Und die Zwischenschritte des Arbeiters stehen **nur** in seiner eigenen Session.
    const workerEvents = await readEvents(pool, workerSessionId);
    expect(workerEvents.some((event) => event.type === "session.completed")).toBe(true);
    expect(
      workerEvents.filter(
        (event) => event.type === "tool.completed" && event.payload.tool_name === "dev.echo",
      ),
    ).toHaveLength(1);
    expect(
      events.some(
        (event) => event.type === "tool.completed" && event.payload.tool_name === "dev.echo",
      ),
    ).toBe(false);
  });

  it("meldet einen unbekannten Agenten als Fehlerhülle mit den bekannten Namen", async () => {
    const session = await newSession();
    const callId = `call_${randomUUID()}`;
    const call = {
      callId,
      name: "agent.delegate",
      input: { agent: "gibt-es-nicht", task: "irgendwas" },
    };

    await expect(callTool(router, session, call)).rejects.toThrow(ApprovalRequiredError);
    await decidePolicyApproval(pool, session.sessionId, `policy:${callId}`, "once");

    const result = await callTool(router, session, call);
    expect(result.status).toBe("error");
    expect(JSON.stringify(result.structured)).toContain("agent.create");
  });
});
