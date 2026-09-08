import type { Pool, PoolClient } from "pg";
import { type EventRecord, appendEventInTx, readEvents } from "../events/log.js";
import { redactText } from "../redaction/redact.js";
import {
  TASK_COLUMNS,
  type TaskPatch,
  type TaskRow,
  type TaskSpec,
  type TaskState,
  type TaskStatus,
  assertTaskStatus,
  compareTasks,
  toTaskState,
} from "./types.js";

/**
 * `task.set` und `task.update` (Abschnitt 9). Der Plan ist das Kurzzeitgedächtnis der
 * Session (Abschnitt 8): er lebt in `kuronami.tasks` **und** im Ereignisprotokoll, und die
 * Faltung über `task.created`/`task.updated` muss denselben Stand ergeben wie die Zeilen
 * (S05-Disziplin — `replay.test.ts`-Muster). Deshalb schreibt jede Änderung Zeile und
 * Ereignis in **einer** Transaktion, mit `now()` als gemeinsamem Zeitstempel.
 *
 * `task.set` schreibt den **kompletten** Plan neu, es hängt nicht an: Aufgaben, die in der
 * neuen Liste fehlen, werden entfernt (Zeile gelöscht, `task.updated` mit `dropped: true`,
 * damit die Faltung sie fallen lassen kann). Die `id` jeder Aufgabe wählt der Aufrufer
 * stabil (wie `callId` in S07) — nur so trifft ein `task.update` nach einem Neustart
 * dieselbe Aufgabe.
 *
 * Beide laufen **nicht** durch die Ausführungshülle aus S05: sie haben keinen externen
 * Seiteneffekt. `task.set` ist deklarativ (derselbe Plan noch einmal gesetzt ist ein No-op),
 * `task.update` ein gezielter Patch. Der Determinismus folgt aus der Form der Operation,
 * nicht aus einem Idempotenzschlüssel, der ein Wiederverschicken absichert — dasselbe
 * Argument wie bei `writeArtifact` (S06), das ebenfalls Zeile und Ereignis ohne die Hülle
 * schreibt.
 */

/** `task.update` zeigt auf eine Aufgabe, die es in dieser Session nicht (mehr) gibt. */
export class TaskNotFoundError extends Error {}
/** `task.set` bekommt zweimal dieselbe `id`, oder `task.update` einen leeren Patch. */
export class TaskInputError extends Error {}

export interface PlanChange {
  /** Der vollständige Plan nach der Änderung, geordnet. */
  plan: TaskState[];
  created: string[];
  updated: string[];
  dropped: string[];
}

const LOCK_SESSION_SQL = `
  SELECT session_id FROM kuronami.sessions WHERE session_id = $1 FOR UPDATE
`;

const SELECT_PLAN_SQL = `SELECT ${TASK_COLUMNS} FROM kuronami.tasks WHERE session_id = $1`;

const SELECT_TASK_FOR_UPDATE_SQL = `
  SELECT ${TASK_COLUMNS} FROM kuronami.tasks WHERE session_id = $1 AND task_id = $2 FOR UPDATE
`;

const INSERT_TASK_SQL = `
  INSERT INTO kuronami.tasks
    (task_id, session_id, title, status, owner, dependencies, blockers, artifact_refs, position)
  VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9)
  RETURNING ${TASK_COLUMNS}
`;

/** Setzt alle veränderlichen Felder auf den übergebenen Stand. Die Herkunft (`created_at`) bleibt. */
const UPDATE_TASK_SQL = `
  UPDATE kuronami.tasks
  SET title = $3, status = $4, owner = $5, dependencies = $6::jsonb, blockers = $7::jsonb,
      artifact_refs = $8::jsonb, position = $9, updated_at = now()
  WHERE session_id = $1 AND task_id = $2
  RETURNING ${TASK_COLUMNS}
`;

const DELETE_TASK_SQL = `
  DELETE FROM kuronami.tasks WHERE session_id = $1 AND task_id = $2
`;

const DEFAULT_OWNER = "main-agent";

/** Der vollständige Feldsatz einer Aufgabe, wie er in Zeile und Ereignis geht. */
interface TaskFields {
  title: string;
  status: TaskStatus;
  owner: string;
  dependencies: string[];
  blockers: string[];
  artifactRefs: string[];
  position: number;
}

