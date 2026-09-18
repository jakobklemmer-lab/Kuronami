import type { EventPayload, EventRecord } from "../runtime/events/log.js";
import {
  type ModelContentBlock,
  type ModelMessage,
  isToolUseBlock,
  textBlock,
  toolResultBlock,
} from "../runtime/model/types.js";
import type { JsonValue } from "../runtime/steps/types.js";

/**
 * Die Gesprächshistorie als **Faltung über das Ereignisprotokoll** (S12).
 *
 * Das ist die eine Entscheidung, an der die ganze Session hängt. Der naheliegende Weg wäre,
 * die Nachrichten im Prozess mitzuführen und bei jedem Zug anzuhängen; er kostet nichts und
 * ist in zwanzig Zeilen geschrieben. Er hat nur eine Eigenschaft, die ihn ausschließt: der
 * Kontext lebte dann im Arbeitsspeicher, und ein abgeschossener Prozess nähme ihn mit. Der
 * Nachweis dieser Session ist aber wörtlich "einen erzwungenen Neustart in der Mitte
 * überleben" — und überleben kann nur, was nie im Prozess lag.
 *
 * Also dieselbe Bauart wie `deriveSessionState` (S05) und `derivePlan` (S10): eine reine
 * Funktion über Ereignisse. Daraus folgen drei Eigenschaften, die man sonst versprechen
 * müsste:
 *
 *   * **Der Neustart braucht keinen Sonderweg.** Ein frisch gestarteter Prozess faltet und
 *     steht exakt da, wo der abgeschossene stand.
 *   * **Fehlgeschlagene Schritte bleiben im Kontext sichtbar** (Auftrag; Abschnitt 7). Sie
 *     stehen im Protokoll, also stehen sie in der Historie — es gibt keinen Zweig, der sie
 *     überspringen könnte, und deshalb auch keinen, den jemand versehentlich einbaut.
 *   * **Kein ungefilterter Text erreicht den Prompt.** Die Signatur nimmt Ereignisse entgegen
 *     und sonst nichts, und die sind am Schreibtor des Protokolls gefiltert (S03). Das ist
 *     eine Eigenschaft der Bauart, keine Zusage der Sorgfalt — dasselbe Argument wie bei
 *     `headArtifact`, das kein `root` bekommt (S06).
 */

/** Das Protokoll gibt die Historie nicht her. Wie in `deriveSessionState`: nicht raten. */
export class TranscriptError extends Error {}

export interface PendingToolCall {
  callId: string;
  /** Katalogname (`fs.read`), nicht der API-Name. Der Loop übersetzt beim Schreiben. */
  toolName: string;
  input: Record<string, JsonValue>;
}

export interface LoopState {
  /** Die vollständige Historie über alle Züge hinweg, in Sendeform. */
  messages: ModelMessage[];
  /** Der offene Zug: ein `turn.started` ohne `turn.completed`. */
  turnId: string | null;
  /** Abgeschlossene Werkzeugaufrufe im offenen Zug — die Schrittzahl der Obergrenze. */
  toolCalls: number;
  /** Fehlgeschlagene Aufrufe am Ende des offenen Zugs, ohne Erfolg dazwischen. */
  consecutiveErrors: number;
  /**
   * Aufrufe der letzten Modellantwort, zu denen noch kein Ergebnis im Protokoll steht.
   *
   * Das ist der Wiederaufnahmepunkt. Ein neu gestarteter Prozess fragt **nicht** das Modell
   * noch einmal — er führt zuerst diese Aufrufe aus. Täte er es andersherum, entstünde eine
   * zweite Modellantwort zu derselben Lage, die alte `tool_use`-Blöcke ohne Gegenstück in der
   * Historie zurückließe, und der Anbieter weist eine solche Historie ab. Dass die Aufrufe
   * gefahrlos wiederholt werden dürfen, sichert die Ausführungshülle über den
   * Idempotenzschlüssel `tool:<call_id>` (S05/S07), nicht diese Faltung.
   */
  pending: PendingToolCall[];
  /** Ausgelagerte Tool-Ergebnisse im ganzen Protokoll. Kennzahl aus Abschnitt 12. */
  offloadedResults: number;
  /**
   * Parallel zu `messages`: die Sequenznummer des Ereignisses, das die jeweilige Nachricht
   * abgeschlossen hat (S18a, `context/compaction.ts`).
   *
   * Die Kompaktierung (Stufe 3) muss einen Schnittpunkt in der Historie **wiederfinden**
   * können, ohne ihn zu raten: ein zweiter, unabhängiger Fold über dieselben Ereignisse hätte
   * bei jeder künftigen Änderung an dieser Funktion driften können. Deshalb entsteht die
   * Zuordnung genau hier, an jeder Stelle, an der auch `messages` wächst — additiv und ohne
   * bestehendes Verhalten zu berühren.
   */
  messageSeqs: number[];
}

