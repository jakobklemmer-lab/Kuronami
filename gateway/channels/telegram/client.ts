/**
 * Die Telegram-Bot-API, so weit das Gateway sie braucht: senden, Knopfdruck quittieren,
 * Updates abholen, eine Datei herunterladen. Fünf Aufrufe, kein SDK.
 *
 * **Warum injiziert statt importiert** — dieselbe Überlegung wie bei `fetchImpl` in
 * `web.fetch` (S09), der n8n-Brücke (S13) und `ModelClient` im Loop (S12): ein Kanal, der fest
 * an einem HTTP-Aufruf hängt, ist nicht prüfbar. Die Tests stellen ein `fetchImpl`, das die
 * Bot-API nachbildet, und können danach behaupten, welche Knöpfe wirklich hinausgegangen sind.
 *
 * **Warum kein SDK.** Dieselbe Abhängigkeitsdisziplin wie überall: die Runtime kennt `pg` und
 * `@anthropic-ai/sdk`, sonst nichts. Ein Bot-Framework brächte einen eigenen Update-Loop, ein
 * eigenes Session- und Zustandskonzept und eine eigene Vorstellung davon, wo ein Gespräch
 * lebt — also genau die drei Dinge, die dieses System selbst und anders löst.
 */

/** Es ist kein Bot-Token konfiguriert; der Kanal ist nicht bedienbar. */
export class TelegramUnavailableError extends Error {}
/** Die Bot-API hat mit `ok: false` geantwortet. */
export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly errorCode: number,
    readonly description: string,
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}
/** Die Antwort war kein verwertbares JSON oder trug kein `ok`. */
export class TelegramResponseError extends Error {}
/** Eine heruntergeladene Datei ist größer als erlaubt. */
export class TelegramFileTooLargeError extends Error {}

export const TELEGRAM_API_ROOT = "https://api.telegram.org";
/** Harte Grenze der Bot-API für den Text einer Nachricht. Längeres wird geteilt, nie gekürzt. */
export const TELEGRAM_MAX_TEXT_LENGTH = 4096;
/** Harte Grenze der Bot-API für `callback_data` eines Inline-Knopfes, in Byte. */
export const TELEGRAM_MAX_CALLBACK_DATA_BYTES = 64;
/** Vorgabe-Zeitfenster eines API-Aufrufs. Long-Polling rechnet sein eigenes dazu. */
export const TELEGRAM_TIMEOUT_MS = 30_000;
/** Obergrenze für eine heruntergeladene Datei. Anhänge darüber werden abgewiesen. */
export const TELEGRAM_MAX_FILE_BYTES = 20 * 1024 * 1024;

export type FetchLike = typeof globalThis.fetch;

export interface TelegramConfig {
  /** Bot-Token von @BotFather. Fehlt er, meldet jeder Aufruf `TelegramUnavailableError`. */
  token?: string;
  /** Vorgabe: globales `fetch`. Tests stellen einen Ersatz. */
  fetchImpl?: FetchLike;
  apiRoot?: string;
  timeoutMs?: number;
  maxFileBytes?: number;
}

export interface TelegramButton {
  text: string;
  /** Höchstens 64 Byte (API-Grenze). Siehe `askRef` in `gateway/routing.ts`. */
  callbackData: string;
}

export interface SendMessageRequest {
  chatId: string;
  text: string;
  /** Eine Zeile je Knopf — auf einem Telefon liest sich das besser als eine Reihe. */
  buttons?: TelegramButton[];
  signal?: AbortSignal;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  [key: string]: unknown;
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  from?: TelegramUser;
  chat: { id: number; type?: string };
  text?: string;
  caption?: string;
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  photo?: { file_id: string; file_size?: number; width?: number; height?: number }[];
  voice?: { file_id: string; mime_type?: string; file_size?: number };
  audio?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  video?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: { message_id: number; chat: { id: number }; date?: number };
}

