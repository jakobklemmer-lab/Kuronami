import type { TelegramMessage, TelegramUpdate, TelegramUser } from "./client.js";

/**
 * Telegram-Update → normalisierte Form. **Ohne Netz und ohne Nebenwirkung.**
 *
 * Die Trennung in zwei Schritte ist die eigentliche Entscheidung dieser Datei: hier wird das
 * Update nur *beschrieben*, die Anhänge werden noch nicht geholt. Ein Anhang kostet zwei
 * HTTP-Aufrufe und bis zu zwanzig Megabyte Arbeitsspeicher — beides für einen Absender
 * auszugeben, der gleich abgewiesen wird, wäre eine offene Tür für jeden, der die
 * Bot-Kennung kennt. Beschreiben, authentifizieren, **dann** holen (`channel.ts`).
 *
 * Dass hier nichts nach draußen geht, ist dabei keine Zusage der Sorgfalt, sondern eine
 * Eigenschaft der Signatur: es gibt keinen Parameter, über den ein Client hereinkäme —
 * dasselbe Argument wie bei `headArtifact` (S06) und `deriveSessionState` (S05).
 */

/** Ein Anhang, wie Telegram ihn ankündigt: eine Kennung, aus der erst noch eine Datei wird. */
export interface TelegramAttachmentRef {
  fileId: string;
  name: string;
  mimeType: string;
  /** Was Telegram über die Größe sagt. `null`, wenn nichts dabeisteht. */
  sizeBytes: number | null;
}

export interface DescribedSender {
  id: string;
  displayName: string;
  chatId: string;
}

export type DescribedUpdate =
  | {
      kind: "message";
      updateId: number;
      sender: DescribedSender;
      externalId: string;
      content: string;
      attachments: TelegramAttachmentRef[];
      receivedAt: Date;
    }
  | {
      kind: "decision";
      updateId: number;
      sender: DescribedSender;
      externalId: string;
      callbackQueryId: string;
      /** Die kurze Referenz aus `askRef` (S16) — nicht die `ask_id` selbst, siehe dort. */
      askRef: string;
      choiceId: string;
      receivedAt: Date;
    }
  | { kind: "ignored"; updateId: number; reason: string };

/** Trennzeichen in `callback_data`. Kommt weder in einem Hex-Ref noch in einer Options-Kennung vor. */
const CALLBACK_SEPARATOR = "|";

/** Baut die `callback_data` eines Knopfes. Gegenstück zu `decodeCallbackData`. */
export function encodeCallbackData(askRef: string, choiceId: string): string {
  return `${askRef}${CALLBACK_SEPARATOR}${choiceId}`;
}

export function decodeCallbackData(
  data: string,
): { askRef: string; choiceId: string } | { error: string } {
  const at = data.indexOf(CALLBACK_SEPARATOR);
  if (at <= 0 || at === data.length - 1) {
    return { error: `callback_data "${data}" hat nicht die Form <ask_ref>|<option>.` };
  }
  return { askRef: data.slice(0, at), choiceId: data.slice(at + 1) };
}

function displayNameOf(user: TelegramUser | undefined): string {
  if (!user) return "unbekannt";
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  if (name.length > 0) return name;
  if (user.username) return `@${user.username}`;
  return String(user.id);
}

const EXTENSION_MIME: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
};

/**
 * Der MIME-Typ eines Anhangs. Telegram nennt ihn meist selbst; sonst wird er aus der Endung
 * geraten, und wo auch das nicht trägt, bleibt es beim ehrlichen `application/octet-stream`.
 * Ein falsch geratener Typ wäre schlimmer als ein unbestimmter: er stünde später als Tatsache
 * in den Artefaktmetadaten.
 */
function mimeFor(declared: string | undefined, name: string): string {
  if (declared && declared.trim().length > 0) return declared.trim();
  const dot = name.lastIndexOf(".");
  if (dot >= 0) {
    const found = EXTENSION_MIME[name.slice(dot).toLowerCase()];
    if (found) return found;
  }
  return "application/octet-stream";
}

const PATH_SEPARATORS = /[\\/]/g;
const DOT_RUNS = /\.{2,}/g;

/**
 * Steuerzeichen werfen — über die Codepunkte und nicht über einen Zeichenbereich im Muster.
 *
 * Ein Steuerzeichenbereich in einem Regex-Literal ist eine Zeile, die man beim Lesen für einen
 * Tippfehler hält und beim Bearbeiten unbemerkt kaputtmacht; Biome verbietet sie aus genau dem
 * Grund. Der Vergleich hier sagt dasselbe und ist lesbar.
 */
function stripControlChars(value: string): string {
  let kept = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    kept += char;
  }
  return kept;
}

/**
 * Ein Dateiname ohne Pfadanteile.
 *
 * Er wird heute **nie zu einem Pfad**: der Artefaktspeicher vergibt seinen eigenen Dateinamen
 * (eine UUID, S06), dieser hier steht nur in der Zusammenfassung und im Protokoll. Trotzdem
 * fliegen Pfadtrenner, Punktfolgen und Steuerzeichen raus — der Name geht später in einen
 * Prompt und womöglich in eine Anzeige, und `../../etc/passwd` als Anhangsname ist an keiner
 * dieser Stellen etwas, das man weiterreicht. Dieselbe Haltung wie in `fs/paths.ts` und
 * `notes/paths.ts`: am Rand abweisen, statt darauf zu vertrauen, dass es weiter innen
 * niemanden stört. Bindestriche und Leerzeichen bleiben — die sind an einem Dateinamen normal.
 */
