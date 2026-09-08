import type { Pool, PoolClient } from "pg";
import { type EventRecord, appendEventInTx, readEvents } from "../events/log.js";
import { redactText } from "../redaction/redact.js";
import { type AskOption, type PendingUserInput, deriveSessionState } from "./state.js";

/**
 * `user.ask` — der synchrone Haltepunkt aus Abschnitt 10. Er pausiert den Lauf, die Session
 * geht in `awaiting_user`, die Antwort setzt an exakt derselben Stelle fort.
 *
 * Der Mechanismus steckt vollständig im Ereignisprotokoll, ohne eigene Tabelle und ohne
 * eigene Spalte:
 *
 *   * Der Aufruf schreibt `approval.requested` mit der Frage und **strukturierten** Optionen
 *     (kein Fließtext, auf dessen Parsbarkeit man hofft).
 *   * Solange kein `approval.granted`/`approval.denied` mit derselben `ask_id` folgt, faltet
 *     `deriveSessionState` den Zustand zu `awaiting_user` (siehe `state.ts`). Ein neu
 *     gestarteter Prozess liest das ohne Weiteres aus dem Protokoll — der Wartezustand
 *     überlebt den Neustart, weil er nie im Speicher lag.
 *   * `answerUserInput` schreibt `approval.granted`. Ein erneuter `user.ask` mit derselben
 *     `call_id` — den ein wiederaufnehmender Lauf aus seinem Plan wieder herleitet — findet
 *     jetzt die Antwort und läuft weiter.
 *
 * `user.ask` läuft **nicht** durch die Ausführungshülle aus S05: es gibt keinen externen
 * Seiteneffekt, den ein Checkpoint umklammern müsste, und einen Schritt stundenlang auf
 * `running` oder `failed` zu parken, während ein Mensch überlegt, wäre beides falsch. Die
 * Idempotenz kommt aus dem Protokoll: ein zweiter `approval.requested` zur selben `ask_id`
 * wird nicht geschrieben.
 */

/**
 * `user.ask` hat eine Rückfrage gestellt, die noch offen ist. Der Router lässt diesen Fehler
 * durch (wie `ToolCatalogMismatchError`) statt ihn in eine Fehlerhülle zu verwandeln: der
 * Lauf ist nicht fehlgeschlagen, er wartet.
 */
export class UserInputRequiredError extends Error {
  constructor(
    readonly askId: string,
    readonly question: string,
    readonly options: AskOption[],
  ) {
    super(`user.ask ${askId}: wartet auf eine Antwort ("${question}")`);
    this.name = "UserInputRequiredError";
  }
}

/** `answerUserInput` findet keine offene Rückfrage zu dieser `ask_id`. */
export class UserInputNotPendingError extends Error {}
/** Die gewählte Option gehört nicht zu den Optionen, die die Rückfrage angeboten hat. */
export class UnknownAskOptionError extends Error {}

export interface AskSpec {
  /** Stabil aus dem Aufruf abgeleitet (`ask:<call_id>`), damit ein Re-Aufruf dieselbe Frage trifft. */
  askId: string;
  question: string;
  options: AskOption[];
}

export type AskResolution =
  | { status: "pending"; askId: string }
  | { status: "answered"; askId: string; choice: string; choiceLabel: string; decidedAt: Date }
  | { status: "dismissed"; askId: string; reason: string; decidedAt: Date };

export interface AnswerReport {
  askId: string;
  choice: string;
  choiceLabel: string;
}

const LOCK_SESSION_SQL = `
  SELECT session_id FROM kuronami.sessions WHERE session_id = $1 FOR UPDATE
`;

interface AskTrace {
  request?: EventRecord;
  decision?: EventRecord;
}

