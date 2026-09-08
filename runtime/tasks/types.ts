/**
 * Was eine Aufgabe ist, unabhängig davon, wer sie schreibt (`store.ts` über `task.set` /
 * `task.update`) und wer sie wieder herleitet (die Faltung über `task.created` /
 * `task.updated`). Beide Seiten hängen an diesen Typen, keine an der anderen — dasselbe
 * Muster wie `runtime/steps/types.ts`.
 */

import type { JsonValue } from "../steps/types.js";

/**
 * Abschnitt 5, Feld `status`. Entspricht `kuronami.task_status` aus Migration 0001, genau
 * diese acht Werte und keine freien Zeichenketten. Die Reihenfolge ist die aus der
 * Architektur.
 */
export const TASK_STATUSES = [
  "queued",
  "ready",
  "in_progress",
  "blocked",
  "awaiting_user",
  "done",
  "canceled",
  "failed",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Wirft, wenn `value` keiner der acht Statuswerte ist. An der Toolgrenze, vor der Datenbank. */
export function assertTaskStatus(value: unknown): asserts value is TaskStatus {
  if (typeof value !== "string" || !(TASK_STATUSES as readonly string[]).includes(value)) {
    throw new TaskStatusError(
      `Ungültiger Aufgabenstatus ${JSON.stringify(value)}: erlaubt sind ${TASK_STATUSES.join(", ")}`,
    );
  }
}

/** Der übergebene Status steht nicht im Enum. */
export class TaskStatusError extends Error {}

/**
 * Der Zustand einer Aufgabe. Zwei Wege führen hierher und müssen dasselbe ergeben (S05-
 * Disziplin): die Zeile in `kuronami.tasks` (Snapshot) und die Faltung über die
 * `task.*`-Ereignisse (Replay). Deshalb steht hier jede Spalte der Tabelle und keine mehr.
 */
export interface TaskState {
  taskId: string;
  sessionId: string;
  title: string;
  status: TaskStatus;
  /** Wer die Aufgabe hält. Freies Textfeld (Abschnitt 5); Vorgabe `main-agent`. */
  owner: string;
  /** `task_id`s, von denen diese Aufgabe abhängt. Reine Referenzliste, nicht erzwungen. */
  dependencies: string[];
  /** Was die Aufgabe blockiert, als freie Kurztexte (Abschnitt 5). */
  blockers: string[];
  artifactRefs: string[];
  /** Platz in der geordneten Liste. `task.set` vergibt ihn nach Eingabereihenfolge. */
  position: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskRow {
  task_id: string;
  session_id: string;
  title: string;
  status: TaskStatus;
  owner: string;
  dependencies: string[];
  blockers: string[];
  artifact_refs: string[];
  position: number;
  created_at: Date;
  updated_at: Date;
}

export const TASK_COLUMNS = `
  task_id, session_id, title, status, owner, dependencies, blockers,
  artifact_refs, position, created_at, updated_at
`;

export function toTaskState(row: TaskRow): TaskState {
  return {
    taskId: row.task_id,
    sessionId: row.session_id,
    title: row.title,
    status: row.status,
    owner: row.owner,
    dependencies: row.dependencies,
    blockers: row.blockers,
    artifactRefs: row.artifact_refs,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Sortierung, auf die sich Snapshot und Faltung gemeinsam einigen. `position` allein
 * genügt nicht: nichts hindert einen Aufrufer, zwei Aufgaben dieselbe Position zu geben,
 * und dann hinge die Reihenfolge an der Laune der Datenbank. Gleichstand entscheidet die
 * `task_id`, wie bei `compareSteps` (S05).
 */
export function compareTasks(a: TaskState, b: TaskState): number {
  return a.position !== b.position ? a.position - b.position : a.taskId.localeCompare(b.taskId);
}

/**
 * Eine Aufgabe, wie sie in `task.set` hereinkommt. `id` ist Pflicht und vom Aufrufer stabil
 * gewählt (wie `ToolCall.callId` in S07): nur so trifft `task.update` nach einem Neustart
 * dieselbe Aufgabe, und nur so ist die Faltung deterministisch.
 */
export interface TaskSpec {
  id: string;
  title: string;
  status?: TaskStatus;
  owner?: string;
  dependencies?: string[];
  blockers?: string[];
  artifactRefs?: string[];
}

/** Die Felder, die `task.update` ändern darf. Leeres Objekt wird abgewiesen. */
export interface TaskPatch {
  status?: TaskStatus;
  title?: string;
  owner?: string;
  dependencies?: string[];
  blockers?: string[];
  artifactRefs?: string[];
}

/** Der Plan, wie ihn `task.set` / `task.update` in `structured` zurückgeben. */
export function taskToJson(task: TaskState): Record<string, JsonValue> {
  return {
    task_id: task.taskId,
    title: task.title,
    status: task.status,
    owner: task.owner,
    dependencies: task.dependencies,
    blockers: task.blockers,
    artifact_refs: task.artifactRefs,
    position: task.position,
  };
}
