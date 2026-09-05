import type { Pool, PoolClient } from "pg";
import { appendEventInTx } from "../events/log.js";
import { SessionCanceledError } from "../steps/hull.js";
import { STEP_COLUMNS, type StepRow, type StepStatus, toStepState } from "../steps/types.js";
import { SESSION_COLUMNS, type SessionRecord, type SessionRow, toSessionRecord } from "./types.js";

/**
 * Was mit einem offenen Schritt geschieht, den eine Wiederaufnahme vorfindet. Abschnitt 6
 * lässt genau diese zwei Möglichkeiten und verlangt, dass nicht geraten wird: die Grundlage
 * ist die Zusage `repeatable` aus der Aufrufstelle, nicht die Lage des Schritts.
 */
export type ResumeDecision = "repeat" | "failed_final";

export interface ResolvedStep {
  stepId: string;
  idempotencyKey: string;
  attempt: number;
  /** Status, in dem die Wiederaufnahme bzw. der Abbruch den Schritt vorgefunden hat. */
  previousStatus: StepStatus;
  decision: ResumeDecision;
}

export interface ResumeReport {
  session: SessionRecord;
  /** Die offenen Schritte, die diese Wiederaufnahme aufgelöst hat. Leer ist der Normalfall. */
  resolved: ResolvedStep[];
}

export interface CancelReport {
  session: SessionRecord;
  /** Schritte, die der Abbruch beendet hat. */
  canceled: Array<Pick<ResolvedStep, "stepId" | "idempotencyKey" | "attempt" | "previousStatus">>;
  /** true, wenn die Session schon vorher abgebrochen war und nichts geschrieben wurde. */
  alreadyCanceled: boolean;
}

const LOCK_SESSION_SQL = `
  SELECT ${SESSION_COLUMNS} FROM kuronami.sessions WHERE session_id = $1 FOR UPDATE
`;

const IS_CANCELED_SQL = `
  SELECT 1 FROM kuronami.events
  WHERE session_id = $1 AND type = 'session.canceled'
  LIMIT 1
`;

/**
 * Offene Schritte, aufsteigend nach Entstehung. `running` heißt: der Checkpoint vor dem
 * Seiteneffekt hat stattgefunden, der danach nicht. Genau diese Lücke hinterlässt ein
 * abgestürzter Prozess.
 */
const SELECT_OPEN_STEPS_SQL = `
  SELECT ${STEP_COLUMNS} FROM kuronami.steps
  WHERE session_id = $1 AND status = ANY($2)
  ORDER BY created_at, step_id
  FOR UPDATE
`;

const CLOSE_STEP_SQL = `
  UPDATE kuronami.steps
  SET status = $2, error = $3, result = NULL, ended_at = now()
  WHERE step_id = $1
`;

async function lockSession(client: PoolClient, sessionId: string): Promise<SessionRecord> {
  const found = await client.query<SessionRow>(LOCK_SESSION_SQL, [sessionId]);
  if (found.rowCount === 0) throw new Error(`Session ${sessionId} existiert nicht`);
  return toSessionRecord(found.rows[0]);
}

async function isCanceled(client: PoolClient, sessionId: string): Promise<boolean> {
  const found = await client.query(IS_CANCELED_SQL, [sessionId]);
  return found.rowCount !== 0;
}

/**
 * Wiederaufnahme innerhalb einer bereits offenen Transaktion, unter gehaltener
 * Sessionsperre. Diese Form gibt es, weil `createOrResumeSession` (S04) beim Wiederfinden
 * dasselbe tut wie ein ausdrückliches `resume(id)`: sonst gäbe es zwei Arten, eine Session
 * wiederaufzunehmen, und nur eine davon räumte die offenen Schritte auf.
 *
 * Reihenfolge im Protokoll: erst `session.resumed`, dann die Auflösung der offenen
 * Schritte. So liest sich der Vorgang später als das, was er ist — eine Wiederaufnahme und
 * die Entscheidungen, die sie erzwungen hat.
 */
