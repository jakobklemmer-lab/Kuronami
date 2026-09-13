import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORCHESTRATOR } from "../../context/costs.js";
import { createPool } from "../db/pool.js";
import { appendEvent } from "../events/log.js";
import { listDailySpend } from "./costs.js";

/**
 * S28: `listDailySpend` gegen die echte Datenbank. Geprüft wird genau das, was die reinen Tests
 * in `context/costs.test.ts` **nicht** abdecken können — die Auswahl der Sessions über die
 * Ereignis-Zeitstempel und der Zuschnitt des Tagesfensters.
 *
 * Der Nachweis des Fertig-Kriteriums („Tagesausgaben pro Agent sichtbar") steckt im ersten Test:
 * ein Orchestrator-Lauf und ein delegierter Arbeiter-Lauf am selben Tag erscheinen als zwei
 * getrennte Zeilen mit je eigenem Betrag.
 */

const pool = createPool();
const createdSessions: string[] = [];

async function createSession(channel: "web" | "agent"): Promise<string> {
  const sessionId = `sess_cost_${randomUUID()}`;
  await pool.query(
    `INSERT INTO kuronami.sessions (session_id, thread_id, channel, model_profile, tool_catalog_version)
     VALUES ($1, $2, $3, 'orchestrator-default', 'v1')`,
    [sessionId, `thread_cost_${randomUUID()}`, channel],
  );
  createdSessions.push(sessionId);
  return sessionId;
}

/** Verschiebt ein bereits geschriebenes Ereignis in die Vergangenheit — der einzige Weg, ein
 * Tagesfenster zu prüfen, ohne die Systemuhr anzufassen. */
async function backdate(sessionId: string, days: number): Promise<void> {
  await pool.query(
    "UPDATE kuronami.events SET created_at = created_at - ($2 || ' days')::interval WHERE session_id = $1",
    [sessionId, String(days)],
  );
}

function usage(input: number, output: number) {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
}

let orchestratorId = "";
let workerId = "";
let altId = "";

beforeAll(async () => {
  orchestratorId = await createSession("web");
  workerId = await createSession("agent");
  altId = await createSession("web");

  // Heute: ein Orchestrator-Aufruf und ein delegierter Arbeiter-Lauf.
  await appendEvent(pool, orchestratorId, "session.created");
  await appendEvent(pool, orchestratorId, "model.responded", {
    model: "claude-opus-5",
    usage: usage(1_000_000, 0),
  });
  await appendEvent(pool, orchestratorId, "agent.returned", {
    agent: "lore-writer",
    worker_session: workerId,
  });
  await appendEvent(pool, workerId, "model.responded", {
    model: "claude-sonnet-5",
    usage: usage(1_000_000, 0),
  });

  // Eine dritte Session, zehn Tage alt — sie darf in einem Sieben-Tage-Fenster nicht auftauchen.
  await appendEvent(pool, altId, "model.responded", {
    model: "claude-opus-5",
    usage: usage(5_000_000, 0),
  });
  await backdate(altId, 10);
});

afterAll(async () => {
  for (const sessionId of createdSessions) {
    await pool.query("DELETE FROM kuronami.events WHERE session_id = $1", [sessionId]);
    await pool.query("DELETE FROM kuronami.sessions WHERE session_id = $1", [sessionId]);
  }
  await pool.end();
});

describe("listDailySpend", () => {
  it("zeigt Orchestrator und delegierten Agenten als getrennte Tageszeilen", async () => {
    const report = await listDailySpend(pool, 7);
    const mine = report.days.filter(
      (entry) => entry.agent === ORCHESTRATOR || entry.agent === "lore-writer",
    );

    const worker = mine.find((entry) => entry.agent === "lore-writer");
    expect(worker).toBeDefined();
    expect(worker?.costUsd).toBeCloseTo(2, 6);
    expect(worker?.modelCalls).toBe(1);

    // Der Orchestrator-Eimer kann Zeilen anderer Tests desselben Tages mittragen; geprüft wird
    // deshalb, dass der eigene Aufruf enthalten ist, nicht ein exakter Gesamtbetrag.
    const orchestrator = mine.find((entry) => entry.agent === ORCHESTRATOR);
    expect(orchestrator).toBeDefined();
    expect(orchestrator?.costUsd).toBeGreaterThanOrEqual(5);
  });

  it("laesst einen zehn Tage alten Lauf aus einem Sieben-Tage-Fenster heraus", async () => {
    const short = await listDailySpend(pool, 7);
    const long = await listDailySpend(pool, 30);

    const oldDay = new Date();
    oldDay.setDate(oldDay.getDate() - 10);
    const oldKey = `${oldDay.getFullYear()}-${`${oldDay.getMonth() + 1}`.padStart(2, "0")}-${`${oldDay.getDate()}`.padStart(2, "0")}`;

    expect(short.days.some((entry) => entry.day === oldKey)).toBe(false);
    expect(long.days.some((entry) => entry.day === oldKey)).toBe(true);
  });

  it("nennt Fenstergroesse und Preisstand mit", async () => {
    const report = await listDailySpend(pool, 7);
    expect(report.windowDays).toBe(7);
    expect(report.pricingAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("begrenzt eine uebergrosse Anfrage, statt das ganze Protokoll zu falten", async () => {
    const report = await listDailySpend(pool, 9999);
    expect(report.windowDays).toBe(90);
  });
});
