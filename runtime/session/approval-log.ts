import type { PoolClient } from "pg";
import type { EventRecord } from "../events/log.js";
import type { AskOption } from "./state.js";

/**
 * Die Mechanik offener Entscheidungen im Ereignisprotokoll.
 *
 * Seit S10 hängt `user.ask` daran: eine Rückfrage ist ein `approval.requested` ohne folgendes
 * `approval.granted`/`approval.denied`, und weil sie nur im Protokoll steht, überlebt sie
 * jeden Neustart — sie lag nie im Speicher. Mit S11 hängt die Policy-Engine an derselben
 * Mechanik: eine Freigabe-Rückfrage ist dasselbe Ding mit einem anderen `kind`.
 *
 * Deshalb steht das Lesen hier und nicht in `user-input.ts`: sonst müsste `policy/` auf
 * `user.ask` zeigen, um an eine Freigabe zu kommen, und die beiden Fälle würden sich
 * auseinanderentwickeln, bis `deriveSessionState` zwei Formen desselben Ereignisses falten
 * muss. Geschrieben wird weiterhin getrennt — die Ereignisse tragen verschiedene Felder, und
 * die Freigabe schreibt zusätzlich eine Zeile in `kuronami.approvals`.
 */

/**
 * Wofür eine offene Entscheidung steht. Landet als `kind` im `approval.*`-Ereignis.
 *
 * `agent_create` ist seit S19 dabei: die Bestätigung eines Agentenprofils läuft über dieselbe
 * Mechanik wie `user.ask` (Frage, strukturierte Optionen, Wartezustand aus dem Protokoll), ist
 * aber eine andere Aussage — sie entscheidet nicht über einen Aufruf, sondern über eine
 * **stehende Erlaubnis**. Ohne eigenen `kind` wäre "welche Profile hat der Nutzer je
 * bestätigt" nur über einen Filter auf Fragetexten zu beantworten.
 */
export type AskKind = "user_ask" | "policy" | "agent_create";

export interface AskTrace {
  request?: EventRecord;
  decision?: EventRecord;
}

/**
 * Serialisiert alle Schreiber derselben Session, wie in `events/log.ts` und `steps/hull.ts`.
 * Wer den Entscheidungsstand einer Session ändert, hält diese Sperre — eine je Session, damit
 * es zwischen Rückfrage, Antwort und Schritt keine Sperrreihenfolge zu beachten gibt.
 */
export async function lockSession(client: PoolClient, sessionId: string): Promise<void> {
  const found = await client.query(
    "SELECT session_id FROM kuronami.sessions WHERE session_id = $1 FOR UPDATE",
    [sessionId],
  );
  if (found.rowCount === 0) throw new Error(`Session ${sessionId} existiert nicht`);
}

/**
 * Der Stand einer `ask_id` im Protokoll: die (letzte) Anfrage und eine ihr folgende
 * Entscheidung. Eine neue Anfrage setzt eine ältere Entscheidung zurück — dieselbe `ask_id`
 * kann nach einem `session.resumed` erneut gestellt werden.
 */
export function traceAsk(events: EventRecord[], askId: string): AskTrace {
  const trace: AskTrace = {};
  for (const event of events) {
    if (event.payload.ask_id !== askId) continue;
    if (event.type === "approval.requested") {
      trace.request = event;
      trace.decision = undefined;
    } else if (event.type === "approval.granted" || event.type === "approval.denied") {
      if (trace.request) trace.decision = event;
    }
  }
  return trace;
}

/** Die strukturierten Optionen einer Anfrage (Abschnitt 10: kein Fließtext). */
export function optionsOf(request: EventRecord): AskOption[] {
  const value = request.payload.options;
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (entry): entry is AskOption =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as AskOption).id === "string" &&
        typeof (entry as AskOption).label === "string",
    )
    .map((entry) => ({ id: entry.id, label: entry.label }));
}
