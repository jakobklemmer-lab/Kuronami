import type { Pool } from "pg";
import { SYSTEM_PROMPT } from "../../context/system-prompt.js";
import { deriveLoopState } from "../../context/transcript.js";
import type { PolicyEngine } from "../../policy/engine.js";
import type { AgentProfile } from "../../runtime/agents/types.js";
import { appendEvent, readEvents } from "../../runtime/events/log.js";
import {
  type LoopDeps,
  type LoopOutcome,
  type LoopStop,
  runTurn,
} from "../../runtime/loop/loop.js";
import type { ModelClient } from "../../runtime/model/types.js";
import { cancelSession } from "../../runtime/session/lifecycle.js";
import { startRuntime } from "../../runtime/session/manager.js";
import { ToolRegistry } from "../registry.js";
import type { ToolCatalog } from "../types.js";
import { TokenBudgetExceededError, budgetedModel } from "./budget.js";
import { agentToolsHook } from "./policy.js";

/**
 * Ein Arbeiterlauf (S19) — das Orchestrator-Worker-Muster aus Abschnitt 14, so knapp wie es
 * geht.
 *
 * Die vier Sätze der Architektur, und wo jeder von ihnen im Code steht:
 *
 *   * **"Worker bekommen enge Aufträge und isolierte Kontexte."** Der Arbeiter bekommt eine
 *     **eigene Session** — und damit ein eigenes Ereignisprotokoll. Das ist die Isolierung,
 *     nicht bloß ihre Zusage: der Kontext einer Session *ist* die Faltung ihres Protokolls
 *     (`context/transcript.ts`), und der Arbeiter faltet ein Protokoll, in dem die Unterhaltung
 *     des Hauptagenten schlicht nicht vorkommt. Es gibt keinen Schalter, der sie hereinließe.
 *   * **"Worker liefern nur Endergebnis plus Artefakt-Referenzen zurück."** `WorkerRun` trägt
 *     genau das: Abschlusstext, Artefakt-Handles, Ausgang, Zahl der Aufrufe. Keine Historie,
 *     keine Zwischenschritte — wer sie sehen will, liest das Protokoll der Arbeitersession.
 *   * **"Worker teilen keine Gesprächshistorie."** Siehe oben: sie könnten sie gar nicht.
 *   * **"Keine rekursiven Subagenten, explizite Tool-Beschränkung pro Subagent."** Der Katalog
 *     des Arbeiters ist die Schnittmenge aus der Werkzeugliste seines Profils und dem Katalog,
 *     den der Aufrufer hereinreicht — und dieser Katalog enthält die `agent.*`-Tools nicht
 *     (`runtime/loop/api.ts` registriert sie erst danach). Rekursion ist damit keine Regel, die
 *     jemand einhält, sondern eine Form, die es nicht gibt.
 *
 * ## Warum hier `runTurn` steht und nicht `createRunner`
 *
 * `createRunner` (`runtime/loop/api.ts`) täte fast dasselbe — aber `api.ts` baut den Katalog
 * und registriert dabei genau die `agent.*`-Tools, die diese Datei bedienen. Ein Import von
 * hier nach dort wäre ein Kreis zwischen dem Katalogbau und einem seiner Tools. Also die Ebene
 * darunter: `startRuntime` (S04) und `runTurn` (S12), beide ohne Kenntnis eines Katalogs.
 */

/** Der Katalog dieses Prozesses kennt ein Werkzeug des Profils nicht. */
export class WorkerToolsUnavailableError extends Error {}

export interface WorkerDeps {
  pool: Pool;
  artifactRoot: string;
  /**
   * Der Katalog, aus dem die Werkzeuge des Arbeiters gezogen werden. **Ohne `agent.*`** — siehe
   * oben; wer hier einen Katalog mit `agent.delegate` hereinreicht, baut rekursive Subagenten.
   */
  catalog: ToolCatalog;
  policy: PolicyEngine;
  /** Das Modell dieses Arbeiters (Abschnitt 11: Modell pro Agent). */
  model: ModelClient;
  conventions: string;
  signal?: AbortSignal;
  /** Vorgabe: das Zeitfenster des Routers. */
  timeoutMs?: number;
}

