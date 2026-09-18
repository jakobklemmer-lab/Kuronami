import { EventEmitter } from "node:events";
import { type Server, createServer as createHttpServer } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";
import type { EventRecord } from "./log.js";

/**
 * Der Ereignisbus (S21, Phase 6).
 *
 * **Er ist eine Ansage, nicht das Protokoll.** Die Wahrheit über einen Lauf steht weiterhin in
 * `kuronami.events` und wird von dort gefaltet (S05, S12) — dieser Bus sagt nur "eben wurde
 * etwas geschrieben", damit eine Oberfläche nicht pollen muss. Er hält keinen Zustand, den
 * jemand wiederfinden müsste: was vor dem Verbinden geschah, liegt in der Datenbank, nicht hier.
 * Ein Neustart des Prozesses leert ihn, und das ist richtig so.
 *
 * **Gefüttert wird er über `pg_notify`, nicht mehr über einen direkten Aufruf** (S21-Nachtrag,
 * `notify.ts`). `log.ts` sagt bei jeder Einfügung per `pg_notify` an; `startEventNotifyListener`
 * hält eine eigene lauschende Verbindung, liest den vollen Datensatz über `readEventById` zurück
 * und ruft erst dann `publishRecord` auf dieser Klasse. `pg_notify` ist transaktional — die
 * Zustellung wartet auf den COMMIT der schreibenden Transaktion und entfällt bei einem
 * ROLLBACK —, und genau das war die Lücke der ersten Fassung: ein direkter Aufruf aus
 * `appendEventInTx` sagte ein Ereignis an, bevor feststand, ob die Transaktion durchkommt. Der
 * Kanal ist global (`EVENT_NOTIFY_CHANNEL` in `log.ts`), nicht je Prozess: jeder Prozess mit
 * einem eigenen Bus (Runtime, Gateway) hört auf denselben Kanal und sieht damit **jedes**
 * committete Ereignis im System, nicht mehr nur, was er selbst geschrieben hat — eine
 * Verschiebung gegenüber der ersten Fassung dieses Kommentars, siehe `progress.md`. Sicher
 * bleibt das, weil die Redaction (`log.ts`) an der Zeile selbst hängt, nicht am Absender.
 *
 * **Er hängt weiterhin am einzigen Schreibtor** (`appendEventInTx` in `log.ts`) — aus demselben
 * Grund, aus dem der Redaction-Filter dort steht: es gibt keinen zweiten Weg in
 * `kuronami.events`, also kann kein Ereignis an ihm vorbei entstehen. Der angesagte Datensatz
 * ist der bereits gefilterte — der Bus liegt per Bauart hinter dem Filter und kann kein
 * Geheimnis hinaustragen, das das Protokoll nicht ohnehin trägt.
 *
 * **Nur lesend.** Es gibt keinen Weg von einem verbundenen Client zurück in die Runtime: ein
 * Datenframe von außen beendet die Verbindung (1003), statt stillschweigend verworfen zu werden.
 * Die Oberfläche schreibt über das Gateway (S16), nicht über diesen Port.
 */

/** Die Form, in der ein Ereignis den Prozess verlässt. Bewusst flach und JSON-nah. */
export interface BusEvent {
  type: string;
  /** ISO-8601, UTC. Beim Protokollereignis die `created_at` der Zeile, sonst die Ansagezeit. */
  timestamp: string;
  data: Record<string, unknown>;
}

/** Wie viele Ereignisse der Bus für einen frisch verbundenen Client zurückhält. */
export const DEFAULT_REPLAY_SIZE = 50;

/** Wie viele davon beim Verbinden tatsächlich nachgeliefert werden. */
export const DEFAULT_REPLAY_ON_CONNECT = 25;

const CHANNEL = "event";

/**
 * Prozesslokaler Ereignisbus. Ein `EventEmitter` mit getippter Hülle plus ein kurzer Ringpuffer,
 * damit ein Client, der sich mitten in einem Lauf verbindet, nicht vor einem leeren Fenster
 * sitzt, bis das nächste Ereignis fällt.
 */
export class RuntimeEventBus {
  private readonly emitter = new EventEmitter();
  private readonly buffer: BusEvent[] = [];

  constructor(private readonly replaySize: number = DEFAULT_REPLAY_SIZE) {
    // Ein Zuhörer je verbundenem Client. Die Vorgabe von zehn wäre hier eine Warnung über
    // normalen Betrieb, kein Leck.
    this.emitter.setMaxListeners(0);
  }

