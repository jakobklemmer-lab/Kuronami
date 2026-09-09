import type { ChannelPort, Outbound, Sender } from "../types.js";

/**
 * Der Web-Kanal: die **umgehängte Prompt-Zeile** (Auftrag S16).
 *
 * Bis S15 war die Prompt-Zeile ein Argument an `runtime/index.ts` (`pnpm run:task "…"`). Sie
 * lief an allem vorbei, was ein Kanal ausmacht: keine Authentifizierung, keine normalisierte
 * Nachrichtenform, ein eigener Faden (`thread_dev_local`) und damit ein eigenes Gedächtnis.
 * Ab S16 geht dieselbe Zeile durch das Gateway — `pnpm say "…"` schickt sie an
 * `POST /channels/web/messages`, und sie landet in derselben Session wie eine
 * Telegram-Nachricht. Der direkte Weg über `runtime/index.ts` bleibt bestehen und heißt jetzt,
 * was er ist: ein Lauf ohne Kanal, zum Prüfen.
 *
 * **Warum ein Postfach.** HTTP ist Frage und Antwort, ein Kanal ist es nicht: eine
 * Freigabeanfrage entsteht *während* eines Zugs, und der Zug ist die Antwort auf die
 * Nachricht. `deliver` schreibt deshalb in ein Postfach je Empfänger, und der HTTP-Rand leert
 * es. Was in einem Aufruf entstand, kommt in dessen Antwort zurück; was danach entsteht (der
 * Heartbeat ab S17 wird das brauchen), holt ein `GET`.
 *
 * **Das Postfach ist flüchtig, und das ist in Ordnung.** Es hält keine Wahrheit, nur eine
 * Zustellung. Was einen Neustart überleben muss — welche Rückfrage offen ist und an welchen
 * Kanal sie gehört —, steht im Protokoll und wird von `deriveAskRoutes` gefaltet. Genau dafür
 * gibt es `gateway.delivered`: eine Rückfrage, deren Zustellung im Postfach verlorenging,
 * trägt keinen Eintrag und wird beim nächsten Start erneut zugestellt.
 */

/** Obergrenze je Postfach. Ein Aufrufer, der nie abholt, soll den Prozess nicht auffressen. */
export const WEB_OUTBOX_LIMIT = 100;

export interface WebDelivery {
  at: Date;
  message: Outbound;
}

export interface WebChannel extends ChannelPort {
  readonly id: "web";
  /** Nimmt alles heraus, was für diesen Empfänger bereitliegt, und leert das Fach. */
  drain(replyTo: string): WebDelivery[];
  /** Was bereitliegt, ohne es herauszunehmen. Für Anzeige und Test. */
  peek(replyTo: string): readonly WebDelivery[];
}

export function createWebChannel(now: () => Date = () => new Date()): WebChannel {
  const outbox = new Map<string, WebDelivery[]>();

  return {
    id: "web",

    async deliver(to: Sender, message: Outbound): Promise<void> {
      const box = outbox.get(to.replyTo) ?? [];
      box.push({ at: now(), message });
      // Die ältesten fallen heraus, nicht die neuesten. Eine Freigabeanfrage von gerade eben
      // ist die, auf die jemand wartet; eine Antwort von vor hundert Nachrichten ist es nicht.
      if (box.length > WEB_OUTBOX_LIMIT) box.splice(0, box.length - WEB_OUTBOX_LIMIT);
      outbox.set(to.replyTo, box);
    },

    drain(replyTo: string): WebDelivery[] {
      const box = outbox.get(replyTo) ?? [];
      outbox.delete(replyTo);
      return box;
    },

    peek(replyTo: string): readonly WebDelivery[] {
      return outbox.get(replyTo) ?? [];
    },
  };
}
