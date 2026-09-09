import { createHash } from "node:crypto";
import type { EventRecord } from "../runtime/events/log.js";
import type { AskOption } from "../runtime/session/state.js";
import { type ChannelId, type Sender, isChannelId } from "./types.js";

/**
 * **Freigabeanfragen gehen an den passenden Kanal** (Auftrag S16) — hergeleitet aus dem
 * Protokoll, nicht gemerkt.
 *
 * Der passende Kanal ist der, über den zuletzt etwas hereinkam, bevor der Lauf anhielt: wer
 * per Telegram eine Aufgabe gibt, bekommt die Rückfrage dazu per Telegram. Das ließe sich mit
 * einer `Map<askId, channel>` im Prozess erledigen — und wäre genau so lange richtig, bis das
 * Gateway neu startet. Danach stünde im Protokoll eine offene Rückfrage, zu der niemand mehr
 * wüsste, wohin sie gehört; sie käme nie an, und der Lauf wartete für immer.
 *
 * Also dieselbe Bauart wie `deriveSessionState` (S05), `deriveLoopState` (S12) und
 * `derivePolicyApprovals` (S11): eine **reine Funktion über Ereignisse**. Sie nimmt
 * Ereignisse entgegen und sonst nichts — es gibt keinen Parameter, über den ein Seiteneffekt
 * hereinkäme, und keinen Zustand, den ein Neustart verlöre.
 *
 * Möglich wird das durch die beiden `gateway.*`-Ereignisse (S16):
 *
 *   * `gateway.received` trägt Kanal und Absender jeder Nachricht **und jeder Entscheidung**.
 *     Auch eine Entscheidung verschiebt die Herkunft: wer eine Rückfrage per Telegram
 *     beantwortet, bekommt die nächste des fortgesetzten Laufs ebenfalls per Telegram — sein
 *     letztes Wort kam von dort.
 *   * `gateway.delivered` hält fest, was schon hinausging. Ohne das schickte ein neu
 *     gestarteter Prozess jede noch offene Rückfrage erneut, und der Nutzer sähe dieselbe
 *     Frage nach jedem Neustart ein weiteres Mal.
 */

/** Wohin eine Rückfrage gehört, samt allem, was der Kanal zum Zustellen braucht. */
export interface AskRoute {
  askId: string;
  /** `policy` (S11) oder `user_ask` (S10). Der Kanal darf beide gleich anzeigen. */
  kind: string;
  question: string;
  options: AskOption[];
  /** Der Kanal, über den zuletzt etwas hereinkam, bevor die Rückfrage entstand. */
  to: Sender;
  /** Steht schon ein `gateway.delivered` zu dieser `ask_id`? */
  delivered: boolean;
}

/** Die Herkunft einer Nachricht, wie sie im `gateway.received` steht. */
function senderOf(payload: Record<string, unknown>): Sender | null {
  const channel = payload.channel;
  const sender = payload.sender as Record<string, unknown> | undefined;
  if (!isChannelId(channel) || typeof sender !== "object" || sender === null) return null;
  const channelUserId = sender.channel_user_id;
  const replyTo = sender.reply_to;
  if (typeof channelUserId !== "string" || typeof replyTo !== "string") return null;
  return {
    channel,
    channelUserId,
    replyTo,
    displayName: typeof sender.display_name === "string" ? sender.display_name : channelUserId,
  };
}

