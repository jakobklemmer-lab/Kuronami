import { createHmac, timingSafeEqual } from "node:crypto";
import { type ChannelId, type Sender, isChannelId } from "./types.js";

/**
 * **Authentifizierung am Gateway, nicht in der Runtime** (Auftrag S16).
 *
 * Das ist keine Ortsangabe, sondern eine Zusage über die Runtime: sie hat kein Feld, keinen
 * Parameter und keine Tabelle für "wer war das". Sie kennt eine Session, und dass hinter der
 * Session ein berechtigter Mensch steht, ist bereits entschieden, bevor irgendetwas aus
 * `runtime/` gerufen wird. Eine zweite Prüfung dort wäre nicht doppelt sicher, sondern eine
 * zweite Stelle, an der die Antwort auch anders ausfallen kann.
 *
 * Erzwungen wird das wie die Policy-Freigabe in S11 — über den Typ, nicht über Disziplin:
 * `receiveMessage`/`receiveDecision` verlangen einen `Principal`, und den stellt allein diese
 * Datei aus. `Identity` wird nur als **Typ** exportiert, die Klasse nie als Wert; zusammen mit
 * dem privaten Feld macht das den Typ nominal. Ein Objektliteral kann keinen Nutzer
 * vortäuschen, und der Weg an der Authentifizierung vorbei ist damit nicht verboten, sondern
 * nicht vorhanden.
 *
 * ## Ein Nutzer
 *
 * Phase 3 hat genau einen Nutzer (Abschnitt 1: Ein-Personen-System). Deshalb ist die
 * Identitätstabelle hier klein genug, um vollständig aus der Umgebung zu kommen: ein
 * Web-Token, ein Telegram-Webhook-Geheimnis, eine Liste erlaubter Telegram-Kennungen. Alle
 * zeigen auf **dieselbe** `userId` — und genau daraus folgt "ein Nutzer, ein Gedächtnis":
 * die Unterhaltung hängt an der `userId`, nicht am Kanal (siehe `conversation.ts`).
 *
 * Ein zweiter Nutzer wäre eine Tabelle statt einer Konstanten und sonst keine Änderung an
 * diesem Aufbau. Er wird hier nicht vorweggenommen, weil eine Nutzerverwaltung ohne zweiten
 * Nutzer nur eine ungeprüfte Vermutung darüber wäre, wie sie aussehen müsste.
 */

/**
 * Ein authentifizierter Absender. Nur `authenticate*` stellt sie aus.
 *
 * Die Klasse wird bewusst nicht als Wert exportiert, nur als Typ — dasselbe Muster wie
 * `PolicyGrant` (S11).
 */
class Identity {
  readonly #authMethod: string;

  constructor(
    readonly userId: string,
    readonly sender: Sender,
    authMethod: string,
  ) {
    this.#authMethod = authMethod;
  }

  /**
   * **Wie** der Absender geprüft wurde (`web:bearer`, `telegram:webhook`, `telegram:polling`) —
   * nie **womit**. Der Unterschied ist hier nicht nur sprachlich: der Wert geht ins
   * `gateway.received` und damit in den Freigabepfad aus Abschnitt 10, und ein Feld, in dem
   * ein Token stünde, wäre am Schreibtor des Protokolls zu Recht ersetzt worden.
   *
   * Genau das ist beim Bauen passiert: das Feld hieß erst `auth`, und der Redaction-Filter
   * hat es weggefiltert — `auth` steht in `SECRET_FIELD_NAMES`. Der Filter hatte recht; die
   * Korrektur war, das Feld nach dem zu benennen, was drinsteht.
   */
  get authMethod(): string {
    return this.#authMethod;
  }
}

export type Principal = Identity;

export type AuthFailureReason =
  | "missing_credential"
  | "bad_credential"
  | "unknown_sender"
  | "channel_not_configured";

export type AuthResult =
  | { ok: true; principal: Principal }
  | { ok: false; reason: AuthFailureReason; message: string };

/**
 * Die Identitätstabelle des Gateways. Aus der Umgebung gebaut (`identityFromEnv`), im Test
 * direkt gestellt.
 */
