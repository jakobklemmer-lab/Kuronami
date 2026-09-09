import type { Pool } from "pg";
import { deriveLoopState } from "../context/transcript.js";
import { appendEvent, readEvents } from "../runtime/events/log.js";
import type { LoopOutcome } from "../runtime/loop/api.js";
import { type StoredAttachment, storeAttachments } from "./attachments.js";
import type { Conversation, Conversations } from "./conversation.js";
import type { Principal } from "./identity.js";
import { type AskRoute, deriveAskRoutes, hasReceived } from "./routing.js";
import {
  type ChannelRegistry,
  type InboundDecision,
  type InboundMessage,
  type Outbound,
  type Sender,
  channelOrThrow,
} from "./types.js";

/**
 * Der Kern des Gateways: was mit einer normalisierten Nachricht passiert.
 *
 * **Hier steht kein Kanal.** Weder `web` noch `telegram` kommt in dieser Datei als Sonderfall
 * vor; es gibt nur `message.channel` als Nachschlagewert in der Kanalliste. Das ist der
 * Prüfstein der Surface-Schicht: ein dritter Kanal (Mail, Sprache) ist eine neue Datei unter
 * `channels/` und keine Zeile hier.
 *
 * **Und hier steht keine Ausführungslogik.** Was ein Zug tut, entscheidet der Loop (S12); ob
 * ein Aufruf durchgeht, die Policy (S11); was wiederholbar ist, die Hülle (S05). Diese Datei
 * ordnet nur zu: Nachricht → Unterhaltung → Zug, und Rückfrage → Kanal → Antwort → derselbe
 * Zug. `gateway/README.md` nennt genau das als die Grenze dieser Schicht.
 */

export interface GatewayDeps {
  pool: Pool;
  artifactRoot: string;
  conversations: Conversations;
  channels: ChannelRegistry;
}

export type GatewayStatus =
  | "answered"
  | "awaiting_user"
  | "busy"
  | "duplicate"
  | "rejected"
  | "canceled"
  | "failed";

export interface GatewayOutcome {
  sessionId: string;
  status: GatewayStatus;
  /** In einem Satz, was passiert ist. Geht so auch an den Kanal. */
  reason: string;
  /** Was tatsächlich zugestellt wurde, in der Reihenfolge der Zustellung. */
  delivered: Outbound[];
}

/**
 * Die Nachricht, wie das Modell sie zu lesen bekommt.
 *
 * Die normalisierte Form wird hier **sichtbar** gemacht statt stillschweigend auf ihren Text
 * reduziert: Kanal, Absender und Zeit stehen im Zugtext, weil sie den Inhalt verändern
 * können ("schick mir das gleich zu" heißt auf Telegram etwas anderes als im Web). Anhänge
 * stehen mit ihrem Handle da, nicht mit ihrem Inhalt (S06).
 *
 * Der Text ist bewusst kein JSON: er landet in `turn.started` und geht als Nutzernachricht
 * ins Modell, und dort liest sich eine Kopfzeile besser als ein Objekt.
 */
export function renderTurnInput(
  message: InboundMessage,
  attachments: readonly StoredAttachment[],
): string {
  const header = `[${message.channel} · ${message.sender.displayName} (${message.sender.channelUserId}) · ${message.receivedAt.toISOString()}]`;
  const body = message.content.trim();
  const lines = [header, body.length > 0 ? body : "(kein Text)"];

  if (attachments.length > 0) {
    lines.push(
      "",
      `Anhänge (${attachments.length}), Inhalt jeweils hinter dem Handle:`,
      ...attachments.map(
        (attachment) =>
          `- ${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes} Byte) → ${attachment.uri}`,
      ),
    );
  }
  return lines.join("\n");
}

