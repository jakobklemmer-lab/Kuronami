import type { Pool } from "pg";
import { type EventPayload, type EventRecord, readEvents } from "../events/log.js";
import {
  type JsonValue,
  STEP_COLUMNS,
  type StepKind,
  type StepRow,
  type StepState,
  compareSteps,
  toStepState,
} from "../steps/types.js";

/**
 * Der Lebenslauf einer Session. Bewusst ohne Spalte in `kuronami.sessions`: Abschnitt 4.4
 * sagt, der Snapshot ist abgeleitet und das Protokoll ist die Wahrheit. Für den Zustand
 * der Session ist das hier wörtlich gemeint — es gibt nur die Herleitung.
 */
export type SessionStatus = "running" | "completed" | "failed" | "canceled";

export interface SessionState {
  sessionId: string;
  status: SessionStatus;
  steps: StepState[];
}

function requireString(payload: EventPayload, field: string, type: string): string {
  const value = payload[field];
  if (typeof value !== "string") {
    throw new Error(
      `Ereignis ${type} ohne verwertbares Feld "${field}": ${JSON.stringify(payload)}. Der Zustand ist aus diesem Protokoll nicht herleitbar.`,
    );
  }
  return value;
}

/**
 * Faltet das Protokoll zum Zustand. Nimmt Ereignisse entgegen und sonst nichts: es gibt
 * keinen Parameter, über den ein Seiteneffekt hereinkäme, und keinen Aufruf, der einen
 * auslöste. Dass ein Replay nichts nach draußen tut, ist deshalb keine Zusage der
 * Sorgfalt, sondern eine Eigenschaft der Signatur.
 */
export function deriveSessionState(sessionId: string, events: EventRecord[]): SessionState {
  let status: SessionStatus = "running";
  const steps = new Map<string, StepState>();

  function step(event: EventRecord): StepState {
    const stepId = requireString(event.payload, "step_id", event.type);
    const found = steps.get(stepId);
    if (!found) {
      throw new Error(
        `Ereignis ${event.type} (seq ${event.seq}) verweist auf Schritt ${stepId}, zu dem kein step.started im Protokoll steht`,
      );
    }
    return found;
  }

  for (const event of events) {
    switch (event.type) {
      case "session.created":
      case "session.resumed":
        status = "running";
        break;
      case "session.completed":
        status = "completed";
        break;
      case "session.failed":
        status = "failed";
        break;
      case "session.canceled":
        status = "canceled";
        break;

      case "step.started": {
        const stepId = requireString(event.payload, "step_id", event.type);
        const existing = steps.get(stepId);
        // Ein zweiter Versuch setzt Ergebnis, Fehler und Ende zurück, genau wie
        // RETRY_STEP_SQL in der Hülle. Der vorige Versuch gilt nicht mehr.
        steps.set(stepId, {
          stepId,
          sessionId,
          idempotencyKey: requireString(event.payload, "idempotency_key", event.type),
          kind: event.payload.kind as StepKind,
          toolName: (event.payload.tool_name as string | null) ?? null,
          status: "running",
          attempt: event.payload.attempt as number,
          repeatable: event.payload.repeatable === true,
          result: null,
          error: null,
          artifactRefs: [],
          // Der erste Start legt die Zeile an; ihr created_at ist der Zeitstempel derselben
          // Transaktion und damit exakt dieser Zeitstempel.
          createdAt: existing?.createdAt ?? event.createdAt,
          startedAt: event.createdAt,
          endedAt: null,
        });
        break;
      }

      case "step.completed": {
        const current = step(event);
        steps.set(current.stepId, {
          ...current,
          status: "completed",
          result: (event.payload.result as JsonValue | undefined) ?? null,
          error: null,
          // S06 füllt artifact_refs. Kommen sie dann nicht ins Ereignis, laufen Snapshot
          // und Herleitung auseinander, und der Replay-Test hier schlägt fehl.
          artifactRefs: (event.payload.artifact_refs as string[] | undefined) ?? [],
          endedAt: event.createdAt,
        });
        break;
      }

      case "step.failed": {
        const current = step(event);
        steps.set(current.stepId, {
          ...current,
          status: "failed",
          result: null,
          error: (event.payload.error as string | null) ?? null,
          endedAt: event.createdAt,
        });
        break;
      }

      case "step.canceled": {
        const current = step(event);
        steps.set(current.stepId, {
          ...current,
          status: "canceled",
          error: (event.payload.error as string | null) ?? null,
          endedAt: event.createdAt,
        });
        break;
      }

      // Alles Übrige — runtime.*, turn.*, model.*, tool.*, policy.*, approval.* — sagt
      // nichts über Schritte oder Sessionzustand. Ein unbekannter Typ ist hier kein
      // Fehler: die Taxonomie wächst, die Herleitung muss das aushalten.
      default:
        break;
    }
  }

  return { sessionId, status, steps: [...steps.values()].sort(compareSteps) };
}

/**
 * Baut den Zustand allein aus dem Protokoll neu auf. Kein Seiteneffekt läuft dabei, weil
 * keiner laufen kann: die Funktion liest Ereignisse und faltet sie.
 */
export async function replaySession(pool: Pool, sessionId: string): Promise<SessionState> {
  await assertSessionExists(pool, sessionId);
  return deriveSessionState(sessionId, await readEvents(pool, sessionId));
}

/** Die Schritt-Zeilen, wie der Lauf sie hinterlassen hat. Reiner Blick in den Snapshot. */
export async function readStepSnapshot(pool: Pool, sessionId: string): Promise<StepState[]> {
  const result = await pool.query<StepRow>(
    `SELECT ${STEP_COLUMNS} FROM kuronami.steps WHERE session_id = $1`,
    [sessionId],
  );
  return result.rows.map(toStepState).sort(compareSteps);
}

/**
 * Der Zustand, wie ihn der Lauf hinterlassen hat: Schritte aus `kuronami.steps`.
 *
 * `status` kommt auch hier aus dem Protokoll, weil `kuronami.sessions` dafür keine Spalte
 * hat (Abschnitt 5 sieht keine vor). Die Aussage "Replay ergibt denselben Endzustand"
 * trägt deshalb bei den Schritten ihr ganzes Gewicht — dort stehen zwei unabhängige Wege
 * nebeneinander, hier nur einer.
 */
export async function readSessionState(pool: Pool, sessionId: string): Promise<SessionState> {
  await assertSessionExists(pool, sessionId);
  const events = await readEvents(pool, sessionId);
  return {
    sessionId,
    status: deriveSessionState(sessionId, events).status,
    steps: await readStepSnapshot(pool, sessionId),
  };
}

async function assertSessionExists(pool: Pool, sessionId: string): Promise<void> {
  const found = await pool.query("SELECT 1 FROM kuronami.sessions WHERE session_id = $1", [
    sessionId,
  ]);
  if (found.rowCount === 0) throw new Error(`Session ${sessionId} existiert nicht`);
}