function safeName(name: string, fallback: string): string {
  const cleaned = stripControlChars(
    name.replace(PATH_SEPARATORS, "_").replace(DOT_RUNS, "_"),
  ).trim();
  return cleaned.length > 0 ? cleaned.slice(0, 200) : fallback;
}

function attachmentsOf(message: TelegramMessage): TelegramAttachmentRef[] {
  const found: TelegramAttachmentRef[] = [];

  if (message.document) {
    const name = safeName(message.document.file_name ?? "", `dokument_${message.message_id}`);
    found.push({
      fileId: message.document.file_id,
      name,
      mimeType: mimeFor(message.document.mime_type, name),
      sizeBytes: message.document.file_size ?? null,
    });
  }

  if (Array.isArray(message.photo) && message.photo.length > 0) {
    // Telegram schickt dasselbe Bild in mehreren Auflösungen, aufsteigend sortiert. Die
    // kleinste zu nehmen wäre bequem und falsch: der Nutzer hat das Bild geschickt, das er
    // meint, nicht eine Vorschau davon.
    const largest = message.photo.reduce((best, entry) =>
      (entry.file_size ?? 0) >= (best.file_size ?? 0) ? entry : best,
    );
    found.push({
      fileId: largest.file_id,
      name: `foto_${message.message_id}.jpg`,
      mimeType: "image/jpeg",
      sizeBytes: largest.file_size ?? null,
    });
  }

  for (const [media, prefix, fallbackMime] of [
    [message.voice, "sprachnachricht", "audio/ogg"],
    [message.audio, "audio", "audio/mpeg"],
    [message.video, "video", "video/mp4"],
  ] as const) {
    if (!media) continue;
    const declaredName = "file_name" in media ? media.file_name : undefined;
    const name = safeName(declaredName ?? "", `${prefix}_${message.message_id}`);
    found.push({
      fileId: media.file_id,
      name,
      mimeType: mimeFor(media.mime_type, name) || fallbackMime,
      sizeBytes: media.file_size ?? null,
    });
  }

  return found;
}

/**
 * Beschreibt ein Update. Kennt drei Ausgänge, und `ignored` ist einer davon: ein Bot bekommt
 * laufend Updates, die ihn nichts angehen (Beitritte, bearbeitete Nachrichten, Umfragen). Sie
 * als Fehler zu behandeln hieße, die Long-Polling-Schleife an fremdem Verkehr abbrechen zu
 * lassen.
 */
export function describeUpdate(
  update: TelegramUpdate,
  now: () => Date = () => new Date(),
): DescribedUpdate {
  const updateId = typeof update.update_id === "number" ? update.update_id : -1;

  if (update.callback_query) {
    const query = update.callback_query;
    const chatId = query.message?.chat?.id;
    if (typeof chatId !== "number") {
      return { kind: "ignored", updateId, reason: "callback_query ohne Chatbezug" };
    }
    if (typeof query.data !== "string") {
      return { kind: "ignored", updateId, reason: "callback_query ohne data" };
    }
    const decoded = decodeCallbackData(query.data);
    if ("error" in decoded) return { kind: "ignored", updateId, reason: decoded.error };

    return {
      kind: "decision",
      updateId,
      sender: {
        id: String(query.from.id),
        displayName: displayNameOf(query.from),
        chatId: String(chatId),
      },
      // Die Kennung des Knopfdrucks, nicht die der Nachricht darunter: zwei Drücke auf
      // denselben Knopf sind zwei Entscheidungen und müssen unterscheidbar bleiben.
      externalId: `callback:${query.id}`,
      callbackQueryId: query.id,
      askRef: decoded.askRef,
      choiceId: decoded.choiceId,
      receivedAt: now(),
    };
  }

  if (update.message) {
    const message = update.message;
    if (message.from?.is_bot === true) {
      return { kind: "ignored", updateId, reason: "Nachricht von einem Bot" };
    }
    const content = (message.text ?? message.caption ?? "").trim();
    const attachments = attachmentsOf(message);
    if (content.length === 0 && attachments.length === 0) {
      return { kind: "ignored", updateId, reason: "Nachricht ohne Text und ohne Anhang" };
    }

    return {
      kind: "message",
      updateId,
      sender: {
        id: message.from ? String(message.from.id) : "",
        displayName: displayNameOf(message.from),
        chatId: String(message.chat.id),
      },
      externalId: `message:${message.chat.id}:${message.message_id}`,
      content,
      attachments,
      // Telegram zählt in Sekunden seit Epoche. Fehlt das Feld, ist die Ankunftszeit hier die
      // ehrlichste Angabe — geraten wird nichts.
      receivedAt: typeof message.date === "number" ? new Date(message.date * 1000) : now(),
    };
  }

  return { kind: "ignored", updateId, reason: "Update ohne message und ohne callback_query" };
}
