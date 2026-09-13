import type { Pool, PoolClient } from "pg";
import { type RuntimeEventBus, eventBus } from "./bus.js";
import { EVENT_NOTIFY_CHANNEL, readEventById } from "./log.js";

/**
 * Die lauschende Seite des Ereignisbusses (S21-Nachtrag).
 *
 * `log.ts` sagt jede Einfügung per `SELECT pg_notify(...)` an, in derselben Transaktion wie die
 * Einfügung selbst. `pg_notify` ist transaktional: Postgres stellt die Benachrichtigung erst
 * zu, wenn diese Transaktion committet, und verwirft sie stillschweigend bei einem ROLLBACK.
 * Das ist die Zusage, die eine direkte Ansage aus `appendEventInTx` nicht geben konnte (siehe
 * `log.ts` und `bus.ts`).
 *
 * **Eine eigene Verbindung, dauerhaft im LISTEN-Zustand.** `LISTEN` gilt für die Verbindung, auf
 * der es ausgeführt wurde — ein `Pool`, der Verbindungen zwischen Aufrufen wechselt, kann das
 * nicht halten. Diese Funktion holt sich deshalb genau eine Verbindung aus dem übergebenen
 * `Pool` (`pool.connect()`) und gibt sie **nie** an ihn zurück, solange sie lauscht; beim
 * Schließen oder nach einem Verbindungsabbruch wird sie mit `release(true)` verworfen statt
 * zurückgelegt — die Alternative wäre, dass der Pool sie später an einen fremden Aufruf
 * ausgibt, der von der LISTEN-Registrierung nichts weiß.
 *
 * **Die Benachrichtigung trägt nur die `event_id`, nicht die Nutzdaten.** Erstens hat ein
 * NOTIFY-Payload eine Obergrenze von rund 8000 Byte, die ein Werkzeugergebnis leicht sprengt.
 * Zweitens bliebe eine im Payload mitgeschickte Fassung eine zweite Kopie neben der Zeile in
 * `kuronami.events` — dieser Bus soll genau eine Wahrheit haben. Der volle, bereits gefilterte
 * Datensatz kommt deshalb über `readEventById` aus derselben Tabelle zurück.
 *
 * **Der Kanal ist global**, nicht je Prozess: `LISTEN kuronami_events` sieht jede committete
 * Einfügung im System, unabhängig davon, welcher Prozess sie geschrieben hat. Für S22 (Runs
 * über alle Kanäle, auch Hintergrundläufe) ist das die richtige Reichweite — eine Oberfläche,
 * die nur die Schreibvorgänge des eigenen Prozesses sähe, zeigte einen nach Zeitplan gelaufenen
 * Agenten gar nicht an.
 */

export interface EventNotifyListenerOptions {
  /** Ziel der Ansagen. Vorgabe: der Bus dieses Prozesses. */
  bus?: RuntimeEventBus;
  /** Vorgabe: `EVENT_NOTIFY_CHANNEL`. Im Test frei zu setzen, um Läufe zu isolieren. */
  channel?: string;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (id: ReturnType<typeof setTimeout>) => void;
  /** Ruft bei jedem Fehler, der die Verbindung nicht sofort beendet (z. B. ein Nachschlagen,
   * das fehlschlägt). Vorgabe: `console.error`. Wirft nie selbst. */
  onError?: (error: unknown) => void;
}

export interface EventNotifyListenerHandle {
  /** Beendet die lauschende Verbindung endgültig — keine Wiederverbindung danach. */
  close(): Promise<void>;
  /** Ob gerade eine Verbindung im LISTEN-Zustand steht. Für Tests, die einen Abriss nachweisen. */
  readonly connected: boolean;
  /** Die Backend-PID der aktuell lauschenden Verbindung, oder `null` zwischen zwei Versuchen.
   * Ausschließlich dafür da, dass ein Test einen Abriss gezielt auslösen kann
   * (`pg_terminate_backend`) statt danach zu raten. */
  readonly pid: number | null;
}

export const DEFAULT_NOTIFY_BASE_BACKOFF_MS = 250;
export const DEFAULT_NOTIFY_MAX_BACKOFF_MS = 10_000;

