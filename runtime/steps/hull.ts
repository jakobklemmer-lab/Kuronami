import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { appendEventInTx } from "../events/log.js";
import {
  type JsonValue,
  STEP_COLUMNS,
  type StepKind,
  type StepRow,
  type StepState,
  toStepState,
} from "./types.js";

/** Sandbox-Timeout aus Abschnitt 13. */
export const DEFAULT_STEP_TIMEOUT_MS = 60_000;

/**
 * "Max. Wiederholungen pro Schritt: 2 bis 3" (Abschnitt 13). Gezählt werden hier Versuche,
 * nicht Wiederholungen: drei Versuche sind ein erster plus zwei Wiederholungen, also das
 * untere Ende der Spanne. Eine Obergrenze muss es geben, sonst wird aus "wiederholbar"
 * eine Endlosschleife über denselben Seiteneffekt.
 */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** Der Lauf ist abgebrochen; kein Schritt darf mehr starten. */
export class SessionCanceledError extends Error {}
/** Ein anderer Ausführer hält diesen Schritt gerade. Nur die Wiederaufnahme löst das auf. */
export class StepAlreadyRunningError extends Error {}
/** Der Schritt ist nicht wiederholbar und hat bereits einen Versuch hinter sich. */
export class StepNotRepeatableError extends Error {}
/** Die Obergrenze aus Abschnitt 13 ist erreicht. */
export class StepAttemptsExhaustedError extends Error {}
/** Der Schritt wurde abgebrochen und wird nicht neu gestartet. */
export class StepCanceledError extends Error {}
/** Der Seiteneffekt hat das Zeitfenster überschritten. */
export class StepTimeoutError extends Error {}
/** Der Seiteneffekt wurde von außen abgebrochen. */
export class StepAbortedError extends Error {}

/** Was der Seiteneffekt über sich selbst wissen darf. */
export interface StepContext {
  readonly stepId: string;
  readonly idempotencyKey: string;
  readonly attempt: number;
  /**
   * Bricht bei Timeout und bei Abbruch von außen. Ein Effekt, der darauf hört, hört
   * wirklich auf; einer, der nicht darauf hört, läuft weiter — die Hülle kann eine
   * laufende Zusage nicht abschießen. Genau deshalb ist ein Timeout kein sauberer Fehler.
   */
  readonly signal: AbortSignal;
}

export type StepEffect = (context: StepContext) => Promise<JsonValue>;

export interface StepSpec {
  sessionId: string;
  /**
   * Identität der Arbeit, nicht der Zeile. Muss ein wiederaufnehmender Prozess aus seinem
   * Plan wieder herleiten können, ohne die step_id zu kennen.
   */
  idempotencyKey: string;
  kind: StepKind;
  toolName?: string | null;
  /**
   * Pflichtfeld ohne Default. Ob ein unterbrochener Seiteneffekt wiederholt werden darf,
   * ist eine Aussage über die Außenwelt, die nur die Aufrufstelle treffen kann. Ein
   * Default hier wäre genau das Raten, das Abschnitt 6 verbietet.
   */
  repeatable: boolean;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Abbruch von außen, etwa durch das Signal eines laufenden Runtime-Prozesses. */
  signal?: AbortSignal;
}

export interface StepClaim {
  step: StepState;
  /** true, wenn der Schritt schon abgeschlossen war und der Seiteneffekt entfällt. */
  alreadyCompleted: boolean;
}

export interface StepOutcome {
  status: "ok" | "error";
  step: StepState;
  result: JsonValue | null;
  /** Voller Fehlertext samt Stacktrace. Wird nie geglättet (AGENTS.md). */
  error: string | null;
  /** false, wenn der Seiteneffekt übersprungen wurde, weil der Schritt schon fertig war. */
  executed: boolean;
}

const LOCK_SESSION_SQL = `
  SELECT session_id FROM kuronami.sessions WHERE session_id = $1 FOR UPDATE
`;

/**
 * Der Abbruch wird in derselben Transaktion gelesen, in der der Schritt entstehen würde,
 * und unter derselben Sessionsperre, die cancelSession hält. Ein Blick davor wäre eine
 * Momentaufnahme: zwischen "nicht abgebrochen" und dem INSERT läge ein Spalt, in den ein
 * gleichzeitiger Abbruch fiele.
 */
