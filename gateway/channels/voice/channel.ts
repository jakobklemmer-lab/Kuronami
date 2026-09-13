import type { ChannelPort, Outbound, Sender } from "../../types.js";

/**
 * Der Sprach-Kanal (S30/S31) — die Gegenstelle des Python-Prozesses unter `voice/`.
 *
 * **Warum ein eigener Kanal und nicht einfach der Web-Kanal.** Weil der Kanal im Zugtext steht
 * (`renderTurnInput`, S16) und deshalb den Inhalt verändert: "schick mir das gleich zu" heißt
 * gesprochen etwas anderes als getippt, und eine Antwort, die vorgelesen wird, sieht anders aus
 * als eine, die man liest. Genauso wichtig ist die **Zustellrichtung**: entsteht mitten in einem
 * Sprachzug eine Freigabeanfrage, gehört sie in dieselbe Sprachsitzung und nicht in ein
 * Browserfenster, das vielleicht gar nicht offen ist. Das leistet `deriveAskRoutes` (S16) allein
 * dadurch, dass der Kanal `voice` heißt.
 *
 * **Warum ein Postfach wie beim Web-Kanal.** Aus demselben Grund wie dort: HTTP ist Frage und
 * Antwort, ein Gespräch ist es nicht. Eine Freigabeanfrage entsteht *während* eines Zugs; sie
 * landet hier und wird mit der Antwort auf den auslösenden Aufruf abgeholt. Der Sprachprozess
 * liest sie aus, liest sie vor und schickt die Entscheidung zurück.
 *
 * Absichtlich **keine** eigene Zustellung über einen zweiten Draht (etwa ein Rückruf in den
 * Python-Prozess): das wäre eine zweite Verbindung in die Gegenrichtung, die es zu warten und
 * abzusichern gälte, für einen Fall, den das Postfach vollständig abdeckt.
 */

/** Obergrenze je Postfach — wie im Web-Kanal. Ein Client, der nie abholt, frisst nichts auf. */
export const VOICE_OUTBOX_LIMIT = 50;

export interface VoiceDelivery {
  at: Date;
  message: Outbound;
}

export interface VoiceChannel extends ChannelPort {
  readonly id: "voice";
  /** Nimmt alles heraus, was für diese Sitzung bereitliegt, und leert das Fach. */
  drain(replyTo: string): VoiceDelivery[];
  /** Was bereitliegt, ohne es herauszunehmen. Für Anzeige und Test. */
  peek(replyTo: string): readonly VoiceDelivery[];
}

export function createVoiceChannel(now: () => Date = () => new Date()): VoiceChannel {
  const outbox = new Map<string, VoiceDelivery[]>();

  return {
    id: "voice",

    async deliver(to: Sender, message: Outbound): Promise<void> {
      const box = outbox.get(to.replyTo) ?? [];
      box.push({ at: now(), message });
      // Die ältesten fallen heraus. In einem Gespräch ist die jüngste Zustellung die, auf die
      // jemand gerade wartet; eine Antwort von vor fünfzig Sätzen wird niemand mehr hören wollen.
      if (box.length > VOICE_OUTBOX_LIMIT) box.splice(0, box.length - VOICE_OUTBOX_LIMIT);
      outbox.set(to.replyTo, box);
    },

    drain(replyTo: string): VoiceDelivery[] {
      const box = outbox.get(replyTo) ?? [];
      outbox.delete(replyTo);
      return box;
    },

    peek(replyTo: string): readonly VoiceDelivery[] {
      return outbox.get(replyTo) ?? [];
    },
  };
}