export interface GatewayIdentity {
  /** Der eine Nutzer. Bestimmt den Faden der Unterhaltung und damit das Gedächtnis. */
  userId: string;
  /** Bearer-Token des Web-Kanals. Leer heißt: der Web-Kanal nimmt nichts an. */
  webToken: string;
  /** Geheimnis im Header `X-Telegram-Bot-Api-Secret-Token`. Leer: Telegram nimmt nichts an. */
  telegramSecret: string;
  /** Erlaubte Telegram-Nutzerkennungen. Leer: Telegram nimmt nichts an. */
  telegramUserIds: readonly string[];
  /** Signiergeheimnis der Slack-App (Basic Information → Signing Secret). Leer: Slack nimmt nichts an. */
  slackSigningSecret: string;
  /** Erlaubte Slack-Nutzerkennungen. Leer: Slack nimmt nichts an. */
  slackUserIds: readonly string[];
  /**
   * Bearer-Token des Sprach-Kanals (S30). Leer heißt: der Kanal nimmt nichts an.
   *
   * Ein **eigener** Token und nicht `webToken`: die Sprachschicht ist ein zweiter Prozess mit
   * einem eigenen Lebenslauf, möglicherweise in einem eigenen Container. Ihn denselben Ausweis
   * tragen zu lassen wie den Browser hieße, dass ein Wechsel des einen den anderen aussperrt —
   * und dass ein abhandengekommener Token zwei Türen öffnet statt einer.
   */
  voiceToken: string;
  /**
   * `VOICE_SESSION_TOKEN` — das Geheimnis, das der **Browser** dem WebSocket-Rand der
   * Sprachschicht vorzeigt. Der Gateway prüft es nie; er reicht es nur an eine Oberfläche
   * weiter, die sich zuvor mit `webToken` ausgewiesen hat (`GET /channels/web/voice`).
   *
   * Das gibt keinen Zugang preis, den der Aufrufer nicht schon hätte: wer den `webToken` hält,
   * spricht bereits mit dem Agenten. Ihn abtippen zu lassen, was der Gateway ohnehin kennt,
   * wäre eine Hürde ohne Gegenwert — und eine, die auf jedem neuen Gerät wiederkäme.
   */
  voiceSessionToken: string;
}

/**
 * Zeichenkettenvergleich in konstanter Zeit.
 *
 * Ein `===` auf einem Token verrät über die Laufzeit, wie viele Zeichen am Anfang stimmen.
 * Das ist bei einem lokal laufenden Gateway kein dringendes Risiko und trotzdem der falsche
 * Ort zum Sparen: es kostet drei Zeilen, und der Kanal ist ab S16 die Außengrenze des ganzen
 * Systems.
 *
 * Verschiedene Längen werden vorher abgefangen — `timingSafeEqual` wirft dann. Die Länge ist
 * die eine Information, die dabei durchsickert; sie ist kein Geheimnis.
 */
