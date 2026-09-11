import type { Pool } from "pg";
import { writeArtifact } from "../runtime/artifacts/store.js";
import { type EventRecord, appendEvent } from "../runtime/events/log.js";
import type { ModelClient, ModelMessage } from "../runtime/model/types.js";
import { largestBalancedPrefix, renderSpan } from "./compaction.js";

/**
 * Kontextstufe 4 (Abschnitt 7, Auftrag S18b): "Frisches Fenster statt Kompaktierung, wenn
 * Zustand gut ausgelagert ist." S18a hat Stufe 2 und 3 gebaut und Stufe 4 ausdrücklich vertagt
 * ("bewusst nicht gebaut" in progress.md zu S18a) — diese Datei holt das nach.
 *
 * ## Ein anderer Auslöser, derselbe Mechanik
 *
 * Stufe 3 schneidet reaktiv, wenn die Fensterauslastung eine Schwelle übersteigt. Ein frischer
 * Abschnitt schneidet **proaktiv**, unabhängig von der Auslastung, wenn eines von drei rein
 * technischen Merkmalen zutrifft (Auftrag, wörtlich):
 *
 *   * **Ruhepause** — seit dem letzten Ereignis dieser Session sind mindestens `idleMs`
 *     vergangen. Nur zu erkennen, wenn die nächste Nachricht eintrifft — es gibt keinen
 *     Hintergrund-Zeitgeber, der eine Session ohne Anlass aufweckt (dieselbe Zurückhaltung wie
 *     überall in diesem System: kein Zustand im Prozess, nur Ableitung aus dem Protokoll).
 *   * **Aufgabenabschluss** — seit dem letzten Abschnittswechsel steht ein `task.updated` oder
 *     `task.created` mit `status: "done"` im Protokoll.
 *   * **Stufe-3-Fallback** — seit dem letzten Abschnittswechsel hat Stufe 3 mindestens
 *     `maxConsecutiveStage3`-mal gegriffen, ohne dass die beiden ersten Auslöser angesprungen
 *     wären. Ein Lauf, der weder ruht noch je eine Aufgabe abschließt, bekäme sonst nie einen
 *     frischen Abschnitt und liefe für immer auf Stufe 3 allein.
 *
 * Beide Prüfungen laufen **nur beim Beginn eines neuen Zugs** (`runtime/loop/loop.ts`, vor
 * `turn.started`), nicht mitten in einem laufenden. Eine Ruhepause ist zwischen Zügen ohnehin
 * die einzige Stelle, an der sie überhaupt auftreten kann ("keine neue Nachricht" ist per
 * Definition eine Lücke zwischen zwei Zügen); ein Aufgabenabschluss und der Stufe-3-Fallback
 * *könnten* auch mitten in einem sehr langen Zug auftreten, werden aber bewusst erst beim
 * nächsten Zugbeginn wirksam — derselbe Punkt, an dem auch das Langzeitgedächtnis nachschlägt
 * (S18). Ein frischer Abschnitt mitten in einem Zug hieße, der geschützten letzten Runde aus
 * Stufe 2 und 3 (Abschnitt 7.4) einen zweiten, widersprechenden Mechanismus zur Seite zu
 * stellen; für den in S18a geführten Nachweis (ein einzelner, sehr langer Zug mit hunderten
 * Werkzeugaufrufen) bleibt Stufe 3 allein zuständig, wie seither.
 *
 * Die eigentliche Kürzung der Historie ist **kein zweiter Mechanismus**: sie läuft über
 * `context/compaction.ts`s `applyCut`/`latestCut`, dieselbe Maschinerie wie Stufe 3. Diese Datei
 * entscheidet nur, *ob* ein frischer Abschnitt beginnt, schreibt den Rohverlauf als Artefakt,
 * holt die kompakte Übergabe über einen eigenen (günstigen) Modellaufruf und hält das Ergebnis
 * als `context.section_started` fest — mit `through_seq` in derselben Zählung wie
 * `context.compacted`. `compactHistory` liest dieses Ereignis beim nächsten Aufruf zurück und
 * wendet den Schnitt an, ganz ohne dass diese Datei ihm mitteilen müsste, dass sie gelaufen ist.
 *
 * ## Kompakt, mit Absicht
 *
 * Stufe 3 fragt nach sechs Abschnitten (Ziel, Stand, offene Aufgaben, Entscheidungen,
 * Artefakt-Refs, nächster Schritt) — eine vollständige Übergabe für einen Ausschnitt, der sonst
 * ersatzlos verschwindet. Ein frischer Abschnitt braucht weniger: **"kompakt, nur was der
 * nächste Abschnitt braucht"** (Auftrag, wörtlich). Länger geltendes Wissen — eine Erkenntnis,
 * eine getroffene Entscheidung samt Grund, eine falsche Annahme — geht **nicht** über dieses
 * Feld zurück, sondern über das Langzeitgedächtnis aus S18 (`tools/memory/summary.ts`): jeder
 * abgeschlossene Zug bekommt seit S18b unabhängig von `completeOnDone` die Chance, eine Notiz zu
 * hinterlassen (`runtime/loop/api.ts`, `summarizeToMemory`). Für den Nutzer wirkt das eine
 * durchgängige Unterhaltung: eine Frage zu einem alten Thema trifft nicht auf die (jetzt knappe)
 * Übergabe, sondern auf den automatischen Gedächtnis-Recall vor jedem Zug (`recallForTurn`).
 */

