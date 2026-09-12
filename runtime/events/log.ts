import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { redactValue } from "../redaction/redact.js";
import { eventBus } from "./bus.js";
import { type EventType, assertEventType } from "./types.js";

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

  // Die Ansage an den Ereignisbus (S21) steht aus demselben Grund hier wie der Filter eine
  // Zeile darüber: dies ist das einzige Schreibtor, also kann kein Ereignis an ihr vorbei
  // entstehen. Angesagt wird der Datensatz aus dem RETURNING — also die **gefilterte**
  // Fassung. Der Bus liegt damit per Bauart hinter dem Redaction-Filter.
  //
  // Was er nicht kann: auf den COMMIT warten. Diese Funktion läuft in einer fremden
  // Transaktion (der Aufrufer verantwortet COMMIT/ROLLBACK), und `pg` kennt keinen Haken auf
  // deren Ende. Eine zurückgerollte Transaktion sagt also ein Ereignis an, das nie dauerhaft
  // wurde. Das ist vertretbar, weil der Bus ausdrücklich eine Ansage ist und nicht das
  // Protokoll: die Oberfläche liest jeden verbindlichen Stand aus `kuronami.events` zurück.
  eventBus.publishRecord(record);

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
