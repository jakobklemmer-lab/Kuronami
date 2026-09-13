import { describe, expect, it } from "vitest";
import {
  NUMBER_EMOJI,
  describeSlackEvent,
  emojiForOption,
  isUrlVerification,
  matchOptionByText,
  optionIndexForReaction,
} from "./normalize.js";

/**
 * Rohes Slack-Ereignis → normalisierte Form. Ohne Netz, ohne Datenbank — reine Funktion, wie
 * `describeUpdate` beim Telegram-Kanal.
 */

const now = () => new Date("2026-09-13T12:00:00.000Z");

describe("url_verification", () => {
  it("erkennt die Herausforderung und liefert die challenge", () => {
    const body = { type: "url_verification", token: "x", challenge: "abc123" };
    expect(isUrlVerification(body)).toBe(true);
    expect(describeSlackEvent(body, now)).toEqual({
      kind: "url_verification",
      challenge: "abc123",
    });
  });

  it("ist keine url_verification ohne challenge", () => {
    expect(isUrlVerification({ type: "url_verification" })).toBe(false);
  });
});

describe("message-Ereignisse", () => {
  function eventCallback(event: Record<string, unknown>, eventId = "Ev1") {
    return { type: "event_callback", event_id: eventId, event };
  }

  it("füllt Sender, ts, Text und externalId", () => {
    const described = describeSlackEvent(
      eventCallback({ type: "message", user: "U1", channel: "D1", ts: "100.001", text: "Hallo" }),
      now,
    );
    expect(described).toEqual({
      kind: "message",
      sender: { userId: "U1", channel: "D1", displayName: "U1" },
      ts: "100.001",
      threadTs: null,
      text: "Hallo",
      receivedAt: now(),
      externalId: "slack:Ev1",
    });
  });

  it("trägt thread_ts, wenn es eine Thread-Antwort ist", () => {
    const described = describeSlackEvent(
      eventCallback({
        type: "message",
        user: "U1",
        channel: "D1",
        ts: "100.002",
        thread_ts: "100.001",
        text: "once",
      }),
      now,
    );
    expect(described.kind).toBe("message");
    if (described.kind !== "message") return;
    expect(described.threadTs).toBe("100.001");
  });

  it("verwirft eine Nachricht des eigenen Bots", () => {
    const described = describeSlackEvent(
      eventCallback({
        type: "message",
        user: "U1",
        bot_id: "B1",
        channel: "D1",
        ts: "1",
        text: "echo",
      }),
      now,
    );
    expect(described.kind).toBe("ignored");
  });

  it("verwirft eine Nachricht mit subtype (bearbeitet/gelöscht)", () => {
    const described = describeSlackEvent(
      eventCallback({
        type: "message",
        subtype: "message_changed",
        user: "U1",
        channel: "D1",
        ts: "1",
      }),
      now,
    );
    expect(described.kind).toBe("ignored");
  });
});

describe("reaction_added-Ereignisse", () => {
  it("füllt Sender, itemTs und den Reaktionsnamen", () => {
    const described = describeSlackEvent(
      {
        type: "event_callback",
        event_id: "Ev2",
        event: {
          type: "reaction_added",
          user: "U1",
          reaction: "one",
          item: { type: "message", channel: "D1", ts: "100.001" },
        },
      },
      now,
    );
    expect(described).toEqual({
      kind: "reaction",
      sender: { userId: "U1", channel: "D1", displayName: "U1" },
      itemTs: "100.001",
      reactionName: "one",
      receivedAt: now(),
      externalId: "slack:Ev2",
    });
  });
});

describe("Unbekanntes", () => {
  it("ignoriert einen unbekannten Ereignistyp", () => {
    expect(describeSlackEvent({ type: "app_uninstalled" }, now).kind).toBe("ignored");
    expect(
      describeSlackEvent({ type: "event_callback", event: { type: "reaction_removed" } }, now).kind,
    ).toBe("ignored");
  });
});

describe("Emoji ↔ Options-Index", () => {
  it("bildet die ersten neun Ziffern-Emoji ab, in Reihenfolge", () => {
    expect(NUMBER_EMOJI).toHaveLength(9);
    expect(emojiForOption(0)).toBe("one");
    expect(emojiForOption(8)).toBe("nine");
    expect(emojiForOption(9)).toBeNull();
  });

  it("liest einen Reaktionsnamen zurück auf seinen Index", () => {
    expect(optionIndexForReaction("three")).toBe(2);
    expect(optionIndexForReaction("thumbsup")).toBeNull();
  });
});

describe("matchOptionByText", () => {
  const options = [
    { id: "once", label: "Nur einmal" },
    { id: "deny", label: "Ablehnen" },
  ];

  it("trifft auf die id", () => {
    expect(matchOptionByText("once", options)).toBe("once");
  });

  it("trifft auf das label, unabhängig von Groß-/Kleinschreibung", () => {
    expect(matchOptionByText("ABLEHNEN", options)).toBe("deny");
  });

  it("trifft auf eine führende, 1-basierte Zahl", () => {
    expect(matchOptionByText("1", options)).toBe("once");
    expect(matchOptionByText("2) ja bitte", options)).toBe("deny");
  });

  it("findet nichts bei einem normalen Gesprächsbeitrag", () => {
    expect(matchOptionByText("wie war dein Tag?", options)).toBeNull();
  });
});