export interface TelegramFileInfo {
  filePath: string;
  fileSize: number | null;
}

export interface TelegramClient {
  readonly configured: boolean;
  sendMessage(request: SendMessageRequest): Promise<{ messageId: number }>;
  answerCallbackQuery(request: {
    callbackQueryId: string;
    text?: string;
    signal?: AbortSignal;
  }): Promise<void>;
  getUpdates(request: {
    offset: number;
    timeoutSeconds: number;
    signal?: AbortSignal;
  }): Promise<TelegramUpdate[]>;
  getFile(request: { fileId: string; signal?: AbortSignal }): Promise<TelegramFileInfo>;
  downloadFile(request: { filePath: string; signal?: AbortSignal }): Promise<Uint8Array>;
}

/**
 * Teilt einen Text in API-taugliche Stücke — an Zeilengrenzen, wo es geht.
 *
 * Kürzen wäre die einfachere Lösung und die falsche: eine Antwort, von der der Nutzer die
 * letzten Absätze nie sieht, ist ein verstecktes Ergebnis (AGENTS.md). Sehr lange Ausgaben
 * gehören ohnehin in ein Artefakt; was hier ankommt, ist die Zusammenfassung, und die darf
 * vollständig ankommen.
 */
export function splitForTelegram(text: string, limit: number = TELEGRAM_MAX_TEXT_LENGTH): string[] {
  const trimmed = text.length > 0 ? text : "(leere Antwort)";
  if (trimmed.length <= limit) return [trimmed];

  const chunks: string[] = [];
  let rest = trimmed;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = window.lastIndexOf("\n");
    // Nur an einer Zeilengrenze trennen, wenn dabei nicht fast das ganze Stück verfällt —
    // sonst entstünden bei einem langen Absatz ohne Umbruch beliebig viele Minifragmente.
    const at = cut > limit / 2 ? cut : limit;
    chunks.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, "");
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

function assertCallbackData(button: TelegramButton): void {
  const size = Buffer.byteLength(button.callbackData, "utf8");
  if (size > TELEGRAM_MAX_CALLBACK_DATA_BYTES) {
    // Telegram wiese die ganze Nachricht ab (BUTTON_DATA_INVALID), und der Nutzer bekäme
    // keine Knöpfe zu sehen — die Freigabe käme nie an. Hier abzubrechen benennt den Grund
    // an der Stelle, an der er entsteht.
    throw new TelegramApiError(
      `callback_data des Knopfes "${button.text}" ist ${size} Byte groß, erlaubt sind ${TELEGRAM_MAX_CALLBACK_DATA_BYTES}.`,
      "sendMessage",
      0,
      "callback_data too long",
    );
  }
}

