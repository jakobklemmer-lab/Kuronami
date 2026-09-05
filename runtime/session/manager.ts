import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { appendEvent, appendEventInTx } from "../events/log.js";
import { resumeSessionInTx } from "./lifecycle.js";
import {
  SESSION_COLUMNS,
  type SessionChannel,
  type SessionRecord,
  type SessionRow,
  toSessionRecord,
} from "./types.js";

// Seit S05 liegen die Typen in ./types.js, damit Manager und Lebenszyklus nicht
// aufeinander zeigen. Hier weiter sichtbar, weil sie so eingeführt wurden.
export type { ApprovalMode, SessionChannel, SessionRecord } from "./types.js";

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
  approvalMode?: "ask" | "accept_edits" | "bypass_in_sandbox";
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
    return { session: toSessionRecord(inserted.rows[0]), created: true };
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

  return { session: toSessionRecord(existing.rows[0]), created: false };
}

/**
 * Legt die Session zu den Kriterien an oder gibt die bestehende zurück. Der Zustand liegt
 * ausschließlich in `kuronami.sessions`; dieses Modul hält keinen Cache, aus dem ein
 * zweiter Prozess ohnehin nichts läse.
 *
 * Zeile und Ereignis entstehen in derselben Transaktion — ein Checkpoint im Sinne von
 * Abschnitt 6. Andernfalls gäbe es einen Moment, in dem die Session existiert, das
 * Protokoll ihre Entstehung aber nicht kennt, und das Protokoll ist die Wahrheit.
 *
 * Seit S05 ist der Wiederfindungsfall eine echte Wiederaufnahme: er läuft über
 * `resumeSessionInTx` und löst dabei die offenen Schritte auf, die ein abgestürzter Lauf
 * hinterlassen hat. In S04 blieben die noch liegen — genau der dort offen notierte Punkt.
 */
export async function createOrResumeSession(
  pool: Pool,
  criteria: SessionCriteria,
): Promise<ResolvedSession> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const resolved = await resolveSession(client, criteria);

    if (resolved.created) {
      await appendEventInTx(client, resolved.session.sessionId, "session.created", {
        thread_id: resolved.session.threadId,
        channel: resolved.session.channel,
      });
    } else {
      await resumeSessionInTx(client, resolved.session);
    }

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
  /**
   * Bricht bei `stop()`. Seiteneffekte, die über die Ausführungshülle laufen, bekommen ihn
   * als `signal` und können reagieren, statt bis zu ihrem Timeout weiterzulaufen.
   */
  readonly signal: AbortSignal;
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

  const controller = new AbortController();
  let stopped = false;

  return {
    session,
    created,
    runtimeId,
    signal: controller.signal,
    async stop(reason = "shutdown"): Promise<void> {
      // Signalbehandler kommen doppelt (SIGINT und danach SIGTERM). Zwei runtime.stopped zu
      // einem Lauf wären eine Falschaussage über den Prozess, kein bloßer Doppeleintrag.
      if (stopped) return;
      stopped = true;
      controller.abort(new Error(`Runtime beendet: ${reason}`));
      await appendEvent(pool, session.sessionId, "runtime.stopped", {
        runtime_id: runtimeId,
        pid: process.pid,
        reason,
      });
    },
  };
}