/**
 * Der Redaction-Filter (Abschnitt 4.7) an derselben Stelle wie in `writeArtifact` (S06):
 * einmal am Schreibtor, über jeden Text, der in Zeile **und** Ereignis geht. Zeile und
 * Ereignis müssen bitweise denselben Wert tragen, sonst laufen Snapshot und Faltung
 * auseinander (der Replay-Vergleich fängt das). `task_id` und `session_id` werden **nicht**
 * ersetzt, sondern geprüft: sie sind Identität (wie `idempotency_key`, den S07 bewusst aus
 * der Feldnamensliste hält). Verändert der Filter sie doch, taugen sie nicht als Schlüssel.
 */
function redactFields(fields: TaskFields): TaskFields {
  return {
    title: redactText(fields.title),
    status: fields.status,
    owner: redactText(fields.owner),
    dependencies: fields.dependencies.map(redactText),
    blockers: fields.blockers.map(redactText),
    artifactRefs: fields.artifactRefs.map(redactText),
    position: fields.position,
  };
}

function assertUsableId(id: unknown): asserts id is string {
  if (typeof id !== "string" || id.trim() === "") {
    throw new TaskInputError(
      "jede Aufgabe braucht eine nicht leere id (vom Aufrufer stabil gewählt)",
    );
  }
  if (redactText(id) !== id) {
    throw new TaskInputError(
      `id "${id}" wird vom Redaction-Filter verändert und taugt damit nicht als stabiler Schlüssel`,
    );
  }
}

function specToFields(spec: TaskSpec, position: number): TaskFields {
  assertUsableId(spec.id);
  if (typeof spec.title !== "string" || spec.title.trim() === "") {
    throw new TaskInputError(`Aufgabe "${spec.id}": title fehlt`);
  }
  if (spec.status !== undefined) assertTaskStatus(spec.status);
  return redactFields({
    title: spec.title,
    status: spec.status ?? "queued",
    owner: spec.owner ?? DEFAULT_OWNER,
    dependencies: [...(spec.dependencies ?? [])],
    blockers: [...(spec.blockers ?? [])],
    artifactRefs: [...(spec.artifactRefs ?? [])],
    position,
  });
}

function fieldsOf(task: TaskState): TaskFields {
  return {
    title: task.title,
    status: task.status,
    owner: task.owner,
    dependencies: task.dependencies,
    blockers: task.blockers,
    artifactRefs: task.artifactRefs,
    position: task.position,
  };
}

function sameFields(a: TaskFields, b: TaskFields): boolean {
  return (
    a.title === b.title &&
    a.status === b.status &&
    a.owner === b.owner &&
    a.position === b.position &&
    JSON.stringify(a.dependencies) === JSON.stringify(b.dependencies) &&
    JSON.stringify(a.blockers) === JSON.stringify(b.blockers) &&
    JSON.stringify(a.artifactRefs) === JSON.stringify(b.artifactRefs)
  );
}

/** Payload für `task.created` / das nicht-`dropped`-`task.updated`. Trägt jede Spalte. */
function taskEventPayload(taskId: string, sessionId: string, fields: TaskFields) {
  return {
    task_id: taskId,
    session_id: sessionId,
    title: fields.title,
    status: fields.status,
    owner: fields.owner,
    dependencies: fields.dependencies,
    blockers: fields.blockers,
    artifact_refs: fields.artifactRefs,
    position: fields.position,
  };
}

async function lockSession(client: PoolClient, sessionId: string): Promise<void> {
  const found = await client.query(LOCK_SESSION_SQL, [sessionId]);
  if (found.rowCount === 0) {
    throw new Error(`Session ${sessionId} existiert nicht, der Plan wurde nicht geschrieben`);
  }
}

async function insertTask(
  client: PoolClient,
  taskId: string,
  sessionId: string,
  fields: TaskFields,
): Promise<TaskState> {
  const inserted = await client.query<TaskRow>(INSERT_TASK_SQL, [
    taskId,
    sessionId,
    fields.title,
    fields.status,
    fields.owner,
    JSON.stringify(fields.dependencies),
    JSON.stringify(fields.blockers),
    JSON.stringify(fields.artifactRefs),
    fields.position,
  ]);
  await appendEventInTx(
    client,
    sessionId,
    "task.created",
    taskEventPayload(taskId, sessionId, fields),
  );
  return toTaskState(inserted.rows[0]);
}

