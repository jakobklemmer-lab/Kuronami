import type { Pool } from "pg";
import type { PolicyEngine } from "../../policy/engine.js";
import { appendEvent } from "../../runtime/events/log.js";
import type { ModelClient } from "../../runtime/model/types.js";
import { redactText } from "../../runtime/redaction/redact.js";
import type { SessionRecord } from "../../runtime/session/types.js";
import { callTool } from "../router.js";
import type { ToolCatalog } from "../types.js";
import type { MemoryStore } from "./store.js";

/**
 * Die strukturierte Zusammenfassung **nach** dem Lauf (Auftrag S18) — die zweite Hälfte des
 * Gedächtnisses.
 *
 * ## „Nicht alles wird gespeichert, das ist eine bewusste Auswahl"
 *
 * Das ist die tragende Anforderung dieser Datei, und sie ist eine Anforderung **gegen** die
 * naheliegende Bauweise. Ein Nachlauf, der jeden Lauf protokolliert, wäre in zwanzig Zeilen
 * geschrieben und wäre wertlos: nach einem Monat stünden dort dreihundert Notizen, von denen
 * 290 „Aufgabe erledigt" heißen, die Suche fände zu jedem Stichwort dreißig Treffer, und der
 * Recall legte fünf davon in jeden Zug. Ein Gedächtnis, das alles behält, erinnert an nichts.
 *
 * Die Auswahl steht deshalb an drei Stellen, und keine davon ist eine Bitte im Prompt allein:
 *
 *   1. **`NICHTS` ist der vorgesehene Normalfall.** Der Prompt sagt es ausdrücklich, und der
 *      Parser behandelt es als Erfolg — nicht als Fehlschlag einer Zusammenfassung.
 *      `memory.skipped` hält im Protokoll fest, dass bewusst nichts abgelegt wurde; ein
 *      ausbleibender Eintrag sieht damit nicht aus wie ein vergessener.
 *   2. **Höchstens eine Notiz je Lauf.** Kein Zählwerk im Prompt, sondern die Form der
 *      Antwort: es gibt genau einen Block. Wer mehr will, schreibt während des Laufs mit
 *      `memory.write`.
 *   3. **Die Mindesthürden des Speichers.** Zu kurz oder ohne Tags wird abgewiesen
 *      (`store.ts`) — auch hier.
 *
 * ## Der Schreibweg führt durch den Router, nicht daran vorbei
 *
 * `writeSummary` ruft `memory.write` über `callTool` — mit Katalogprüfung, Schemaprüfung,
 * Policy-Engine, Ausführungshülle und Protokoll, genau wie ein Aufruf des Modells. Der
 * bequemere Weg wäre, `store.write` direkt zu rufen; er wäre auch das Loch, durch das die
 * Schreibgrenze aus S17 fiele. `BACKGROUND_RULES` verbietet `memory.write` für
 * Hintergrundläufe, und diese Sperre wirkt nur, wenn der Aufruf am selben Tor vorbeikommt wie
 * jeder andere (Abschnitt 4.7). Die `origin` sagt, wer gerufen hat; sie ändert die
 * Entscheidung nicht (S11).
 */

/** Die Antwort, mit der das Modell sagt: dieser Lauf hinterlässt nichts. */
export const NOTHING_MARKER = "NICHTS";

/** So viel Verlauf geht in die Zusammenfassungsanfrage. */
const TRANSCRIPT_CHARS = 6_000;

export interface RunSummaryInput {
  pool: Pool;
  model: ModelClient;
  catalog: ToolCatalog;
  policy: PolicyEngine;
  artifactRoot: string;
  /** Für das Tag-Vokabular: die Zusammenfassung soll an bestehende Tags anschließen. */
  store: MemoryStore;
  session: SessionRecord;
  /** Der Zug, der gerade endete. */
  turnId: string;
  /** Die Eingabe des Nutzers. */
  input: string;
  /** Der Abschlusstext des Modells. */
  outcomeText: string;
  /** Was im Lauf passiert ist, knapp — Toolnamen und Zusammenfassungen. */
  steps: readonly string[];
  signal?: AbortSignal;
  maxTokens?: number;
}

export interface RunSummaryResult {
  /** `null`, wenn bewusst nichts abgelegt wurde. */
  noteId: string | null;
  /** Warum nichts abgelegt wurde, oder wie die Ablage ausging. */
  reason: string;
}

