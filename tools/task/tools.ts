import type { Pool } from "pg";
import type { JsonValue } from "../../runtime/steps/types.js";
import { setPlan, updateTask } from "../../runtime/tasks/store.js";
import {
  type TaskPatch,
  type TaskSpec,
  type TaskState,
  taskToJson,
} from "../../runtime/tasks/types.js";
import type { ToolDefinition, ToolInvocation, ToolOutput } from "../types.js";

/**
 * `task.set` und `task.update` (Abschnitt 9). Der Plan ist das Kurzzeitgedächtnis der
 * Session (Abschnitt 8): er lebt in `kuronami.tasks` und im Ereignisprotokoll
 * (`task.created`/`task.updated`), Faltung und Snapshot müssen übereinstimmen (S05). Die
 * Logik steckt in `runtime/tasks/store.ts`; diese Datei ist der dünne Tool-Mantel.
 *
 * Beide sind `execution: "runtime"` — kein externer Seiteneffekt, also kein Schritt und
 * keine Ausführungshülle. Der Router prüft trotzdem Katalog und Schema und schreibt
 * `tool.requested`/`tool.completed`.
 *
 * `task.set` schreibt den **kompletten** Plan neu, es hängt nicht an: Aufgaben, die in der
 * Liste fehlen, verlassen den Plan. Jede Aufgabe braucht eine vom Aufrufer stabil gewählte
 * `id`, damit `task.update` sie nach einem Neustart wiedertrifft.
 */

/** Ein Feld in der Eingabe passt nicht (falscher Typ, unbekannter Schlüssel, leere Liste). */
export class TaskToolInputError extends Error {}

const TASK_KEYS = new Set([
  "id",
  "title",
  "status",
  "owner",
  "dependencies",
  "blockers",
  "artifact_refs",
]);

function asRecord(value: JsonValue, where: string): Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TaskToolInputError(`${where} muss ein Objekt sein, war ${describe(value)}`);
  }
  return value;
}

function asString(value: JsonValue | undefined, where: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TaskToolInputError(`${where} muss eine nicht leere Zeichenkette sein`);
  }
  return value;
}

function asStringArray(value: JsonValue | undefined, where: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new TaskToolInputError(`${where} muss eine Liste von Zeichenketten sein`);
  }
  return value as string[];
}

