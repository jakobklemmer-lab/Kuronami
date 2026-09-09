import {
  TELEGRAM_MAX_TEXT_LENGTH,
  type TelegramClient,
  splitForTelegram,
} from "../gateway/channels/telegram/client.js";

/**
 * Wie der Heartbeat eine Nachricht loswird. **Ausgehend, mehr nicht** — kein Empfangen, keine
 * Rückfrage, keine Optionen. Das ist der Unterschied zum `ChannelPort` des Gateways: der
 * Heartbeat spricht, er hört nicht zu.
 *
 * Der Telegram-Weg benutzt denselben SDK-freien Client wie das Gateway
 * (`gateway/channels/telegram/client.ts`). Das ist eine Abhängigkeit Surface→Surface und
 * unbedenklich — die harte Regel aus Abschnitt 3 betrifft nur `runtime/` und darunter, nicht
 * zwei Surface-Module untereinander. Den Client hier nachzubauen hieße, seine Aufteilung an
 * der 4096-Zeichen-Grenze und sein Timeout zweimal zu pflegen.
 */

export interface DigestChannel {
  readonly id: string;
  /** Stellt zu. Wirft bei einem Zustellfehler — der Aufrufer protokolliert ihn und macht weiter. */
  deliver(text: string): Promise<void>;
}

/** Fällt zurück auf die Prozessausgabe. Der Digest liegt trotzdem als Artefakt (siehe `digest.ts`). */
export function consoleDigestChannel(log: (line: string) => void = console.log): DigestChannel {
  return {
    id: "console",
    async deliver(text: string): Promise<void> {
      log(`[heartbeat] Digest (kein Kanal konfiguriert, nur Konsole):\n${text}`);
    },
  };
}

export function telegramDigestChannel(deps: {
  client: TelegramClient;
  chatId: string;
}): DigestChannel {
  return {
    id: "telegram",
    async deliver(text: string): Promise<void> {
      // Lange Digests an Zeilengrenzen teilen, nie kürzen (dieselbe Regel wie im Gateway).
      for (const part of splitForTelegram(text, TELEGRAM_MAX_TEXT_LENGTH)) {
        await deps.client.sendMessage({ chatId: deps.chatId, text: part });
      }
    },
  };
}