export interface SectionConfig {
  /** Ruhepause, ab der ein frischer Abschnitt beginnt. Startwert 45 Minuten (Auftrag). */
  idleMs: number;
  /**
   * So viele aufeinanderfolgende Stufe-3-Kompaktierungen ohne Ruhepause oder Aufgabenabschluss
   * lösen trotzdem einen frischen Abschnitt aus. Startwert 3 (Auftrag).
   */
  maxConsecutiveStage3: number;
  /** Deckel für die Übergabe-Antwort. Kleiner als `stage3MaxTokens` — "kompakt", mit Absicht. */
  sectionMaxTokens: number;
}

export const DEFAULT_SECTION_CONFIG: SectionConfig = {
  idleMs: 45 * 60 * 1000,
  maxConsecutiveStage3: 3,
  sectionMaxTokens: 400,
};

export function resolveSectionConfig(overrides?: Partial<SectionConfig>): SectionConfig {
  return { ...DEFAULT_SECTION_CONFIG, ...overrides };
}

export interface SectionDeps {
  pool: Pool;
  artifactRoot: string;
  sessionId: string;
  /** Das günstige Modell für die Übergabe — derselbe Anschluss wie `CompactionDeps.model`. */
  model: ModelClient;
  signal?: AbortSignal;
}

export interface SectionInput {
  /** Der Zug, der mit diesem frischen Abschnitt beginnt. */
  turnId: string;
  /** Jetzt, zum Vergleich gegen den Zeitstempel des letzten Ereignisses (Ruhepause). */
  now: Date;
  /** Die volle Historie, unverändert aus `deriveLoopState` — wie bei `compactHistory`. */
  messages: readonly ModelMessage[];
  /** Parallel dazu: `LoopState.messageSeqs`. */
  messageSeqs: readonly number[];
  /** Das ganze Protokoll der Session. */
  events: readonly EventRecord[];
  config: SectionConfig;
}

export type SectionTrigger = "idle" | "task_completed" | "stage3_fallback";

export interface SectionResult {
  started: boolean;
  reason?: SectionTrigger;
}

/** Sequenznummer des letzten `context.section_started`, oder 0 (Session-Anfang). */
function lastSectionSeq(events: readonly EventRecord[]): number {
  let seq = 0;
  for (const event of events) {
    if (event.type === "context.section_started" && event.seq > seq) seq = event.seq;
  }
  return seq;
}

/** Ist seit `sinceSeq` eine Aufgabe abgeschlossen worden (`status: "done"`, nicht `dropped`)? */
function taskCompletedSince(events: readonly EventRecord[], sinceSeq: number): string | null {
  for (const event of events) {
    if (event.seq <= sinceSeq) continue;
    if (event.type !== "task.created" && event.type !== "task.updated") continue;
    if (event.payload.dropped === true) continue;
    if (event.payload.status !== "done") continue;
    const taskId = event.payload.task_id;
    return typeof taskId === "string" ? taskId : "unbekannt";
  }
  return null;
}

/** Aufeinanderfolgende Stufe-3-Kompaktierungen seit `sinceSeq` — ein einfaches Zählen reicht,
 *  weil zwischen zwei Abschnitten per Definition kein weiterer Abschnittswechsel liegt. */
function stage3StreakSince(events: readonly EventRecord[], sinceSeq: number): number {
  let count = 0;
  for (const event of events) {
    if (event.seq <= sinceSeq) continue;
    if (event.type === "context.compacted" && event.payload.stage === 3) count += 1;
  }
  return count;
}

function buildHandoverPrompt(spanText: string): string {
  return [
    "Ein Abschnitt dieser laufenden Unterhaltung endet hier. Er wird aus dem Modellkontext",
    "entfernt und durch eine kurze Übergabe ersetzt — für den nächsten Abschnitt der einzige",
    "Hinweis auf das, was hier geschah. Länger geltendes Wissen (eine Erkenntnis, eine",
    "Entscheidung samt Grund, eine falsche Annahme) gehört nicht hierher, sondern ins",
    "Langzeitgedächtnis — das läuft getrennt. Hier geht es nur um das, was der nächste Abschnitt",
    "sofort braucht, um nahtlos weiterzumachen.",
    "",
    "Antworte in genau diesen drei Abschnitten, knapp:",
    "STAND: <woran gerade gearbeitet wird, ein bis zwei Sätze>",
    "OFFEN: <der nächste Schritt oder die offene Frage, sonst 'keine'>",
    "REFS: <artifact://-Handles oder Pfade, die weiter gelten, komma-getrennt, sonst 'keine'>",
    "",
    "=== Abschnitt ===",
    spanText,
  ].join("\n");
}