export interface WorkerRequest {
  profile: AgentProfile;
  /** Der Auftrag, wörtlich. */
  task: string;
  /** Was der Auftraggeber ausdrücklich mitgibt. Der **einzige** Weg, wie Kontext hineinkommt. */
  context?: string;
  /** Stabil aus dem Aufruf abgeleitet, damit ein zweiter Anlauf dieselbe Session trifft. */
  threadId: string;
  /** `kuronami.sessions.mode` der Arbeitersession. Vorgabe `worker`. */
  sessionMode?: string;
}

/**
 * Wie ein Arbeiterlauf endet. Die fünf Ausgänge des Loops (S12) plus einen, den nur ein
 * Arbeiter kennt: `token_budget`. Er gehört bewusst **nicht** in `LoopStop` — der Loop kennt
 * keine Kosten und soll keine kennen (siehe `budget.ts`); die Grenze gehört dem Agenten.
 */
export type WorkerStop = LoopStop | "token_budget";

export interface WorkerRun {
  sessionId: string;
  stop: WorkerStop;
  reason: string;
  /** Der Abschlusstext des Arbeiters — das Ergebnis, das zurückgeht. */
  text: string;
  toolCalls: number;
  /** Alles, was der Arbeiter unterwegs abgelegt hat. Handles, keine Bytes. */
  artifactRefs: string[];
  /** Verbrauchte Token, wenn das Profil ein Budget trägt — sonst `null` (nicht gezählt). */
  tokensSpent: number | null;
}

/**
 * Wie viele Arbeiter dieser **Prozess** gleichzeitig laufen lässt (Abschnitt 14, "Obergrenze
 * für parallele Worker"). Über `AGENT_MAX_PARALLEL` verstellbar.
 *
 * Warum eine Zahl je Prozess und keine Spalte je Agent: die Grenze schützt nicht den Agenten,
 * sondern das, was sich alle teilen — Verbindungen zum Pool, Anfragen beim Anbieter, die
 * Rechnung am Monatsende (Abschnitt 11). Zwei Coder gleichzeitig sind dasselbe Problem wie ein
 * Coder und ein Visualizer, und eine Grenze je Agent ließe genau diesen Fall offen.
 *
 * Zwei ist der Startwert und kein Optimum: Abschnitt 14 beginnt mit "nicht mit vielen Agenten
 * anfangen", und das 15-fache Token-Aufkommen eines Multi-Agent-Systems entsteht durch
 * Fächerung. Wer mehr will, stellt es sichtbar in der Umgebung ein.
 *
 * **Prozesslokal**, wie die Serialisierung im Gateway (S16): zwei Prozesse wissen nichts
 * voneinander. Ein verteiltes Kontingent bräuchte eine Sperre in der Datenbank; heute läuft
 * ein Gateway und ein Heartbeat, und die Grenze gilt für jeden für sich.
 */
export const DEFAULT_MAX_PARALLEL_WORKERS = 2;

function maxParallelWorkers(): number {
  const raw = Number(process.env.AGENT_MAX_PARALLEL);
  return Number.isInteger(raw) && raw >= 1 ? raw : DEFAULT_MAX_PARALLEL_WORKERS;
}

let runningWorkers = 0;
const waiting: (() => void)[] = [];

/**
 * Holt einen Platz aus dem Kontingent und gibt die Funktion zurück, die ihn wieder freigibt.
 *
 * **Warten statt ablehnen.** Ein abgewiesener dritter Arbeiter wäre für das Modell ein
 * Fehlschlag, den es nicht beheben kann — es würde es sofort noch einmal versuchen und dabei
 * einen Modellaufruf verbrennen, oder die Aufgabe fallen lassen. Ein wartender Arbeiter wird
 * dagegen einfach etwas später fertig, und das ist genau das, was eine Obergrenze bedeuten
 * soll. Ein Aufruf, der zu lange wartet, läuft in das Zeitfenster der Ausführungshülle
 * (`agent.delegate` trägt seins selbst, S19) — die Grenze staut also, sie hängt nicht.
 */
