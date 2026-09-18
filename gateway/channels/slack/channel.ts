import { readEvents } from "../../../runtime/events/log.js";
import {
  type GatewayDeps,
  type GatewayOutcome,
  openAskRoutes,
  receiveDecision,
  receiveMessage,
} from "../../core.js";
import { type GatewayIdentity, authenticateSlack } from "../../identity.js";
import { type AskRoute, deriveAskRoutes } from "../../routing.js";
import type { ChannelPort, Outbound, Sender } from "../../types.js";
import type { SlackClient } from "./client.js";
import {
  type DescribedSlackEvent,
  describeSlackEvent,
  emojiForOption,
  matchOptionByText,
  optionIndexForReaction,
} from "./normalize.js";

/**
 * Der Slack-Kanal: Zustellung (`ChannelPort`) und Annahme (`handleSlackEvent`) teilen sich
 * `pendingByTs` — dieselbe Verabredung wie Telegrams `callback_data` (`normalize.ts` dort),
 * nur anders getragen: Slack-Reaktionen und Thread-Antworten kommen ohne jede Nutzlast herein
 * (nur `item.ts`/`thread_ts`), also muss etwas sich merken, welche `ts` zu welcher `ask_id`
 * gehörte.
 *
 * **Warum das kein zweiter Speicher ist.** Die Wahrheit über offene Rückfragen bleibt das
 * Protokoll (`deriveAskRoutes`) — `pendingByTs` ist reine Zustellhilfe zur Auflösung von
 * Mehrdeutigkeit, wenn **mehrere** Rückfragen gleichzeitig offen sind (in der Praxis selten,
 * siehe `progress.md`). Ist genau eine offen, wird sie direkt aufgelöst, ganz ohne die Map.
 * Geht die Map durch einen Neustart verloren, bleibt bei mehreren offenen Fragen nur die
 * Thread-Antwort mit dem Options-Text — dieselbe Art flüchtiger Zustellhilfe wie beim
 * Web-Postfach (`channels/web.ts`: „Das Postfach ist flüchtig, und das ist in Ordnung").
 *
 * **Warum keine Bestätigung wie Telegrams `answerCallbackQuery`.** Slack braucht dafür nichts
 * Eigenes — die Events API ist mit der HTTP-200-Antwort schon bestätigt (siehe `server.ts`,
 * dort auch die Begründung für die 3-Sekunden-Frist).
 */

export interface SlackChannelDeps {
  client: SlackClient;
  identity: GatewayIdentity;
  gateway: GatewayDeps;
  /** `ts` der zugestellten Frage → `ask_id`. Von `createSlackChannel` UND `handleSlackEvent`
   * geteilt — beide müssen dieselbe Instanz bekommen (siehe oben). */
  pendingByTs: Map<string, string>;
}

export type UpdateResult =
  | { kind: "ignored"; reason: string }
  | { kind: "rejected"; reason: string }
  | { kind: "handled"; outcome: GatewayOutcome };

/** Höchstens neun Reaktionen — mehr Optionen sind ein Randfall, den `user.ask`/Policy heute
 * selten produzieren; die nummerierte Textliste selbst deckt trotzdem jede Option ab, per
 * Thread-Antwort mit dem Options-Text bleibt sie erreichbar. */
const MAX_REACTION_OPTIONS = 9;

export function createSlackChannel(deps: SlackChannelDeps): ChannelPort {
  return {
    id: "slack",

    async deliver(to: Sender, message: Outbound): Promise<void> {
      if (message.kind === "reply") {
        await deps.client.postMessage({ channel: to.replyTo, text: message.text });
        return;
      }

      const lines = [
        message.question,
        "",
        ...message.options.map((option, index) => `${index + 1}. ${option.label}`),
      ];
      const { ts } = await deps.client.postMessage({ channel: to.replyTo, text: lines.join("\n") });
      deps.pendingByTs.set(ts, message.askId);

      for (const [index, _option] of message.options.entries()) {
        if (index >= MAX_REACTION_OPTIONS) break;
        const emoji = emojiForOption(index);
        if (!emoji) break;
        // Jede Reaktion einzeln abgesichert: ein fehlgeschlagener Reaction-Aufruf (z. B.
        // Ratenlimit) darf die übrigen nicht verhindern und die Zustellung nicht scheitern
        // lassen — die Frage selbst ist ja schon draußen.
        await deps.client
          .addReaction({ channel: to.replyTo, timestamp: ts, name: emoji })
          .catch(() => undefined);
      }
    },
  };
}