function requireString(payload: EventPayload, field: string, type: string): string {
  const value = payload[field];
  if (typeof value !== "string") {
    throw new TranscriptError(
      `Ereignis ${type} ohne verwertbares Feld "${field}": ${JSON.stringify(payload)}. Die Historie ist aus diesem Protokoll nicht herleitbar.`,
    );
  }
  return value;
}

/**
 * Der Text, mit dem ein Zug beginnt: Langzeitgedächtnis (S18), Sessionzustand (Abschnitt 4 des
 * Auftrags) und aktuelle Eingabe (Abschnitt 6), in dieser Reihenfolge und in denselben Marken
 * wie in `prompt.ts`.
 *
 * Alle drei stehen **in der Nachricht** und nicht im System-Prompt. Abschnitt 7 sagt es
 * ausdrücklich: "System-Prompt nicht für dynamische Zustandsänderungen umschreiben, Zustand
 * als Nachricht schicken". Ein Zustand im System-Prompt entwertete bei jedem Zug den
 * gesamten Cache darunter — also alles.
 *
 * Das Gedächtnis steht **vor** dem Sessionzustand, weil es der ältere Kontext ist: erst was
 * aus früheren Läufen gilt, dann wo dieser Lauf steht, dann was jetzt gefragt ist. Fehlt es
 * (leeres Gedächtnis, kein Treffer), fällt der Block ersatzlos weg — ein `<memory>`-Abschnitt
 * mit „nichts gefunden" wäre eine Zeile, die das Modell bei jedem Zug liest und die nie etwas
 * aussagt.
 */
export function renderTurnOpening(state: string, input: string, memory?: string | null): string {
  const parts: string[] = [];
  if (memory && memory.trim() !== "") {
    parts.push("<memory>", memory.trim(), "</memory>", "");
  }
  parts.push(
    "<session_state>",
    state.trim(),
    "</session_state>",
    "",
    "<user_input>",
    input.trim(),
    "</user_input>",
  );
  return parts.join("\n");
}

/** Die Fehlerhülle eines `tool.failed` zurückbauen. `failTool` legt sie flach ins Payload. */
function errorHull(payload: EventPayload): JsonValue {
  const structured: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "call_id" || key === "tool_name" || key === "risk" || key === "summary") continue;
    structured[key] = value as JsonValue;
  }
  return {
    status: "error",
    summary: (payload.summary as string) ?? "Tool-Aufruf ist fehlgeschlagen",
    structured,
    artifact_refs: [],
    preview: [],
  };
}

/**
 * Liegt das Ergebnis hinter einem Handle? Beide Wege zählen — die Auslagerung durch den
 * Router (`structured.offloaded`) und die durch das Tool selbst (`artifact_refs`, so machen
 * es `fs.read` und `web.fetch`). Dieselbe Definition wie `isOffloadedResult` im Router.
 */
function isOffloaded(hull: JsonValue): boolean {
  if (typeof hull !== "object" || hull === null || Array.isArray(hull)) return false;
  const record = hull as Record<string, JsonValue>;
  if (Array.isArray(record.artifact_refs) && record.artifact_refs.length > 0) return true;
  const structured = record.structured;
  return (
    typeof structured === "object" &&
    structured !== null &&
    !Array.isArray(structured) &&
    (structured as Record<string, JsonValue>).offloaded === true
  );
}

/**
 * Faltet das Protokoll zur Historie und zum Stand des offenen Zugs.
 *
 * Die Ergebnis-Hülle eines Aufrufs wird **nicht** aus einer zweiten Quelle geholt: sie steht
 * genau einmal im Protokoll, und zwar in dem Ereignis, das den Ausgang trägt — bei einem
 * Schritt-Tool im `step.completed` (S05), bei einem `execution: "runtime"`-Tool im
 * `tool.completed`, weil es dort keinen Schritt gibt. Die Faltung verbindet beide über
 * `step_id`. Die Hülle in beide Ereignisse zu schreiben, wäre eine zweite Wahrheit, die
 * abweichen kann; sie in keines zu schreiben, hieße den Kontext nach einem Neustart zu
 * verlieren.
 */
