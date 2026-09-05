import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { appendEvent, appendEventInTx } from "../events/log.js";

export type SessionChannel = "web" | "telegram" | "mail" | "heartbeat" | "voice";
export type ApprovalMode = "ask" | "accept_edits" | "bypass_in_sandbox";

/** Eine Zeile aus `kuronami.sessions`, die Felder der Session aus Abschnitt 5. */
export interface SessionRecord {
  sessionId: string;
  threadId: string;
  channel: SessionChannel;
  mode: string;
  modelProfile: string;
  toolCatalogVersion: string;
  approvalMode: ApprovalMode;
  contextState: Record<string, unknown>;
  createdAt: Date;
}

/**
 * Werte, die eine neue Session mitbekommt. Sie gehören bewusst nicht zu den Kriterien:
 * beim Wiederfinden werden sie ignoriert und nie über eine bestehende Session geschrieben.
 * `model_profile` und `tool_catalog_version` mitten in einer Session zu ändern, bräche die
 * Cache-Stabilität (Grundprinzip 2) und baute den Toolsatz im Lauf um (Anti-Muster 2).
 */
export interface SessionDefaults {
  mode?: string;
  modelProfile?: string;
  toolCatalogVersion?: string;
  approvalMode?: ApprovalMode;
}

/**
 * Woran eine Session wiedererkannt wird. Nur `threadId` und `channel` sind Kriterium; sie
 * entsprechen dem UNIQUE-Index aus Migration 0003. Ein neu gestarteter Prozess kennt die
 * `session_id` nicht, wohl aber den Faden und den Kanal, aus dem er gerufen wurde.
 */
export interface SessionCriteria {
  threadId: string;
  channel: SessionChannel;
  defaults?: SessionDefaults;
}

export interface ResolvedSession {
  session: SessionRecord;
  /** true, wenn diese Zeile gerade entstanden ist; false, wenn sie schon da war. */
  created: boolean;
}

/** Startwerte aus dem Session-Beispiel in Abschnitt 5 und aus Abschnitt 13. */
const SESSION_DEFAULTS = {
  mode: "execute",
  modelProfile: "orchestrator-default",
  toolCatalogVersion: "v1",
  approvalMode: "ask",
} as const satisfies Required<SessionDefaults>;

const SESSION_COLUMNS = `
  session_id, thread_id, channel, mode, model_profile,
  tool_catalog_version, approval_mode, context_state, created_at
`;

/**
 * Anlegen und Wiederfinden in einer einzigen Anweisung. Ein vorgeschaltetes SELECT wäre
 * ein Blick auf einen Zustand, der beim folgenden INSERT schon ein anderer sein kann:
 * zwei gleichzeitig startende Prozesse fänden beide nichts und legten beide an. Der
 * UNIQUE-Index entscheidet das statt der Reihenfolge zweier Anfragen.
 */
const INSERT_SESSION_SQL = `
  INSERT INTO kuronami.sessions
    (session_id, thread_id, channel, mode, model_profile, tool_catalog_version, approval_mode)
  VALUES ($1, $2, $3, $4, $5, $6, $7)
  ON CONFLICT (thread_id, channel) DO NOTHING
  RETURNING ${SESSION_COLUMNS}
`;

const SELECT_SESSION_SQL = `
  SELECT ${SESSION_COLUMNS}
  FROM kuronami.sessions
  WHERE thread_id = $1 AND channel = $2
`;

interface SessionRow {
  session_id: string;
  thread_id: string;
  channel: SessionChannel;
  mode: string;
  model_profile: string;
  tool_catalog_version: string;
  approval_mode: ApprovalMode;
  context_state: Record<string, unknown>;
  created_at: Date;
}

function toRecord(row: SessionRow): SessionRecord {
  return {
    sessionId: row.session_id,
    threadId: row.thread_id,
    channel: row.channel,
    mode: row.mode,
    modelProfile: row.model_profile,
    toolCatalogVersion: row.tool_catalog_version,
    approvalMode: row.approval_mode,
    contextState: row.context_state,
    createdAt: row.created_at,
  };
}

