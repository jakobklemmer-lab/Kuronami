/**
 * Die Slack-Web-API, so weit das Gateway sie braucht: eine Nachricht posten, eine Reaktion
 * setzen. Zwei Aufrufe, kein SDK.
 *
 * **Warum injiziert statt importiert** — dieselbe Überlegung wie bei `fetchImpl` in
 * `web.fetch` (S09), der n8n-Brücke (S13) und `TelegramClient` (S16): ein Kanal, der fest an
 * einem HTTP-Aufruf hängt, ist nicht prüfbar. Tests stellen ein `fetchImpl`, das die Slack-API
 * nachbildet.
 *
 * **Warum kein SDK.** Dieselbe Abhängigkeitsdisziplin wie überall: `@slack/bolt`/
 * `@slack/web-api` brächten einen eigenen Update-Mechanismus (Socket Mode), ein eigenes
 * Session- und Zustandskonzept — genau die Dinge, die dieses System selbst und anders löst
 * (siehe `channel.ts`).
 *
 * **Keine Anhänge.** Slack-Dateien (`files.info`, Download mit Bot-Token) sind bewusst nicht
 * Teil dieser Session — S26 baut Text-Nachrichten und Freigaben, keine Anhänge. Dieselbe
 * Haltung wie „mail.send gibt es nicht" (S14): eine bewusste, dokumentierte Lücke, kein
 * Versehen. `InboundMessage.attachments` bleibt für Slack-Nachrichten `[]`.
 */

/** Es ist kein Bot-Token konfiguriert; der Kanal ist nicht bedienbar. */
export class SlackUnavailableError extends Error {}
/** Die Slack-API hat mit `ok: false` geantwortet (unabhängig vom HTTP-Status). */
export class SlackApiError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly slackError: string,
  ) {
    super(message);
    this.name = "SlackApiError";
  }
}
/** Die Antwort war kein verwertbares JSON oder trug kein `ok`. */
export class SlackResponseError extends Error {}

export const SLACK_API_ROOT = "https://slack.com/api";
export const SLACK_TIMEOUT_MS = 30_000;

export type FetchLike = typeof globalThis.fetch;

export interface SlackConfig {
  /** Bot-Token (`xoxb-...`). Fehlt er, meldet jeder Aufruf `SlackUnavailableError`. */
  token?: string;
  /** Vorgabe: globales `fetch`. Tests stellen einen Ersatz. */
  fetchImpl?: FetchLike;
  apiRoot?: string;
  timeoutMs?: number;
}

export interface PostMessageRequest {
  channel: string;
  text: string;
  /** Gesetzt, wenn die Nachricht in einen bestehenden Thread gehört. */
  threadTs?: string;
  signal?: AbortSignal;
}

export interface AddReactionRequest {
  channel: string;
  /** Die `ts` der Nachricht, auf die reagiert wird. */
  timestamp: string;
  /** Emoji-Kurzname ohne Doppelpunkte, z. B. `"one"`. */
  name: string;
  signal?: AbortSignal;
}

export interface SlackClient {
  readonly configured: boolean;
  postMessage(request: PostMessageRequest): Promise<{ ts: string }>;
  addReaction(request: AddReactionRequest): Promise<void>;
}

/**
 * `already_reacted` ist kein echter Fehler: ein zweiter Versuch (z. B. nach einem Neustart
 * mitten in der Zustellung) darf nicht scheitern, nur weil die Reaktion schon dort klebt.
 */
const IGNORABLE_REACTION_ERRORS: ReadonlySet<string> = new Set(["already_reacted"]);

export function createSlackClient(config: SlackConfig = {}): SlackClient {
  const token = config.token?.trim() ?? "";
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const apiRoot = (config.apiRoot ?? SLACK_API_ROOT).replace(/\/+$/, "");
  const timeoutMs = config.timeoutMs ?? SLACK_TIMEOUT_MS;

  function requireToken(): string {
    if (token.length === 0) {
      throw new SlackUnavailableError(
        "Der Slack-Kanal ist nicht bedienbar: SLACK_BOT_TOKEN ist nicht gesetzt.",
      );
    }
    return token;
  }

  async function call<T extends Record<string, unknown>>(
    method: string,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    ignorableErrors: ReadonlySet<string> = new Set(),
  ): Promise<T> {
    const url = `${apiRoot}/${method}`;
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${requireToken()}`,
      },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    });

    const raw = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new SlackResponseError(
        `Antwort auf ${method} war kein JSON (HTTP ${response.status}): ${raw.slice(0, 200)}`,
      );
    }

    const envelope = parsed as { ok?: unknown; error?: string } & T;
    if (envelope.ok !== true) {
      const error = envelope.error ?? "unbekannt";
      if (ignorableErrors.has(error)) return envelope;
      throw new SlackApiError(
        `Slack hat ${method} abgelehnt (HTTP ${response.status}): ${error}`,
        method,
        error,
      );
    }
    return envelope;
  }

  return {
    configured: token.length > 0,

    async postMessage(request: PostMessageRequest): Promise<{ ts: string }> {
      const result = await call<{ ts: string }>(
        "chat.postMessage",
        {
          channel: request.channel,
          text: request.text,
          ...(request.threadTs ? { thread_ts: request.threadTs } : {}),
        },
        request.signal,
      );
      return { ts: result.ts };
    },

    async addReaction(request: AddReactionRequest): Promise<void> {
      await call(
        "reactions.add",
        { channel: request.channel, timestamp: request.timestamp, name: request.name },
        request.signal,
        IGNORABLE_REACTION_ERRORS,
      );
    },
  };
}
