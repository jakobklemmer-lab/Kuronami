import { loadConventions } from "../context/system-prompt.js";
import { listAgents } from "../runtime/agents/store.js";
import type { AgentProfile } from "../runtime/agents/types.js";
import { appendEvent, readEvents } from "../runtime/events/log.js";
import { CronParseError, parseCron, previousFireAtOrBefore } from "../runtime/schedule/cron.js";
import { runWorker } from "../tools/agent/worker.js";
import { type HeartbeatDeps, SILENT_MARKER, overDailyCap } from "./digest.js";

/**
 * Agenten mit Zeitplan (S19) — die zweite Sorte Hintergrundlauf neben Digest und Meldung.
 *
 * ## Was "Registrierung beim Heartbeat-Dienst" hier heißt
 *
 * Nichts, was ein Prozess sich merken müsste. Ein Agent mit `schedule` **ist** registriert,
 * sobald seine Zeile in `kuronami.agents` steht; dieser Dienst liest bei jedem Tick nach, wer
 * fällig ist. Das ist dieselbe Haltung wie bei der Tagesobergrenze seit S17 ("Kein Zustand im
 * Speicher"): eine Anmeldeliste im Prozess ginge beim Neustart verloren, und ein Agent, den
 * der Nutzer angelegt und bestätigt hat, liefe danach stumm nie wieder — ohne dass irgendwo
 * etwas fehlte, woran man es sähe. Ein frisch angelegter Agent ist damit auch **sofort aktiv**
 * (das Fertig-Kriterium von S19), ohne dass jemand den Dienst neu startet.
 *
 * ## Dieselben Grenzen wie für jeden anderen Hintergrundlauf
 *
 *   * **Tagesobergrenze** (`overDailyCap`) — geteilt mit Digest und Meldung, nicht daneben:
 *     Cron-Agenten sind der eigentliche Kostentreiber (Abschnitt 11).
 *   * **Ein Anlass, ein Lauf** — gezählt wird gegen das Protokoll der Diarium-Session, wie beim
 *     Digest. Drei Ticks in derselben Minute ergeben einen Lauf; ein Neustart holt einen
 *     verpassten Anlass nach, solange er nicht zu lange her ist.
 *   * **Der Hintergrundkatalog** — der Arbeiter bekommt die Schnittmenge aus seinem Profil und
 *     dem, was dieser Prozess überhaupt hat (`profile: "background"`, S17). Ein Agent, dessen
 *     Werkzeuge dort fehlen, läuft **nicht** halb, sondern gar nicht (`runWorker` wirft) — und
 *     der Fehlschlag steht im Diarium.
 *   * **Stille ist der Normalfall** — wie beim ereignisgesteuerten Lauf: nur melden, wenn es
 *     etwas zu melden gibt.
 */

export interface ScheduledAgentRun {
  agent: string;
  status: "delivered" | "silent" | "skipped" | "failed";
  reason: string;
  /** Die Session des Arbeiterlaufs, sofern einer stattfand. */
  runSessionId?: string;
  fire?: Date;
}

export interface ScheduledAgentOptions {
  /** Der Zeitpunkt, für den geprüft wird. */
  at: Date;
  /** Wie weit ein verpasster Anlass nachgeholt wird (`MAX_LATENESS_MS` aus `service.ts`). */
  maxLatenessMs: number;
  signal?: AbortSignal;
}

/** Der Auftragstext eines fälligen Laufs. Der Agent weiß aus seinem Profil, was er tun soll. */
export function scheduledTask(profile: AgentProfile, fire: Date): string {
  return [
    `Es ist ${fire.toISOString()}, dein Zeitplan ("${profile.schedule}") ist fällig.`,
    "",
    `Dein Auftrag: ${profile.purpose}`,
    "",
    "Du läufst im Hintergrund, ohne Nutzer am anderen Ende: niemand beantwortet Rückfragen.",
    "",
    `- Gibt es nichts Meldenswertes, antworte mit genau dem einen Wort ${SILENT_MARKER} und sonst nichts.`,
    "- Sonst antworte mit ein bis drei Sätzen: was ist los, was ist zu tun.",
  ].join("\n");
}