/**
 * Prüft die drei Auslöser und beginnt bei Bedarf einen frischen Abschnitt.
 *
 * Wirft nie aus eigenem Antrieb — dieselbe Haltung wie `compactHistory`: ein Modellaufruf für
 * die Übergabe kann scheitern, und ein Zug, der deshalb ganz abbricht, wäre schlechter als
 * einer, der ohne frischen Abschnitt weiterläuft (Stufe 2 und 3 fangen die Historie dann wie
 * gehabt ab). Der Fehler geht ins Protokoll (`error.raised`).
 */
export async function maybeStartFreshSection(
  deps: SectionDeps,
  input: SectionInput,
): Promise<SectionResult> {
  const sinceSeq = lastSectionSeq(input.events);

  const lastEventAt = input.events.at(-1)?.createdAt;
  const idleMs = lastEventAt ? input.now.getTime() - lastEventAt.getTime() : 0;

  let reason: SectionTrigger | null = null;
  let idleMsOut: number | null = null;
  let completedTaskId: string | null = null;
  let stage3Streak: number | null = null;

  if (idleMs >= input.config.idleMs) {
    reason = "idle";
    idleMsOut = idleMs;
  } else {
    const taskId = taskCompletedSince(input.events, sinceSeq);
    if (taskId) {
      reason = "task_completed";
      completedTaskId = taskId;
    } else {
      const streak = stage3StreakSince(input.events, sinceSeq);
      if (streak >= input.config.maxConsecutiveStage3) {
        reason = "stage3_fallback";
        stage3Streak = streak;
      }
    }
  }

  if (!reason) return { started: false };

  // Zwischen zwei Zügen ist nichts offen (`runTurn` prüft das, bevor ein neuer Zug beginnt) —
  // die ganze bisherige Historie ist deshalb an ihrem Ende schon ein sicherer Schnittpunkt.
  // `largestBalancedPrefix` bleibt trotzdem die Prüfung und nicht eine bloße Annahme: derselbe
  // Grundsatz wie in `compaction.ts`, lieber prüfen als aus dem Aufrufer heraus vertrauen.
  const cut = largestBalancedPrefix(input.messages, input.messages.length);
  if (cut === 0) return { started: false };

  const spanMessages = input.messages.slice(0, cut);
  const spanText = renderSpan(spanMessages);

  const rawMeta = await writeArtifact(deps.pool, deps.artifactRoot, {
    content: spanText,
    mimeType: "text/plain",
    summary: `Rohverlauf vor frischem Abschnitt (${spanMessages.length} Nachrichten)`,
    source: { tool: "context.section", sessionId: deps.sessionId, stepId: null },
  });

  await appendEvent(deps.pool, deps.sessionId, "model.requested", {
    turn_id: input.turnId,
    model: deps.model.model,
    purpose: "section_handover",
    messages: 1,
    tools: 0,
  });

  let response: Awaited<ReturnType<ModelClient["complete"]>>;
  try {
    response = await deps.model.complete({
      system: [
        {
          text: "Du schreibst die kurze Übergabe zwischen zwei Abschnitten einer laufenden Unterhaltung.",
        },
      ],
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: buildHandoverPrompt(spanText) }] },
      ],
      maxTokens: input.config.sectionMaxTokens,
      signal: deps.signal,
    });
  } catch (error) {
    await appendEvent(deps.pool, deps.sessionId, "error.raised", {
      turn_id: input.turnId,
      where: "context.section.handover",
      error: error instanceof Error ? error.message : String(error),
    });
    return { started: false };
  }

  await appendEvent(deps.pool, deps.sessionId, "model.responded", {
    turn_id: input.turnId,
    model: response.model,
    purpose: "section_handover",
    stop_reason: response.stopReason,
    text: response.text,
    usage: {
      input_tokens: response.usage.inputTokens,
      output_tokens: response.usage.outputTokens,
      cache_read_input_tokens: response.usage.cacheReadTokens,
      cache_creation_input_tokens: response.usage.cacheCreationTokens,
    },
  });

  const throughSeq = input.messageSeqs[cut - 1];
  await appendEvent(deps.pool, deps.sessionId, "context.section_started", {
    turn_id: input.turnId,
    reason,
    idle_ms: idleMsOut,
    completed_task_id: completedTaskId,
    stage3_streak: stage3Streak,
    through_seq: throughSeq,
    covered_messages: spanMessages.length,
    raw_artifact_uri: rawMeta.uri,
    handover: response.text,
    model: response.model,
  });

  return { started: true, reason };
}
