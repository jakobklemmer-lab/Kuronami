import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_BACKOFF_MS,
  type SocketLike,
  type UiSignal,
  backoffDelay,
  createEventBus,
  parseMessage,
  signalFor,
} from "./bus.js";

/**
 * Der Ereignis-Client ohne Netz. Der Draht wird hereingereicht (`socketFactory`), ebenso die
 * Zeit (`setTimer`/`clearTimer`) — beides sind die Stellen, an denen dieser Client sonst an
 * der Umgebung hinge, und beide sind deshalb Parameter und keine Importe.
 */

/** Ein WebSocket-Ersatz, der von Hand geöffnet, gefüttert und geschlossen wird. */
class FakeSocket implements SocketLike {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readyState = FakeSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closedWith: number | null = null;

  constructor(readonly url: string) {}

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  deliver(payload: unknown): void {
    this.onmessage?.({ data: typeof payload === "string" ? payload : JSON.stringify(payload) });
  }

  /** Ein Abriss von außen — der Fall, auf den die Wiederverbindung antwortet. */
  drop(code = 1006): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code });
  }

  close(code?: number): void {
    this.closedWith = code ?? 1000;
    this.readyState = FakeSocket.CLOSED;
  }
}

/** Eine Uhr, die nur läuft, wenn der Test sie laufen lässt. */
function fakeClock() {
  const timers = new Map<number, { fn: () => void; at: number }>();
  let nextId = 1;
  let now = 0;
  return {
    setTimer: (fn: () => void, ms: number): number => {
      const id = nextId;
      nextId += 1;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimer: (id: number): void => {
      timers.delete(id);
    },
    /** Rückt die Zeit vor und feuert, was fällig geworden ist. */
    advance(ms: number): void {
      now += ms;
      for (const [id, timer] of [...timers.entries()]) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.fn();
      }
    },
    /** Wie lange der einzige offene Zeitgeber noch läuft. */
    pending(): number[] {
      return [...timers.values()].map((timer) => timer.at - now);
    },
  };
}

function harness(options: { idleAfterMs?: number } = {}) {
  const clock = fakeClock();
  const sockets: FakeSocket[] = [];
  const bus = createEventBus({
    url: "ws://localhost:3000/events",
    socketFactory: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    idleAfterMs: options.idleAfterMs ?? 0,
  });
  return { bus, clock, sockets, last: () => sockets[sockets.length - 1] };
}

describe("Ereignis-Client · Zuordnung", () => {
  it("übersetzt Protokollereignisse in die sechs Signale der Oberfläche", () => {
    const cases: Array<[string, UiSignal | null]> = [
      ["turn.started", "processing"],
      ["tool.requested", "processing"],
      ["model.requested", "processing"],
      ["agent.delegated", "processing"],
      ["model.responded", "speaking"],
      ["approval.requested", "speaking"],
      ["gateway.delivered", "speaking"],
      ["turn.completed", "complete"],
      ["session.completed", "complete"],
      ["agent.returned", "complete"],
      ["bus.connected", "idle"],
      ["runtime.started", "idle"],
      ["task.created", "task_added"],
      // Buchführung ohne Bühne: die Anzeige ändert sich nicht.
      ["policy.allowed", null],
      ["artifact.created", null],
      ["context.compacted", null],
      ["memory.recalled", null],
    ];

    for (const [type, expected] of cases) {
      expect(signalFor({ type, timestamp: "2026-09-12T10:00:00.000Z" })).toBe(expected);
    }
  });

  it("unterscheidet bei task.updated die Erledigung vom bloßen Umschreiben", () => {
    const base = { type: "task.updated", timestamp: "2026-09-12T10:00:00.000Z" };
    expect(signalFor({ ...base, data: { status: "done" } })).toBe("task_done");
    expect(signalFor({ ...base, data: { status: "in_progress" } })).toBeNull();
    expect(signalFor({ ...base, data: { dropped: true } })).toBeNull();
  });

  it("liest kaputte Rahmen als null, statt an ihnen zu scheitern", () => {
    expect(parseMessage('{"type":"turn.started","timestamp":"x","data":{"a":1}}')).toEqual({
      type: "turn.started",
      timestamp: "x",
      data: { a: 1 },
    });
    expect(parseMessage("kein json")).toBeNull();
    expect(parseMessage('{"ohne":"typ"}')).toBeNull();
    expect(parseMessage('"nur ein string"')).toBeNull();
    expect(parseMessage(42)).toBeNull();
  });
});