const IS_CANCELED_SQL = `
  SELECT 1 FROM kuronami.events
  WHERE session_id = $1 AND type = 'session.canceled'
  LIMIT 1
`;

const CLAIM_STEP_SQL = `
  INSERT INTO kuronami.steps
    (step_id, session_id, idempotency_key, kind, tool_name, repeatable, status, attempt, started_at)
  VALUES ($1, $2, $3, $4, $5, $6, 'running', 1, now())
  ON CONFLICT (session_id, idempotency_key) DO NOTHING
  RETURNING ${STEP_COLUMNS}
`;

const SELECT_STEP_FOR_UPDATE_SQL = `
  SELECT ${STEP_COLUMNS} FROM kuronami.steps
  WHERE session_id = $1 AND idempotency_key = $2
  FOR UPDATE
`;

const SELECT_STEP_BY_ID_SQL = `
  SELECT ${STEP_COLUMNS} FROM kuronami.steps WHERE step_id = $1 FOR UPDATE
`;

/**
 * Ein neuer Versuch am selben Schlüssel. `result`, `error` und `ended_at` werden bewusst
 * zurückgesetzt: das Ergebnis des vorigen Versuchs gilt nicht mehr, und die Faltung über
 * das Protokoll setzt sie bei step.started ebenfalls zurück. Liefen beide auseinander,
 * wäre der Snapshot nicht mehr aus dem Protokoll herleitbar.
 */
const RETRY_STEP_SQL = `
  UPDATE kuronami.steps
  SET status = 'running', attempt = attempt + 1, started_at = now(),
      ended_at = NULL, error = NULL, result = NULL
  WHERE step_id = $1
  RETURNING ${STEP_COLUMNS}
`;

const FINISH_STEP_SQL = `
  UPDATE kuronami.steps
  SET status = $2, result = $3::jsonb, error = $4, ended_at = now()
  WHERE step_id = $1
  RETURNING ${STEP_COLUMNS}
`;

/** Behält Stacktrace und Wortlaut. Kein Abfangen, das den Fehler freundlich macht. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * Checkpoint **vor** dem Seiteneffekt (Abschnitt 6, Regel 1). Legt den Schritt an oder
 * findet ihn über seinen Idempotenzschlüssel wieder, entscheidet, ob ein Versuch überhaupt
 * beginnen darf, und schreibt step.started — Zeile und Ereignis in einer Transaktion.
 *
 * Absichtlich öffentlich und nicht in executeStep versteckt: die Ausführungshülle ist ein
 * Paar aus zwei Checkpoints, und ein abgestürzter Prozess ist genau der Fall, in dem nur
 * der erste stattgefunden hat. Wer diesen Fall herstellen oder prüfen will, braucht die
 * beiden Hälften einzeln.
 */
export async function beginStep(pool: Pool, spec: StepSpec): Promise<StepClaim> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claim = await claimStep(client, spec);
    await client.query("COMMIT");
    return claim;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function claimStep(client: PoolClient, spec: StepSpec): Promise<StepClaim> {
  const maxAttempts = spec.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  // Dieselbe Sessionsperre, die seit S03 die seq-Vergabe serialisiert. Sie trägt hier eine
  // zweite Bedeutung: wer den Schrittbestand einer Session ändert, hält sie. Eine Sperre je
  // Session, damit es keine Reihenfolge zwischen zwei Sperren zu beachten gibt.
  const session = await client.query(LOCK_SESSION_SQL, [spec.sessionId]);
  if (session.rowCount === 0) {
    throw new Error(`Session ${spec.sessionId} existiert nicht, Schritt wurde nicht gestartet`);
  }

  const canceled = await client.query(IS_CANCELED_SQL, [spec.sessionId]);
  if (canceled.rowCount !== 0) {
    throw new SessionCanceledError(
      `Session ${spec.sessionId} ist abgebrochen, Schritt ${spec.idempotencyKey} wurde nicht gestartet`,
    );
  }

  const inserted = await client.query<StepRow>(CLAIM_STEP_SQL, [
    `step_${randomUUID()}`,
    spec.sessionId,
    spec.idempotencyKey,
    spec.kind,
    spec.toolName ?? null,
    spec.repeatable,
  ]);

  const step =
    inserted.rowCount === 1
      ? toStepState(inserted.rows[0])
      : await reclaimStep(client, spec, maxAttempts);

  if (step.status === "completed") {
    // Kein Ereignis. Es ist nichts geschehen, was den Zustand änderte, und ein Protokoll,
    // das folgenlose Aufrufe mitschreibt, erschwert das Lesen, ohne etwas herzuleiten.
    return { step, alreadyCompleted: true };
  }

  await appendEventInTx(client, spec.sessionId, "step.started", {
    step_id: step.stepId,
    idempotency_key: step.idempotencyKey,
    kind: step.kind,
    tool_name: step.toolName,
    repeatable: step.repeatable,
    attempt: step.attempt,
    timeout_ms: spec.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
  });

  return { step, alreadyCompleted: false };
}