/** Lief dieser Anlass für diesen Agenten schon? Gefaltet aus dem Diarium, nicht aus dem Speicher. */
async function alreadyHandled(deps: HeartbeatDeps, agent: string, fire: Date): Promise<boolean> {
  const events = await readEvents(deps.pool, deps.diarySessionId);
  const fireIso = fire.toISOString();
  return events.some((event) => {
    if (event.type !== "heartbeat.ran" && event.type !== "heartbeat.skipped") return false;
    const payload = event.payload as { kind?: string; agent?: string; fire?: string };
    return payload.kind === "agent" && payload.agent === agent && payload.fire === fireIso;
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Die Konventionen für Arbeitersessions, einmal gelesen und dann gehalten — wie in
 * `createRunner` (S12) und in `tools/agent/tools.ts`. Ein Prozess, der AGENTS.md bei jedem
 * fälligen Lauf neu läse, bräche den Cache-Präfix seiner Arbeiter, sobald jemand die Datei
 * bearbeitet.
 */
let conventionsPromise: Promise<string> | undefined;
function cachedConventions(): Promise<string> {
  conventionsPromise ??= loadConventions();
  return conventionsPromise;
}

/**
 * Prüft alle aktiven Agenten mit Zeitplan und lässt die fälligen laufen.
 *
 * Ein Agent, der wirft, reißt die übrigen nicht mit: jeder Lauf steht für sich, und ein
 * kaputter Cron-Ausdruck oder ein fehlendes Werkzeug ist eine Auskunft über **diesen** Agenten
 * (dieselbe Haltung wie bei den Szenarien der Eval-Suite, S18f).
 */
export async function runScheduledAgents(
  deps: HeartbeatDeps,
  options: ScheduledAgentOptions,
): Promise<ScheduledAgentRun[]> {
  const agents = await listAgents(deps.pool, { status: "active", scheduledOnly: true });
  const runs: ScheduledAgentRun[] = [];

  for (const profile of agents) {
    try {
      runs.push(await runOne(deps, profile, options));
    } catch (error) {
      const reason = describeError(error);
      await appendEvent(deps.pool, deps.diarySessionId, "heartbeat.ran", {
        kind: "agent",
        agent: profile.name,
        ok: false,
        delivered: false,
        reason,
      });
      runs.push({ agent: profile.name, status: "failed", reason });
    }
  }

  return runs.filter((run) => run.status !== "skipped" || run.reason !== "nicht fällig");
}

async function runOne(
  deps: HeartbeatDeps,
  profile: AgentProfile,
  options: ScheduledAgentOptions,
): Promise<ScheduledAgentRun> {
  const schedule = profile.schedule;
  if (!schedule) return { agent: profile.name, status: "skipped", reason: "nicht fällig" };

  let fire: Date | null;
  try {
    fire = previousFireAtOrBefore(parseCron(schedule), options.at);
  } catch (error) {
    if (!(error instanceof CronParseError)) throw error;
    // `agent.create` prüft den Ausdruck beim Anlegen; hierher kommt nur, was von Hand in die
    // Tabelle geschrieben wurde. Es bleibt sichtbar, statt stumm nie zu feuern.
    const reason = `Zeitplan "${schedule}" ist kein gültiger Cron-Ausdruck: ${error.message}`;
    await appendEvent(deps.pool, deps.diarySessionId, "heartbeat.skipped", {
      kind: "agent",
      agent: profile.name,
      reason: "cron_invalid",
      detail: reason,
    });
    return { agent: profile.name, status: "skipped", reason };
  }

  if (!fire) return { agent: profile.name, status: "skipped", reason: "nicht fällig" };
  if (options.at.getTime() - fire.getTime() > options.maxLatenessMs) {
    return { agent: profile.name, status: "skipped", reason: "Anlass zu lange her" };
  }
  if (await alreadyHandled(deps, profile.name, fire)) {
    return { agent: profile.name, status: "skipped", reason: "nicht fällig" };
  }

  const fireIso = fire.toISOString();
  if (await overDailyCap(deps, options.at, { kind: "agent", agent: profile.name, fire: fireIso })) {
    return {
      agent: profile.name,
      status: "skipped",
      reason: `Tagesobergrenze ${deps.maxRunsPerDay} erreicht.`,
      fire,
    };
  }

  const model = deps.modelFor?.(profile.model) ?? deps.model;
  const run = await runWorker(
    {
      pool: deps.pool,
      artifactRoot: deps.artifactRoot,
      catalog: deps.catalog,
      policy: deps.policy,
      model,
      conventions: deps.conventions ?? (await cachedConventions()),
      signal: options.signal,
    },
    {
      profile,
      task: scheduledTask(profile, fire),
      // Der Anlass steht im Faden: derselbe fällige Zeitpunkt trifft dieselbe Session, auch
      // wenn zwei Ticks sich überholen.
      threadId: `thread_agent_${profile.name}_${fireIso}`,
      sessionMode: "background",
    },
  );

  if (run.stop !== "done") {
    await appendEvent(deps.pool, deps.diarySessionId, "heartbeat.ran", {
      kind: "agent",
      agent: profile.name,
      fire: fireIso,
      run_session: run.sessionId,
      ok: false,
      delivered: false,
      stop: run.stop,
      reason: run.reason,
    });
    // Anders als beim Morgen-Digest geht **keine** Fehlermeldung hinaus: ein Agent, der alle
    // zwanzig Minuten fällig ist, schickte sonst alle zwanzig Minuten dieselbe Panne. Der
    // Fehlschlag steht im Diarium, wo ein Betreiber ihn findet (AGENTS.md: nicht verstecken —
    // aber auch nicht in den Zustellkanal spülen).
    return {
      agent: profile.name,
      status: "failed",
      reason: run.reason,
      runSessionId: run.sessionId,
      fire,
    };
  }

  const text = run.text.trim();
  if (text.length === 0 || text.toUpperCase().startsWith(SILENT_MARKER)) {
    await appendEvent(deps.pool, deps.diarySessionId, "heartbeat.silent", {
      kind: "agent",
      agent: profile.name,
      fire: fireIso,
      run_session: run.sessionId,
    });
    await appendEvent(deps.pool, deps.diarySessionId, "heartbeat.ran", {
      kind: "agent",
      agent: profile.name,
      fire: fireIso,
      run_session: run.sessionId,
      ok: true,
      delivered: false,
      model: model.model,
      model_from_profile: model.model === profile.model,
      tool_calls: run.toolCalls,
    });
    return { agent: profile.name, status: "silent", reason: "Nichts Meldenswertes.", fire };
  }

  let delivered = true;
  try {
    await deps.channel.deliver(`[${profile.name}] ${text}`);
  } catch (error) {
    delivered = false;
    await appendEvent(deps.pool, deps.diarySessionId, "error.raised", {
      where: "heartbeat.agent.deliver",
      agent: profile.name,
      error: describeError(error),
    });
  }

  if (delivered) {
    await appendEvent(deps.pool, deps.diarySessionId, "heartbeat.delivered", {
      kind: "agent",
      agent: profile.name,
      channel: deps.channel.id,
      run_session: run.sessionId,
    });
  }

  await appendEvent(deps.pool, deps.diarySessionId, "heartbeat.ran", {
    kind: "agent",
    agent: profile.name,
    fire: fireIso,
    run_session: run.sessionId,
    ok: true,
    delivered,
    model: model.model,
    model_from_profile: model.model === profile.model,
    tool_calls: run.toolCalls,
    artifact_refs: run.artifactRefs,
  });

  return {
    agent: profile.name,
    status: delivered ? "delivered" : "failed",
    reason: delivered
      ? `Meldung zugestellt über ${deps.channel.id}.`
      : "Zustellung fehlgeschlagen.",
    runSessionId: run.sessionId,
    fire,
  };
}