/**
 * Exponentieller Backoff mit Deckel, ohne Jitter — dieselbe Formel wie beim Ereignis-Client der
 * Oberfläche (`ui/events/bus.ts`, `backoffDelay`), hier aber eigenständig: `runtime/` darf nicht
 * von `ui/` abhängen (Abschnitt 3), und die drei Zeilen sind billiger als eine geteilte Datei,
 * die diese Grenze überqueren müsste.
 */
export function notifyBackoffDelay(
  attempt: number,
  base = DEFAULT_NOTIFY_BASE_BACKOFF_MS,
  max = DEFAULT_NOTIFY_MAX_BACKOFF_MS,
): number {
  if (attempt <= 1) return Math.min(base, max);
  return Math.min(base * 2 ** (attempt - 1), max);
}

const CHANNEL_PATTERN = /^[a-z_][a-z0-9_]*$/;

/**
 * Startet die lauschende Verbindung und meldet sich nach einem Abriss (Netzwerk, Neustart des
 * Servers, `pg_terminate_backend`) von selbst wieder an — dieselbe Erwartung wie an den
 * WebSocket-Client der Oberfläche, nur auf der Postgres-Seite.
 */
export async function startEventNotifyListener(
  pool: Pool,
  options: EventNotifyListenerOptions = {},
): Promise<EventNotifyListenerHandle> {
  const bus = options.bus ?? eventBus;
  const channel = options.channel ?? EVENT_NOTIFY_CHANNEL;
  if (!CHANNEL_PATTERN.test(channel)) {
    throw new Error(`Ungültiger NOTIFY-Kanal "${channel}": erwartet wird ein SQL-Bezeichner.`);
  }
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ?? ((id: ReturnType<typeof setTimeout>) => clearTimeout(id));
  const baseBackoffMs = options.baseBackoffMs ?? DEFAULT_NOTIFY_BASE_BACKOFF_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_NOTIFY_MAX_BACKOFF_MS;
  const onError = options.onError ?? ((error: unknown) => console.error("[events/notify]", error));

  let closed = false;
  let current: PoolClient | null = null;
  let currentPid: number | null = null;
  let attempts = 0;
  let reconnectTimer: ReturnType<typeof setTimer> | null = null;

  function scheduleReconnect(): void {
    if (closed || reconnectTimer !== null) return;
    attempts += 1;
    const delay = notifyBackoffDelay(attempts, baseBackoffMs, maxBackoffMs);
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      connect().catch(onError);
    }, delay);
  }

  function drop(client: PoolClient): void {
    if (current === client) {
      current = null;
      currentPid = null;
    }
    client.removeAllListeners();
    // `release(true)` verwirft die Verbindung, statt sie an den Pool zurückzugeben: sie trug
    // eine LISTEN-Registrierung, von der ein fremder Aufruf, der sie als Nächstes bekäme,
    // nichts weiß.
    client.release(true);
    scheduleReconnect();
  }

  async function connect(): Promise<void> {
    if (closed) return;
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch (error) {
      onError(error);
      scheduleReconnect();
      return;
    }
    if (closed) {
      client.release(true);
      return;
    }
    current = client;

    client.on("notification", (message) => {
      if (message.channel !== channel || !message.payload) return;
      readEventById(pool, message.payload)
        .then((record) => {
          if (record) bus.publishRecord(record);
        })
        .catch(onError);
    });
    client.on("error", () => drop(client));
    client.on("end", () => drop(client));

    try {
      await client.query(`LISTEN ${channel}`);
      attempts = 0;
      const backend = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      currentPid = backend.rows[0]?.pid ?? null;
    } catch (error) {
      onError(error);
      drop(client);
    }
  }

  await connect();

  return {
    async close(): Promise<void> {
      closed = true;
      if (reconnectTimer !== null) {
        clearTimer(reconnectTimer);
        reconnectTimer = null;
      }
      const client = current;
      current = null;
      currentPid = null;
      if (client) {
        client.removeAllListeners();
        await client.query(`UNLISTEN ${channel}`).catch(() => {});
        client.release(true);
      }
    },
    get pid(): number | null {
      return currentPid;
    },
    get connected(): boolean {
      return current !== null;
    },
  };
}