export function createTelegramClient(config: TelegramConfig = {}): TelegramClient {
  const token = config.token?.trim() ?? "";
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const apiRoot = (config.apiRoot ?? TELEGRAM_API_ROOT).replace(/\/+$/, "");
  const timeoutMs = config.timeoutMs ?? TELEGRAM_TIMEOUT_MS;
  const maxFileBytes = config.maxFileBytes ?? TELEGRAM_MAX_FILE_BYTES;

  function requireToken(): string {
    if (token.length === 0) {
      throw new TelegramUnavailableError(
        "Der Telegram-Kanal ist nicht bedienbar: TELEGRAM_BOT_TOKEN ist nicht gesetzt.",
      );
    }
    return token;
  }

  async function call<T>(
    method: string,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    timeout: number,
  ): Promise<T> {
    const url = `${apiRoot}/bot${requireToken()}/${method}`;
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(timeout),
    });

    const raw = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new TelegramResponseError(
        `Antwort auf ${method} war kein JSON (HTTP ${response.status}): ${raw.slice(0, 200)}`,
      );
    }

    const envelope = parsed as {
      ok?: unknown;
      result?: T;
      error_code?: number;
      description?: string;
    };
    if (envelope.ok !== true) {
      throw new TelegramApiError(
        `Telegram hat ${method} abgelehnt (HTTP ${response.status}, ${envelope.error_code ?? "ohne Code"}): ${envelope.description ?? raw.slice(0, 200)}`,
        method,
        envelope.error_code ?? response.status,
        envelope.description ?? "",
      );
    }
    return envelope.result as T;
  }

  return {
    configured: token.length > 0,

    async sendMessage(request: SendMessageRequest): Promise<{ messageId: number }> {
      const buttons = request.buttons ?? [];
      for (const button of buttons) assertCallbackData(button);

      const chunks = splitForTelegram(request.text);
      let last = { message_id: 0 };
      for (const [index, chunk] of chunks.entries()) {
        // Die Knöpfe hängen an der **letzten** Nachricht. Andernfalls stünden sie über einem
        // abgeschnittenen Text, und der Nutzer entschiede, ohne die Frage zu Ende gelesen zu
        // haben.
        const isLast = index === chunks.length - 1;
        last = await call<{ message_id: number }>(
          "sendMessage",
          {
            chat_id: request.chatId,
            text: chunk,
            ...(isLast && buttons.length > 0
              ? {
                  reply_markup: {
                    inline_keyboard: buttons.map((button) => [
                      { text: button.text, callback_data: button.callbackData },
                    ]),
                  },
                }
              : {}),
          },
          request.signal,
          timeoutMs,
        );
      }
      return { messageId: last.message_id };
    },

    async answerCallbackQuery(request): Promise<void> {
      await call<boolean>(
        "answerCallbackQuery",
        {
          callback_query_id: request.callbackQueryId,
          ...(request.text ? { text: request.text } : {}),
        },
        request.signal,
        timeoutMs,
      );
    },

    async getUpdates(request): Promise<TelegramUpdate[]> {
      // Das Zeitfenster des Aufrufs muss über dem Long-Polling-Fenster liegen, sonst bräche
      // der Client die Verbindung ab, die er selbst offen halten wollte.
      return call<TelegramUpdate[]>(
        "getUpdates",
        {
          offset: request.offset,
          timeout: request.timeoutSeconds,
          allowed_updates: ["message", "callback_query"],
        },
        request.signal,
        request.timeoutSeconds * 1000 + timeoutMs,
      );
    },

    async getFile(request): Promise<TelegramFileInfo> {
      const result = await call<{ file_path?: string; file_size?: number }>(
        "getFile",
        { file_id: request.fileId },
        request.signal,
        timeoutMs,
      );
      if (typeof result.file_path !== "string" || result.file_path.length === 0) {
        throw new TelegramResponseError(
          `getFile hat keinen file_path geliefert: ${JSON.stringify(result)}`,
        );
      }
      return { filePath: result.file_path, fileSize: result.file_size ?? null };
    },

    async downloadFile(request): Promise<Uint8Array> {
      const url = `${apiRoot}/file/bot${requireToken()}/${request.filePath}`;
      const response = await fetchImpl(url, {
        signal: request.signal ?? AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new TelegramApiError(
          `Download von ${request.filePath} scheiterte mit HTTP ${response.status}.`,
          "downloadFile",
          response.status,
          response.statusText,
        );
      }

      // Erst die angekündigte Größe prüfen, dann laden. Ein 500-MB-Anhang soll nicht erst im
      // Arbeitsspeicher stehen, bevor jemand merkt, dass er zu groß ist.
      const announced = Number(response.headers.get("content-length") ?? "0");
      if (announced > maxFileBytes) {
        throw new TelegramFileTooLargeError(
          `Datei ${request.filePath} ist ${announced} Byte groß, erlaubt sind ${maxFileBytes}.`,
        );
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxFileBytes) {
        throw new TelegramFileTooLargeError(
          `Datei ${request.filePath} ist ${bytes.byteLength} Byte groß, erlaubt sind ${maxFileBytes}.`,
        );
      }
      return bytes;
    },
  };
}