/** Der Stand einer `ask_id` im Protokoll: die (letzte) Anfrage und eine ihr folgende Entscheidung. */
function traceAsk(events: EventRecord[], askId: string): AskTrace {
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

function optionsOf(request: EventRecord): AskOption[] {
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

async function lockSession(client: PoolClient, sessionId: string): Promise<void> {
  const found = await client.query(LOCK_SESSION_SQL, [sessionId]);
  if (found.rowCount === 0) throw new Error(`Session ${sessionId} existiert nicht`);
}

function resolutionFrom(trace: AskTrace): AskResolution | null {
  if (trace.decision?.type === "approval.granted") {
    return {
      status: "answered",
      askId: trace.decision.payload.ask_id as string,
      choice: trace.decision.payload.choice as string,
      choiceLabel: (trace.decision.payload.choice_label as string) ?? "",
      decidedAt: trace.decision.createdAt,
    };
  }
  if (trace.decision?.type === "approval.denied") {
    return {
      status: "dismissed",
      askId: trace.decision.payload.ask_id as string,
      reason: (trace.decision.payload.reason as string) ?? "",
      decidedAt: trace.decision.createdAt,
    };
  }
  if (trace.request) {
    return { status: "pending", askId: trace.request.payload.ask_id as string };
  }
  return null;
}

/**
 * Stellt eine Rückfrage bzw. holt ihre Antwort. Das ist, was der `user.ask`-Handler aufruft:
 *
 *   * ist die Rückfrage schon beantwortet → `answered`/`dismissed`, der Handler baut daraus
 *     die Tool-Hülle und der Lauf geht weiter;
 *   * ist sie offen → `pending`; der Handler wirft dann `UserInputRequiredError` und der Lauf
 *     hält an;
 *   * gibt es sie noch nicht → schreibt `approval.requested` (genau einmal) und meldet
 *     `pending`.
 */
export async function askUserInput(
  pool: Pool,
  sessionId: string,
  spec: AskSpec,
): Promise<AskResolution> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockSession(client, sessionId);

    const events = await readEvents(pool, sessionId);
    const resolved = resolutionFrom(traceAsk(events, spec.askId));
    if (resolved) {
      // Nichts zu schreiben: die Rückfrage steht schon (offen oder entschieden). Ein zweiter
      // `approval.requested` zur selben `ask_id` wäre Doppelrauschen im Protokoll.
      await client.query("COMMIT");
      return resolved;
    }

    await appendEventInTx(client, sessionId, "approval.requested", {
      ask_id: spec.askId,
      kind: "user_ask",
      question: redactText(spec.question),
      options: spec.options.map((option) => ({
        id: option.id,
        label: redactText(option.label),
      })),
    });
    await client.query("COMMIT");
    return { status: "pending", askId: spec.askId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Beantwortet eine offene Rückfrage. Der Mensch entscheidet (Abschnitt 10) — bis zum Gateway
 * (S16) ruft das der Betreiber bzw. der Test direkt. Schreibt `approval.granted` mit dem
 * vollständigen Freigabepfad (Auslöser, gewählte Option, Zeitstempel — Abschnitt 10).
 */
export async function answerUserInput(
  pool: Pool,
  sessionId: string,
  askId: string,
  choiceId: string,
  opts: { decidedBy?: string } = {},
): Promise<AnswerReport> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockSession(client, sessionId);

    const trace = traceAsk(await readEvents(pool, sessionId), askId);
    if (!trace.request || trace.decision) {
      throw new UserInputNotPendingError(
        `Zu ask_id "${askId}" steht in Session ${sessionId} keine offene Rückfrage${
          trace.decision ? " (sie ist bereits entschieden)" : ""
        }.`,
      );
    }

    const option = optionsOf(trace.request).find((entry) => entry.id === choiceId);
    if (!option) {
      const known = optionsOf(trace.request)
        .map((entry) => entry.id)
        .join(", ");
      throw new UnknownAskOptionError(
        `Option "${choiceId}" gehört nicht zu ask_id "${askId}" (angeboten: ${known || "keine"}).`,
      );
    }

    await appendEventInTx(client, sessionId, "approval.granted", {
      ask_id: askId,
      kind: "user_ask",
      choice: option.id,
      choice_label: option.label,
      question: trace.request.payload.question ?? null,
      decided_by: opts.decidedBy ?? "operator",
    });
    await client.query("COMMIT");
    return { askId, choice: option.id, choiceLabel: option.label };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Weist eine offene Rückfrage ab, ohne eine der Optionen zu wählen. Schreibt
 * `approval.denied`; der `user.ask`-Handler meldet das nächste Mal `dismissed`, und der Lauf
 * entscheidet selbst, wie er ohne Antwort weitermacht.
 */
export async function dismissUserInput(
  pool: Pool,
  sessionId: string,
  askId: string,
  reason: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockSession(client, sessionId);

    const trace = traceAsk(await readEvents(pool, sessionId), askId);
    if (!trace.request || trace.decision) {
      throw new UserInputNotPendingError(
        `Zu ask_id "${askId}" steht in Session ${sessionId} keine offene Rückfrage.`,
      );
    }

    await appendEventInTx(client, sessionId, "approval.denied", {
      ask_id: askId,
      kind: "user_ask",
      reason: redactText(reason),
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Die offenen Rückfragen einer Session, aus dem Protokoll gefaltet. Kein Seiteneffekt. */
export async function readPendingUserInput(
  pool: Pool,
  sessionId: string,
): Promise<PendingUserInput[]> {
  return deriveSessionState(sessionId, await readEvents(pool, sessionId)).pendingUserInput;
}
