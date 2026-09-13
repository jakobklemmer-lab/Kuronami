import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { redactValue } from "../redaction/redact.js";
import { type EventType, assertEventType } from "./types.js";

/**
 * Der Kanal, auf dem jede Einfügung in `kuronami.events` per `pg_notify` ansagt (S21-Nachtrag,
 * `notify.ts`). `pg_notify` ist transaktional: die Zustellung wartet auf den COMMIT der
 * sendenden Transaktion und entfällt bei einem ROLLBACK. Genau das konnte die direkte Ansage,
 * die S21 zuerst gebaut hat, nicht leisten (siehe `notify.ts` für die lauschende Seite).
 */
export const EVENT_NOTIFY_CHANNEL = "kuronami_events";

export type EventPayload = Record<string, unknown>;

export interface EventRecord {
  eventId: string;
  sessionId: string;
  seq: number;
  type: string;
  payload: EventPayload;
  createdAt: Date;
}

interface EventRow {
  event_id: string;
  session_id: string;
  seq: number;
  type: string;
  payload: EventPayload;
  created_at: Date;
}

/**
 * Serialisiert alle Schreiber derselben Session. Die Sperre liegt auf der Session-Zeile,
 * nicht auf den Ereignissen: über einen Zeilenbereich, in den erst noch eingefügt wird,
 * lässt sich keine Sperre halten, und zwei Schreiber läsen sonst dasselbe MAX(seq).
 */
const LOCK_SESSION_SQL = `
  SELECT session_id
  FROM kuronami.sessions
  WHERE session_id = $1
  FOR UPDATE
`;

/**
 * Vergabe und Einfügung in einer einzigen Anweisung: zwischen dem Lesen von MAX(seq) und
 * dem Schreiben liegt damit kein Moment, in dem ein zweiter Schreiber dazwischenkäme.
 */
const INSERT_EVENT_SQL = `
  INSERT INTO kuronami.events (event_id, session_id, seq, type, payload)
  SELECT $1, $2, coalesce(max(seq), 0) + 1, $3, $4::jsonb
  FROM kuronami.events
  WHERE session_id = $2
  RETURNING event_id, session_id, seq, type, payload, created_at
`;

const SELECT_EVENTS_SQL = `
  SELECT event_id, session_id, seq, type, payload, created_at
  FROM kuronami.events
  WHERE session_id = $1
  ORDER BY seq
`;

function toRecord(row: EventRow): EventRecord {
  return {
    eventId: row.event_id,
    sessionId: row.session_id,
    seq: row.seq,
    type: row.type,
    payload: row.payload,
    createdAt: row.created_at,
  };
}

/**
 * Hängt ein Ereignis innerhalb einer bereits laufenden Transaktion an. Das ist die Form,
 * die ein Checkpoint braucht: Ereignis und Snapshot müssen in dieselbe Transaktion
 * (Architektur, Abschnitt 6). Der Aufrufer verantwortet BEGIN, COMMIT und ROLLBACK.
 */
export async function appendEventInTx(
  client: PoolClient,
  sessionId: string,
  type: EventType,
  payload: EventPayload = {},
): Promise<EventRecord> {
  assertEventType(type);

  const session = await client.query(LOCK_SESSION_SQL, [sessionId]);
  if (session.rowCount === 0) {
    throw new Error(
      `Session ${sessionId} existiert nicht, Ereignis ${type} wurde nicht geschrieben`,
    );
  }

  const inserted = await client.query<EventRow>(INSERT_EVENT_SQL, [
    `event_${randomUUID()}`,
    sessionId,
    type,
    // Der Redaction-Filter aus Abschnitt 4.7. Er steht hier und nicht bei den Aufrufern,
    // weil dies das einzige Schreibtor des Protokolls ist: `appendEvent` läuft durch diese
    // Funktion, und einen zweiten Weg in `kuronami.events` gibt es nicht. Ein Filter, den
    // jede Aufrufstelle selbst anwenden müsste, wäre in der ersten vergessenen Zeile umgangen.
    // Der zurückgegebene Record trägt die gefilterte Fassung, weil er aus dem RETURNING der
    // Einfügung stammt — auch der Aufrufer sieht das Geheimnis danach nicht mehr.
    JSON.stringify(redactValue(payload)),
  ]);

  const record = toRecord(inserted.rows[0]);

  // Die Ansage an den Ereignisbus (S21) läuft seit dem Nachtrag über `pg_notify`, nicht mehr
  // über einen direkten Aufruf von hier aus. Grund: diese Funktion läuft in einer fremden
  // Transaktion (der Aufrufer verantwortet COMMIT/ROLLBACK), und ein direkter Aufruf sagte ein
  // Ereignis an, bevor feststand, ob die Transaktion überhaupt durchkommt — eine
  // zurückgerollte Transaktion hätte trotzdem etwas angesagt, das nie dauerhaft wurde.
  // `pg_notify` ist transaktional: die Zustellung an lauschende Verbindungen (`notify.ts`)
  // wartet auf genau diesen COMMIT und entfällt bei einem ROLLBACK von selbst. Der Kanal trägt
  // nur die `event_id` (NOTIFY-Payloads sind auf ~8000 Byte begrenzt); die lauschende Seite
  // liest den vollen — bereits gefilterten — Datensatz über `readEventById` zurück, also bleibt
  // der Bus per Bauart hinter dem Redaction-Filter dieser Funktion.
  await client.query("SELECT pg_notify($1, $2)", [EVENT_NOTIFY_CHANNEL, record.eventId]);

  return record;
}

/** Hängt ein Ereignis in einer eigenen Transaktion an. */
export async function appendEvent(
  pool: Pool,
  sessionId: string,
  type: EventType,
  payload: EventPayload = {},
): Promise<EventRecord> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const record = await appendEventInTx(client, sessionId, type, payload);
    await client.query("COMMIT");
    return record;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Liest alle Ereignisse einer Session in Vergabereihenfolge, aufsteigend nach seq. */
export async function readEvents(pool: Pool, sessionId: string): Promise<EventRecord[]> {
  const result = await pool.query<EventRow>(SELECT_EVENTS_SQL, [sessionId]);
  return result.rows.map(toRecord);
}

const SELECT_EVENT_BY_ID_SQL = `
  SELECT event_id, session_id, seq, type, payload, created_at
  FROM kuronami.events
  WHERE event_id = $1
`;

/**
 * Liest ein einzelnes Ereignis über seine ID. Die einzige Aufruferin ist `notify.ts`: eine
 * `pg_notify`-Benachrichtigung trägt nur die ID, nicht den Datensatz (Größenbegrenzung, siehe
 * `EVENT_NOTIFY_CHANNEL`), und diese Funktion liefert dafür die volle — bereits gefilterte —
 * Zeile zurück. `null` heißt: kein Eintrag mit dieser ID, was bei einer echten Ansage aus
 * dieser Datenbank nicht vorkommen sollte, aber kein Grund ist, eine Ausnahme zu werfen.
 */
export async function readEventById(pool: Pool, eventId: string): Promise<EventRecord | null> {
  const result = await pool.query<EventRow>(SELECT_EVENT_BY_ID_SQL, [eventId]);
  return result.rowCount === 0 ? null : toRecord(result.rows[0]);
}