async function updateTaskRow(
  client: PoolClient,
  taskId: string,
  sessionId: string,
  fields: TaskFields,
): Promise<TaskState> {
  const updated = await client.query<TaskRow>(UPDATE_TASK_SQL, [
    sessionId,
    taskId,
    fields.title,
    fields.status,
    fields.owner,
    JSON.stringify(fields.dependencies),
    JSON.stringify(fields.blockers),
    JSON.stringify(fields.artifactRefs),
    fields.position,
  ]);
  await appendEventInTx(
    client,
    sessionId,
    "task.updated",
    taskEventPayload(taskId, sessionId, fields),
  );
  return toTaskState(updated.rows[0]);
}

async function currentPlan(client: PoolClient, sessionId: string): Promise<TaskState[]> {
  const rows = await client.query<TaskRow>(SELECT_PLAN_SQL, [sessionId]);
  return rows.rows.map(toTaskState).sort(compareTasks);
}

/**
 * Schreibt den kompletten Plan neu. Aufgaben, deren `id` schon dasteht, werden auf den neuen
 * Stand gebracht (nur wenn sich etwas ändert — ein unveränderter Re-`set` schreibt kein
 * Ereignis, wie `beginStep` bei einem schon fertigen Schritt); neue kommen dazu; fehlende
 * werden entfernt.
 */
