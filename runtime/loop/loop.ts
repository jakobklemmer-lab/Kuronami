import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  type CompactionConfig,
  compactHistory,
  estimateFixedOverheadTokens,
  resolveCompactionConfig,
} from "../../context/compaction.js";
import { type RunMetrics, deriveRunMetrics } from "../../context/metrics.js";
import {
  buildModelRequest,
  countCacheBreakpoints,
  deriveLoadedToolNames,
  toolNameDecoder,
} from "../../context/request.js";
import {
  type SectionConfig,
  maybeStartFreshSection,
  resolveSectionConfig,
} from "../../context/section.js";
import { SYSTEM_PROMPT } from "../../context/system-prompt.js";
import {
  type LoopState,
  type PendingToolCall,
  assertReplayable,
  assertSendable,
  deriveLoopState,
  renderTurnOpening,
} from "../../context/transcript.js";
import { ApprovalRequiredError } from "../../policy/approvals.js";
import type { PolicyEngine } from "../../policy/engine.js";
import { recallForTurn } from "../../tools/memory/recall.js";
import type { MemoryStore } from "../../tools/memory/store.js";
import { type ToolRouterDeps, callTool } from "../../tools/router.js";
import type { SkillCatalog } from "../../tools/skill/catalog.js";
import type { ToolCatalog } from "../../tools/types.js";
import { appendEvent, readEvents } from "../events/log.js";
import { DEFAULT_MAX_TOKENS } from "../model/anthropic.js";
import type { ModelClient } from "../model/types.js";
import { type PendingUserInput, deriveSessionState } from "../session/state.js";
import type { SessionRecord } from "../session/types.js";
import { UserInputRequiredError } from "../session/user-input.js";
import { SessionCanceledError } from "../steps/hull.js";
import { readPlanSnapshot } from "../tasks/store.js";

/**
 * Die Plan-Handeln-Prüfen-Schleife (S12) — der Meilenstein von Phase 1.
 *
 * Sie ist absichtlich klein, und ihre Größe ist die eigentliche Aussage: alles, was eine
 * Agentenschleife üblicherweise umfangreich macht, steht schon woanders. Die Idempotenz in
 * der Ausführungshülle (S05), die Auslagerung im Router (S07), die Freigaben in der Engine
 * (S11), der Kontext in der Faltung (`context/transcript.ts`). Was hier bleibt, ist die
 * Frage, **wann** gefragt, gehandelt und aufgehört wird.
 *
 * ## Der Zyklus
 *
 *   1. Zustand aus dem Protokoll falten.
 *   2. Abbrechen, wenn eine der vier Bedingungen greift.
 *   3. Stehen Aufrufe offen? Dann **die zuerst** — nicht das Modell fragen.
 *   4. Sonst das Modell fragen und seine Antwort protokollieren.
 *   5. Keine Aufrufe in der Antwort → fertig. Sonst ausführen und zurück zu 1.
 *
 * Schritt 3 vor Schritt 4 ist der Wiederaufnahmepunkt und keine Optimierung: nach einem
 * Absturz zwischen `model.responded` und dem Werkzeugaufruf stünde sonst eine zweite
 * Modellantwort in der Historie, während die erste `tool_use`-Blöcke ohne Ergebnis
 * hinterließe. Der Anbieter weist eine solche Historie ab, und zwar zu Recht.
 *
 * ## Die vier Abbruchbedingungen
 *
 *   * **fertig** — das Modell antwortet ohne Werkzeugaufruf.
 *   * **Freigabe nötig** — die Policy oder `user.ask` hält an. Der Zug wird **nicht**
 *     abgeschlossen; er bleibt offen, damit die Antwort ihn an derselben Stelle fortsetzt.
 *   * **Schrittobergrenze** — Abschnitt 13.
 *   * **Fehlerhäufung** — siehe `DEFAULT_MAX_CONSECUTIVE_ERRORS`.
 *
 * Nur die erste ist ein Erfolg. Die anderen drei enden ohne Ergebnis, und keine davon wird
 * als Erfolg protokolliert — ein Lauf, der an der Schrittobergrenze endet und `turn.completed`
 * ohne Grund schriebe, sähe im Protokoll aus wie einer, der fertig wurde.
 */