export async function resumeSessionInTx(
  client: PoolClient,
  session: SessionRecord,
): Promise<ResumeReport> {
  const open = await client.query<StepRow>(SELECT_OPEN_STEPS_SQL, [session.sessionId, ["running"]]);

  const resolved: ResolvedStep[] = open.rows.map((row) => {
    const step = toStepState(row);
    return {
      stepId: step.stepId,
      idempotencyKey: step.idempotencyKey,
      attempt: step.attempt,
      previousStatus: step.status,
      // Nicht geraten: die Aufrufstelle hat beim Start zugesagt, ob ein zweiter
      // Seiteneffekt gefahrlos ist. Nur diese Zusage entscheidet hier.
      decision: step.repeatable ? "repeat" : "failed_final",
    };
  });

  await appendEventInTx(client, session.sessionId, "session.resumed", {
    thread_id: session.threadId,
    channel: session.channel,
    open_steps: resolved.length,
    decisions: resolved.map((entry) => ({
      step_id: entry.stepId,
      idempotency_key: entry.idempotencyKey,
      decision: entry.decision,
    })),
  });

  for (const entry of resolved) {
    // Beide Entscheidungen enden im selben Zustand: fehlgeschlagen. Der Unterschied liegt
    // nicht im Status, sondern darin, ob die Hülle einen neuen Versuch zulässt — sie prüft
    // dafür `repeatable`. "Wiederholen" heißt also: darf wieder angefasst werden, nicht:
    // wird jetzt heimlich noch einmal ausgeführt.
    const verdict =
      entry.decision === "repeat"
        ? "als wiederholbar angelegt, ein neuer Versuch ist zulässig."
        : "nicht wiederholbar, ein neuer Versuch braucht eine Entscheidung von außen.";
    const error = `Lauf unterbrochen: Der Schritt stand auf running, als die Session wiederaufgenommen wurde. Versuch ${entry.attempt} hat einen unbekannten Ausgang — ob der Seiteneffekt draußen gewirkt hat, ist von hier aus nicht feststellbar. Entscheidung: ${verdict}`;

    await client.query(CLOSE_STEP_SQL, [entry.stepId, "failed", error]);
    await appendEventInTx(client, session.sessionId, "step.failed", {
      step_id: entry.stepId,
      idempotency_key: entry.idempotencyKey,
      attempt: entry.attempt,
      error,
      reason: "interrupted",
      effect_outcome: "unknown",
      repeatable: entry.decision === "repeat",
      decision: entry.decision,
    });
  }

  return { session, resolved };
}

/**
 * `session.resume(id)`. Nimmt die Session über ihre Kennung wieder auf: findet die offenen
 * Schritte und entscheidet über jeden einzelnen, statt sie liegen zu lassen.
 *
 * Der Pool ist erster Parameter, wie überall seit S03 — der Verbindungslebenszyklus bleibt
 * beim Aufrufer.
 */
export async function resumeSession(pool: Pool, sessionId: string): Promise<ResumeReport> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const session = await lockSession(client, sessionId);

    if (await isCanceled(client, sessionId)) {
      // Eine abgebrochene Session wieder anlaufen zu lassen, hieße die Entscheidung des
      // Nutzers zu überschreiben. Weiterarbeiten heißt: eine neue Session.
      throw new SessionCanceledError(
        `Session ${sessionId} ist abgebrochen und wird nicht wiederaufgenommen`,
      );
    }

    const report = await resumeSessionInTx(client, session);
    await client.query("COMMIT");
    return report;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * `session.cancel(id)`. Beendet den Lauf: die Session wird als abgebrochen protokolliert,
 * noch offene Schritte werden geschlossen.
 *
 * Der Abbruch wirkt über Prozessgrenzen, ohne dass ein Signal jemanden erreichen müsste.
 * `beginStep` liest ihn in derselben Transaktion und unter derselben Sessionsperre, in der
 * ein neuer Schritt entstünde — danach startet keiner mehr. Ein Schritt, der schon lief,
 * wird hier geschlossen; kommt sein Ausführer trotzdem noch zum zweiten Checkpoint, trägt
 * er den tatsächlichen Ausgang nach. Das Protokoll behält recht, nicht der Abbruch.
 */
export async function cancelSession(
  pool: Pool,
  sessionId: string,
  reason = "user_request",
): Promise<CancelReport> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const session = await lockSession(client, sessionId);

    if (await isCanceled(client, sessionId)) {
      // Wie `stop()` in S04: zwei session.canceled zu einem Abbruch wären eine
      // Falschaussage über den Lauf, kein bloßer Doppeleintrag.
      await client.query("COMMIT");
      return { session, canceled: [], alreadyCanceled: true };
    }

    const open = await client.query<StepRow>(SELECT_OPEN_STEPS_SQL, [
      sessionId,
      ["pending", "running"],
    ]);
    const canceled = open.rows.map((row) => {
      const step = toStepState(row);
      return {
        stepId: step.stepId,
        idempotencyKey: step.idempotencyKey,
        attempt: step.attempt,
        previousStatus: step.status,
      };
    });

    await appendEventInTx(client, sessionId, "session.canceled", {
      reason,
      canceled_steps: canceled.length,
    });

    for (const entry of canceled) {
      const detail =
        entry.previousStatus === "running"
          ? `, Versuch ${entry.attempt} hat einen unbekannten Ausgang.`
          : ".";
      const error = `Session abgebrochen (${reason}). Der Schritt stand auf ${entry.previousStatus}${detail}`;

      await client.query(CLOSE_STEP_SQL, [entry.stepId, "canceled", error]);
      await appendEventInTx(client, sessionId, "step.canceled", {
        step_id: entry.stepId,
        idempotency_key: entry.idempotencyKey,
        attempt: entry.attempt,
        error,
        reason,
        previous_status: entry.previousStatus,
      });
    }

    await client.query("COMMIT");
    return { session, canceled, alreadyCanceled: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