async function acquireWorkerSlot(): Promise<() => void> {
  if (runningWorkers >= maxParallelWorkers()) {
    // Der Platz wird beim Freigeben **weitergereicht**, nicht neu gezählt (siehe unten) —
    // deshalb erhöht der Wartende den Zähler nicht selbst.
    await new Promise<void>((resolve) => {
      waiting.push(resolve);
    });
  } else {
    runningWorkers += 1;
  }

  let released = false;
  return () => {
    // Zweimal freigeben hieße, dem Kontingent einen Platz zu schenken, den es nie gab.
    if (released) return;
    released = true;
    const next = waiting.shift();
    // Übergeben statt herunter- und wieder hochzählen: zwischen dem Herunterzählen und dem
    // Weiterlaufen des Wartenden liegt ein Microtask, und ein dritter Aufrufer, der genau dort
    // ankommt, sähe einen freien Platz, den es nicht gibt.
    if (next) next();
    else runningWorkers -= 1;
  };
}

/** Der System-Prompt des Arbeiters: der gewohnte, plus seine Rolle. */
export function workerSystemPrompt(profile: AgentProfile): string {
  return [
    SYSTEM_PROMPT,
    "",
    `## Deine Rolle: ${profile.role} (${profile.name})`,
    "",
    profile.systemPrompt,
    "",
    "Du läufst als Subagent mit einem engen Auftrag. Niemand beantwortet dir eine Rückfrage;",
    "was du nicht selbst entscheiden kannst, schreibst du ins Ergebnis. Du kannst nicht",
    "weiterdelegieren. Am Ende antwortest du ohne Werkzeugaufruf mit dem Ergebnis — kurz, und",
    "mit den Artefakt-Handles, die dazugehören.",
  ].join("\n");
}

function workerInput(request: WorkerRequest): string {
  const lines = [`Auftrag: ${request.task.trim()}`];
  if (request.context?.trim()) {
    lines.push("", `Mitgegeben vom Auftraggeber: ${request.context.trim()}`);
  }
  return lines.join("\n");
}

/** Die Artefakte, die dieser Lauf hinterlassen hat — aus seinem eigenen Protokoll. */
function artifactRefsOf(events: { type: string; payload: Record<string, unknown> }[]): string[] {
  const refs = new Set<string>();
  for (const event of events) {
    if (event.type !== "tool.completed") continue;
    const value = event.payload.artifact_refs;
    if (!Array.isArray(value)) continue;
    for (const ref of value) if (typeof ref === "string") refs.add(ref);
  }
  return [...refs];
}

/**
 * Führt einen Arbeiterlauf aus und gibt sein Ergebnis zurück.
 *
 * Genau **ein** Zug: ein Auftrag, eine Antwort. Ein Arbeiter, der über mehrere Züge hinweg
 * weiterspricht, wäre kein Arbeiter mehr, sondern eine zweite Unterhaltung — und für die hält
 * der Hauptagent den Vertrag mit dem Nutzer (Abschnitt 14).
 */
export async function runWorker(deps: WorkerDeps, request: WorkerRequest): Promise<WorkerRun> {
  // Die Obergrenze für parallele Arbeiter (S20) liegt **vor** allem anderen: sie soll greifen,
  // bevor eine Session entsteht und bevor ein Modell gefragt wird.
  const slot = await acquireWorkerSlot();
  try {
    return await runWorkerInSlot(deps, request);
  } finally {
    slot();
  }
}