/** Der Schlüssel war schon da. Ob daraus ein neuer Versuch wird, entscheidet sich hier. */
async function reclaimStep(
  client: PoolClient,
  spec: StepSpec,
  maxAttempts: number,
): Promise<StepState> {
  const found = await client.query<StepRow>(SELECT_STEP_FOR_UPDATE_SQL, [
    spec.sessionId,
    spec.idempotencyKey,
  ]);
  if (found.rowCount === 0) {
    throw new Error(
      `Schritt ${spec.idempotencyKey} wurde weder angelegt noch gefunden (Session ${spec.sessionId})`,
    );
  }

  const existing = toStepState(found.rows[0]);

  // Der abgeschlossene Schritt ist der eigentliche Zweck des Idempotenzschlüssels: der
  // Seiteneffekt lief schon, sein Ergebnis steht in der Zeile, es wird zurückgegeben statt
  // ein zweites Mal erzeugt.
  if (existing.status === "completed") return existing;

  if (existing.status === "running") {
    // Entweder hält gerade ein anderer Ausführer den Schritt, oder ein abgestürzter Lauf
    // hat ihn offen liegen lassen. Von außen ist das nicht zu unterscheiden, und raten
    // verbietet Abschnitt 6. Auflösen darf das nur resumeSession.
    throw new StepAlreadyRunningError(
      `Schritt ${existing.stepId} (${existing.idempotencyKey}) steht auf running, Versuch ${existing.attempt}. Ein offener Schritt wird nicht nebenbei übernommen: erst resumeSession entscheidet über ihn.`,
    );
  }

  // ACHTUNG, keine Leiche: dieser Zweig ist heute nicht über die öffentliche API
  // erreichbar, weil `cancelSession` der einzige Abbrecher von Schritten ist und dabei
  // immer auch die Session abbricht — dann wirft schon die Abbruchprüfung oben. Diese
  // Kaskade ist aber nur Konvention der aktuellen Implementierung, kein Constraint im Typ
  // und keiner in der Datenbank. Sobald ein einzelner Schritt ohne die Session abgebrochen
  // wird (absehbar mit user.ask in S10 oder der Policy-Engine in S11), ist der Zweig der
  // einzige Halt: ohne ihn fiele ein abgebrochener Schritt in den Wiederholungszweig
  // darunter und liefe noch einmal los. Der Test "startet einen einzeln abgebrochenen
  // Schritt nicht neu" hält das fest, ohne auf jene Aufrufstelle zu warten.
  if (existing.status === "canceled") {
    throw new StepCanceledError(
      `Schritt ${existing.stepId} (${existing.idempotencyKey}) wurde abgebrochen und wird nicht neu gestartet`,
    );
  }

  // Bleibt failed oder pending. Ein zweiter Versuch ist ein zweiter Seiteneffekt, und ob
  // der erste draußen etwas bewirkt hat, weiß die Hülle nicht — auch ein Effekt, der eine
  // Ausnahme wirft, kann vorher die Mail verschickt haben. Deshalb entscheidet allein die
  // Zusage der Aufrufstelle, nicht die Art des Fehlers.
  if (!existing.repeatable) {
    throw new StepNotRepeatableError(
      `Schritt ${existing.stepId} (${existing.idempotencyKey}) ist als nicht wiederholbar angelegt und hat Versuch ${existing.attempt} mit unbekanntem Ausgang hinter sich. Ein zweiter Versuch braucht eine Entscheidung von außen, keine Vermutung der Hülle.`,
    );
  }

  if (existing.attempt >= maxAttempts) {
    throw new StepAttemptsExhaustedError(
      `Schritt ${existing.stepId} (${existing.idempotencyKey}) hat ${existing.attempt} von ${maxAttempts} Versuchen verbraucht`,
    );
  }

  const retried = await client.query<StepRow>(RETRY_STEP_SQL, [existing.stepId]);
  return toStepState(retried.rows[0]);
}

