import type { Pool } from "pg";
import { type RunMetrics, combineRunMetrics, deriveRunMetrics } from "../../context/metrics.js";
import { headArtifact } from "../artifacts/store.js";
import type { ArtifactMeta } from "../artifacts/types.js";
import { type EventRecord, readEvents } from "../events/log.js";
import type { StepKind, StepStatus } from "../steps/types.js";
import { type RunStatus, deriveRunStatus } from "./run-status.js";
import { type PendingUserInput, deriveSessionState } from "./state.js";
import type { SessionChannel } from "./types.js";

/**
 * Die Runs-Ansicht (S22): Liste und Detail über die Sessions des Systems, gefaltet aus
 * demselben Protokoll wie `deriveSessionState`/`deriveRunStatus` — keine eigene Tabelle, kein
 * Zähler im Prozess. "Run" ist hier, was das Grundgerüst aus S21 schon so nennt (das
 * Läufe-Panel, `ui/index.html`): eine Session, nicht eine Aufgabe (`kuronami.tasks` hat ihr
 * eigenes, unabhängiges "Plan"-Panel).
 *
 * Liegt in `runtime/`, nicht in `gateway/`: Abschnitt 3 erlaubt Runtime → Context
 * (`deriveRunMetrics` kommt von dort, dasselbe Muster wie `runtime/devui/server.ts` mit
 * `deriveLoopState`), aber nie Runtime → Surface. `gateway/server.ts` ruft diese Datei auf,
 * nicht umgekehrt.
 */

export interface RunSummary {
  sessionId: string;
  threadId: string;
  channel: SessionChannel;
  createdAt: string;
  /** `null`, wenn sich diese eine Session nicht falten ließ (siehe `foldError`) — der Run
   * bleibt trotzdem in der Liste, statt die ganze Übersicht an ihm scheitern zu lassen. */
  status: RunStatus | null;
  stepCount: number;
  pendingUserInput: number;
  /** Der Fehlertext, wenn `status` deshalb `null` ist. AGENTS.md: Fehler nie verstecken —
   * dieses Feld ist der Grund, warum "verstecken" hier nicht "weglassen" heißt, sondern
   * "einer defekten Zeile zuordnen, statt die ganze Liste damit zu Fall zu bringen". */
  foldError: string | null;
}

export type RunStepArtifact = ArtifactMeta;

export interface RunStepView {
  stepId: string;
  kind: StepKind;
  toolName: string | null;
  status: StepStatus;
  attempt: number;
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
  artifacts: RunStepArtifact[];
}

export interface RunDetail {
  sessionId: string;
  threadId: string;
  channel: SessionChannel;
  createdAt: string;
  status: RunStatus;
  pendingUserInput: PendingUserInput[];
  steps: RunStepView[];
}

interface SessionRow {
  session_id: string;
  thread_id: string;
  channel: SessionChannel;
  created_at: Date;
}

/** Wie viele Runs die Liste höchstens zeigt — dieselbe Vorgabe wie `runtime/devui/server.ts`. */
const DEFAULT_RUN_LIMIT = 50;

async function resolveArtifacts(pool: Pool, uris: readonly string[]): Promise<ArtifactMeta[]> {
  return Promise.all(uris.map((uri) => headArtifact(pool, uri)));
}

/**
 * Alle Runs, neueste zuerst, mitsamt den über sie summierten Kennzahlen (Abschnitt 12,
 * `context/metrics.ts`) — in einem Durchgang berechnet, weil beide dieselben Ereignisse pro
 * Session lesen und ein zweiter Durchlauf eine zweite volle Protokoll-Lesung wäre.
 */
export async function listRuns(
  pool: Pool,
  limit = DEFAULT_RUN_LIMIT,
): Promise<{ runs: RunSummary[]; metrics: RunMetrics }> {
  const rows = await pool.query<SessionRow>(
    "SELECT session_id, thread_id, channel, created_at FROM kuronami.sessions ORDER BY created_at DESC LIMIT $1",
    [limit],
  );

  const runs: RunSummary[] = [];
  const perRunMetrics: RunMetrics[] = [];

  for (const row of rows.rows) {
    const events = await readEvents(pool, row.session_id);
    // Ein Durchgang über **alle** Sessions: eine einzelne mit einem Protokoll, das sich nicht
    // falten lässt (z. B. Altlast aus einem Vor-S05-Lauf), soll nicht die ganze Liste mit
    // hinunterreißen. `getRunDetail` unten lässt denselben Fehler dagegen offen durch — dort
    // hat der Aufrufer explizit nach genau dieser einen Session gefragt.
    try {
      const session = deriveSessionState(row.session_id, events);
      runs.push({
        sessionId: row.session_id,
        threadId: row.thread_id,
        channel: row.channel,
        createdAt: row.created_at.toISOString(),
        status: deriveRunStatus(events, session),
        stepCount: session.steps.length,
        pendingUserInput: session.pendingUserInput.length,
        foldError: null,
      });
      perRunMetrics.push(deriveRunMetrics(events));
    } catch (error) {
      runs.push({
        sessionId: row.session_id,
        threadId: row.thread_id,
        channel: row.channel,
        createdAt: row.created_at.toISOString(),
        status: null,
        stepCount: 0,
        pendingUserInput: 0,
        foldError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { runs, metrics: combineRunMetrics(perRunMetrics) };
}

/** Der Schritt-für-Schritt-Verlauf eines Runs samt aufgelöster Artefakte, oder `null`, wenn die
 * Session unbekannt ist. */
export async function getRunDetail(pool: Pool, sessionId: string): Promise<RunDetail | null> {
  const found = await pool.query<SessionRow>(
    "SELECT session_id, thread_id, channel, created_at FROM kuronami.sessions WHERE session_id = $1",
    [sessionId],
  );
  const row = found.rows[0];
  if (!row) return null;

  const events: EventRecord[] = await readEvents(pool, sessionId);
  const session = deriveSessionState(sessionId, events);

  const steps: RunStepView[] = await Promise.all(
    session.steps.map(async (step) => ({
      stepId: step.stepId,
      kind: step.kind,
      toolName: step.toolName,
      status: step.status,
      attempt: step.attempt,
      startedAt: step.startedAt ? step.startedAt.toISOString() : null,
      endedAt: step.endedAt ? step.endedAt.toISOString() : null,
      error: step.error,
      artifacts: await resolveArtifacts(pool, step.artifactRefs),
    })),
  );

  return {
    sessionId: row.session_id,
    threadId: row.thread_id,
    channel: row.channel,
    createdAt: row.created_at.toISOString(),
    status: deriveRunStatus(events, session),
    pendingUserInput: session.pendingUserInput,
    steps,
  };
}