async function resolveSession(
  client: PoolClient,
  criteria: SessionCriteria,
): Promise<ResolvedSession> {
  const defaults = criteria.defaults;

  const inserted = await client.query<SessionRow>(INSERT_SESSION_SQL, [
    `sess_${randomUUID()}`,
    criteria.threadId,
    criteria.channel,
    defaults?.mode ?? SESSION_DEFAULTS.mode,
    defaults?.modelProfile ?? SESSION_DEFAULTS.modelProfile,
    defaults?.toolCatalogVersion ?? SESSION_DEFAULTS.toolCatalogVersion,
    defaults?.approvalMode ?? SESSION_DEFAULTS.approvalMode,
  ]);

  if (inserted.rowCount === 1) {
    return { session: toRecord(inserted.rows[0]), created: true };
  }

  // `ON CONFLICT DO NOTHING` liefert bei Kollision keine Zeile zurück, deshalb der zweite
  // Blick. Er sieht die fremde Zeile verlässlich: der Konflikt wartet auf die Transaktion,
  // die sie schreibt, und READ COMMITTED nimmt für jede Anweisung einen frischen Snapshot.
  const existing = await client.query<SessionRow>(SELECT_SESSION_SQL, [
    criteria.threadId,
    criteria.channel,
  ]);

  if (existing.rowCount === 0) {
    throw new Error(
      `Session zu thread_id=${criteria.threadId} channel=${criteria.channel} wurde weder angelegt noch gefunden`,
    );
  }

  return { session: toRecord(existing.rows[0]), created: false };
}

/**
 * Legt die Session zu den Kriterien an oder gibt die bestehende zurück. Der Zustand liegt
 * ausschließlich in `kuronami.sessions`; dieses Modul hält keinen Cache, aus dem ein
 * zweiter Prozess ohnehin nichts läse.
 *
 * Zeile und Ereignis entstehen in derselben Transaktion — ein Checkpoint im Sinne von
 * Abschnitt 6. Andernfalls gäbe es einen Moment, in dem die Session existiert, das
 * Protokoll ihre Entstehung aber nicht kennt, und das Protokoll ist die Wahrheit.
 */
export async function createOrResumeSession(
  pool: Pool,
  criteria: SessionCriteria,
): Promise<ResolvedSession> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const resolved = await resolveSession(client, criteria);
    await appendEventInTx(
      client,
      resolved.session.sessionId,
      resolved.created ? "session.created" : "session.resumed",
      { thread_id: resolved.session.threadId, channel: resolved.session.channel },
    );
    await client.query("COMMIT");
    return resolved;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Ein laufender Runtime-Prozess zu einer Session. Was hier im Speicher steht, ist bei
 * jedem Start neu aus der Datenbank abgeleitet; nichts davon müsste einen Neustart
 * überleben. `runtimeId` benennt genau diese eine Prozess-Inkarnation und macht im
 * Protokoll unterscheidbar, welcher Lauf welchen Eintrag geschrieben hat.
 */
export interface RuntimeHandle {
  readonly session: SessionRecord;
  readonly created: boolean;
  readonly runtimeId: string;
  stop(reason?: string): Promise<void>;
}

/**
 * Nimmt die Session auf und protokolliert, dass ein Prozess sie bedient.
 *
 * Bewusst eine zweite Transaktion nach `createOrResumeSession`: `runtime.started` ist eine
 * Beobachtung über den Prozess, kein Teil des Session-Zustands. Bräche der Start dazwischen
 * ab, fehlte eine Beobachtung, aber keine Zeile stünde falsch.
 */
export async function startRuntime(pool: Pool, criteria: SessionCriteria): Promise<RuntimeHandle> {
  const { session, created } = await createOrResumeSession(pool, criteria);
  const runtimeId = `run_${randomUUID()}`;

  await appendEvent(pool, session.sessionId, "runtime.started", {
    runtime_id: runtimeId,
    pid: process.pid,
    resumed: !created,
  });

  let stopped = false;

  return {
    session,
    created,
    runtimeId,
    async stop(reason = "shutdown"): Promise<void> {
      // Signalbehandler kommen doppelt (SIGINT und danach SIGTERM). Zwei runtime.stopped zu
      // einem Lauf wären eine Falschaussage über den Prozess, kein bloßer Doppeleintrag.
      if (stopped) return;
      stopped = true;
      await appendEvent(pool, session.sessionId, "runtime.stopped", {
        runtime_id: runtimeId,
        pid: process.pid,
        reason,
      });
    },
  };
}