interface FinishInput {
  status: "completed" | "failed";
  result?: JsonValue | null;
  error?: string | null;
  /** Landet unverändert im Ereignis. Trägt Grund und Ungewissheit des Ausgangs. */
  payload?: Record<string, JsonValue>;
}

/**
 * Checkpoint **nach** dem Seiteneffekt (Abschnitt 6, Regel 1). Schreibt Ausgang und
 * Ereignis in einer Transaktion.
 *
 * Prüft bewusst **nicht**, ob die Session inzwischen abgebrochen wurde: der Seiteneffekt
 * ist dann trotzdem gelaufen. Ihn wegen eines Abbruchs nicht zu protokollieren, hieße das
 * Protokoll über die Außenwelt lügen zu lassen, und das Protokoll ist die Wahrheit.
 */
export async function finishStep(
  pool: Pool,
  stepId: string,
  outcome: FinishInput,
): Promise<StepState> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const found = await client.query<StepRow>(SELECT_STEP_BY_ID_SQL, [stepId]);
    if (found.rowCount === 0) throw new Error(`Schritt ${stepId} existiert nicht`);
    const before = toStepState(found.rows[0]);

    const result = outcome.result ?? null;
    const updated = await client.query<StepRow>(FINISH_STEP_SQL, [
      stepId,
      outcome.status,
      result === null ? null : JSON.stringify(result),
      outcome.error ?? null,
    ]);
    const step = toStepState(updated.rows[0]);

    await appendEventInTx(
      client,
      step.sessionId,
      outcome.status === "completed" ? "step.completed" : "step.failed",
      {
        step_id: step.stepId,
        idempotency_key: step.idempotencyKey,
        attempt: step.attempt,
        ...(outcome.status === "completed"
          ? { result }
          : { error: outcome.error ?? null, ...outcome.payload }),
        // Hat ein Abbruch diesen Schritt überholt, steht das im Protokoll, statt verschwiegen
        // zu werden: der Schritt lief zu Ende, obwohl die Session abgebrochen wurde.
        ...(before.status === "canceled" ? { after_cancel: true } : {}),
      },
    );

    await client.query("COMMIT");
    return step;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

interface EffectOutcome {
  ok: boolean;
  value: JsonValue;
  error: unknown;
  reason: "ok" | "timeout" | "aborted" | "error";
  /** true, wenn der Effekt das Rennen verloren hat und weiterläuft. */
  stillRunning: boolean;
}

/**
 * Führt den Seiteneffekt gegen eine Uhr aus. Das Zeitfenster ist der Unterschied zwischen
 * einem fehlgeschlagenen Schritt und einem stehenden Lauf: ohne es wartet die Schleife
 * ewig auf einen Effekt, der nie zurückkommt.
 */
