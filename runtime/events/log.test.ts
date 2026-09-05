import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "../db/pool.js";
import { appendEvent, readEvents } from "./log.js";
import { EVENT_TYPES, type EventType } from "./types.js";

const pool = createPool();
const createdSessions: string[] = [];

async function createSession(): Promise<string> {
  const sessionId = `sess_test_${randomUUID()}`;
  await pool.query(
    `INSERT INTO kuronami.sessions (session_id, thread_id, channel, model_profile, tool_catalog_version)
     VALUES ($1, $2, 'web', 'orchestrator-default', 'v1')`,
    [sessionId, `thread_test_${randomUUID()}`],
  );
  createdSessions.push(sessionId);
  return sessionId;
}

afterAll(async () => {
  if (createdSessions.length > 0) {
    await pool.query("DELETE FROM kuronami.events WHERE session_id = ANY($1)", [createdSessions]);
    await pool.query("DELETE FROM kuronami.sessions WHERE session_id = ANY($1)", [createdSessions]);
  }
  await pool.end();
});

describe("Ereignisprotokoll", () => {
  it("liest nacheinander geschriebene Ereignisse in genau der Schreibreihenfolge", async () => {
    const sessionId = await createSession();
    const written: EventType[] = [
      "session.created",
      "turn.started",
      "step.started",
      "model.requested",
      "model.responded",
      "step.completed",
      "turn.completed",
    ];

    for (const [index, type] of written.entries()) {
      await appendEvent(pool, sessionId, type, { index });
    }

    const events = await readEvents(pool, sessionId);

    expect(events.map((event) => event.type)).toEqual(written);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(events.map((event) => event.payload.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("vergibt seq lückenlos, wenn viele Schreiber gleichzeitig anhängen", async () => {
    const sessionId = await createSession();
    const count = 25;

    const written = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        appendEvent(pool, sessionId, "tool.completed", { index }),
      ),
    );

    // Gleichzeitige Schreiber haben keine Schreibreihenfolge, die man vergleichen könnte.
    // Nachweisbar ist das, worauf die Wiederaufnahme später baut: jede seq genau einmal,
    // keine Lücke, kein verlorenes Ereignis.
    expect(new Set(written.map((event) => event.seq)).size).toBe(count);

    const events = await readEvents(pool, sessionId);
    expect(events).toHaveLength(count);
    expect(events.map((event) => event.seq)).toEqual(
      Array.from({ length: count }, (_, index) => index + 1),
    );
    expect(new Set(events.map((event) => event.payload.index))).toEqual(
      new Set(Array.from({ length: count }, (_, index) => index)),
    );
  });

  it("zählt seq je Session getrennt und beginnt bei 1", async () => {
    const [first, second] = [await createSession(), await createSession()];

    await appendEvent(pool, first, "session.created");
    await appendEvent(pool, second, "session.created");
    await appendEvent(pool, first, "turn.started");
    await appendEvent(pool, second, "turn.started");
    await appendEvent(pool, second, "turn.completed");

    expect((await readEvents(pool, first)).map((event) => event.seq)).toEqual([1, 2]);
    expect((await readEvents(pool, second)).map((event) => event.seq)).toEqual([1, 2, 3]);
  });

  it("schreibt jeden Typ der Ereignis-Taxonomie", async () => {
    const sessionId = await createSession();

    for (const type of EVENT_TYPES) {
      await appendEvent(pool, sessionId, type);
    }

    const events = await readEvents(pool, sessionId);

    expect(events.map((event) => event.type)).toEqual([...EVENT_TYPES]);
    expect(new Set(events.map((event) => event.type.split(".")[0])).size).toBe(12);
    expect(events.every((event) => event.payload !== null)).toBe(true);
  });

  it("füllt payload und created_at, auch ohne übergebene Nutzdaten", async () => {
    const sessionId = await createSession();

    const event = await appendEvent(pool, sessionId, "artifact.created");

    expect(event.payload).toEqual({});
    expect(event.eventId).toMatch(/^event_/);
    expect(event.createdAt).toBeInstanceOf(Date);
  });

  it("weist ein Ereignis ohne existierende Session ab", async () => {
    await expect(appendEvent(pool, "sess_gibt_es_nicht", "error.raised")).rejects.toThrow(
      /existiert nicht/,
    );
  });

  it("weist Typen ab, die der Namensform widersprechen", async () => {
    const sessionId = await createSession();

    await expect(appendEvent(pool, sessionId, "SessionCreated" as EventType)).rejects.toThrow(
      /Ungültiger Ereignistyp/,
    );
    await expect(appendEvent(pool, sessionId, "session" as EventType)).rejects.toThrow(
      /Ungültiger Ereignistyp/,
    );

    expect(await readEvents(pool, sessionId)).toHaveLength(0);
  });
});