export async function setPlan(
  pool: Pool,
  sessionId: string,
  specs: TaskSpec[],
): Promise<PlanChange> {
  const seen = new Set<string>();
  const wanted = specs.map((spec, index) => {
    if (seen.has(spec.id)) {
      throw new TaskInputError(`id "${spec.id}" kommt in task.set mehrfach vor`);
    }
    seen.add(spec.id);
    return { id: spec.id, fields: specToFields(spec, index) };
  });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockSession(client, sessionId);

    const existing = new Map(
      (await currentPlan(client, sessionId)).map((task) => [task.taskId, task]),
    );
    const change: PlanChange = { plan: [], created: [], updated: [], dropped: [] };

    for (const { id, fields } of wanted) {
      const before = existing.get(id);
      if (!before) {
        await insertTask(client, id, sessionId, fields);
        change.created.push(id);
      } else if (!sameFields(fieldsOf(before), fields)) {
        await updateTaskRow(client, id, sessionId, fields);
        change.updated.push(id);
      }
    }

    for (const [id] of existing) {
      if (!seen.has(id)) {
        await client.query(DELETE_TASK_SQL, [sessionId, id]);
        await appendEventInTx(client, sessionId, "task.updated", {
          task_id: id,
          session_id: sessionId,
          dropped: true,
        });
        change.dropped.push(id);
      }
    }

    change.plan = await currentPlan(client, sessionId);
    await client.query("COMMIT");
    return change;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Ändert Status, Blocker, Artefakt-Refs oder Titel einer einzelnen Aufgabe. */
export async function updateTask(
  pool: Pool,
  sessionId: string,
  taskId: string,
  patch: TaskPatch,
): Promise<PlanChange> {
  const keys = Object.entries(patch).filter(([, value]) => value !== undefined);
  if (keys.length === 0) {
    throw new TaskInputError(`task.update für "${taskId}" hat kein Feld zu ändern`);
  }
  if (patch.status !== undefined) assertTaskStatus(patch.status);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockSession(client, sessionId);

    const found = await client.query<TaskRow>(SELECT_TASK_FOR_UPDATE_SQL, [sessionId, taskId]);
    if (found.rowCount === 0) {
      throw new TaskNotFoundError(
        `Aufgabe "${taskId}" gibt es in Session ${sessionId} nicht. task.set legt den Plan an.`,
      );
    }
    const before = toTaskState(found.rows[0]);
    const merged = redactFields({
      title: patch.title ?? before.title,
      status: patch.status ?? before.status,
      owner: patch.owner ?? before.owner,
      dependencies: patch.dependencies ? [...patch.dependencies] : before.dependencies,
      blockers: patch.blockers ? [...patch.blockers] : before.blockers,
      artifactRefs: patch.artifactRefs ? [...patch.artifactRefs] : before.artifactRefs,
      position: before.position,
    });

    await updateTaskRow(client, taskId, sessionId, merged);
    const plan = await currentPlan(client, sessionId);
    await client.query("COMMIT");
    return { plan, created: [], updated: [taskId], dropped: [] };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Die Zeilen aus `kuronami.tasks`, wie der Lauf sie hinterlassen hat. Reiner Snapshot-Blick. */
export async function readPlanSnapshot(pool: Pool, sessionId: string): Promise<TaskState[]> {
  const rows = await pool.query<TaskRow>(SELECT_PLAN_SQL, [sessionId]);
  return rows.rows.map(toTaskState).sort(compareTasks);
}

function requireString(payload: Record<string, unknown>, field: string, type: string): string {
  const value = payload[field];
  if (typeof value !== "string") {
    throw new Error(
      `Ereignis ${type} ohne verwertbares Feld "${field}": ${JSON.stringify(payload)}. Der Plan ist aus diesem Protokoll nicht herleitbar.`,
    );
  }
  return value;
}

function requireStringArray(payload: Record<string, unknown>, field: string): string[] {
  const value = payload[field];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Ereignis task.* mit unbrauchbarem "${field}": ${JSON.stringify(value)}`);
  }
  return [...value] as string[];
}

function requireStatus(payload: Record<string, unknown>): TaskStatus {
  const value = payload.status;
  assertTaskStatus(value);
  return value;
}

function requirePosition(payload: Record<string, unknown>): number {
  const value = payload.position;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`Ereignis task.* mit unbrauchbarer "position": ${JSON.stringify(value)}`);
  }
  return value;
}

/** Die veränderlichen Felder aus einem `task.created`/`task.updated`-Payload. */
function fieldsFromPayload(payload: Record<string, unknown>, type: string): TaskFields {
  return {
    title: requireString(payload, "title", type),
    status: requireStatus(payload),
    owner: requireString(payload, "owner", type),
    dependencies: requireStringArray(payload, "dependencies"),
    blockers: requireStringArray(payload, "blockers"),
    artifactRefs: requireStringArray(payload, "artifact_refs"),
    position: requirePosition(payload),
  };
}

/**
 * Faltet die `task.*`-Ereignisse zum Plan. Nimmt Ereignisse entgegen und sonst nichts —
 * dieselbe Eigenschaft der Signatur wie `deriveSessionState` (S05): kein Seiteneffekt kann
 * hereinkommen. Ein `task.updated` ohne vorheriges `task.created` wirft; dann ist der Plan
 * aus dem Protokoll nicht herleitbar.
 */
export function derivePlan(sessionId: string, events: EventRecord[]): TaskState[] {
  const tasks = new Map<string, TaskState>();

  for (const event of events) {
    if (event.type === "task.created") {
      const taskId = requireString(event.payload, "task_id", event.type);
      tasks.set(taskId, {
        taskId,
        sessionId,
        ...fieldsFromPayload(event.payload, event.type),
        // Zeile und Ereignis entstehen in derselben Transaktion; `now()` ist die
        // Transaktionszeit, also ist `event.createdAt` buchstäblich `created_at` der Zeile.
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
      });
      continue;
    }

    if (event.type === "task.updated") {
      const taskId = requireString(event.payload, "task_id", event.type);
      if (event.payload.dropped === true) {
        tasks.delete(taskId);
        continue;
      }
      const current = tasks.get(taskId);
      if (!current) {
        throw new Error(
          `Ereignis task.updated (seq ${event.seq}) verweist auf Aufgabe ${taskId}, zu der kein task.created im Protokoll steht`,
        );
      }
      tasks.set(taskId, {
        ...current,
        ...fieldsFromPayload(event.payload, event.type),
        updatedAt: event.createdAt,
      });
    }
  }

  return [...tasks.values()].sort(compareTasks);
}

/** Baut den Plan allein aus dem Protokoll neu auf. Kein Seiteneffekt läuft dabei. */
export async function replayPlan(pool: Pool, sessionId: string): Promise<TaskState[]> {
  return derivePlan(sessionId, await readEvents(pool, sessionId));
}