async function runEffect(
  effect: StepEffect,
  base: Omit<StepContext, "signal">,
  timeoutMs: number,
  outer: AbortSignal | undefined,
): Promise<EffectOutcome> {
  const controller = new AbortController();
  let interruption: { reason: "timeout" | "aborted"; error: Error } | undefined;
  let rejectRace: ((error: Error) => void) | undefined;

  function interrupt(reason: "timeout" | "aborted", error: Error): void {
    if (interruption) return;
    interruption = { reason, error };
    // Erst das Rennen entscheiden, dann abbrechen. Umgekehrt gewänne ein Effekt, der auf
    // sein Signal hört: `abort()` ruft seinen Zuhörer sofort auf, dessen Auflösung stünde
    // vor der Ablehnung in der Warteschlange, und ein abgelaufenes Zeitfenster käme als
    // ordentliches Ergebnis zurück. Wer aufs Signal hört, würde damit bestraft.
    rejectRace?.(error);
    controller.abort(error);
  }

  const timer = setTimeout(
    () =>
      interrupt(
        "timeout",
        new StepTimeoutError(
          `Schritt ${base.stepId} (${base.idempotencyKey}) hat das Zeitfenster von ${timeoutMs} ms überschritten`,
        ),
      ),
    timeoutMs,
  );
  const onOuterAbort = (): void =>
    interrupt(
      "aborted",
      new StepAbortedError(`Schritt ${base.stepId} (${base.idempotencyKey}) wurde abgebrochen`),
    );
  outer?.addEventListener("abort", onOuterAbort, { once: true });

  const interrupted = new Promise<never>((_, reject) => {
    rejectRace = reject;
  });
  // Ein bereits abgebrochenes Signal feuert kein Ereignis mehr, also hier selbst nachholen.
  if (outer?.aborted) onOuterAbort();

  const running = effect({ ...base, signal: controller.signal });
  // Der Zweig, der das Rennen verliert, läuft weiter. Ohne diesen Fänger risse eine
  // spätere Ablehnung den ganzen Prozess mit einer unbehandelten Rejection ab.
  running.catch(() => {});

  try {
    const value = await Promise.race([running, interrupted]);
    return { ok: true, value, error: null, reason: "ok", stillRunning: false };
  } catch (error) {
    if (interruption) {
      return {
        ok: false,
        value: null,
        error: interruption.error,
        reason: interruption.reason,
        // JavaScript kann eine laufende Zusage nicht abschießen. Was der Effekt draußen
        // noch bewirkt, sieht die Hülle nicht mehr.
        stillRunning: true,
      };
    }
    return { ok: false, value: null, error, reason: "error", stillRunning: false };
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuterAbort);
  }
}

/**
 * Die Ausführungshülle: Checkpoint, Seiteneffekt, Checkpoint. Jeder externe Seiteneffekt
 * läuft hierdurch — das ist die Zusage aus Abschnitt 6, ohne die weder Wiederaufnahme noch
 * Replay sicher sind.
 *
 * Fehler des Seiteneffekts kommen als `status: "error"` zurück und nicht als Ausnahme: sie
 * sind das Ergebnis des Schritts und gehören dem Aufrufer vorgelegt, nicht an ihm vorbei
 * nach oben geworfen. Weigert sich dagegen die Hülle, überhaupt zu starten (Abbruch,
 * offener Schritt, nicht wiederholbar, Versuche verbraucht), wirft sie: dann gibt es kein
 * Schrittergebnis, sondern eine Lage, die von außen entschieden werden muss.
 */
export async function executeStep(
  pool: Pool,
  spec: StepSpec,
  effect: StepEffect,
): Promise<StepOutcome> {
  const claim = await beginStep(pool, spec);

  if (claim.alreadyCompleted) {
    return {
      status: "ok",
      step: claim.step,
      result: claim.step.result,
      error: null,
      executed: false,
    };
  }

  const outcome = await runEffect(
    effect,
    {
      stepId: claim.step.stepId,
      idempotencyKey: claim.step.idempotencyKey,
      attempt: claim.step.attempt,
    },
    spec.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
    spec.signal,
  );

  if (outcome.ok) {
    const step = await finishStep(pool, claim.step.stepId, {
      status: "completed",
      result: outcome.value,
    });
    return { status: "ok", step, result: step.result, error: null, executed: true };
  }

  const error = describeError(outcome.error);
  const step = await finishStep(pool, claim.step.stepId, {
    status: "failed",
    error,
    payload: {
      reason: outcome.reason,
      // Was der Effekt draußen bewirkt hat, weiß die Hülle nie: auch eine Ausnahme kann
      // nach dem Seiteneffekt geflogen sein. Ein Timeout ist noch schlechter dran, dort
      // läuft der Effekt weiter. Deshalb steht hier kein Freispruch, sondern der Befund.
      effect_outcome: "unknown",
      effect_still_running: outcome.stillRunning,
    },
  });

  return { status: "error", step, result: null, error, executed: true };
}