/** "Max. Schritte pro Turn: 50 bis 100" (Abschnitt 13), unteres Ende der Spanne. */
export const DEFAULT_MAX_STEPS = 50;

/**
 * Fehlerhäufung: so viele fehlgeschlagene Aufrufe **hintereinander** beenden den Zug.
 *
 * Gezählt wird in Folge und nicht insgesamt, und das ist der ganze Gehalt der Kennzahl. Ein
 * Lauf mit fünf Fehlschlägen auf dreißig Schritte arbeitet — er stößt an Grenzen und findet
 * Wege daran vorbei, und genau dafür bleiben Fehler im Kontext sichtbar (Abschnitt 7). Ein
 * Lauf mit fünf Fehlschlägen **nacheinander** lernt nichts aus ihnen; er wiederholt eine
 * Vorstellung, die nicht zutrifft, und jeder weitere Versuch kostet einen Modellaufruf für
 * dasselbe Ergebnis. Eine Gesamtzahl beendete stattdessen den erfolgreichen langen Lauf und
 * ließe den kurzen im Kreis laufen — also genau verkehrt herum.
 */
export const DEFAULT_MAX_CONSECUTIVE_ERRORS = 5;

export type LoopStop = "done" | "awaiting_user" | "step_limit" | "error_rate" | "canceled";

export interface LoopDeps {
  pool: Pool;
  artifactRoot: string;
  /** Eingefroren für die Dauer der Session (S07, Anti-Muster 2). */
  catalog: ToolCatalog;
  policy: PolicyEngine;
  model: ModelClient;
  /** Einmal beim Start gelesen, danach unverändert — sonst bricht der Cache-Präfix. */
  conventions: string;
  /**
   * Das Langzeitgedächtnis (S18). Ist es gesetzt, sucht der Loop **bei jedem Zugbeginn** nach
   * thematisch passenden Notizen und legt sie in die Eröffnungsnachricht — ohne dass das
   * Modell danach fragen müsste (siehe `tools/memory/recall.ts`). Optional, weil eine Session
   * ohne Gedächtnis laufen können muss: Tests, Probeläufe und jede Verdrahtung, die es nicht
   * konfiguriert hat.
   */
  memory?: MemoryStore;
  /**
   * Der Skill-Katalog (S18c) — einmal beim Sessionstart gescannt (`loadSkillCatalog`), wie
   * `conventions`. Ist er gesetzt, steht seine Kurzliste (Titel, Beschreibung, Auslösebedingung)
   * neben den Konventionen im Prompt; `skill.load` (falls im Tool-Katalog registriert) macht
   * die volle Anleitung eines Skills bei Bedarf nach.
   */
  skills?: SkillCatalog;
  /**
   * Textstücke des Modells, sobald sie entstehen (Streaming, 2026-09-16). Der Loop setzt sie
   * als `onTextDelta` an jede Modellanfrage und reicht Session und Zug dazu — wer zuhört
   * (der Gateway: als flüchtiges Bus-Ereignis `model.delta`), kann den ersten Satz zeigen oder
   * sprechen, während der Zug noch läuft. Nichts davon geht ins Protokoll: das Protokoll trägt
   * die ganze Antwort (`model.responded`), der Hook nur ihr Entstehen.
   */
  onTextDelta?: (delta: { sessionId: string; turnId: string; text: string }) => void;
  systemPrompt?: string;
  maxSteps?: number;
  maxConsecutiveErrors?: number;
  maxTokens?: number;
  offloadThresholdTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Kontextstufen 2 und 3 (S18a, `context/compaction.ts`). Schwellenwerte konfigurierbar mit
   * Vorgabe (`DEFAULT_COMPACTION_CONFIG`) — ein Test setzt hier ein kleines Fenster, um die
   * Kompaktierung ohne eine riesige Historie auszulösen.
   */
  compactionConfig?: Partial<CompactionConfig>;
  /**
   * Das günstige Modell für die Zusammenfassung in Stufe 3. Ohne Angabe fällt sie auf `model`
   * zurück (lauffähig, aber nicht kostenoptimiert) — siehe die Begründung in
   * `context/compaction.ts`.
   */
  compactionModel?: ModelClient;
  /**
   * Kontextstufe 4 (S18b, `context/section.ts`): Ruhepause, Aufgabenabschluss und der
   * Stufe-3-Fallback, mit Startwerten. Dieselbe Verdrahtung wie `compactionConfig` — pro Lauf
   * überschreibbar, ein Test setzt hier kleine Werte, um die Auslöser ohne 45 echte Minuten
   * oder drei echte Kompaktierungsrunden zu erreichen.
   */
  sectionConfig?: Partial<SectionConfig>;
}