export function deriveLoopState(events: EventRecord[]): LoopState {
  const messages: ModelMessage[] = [];
  const messageSeqs: number[] = [];
  const stepResults = new Map<string, JsonValue>();
  let toolResults: ModelContentBlock[] = [];
  let lastToolResultSeq = 0;
  let turnId: string | null = null;
  let toolCalls = 0;
  let consecutiveErrors = 0;
  let pending: PendingToolCall[] = [];
  let offloadedResults = 0;

  function flushToolResults(): void {
    if (toolResults.length === 0) return;
    messages.push({ role: "user", content: toolResults });
    messageSeqs.push(lastToolResultSeq);
    toolResults = [];
  }

  function recordOutcome(callId: string, hull: JsonValue, failed: boolean, seq: number): void {
    toolResults.push(toolResultBlock(callId, JSON.stringify(hull), failed));
    lastToolResultSeq = seq;
    pending = pending.filter((entry) => entry.callId !== callId);
    toolCalls += 1;
    consecutiveErrors = failed ? consecutiveErrors + 1 : 0;
    if (isOffloaded(hull)) offloadedResults += 1;
  }

  for (const event of events) {
    switch (event.type) {
      case "step.completed": {
        const stepId = requireString(event.payload, "step_id", event.type);
        stepResults.set(stepId, (event.payload.result as JsonValue | undefined) ?? null);
        break;
      }

      case "turn.started": {
        flushToolResults();
        turnId = requireString(event.payload, "turn_id", event.type);
        toolCalls = 0;
        consecutiveErrors = 0;
        pending = [];
        messages.push({
          role: "user",
          content: [textBlock(requireString(event.payload, "prompt", event.type))],
        });
        messageSeqs.push(event.seq);
        break;
      }

      case "turn.completed":
        flushToolResults();
        turnId = null;
        pending = [];
        break;

      case "model.responded": {
        // Die Zusammenfassung der Kontext-Kompaktierung (S18a, `context/compaction.ts`) und die
        // Übergabe eines frischen Abschnitts (S18b, `context/section.ts`) laufen über denselben
        // Modellaufruf-Vertrag und hinterlassen deshalb dieselben zwei Ereignistypen — sonst
        // blieben sie für die Kostenrechnung unsichtbar (Abschnitt 12). Beide sind aber **kein**
        // Zug des Loops: sie tragen keine Werkzeugaufrufe, gehören zu keiner Runde und dürfen
        // die Historie, die dem Modell als nächstes gezeigt wird, nicht verdoppeln. Die Marke
        // `purpose` ist die Unterscheidung — jeder Wert außer einer echten Zugantwort (die trägt
        // kein `purpose`) markiert einen solchen Nebenaufruf; `context/metrics.ts` zählt bewusst
        // **alle** mit, das ist der ganze Zweck der Marke.
        if (typeof event.payload.purpose === "string") break;

        flushToolResults();
        const content = event.payload.content;
        if (!Array.isArray(content)) {
          throw new TranscriptError(
            `Ereignis model.responded (seq ${event.seq}) trägt keine Inhaltsblöcke. Ohne sie lässt sich der Zug nicht fortsetzen.`,
          );
        }
        const blocks = content as ModelContentBlock[];
        // Leere Antworten kommen vor (nur Denkblöcke, kein Text, kein Aufruf). Eine leere
        // Nachricht weist der Anbieter ab, also darf sie gar nicht erst in die Historie.
        if (blocks.length > 0) {
          messages.push({ role: "assistant", content: blocks });
          messageSeqs.push(event.seq);
        }

        const calls = event.payload.tool_calls;
        pending = Array.isArray(calls)
          ? calls.map((entry) => {
              const call = entry as Record<string, JsonValue>;
              if (typeof call.call_id !== "string" || typeof call.tool_name !== "string") {
                throw new TranscriptError(
                  `Ereignis model.responded (seq ${event.seq}) trägt einen Aufruf ohne call_id/tool_name: ${JSON.stringify(entry)}`,
                );
              }
              return {
                callId: call.call_id,
                toolName: call.tool_name,
                input: (call.input as Record<string, JsonValue> | undefined) ?? {},
              };
            })
          : [];
        break;
      }

      case "tool.completed": {
        const callId = requireString(event.payload, "call_id", event.type);
        // Nur Aufrufe, die das Modell in diesem Zug als `tool_use` angekündigt hat (also in
        // `pending` stehen), werden zu einem `tool_result`. Ein Aufruf ohne vorangehenden
        // `tool_use` ergäbe ein verwaistes `tool_result`, und das weist der Anbieter mit 400 ab
        // ("unexpected tool_use_id ... Each tool_result block must have a corresponding
        // tool_use block"). Der Fall im Betrieb: die Nachlauf-Zusammenfassung ins Gedächtnis
        // (`tools/memory/summary.ts`, `memory.write` mit `origin: "run_summary"`), die **nach**
        // `turn.completed` läuft — sie ist ein Systemaufruf, kein Zug des Modells, und `pending`
        // ist zu diesem Zeitpunkt bereits geleert.
        if (!pending.some((entry) => entry.callId === callId)) break;
        const stepId = event.payload.step_id;
        let hull: JsonValue;
        if (typeof stepId === "string") {
          const stored = stepResults.get(stepId);
          if (stored === undefined) {
            throw new TranscriptError(
              `Ereignis tool.completed (seq ${event.seq}) verweist auf Schritt ${stepId}, zu dem kein step.completed mit Ergebnis im Protokoll steht.`,
            );
          }
          hull = stored;
        } else {
          hull = (event.payload.result as JsonValue | undefined) ?? null;
        }
        recordOutcome(callId, hull, false, event.seq);
        break;
      }

      case "tool.failed": {
        const callId = requireString(event.payload, "call_id", event.type);
        // Dieselbe Bedingung wie bei `tool.completed`: ein Aufruf ohne vorangehenden `tool_use`
        // gehört nicht in die Historie, gleich ob er glückte oder scheiterte.
        if (!pending.some((entry) => entry.callId === callId)) break;
        recordOutcome(callId, errorHull(event.payload), true, event.seq);
        break;
      }

      // Alles Übrige sagt nichts über die Historie. Wie in `deriveSessionState`: ein
      // unbekannter Typ ist kein Fehler, die Taxonomie wächst.
      default:
        break;
    }
  }

  flushToolResults();
  return { messages, messageSeqs, turnId, toolCalls, consecutiveErrors, pending, offloadedResults };
}