  publish(event: BusEvent): void {
    this.buffer.push(event);
    if (this.buffer.length > this.replaySize)
      this.buffer.splice(0, this.buffer.length - this.replaySize);
    this.emitter.emit(CHANNEL, event);
  }

  /** Sagt einen geschriebenen Protokolleintrag an. `record` ist die gefilterte Fassung. */
  publishRecord(record: EventRecord): void {
    this.publish({
      type: record.type,
      timestamp: record.createdAt.toISOString(),
      data: {
        event_id: record.eventId,
        session_id: record.sessionId,
        seq: record.seq,
        payload: record.payload,
      },
    });
  }

  /** Meldet einen Zuhörer an und gibt seine Abmeldung zurück. */
  subscribe(listener: (event: BusEvent) => void): () => void {
    this.emitter.on(CHANNEL, listener);
    return () => {
      this.emitter.off(CHANNEL, listener);
    };
  }

  /** Die jüngsten Ereignisse, älteste zuerst. */
  recent(limit = this.replaySize): BusEvent[] {
    return limit >= this.buffer.length ? [...this.buffer] : this.buffer.slice(-limit);
  }

  get listenerCount(): number {
    return this.emitter.listenerCount(CHANNEL);
  }
}

/**
 * Der Bus dieses Prozesses.
 *
 * Ein Modul-Singleton, und das ist eine bewusste Ausnahme von der sonstigen Übergabe per
 * Parameter: `appendEventInTx` ist an über hundert Stellen aufgerufen, und ein zusätzlicher
 * Parameter durch dreißig Dateien wäre eine Änderung an jedem Aufrufer für eine Ansage, die
 * niemanden von ihnen etwas angeht. Der Bus ist prozesslokal wie das Kontingent paralleler
 * Arbeiter (S20) und die Serialisierung im Gateway (S16).
 */
export const eventBus = new RuntimeEventBus();

/** Ein verbundener Client. */
interface Subscriber {
  socket: WebSocket;
  alive: boolean;
}

export interface EventSocketOptions {
  /** Pfad, auf dem der Upgrade angenommen wird. */
  path?: string;
  /** Wie viele zurückliegende Ereignisse ein frischer Client bekommt. */
  replayOnConnect?: number;
  /** Abstand der Lebendprüfung in Millisekunden. 0 schaltet sie ab. */
  pingIntervalMs?: number;
  /**
   * Erlaubte `Origin`-Header. Vorgabe: nur localhost. Ein WebSocket unterliegt **nicht** der
   * Same-Origin-Regel des Browsers — ohne diese Prüfung könnte jede beliebige Seite, die der
   * Nutzer offen hat, das gesamte Protokoll dieses Prozesses mitlesen.
   */
  allowedOrigins?: readonly string[];
}

export interface EventSocketHandle {
  /** Zahl der gerade verbundenen Clients. */
  clientCount(): number;
  /** Beendet alle Verbindungen und meldet den Bus ab. */
  close(): Promise<void>;
}

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * Herkünfte jenseits von localhost, die trotzdem vertraut sind — etwa die Oberfläche auf einem
 * Server, den man über die öffentliche IP statt über einen Tunnel erreicht. Kommagetrennt in
 * `EVENTS_ALLOWED_ORIGINS`, gelesen wie `EVENTS_PORT` direkt aus der Umgebung. Leer = niemand
 * zusätzlich, unverändert die alte Vorgabe (nur localhost).
 */