/** Welche `ask_id` eine Reaktion/Thread-Antwort meint, unter mehreren offenen Slack-Rückfragen. */
function resolveAmbiguity(
  routes: readonly AskRoute[],
  pendingByTs: Map<string, string>,
  candidateTs: string | null,
): AskRoute | null {
  if (routes.length === 1) return routes[0];
  if (routes.length === 0 || candidateTs === null) return null;
  const askId = pendingByTs.get(candidateTs);
  if (!askId) return null;
  return routes.find((route) => route.askId === askId) ?? null;
}

export interface HandleSlackEventOptions {
  /** Header `X-Slack-Request-Timestamp`. */
  timestamp: string | null;
  /** Header `X-Slack-Signature`. */
  signature: string | null;
  /** Der **rohe** Anfragekörper, wie er auf der Leitung stand (vor jedem JSON-Parsing) — die
   * Signatur läuft über exakt diese Bytes, siehe `verifySlackSignature`. */
  rawBody: string;
  signal?: AbortSignal;
}

export async function handleSlackEvent(
  deps: SlackChannelDeps,
  body: unknown,
  options: HandleSlackEventOptions,
): Promise<UpdateResult> {
  const described: DescribedSlackEvent = describeSlackEvent(body);
  if (described.kind === "ignored") return { kind: "ignored", reason: described.reason };
  if (described.kind === "url_verification") {
    // Gehört an `server.ts`, das die Herausforderung direkt beantwortet, bevor es hierher
    // kommt — trifft dieser Zweig doch zu, ist das ein Verdrahtungsfehler, kein Nutzerfall.
    return { kind: "ignored", reason: "url_verification gehört an server.ts, nicht hierher." };
  }

  const auth = authenticateSlack(deps.identity, {
    timestamp: options.timestamp,
    rawBody: options.rawBody,
    signature: options.signature,
    fromId: described.sender.userId,
    channelId: described.sender.channel,
    displayName: described.sender.displayName,
  });
  if (!auth.ok) return { kind: "rejected", reason: auth.message };
  const principal = auth.principal;

  const openSlack = openAskRoutes(deps.gateway).filter((route) => route.to.channel === "slack");

  if (described.kind === "reaction") {
    const route = resolveAmbiguity(openSlack, deps.pendingByTs, described.itemTs);
    if (!route) return { kind: "ignored", reason: "Reaktion passt zu keiner offenen Rückfrage." };
    const index = optionIndexForReaction(described.reactionName);
    const choiceId = index !== null ? route.options[index]?.id : undefined;
    if (!choiceId) {
      return { kind: "ignored", reason: `Unbekannte Reaktion "${described.reactionName}".` };
    }
    return {
      kind: "handled",
      outcome: await receiveDecision(deps.gateway, principal, {
        channel: "slack",
        sender: principal.sender,
        askId: route.askId,
        choiceId,
        receivedAt: described.receivedAt,
        externalId: described.externalId,
      }),
    };
  }

  // kind === "message"
  const route = resolveAmbiguity(openSlack, deps.pendingByTs, described.threadTs);
  if (route) {
    const choiceId = matchOptionByText(described.text, route.options);
    if (choiceId) {
      return {
        kind: "handled",
        outcome: await receiveDecision(deps.gateway, principal, {
          channel: "slack",
          sender: principal.sender,
          askId: route.askId,
          choiceId,
          receivedAt: described.receivedAt,
          externalId: described.externalId,
        }),
      };
    }
  } else if (openSlack.length > 1) {
    // Mehrdeutig, und die Map konnte nicht auflösen (z. B. nach einem Neustart): kein Ratespiel,
    // sondern eine Rückmeldung, wie es doch geht.
    const listed = openSlack
      .map((entry) => `${entry.question} (${entry.options.map((option) => option.id).join(" / ")})`)
      .join("; ");
    const reply: Outbound = {
      kind: "reply",
      text: `Es sind mehrere Rückfragen offen: ${listed}. Antworte im jeweiligen Thread mit der Options-Kennung oder dem Optionstext.`,
    };
    await deps.client
      .postMessage({ channel: described.sender.channel, text: reply.text })
      .catch(() => undefined);
    return { kind: "rejected", reason: reply.text };
  }

  return {
    kind: "handled",
    outcome: await receiveMessage(deps.gateway, principal, {
      channel: "slack",
      sender: principal.sender,
      content: described.text,
      attachments: [],
      receivedAt: described.receivedAt,
      externalId: described.externalId,
    }),
  };
}