describe("Ereignis-Client · Strom", () => {
  it("verbindet sich, meldet den Stand und schaltet den Zustand um", () => {
    const { bus, sockets, last } = harness();
    const states: string[] = [];
    const stati: string[] = [];
    bus.onState((state) => states.push(state));
    bus.onStatus((status) => stati.push(status));

    bus.connect();
    expect(sockets).toHaveLength(1);
    expect(last().url).toBe("ws://localhost:3000/events");
    expect(bus.status).toBe("connecting");

    last().open();
    expect(bus.status).toBe("open");

    last().deliver({ type: "turn.started", timestamp: "2026-09-12T10:00:00.000Z", data: {} });
    expect(bus.state).toBe("processing");

    last().deliver({ type: "model.responded", timestamp: "2026-09-12T10:00:01.000Z", data: {} });
    expect(bus.state).toBe("speaking");

    last().deliver({ type: "turn.completed", timestamp: "2026-09-12T10:00:02.000Z", data: {} });
    expect(bus.state).toBe("complete");

    expect(states).toEqual(["processing", "speaking", "complete"]);
    expect(stati).toEqual(["connecting", "open"]);
  });

  it("meldet jeden Rahmen weiter, auch den ohne Signal", () => {
    const { bus, last } = harness();
    const alle: string[] = [];
    const arbeitend: string[] = [];
    bus.onMessage((message) => alle.push(message.type));
    bus.on("processing", (message) => arbeitend.push(message.type));

    bus.connect();
    last().open();
    last().deliver({ type: "policy.allowed", timestamp: "t", data: {} });
    last().deliver({ type: "step.started", timestamp: "t", data: {} });
    last().deliver("kein json");

    expect(alle).toEqual(["policy.allowed", "step.started"]);
    expect(arbeitend).toEqual(["step.started"]);
    expect(bus.state).toBe("processing");
  });

  it("zählt Plansignale getrennt", () => {
    const { bus, last } = harness();
    let dazu = 0;
    let fertig = 0;
    bus.on("task_added", () => {
      dazu += 1;
    });
    bus.on("task_done", () => {
      fertig += 1;
    });

    bus.connect();
    last().open();
    last().deliver({ type: "task.created", timestamp: "t", data: { task_id: "a" } });
    last().deliver({ type: "task.created", timestamp: "t", data: { task_id: "b" } });
    last().deliver({
      type: "task.updated",
      timestamp: "t",
      data: { task_id: "a", status: "done" },
    });

    expect(dazu).toBe(2);
    expect(fertig).toBe(1);
    // Plansignale sind keine Wasserzustände — die Kreise bleiben, wo sie waren.
    expect(bus.state).toBe("idle");
  });

  it("kehrt nach dem Auslaufen von selbst zur Ruhe zurück", () => {
    const { bus, clock, last } = harness({ idleAfterMs: 4000 });
    bus.connect();
    last().open();
    last().deliver({ type: "turn.completed", timestamp: "t", data: {} });
    expect(bus.state).toBe("complete");

    clock.advance(3999);
    expect(bus.state).toBe("complete");
    clock.advance(1);
    expect(bus.state).toBe("idle");
  });
});

describe("Ereignis-Client · Wiederverbindung", () => {
  it("wartet exponentiell länger und nie länger als der Deckel", () => {
    expect(backoffDelay(1)).toBe(500);
    expect(backoffDelay(2)).toBe(1000);
    expect(backoffDelay(3)).toBe(2000);
    expect(backoffDelay(4)).toBe(4000);
    expect(backoffDelay(5)).toBe(8000);
    expect(backoffDelay(6)).toBe(DEFAULT_MAX_BACKOFF_MS);
    expect(backoffDelay(20)).toBe(DEFAULT_MAX_BACKOFF_MS);
    expect(backoffDelay(1, 500, 250)).toBe(250);
  });

  it("verbindet sich nach einem Abriss neu, mit wachsender Wartezeit", () => {
    const { bus, clock, sockets, last } = harness();
    bus.connect();
    last().open();
    expect(sockets).toHaveLength(1);

    // Erster Abriss: nach 500 ms der zweite Versuch.
    last().drop();
    expect(bus.status).toBe("closed");
    expect(clock.pending()).toEqual([500]);
    clock.advance(499);
    expect(sockets).toHaveLength(1);
    clock.advance(1);
    expect(sockets).toHaveLength(2);
    expect(bus.status).toBe("connecting");

    // Der zweite Versuch scheitert, ohne je offen gewesen zu sein: 1000 ms.
    last().drop();
    expect(clock.pending()).toEqual([1000]);
    clock.advance(1000);
    expect(sockets).toHaveLength(3);
    expect(bus.attempts).toBe(2);

    // Der dritte gelingt — der Zähler fällt auf null zurück.
    last().open();
    expect(bus.attempts).toBe(0);

    // Und der nächste Abriss beginnt wieder bei 500 ms, nicht bei 2000.
    last().drop();
    expect(clock.pending()).toEqual([500]);
  });

  it("deckelt die Wartezeit bei zehn Sekunden", () => {
    const { bus, clock, last } = harness();
    bus.connect();
    last().open();

    const gewartet: number[] = [];
    for (let versuch = 0; versuch < 8; versuch += 1) {
      last().drop();
      gewartet.push(clock.pending()[0]);
      clock.advance(clock.pending()[0]);
    }

    expect(gewartet).toEqual([500, 1000, 2000, 4000, 8000, 10_000, 10_000, 10_000]);
    expect(Math.max(...gewartet)).toBe(DEFAULT_MAX_BACKOFF_MS);
  });

  it("schließt endgültig: kein Zeitgeber bleibt offen, kein Draht kommt nach", () => {
    const { bus, clock, sockets, last } = harness();
    bus.connect();
    const erster = last();
    erster.open();

    bus.close();
    expect(erster.closedWith).toBe(1000);
    expect(bus.status).toBe("closed");
    expect(clock.pending()).toEqual([]);

    clock.advance(60_000);
    expect(sockets).toHaveLength(1);
  });

  it("baut nach einem selbst veranlassten Schließen keine Verbindung mehr auf", () => {
    const { bus, clock, sockets, last } = harness();
    bus.connect();
    last().open();
    bus.close();

    // Ein nachgereichtes onclose des Browsers darf die Wiederverbindung nicht wiederbeleben.
    last().drop();
    clock.advance(60_000);
    expect(sockets).toHaveLength(1);
  });
});
