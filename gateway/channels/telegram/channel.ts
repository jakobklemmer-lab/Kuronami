import { readEvents } from "../../../runtime/events/log.js";
import {
  type GatewayDeps,
  type GatewayOutcome,
  openAskRoutes,
  receiveDecision,
  receiveMessage,
} from "../../core.js";
import { type GatewayIdentity, authenticateTelegram } from "../../identity.js";
import { askRef, deriveAskRoutes, resolveAskRef } from "../../routing.js";
import type { ChannelPort, InboundAttachment, Outbound, Sender } from "../../types.js";
import type { TelegramClient, TelegramUpdate } from "./client.js";
import {
  type DescribedUpdate,
  type TelegramAttachmentRef,
  describeUpdate,
  encodeCallbackData,
} from "./normalize.js";

/**
 * Der Telegram-Kanal: Zustellung (`ChannelPort`) und Annahme (`handleUpdate`) in einer Datei,
 * weil beides dieselbe Verabredung über `callback_data` teilt — der Knopf, den `deliver`
 * schickt, ist genau der, den `handleUpdate` wieder auflöst. Läge das in zwei Dateien,
 * stünden Kodierung und Dekodierung an zwei Orten, und die Verabredung wäre eine Hoffnung.
 *
 * Die Reihenfolge in `handleUpdate` ist Absicht und nicht Geschmack:
 *
 *   1. **beschreiben** (kein Netz, keine Wirkung — `normalize.ts`),
 *   2. **authentifizieren** (`identity.ts`),
 *   3. **erst dann** Anhänge holen und in die Runtime gehen.
 *
 * Ein nicht berechtigter Absender kostet damit zwei Vergleiche und keinen einzigen
 * HTTP-Aufruf, keine Session, kein Ereignis. Ein Bot ist über seine Kennung für jeden
 * erreichbar; ohne diese Reihenfolge wäre er eine Fernbedienung für Fremde.
 */

export interface TelegramChannelDeps {
  client: TelegramClient;
  identity: GatewayIdentity;
  gateway: GatewayDeps;
}

/** Was mit einem Update passiert ist. Für Protokollzeilen und Tests. */
export type UpdateResult =
  | { kind: "ignored"; reason: string }
  | { kind: "rejected"; reason: string }
  | { kind: "handled"; outcome: GatewayOutcome };

/** Der Knopftext einer Option. Die Kennung steht dabei, damit sichtbar ist, was gewählt wird. */
function buttonLabel(option: { id: string; label: string }): string {
  return `${option.label} (${option.id})`;
}

export function createTelegramChannel(deps: TelegramChannelDeps): ChannelPort {
  return {
    id: "telegram",

    async deliver(to: Sender, message: Outbound): Promise<void> {
      if (message.kind === "reply") {
        await deps.client.sendMessage({ chatId: to.replyTo, text: message.text });
        return;
      }

      // Die Optionen kommen aus dem Protokoll (Abschnitt 10: strukturiert, kein Fließtext) und
      // werden hier nur angezeigt. Der Kanal erfindet keine Wahlmöglichkeit und lässt keine
      // weg — was in `approval.requested` steht, steht auf den Knöpfen.
      const ref = askRef(message.askId);
      await deps.client.sendMessage({
        chatId: to.replyTo,
        text: message.question,
        buttons: message.options.map((option) => ({
          text: buttonLabel(option),
          callbackData: encodeCallbackData(ref, option.id),
        })),
      });
    },
  };
}

/** Lädt die angekündigten Anhänge wirklich herunter. Läuft erst nach der Authentifizierung. */
async function fetchAttachments(
  client: TelegramClient,
  refs: readonly TelegramAttachmentRef[],
  signal?: AbortSignal,
): Promise<InboundAttachment[]> {
  const loaded: InboundAttachment[] = [];
  for (const ref of refs) {
    const info = await client.getFile({ fileId: ref.fileId, signal });
    loaded.push({
      name: ref.name,
      mimeType: ref.mimeType,
      bytes: await client.downloadFile({ filePath: info.filePath, signal }),
    });
  }
  return loaded;
}

/**
 * Nimmt ein Update an. `transport` sagt, woher es kam: über den Webhook (dann muss das
 * Geheimnis im Header stehen) oder aus dem Long-Polling dieses Prozesses (dann gibt es keinen
 * Header, und der Bot-Token trägt den Nachweis).
 */