function secretEquals(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Der Bearer-Token aus einem `Authorization`-Header, oder `null`. */
export function bearerToken(header: string | undefined): string | null {
  if (typeof header !== "string") return null;
  const match = /^Bearer[ ]+(.+)$/.exec(header.trim());
  return match ? match[1].trim() : null;
}

export interface WebCredential {
  token: string | null;
  /** Frei wählbarer Anzeigename des Aufrufers (Browserfenster, CLI). Nie eine Berechtigung. */
  displayName?: string;
  /**
   * Wohin die Antwort geht. Der Web-Kanal ist zustandslos: eine Antwort landet in dem
   * Postfach, das der Aufrufer nennt. Vorgabe ist die `userId` — ein einzelnes Postfach für
   * den einen Nutzer.
   */
  replyTo?: string;
}

/** Web: ein Bearer-Token, mehr nicht. Der Kanal hat keinen eigenen Nutzerbegriff. */
export function authenticateWeb(identity: GatewayIdentity, credential: WebCredential): AuthResult {
  if (identity.webToken.length === 0) {
    return {
      ok: false,
      reason: "channel_not_configured",
      message: "Der Web-Kanal ist ohne GATEWAY_WEB_TOKEN nicht bedienbar.",
    };
  }
  if (credential.token === null || credential.token.length === 0) {
    return {
      ok: false,
      reason: "missing_credential",
      message: "Es fehlt ein Bearer-Token im Authorization-Header.",
    };
  }
  if (!secretEquals(credential.token, identity.webToken)) {
    return { ok: false, reason: "bad_credential", message: "Der Bearer-Token stimmt nicht." };
  }

  const sender: Sender = {
    channel: "web",
    channelUserId: identity.userId,
    displayName: credential.displayName?.trim() || identity.userId,
    replyTo: credential.replyTo?.trim() || identity.userId,
  };
  return { ok: true, principal: new Identity(identity.userId, sender, "web:bearer") };
}

export interface VoiceCredential {
  token: string | null;
  /** Anzeigename der Sprachsitzung. Reine Anzeige, nie eine Berechtigung. */
  displayName?: string;
  /** Das Postfach dieser Sprachsitzung. Vorgabe `voice` — eine Sitzung je Nutzer. */
  replyTo?: string;
}

/**
 * Sprache: ein Bearer-Token, mehr nicht — dasselbe Muster wie beim Web-Kanal.
 *
 * **Eine Prüfung genügt hier, anders als bei Telegram und Slack**, und der Unterschied ist kein
 * Nachlassen: dort beweist das Geheimnis nur, dass die Zustellung *vom Anbieter* kommt, während
 * jeder Fremde dem Bot schreiben kann — deshalb dort zusätzlich die Absenderliste. Hier gibt es
 * keinen fremden Absender: die Gegenstelle ist der eigene Sprachprozess, und wer seinen Token
 * hat, ist der Betreiber. Die Frage "wer spricht da eigentlich ins Mikrofon" beantwortet dieser
 * Token allerdings **nicht** — sie ist offen und steht als solche in den Befunden zu S30.
 */
export function authenticateVoice(
  identity: GatewayIdentity,
  credential: VoiceCredential,
): AuthResult {
  if (identity.voiceToken.length === 0) {
    return {
      ok: false,
      reason: "channel_not_configured",
      message: "Der Sprach-Kanal ist ohne VOICE_BRIDGE_TOKEN nicht bedienbar.",
    };
  }
  if (credential.token === null || credential.token.length === 0) {
    return {
      ok: false,
      reason: "missing_credential",
      message: "Es fehlt ein Bearer-Token im Authorization-Header.",
    };
  }
  if (!secretEquals(credential.token, identity.voiceToken)) {
    return { ok: false, reason: "bad_credential", message: "Der Bearer-Token stimmt nicht." };
  }

  const sender: Sender = {
    channel: "voice",
    channelUserId: identity.userId,
    displayName: credential.displayName?.trim() || "Sprache",
    replyTo: credential.replyTo?.trim() || "voice",
  };
  return { ok: true, principal: new Identity(identity.userId, sender, "voice:bearer") };
}

export interface TelegramCredential {
  /** Der Wert des Headers `X-Telegram-Bot-Api-Secret-Token`, oder `null` beim Long-Polling. */
  secretHeader: string | null;
  /**
   * Beim Long-Polling gibt es keinen Header: die Updates kommen aus einer Verbindung, die
   * dieser Prozess selbst mit dem Bot-Token aufgemacht hat. Dann trägt der Bot-Token den
   * Nachweis, und die Absenderprüfung unten bleibt die eigentliche Kontrolle.
   */
  transport: "webhook" | "polling";
  fromId: string;
  chatId: string;
  displayName: string;
}

/**
 * Telegram: **zwei** Prüfungen, und beide sind nötig.
 *
 * Das Webhook-Geheimnis beweist, dass das Update von Telegram kommt — nicht, von wem. Jeder
 * Mensch auf der Welt kann einem Bot schreiben, und sein Update trägt dasselbe gültige
 * Geheimnis wie das des Betreibers. Ohne die Absenderliste wäre der Bot damit eine offene
 * Fernbedienung für ein System, das Dateien schreibt und Termine anlegt.
 *
 * Beim Long-Polling entfällt die erste Prüfung, weil es keinen Header gibt; die zweite trägt
 * dort allein und ist genau die, auf die es ankommt.
 */
export function authenticateTelegram(
  identity: GatewayIdentity,
  credential: TelegramCredential,
): AuthResult {
  if (identity.telegramUserIds.length === 0) {
    return {
      ok: false,
      reason: "channel_not_configured",
      message: "Der Telegram-Kanal ist ohne TELEGRAM_ALLOWED_USER_IDS nicht bedienbar.",
    };
  }

  if (credential.transport === "webhook") {
    if (identity.telegramSecret.length === 0) {
      return {
        ok: false,
        reason: "channel_not_configured",
        message: "Ein Telegram-Webhook ohne TELEGRAM_WEBHOOK_SECRET wird nicht angenommen.",
      };
    }
    if (credential.secretHeader === null || credential.secretHeader.length === 0) {
      return {
        ok: false,
        reason: "missing_credential",
        message: "Es fehlt der Header X-Telegram-Bot-Api-Secret-Token.",
      };
    }
    if (!secretEquals(credential.secretHeader, identity.telegramSecret)) {
      return {
        ok: false,
        reason: "bad_credential",
        message: "Das Webhook-Geheimnis stimmt nicht.",
      };
    }
  }

  if (!identity.telegramUserIds.includes(credential.fromId)) {
    return {
      ok: false,
      reason: "unknown_sender",
      message: `Telegram-Absender ${credential.fromId} steht nicht in TELEGRAM_ALLOWED_USER_IDS.`,
    };
  }

  const sender: Sender = {
    channel: "telegram",
    channelUserId: credential.fromId,
    displayName: credential.displayName.trim() || credential.fromId,
    replyTo: credential.chatId,
  };
  return {
    ok: true,
    principal: new Identity(identity.userId, sender, `telegram:${credential.transport}`),
  };
}

/**
 * Slack: **keine** Geheimnis-Kopfzeile wie bei Telegram, sondern eine HMAC-Signatur über den
 * rohen Request-Body (Slacks Rezept: `v0:<timestamp>:<rawBody>`, HMAC-SHA256 mit dem
 * Signiergeheimnis, als `v0=<hex>` im Header `X-Slack-Signature`). Das beweist "von Slack",
 * nicht "von wem" — genau wie `TELEGRAM_WEBHOOK_SECRET` beweist auch dies nur die Herkunft; die
 * Absenderliste (`slackUserIds`) trägt die eigentliche Kontrolle, wie bei Telegram.
 *
 * Der Zeitstempel darf nicht älter als fünf Minuten sein — sonst könnte eine einmal
 * mitgeschnittene, gültig signierte Anfrage beliebig oft wiederholt werden (Replay).
 */
export const SLACK_SIGNATURE_MAX_AGE_SECONDS = 5 * 60;

export function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
  now: () => number = () => Date.now(),
): boolean {
  if (signingSecret.length === 0 || timestamp.length === 0 || signature.length === 0) return false;
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  if (Math.abs(now() / 1000 - timestampSeconds) > SLACK_SIGNATURE_MAX_AGE_SECONDS) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${createHmac("sha256", signingSecret).update(base, "utf8").digest("hex")}`;
  return secretEquals(signature, expected);
}

export interface SlackCredential {
  timestamp: string | null;
  rawBody: string;
  signature: string | null;
  fromId: string;
  channelId: string;
  displayName: string;
}

/**
 * Slack: Signatur **und** Absenderliste, dasselbe Zwei-Prüfungen-Muster wie bei Telegram
 * (`authenticateTelegram`). Jeder Mensch kann eine Nachricht an den Bot schicken, und ihre
 * Zustellung trägt dieselbe gültige Signatur wie die des Betreibers — ohne die Absenderliste
 * wäre der Bot eine offene Fernbedienung für Fremde.
 */
export function authenticateSlack(
  identity: GatewayIdentity,
  credential: SlackCredential,
): AuthResult {
  if (identity.slackUserIds.length === 0) {
    return {
      ok: false,
      reason: "channel_not_configured",
      message: "Der Slack-Kanal ist ohne SLACK_ALLOWED_USER_IDS nicht bedienbar.",
    };
  }
  if (identity.slackSigningSecret.length === 0) {
    return {
      ok: false,
      reason: "channel_not_configured",
      message: "Der Slack-Kanal ist ohne SLACK_SIGNING_SECRET nicht bedienbar.",
    };
  }
  if (credential.timestamp === null || credential.signature === null) {
    return {
      ok: false,
      reason: "missing_credential",
      message: "Es fehlt X-Slack-Request-Timestamp oder X-Slack-Signature.",
    };
  }
  if (
    !verifySlackSignature(
      identity.slackSigningSecret,
      credential.timestamp,
      credential.rawBody,
      credential.signature,
    )
  ) {
    return { ok: false, reason: "bad_credential", message: "Die Slack-Signatur stimmt nicht." };
  }
  if (!identity.slackUserIds.includes(credential.fromId)) {
    return {
      ok: false,
      reason: "unknown_sender",
      message: `Slack-Absender ${credential.fromId} steht nicht in SLACK_ALLOWED_USER_IDS.`,
    };
  }

  const sender: Sender = {
    channel: "slack",
    channelUserId: credential.fromId,
    displayName: credential.displayName.trim() || credential.fromId,
    replyTo: credential.channelId,
  };
  return { ok: true, principal: new Identity(identity.userId, sender, "slack:webhook") };
}

/** Baut die Identitätstabelle aus der Umgebung. Fehlende Werte schalten ihren Kanal ab. */
export function identityFromEnv(env: NodeJS.ProcessEnv = process.env): GatewayIdentity {
  return {
    userId: env.GATEWAY_USER_ID?.trim() || "kuronami",
    webToken: env.GATEWAY_WEB_TOKEN?.trim() ?? "",
    telegramSecret: env.TELEGRAM_WEBHOOK_SECRET?.trim() ?? "",
    telegramUserIds: (env.TELEGRAM_ALLOWED_USER_IDS ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
    slackSigningSecret: env.SLACK_SIGNING_SECRET?.trim() ?? "",
    slackUserIds: (env.SLACK_ALLOWED_USER_IDS ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
    voiceToken: env.VOICE_BRIDGE_TOKEN?.trim() ?? "",
    voiceSessionToken: env.VOICE_SESSION_TOKEN?.trim() ?? "",
  };
}

/** Welche Kanäle diese Identitätstabelle überhaupt bedienbar macht. */
export function configuredChannels(identity: GatewayIdentity): ChannelId[] {
  const found: ChannelId[] = [];
  if (identity.webToken.length > 0) found.push("web");
  if (identity.telegramUserIds.length > 0) found.push("telegram");
  if (identity.slackUserIds.length > 0) found.push("slack");
  if (identity.voiceToken.length > 0) found.push("voice");
  return found.filter(isChannelId);
}