function optionsOf(payload: Record<string, unknown>): AskOption[] {
  const value = payload.options;
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

/**
 * Die **offenen** Rückfragen mit ihrem Kanal, in Reihenfolge ihrer Entstehung.
 *
 * Offen heißt hier dasselbe wie in `deriveSessionState`: ein `approval.requested`, zu dem
 * kein `approval.granted`/`approval.denied` mit derselben `ask_id` folgt.
 */
export function deriveAskRoutes(events: EventRecord[]): AskRoute[] {
  const open = new Map<string, AskRoute>();
  let origin: Sender | null = null;

  for (const event of events) {
    switch (event.type) {
      case "gateway.received": {
        const sender = senderOf(event.payload);
        if (sender) origin = sender;
        break;
      }

      case "approval.requested": {
        const askId = event.payload.ask_id;
        if (typeof askId !== "string") break;
        // Ohne Herkunft gibt es keinen passenden Kanal. Das ist der Fall einer Session, die
        // nicht über das Gateway gestartet wurde (`pnpm run:task`, DevUI, ein Test) — sie
        // taucht hier gar nicht erst auf, statt willkürlich irgendwo zugestellt zu werden.
        if (!origin) break;
        open.set(askId, {
          askId,
          kind: typeof event.payload.kind === "string" ? event.payload.kind : "unbekannt",
          question: typeof event.payload.question === "string" ? event.payload.question : askId,
          options: optionsOf(event.payload),
          to: origin,
          delivered: false,
        });
        break;
      }

      case "approval.granted":
      case "approval.denied": {
        const askId = event.payload.ask_id;
        if (typeof askId === "string") open.delete(askId);
        break;
      }

      case "gateway.delivered": {
        const askId = event.payload.ask_id;
        const found = typeof askId === "string" ? open.get(askId) : undefined;
        if (found) found.delivered = true;
        break;
      }

      default:
        break;
    }
  }

  return [...open.values()];
}

/**
 * Ist unter dieser Kanal-Kennung schon etwas eingegangen?
 *
 * Telegram stellt ein Update erneut zu, wenn die Bestätigung verlorenging — nach einem
 * Absturz mitten in der Bearbeitung ist das der Normalfall und nicht die Ausnahme. Ohne
 * diese Prüfung liefe dieselbe Nachricht ein zweites Mal als eigener Zug, mit allem, was
 * daran hängt: ein zweiter Modellaufruf, ein zweiter Seiteneffekt, eine zweite Rechnung.
 *
 * Die Idempotenz kommt dabei aus dem Protokoll und nicht aus einem Speicher im Prozess —
 * dasselbe Muster wie beim Idempotenzschlüssel der Ausführungshülle (S05) und bei der
 * einmaligen Rückfrage in `user.ask` (S10). Nur so trägt sie über einen Neustart hinweg,
 * und genau dann wird sie gebraucht.
 */
export function hasReceived(events: EventRecord[], externalId: string): boolean {
  return events.some(
    (event) => event.type === "gateway.received" && event.payload.external_id === externalId,
  );
}

/** Die Herkunft der letzten eingegangenen Nachricht — wohin eine Antwort geht. */
export function deriveLastOrigin(events: EventRecord[]): Sender | null {
  let origin: Sender | null = null;
  for (const event of events) {
    if (event.type !== "gateway.received") continue;
    const sender = senderOf(event.payload);
    if (sender) origin = sender;
  }
  return origin;
}

/**
 * Eine kurze, stabile Referenz auf eine `ask_id`.
 *
 * Der Grund ist eine harte Grenze von Telegram: `callback_data` eines Inline-Knopfes darf
 * **64 Byte** nicht überschreiten, sonst weist die API den ganzen Knopf ab
 * (`BUTTON_DATA_INVALID`). Eine `ask_id` ist `policy:<call_id>`, und `call_id` ist die
 * `tool_use`-Kennung des Anbieters — heute rund dreißig Zeichen, morgen so lang, wie der
 * Anbieter will. Zusammen mit der gewählten Option wäre die Grenze irgendwann gerissen, und
 * zwar nicht beim Testen, sondern beim längsten Aufruf im Betrieb.
 *
 * Deshalb geht nicht die Kennung mit, sondern ihre ersten zwölf Hexstellen aus SHA-256. Das
 * ist keine Verschleierung — die Referenz ist **ableitbar und zustandslos**: `resolveAskRef`
 * bildet sie für jede offene Rückfrage des Protokolls neu und vergleicht. Kein Speicher, kein
 * Ablauf, und nach einem Neustart funktioniert ein Knopf von vorhin unverändert.
 *
 * Zwölf Hexstellen sind 48 Bit. Kollidieren müssten zwei **gleichzeitig offene** Rückfragen
 * derselben Session; davon gibt es in der Praxis eine, selten zwei. `resolveAskRef` meldet
 * eine Kollision trotzdem als Fehler, statt eine der beiden zu raten.
 */
export function askRef(askId: string): string {
  return createHash("sha256").update(askId, "utf8").digest("hex").slice(0, 12);
}

export type AskRefLookup =
  | { status: "found"; route: AskRoute }
  | { status: "unknown" }
  | { status: "ambiguous"; askIds: string[] };

/** Sucht die offene Rückfrage zu einer kurzen Referenz. Ohne Speicher, rein aus dem Protokoll. */
export function resolveAskRef(routes: AskRoute[], ref: string): AskRefLookup {
  const matches = routes.filter((route) => askRef(route.askId) === ref);
  if (matches.length === 0) return { status: "unknown" };
  if (matches.length > 1) {
    return { status: "ambiguous", askIds: matches.map((route) => route.askId) };
  }
  return { status: "found", route: matches[0] };
}