/** Das `gateway.received`-Payload. Die normalisierte Form, eins zu eins im Protokoll. */
function receivedPayload(
  kind: "message" | "decision",
  sender: Sender,
  principal: Principal,
  receivedAt: Date,
  externalId: string,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    kind,
    channel: sender.channel,
    sender: {
      channel_user_id: sender.channelUserId,
      display_name: sender.displayName,
      reply_to: sender.replyTo,
    },
    // Wer authentifiziert wurde und auf welchem Weg. Ohne das stünde im Protokoll zwar der
    // Absender, aber nicht, dass ihn jemand geprüft hat — und der Freigabepfad aus Abschnitt 10
    // ("Auslöser") begänne erst eine Ebene zu spät. `auth_method` und nicht `auth`: der zweite
    // Name steht in `SECRET_FIELD_NAMES` und würde vom Redaction-Filter ersetzt, und zwar zu
    // Recht — ein Feld namens `auth` sieht aus, als stünde ein Token darin.
    user_id: principal.userId,
    auth_method: principal.authMethod,
    received_at: receivedAt.toISOString(),
    external_id: externalId,
    ...extra,
  };
}

async function deliver(
  deps: GatewayDeps,
  sessionId: string,
  to: Sender,
  message: Outbound,
): Promise<void> {
  const channel = channelOrThrow(deps.channels, to.channel);
  await channel.deliver(to, message);
  // Erst zustellen, dann protokollieren. Andersherum stünde nach einem Fehlschlag der
  // Zustellung im Protokoll, die Rückfrage sei draußen — und kein Neustart holte sie je nach.
  await appendEvent(deps.pool, sessionId, "gateway.delivered", {
    kind: message.kind,
    channel: to.channel,
    reply_to: to.replyTo,
    ...(message.kind === "approval" ? { ask_id: message.askId } : {}),
  });
}

/**
 * Stellt zu, was nach einem Zug offen ist: die noch nicht zugestellten Rückfragen an ihren
 * jeweiligen Kanal, und den Abschlusstext an den, von dem die Nachricht kam.
 *
 * Die Rückfragen kommen aus der **Faltung** (`deriveAskRoutes`) und nicht aus
 * `outcome.pendingUserInput`. Beide nennen dieselben offenen Fragen, aber nur die Faltung
 * weiß, an welchen Kanal jede gehört — und nur sie weiß, welche schon draußen ist.
 */
async function dispatch(
  deps: GatewayDeps,
  conversation: Conversation,
  outcome: LoopOutcome,
  origin: Sender,
): Promise<GatewayOutcome> {
  const sessionId = conversation.runner.session.sessionId;
  const delivered: Outbound[] = [];

  const routes: AskRoute[] = deriveAskRoutes(await readEvents(deps.pool, sessionId)).filter(
    (route) => !route.delivered,
  );
  for (const route of routes) {
    const message: Outbound = {
      kind: "approval",
      askId: route.askId,
      question: route.question,
      options: route.options,
    };
    await deliver(deps, sessionId, route.to, message);
    delivered.push(message);
  }

  if (outcome.stop === "awaiting_user") {
    return {
      sessionId,
      status: "awaiting_user",
      reason: outcome.reason,
      delivered,
    };
  }

  // Jeder andere Ausgang endet mit einem Text an den Absender — auch ein gescheiterter. Ein
  // Lauf, der an der Schrittobergrenze oder an einer Fehlerhäufung endet, ohne dass der
  // Nutzer davon erfährt, sähe von außen aus wie einer, der noch arbeitet (AGENTS.md: Fehler
  // nie verstecken).
  const text =
    outcome.stop === "done" && outcome.text.trim().length > 0 ? outcome.text : outcome.reason;
  const reply: Outbound = { kind: "reply", text };
  await deliver(deps, sessionId, origin, reply);
  delivered.push(reply);

  return {
    sessionId,
    status:
      outcome.stop === "done" ? "answered" : outcome.stop === "canceled" ? "canceled" : "failed",
    reason: outcome.reason,
    delivered,
  };
}

/**
 * Ein Fehler mitten im Zug. Er geht ins Protokoll (`error.raised`, seit Abschnitt 4.4) **und**
 * an den Kanal, mit seinem Text und nicht mit einer freundlichen Zusammenfassung.
 *
 * Kein erneutes Werfen: der Nutzer hat seine Antwort, der Betreiber hat den Eintrag, und ein
 * durchgereichter Fehler risse beim Long-Polling die Schleife ab. Verloren geht dabei nichts —
 * `error.raised` trägt Text und Stacktrace.
 */