interface ParsedSummary {
  title: string;
  tags: string[];
  supersedes: string[];
  body: string;
}

/**
 * Der Prompt der Zusammenfassung. Bewusst kurz und bewusst mit einer **hohen Hürde**: die
 * Beispiele für „nicht aufheben" stehen vor denen für „aufheben", weil das Modell sonst die
 * Frage „gibt es hier etwas?" mit „ich soll etwas finden" verwechselt.
 */
export function buildSummaryPrompt(input: RunSummaryInput, memoryTags: readonly string[]): string {
  const steps = input.steps.slice(0, 40).join("\n");
  const transcript = [
    `Eingabe des Nutzers: ${input.input}`,
    "",
    "Was der Lauf getan hat:",
    steps || "(keine Werkzeugaufrufe)",
    "",
    `Abschluss: ${input.outcomeText}`,
  ]
    .join("\n")
    .slice(0, TRANSCRIPT_CHARS);

  // Der Verlauf geht in den Modellkontext und damit durch den Filter (AGENTS.md). Er stammt
  // hier **nicht** aus `readEvents`, sondern aus den Werten des Aufrufers — die Ausnahme, die
  // `context/request.ts` für die Historie beschreibt, gilt für ihn also nicht.
  return [
    "Der Lauf ist zu Ende. Entscheide, ob er etwas hinterlässt, das beim nächsten Mal den",
    "Unterschied macht.",
    "",
    "Die meisten Läufe hinterlassen nichts. Antworte dann mit einem einzigen Wort:",
    NOTHING_MARKER,
    "",
    "Nichts aufheben ist richtig bei: erledigten Routineaufgaben, allem, was im Code, in der",
    "Git-Historie oder in den Konventionen ohnehin steht, dem bloßen Verlauf des Laufs, und",
    "allem, was nur für diese eine Unterhaltung galt.",
    "",
    "Aufheben ist richtig bei: einer Erkenntnis über die Welt außerhalb dieses Systems, die",
    "sich nicht aus dem Code ergibt; einem Ereignis mit Folgen für später; einer Annahme, die",
    "sich als falsch erwiesen hat; einer Entscheidung samt ihrem Grund.",
    "",
    "Dauerregeln, Vorlieben und Arbeitskonventionen gehören NICHT hierher, sondern in die",
    `Konventionsdatei. Wenn der Lauf so etwas ergeben hat, antworte mit ${NOTHING_MARKER}.`,
    "",
    memoryTags.length > 0
      ? `Vorhandene Tags im Gedächtnis (nimm bestehende, wo sie passen): ${memoryTags.join(", ")}`
      : "Das Gedächtnis ist noch leer.",
    "",
    "Antwortformat, wenn etwas aufzuheben ist — genau eine Notiz, nichts davor und danach:",
    "TITEL: <ein Satz>",
    "TAGS: <komma-getrennt, kleingeschrieben>",
    "ERSETZT: <Kennungen widersprochener Notizen, komma-getrennt; weglassen, wenn keine>",
    "---",
    "<Der Notiztext. So schreiben, dass er in einem halben Jahr ohne den heutigen",
    "Zusammenhang verständlich ist.>",
    "",
    "=== Der Lauf ===",
    redactText(transcript),
  ].join("\n");
}

/**
 * Zerlegt die Modellantwort. Gibt `null` zurück, wenn nichts abzulegen ist — und **wirft**,
 * wenn die Antwort zwar nach einer Notiz aussieht, aber unvollständig ist: eine halb erkannte
 * Notiz stillschweigend zu verwerfen hieße, den Verlust als bewusste Auswahl auszugeben.
 */
export function parseSummary(text: string): ParsedSummary | null {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.toUpperCase().startsWith(NOTHING_MARKER)) return null;

  const separator = trimmed.indexOf("\n---");
  if (separator === -1) {
    throw new Error(
      `Die Zusammenfassung hat weder mit "${NOTHING_MARKER}" geantwortet noch die Trennlinie "---" gesetzt. Antwort war: ${trimmed.slice(0, 300)}`,
    );
  }

  const head = trimmed.slice(0, separator);
  const body = trimmed
    .slice(separator + 4)
    .replace(/^-*\n/, "")
    .trim();

  const field = (name: string): string => {
    const match = new RegExp(`^${name}:\\s*(.*)$`, "im").exec(head);
    return match ? match[1].trim() : "";
  };

  const title = field("TITEL");
  const tags = splitList(field("TAGS"));
  if (title === "" || tags.length === 0 || body === "") {
    throw new Error(
      `Die Zusammenfassung ist unvollständig (Titel: ${title === "" ? "fehlt" : "ok"}, Tags: ${tags.length}, Text: ${body.length} Zeichen).`,
    );
  }

  return { title, tags, supersedes: splitList(field("ERSETZT")), body };
}

