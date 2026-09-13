import type { AskOption } from "../runtime/session/state.js";

/**
 * Die **normalisierte Nachrichtenform** (S16) und die Schnittstelle, die jeder Kanal erfüllt.
 *
 * Das ist der ganze Zweck der Surface-Schicht: was ein Kanal hereinreicht, sieht danach
 * gleich aus, egal ob es aus einem HTTP-POST oder aus einem Telegram-Update kam. Alles, was
 * unterhalb dieser Datei liegt — Unterhaltung, Lauf, Freigabe —, kennt nur noch diese Form
 * und keinen Kanal mehr.
 *
 * Die fünf Felder sind die aus dem Auftrag: **Kanal, Absender, Inhalt, Anhänge, Zeit**. Dazu
 * kommt `externalId`, weil ein Kanal dieselbe Nachricht zweimal zustellen kann (Telegram
 * wiederholt ein Update, wenn die Antwort auf den Webhook verlorengeht) — ohne eine Kennung
 * des Kanals ließe sich das nicht erkennen.
 *
 * **Diese Datei kennt die Runtime nicht.** Sie importiert genau einen Typ (`AskOption`), weil
 * die Optionen einer Rückfrage aus dem Protokoll kommen und ein Kanal sie unverändert
 * anzeigen muss — sie nachzubauen hieße, zwei Formen derselben Sache zu pflegen. Die Richtung
 * stimmt: `gateway/` darf auf `runtime/` zeigen, umgekehrt nie (Abschnitt 3, harte Regel).
 */

/**
 * Die Kanäle, die das Gateway heute bedient. Mail kommt später dazu.
 *
 * `voice` seit S30: die Sprachschicht ist ein **eigener Prozess** (Python, Pipecat, siehe
 * `voice/`), und er redet mit diesem Gateway genauso wie Telegram oder Slack — über HTTP, mit
 * einem eigenen Geheimnis, in der normalisierten Nachrichtenform. Dass er woanders läuft und in
 * einer anderen Sprache geschrieben ist, ändert an seiner Rolle nichts: er ist ein Kanal.
 */
export type ChannelId = "web" | "telegram" | "slack" | "voice";

export const CHANNEL_IDS: readonly ChannelId[] = ["web", "telegram", "slack", "voice"];

export function isChannelId(value: unknown): value is ChannelId {
  return typeof value === "string" && (CHANNEL_IDS as readonly string[]).includes(value);
}

/**
 * Wer schreibt — und wohin die Antwort geht.
 *
 * `channelUserId` und `replyTo` sind absichtlich zwei Felder und nicht eines. Bei Telegram
 * sind sie im Einzelchat gleich (Nutzerkennung = Chatkennung) und in einer Gruppe verschieden;
 * sie zusammenzulegen hieße, sich auf den Einzelchat festzulegen und es beim ersten
 * Gruppenchat still falsch zu machen. Authentifiziert wird über `channelUserId`, zugestellt
 * über `replyTo`.
 */
export interface Sender {
  channel: ChannelId;
  /** Die Kennung, unter der der Kanal den Absender führt. Daran hängt die Authentifizierung. */
  channelUserId: string;
  /** Anzeigename, wie der Kanal ihn liefert. Reine Anzeige, nie eine Berechtigung. */
  displayName: string;
  /** Wohin eine Antwort auf diesem Kanal geht (Telegram: Chatkennung, Web: Aufrufer-Sitzung). */
  replyTo: string;
}

/**
 * Ein Anhang, bereits als Bytes.
 *
 * Der Kanal löst seine eigene Umständlichkeit **vor** dieser Grenze auf: Telegram gibt eine
 * `file_id`, aus der erst über zwei weitere HTTP-Aufrufe eine Datei wird. Käme die `file_id`
 * bis hierher durch, müsste jede Schicht dahinter wissen, wie man sie einlöst — und der Kern
 * wäre wieder kanalabhängig. Deshalb stehen hier Bytes, und der Kanal hat sie beschafft.
 */
export interface InboundAttachment {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

/** Eine eingehende Nachricht, normalisiert. */
export interface InboundMessage {
  channel: ChannelId;
  sender: Sender;
  content: string;
  attachments: InboundAttachment[];
  receivedAt: Date;
  /** Die Kennung, unter der der Kanal diese Nachricht führt. */
  externalId: string;
}

/**
 * Eine eingehende **Entscheidung**: der Nutzer hat auf eine Rückfrage geantwortet.
 *
 * Bewusst ein eigener Typ und keine Nachricht mit Sonderbedeutung. Eine Entscheidung startet
 * keinen neuen Zug, sie löst einen angehaltenen auf; sie als Nachricht durchzureichen hieße,
 * diesen Unterschied irgendwo weiter unten an einem Textmuster wieder herauszuraten.
 */
export interface InboundDecision {
  channel: ChannelId;
  sender: Sender;
  /** Die `ask_id` aus dem `approval.requested` — `policy:<call_id>` oder `ask:<call_id>`. */
  askId: string;
  choiceId: string;
  receivedAt: Date;
  externalId: string;
}

/** Eine Antwort des Agenten. */
export interface OutboundReply {
  kind: "reply";
  text: string;
}

/**
 * Eine Freigabeanfrage. Der Kanal zeigt die Optionen so an, wie er kann (Telegram: Knöpfe,
 * Web: eine Liste), aber er **erfindet keine**: sie kommen aus dem Protokoll (Abschnitt 10,
 * "strukturierte Optionen, kein Fließtext").
 */
export interface OutboundApproval {
  kind: "approval";
  askId: string;
  question: string;
  options: AskOption[];
}

export type Outbound = OutboundReply | OutboundApproval;

/**
 * Was ein Kanal können muss. Genau eine Methode — mehr braucht der Kern nicht, und alles
 * darüber hinaus wäre eine Eigenschaft eines bestimmten Kanals, die die anderen mittragen
 * müssten.
 */
export interface ChannelPort {
  readonly id: ChannelId;
  /** Stellt zu. Wirft, wenn die Zustellung scheitert — ein verschluckter Fehler hieße hier,
   * dass eine Freigabeanfrage nie ankommt und der Lauf für immer wartet. */
  deliver(to: Sender, message: Outbound): Promise<void>;
}

export type ChannelRegistry = ReadonlyMap<ChannelId, ChannelPort>;

/** Der Kanal ist nicht konfiguriert. Passiert, wenn eine alte Session auf ihn zeigt. */
export class UnknownChannelError extends Error {
  constructor(readonly channel: string) {
    super(`Kanal "${channel}" ist in diesem Gateway nicht eingerichtet.`);
    this.name = "UnknownChannelError";
  }
}

export function channelOrThrow(channels: ChannelRegistry, id: ChannelId): ChannelPort {
  const found = channels.get(id);
  if (!found) throw new UnknownChannelError(id);
  return found;
}