export interface TurnRequest {
  /**
   * Die Eingabe eines neuen Zugs. Fehlt sie, wird der offene Zug fortgesetzt — das ist der
   * Fall nach einem Neustart und nach einer erteilten Freigabe.
   */
  input?: string;
}

export interface LoopOutcome {
  stop: LoopStop;
  turnId: string;
  /** Warum der Zug endete, in einem Satz. Steht so auch im `turn.completed`. */
  reason: string;
  /** Abgeschlossene Werkzeugaufrufe in diesem Zug. */
  toolCalls: number;
  /** Der letzte Text des Modells. Leer, wenn der Zug vorher abbrach. */
  text: string;
  metrics: RunMetrics;
  /** Bei `awaiting_user`: worauf gewartet wird. */
  pendingUserInput: PendingUserInput[];
}

/** Es gibt keinen offenen Zug und keine Eingabe, mit der einer beginnen könnte. */
export class NoOpenTurnError extends Error {}

/**
 * Der Sessionzustand als Text für den Zugbeginn (Abschnitt 7.3).
 *
 * Der Plan ist das Kurzzeitgedächtnis (Abschnitt 8) und die einzige Zusammenfassung, die es
 * in Phase 1 gibt. Er wird **einmal je Zug** gerendert und wandert dann als unveränderliche
 * Nachricht in die Historie — nicht bei jedem Modellaufruf neu, denn dann läge veränderlicher
 * Text am Ende des Präfixes und entwertete den Cache bei jedem Zyklus.
 */
async function renderSessionState(pool: Pool, sessionId: string): Promise<string> {
  const plan = await readPlanSnapshot(pool, sessionId);
  if (plan.length === 0) return "Kein Plan gesetzt. Lege bei mehrschrittigen Aufgaben einen an.";
  return [
    `Plan (${plan.length} Aufgaben):`,
    ...plan.map((task) => {
      const blockers = task.blockers.length > 0 ? ` — blockiert: ${task.blockers.join("; ")}` : "";
      return `- [${task.status}] ${task.taskId}: ${task.title}${blockers}`;
    }),
  ].join("\n");
}

async function finishTurn(
  pool: Pool,
  sessionId: string,
  turnId: string,
  stop: LoopStop,
  reason: string,
  state: LoopState,
  metrics: RunMetrics,
): Promise<void> {
  await appendEvent(pool, sessionId, "turn.completed", {
    turn_id: turnId,
    stop,
    reason,
    tool_calls: state.toolCalls,
    consecutive_errors: state.consecutiveErrors,
    // Die Cache-Trefferquote (Abschnitt 12, Auftrag S18a) landet hier im Protokoll und nicht
    // nur in einer Faltung, die jemand erst aufrufen müsste: "pro Lauf auslesbar" heißt, sie
    // steht in der Zeile, die den Lauf abschließt. `context_compactions` ist redundant zu den
    // `context.compacted`-Ereignissen selbst (Abschnitt 4.4 verbietet Doppelschreibung von
    // Wahrheiten) — hier steht nur die **Zahl**, nicht ihr Inhalt, als derselbe Kompromiss wie
    // bei `offloaded` in `tool.completed` (S07): eine Kennzahl, keine zweite Ablage.
    cache_hit_rate: metrics.cacheHitRate,
    cache_read_tokens: metrics.cacheReadTokens,
    cache_creation_tokens: metrics.cacheCreationTokens,
    input_tokens: metrics.inputTokens,
    context_compactions: metrics.contextCompactions,
    // Kontextstufe 4 (S18b) — bewusst ein eigenes Feld und nicht in `context_compactions`
    // gefaltet: ein frischer Abschnitt ist keine weitere Kompaktierung, sondern ihr Gegenstück
    // (siehe `context/metrics.ts`), und der bestehende 110-Schritte-Nachweis aus S18a prüft
    // `context_compactions` auf einen exakten Wert.
    fresh_sections: metrics.freshSections,
  });
}