function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim().replace(/^\[|\]$/g, ""))
    .filter((entry) => entry !== "" && entry.toLowerCase() !== "keine");
}

/**
 * Fragt das Modell nach der Zusammenfassung und legt sie — wenn es eine gibt — über den Router
 * ab. Wirft nie: ein Lauf, der erfolgreich war, ist nicht nachträglich fehlgeschlagen, weil
 * seine Nachbereitung es war. Der Fehler landet im Protokoll (`error.raised`), nicht im
 * Ergebnis des Laufs.
 */
export async function summarizeRun(input: RunSummaryInput): Promise<RunSummaryResult> {
  const sessionId = input.session.sessionId;

  if (!input.catalog.get("memory.write")) {
    const reason =
      "Der Katalog dieser Session kennt kein memory.write (Hintergrundprofil oder Gedächtnis nicht verdrahtet).";
    await appendEvent(input.pool, sessionId, "memory.skipped", {
      turn_id: input.turnId,
      reason,
      decided_by: "runtime",
    });
    return { noteId: null, reason };
  }

  let parsed: ParsedSummary | null;
  try {
    const response = await input.model.complete({
      system: [{ text: "Du führst das Langzeitgedächtnis eines persönlichen Assistenten." }],
      tools: [],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: buildSummaryPrompt(input, tagVocabulary(input.store)) }],
        },
      ],
      maxTokens: input.maxTokens ?? 1_024,
      signal: input.signal,
    });
    parsed = parseSummary(response.text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await appendEvent(input.pool, sessionId, "error.raised", {
      turn_id: input.turnId,
      where: "memory.summary",
      error: detail,
    });
    return { noteId: null, reason: `Die Zusammenfassung ist fehlgeschlagen: ${detail}` };
  }

  if (parsed === null) {
    const reason = "Der Lauf hinterlässt nichts, was über ihn hinaus gilt.";
    await appendEvent(input.pool, sessionId, "memory.skipped", {
      turn_id: input.turnId,
      reason,
      decided_by: "model",
    });
    return { noteId: null, reason };
  }

  const result = await callTool(
    {
      pool: input.pool,
      artifactRoot: input.artifactRoot,
      catalog: input.catalog,
      policy: input.policy,
      signal: input.signal,
    },
    input.session,
    {
      // Der Zug ist die Arbeit: dieselbe Zusammenfassung zweimal abzusetzen trifft auf
      // denselben Idempotenzschlüssel und legt keine zweite Notiz an (S05).
      callId: `memory_summary_${input.turnId}`,
      name: "memory.write",
      input: {
        content: parsed.body,
        tags: parsed.tags,
        title: parsed.title,
        kind: "erkenntnis",
        supersedes: parsed.supersedes,
      },
      origin: "run_summary",
    },
  );

  if (result.status === "error") {
    await appendEvent(input.pool, sessionId, "error.raised", {
      turn_id: input.turnId,
      where: "memory.summary.write",
      error: result.summary,
    });
    return { noteId: null, reason: `Die Notiz konnte nicht abgelegt werden: ${result.summary}` };
  }

  const structured = result.structured as { id?: unknown } | null;
  const noteId = typeof structured?.id === "string" ? structured.id : null;
  return { noteId, reason: result.summary };
}

/** So viele Tags gehen als Vokabular in den Prompt. */
const TAG_VOCABULARY_LIMIT = 40;

/**
 * Die vorhandenen Tags, nach Häufigkeit. Sie stehen im Prompt, damit die Zusammenfassung an
 * bestehende anschließt statt neue zu erfinden: ein Gedächtnis, in dem dieselbe Sache einmal
 * unter `kalender` und einmal unter `termine` liegt, findet sich selbst nicht wieder — und
 * Tags wiegen bei der Suche am schwersten (`index-db.ts`).
 */
function tagVocabulary(store: MemoryStore): string[] {
  const counts = new Map<string, number>();
  for (const note of store.all()) {
    for (const tag of note.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TAG_VOCABULARY_LIMIT)
    .map(([tag]) => tag);
}
