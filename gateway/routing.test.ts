import { describe, expect, it } from "vitest";
import type { EventRecord } from "../runtime/events/log.js";
import {
  askRef,
  deriveAskRoutes,
  deriveLastOrigin,
  hasReceived,
  resolveAskRef,
} from "./routing.js";

/**
 * Die Zuordnung "welche Rückfrage gehört an welchen Kanal" — als Faltung über das Protokoll
 * (S16). Ohne Datenbank: die Funktion nimmt Ereignisse entgegen und sonst nichts, also lässt
 * sie sich auch mit gestellten Ereignissen prüfen.
 */

let seq = 0;
function event(type: string, payload: Record<string, unknown> = {}): EventRecord {
  seq += 1;
  return {
    eventId: `event_${seq}`,
    sessionId: "sess_test",
    seq,
    type,
    payload,
    createdAt: new Date(2026, 8, 9, 12, 0, seq),
  };
}

function received(channel: string, replyTo: string, extra: Record<string, unknown> = {}) {
  return event("gateway.received", {
    kind: "message",
    channel,
    sender: { channel_user_id: `user_${channel}`, display_name: channel, reply_to: replyTo },
    ...extra,
  });
}

function requested(askId: string, question = "Freigabe?") {
  return event("approval.requested", {
    ask_id: askId,
    kind: "policy",
    question,
    options: [
      { id: "once", label: "Nur dieses eine Mal erlauben" },
      { id: "deny", label: "Ablehnen" },
    ],
  });
}

describe("deriveAskRoutes", () => {
  it("schickt eine Rückfrage an den Kanal, über den zuletzt etwas hereinkam", () => {
    // Genau das Fertig-Kriterium in klein: erst Web, dann Telegram, und die Rückfrage des
    // Telegram-Zugs gehört nach Telegram — nicht dorthin, wo die Unterhaltung anfing.
    const routes = deriveAskRoutes([
      received("web", "jakob"),
      event("turn.completed", {}),
      received("telegram", "555"),
      requested("policy:call_4"),
    ]);

    expect(routes).toHaveLength(1);
    expect(routes[0].askId).toBe("policy:call_4");
    expect(routes[0].to.channel).toBe("telegram");
    expect(routes[0].to.replyTo).toBe("555");
    expect(routes[0].options.map((option) => option.id)).toEqual(["once", "deny"]);
    expect(routes[0].delivered).toBe(false);
  });

  it("verschiebt die Herkunft auch durch eine Entscheidung", () => {
    // Wer per Telegram entscheidet, bekommt die nächste Rückfrage desselben fortgesetzten
    // Laufs ebenfalls per Telegram: sein letztes Wort kam von dort.
    const routes = deriveAskRoutes([
      received("web", "jakob"),
      requested("policy:call_1"),
      event("gateway.received", {
        kind: "decision",
        channel: "telegram",
        sender: { channel_user_id: "555", display_name: "Jakob", reply_to: "555" },
        ask_id: "policy:call_1",
      }),
      event("approval.granted", { ask_id: "policy:call_1" }),
      requested("policy:call_2"),
    ]);

    expect(routes.map((route) => route.askId)).toEqual(["policy:call_2"]);
    expect(routes[0].to.channel).toBe("telegram");
  });

  it("nimmt eine beantwortete Rückfrage wieder heraus", () => {
    const routes = deriveAskRoutes([
      received("web", "jakob"),
      requested("policy:call_1"),
      event("approval.granted", { ask_id: "policy:call_1" }),
    ]);

    expect(routes).toEqual([]);
  });

  it("merkt sich, was schon zugestellt wurde", () => {
    const events = [received("web", "jakob"), requested("policy:call_1")];
    expect(deriveAskRoutes(events)[0].delivered).toBe(false);

    events.push(event("gateway.delivered", { kind: "approval", ask_id: "policy:call_1" }));
    expect(deriveAskRoutes(events)[0].delivered).toBe(true);
  });

  it("lässt eine Rückfrage ohne Herkunft weg, statt sie irgendwohin zu schicken", () => {
    // Eine Session, die nicht über das Gateway lief (`pnpm run:task`, DevUI, ein Test). Sie
    // hier willkürlich einem Kanal zuzuschlagen hieße, eine Freigabe an jemanden zu schicken,
    // der sie nie angefordert hat.
    expect(deriveAskRoutes([requested("policy:call_1")])).toEqual([]);
  });

  it("überspringt, was es nicht deuten kann, statt zu werfen", () => {
    const routes = deriveAskRoutes([
      event("gateway.received", { kind: "message", channel: "signal", sender: {} }),
      received("web", "jakob"),
      event("approval.requested", { kind: "policy" }),
      requested("policy:call_1"),
      event("irgendwas.neues", {}),
    ]);

    expect(routes.map((route) => route.askId)).toEqual(["policy:call_1"]);
  });

  it("findet die Herkunft der letzten Nachricht", () => {
    expect(deriveLastOrigin([received("web", "jakob"), received("telegram", "555")])?.channel).toBe(
      "telegram",
    );
    expect(deriveLastOrigin([])).toBeNull();
  });
});

describe("askRef", () => {
  it("bleibt unter der 64-Byte-Grenze von Telegram, auch bei sehr langer ask_id", () => {
    // Der Grund für die Referenz: `callback_data` darf 64 Byte nicht überschreiten, sonst
    // weist die Bot-API den ganzen Knopf ab und die Freigabe käme nie an.
    const long = `policy:${"t".repeat(400)}`;
    const data = `${askRef(long)}|session`;

    expect(askRef(long)).toHaveLength(12);
    expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(64);
  });

  it("ist stabil — dieselbe ask_id ergibt nach einem Neustart dieselbe Referenz", () => {
    expect(askRef("policy:call_4")).toBe(askRef("policy:call_4"));
    expect(askRef("policy:call_4")).not.toBe(askRef("policy:call_5"));
  });

  it("löst eine Referenz gegen die offenen Rückfragen auf, ohne Speicher", () => {
    const routes = deriveAskRoutes([received("telegram", "555"), requested("policy:call_4")]);

    expect(resolveAskRef(routes, askRef("policy:call_4"))).toEqual({
      status: "found",
      route: routes[0],
    });
    expect(resolveAskRef(routes, askRef("policy:call_9"))).toEqual({ status: "unknown" });
    expect(resolveAskRef([], "abc")).toEqual({ status: "unknown" });
  });
});

describe("hasReceived", () => {
  it("erkennt eine erneut zugestellte Nachricht an ihrer Kanal-Kennung", () => {
    const events = [received("telegram", "555", { external_id: "message:555:42" })];

    expect(hasReceived(events, "message:555:42")).toBe(true);
    expect(hasReceived(events, "message:555:43")).toBe(false);
  });
});
