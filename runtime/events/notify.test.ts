import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createPool } from "../db/pool.js";
import { RuntimeEventBus } from "./bus.js";
import { appendEventInTx } from "./log.js";
import { type EventNotifyListenerHandle, startEventNotifyListener } from "./notify.js";

/**
 * Der S21-Nachtrag: `appendEventInTx` sagt seither per `pg_notify` an (in derselben
 * Transaktion wie die Einfügung), und diese Datei prüft die lauschende Seite gegen die
 * **echte** Datenbank — kein Nachbau, weil genau das Zusammenspiel mit COMMIT/ROLLBACK das
 * ist, was hier zählen soll.
 */

const pool = createPool();
const createdSessions: string[] = [];
const handles: EventNotifyListenerHandle[] = [];

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

/**
 * Ohne eigenen Kanal je Test: `appendEventInTx` (`log.ts`) sagt immer auf dem festen
 * `EVENT_NOTIFY_CHANNEL` an, ein Testkanal daneben hörte nie etwas. Isolation zwischen den
 * Tests kommt stattdessen aus der zufälligen `session_id` jedes Tests, nach der die
 * Vorhersagen unten filtern.
 */
async function listener(bus = new RuntimeEventBus()): Promise<{
  bus: RuntimeEventBus;
  handle: EventNotifyListenerHandle;
}> {
  const handle = await startEventNotifyListener(pool, { bus, baseBackoffMs: 20 });
  handles.push(handle);
  return { bus, handle };
}

function waitForEvent(
  bus: RuntimeEventBus,
  predicate: (event: { type: string; data: Record<string, unknown> }) => boolean,
  timeoutMs = 2000,
): Promise<{ type: string; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("Kein passendes Ereignis binnen der Frist."));
    }, timeoutMs);
    const unsubscribe = bus.subscribe((event) => {
      if (!predicate(event)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(event);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
});

afterAll(async () => {
  if (createdSessions.length > 0) {
    await pool.query("DELETE FROM kuronami.events WHERE session_id = ANY($1)", [createdSessions]);
    await pool.query("DELETE FROM kuronami.sessions WHERE session_id = ANY($1)", [createdSessions]);
  }
  await pool.end();
});

describe("Ereignisbus über pg_notify (S21-Nachtrag)", () => {
  it("sagt ein Ereignis erst nach dem COMMIT an, nie davor", async () => {
    const { bus } = await listener();
    const sessionId = await createSession();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await appendEventInTx(client, sessionId, "turn.started", { turn_id: "t1" });

      const isMine = (event: { type: string; data: Record<string, unknown> }): boolean =>
        event.type === "turn.started" && event.data.session_id === sessionId;

      const tooEarly = waitForEvent(bus, isMine, 300).then(
        () => "kam",
        () => "kam nicht",
      );
      expect(await tooEarly).toBe("kam nicht");

      const arrived = waitForEvent(bus, isMine);
      await client.query("COMMIT");
      const event = await arrived;
      expect(event.data.session_id).toBe(sessionId);
    } finally {
      client.release();
    }
  });

  it("sagt ein zurückgerolltes Ereignis nie an", async () => {
    const { bus } = await listener();
    const sessionId = await createSession();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await appendEventInTx(client, sessionId, "turn.started", { turn_id: "rollback" });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    const outcome = await waitForEvent(
      bus,
      (event) => event.type === "turn.started" && event.data.session_id === sessionId,
      400,
    ).then(
      () => "kam",
      () => "kam nicht",
    );
    expect(outcome).toBe("kam nicht");
  });

  it("liefert den bereits gefilterten Datensatz aus der Zeile, nicht aus dem NOTIFY-Payload", async () => {
    const { bus } = await listener();
    const sessionId = await createSession();
    const arrived = waitForEvent(bus, (event) => event.data.session_id === sessionId);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await appendEventInTx(client, sessionId, "tool.requested", {
        secret_key: "ANTHROPIC_API_KEY=sk-geheim",
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const event = await arrived;
    expect(JSON.stringify(event.data.payload)).not.toContain("sk-geheim");
    expect(JSON.stringify(event.data.payload)).toContain("redacted");
  });

  it("meldet sich nach einem Abriss der lauschenden Verbindung selbst wieder an", async () => {
    const { bus, handle } = await listener();
    expect(handle.connected).toBe(true);
    const pid = handle.pid;
    expect(pid).not.toBeNull();

    await pool.query("SELECT pg_terminate_backend($1)", [pid]);

    await sleep(150);
    // Backoff ist 20ms Basis — reichlich Zeit für mehrere Versuche.
    await sleep(500);
    expect(handle.connected).toBe(true);

    const sessionId = await createSession();
    const arrived = waitForEvent(bus, (event) => event.data.session_id === sessionId);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await appendEventInTx(client, sessionId, "turn.started", { turn_id: "nach-abriss" });
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    await arrived;
  });
});
