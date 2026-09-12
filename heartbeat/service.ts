import type { Pool } from "pg";
import { readEvents } from "../runtime/events/log.js";
import { type CronExpr, nextFireAfter, previousFireAtOrBefore } from "../runtime/schedule/cron.js";
import { createOrResumeSession } from "../runtime/session/manager.js";
import { type ScheduledAgentRun, runScheduledAgents } from "./agents.js";
import {
  type HeartbeatDeps,
  type HeartbeatRunResult,
  type Notification,
  handleNotification,
  runDigest,
} from "./digest.js";

/**
 * Der Dienst um `digest.ts` herum: der **Zeitplan** und die Buchführungs-Session.
 *
 * `tick` ist die ganze Zeitplanlogik und bewusst so geschnitten, dass ein Test sie mit einer
 * gestellten Uhr aufrufen kann. `start()` verdrahtet nur ein `setInterval` darauf.
 *
 * **Kein Zustand im Speicher.** Ob der heutige Digest schon lief, steht im Protokoll der
 * Diarium-Session (jedes `heartbeat.ran`/`heartbeat.skipped` trägt seinen Zeitplan-Anlass im
 * Feld `fire`). Ein Neustart um 09:00 sieht dort, dass der 07:00-Digest noch fehlt, und holt
 * ihn nach — solange er nicht mehr als `MAX_LATENESS_MS` her ist.
 */

/** Ein verpasster Digest, der länger als das zurückliegt, wird nicht mehr nachgeholt. */
export const MAX_LATENESS_MS = 6 * 60 * 60 * 1000;

/** Der Faden der Diarium-Session. Fest — hier zählt der Dienst seine Läufe pro Tag. */
export const HEARTBEAT_DIARY_THREAD = "thread_heartbeat";

export interface HeartbeatServiceDeps extends Omit<HeartbeatDeps, "diarySessionId"> {
  digestCron: CronExpr;
  /** Wie oft `tick` von selbst läuft. */
  pollMs: number;
  /** Der Faden der Diarium-Session. Vorgabe `HEARTBEAT_DIARY_THREAD`; Tests stellen einen eigenen. */
  diaryThread?: string;
}

export interface Heartbeat {
  readonly diarySessionId: string;
  /**
   * Prüft, was fällig ist, und stößt es an — erst den Digest, dann die Agenten mit Zeitplan
   * (S19). Idempotent je Zeitplan-Anlass, für beide.
   *
   * Die Reihenfolge ist nicht beliebig: der Morgen-Digest ist die Aussage, mit der der Tag
   * beginnt; fiele er wegen der Tagesobergrenze aus, weil zuvor drei Agenten liefen, wäre die
   * Obergrenze an der falschen Stelle wirksam geworden.
   */
  tick(now?: Date): Promise<void>;
  /** Die fälligen Agenten eines Zeitpunkts, ohne den Digest. Für Tests und einen Handstoß. */
  tickAgents(now?: Date): Promise<ScheduledAgentRun[]>;
  /** Ein ereignisgesteuerter Lauf, serialisiert gegen `tick`. */
  notify(notification: Notification): Promise<HeartbeatRunResult>;
  start(): void;
  stop(): void;
  nextDigest(after?: Date): Date | null;
}

/** Legt die Diarium-Session an oder findet sie wieder. Einmal beim Start. */
export async function ensureDiarySession(
  pool: Pool,
  threadId: string = HEARTBEAT_DIARY_THREAD,
): Promise<string> {
  const { session } = await createOrResumeSession(pool, {
    threadId,
    channel: "heartbeat",
    defaults: { mode: "background" },
  });
  return session.sessionId;
}

export async function createHeartbeat(deps: HeartbeatServiceDeps): Promise<Heartbeat> {
  const diarySessionId = await ensureDiarySession(deps.pool, deps.diaryThread);
  const runDeps: HeartbeatDeps = { ...deps, diarySessionId };
  const now = () => deps.now?.() ?? new Date();

  // Serialisierung wie im Gateway: Digest und Meldung teilen die Tagesobergrenze, zwei
  // gleichzeitige Läufe würden die Zählung gegeneinander laufen lassen. Ein Fehler des einen
  // legt die Kette nicht still (`then(work, work)`).
  let tail: Promise<unknown> = Promise.resolve();
  function serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(work, work);
    tail = result.catch(() => undefined);
    return result;
  }

  async function digestDue(at: Date): Promise<Date | null> {
    const fire = previousFireAtOrBefore(deps.digestCron, at);
    if (!fire) return null;
    if (at.getTime() - fire.getTime() > MAX_LATENESS_MS) return null;

    const events = await readEvents(deps.pool, diarySessionId);
    const handled = events.some(
      (event) =>
        (event.type === "heartbeat.ran" || event.type === "heartbeat.skipped") &&
        (event.payload as { kind?: string }).kind === "digest" &&
        (event.payload as { fire?: string }).fire === fire.toISOString(),
    );
    return handled ? null : fire;
  }

  let timer: ReturnType<typeof setInterval> | undefined;

  return {
    diarySessionId,

    tick(at: Date = now()): Promise<void> {
      return serialize(async () => {
        const fire = await digestDue(at);
        if (fire) await runDigest(runDeps, { fire });
        await runScheduledAgents(runDeps, { at, maxLatenessMs: MAX_LATENESS_MS });
      });
    },

    tickAgents(at: Date = now()): Promise<ScheduledAgentRun[]> {
      return serialize(() => runScheduledAgents(runDeps, { at, maxLatenessMs: MAX_LATENESS_MS }));
    },

    notify(notification: Notification): Promise<HeartbeatRunResult> {
      return serialize(() => handleNotification(runDeps, notification));
    },

    start(): void {
      if (timer) return;
      timer = setInterval(() => {
        void this.tick().catch((error) => console.error("[heartbeat] tick:", error));
      }, deps.pollMs);
    },

    stop(): void {
      if (timer) clearInterval(timer);
      timer = undefined;
    },

    nextDigest(after: Date = now()): Date | null {
      return nextFireAfter(deps.digestCron, after);
    },
  };
}