async function reportFailure(
  deps: GatewayDeps,
  conversation: Conversation,
  origin: Sender,
  where: string,
  error: unknown,
): Promise<GatewayOutcome> {
  const sessionId = conversation.runner.session.sessionId;
  const message = error instanceof Error ? error.message : String(error);
  await appendEvent(deps.pool, sessionId, "error.raised", {
    where,
    channel: origin.channel,
    message,
    stack: error instanceof Error ? (error.stack ?? null) : null,
  });

  const reply: Outbound = { kind: "reply", text: `${where} ist fehlgeschlagen: ${message}` };
  // Scheitert auch noch die Zustellung, bleibt nur das Protokoll — und der Aufrufer bekommt
  // den ursprünglichen Fehler, nicht den der Zustellung.
  await deliver(deps, sessionId, origin, reply).catch(() => undefined);

  return { sessionId, status: "failed", reason: message, delivered: [reply] };
}

/** Die offenen Rückfragen dieser Session, mit ihrem Kanal. */
async function openAsks(deps: GatewayDeps, sessionId: string): Promise<AskRoute[]> {
  return deriveAskRoutes(await readEvents(deps.pool, sessionId));
}

/**
 * Nimmt eine Nachricht an und führt sie in die Unterhaltung des Nutzers.
 *
 * Verlangt einen `Principal` — den stellt allein `identity.ts` aus. Eine nicht
 * authentifizierte Nachricht kann diese Funktion nicht erreichen (siehe dort).
 */
export async function receiveMessage(
  deps: GatewayDeps,
  principal: Principal,
  message: InboundMessage,
): Promise<GatewayOutcome> {
  const conversation = await deps.conversations.of(principal.userId);

  return conversation.serialize(async () => {
    const sessionId = conversation.runner.session.sessionId;
    const origin = message.sender;

    if (hasReceived(await readEvents(deps.pool, sessionId), message.externalId)) {
      // Erneut zugestellt (siehe `hasReceived`). Nichts tun und nichts antworten: der Nutzer
      // hat einmal geschrieben und einmal eine Antwort bekommen; eine zweite wäre ein Echo,
      // das er sich nicht erklären kann.
      return {
        sessionId,
        status: "duplicate",
        reason: `Nachricht ${message.externalId} war schon da.`,
        delivered: [],
      };
    }

    let attachments: StoredAttachment[];
    try {
      attachments = await storeAttachments(deps.pool, deps.artifactRoot, sessionId, message);
    } catch (error) {
      return reportFailure(deps, conversation, origin, "Anhang annehmen", error);
    }

    await appendEvent(
      deps.pool,
      sessionId,
      "gateway.received",
      receivedPayload("message", origin, principal, message.receivedAt, message.externalId, {
        content: message.content,
        attachments: attachments.map((attachment) => ({
          name: attachment.name,
          mime_type: attachment.mimeType,
          size_bytes: attachment.sizeBytes,
          uri: attachment.uri,
          sha256: attachment.sha256,
        })),
      }),
    );

    try {
      // Ein offener Zug ohne offene Rückfrage ist ein unterbrochener Lauf — das Gateway wurde
      // mitten in einem Zug beendet. Erst den zu Ende bringen, dann die neue Nachricht: die
      // Reihenfolge ist dieselbe wie im Loop selbst ("stehen Aufrufe offen? dann die zuerst",
      // S12), und sie ist der Grund, warum eine Nachricht nach einem Neustart nicht in einen
      // halben Zug fällt.
      if (deriveLoopState(await readEvents(deps.pool, sessionId)).turnId !== null) {
        if ((await openAsks(deps, sessionId)).length === 0) {
          await dispatch(deps, conversation, await conversation.runner.run(), origin);
        }
      }

      const pending = await openAsks(deps, sessionId);
      if (pending.length > 0) {
        // Der Nutzer hat geschrieben, statt zu entscheiden. Die Nachricht wird **nicht**
        // verworfen und **nicht** zum Zug gemacht: sie bliebe sonst als Eingabe in einem Zug
        // hängen, der auf etwas ganz anderes wartet. Stattdessen wird gesagt, was offen ist.
        const listed = pending
          .map(
            (route) =>
              `${route.question} (${route.options.map((option) => option.id).join(" / ")})`,
          )
          .join("; ");
        const reply: Outbound = {
          kind: "reply",
          text: `Es wartet noch eine Entscheidung: ${listed}. Beantworte sie, dann geht es weiter — deine Nachricht ist noch nicht in den Lauf gegangen.`,
        };
        await deliver(deps, sessionId, origin, reply);
        return { sessionId, status: "busy", reason: listed, delivered: [reply] };
      }

      const outcome = await conversation.runner.run(renderTurnInput(message, attachments));
      return await dispatch(deps, conversation, outcome, origin);
    } catch (error) {
      return reportFailure(deps, conversation, origin, "Zug ausführen", error);
    }
  });
}