/**
 * Prüft, dass eine Historie sendbar ist: zu jedem `tool_use` gibt es ein `tool_result`.
 *
 * Der Anbieter lehnt eine Historie mit einem offenen `tool_use` ab, und zwar zu Recht — sie
 * behauptet einen Aufruf, dessen Ausgang niemand kennt. Im Betrieb kann das genau einmal
 * auftreten: wenn der Loop das Modell fragte, obwohl noch Aufrufe offen sind. Diese Prüfung
 * macht daraus einen benannten Fehler an der Stelle, an der er entsteht, statt einer 400 vom
 * Anbieter, die man erst zurückverfolgen muss.
 */
export function assertSendable(messages: ModelMessage[]): void {
  const open = new Map<string, string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (isToolUseBlock(block)) open.set(block.id, block.name);
      if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        open.delete(block.tool_use_id);
      }
    }
  }
  if (open.size > 0) {
    const listed = [...open.entries()].map(([id, name]) => `${name} (${id})`).join(", ");
    throw new TranscriptError(
      `Die Historie trägt ${open.size} Werkzeugaufruf(e) ohne Ergebnis: ${listed}. Sie darf nicht abgeschickt werden — erst die offenen Aufrufe ausführen, dann das Modell fragen.`,
    );
  }
}

/**
 * Prüft, dass die Blöcke einer Modellantwort den Redaction-Filter unverändert überstanden
 * haben, soweit es auf Unverändertheit ankommt.
 *
 * Text darf der Filter ersetzen — dafür ist er da. Drei Dinge darf er nicht anfassen, weil
 * sie **Identitäten** sind und wieder nachgeschlagen bzw. vom Anbieter geprüft werden:
 * `tool_use.id` (er wird zum Idempotenzschlüssel), `tool_use.name` (er wählt das Tool) und
 * die `signature` eines Denkblocks (der Anbieter verifiziert sie beim Zurückreichen).
 * Dieselbe Haltung wie bei `task_id` (S10) und beim Subjektschlüssel der Policy (S11): lieber
 * abweisen als mit einem kaputten Schlüssel weiterlaufen, denn der Bruch fiele sonst erst
 * beim nächsten Zug auf und sähe dort nach einem Anbieterfehler aus.
 */
export function assertReplayable(sent: ModelContentBlock[], stored: unknown): void {
  if (!Array.isArray(stored) || stored.length !== sent.length) {
    throw new TranscriptError(
      `Die Modellantwort ist beim Schreiben ins Protokoll von ${sent.length} auf ${Array.isArray(stored) ? stored.length : "keine"} Blöcke verändert worden und lässt sich nicht mehr zurückreichen.`,
    );
  }
  for (const [index, block] of sent.entries()) {
    const after = stored[index] as Record<string, unknown>;
    for (const field of ["type", "id", "name", "signature"]) {
      if (block[field] !== undefined && after?.[field] !== block[field]) {
        throw new TranscriptError(
          `Der Redaction-Filter hat "${field}" in Block ${index} (${block.type}) der Modellantwort verändert. Das Feld ist eine Identität und wird wieder nachgeschlagen oder vom Anbieter geprüft; ein veränderter Wert bräche den nächsten Zug.`,
        );
      }
    }
  }
}