async function outcome(
  pool: Pool,
  sessionId: string,
  turnId: string,
  stop: LoopStop,
  reason: string,
  state: LoopState,
  text: string,
): Promise<LoopOutcome> {
  const events = await readEvents(pool, sessionId);
  return {
    stop,
    turnId,
    reason,
    toolCalls: state.toolCalls,
    text,
    metrics: deriveRunMetrics(events),
    pendingUserInput: deriveSessionState(sessionId, events).pendingUserInput,
  };
}

/**
 * Führt einen Zug aus: entweder einen neuen (mit `input`) oder den offenen weiter.
 *
 * Kommt **immer** mit einem Ergebnis zurück, außer bei einer Lage, die von außen entschieden
 * werden muss — ein Katalog, der nicht zur Session passt (S07), oder ein Modellaufruf, der
 * scheitert. Dieselbe Trennlinie wie in der Ausführungshülle (S05) und im Router (S07): das
 * Ergebnis eines Laufs kommt zurück, die Weigerung zu laufen fliegt.
 */
export async function runTurn(
  deps: LoopDeps,
  session: SessionRecord,
  request: TurnRequest = {},
): Promise<LoopOutcome> {
  const { pool } = deps;
  const sessionId = session.sessionId;
  const maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS;
  const maxErrors = deps.maxConsecutiveErrors ?? DEFAULT_MAX_CONSECUTIVE_ERRORS;
  const decodeToolName = toolNameDecoder(deps.catalog);
  const systemPrompt = deps.systemPrompt ?? SYSTEM_PROMPT;
  const compactionConfig = resolveCompactionConfig(deps.compactionConfig);
  const sectionConfig = resolveSectionConfig(deps.sectionConfig);
  // Der Katalog ist eingefroren (S07), System-Prompt und Konventionen werden einmal beim
  // Start gelesen (Abschnitt 7) — der feste Anteil der Anfrage ändert sich innerhalb der
  // Session nicht und wird deshalb einmal je Zug geschätzt, nicht bei jedem Schritt neu.
  const fixedOverheadTokens = estimateFixedOverheadTokens(
    systemPrompt,
    deps.conventions,
    deps.catalog,
  );

  const router: ToolRouterDeps = {
    pool,
    artifactRoot: deps.artifactRoot,
    catalog: deps.catalog,
    policy: deps.policy,
    offloadThresholdTokens: deps.offloadThresholdTokens,
    timeoutMs: deps.timeoutMs,
    signal: deps.signal,
  };

  let events = await readEvents(pool, sessionId);
  let state = deriveLoopState(events);
  let turnId = state.turnId;

  if (request.input !== undefined) {
    if (turnId) {
      // Ein offener Zug und eine neue Eingabe schlössen sich aus: entweder wird der alte
      // still verworfen (samt seiner offenen Aufrufe) oder die Eingabe landet mitten in ihm.
      // Beides wäre eine Entscheidung, die der Aufrufer treffen muss.
      throw new NoOpenTurnError(
        `Session ${sessionId} hat noch den offenen Zug ${turnId}. Eine neue Eingabe würde ihn überschreiben — erst fortsetzen (ohne input) oder abbrechen.`,
      );
    }
    turnId = `turn_${randomUUID()}`;

    // Kontextstufe 4 (S18b), **vor** dem Langzeitgedächtnis und vor `turn.started`: ob ein
    // frischer Abschnitt beginnt, ist eine Aussage über die Historie **bis zu diesem Zug**, und
    // die Reihenfolge im Protokoll soll die des Geschehens sein — erst der Abschnittswechsel
    // (falls einer stattfindet), dann der Gedächtnis-Recall des neuen Abschnitts, dann der Zug.
    // Die Prüfung selbst läuft nur hier, beim Zugbeginn — siehe die Begründung in
    // `context/section.ts` dafür, warum nicht mitten in einem laufenden Zug.
    await maybeStartFreshSection(
      {
        pool,
        artifactRoot: deps.artifactRoot,
        sessionId,
        model: deps.compactionModel ?? deps.model,
        signal: deps.signal,
      },
      {
        turnId,
        now: new Date(),
        messages: state.messages,
        messageSeqs: state.messageSeqs,
        events,
        config: sectionConfig,
      },
    );

    // Das Langzeitgedächtnis, **bevor** der Zug beginnt (S18). Die Suche läuft mit der
    // Eingabe des Nutzers als Anfrage; was sie findet, steht in der Eröffnungsnachricht und
    // damit ab dem ersten Modellaufruf im Kontext. Das Ereignis kommt vor `turn.started`,
    // damit die Reihenfolge im Protokoll die des Geschehens ist: erst nachgeschlagen, dann
    // den Zug eröffnet.
    let memoryBlock: string | null = null;
    if (deps.memory) {
      const recall = recallForTurn(deps.memory, request.input);
      memoryBlock = recall.block;
      await appendEvent(pool, sessionId, "memory.recalled", {
        turn_id: turnId,
        query: recall.query,
        found: recall.notes.length,
        total: recall.total,
        notes: recall.notes.map((note) => ({
          id: note.id,
          date: note.date,
          title: note.title,
          tags: note.tags,
          score: note.score,
          why: note.why,
        })),
      });
    }

    await appendEvent(pool, sessionId, "turn.started", {
      turn_id: turnId,
      input: request.input,
      // Was das Modell wirklich zu lesen bekommt, steht als ein Feld im Protokoll. Nur so
      // ergibt die Faltung dieselbe Nachricht wie der Lauf sie geschickt hat — und deshalb
      // steht der Gedächtnisblock hier mit drin und wird beim Replay nicht neu gesucht.
      prompt: renderTurnOpening(
        await renderSessionState(pool, sessionId),
        request.input,
        memoryBlock,
      ),
      model: deps.model.model,
      tool_catalog_version: deps.catalog.version,
    });
    events = await readEvents(pool, sessionId);
    state = deriveLoopState(events);
  }

  if (!turnId) {
    throw new NoOpenTurnError(
      `Session ${sessionId} hat keinen offenen Zug und es wurde keine Eingabe übergeben.`,
    );
  }

  let text = "";

  for (;;) {
    if (state.toolCalls >= maxSteps) {
      const reason = `Schrittobergrenze erreicht: ${state.toolCalls} von ${maxSteps} Werkzeugaufrufen in diesem Zug.`;
      await finishTurn(
        pool,
        sessionId,
        turnId,
        "step_limit",
        reason,
        state,
        deriveRunMetrics(events),
      );
      return await outcome(pool, sessionId, turnId, "step_limit", reason, state, text);
    }

    if (state.consecutiveErrors >= maxErrors) {
      const reason = `Fehlerhäufung: ${state.consecutiveErrors} Werkzeugaufrufe in Folge fehlgeschlagen (Grenze ${maxErrors}).`;
      await finishTurn(
        pool,
        sessionId,
        turnId,
        "error_rate",
        reason,
        state,
        deriveRunMetrics(events),
      );
      return await outcome(pool, sessionId, turnId, "error_rate", reason, state, text);
    }

    let calls: PendingToolCall[] = state.pending;

    if (calls.length === 0) {
      assertSendable(state.messages);

      // Kontextstufen 2 und 3 (S18a), direkt vor dem Aufbau der Anfrage: die volle Historie
      // bleibt die Wahrheit (`state.messages`, unverändert für den nächsten Schritt), nur was
      // an das Modell geht, wird hier bei Bedarf kleiner. `events` trägt frühere
      // `context.compacted`-Ereignisse, damit dieselbe Arbeit nicht bei jedem Schritt erneut
      // anfällt (siehe `context/compaction.ts`).
      const compaction = await compactHistory(
        {
          pool,
          artifactRoot: deps.artifactRoot,
          sessionId,
          model: deps.compactionModel ?? deps.model,
          signal: deps.signal,
        },
        {
          turnId,
          messages: state.messages,
          messageSeqs: state.messageSeqs,
          events,
          fixedOverheadTokens,
          config: compactionConfig,
        },
      );
      assertSendable(compaction.messages);

      const modelRequest = buildModelRequest({
        systemPrompt,
        conventions: deps.conventions,
        catalog: deps.catalog,
        messages: compaction.messages,
        maxTokens: deps.maxTokens ?? DEFAULT_MAX_TOKENS,
        signal: deps.signal,
        // Verzögertes Tool-Laden (S18b): welche `deferred`-Tools diese Session schon per
        // `tool.load` nachgeladen hat, zurückgelesen aus demselben `events`, das auch die
        // Kompaktierung oben schon trägt — kein zweiter Zustand, nur eine zweite Faltung
        // desselben Protokolls.
        loadedTools: deriveLoadedToolNames(events),
        skills: deps.skills,
      });

      await appendEvent(pool, sessionId, "model.requested", {
        turn_id: turnId,
        model: deps.model.model,
        tool_catalog_version: deps.catalog.version,
        messages: modelRequest.messages.length,
        tools: modelRequest.tools.length,
        // Die Haltepunkte stehen im Protokoll, damit die Trefferquote daneben deutbar ist:
        // eine Quote von null bei drei gesetzten Haltepunkten ist ein Befund, eine Quote von
        // null ohne Haltepunkte ist eine Selbstverständlichkeit.
        cache_breakpoints: countCacheBreakpoints(modelRequest),
      });

      const onTextDelta = deps.onTextDelta;
      if (onTextDelta) {
        modelRequest.onTextDelta = (text) => onTextDelta({ sessionId, turnId, text });
      }
      const response = await deps.model.complete(modelRequest);
      text = response.text;

      const toolCalls = response.toolCalls.map((call) => ({
        callId: call.callId,
        toolName: decodeToolName(call.name),
        input: call.input,
      }));

      const stored = await appendEvent(pool, sessionId, "model.responded", {
        turn_id: turnId,
        model: response.model,
        stop_reason: response.stopReason,
        text: response.text,
        // Die Antwort unverändert. Sie geht bei jedem folgenden Zug so wieder hinaus — nur
        // damit überlebt ein Werkzeuglauf mit Denkblöcken den Prozessneustart.
        content: response.content,
        tool_calls: toolCalls.map((call) => ({
          call_id: call.callId,
          tool_name: call.toolName,
          input: call.input,
        })),
        usage: {
          input_tokens: response.usage.inputTokens,
          output_tokens: response.usage.outputTokens,
          cache_read_input_tokens: response.usage.cacheReadTokens,
          cache_creation_input_tokens: response.usage.cacheCreationTokens,
        },
      });
      assertReplayable(response.content, stored.payload.content);

      if (toolCalls.length === 0) {
        events = await readEvents(pool, sessionId);
        state = deriveLoopState(events);
        const reason = `Das Modell hat ohne Werkzeugaufruf geantwortet (stop_reason ${response.stopReason}).`;
        const metrics = deriveRunMetrics(events);
        await finishTurn(pool, sessionId, turnId, "done", reason, state, metrics);
        return await outcome(pool, sessionId, turnId, "done", reason, state, text);
      }

      calls = toolCalls;
    }

    for (const call of calls) {
      try {
        await callTool(router, session, {
          callId: call.callId,
          name: call.toolName,
          input: call.input,
          origin: "model",
        });
      } catch (error) {
        // Die drei Fehler, die der Router bewusst durchlässt (S07/S10/S11). Zwei davon sind
        // Haltepunkte und kein Fehlschlag: der Zug bleibt offen, damit die Antwort ihn an
        // genau dieser Stelle fortsetzt. Deshalb steht hier kein `turn.completed`.
        if (error instanceof ApprovalRequiredError || error instanceof UserInputRequiredError) {
          const reason =
            error instanceof ApprovalRequiredError
              ? `Freigabe nötig für ${call.toolName} (${error.subject}).`
              : `Rückfrage an den Nutzer offen: ${error.question}`;
          events = await readEvents(pool, sessionId);
          state = deriveLoopState(events);
          return await outcome(pool, sessionId, turnId, "awaiting_user", reason, state, text);
        }
        if (error instanceof SessionCanceledError) {
          const reason = `Die Session wurde abgebrochen: ${error.message}`;
          events = await readEvents(pool, sessionId);
          state = deriveLoopState(events);
          return await outcome(pool, sessionId, turnId, "canceled", reason, state, text);
        }
        throw error;
      }
    }

    events = await readEvents(pool, sessionId);
    state = deriveLoopState(events);
  }
}