export async function handleUpdate(
  deps: TelegramChannelDeps,
  update: TelegramUpdate,
  options: { transport: "webhook" | "polling"; secretHeader?: string | null; signal?: AbortSignal },
): Promise<UpdateResult> {
  const described: DescribedUpdate = describeUpdate(update);
  if (described.kind === "ignored") return { kind: "ignored", reason: described.reason };

  const auth = authenticateTelegram(deps.identity, {
    transport: options.transport,
    secretHeader: options.secretHeader ?? null,
    fromId: described.sender.id,
    chatId: described.sender.chatId,
    displayName: described.sender.displayName,
  });
  if (!auth.ok) {
    // Bewusst **ohne** Antwort an den Absender. Eine Fehlermeldung an einen Unbefugten sagt
    // ihm, dass hier etwas läuft, das sich zu suchen lohnt; ein Bot, der Fremden schweigt,
    // sagt nichts. Der Vorfall steht in der Prozessausgabe, nicht im Chat.
    return { kind: "rejected", reason: auth.message };
  }
  const principal = auth.principal;

  if (described.kind === "message") {
    const attachments = await fetchAttachments(deps.client, described.attachments, options.signal);
    return {
      kind: "handled",
      outcome: await receiveMessage(deps.gateway, principal, {
        channel: "telegram",
        sender: principal.sender,
        content: described.content,
        attachments,
        receivedAt: described.receivedAt,
        externalId: described.externalId,
      }),
    };
  }

  // Eine Entscheidung. Die kurze Referenz vom Knopf wird gegen die **offenen** Rückfragen der
  // Unterhaltung aufgelöst — zustandslos, aus dem Protokoll (siehe `askRef`).
  const routes = openAskRoutes(deps.gateway);
  const found = resolveAskRef(routes, described.askRef);

  // Den Knopfdruck sofort quittieren, bevor der Zug weiterläuft: Telegram zeigt sonst bis zu
  // einer halben Minute lang eine Ladeanzeige, und der Nutzer drückt in der Zwischenzeit ein
  // zweites Mal.
  const acknowledgement =
    found.status === "found"
      ? `Angenommen: ${described.choiceId}`
      : "Diese Frage ist nicht mehr offen.";
  await deps.client
    .answerCallbackQuery({
      callbackQueryId: described.callbackQueryId,
      text: acknowledgement,
      signal: options.signal,
    })
    // Die Quittung ist Anzeigekomfort. Scheitert sie, läuft die Entscheidung trotzdem — sie
    // deshalb fallenzulassen wäre die teurere Falschentscheidung.
    .catch(() => undefined);

  if (found.status !== "found") {
    const reason =
      found.status === "ambiguous"
        ? `Die Knopfkennung ${described.askRef} passt auf mehrere offene Rückfragen (${found.askIds.join(", ")}).`
        : `Zu der Knopfkennung ${described.askRef} steht keine offene Rückfrage mehr.`;
    await deps.client
      .sendMessage({ chatId: described.sender.chatId, text: reason, signal: options.signal })
      .catch(() => undefined);
    return { kind: "rejected", reason };
  }

  return {
    kind: "handled",
    outcome: await receiveDecision(deps.gateway, principal, {
      channel: "telegram",
      sender: principal.sender,
      askId: found.route.askId,
      choiceId: described.choiceId,
      receivedAt: described.receivedAt,
      externalId: described.externalId,
    }),
  };
}

export interface PollingHandle {
  /** Läuft, bis `stop()` gerufen wird oder das Signal bricht. */
  readonly done: Promise<void>;
  stop(): void;
}

export interface PollingOptions {
  /** Sekunden, die ein `getUpdates` offen bleibt. Telegram erlaubt bis 50. */
  timeoutSeconds?: number;
  /** Pause nach einem Fehlschlag, damit ein dauerhaft kaputtes Telegram nicht heißläuft. */
  retryDelayMs?: number;
  signal?: AbortSignal;
  onResult?: (result: UpdateResult, update: TelegramUpdate) => void;
  onError?: (error: unknown) => void;
}

/**
 * Long-Polling: der Weg, der **ohne öffentliche Adresse** funktioniert.
 *
 * Ein Webhook braucht eine von Telegram erreichbare URL mit gültigem Zertifikat. Auf dem
 * Entwicklungsrechner gibt es die nicht, und ein Tunnel wäre ein zusätzlicher Dienst, an dem
 * der zweite Kanal hinge. Beide Wege münden in dasselbe `handleUpdate` — der Webhook ist
 * damit keine zweite Fassung des Kanals, sondern nur ein anderer Eingang, und der Umzug auf
 * einen Server (Abschnitt 17) ist eine Einstellung und keine Änderung am Code.
 */
export function startTelegramPolling(
  deps: TelegramChannelDeps,
  options: PollingOptions = {},
): PollingHandle {
  const timeoutSeconds = options.timeoutSeconds ?? 25;
  const retryDelayMs = options.retryDelayMs ?? 3000;
  const controller = new AbortController();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  async function loop(): Promise<void> {
    let offset = 0;
    while (!controller.signal.aborted) {
      try {
        const updates = await deps.client.getUpdates({
          offset,
          timeoutSeconds,
          signal: controller.signal,
        });
        for (const update of updates) {
          if (controller.signal.aborted) break;
          // Der Versatz rückt vor, **bevor** das Update bearbeitet wird. Sonst holte ein
          // Update, an dem die Bearbeitung scheitert, sich selbst endlos wieder — und das
          // Gateway käme nie zur nächsten Nachricht. Der Fehlschlag steht im Protokoll
          // (`error.raised`), nicht in einer Schleife.
          offset = Math.max(offset, update.update_id + 1);
          try {
            options.onResult?.(
              await handleUpdate(deps, update, {
                transport: "polling",
                signal: controller.signal,
              }),
              update,
            );
          } catch (error) {
            options.onError?.(error);
          }
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        options.onError?.(error);
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }

  return { done: loop(), stop: () => controller.abort() };
}
