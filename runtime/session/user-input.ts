import type { Pool } from "pg";
import { appendEventInTx, readEvents } from "../events/log.js";
import { redactText } from "../redaction/redact.js";
import type { JsonValue } from "../steps/types.js";
import { type AskKind, type AskTrace, lockSession, optionsOf, traceAsk } from "./approval-log.js";
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
  /**
   * Die Art der Rückfrage. Vorgabe `user_ask` — das ist jede Frage, die das Modell über
   * `user.ask` stellt.
   */
  kind?: AskKind;
  /**
   * Was zur Entscheidung gehört, wenn die Frage mehr trägt als ihren Wortlaut (S19).
   *
   * `agent.create` legt hier das entworfene Profil ab, und das ist kein Beiwerk, sondern der
   * Grund, aus dem der Entwurf einen Neustart überlebt: der Modellaufruf, der ihn gebaut hat,
   * läuft **einmal**: findet der Handler beim Fortsetzen sein `approval.requested` wieder,
   * liest er den Entwurf von dort statt ein zweites Mal zu fragen — und was eingetragen wird,
   * ist dadurch nachweislich genau das, was der Nutzer bestätigt hat, und nicht eine zweite,
   * ähnliche Antwort desselben Modells.
   *
   * Der Aufrufer ist dafür verantwortlich, dass hier nichts Ungefiltertes hineingeht: dieses
   * Modul redigiert Frage und Beschriftungen (siehe unten), aber es kennt die Form von
   * `details` nicht.
   */
  details?: Record<string, JsonValue>;
}

/**
 * Was der Frage beilag (`AskSpec.details`), zurückgelesen aus dem `approval.requested`. Steht
 * bei jedem Ausgang mit dabei — auch bei `answered`: wer eine Entscheidung auswertet, braucht
 * das, worüber entschieden wurde, und soll es nicht ein zweites Mal herstellen müssen (S19).
 */
export type AskDetails = Record<string, JsonValue> | null;

export type AskResolution =
  | { status: "pending"; askId: string; details: AskDetails }
  | {
      status: "answered";
      askId: string;
      choice: string;
      choiceLabel: string;
      decidedAt: Date;
      /** Wer entschieden hat — der Freigabepfad aus Abschnitt 10, an seinem Ende. */
      decidedBy: string;
      details: AskDetails;
    }
  | { status: "dismissed"; askId: string; reason: string; decidedAt: Date; details: AskDetails };

export interface AnswerReport {
  askId: string;
  choice: string;
  choiceLabel: string;
}

// Sperre, Ablaufverfolgung und Optionslesen liegen seit S11 in `./approval-log.ts`: die
// Policy-Engine benutzt dieselbe Mechanik für ihre Freigabe-Rückfragen, und zwei Kopien
// wären zwei Formen desselben Ereignisses.

function detailsOf(trace: AskTrace): AskDetails {
  const value = trace.request?.payload.details;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, JsonValue>;
}

function resolutionFrom(trace: AskTrace): AskResolution | null {
  const details = detailsOf(trace);
  if (trace.decision?.type === "approval.granted") {
    return {
      status: "answered",
      askId: trace.decision.payload.ask_id as string,
      choice: trace.decision.payload.choice as string,
      choiceLabel: (trace.decision.payload.choice_label as string) ?? "",
      decidedAt: trace.decision.createdAt,
      decidedBy: (trace.decision.payload.decided_by as string) ?? "operator",
      details,
    };
  }
  if (trace.decision?.type === "approval.denied") {
    return {
      status: "dismissed",
      askId: trace.decision.payload.ask_id as string,
      reason: (trace.decision.payload.reason as string) ?? "",
      decidedAt: trace.decision.createdAt,
      details,
    };
  }
  if (trace.request) {
    return { status: "pending", askId: trace.request.payload.ask_id as string, details };
  }
  return null;
}

/** Die Art der Rückfrage, wie sie in der Anfrage steht. Vorgabe `user_ask` (S10-Bestand). */
function kindOf(trace: AskTrace): AskKind {
  const value = trace.request?.payload.kind;
  return value === "policy" || value === "agent_create" ? value : "user_ask";
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
      kind: spec.kind ?? "user_ask",
      question: redactText(spec.question),
      options: spec.options.map((option) => ({
        id: option.id,
        label: redactText(option.label),
      })),
      ...(spec.details ? { details: spec.details } : {}),
    });
    await client.query("COMMIT");
    return { status: "pending", askId: spec.askId, details: spec.details ?? null };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Der Stand einer Rückfrage, **ohne** sie zu stellen. `null`, wenn es sie noch nicht gibt.
 *
 * Der Unterschied zu `askUserInput` ist der ganze Zweck (S19): dort entsteht die Frage, wenn
 * sie fehlt. Wer sie erst **bauen** muss — `agent.create` fragt dafür ein Modell —, braucht
 * vorher die Auskunft, ob das überhaupt nötig ist. Ohne diesen Blick liefe bei jedem
 * Fortsetzen ein zweiter Modellaufruf, und der Entwurf, den der Nutzer bestätigt, wäre nicht
 * mehr sicher derselbe, den er gesehen hat.
 */
export async function peekAsk(
  pool: Pool,
  sessionId: string,
  askId: string,
): Promise<AskResolution | null> {
  return resolutionFrom(traceAsk(await readEvents(pool, sessionId), askId));
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
      // Die Entscheidung trägt die Art **der Frage**, nicht die dieses Schreibwegs (S19): eine
      // Rückfrage von `agent.create` wird hier beantwortet wie jede andere, und ein Protokoll,
      // in dem die Anfrage `agent_create` heißt und ihre Antwort `user_ask`, ließe sich nur
      // noch über die `ask_id` zusammenlesen.
      kind: kindOf(trace),
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
      // Wie bei `answerUserInput`: die Art der Frage, nicht die dieses Schreibwegs.
      kind: kindOf(trace),
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
