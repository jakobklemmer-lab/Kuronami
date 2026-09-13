/**
 * Beschreibt ein rohes Slack-Ereignis — kein Netz, keine Wirkung, reine Funktion, wie
 * `describeUpdate` beim Telegram-Kanal.
 *
 * Slacks Events API schickt zwei Formen an dieselbe Request-URL:
 *
 *   * `{type: "url_verification", challenge}` — einmalig beim Einrichten, keine echte
 *     Zustellung. Wird von `server.ts` direkt beantwortet, ohne den Kanal zu bemühen.
 *   * `{type: "event_callback", event_id, event: {...}}` — die eigentliche Zustellung.
 *     `event.type` ist entweder `"message"` oder `"reaction_added"`.
 *
 * Ignoriert werden: Nachrichten von Bots (`bot_id` gesetzt — sonst reagiert der eigene Bot auf
 * sich selbst), Nachrichten mit einem `subtype` (`message_changed`, `message_deleted`, …, nur
 * unveränderte neue Nachrichten zählen), und jede Reaktion, deren Name kein bekanntes
 * Ziffern-Emoji ist.
 */

export interface SlackSender {
  userId: string;
  channel: string;
  displayName: string;
}

export type DescribedSlackEvent =
  | { kind: "ignored"; reason: string }
  | { kind: "url_verification"; challenge: string }
  | {
      kind: "message";
      sender: SlackSender;
      ts: string;
      threadTs: string | null;
      text: string;
      receivedAt: Date;
      externalId: string;
    }
  | {
      kind: "reaction";
      sender: SlackSender;
      itemTs: string;
      reactionName: string;
      receivedAt: Date;
      externalId: string;
    };

/** Slacks Kurznamen für Ziffern-Emoji, Index 0 = "1.". Bewusst bei neun gedeckelt (siehe channel.ts). */
export const NUMBER_EMOJI: readonly string[] = [
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
];

export function emojiForOption(index: number): string | null {
  return NUMBER_EMOJI[index] ?? null;
}

/** Der 1-basierte Options-Index zu einem Reaktionsnamen, oder `null` bei einem unbekannten Emoji. */
export function optionIndexForReaction(reactionName: string): number | null {
  const index = NUMBER_EMOJI.indexOf(reactionName);
  return index === -1 ? null : index;
}

interface RawSlackEvent {
  type?: string;
  user?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  text?: string;
  bot_id?: string;
  subtype?: string;
  reaction?: string;
  item?: { type?: string; channel?: string; ts?: string };
  item_user?: string;
}

interface RawSlackBody {
  type?: string;
  challenge?: string;
  event_id?: string;
  event?: RawSlackEvent;
}

export function isUrlVerification(body: unknown): body is { challenge: string } {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as RawSlackBody).type === "url_verification" &&
    typeof (body as RawSlackBody).challenge === "string"
  );
}

export function describeSlackEvent(
  body: unknown,
  now: () => Date = () => new Date(),
): DescribedSlackEvent {
  if (typeof body !== "object" || body === null) {
    return { kind: "ignored", reason: "Der Anfragekörper ist kein Objekt." };
  }
  const raw = body as RawSlackBody;

  if (raw.type === "url_verification") {
    if (typeof raw.challenge !== "string") {
      return { kind: "ignored", reason: "url_verification ohne challenge." };
    }
    return { kind: "url_verification", challenge: raw.challenge };
  }

  if (raw.type !== "event_callback" || typeof raw.event !== "object" || raw.event === null) {
    return { kind: "ignored", reason: `Unbekannter Ereignistyp "${raw.type ?? "(fehlt)"}".` };
  }
  const event = raw.event;
  const eventId = raw.event_id ?? "";
  const receivedAt = now();

  if (event.type === "message") {
    if (typeof event.bot_id === "string" && event.bot_id.length > 0) {
      return { kind: "ignored", reason: "Nachricht stammt von einem Bot." };
    }
    if (typeof event.subtype === "string" && event.subtype.length > 0) {
      return { kind: "ignored", reason: `Nachricht trägt subtype "${event.subtype}".` };
    }
    if (
      typeof event.user !== "string" ||
      typeof event.channel !== "string" ||
      typeof event.ts !== "string"
    ) {
      return { kind: "ignored", reason: "message-Ereignis ohne user/channel/ts." };
    }
    return {
      kind: "message",
      sender: { userId: event.user, channel: event.channel, displayName: event.user },
      ts: event.ts,
      threadTs: typeof event.thread_ts === "string" ? event.thread_ts : null,
      text: typeof event.text === "string" ? event.text : "",
      receivedAt,
      externalId: `slack:${eventId || event.ts}`,
    };
  }

  if (event.type === "reaction_added") {
    if (
      typeof event.user !== "string" ||
      typeof event.reaction !== "string" ||
      typeof event.item?.ts !== "string" ||
      typeof event.item?.channel !== "string"
    ) {
      return { kind: "ignored", reason: "reaction_added-Ereignis ohne user/reaction/item." };
    }
    return {
      kind: "reaction",
      sender: { userId: event.user, channel: event.item.channel, displayName: event.user },
      itemTs: event.item.ts,
      reactionName: event.reaction,
      receivedAt,
      externalId: `slack:${eventId || `${event.item.ts}:${event.reaction}:${event.user}`}`,
    };
  }

  return { kind: "ignored", reason: `Unbekannter event.type "${event.type ?? "(fehlt)"}".` };
}

/**
 * Ordnet einen Thread-Antwort-Text einer Option zu: zuerst exakte `id`, dann
 * Groß-/Kleinschreibung-unabhängige `label`-Gleichheit, dann eine führende Zahl 1-basiert als
 * Index (`"1"`, `"1."`, `"1) ja"`). Kein Treffer → `null` — die Nachricht ist dann keine
 * Entscheidung, sondern ein normaler Gesprächsbeitrag.
 */
export function matchOptionByText(
  text: string,
  options: readonly { id: string; label: string }[],
): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  const byId = options.find((option) => option.id === trimmed);
  if (byId) return byId.id;

  const lower = trimmed.toLowerCase();
  const byLabel = options.find((option) => option.label.toLowerCase() === lower);
  if (byLabel) return byLabel.id;

  const leadingNumber = /^(\d+)/.exec(trimmed);
  if (leadingNumber) {
    const index = Number(leadingNumber[1]) - 1;
    if (index >= 0 && index < options.length) return options[index].id;
  }

  return null;
}