function extraAllowedOrigins(): readonly string[] {
  return (process.env.EVENTS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Ein Aufruf ohne `Origin` kommt nicht aus einem Browser (curl, Test, Tauri) und ist erlaubt. */
export function originAllowed(origin: string | undefined, allowed?: readonly string[]): boolean {
  if (origin === undefined || origin === "") return true;
  if (allowed !== undefined) return allowed.includes(origin);
  return LOCAL_ORIGIN.test(origin) || extraAllowedOrigins().includes(origin);
}

/**
 * Hängt den Ereignisstrom an einen bestehenden HTTP-Server.
 *
 * Warum am Server und nicht als Express-Route: ein Upgrade ist kein Request, den ein
 * Express-Handler je zu sehen bekommt — `http.Server` reicht ihn über das `upgrade`-Ereignis
 * heraus, bevor die Route-Schicht überhaupt anläuft. Der Pfad wird hier geprüft, damit ein
 * Upgrade auf irgendeinen anderen Pfad nicht stillschweigend angenommen wird.
 */
export function attachEventSocket(
  server: Server,
  bus: RuntimeEventBus = eventBus,
  options: EventSocketOptions = {},
): EventSocketHandle {
  const path = options.path ?? "/events";
  const replayOnConnect = options.replayOnConnect ?? DEFAULT_REPLAY_ON_CONNECT;
  const pingIntervalMs = options.pingIntervalMs ?? 30_000;

  const wss = new WebSocketServer({ noServer: true });
  const subscribers = new Set<Subscriber>();

  function send(socket: WebSocket, event: BusEvent): void {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify(event));
  }

  const unsubscribe = bus.subscribe((event) => {
    for (const subscriber of subscribers) send(subscriber.socket, event);
  });

  wss.on("connection", (socket: WebSocket) => {
    const subscriber: Subscriber = { socket, alive: true };
    subscribers.add(subscriber);

    socket.on("pong", () => {
      subscriber.alive = true;
    });

    // Der einzige Schreibversuch, den es geben kann, ist einer von außen — und der wird
    // benannt abgewiesen statt verworfen (AGENTS.md: Fehler nie verstecken).
    socket.on("message", () => {
      socket.close(1003, "Der Ereignisstrom ist nur lesend.");
    });

    socket.on("close", () => {
      subscribers.delete(subscriber);
    });
    socket.on("error", () => {
      subscribers.delete(subscriber);
    });

    const replay = replayOnConnect > 0 ? bus.recent(replayOnConnect) : [];
    send(socket, {
      type: "bus.connected",
      timestamp: new Date().toISOString(),
      data: { replay: replay.length, path },
    });
    for (const event of replay) send(socket, event);
  });

  const onUpgrade = (
    request: import("node:http").IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer,
  ): void => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== path) {
      socket.destroy();
      return;
    }
    if (!originAllowed(request.headers.origin, options.allowedOrigins)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  };
  server.on("upgrade", onUpgrade);

  const ping =
    pingIntervalMs > 0
      ? setInterval(() => {
          for (const subscriber of subscribers) {
            if (!subscriber.alive) {
              subscriber.socket.terminate();
              subscribers.delete(subscriber);
              continue;
            }
            subscriber.alive = false;
            subscriber.socket.ping();
          }
        }, pingIntervalMs)
      : undefined;
  ping?.unref();

  return {
    clientCount: () => subscribers.size,
    close: async () => {
      if (ping) clearInterval(ping);
      unsubscribe();
      server.off("upgrade", onUpgrade);
      for (const subscriber of subscribers) subscriber.socket.close(1001, "Server fährt herunter.");
      subscribers.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

export interface EventServerOptions extends EventSocketOptions {
  port?: number;
  bus?: RuntimeEventBus;
}

export interface EventServerHandle extends EventSocketHandle {
  server: Server;
  /** Der tatsächlich belegte Port — bei `port: 0` der vom System vergebene. */
  port(): number;
}

/** Der Vorgabeport des Ereignisstroms. Die Oberfläche (S21) erwartet ihn dort. */
export const DEFAULT_EVENTS_PORT = 3000;

/**
 * Startet einen eigenen HTTP-Server, der nur zweierlei kann: `/events` als WebSocket und
 * `/health` als Statuszeile. Kein Schreibpfad, keine Session, keine Authentifizierung — wer
 * etwas anstoßen will, geht über das Gateway (S16).
 */
export async function startEventServer(
  options: EventServerOptions = {},
): Promise<EventServerHandle> {
  const bus = options.bus ?? eventBus;
  const port = options.port ?? Number(process.env.EVENTS_PORT ?? DEFAULT_EVENTS_PORT);
  const path = options.path ?? "/events";

  const server = createHttpServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: true, events: path, clients: handle.clientCount() }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    response.end(
      JSON.stringify({
        error: `Unbekannter Pfad ${url.pathname}. Es gibt ${path} (WebSocket) und /health.`,
      }),
    );
  });

  const handle = attachEventSocket(server, bus, { ...options, path });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    server,
    port: () => {
      const address = server.address();
      return typeof address === "object" && address !== null ? address.port : port;
    },
    clientCount: handle.clientCount,
    close: async () => {
      await handle.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
