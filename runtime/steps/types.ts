/**
 * Was ein Schritt ist, unabhängig davon, wer ihn ausführt (Hülle) und wer ihn wieder
 * herleitet (Replay). Beide Seiten hängen an diesen Typen, keine an der anderen.
 */

/**
 * Alles, was durch jsonb passt. Absichtlich kein `unknown`: was in `result` landet, geht
 * durch die Datenbank und kommt als JSON zurück. Ein Typ, der mehr verspricht, als der
 * Rückweg halten kann, wäre eine Lüge über genau die Stelle, an der Replay ansetzt.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Abschnitt 5, Feld `kind`. Entspricht kuronami.step_kind. */
export type StepKind = "plan" | "tool_call" | "verify" | "message";

/** Abschnitt 5, Feld `status`. Entspricht kuronami.step_status. */
export type StepStatus = "pending" | "running" | "completed" | "failed" | "canceled";

/**
 * Der Zustand eines Schritts. Zwei Wege führen hierher, und dass beide dasselbe ergeben,
 * ist das Ergebnis von S05: die Zeile in `kuronami.steps` (Snapshot) und die Faltung über
 * das Ereignisprotokoll (Replay). Deshalb steht hier jede Spalte der Tabelle und keine
 * mehr — eine Spalte, die das Protokoll nicht hergibt, wäre ein stiller Bruch.
 */
export interface StepState {
  stepId: string;
  sessionId: string;
  /** Identität der Arbeit, stabil über Prozessgrenzen. Siehe Migration 0004. */
  idempotencyKey: string;
  kind: StepKind;
  toolName: string | null;
  status: StepStatus;
  /** Zahl der bisherigen Ausführungsversuche. 0 = angelegt, aber nie gestartet. */
  attempt: number;
  /** Darf der Seiteneffekt gefahrlos ein zweites Mal laufen? */
  repeatable: boolean;
  result: JsonValue | null;
  /** Voller Fehlertext samt Stacktrace, nicht geglättet (AGENTS.md). */
  error: string | null;
  artifactRefs: string[];
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
}

export interface StepRow {
  step_id: string;
  session_id: string;
  idempotency_key: string;
  kind: StepKind;
  tool_name: string | null;
  status: StepStatus;
  attempt: number;
  repeatable: boolean;
  result: JsonValue | null;
  error: string | null;
  artifact_refs: string[];
  created_at: Date;
  started_at: Date | null;
  ended_at: Date | null;
}

export const STEP_COLUMNS = `
  step_id, session_id, idempotency_key, kind, tool_name, status, attempt,
  repeatable, result, error, artifact_refs, created_at, started_at, ended_at
`;

export function toStepState(row: StepRow): StepState {
  return {
    stepId: row.step_id,
    sessionId: row.session_id,
    idempotencyKey: row.idempotency_key,
    kind: row.kind,
    toolName: row.tool_name,
    status: row.status,
    attempt: row.attempt,
    repeatable: row.repeatable,
    result: row.result,
    error: row.error,
    artifactRefs: row.artifact_refs,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

/**
 * Sortierung, auf die sich Snapshot und Replay gemeinsam einigen. `created_at` allein
 * genügt nicht: zwei Schritte könnten sich einen Zeitstempel teilen, und dann hinge die
 * Reihenfolge an der Laune der Datenbank statt an einer Regel.
 */
export function compareSteps(a: StepState, b: StepState): number {
  const byTime = a.createdAt.getTime() - b.createdAt.getTime();
  return byTime !== 0 ? byTime : a.stepId.localeCompare(b.stepId);
}