function describe(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Wandelt ein rohes Aufgabenobjekt aus `task.set` in einen `TaskSpec`. Unbekannte Schlüssel fliegen. */
function toSpec(raw: JsonValue, index: number): TaskSpec {
  const obj = asRecord(raw, `tasks[${index}]`);
  for (const key of Object.keys(obj)) {
    if (!TASK_KEYS.has(key)) {
      throw new TaskToolInputError(
        `tasks[${index}]: unbekanntes Feld "${key}" (erlaubt: ${[...TASK_KEYS].join(", ")})`,
      );
    }
  }
  return {
    id: asString(obj.id, `tasks[${index}].id`),
    title: asString(obj.title, `tasks[${index}].title`),
    // status prüft `setPlan` gegen das Enum — hier nur die grobe Form.
    status:
      obj.status === undefined
        ? undefined
        : (asString(obj.status, `tasks[${index}].status`) as TaskSpec["status"]),
    owner: obj.owner === undefined ? undefined : asString(obj.owner, `tasks[${index}].owner`),
    dependencies: asStringArray(obj.dependencies, `tasks[${index}].dependencies`),
    blockers: asStringArray(obj.blockers, `tasks[${index}].blockers`),
    artifactRefs: asStringArray(obj.artifact_refs, `tasks[${index}].artifact_refs`),
  };
}

function planOutput(
  verb: string,
  plan: TaskState[],
  change: { created: string[]; updated: string[]; dropped: string[] },
): ToolOutput {
  const parts = [
    `${change.created.length} neu`,
    `${change.updated.length} geändert`,
    `${change.dropped.length} entfernt`,
  ];
  return {
    summary: `${verb}: ${plan.length} Aufgabe(n) im Plan (${parts.join(", ")})`,
    structured: {
      plan: plan.map(taskToJson),
      created: change.created,
      updated: change.updated,
      dropped: change.dropped,
    },
    preview: plan
      .slice(0, 12)
      .map((task) => `${task.position + 1}. [${task.status}] ${task.title}`),
  };
}

async function setHandler(pool: Pool, inv: ToolInvocation): Promise<ToolOutput> {
  const raw = inv.input.tasks;
  if (!Array.isArray(raw)) {
    throw new TaskToolInputError("tasks muss eine Liste sein");
  }
  const specs = raw.map((entry, index) => toSpec(entry, index));
  const change = await setPlan(pool, inv.sessionId, specs);
  return planOutput("Plan neu gesetzt", change.plan, change);
}

async function updateHandler(pool: Pool, inv: ToolInvocation): Promise<ToolOutput> {
  const taskId = asString(inv.input.task_id, "task_id");
  const patch: TaskPatch = {};
  if (inv.input.status !== undefined) {
    patch.status = asString(inv.input.status, "status") as TaskPatch["status"];
  }
  if (inv.input.title !== undefined) patch.title = asString(inv.input.title, "title");
  if (inv.input.owner !== undefined) patch.owner = asString(inv.input.owner, "owner");
  const dependencies = asStringArray(inv.input.dependencies, "dependencies");
  if (dependencies !== undefined) patch.dependencies = dependencies;
  const blockers = asStringArray(inv.input.blockers, "blockers");
  if (blockers !== undefined) patch.blockers = blockers;
  const artifactRefs = asStringArray(inv.input.artifact_refs, "artifact_refs");
  if (artifactRefs !== undefined) patch.artifactRefs = artifactRefs;

  const change = await updateTask(pool, inv.sessionId, taskId, patch);
  return planOutput(`Aufgabe "${taskId}" geändert`, change.plan, change);
}

export interface TaskToolDeps {
  pool: Pool;
}

/**
 * Baut die zwei `task.*`-Definitionen mit dem Pool in den Handlern geschlossen —
 * Muster von `createFsTools`/`createWebTools`.
 */
export function createTaskTools(deps: TaskToolDeps): ToolDefinition[] {
  return [
    {
      name: "task.set",
      description:
        "Schreibt den kompletten Aufgabenplan der Session neu (kein Anhängen: Aufgaben, die fehlen, verlassen den Plan). Jede Aufgabe braucht eine stabile id. status muss einer von queued, ready, in_progress, blocked, awaiting_user, done, canceled, failed sein.",
      risk: "soft_write",
      repeatable: true,
      execution: "runtime",
      inputSchema: {
        fields: {
          tasks: {
            type: "array",
            required: true,
            description:
              "Liste von { id, title, status?, owner?, dependencies?, blockers?, artifact_refs? }. Die Reihenfolge ist die Planreihenfolge.",
          },
        },
      },
      handler: (inv) => setHandler(deps.pool, inv),
    },
    {
      name: "task.update",
      description:
        "Ändert Status, Blocker, Artefakt-Refs, Abhängigkeiten, Titel oder Owner einer einzelnen Aufgabe. status muss einer der acht Enum-Werte sein.",
      risk: "soft_write",
      repeatable: true,
      execution: "runtime",
      inputSchema: {
        fields: {
          task_id: { type: "string", required: true, description: "id der Aufgabe aus task.set." },
          status: {
            type: "string",
            required: false,
            description:
              "Neuer Status: queued, ready, in_progress, blocked, awaiting_user, done, canceled oder failed.",
          },
          title: { type: "string", required: false, description: "Neuer Titel." },
          owner: { type: "string", required: false, description: "Neuer Owner." },
          dependencies: {
            type: "array",
            required: false,
            description: "Ersetzt die Abhängigkeitsliste (task_ids).",
          },
          blockers: {
            type: "array",
            required: false,
            description: "Ersetzt die Blockerliste (Kurztexte).",
          },
          artifact_refs: {
            type: "array",
            required: false,
            description: "Ersetzt die Artefakt-Referenzliste (artifact://-Handles).",
          },
        },
      },
      handler: (inv) => updateHandler(deps.pool, inv),
    },
  ];
}
