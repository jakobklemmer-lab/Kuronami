import type { Pool } from "pg";
import type { KuroAgent } from "./agent.js";
import type { Principal } from "./identity.js";
import type { AskRoute } from "./routing.js";
import type { ChannelRegistry, InboundDecision, InboundMessage, Outbound } from "./types.js";

/**
 * Der Kern des Gateways — seit dem Motorwechsel ein **Adapter** und keine Agentenschleife mehr.
 *
 * Vorher standen hier 459 Zeilen: Sitzungsverwaltung, Zugserialisierung, Doppelerkennung über
 * das Ereignisprotokoll, das Auflösen offener Rückfragen, die Wortlaut-Zuordnung von Antworten.
 * Das alles macht jetzt `agent.ts` über das Agent-SDK, und zwar mit Kontextkompaktierung und
 * funktionierendem Prompt-Caching — den beiden Dingen, die der selbstgebauten Schleife fehlten
 * und die sie 65.000 Token pro Aufruf kosteten, 52.000 davon zum vollen Preis.
 *
 * Die **Signaturen bleiben unverändert**. Das ist Absicht und der Grund, warum der Wechsel
 * nicht durch das ganze Projekt schneidet: `receiveMessage`, `receiveDecision` und
 * `redeliverPending` werden an sieben Stellen aufgerufen — Web, Telegram, Sprachschicht
 * —, und keine davon muss wissen, dass darunter ein anderer Motor läuft.
 *
 * Die alte Fassung liegt vollständig in `archiv/eigener-motor`.
 */

export interface GatewayDeps {
  pool: Pool;
  artifactRoot: string;
  /** Der Motor. */
  agent: KuroAgent;
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
 * Eine Nachricht annehmen.
 *
 * `principal` wird nicht mehr durchgereicht: die Authentifizierung ist vor dieser Grenze
 * passiert (`identity.ts`), und dahinter gibt es genau einen Nutzer mit genau einer
 * Unterhaltung. Der Parameter bleibt in der Signatur, damit die Aufrufstellen unverändert
 * bleiben — und damit ein zweiter Nutzer später hier ansetzen kann, statt sieben Stellen
 * anfassen zu müssen.
 */
export async function receiveMessage(
  deps: GatewayDeps,
  _principal: Principal,
  message: InboundMessage,
): Promise<GatewayOutcome> {
  return deps.agent.receive(message);
}

/**
 * Eine Entscheidung annehmen — also einen Klick auf eine der angebotenen Optionen.
 *
 * Seit dem Wechsel ist das nur noch **ein** Weg von zweien: eine gesprochene oder getippte
 * Antwort geht als gewöhnliche Nachricht durch `receiveMessage` und wird dort ebenso zur
 * Antwort auf die offene Rückfrage. Der Klick ist der Sonderfall, nicht die Regel — vorher
 * war es umgekehrt, und genau daran scheiterte die reine Sprachbedienung.
 */
export async function receiveDecision(
  deps: GatewayDeps,
  _principal: Principal,
  decision: InboundDecision,
): Promise<GatewayOutcome> {
  const offen = deps.agent.offeneFrage;
  if (!offen || offen.askId !== decision.askId) {
    return {
      sessionId: deps.agent.sessionId ?? "",
      status: "rejected",
      reason: `Zu ${decision.askId} steht keine Frage (mehr) offen.`,
      delivered: [],
    };
  }

  // Der Klick trägt eine `choiceId` ("ja"/"nein"); der Agent erwartet den Wortlaut. Die
  // Kennung **ist** hier der Wortlaut — dieselben zwei Optionen stellt `agent.ts`.
  return deps.agent.receive({
    channel: decision.channel,
    sender: decision.sender,
    content: decision.choiceId,
    attachments: [],
    receivedAt: decision.receivedAt,
    externalId: decision.externalId,
  });
}

/**
 * Beim Start eine noch offene Rückfrage erneut zustellen.
 *
 * Nach dem Wechsel gibt es nichts nachzureichen: eine Rückfrage lebt im laufenden Zug, und
 * ein Neustart beendet den Zug. Die Funktion bleibt, weil `index.ts` sie aufruft und weil
 * ein leeres Ergebnis hier ehrlicher ist als ein entfernter Aufruf, der später jemandem fehlt.
 */
export async function redeliverPending(_deps: GatewayDeps): Promise<Outbound[]> {
  return [];
}

/**
 * Die offene Rückfrage im Format, das die Kanäle schon kennen (`AskRoute` aus `routing.ts`).
 *
 * Vorher leitete jeder Kanal sie sich selbst aus dem Ereignisprotokoll ab — vier Stellen, die
 * alle `readEvents` + `deriveAskRoutes` aufriefen, um dieselbe Frage zu beantworten. Beim
 * neuen Motor steht sie am Agenten, und es kann höchstens eine geben: ein angehaltener
 * Werkzeugaufruf wartet, und solange er wartet, läuft kein zweiter.
 */
export function openAskRoutes(deps: GatewayDeps): AskRoute[] {
  const offen = deps.agent.offeneFrage;
  if (!offen) return [];
  return [
    {
      askId: offen.askId,
      kind: "policy",
      question: offen.frage,
      options: [
        { id: "ja", label: "Ja, mach das" },
        { id: "nein", label: "Nein, lass es" },
      ],
      to: offen.to,
      delivered: true,
    },
  ];
}