async function runWorkerInSlot(deps: WorkerDeps, request: WorkerRequest): Promise<WorkerRun> {
  const profile = request.profile;

  const missing = profile.tools.filter((name) => !deps.catalog.get(name));
  if (missing.length > 0) {
    // Fail closed statt still kleiner: das Profil wurde gegen einen Katalog geprüft, der diese
    // Werkzeuge hatte. Ein Arbeiter, dem die Hälfte fehlt, läuft trotzdem los und meldet
    // hinterher ein Ergebnis, das niemand als unvollständig erkennt.
    throw new WorkerToolsUnavailableError(
      `Der Katalog dieses Prozesses (${deps.catalog.version}) kennt ${missing.length} Werkzeug(e) aus dem Profil "${profile.name}" nicht: ${missing.join(", ")}.`,
    );
  }

  const workerCatalog = new ToolRegistry()
    .registerAll(deps.catalog.tools.filter((tool) => profile.tools.includes(tool.name)))
    .freeze();

  const runtime = await startRuntime(deps.pool, {
    threadId: request.threadId,
    channel: "agent",
    defaults: {
      mode: request.sessionMode ?? "worker",
      modelProfile: profile.model,
      toolCatalogVersion: workerCatalog.version,
    },
  });
  const sessionId = runtime.session.sessionId;

  // Zwei Gründe, warum ein Lauf enden kann: der Arbeiter ist fertig, oder der Auftraggeber
  // hört auf. Beide Signale gelten, keins ersetzt das andere.
  const signal = deps.signal ? AbortSignal.any([deps.signal, runtime.signal]) : runtime.signal;

  // Das Token-Budget (S20) sitzt als Hülle um den Modell-Client — an der Stelle, an der Token
  // entstehen. Ohne Budget bleibt der Client unverändert: keine Zählung, keine Grenze.
  const budgeted =
    profile.tokenBudget !== null ? budgetedModel(deps.model, profile.tokenBudget) : null;

  const loopDeps: LoopDeps = {
    pool: deps.pool,
    artifactRoot: deps.artifactRoot,
    catalog: workerCatalog,
    // Die Werkzeugliste als zweites, vom Katalog unabhängiges Tor (S20, `policy.ts`). Die
    // Engine bleibt dieselbe — es kommt Ebene 1 dazu, und Hooks können nur verschärfen.
    policy: deps.policy.withHooks([agentToolsHook(profile)]),
    model: budgeted ?? deps.model,
    conventions: deps.conventions,
    systemPrompt: workerSystemPrompt(profile),
    maxSteps: profile.maxSteps,
    timeoutMs: deps.timeoutMs,
    signal,
  };

  try {
    // Ein wiederaufgenommener Anlauf trifft dieselbe Session (der Faden ist stabil aus dem
    // Aufruf abgeleitet) und setzt den offenen Zug fort, statt einen zweiten zu eröffnen —
    // dieselbe Unterscheidung wie in `runTurn` selbst (S12).
    const openTurn = deriveLoopState(await readEvents(deps.pool, sessionId)).turnId;
    let outcome: LoopOutcome;
    try {
      outcome = await runTurn(
        loopDeps,
        runtime.session,
        openTurn ? {} : { input: workerInput(request) },
      );
    } catch (error) {
      if (!(error instanceof TokenBudgetExceededError)) throw error;
      // Das Budget ist aufgebraucht. Der Zug bleibt sonst offen stehen und niemand setzt ihn je
      // fort — also wird die Session abgebrochen, wie bei einer Freigabe ohne Gegenüber. Der
      // Grund steht im Protokoll und im Ergebnis, nicht nur im Log (AGENTS.md).
      await cancelSession(deps.pool, sessionId, `agent-worker: ${error.message}`).catch(() => {});
      return {
        sessionId,
        stop: "token_budget",
        reason: error.message,
        text: "",
        toolCalls: 0,
        artifactRefs: artifactRefsOf(await readEvents(deps.pool, sessionId)),
        tokensSpent: error.spent,
      };
    }

    if (outcome.stop === "awaiting_user") {
      // Kann vorkommen: ein Werkzeug des Profils braucht eine Freigabe, und im Lauf eines
      // Arbeiters ist niemand, der sie erteilt. Die Session wird abgebrochen, damit kein
      // offener Zug liegenbleibt, den nie jemand fortsetzt (wie im Heartbeat, S17).
      await cancelSession(
        deps.pool,
        sessionId,
        "agent-worker: keine Freigabe ohne Gegenüber",
      ).catch(() => {});
    } else {
      await appendEvent(
        deps.pool,
        sessionId,
        outcome.stop === "done" ? "session.completed" : "session.failed",
        { turn_id: outcome.turnId, stop: outcome.stop, reason: outcome.reason },
      );
    }

    return {
      sessionId,
      stop: outcome.stop,
      reason: outcome.reason,
      text: outcome.text,
      toolCalls: outcome.toolCalls,
      artifactRefs: artifactRefsOf(await readEvents(deps.pool, sessionId)),
      tokensSpent: budgeted?.spent() ?? null,
    };
  } finally {
    await runtime.stop("arbeiterlauf-fertig").catch(() => {});
  }
}
