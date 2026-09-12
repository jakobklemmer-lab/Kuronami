import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEV_TOOLS } from "../../tools/dummies.js";
import { ToolRegistry } from "../../tools/registry.js";
import type { ToolCatalog, ToolDefinition } from "../../tools/types.js";
import { createPool } from "../db/pool.js";
import { readEvents } from "../events/log.js";
import { createOrResumeSession } from "../session/manager.js";
import { AgentNameTakenError, agentCreatedByCall, insertAgent, listAgents } from "./store.js";
import {
  type AgentDraft,
  AgentProfileError,
  checkAgentDraft,
  needsExtraConfirmation,
} from "./types.js";

/**
 * Die Registry gegen die echte Datenbank, und die Profilprüfung ohne sie.
 *
 * Die Prüfung ist der eigentliche Gehalt dieser Datei: sie ist das Tor, durch das **jedes**
 * Profil muss (S19) — `agent.create` heute, die erste Besetzung in S20, ein Betreiber von Hand.
 */

const pool = createPool();
const sessionIds: string[] = [];
const agentNames: string[] = [];

/** Ein Prüf-Tool mit harter Schreibstufe. `dev.*` gehört in keinen produktiven Katalog. */
const DEV_PUSH: ToolDefinition = {
  name: "dev.push",
  description: "Prüf-Tool mit harter Schreibstufe.",
  risk: "hard_write",
  repeatable: false,
  inputSchema: { fields: {} },
  handler: async () => ({ summary: "ok" }),
};

let catalog: ToolCatalog;
let sessionId: string;

beforeAll(async () => {
  catalog = new ToolRegistry().registerAll([...DEV_TOOLS, DEV_PUSH]).freeze();
  const { session } = await createOrResumeSession(pool, {
    threadId: `thread_agents_store_${randomUUID()}`,
    channel: "web",
  });
  sessionId = session.sessionId;
  sessionIds.push(sessionId);
});

afterAll(async () => {
  if (agentNames.length > 0) {
    await pool.query("DELETE FROM kuronami.agents WHERE name = ANY($1)", [agentNames]);
  }
  if (sessionIds.length > 0) {
    await pool.query("DELETE FROM kuronami.events WHERE session_id = ANY($1)", [sessionIds]);
    await pool.query("DELETE FROM kuronami.sessions WHERE session_id = ANY($1)", [sessionIds]);
  }
  await pool.end();
});

function draft(overrides: Partial<AgentDraft> = {}): Record<string, unknown> {
  return {
    name: `test-agent-${randomUUID().slice(0, 8)}`,
    role: "Prüf-Agent",
    purpose: "Sieht nach und meldet, was auffällt.",
    system_prompt: "Du siehst nach und meldest knapp.",
    model: "modell-guenstig",
    tools: ["dev.echo"],
    max_risk: "read",
    max_steps: 8,
    schedule: null,
    ...overrides,
  };
}