/**
 * Nimmt eine Entscheidung an und **setzt den Lauf fort** (Auftrag S16: "Antwort zurück in den
 * Lauf").
 *
 * Zwei Schritte, und der zweite ist der eigentliche: `answer()` schreibt nur die Entscheidung
 * ins Protokoll (S10/S11) — der angehaltene Zug läuft davon nicht weiter. Erst `run()` ohne
 * Eingabe nimmt ihn an genau der Stelle wieder auf, an der er stand. Dasselbe Muster wie im
 * DevUI (S12b) und im Freigabetest von S12.
 */
export async function receiveDecision(
  deps: GatewayDeps,
  principal: Principal,
  decision: InboundDecision,
): Promise<GatewayOutcome> {
  const conversation = await deps.conversations.of(principal.userId);

  return conversation.serialize(async () => {
    const sessionId = conversation.runner.session.sessionId;
    const origin = decision.sender;

    if (hasReceived(await readEvents(deps.pool, sessionId), decision.externalId)) {
      return {
        sessionId,
        status: "duplicate",
        reason: `Entscheidung ${decision.externalId} war schon da.`,
        delivered: [],
      };
    }

    const route = (await openAsks(deps, sessionId)).find((entry) => entry.askId === decision.askId);
    if (!route) {
      const reply: Outbound = {
        kind: "reply",
        text: `Zu dieser Frage steht keine Entscheidung mehr offen (${decision.askId}). Sie ist bereits beantwortet oder gehört zu einem anderen Lauf.`,
      };
      await deliver(deps, sessionId, origin, reply);
      return { sessionId, status: "rejected", reason: reply.text, delivered: [reply] };
    }

    await appendEvent(
      deps.pool,
      sessionId,
      "gateway.received",
      receivedPayload("decision", origin, principal, decision.receivedAt, decision.externalId, {
        ask_id: decision.askId,
        choice_id: decision.choiceId,
      }),
    );

    try {
      // Wer entschieden hat, steht damit im `approval.granted` und in `kuronami.approvals` —
      // der Freigabepfad aus Abschnitt 10 nennt den Auslöser, und der ist ab hier ein Mensch
      // auf einem Kanal und nicht mehr "operator".
      await conversation.runner.answer(
        decision.askId,
        decision.choiceId,
        `${origin.channel}:${origin.channelUserId}`,
      );
    } catch (error) {
      return reportFailure(deps, conversation, origin, "Entscheidung eintragen", error);
    }

    try {
      return await dispatch(deps, conversation, await conversation.runner.run(), origin);
    } catch (error) {
      return reportFailure(deps, conversation, origin, "Lauf fortsetzen", error);
    }
  });
}

/**
 * Stellt nach — was offen ist und noch nicht draußen war, geht jetzt hinaus.
 *
 * Der Fall, für den `gateway.delivered` existiert: das Gateway wird beendet, während eine
 * Freigabeanfrage geschrieben, aber noch nicht zugestellt ist. Ohne diesen Aufruf beim Start
 * bliebe der Lauf für immer wartend, und der Nutzer hätte nie eine Frage gesehen.
 */
export async function redeliverPending(
  deps: GatewayDeps,
  conversation: Conversation,
): Promise<Outbound[]> {
  const sessionId = conversation.runner.session.sessionId;
  const delivered: Outbound[] = [];
  for (const route of await openAsks(deps, sessionId)) {
    if (route.delivered) continue;
    const message: Outbound = {
      kind: "approval",
      askId: route.askId,
      question: route.question,
      options: route.options,
    };
    await deliver(deps, sessionId, route.to, message);
    delivered.push(message);
  }
  return delivered;
}
