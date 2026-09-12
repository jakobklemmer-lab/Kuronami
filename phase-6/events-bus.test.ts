import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  type BusEvent,
  RuntimeEventBus,
  attachEventSocket,
  originAllowed,
  startEventServer,
} from "../runtime/events/bus.js";
import type { EventRecord } from "../runtime/events/log.js";

/**
 * Die Runtime-Seite des Ereignisbusses (S21): der Bus selbst, der WebSocket-Endpunkt und die
 * Zusage, dass von außen nichts hineingeschrieben werden kann.
 *
 * Die Tests laufen gegen einen **echten** Server auf einem vom System vergebenen Port (`0`)
 * und einen echten `ws`-Client. Ein Nachbau des Protokolls würde genau das nicht prüfen, was
 * hier schiefgehen kann: Upgrade, Pfad, Herkunft, Rahmenrichtung.
 */

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function record(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    eventId: "event_1",
    sessionId: "session_1",
    seq: 1,
    type: "turn.started",
    payload: { turn_id: "turn_1" },
    createdAt: new Date("2026-09-12T10:00:00.000Z"),
    ...overrides,
  };
}

/** Verbindet einen echten Client und sammelt, was ankommt. */
async function connect(
  url: string,
  options?: { origin?: string },
): Promise<{ socket: WebSocket; received: BusEvent[]; next(): Promise<BusEvent> }> {
  const socket = new WebSocket(url, options?.origin ? { origin: options.origin } : undefined);
  const received: BusEvent[] = [];
  const waiting: Array<(event: BusEvent) => void> = [];
  // `next()` liest der Reihe nach ab, statt auf den *nächsten* Rahmen zu warten: die
  // Begrüßung steht schon da, bevor der erste Test danach fragt.
  let cursor = 0;

  socket.on("message", (raw) => {
    const event = JSON.parse(String(raw)) as BusEvent;
    received.push(event);
    if (waiting.length > 0 && cursor < received.length) {
      cursor += 1;
      waiting.shift()?.(event);
    }
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  cleanups.push(() => {
    socket.close();
  });

  return {
    socket,
    received,
    next: () =>
      new Promise<BusEvent>((resolve, reject) => {
        if (cursor < received.length) {
          const event = received[cursor];
          cursor += 1;
          resolve(event);
          return;
        }
        const timer = setTimeout(() => reject(new Error("Kein Ereignis binnen 2 s.")), 2000);
        waiting.push((event) => {
          clearTimeout(timer);
          resolve(event);
        });
      }),
  };
}

async function serve(bus: RuntimeEventBus) {
  const handle = await startEventServer({ port: 0, bus, pingIntervalMs: 0 });
  cleanups.push(() => handle.close());
  return { handle, url: `ws://127.0.0.1:${handle.port()}/events` };
}

describe("Ereignisbus · der Bus selbst", () => {
  it("reicht jedes Ereignis an jeden Zuhörer weiter und meldet sie wieder ab", () => {
    const bus = new RuntimeEventBus();
    const ersterEmpfang: BusEvent[] = [];
    const zweiterEmpfang: BusEvent[] = [];

    const abmelden = bus.subscribe((event) => ersterEmpfang.push(event));
    bus.subscribe((event) => zweiterEmpfang.push(event));

    bus.publishRecord(record());
    expect(ersterEmpfang).toHaveLength(1);
    expect(zweiterEmpfang).toHaveLength(1);

    abmelden();
    bus.publishRecord(record({ eventId: "event_2", seq: 2 }));
    expect(ersterEmpfang).toHaveLength(1);
    expect(zweiterEmpfang).toHaveLength(2);
    expect(bus.listenerCount).toBe(1);
  });

  it("packt einen Protokolleintrag in die Form {type, timestamp, data}", () => {
    const bus = new RuntimeEventBus();
    const gesehen: BusEvent[] = [];
    bus.subscribe((event) => gesehen.push(event));

    bus.publishRecord(
      record({ type: "tool.requested", seq: 7, payload: { tool_name: "fs.read" } }),
    );

    expect(gesehen[0]).toEqual({
      type: "tool.requested",
      timestamp: "2026-09-12T10:00:00.000Z",
      data: {
        event_id: "event_1",
        session_id: "session_1",
        seq: 7,
        payload: { tool_name: "fs.read" },
      },
    });
  });

  it("hält nur die jüngsten Ereignisse zurück — er ist eine Ansage, kein Protokoll", () => {
    const bus = new RuntimeEventBus(3);
    for (let seq = 1; seq <= 10; seq += 1) {
      bus.publishRecord(record({ eventId: `event_${seq}`, seq }));
    }
    expect(bus.recent().map((event) => event.data.seq)).toEqual([8, 9, 10]);
    expect(bus.recent(2).map((event) => event.data.seq)).toEqual([9, 10]);
  });
});

describe("Ereignisbus · WebSocket-Endpunkt", () => {
  it("meldet sich beim Verbinden und sendet danach jedes neue Ereignis", async () => {
    const bus = new RuntimeEventBus();
    const { url } = await serve(bus);
    const client = await connect(url);

    const hallo = await client.next();
    expect(hallo.type).toBe("bus.connected");
    expect(hallo.data).toMatchObject({ replay: 0, path: "/events" });

    bus.publishRecord(record({ type: "model.responded" }));
    const live = await client.next();
    expect(live.type).toBe("model.responded");
    expect(live.data.session_id).toBe("session_1");
  });

  it("liefert einem frisch verbundenen Client den jüngsten Verlauf nach", async () => {
    const bus = new RuntimeEventBus();
    bus.publishRecord(record({ eventId: "event_1", seq: 1, type: "session.created" }));
    bus.publishRecord(record({ eventId: "event_2", seq: 2, type: "turn.started" }));

    const { url } = await serve(bus);
    const client = await connect(url);

    expect((await client.next()).type).toBe("bus.connected");
    expect((await client.next()).type).toBe("session.created");
    expect((await client.next()).type).toBe("turn.started");
    expect(client.received[0].data.replay).toBe(2);
  });

  it("sendet an alle verbundenen Clients zugleich", async () => {
    const bus = new RuntimeEventBus();
    const { handle, url } = await serve(bus);

    const ersterClient = await connect(url);
    const zweiterClient = await connect(url);
    await ersterClient.next();
    await zweiterClient.next();
    expect(handle.clientCount()).toBe(2);

    bus.publishRecord(record({ type: "turn.completed" }));
    expect((await ersterClient.next()).type).toBe("turn.completed");
    expect((await zweiterClient.next()).type).toBe("turn.completed");
  });

  it("ist nur lesend: ein Datenframe von außen beendet die Verbindung benannt", async () => {
    const bus = new RuntimeEventBus();
    const { url } = await serve(bus);
    const client = await connect(url);
    await client.next();

    const geschlossen = new Promise<{ code: number; reason: string }>((resolve) => {
      client.socket.once("close", (code, reason) => resolve({ code, reason: String(reason) }));
    });

    client.socket.send(JSON.stringify({ type: "session.cancel" }));
    const ende = await geschlossen;

    expect(ende.code).toBe(1003);
    expect(ende.reason).toMatch(/nur lesend/);
  });

  it("nimmt kein Upgrade auf einem anderen Pfad an", async () => {
    const bus = new RuntimeEventBus();
    const { handle } = await serve(bus);
    const falsch = new WebSocket(`ws://127.0.0.1:${handle.port()}/irgendwas`);

    await expect(
      new Promise((resolve, reject) => {
        falsch.once("open", () => resolve("offen"));
        falsch.once("error", reject);
      }),
    ).rejects.toThrow();
  });

  it("weist eine fremde Herkunft ab — ein WebSocket kennt keine Same-Origin-Regel", async () => {
    expect(originAllowed(undefined)).toBe(true);
    expect(originAllowed("http://localhost:3001")).toBe(true);
    expect(originAllowed("http://127.0.0.1:3001")).toBe(true);
    expect(originAllowed("https://beispiel.test")).toBe(false);
    expect(originAllowed("https://beispiel.test", ["https://beispiel.test"])).toBe(true);

    const bus = new RuntimeEventBus();
    const { handle, url } = await serve(bus);

    const erlaubt = await connect(url, { origin: "http://localhost:3001" });
    expect((await erlaubt.next()).type).toBe("bus.connected");

    const fremd = new WebSocket(url, { origin: "https://beispiel.test" });
    await expect(
      new Promise((resolve, reject) => {
        fremd.once("open", () => resolve("offen"));
        fremd.once("error", reject);
      }),
    ).rejects.toThrow(/403/);
    expect(handle.clientCount()).toBe(1);
  });

  it("hängt sich auch an einen bestehenden Server, ohne dessen Routen zu stören", async () => {
    const bus = new RuntimeEventBus();
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("gateway");
    });
    const handle = attachEventSocket(server, bus, { pingIntervalMs: 0 });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    cleanups.push(async () => {
      await handle.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const antwort = await fetch(`http://127.0.0.1:${port}/beliebig`);
    expect(await antwort.text()).toBe("gateway");

    const client = await connect(`ws://127.0.0.1:${port}/events`);
    expect((await client.next()).type).toBe("bus.connected");

    bus.publishRecord(record({ type: "gateway.delivered" }));
    expect((await client.next()).type).toBe("gateway.delivered");
  });

  it("räumt beim Schließen auf: kein Client, kein Zuhörer bleibt hängen", async () => {
    const bus = new RuntimeEventBus();
    const { handle, url } = await serve(bus);
    const client = await connect(url);
    await client.next();
    expect(handle.clientCount()).toBe(1);
    expect(bus.listenerCount).toBe(1);

    await handle.close();
    expect(handle.clientCount()).toBe(0);
    expect(bus.listenerCount).toBe(0);
  });
});