describe("Agentenprofil · Prüfung", () => {
  it("nimmt ein sauberes Profil an und räumt es auf", () => {
    const checked = checkAgentDraft(draft({ role: "  Prüf-Agent  " }), { catalog });
    expect(checked.role).toBe("Prüf-Agent");
    expect(checked.tools).toEqual(["dev.echo"]);
    expect(checked.schedule).toBeNull();
  });

  it("weist einen Namen ab, der nicht der Form entspricht", () => {
    expect(() => checkAgentDraft(draft({ name: "Mail Wächter" }), { catalog })).toThrow(
      AgentProfileError,
    );
    expect(() => checkAgentDraft(draft({ name: "-mail" }), { catalog })).toThrow(AgentProfileError);
  });

  it("weist ein Profil ohne Werkzeuge und eines mit unbekanntem Werkzeug ab", () => {
    expect(() => checkAgentDraft(draft({ tools: [] }), { catalog })).toThrow(AgentProfileError);
    expect(() => checkAgentDraft(draft({ tools: ["mail.send"] }), { catalog })).toThrow(
      /steht nicht im Katalog/,
    );
  });

  it("weist ein Werkzeug über der Obergrenze des Profils ab", () => {
    // `dev.push` ist `hard_write`, die Obergrenze steht auf `read`: ein Widerspruch, kein Detail.
    expect(() =>
      checkAgentDraft(draft({ tools: ["dev.echo", "dev.push"], max_risk: "read" }), { catalog }),
    ).toThrow(/Obergrenze des Profils/);

    // Mit passender Obergrenze geht dasselbe Profil durch — und verlangt dann eine
    // Zusatzbestätigung.
    const checked = checkAgentDraft(draft({ tools: ["dev.push"], max_risk: "hard_write" }), {
      catalog,
    });
    expect(needsExtraConfirmation(checked.max_risk)).toBe(true);
    expect(needsExtraConfirmation("soft_write")).toBe(false);
  });

  it("weist verbotene Werkzeuge ab, auch wenn sie im Katalog stünden", () => {
    expect(() =>
      checkAgentDraft(draft({ tools: ["dev.echo"] }), {
        catalog,
        forbiddenTools: ["dev.echo"],
      }),
    ).toThrow(AgentProfileError);
  });

  it("prüft den Cron-Ausdruck beim Anlegen, nicht erst beim ersten fälligen Lauf", () => {
    expect(checkAgentDraft(draft({ schedule: "*/20 * * * *" }), { catalog }).schedule).toBe(
      "*/20 * * * *",
    );
    expect(() => checkAgentDraft(draft({ schedule: "alle 20 Minuten" }), { catalog })).toThrow();
    expect(() => checkAgentDraft(draft({ schedule: "*/20 * * *" }), { catalog })).toThrow();
  });

  it("weist ein Schrittbudget außerhalb der Spanne ab", () => {
    expect(() => checkAgentDraft(draft({ max_steps: 0 }), { catalog })).toThrow(AgentProfileError);
    expect(() => checkAgentDraft(draft({ max_steps: 5_000 }), { catalog })).toThrow(
      AgentProfileError,
    );
  });
});

describe("Agenten-Registry · Zeile und Ereignis", () => {
  it("trägt ein Profil ein, schreibt agent.created und findet es wieder", async () => {
    const checked = checkAgentDraft(draft({ schedule: "*/20 * * * *" }), { catalog });
    agentNames.push(checked.name);

    const callId = `call_${randomUUID()}`;
    const profile = await insertAgent(pool, sessionId, checked, {
      createdBy: "operator",
      callId,
    });

    expect(profile.status).toBe("active");
    expect(profile.schedule).toBe("*/20 * * * *");
    expect(profile.createdInSession).toBe(sessionId);

    const events = await readEvents(pool, sessionId);
    const created = events.filter(
      (event) => event.type === "agent.created" && event.payload.name === checked.name,
    );
    expect(created).toHaveLength(1);
    expect(created[0].payload.tools).toEqual(["dev.echo"]);
    expect(created[0].payload.call_id).toBe(callId);

    // Die Wiederaufnahme-Frage: derselbe Aufruf findet seinen eigenen Eintrag wieder.
    const again = await agentCreatedByCall(pool, sessionId, callId);
    expect(again?.agentId).toBe(profile.agentId);
    expect(await agentCreatedByCall(pool, sessionId, `call_${randomUUID()}`)).toBeNull();

    // Der Lesepfad des Heartbeats: aktiv **und** mit Zeitplan.
    const scheduled = await listAgents(pool, { status: "active", scheduledOnly: true });
    expect(scheduled.map((entry) => entry.name)).toContain(checked.name);
  });

  it("lässt denselben Namen kein zweites Mal zu", async () => {
    const checked = checkAgentDraft(draft(), { catalog });
    agentNames.push(checked.name);
    await insertAgent(pool, sessionId, checked, { createdBy: "operator" });

    await expect(insertAgent(pool, sessionId, checked, { createdBy: "operator" })).rejects.toThrow(
      AgentNameTakenError,
    );

    // Und kein halber Eintrag: genau ein `agent.created` zu diesem Namen im Protokoll.
    const events = await readEvents(pool, sessionId);
    expect(
      events.filter(
        (event) => event.type === "agent.created" && event.payload.name === checked.name,
      ),
    ).toHaveLength(1);
  });

  it("führt den Profiltext durch den Redaction-Filter", async () => {
    const checked = checkAgentDraft(
      draft({
        purpose: "Meldet, was ansteht. api_key: sk-ant-api03-GEHEIMGEHEIMGEHEIMGEHEIM",
      }),
      { catalog },
    );
    agentNames.push(checked.name);

    const profile = await insertAgent(pool, sessionId, checked, { createdBy: "operator" });
    expect(profile.purpose).not.toContain("sk-ant-api03-GEHEIMGEHEIMGEHEIMGEHEIM");
    expect(profile.purpose).toContain("Meldet, was ansteht.");
  });
});
