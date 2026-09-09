import { describe, expect, it } from "vitest";
import type { TelegramUpdate } from "./client.js";
import { decodeCallbackData, describeUpdate, encodeCallbackData } from "./normalize.js";

/**
 * Telegram-Update → normalisierte Form. Ohne Netz, ohne Datenbank — `describeUpdate` bekommt
 * keinen Client, kann also gar nichts holen. Genau das ist die Eigenschaft, auf die es
 * ankommt: ein Update wird beschrieben, bevor jemand weiß, ob sein Absender berechtigt ist.
 */

const now = () => new Date("2026-09-09T12:00:00.000Z");

function textUpdate(overrides: Partial<TelegramUpdate["message"]> = {}): TelegramUpdate {
  return {
    update_id: 7,
    message: {
      message_id: 42,
      date: 1_788_000_000,
      from: { id: 11111111, first_name: "Jakob", last_name: "K" },
      chat: { id: 11111111, type: "private" },
      text: "Was steht heute an?",
      ...overrides,
    },
  };
}

describe("Nachrichten", () => {
  it("füllt alle fünf Felder der normalisierten Form", () => {
    const described = describeUpdate(textUpdate(), now);

    expect(described.kind).toBe("message");
    if (described.kind !== "message") return;
    expect(described.sender).toEqual({
      id: "11111111",
      displayName: "Jakob K",
      chatId: "11111111",
    });
    expect(described.content).toBe("Was steht heute an?");
    expect(described.attachments).toEqual([]);
    // Telegram zählt in Sekunden seit Epoche.
    expect(described.receivedAt.toISOString()).toBe(new Date(1_788_000_000_000).toISOString());
    expect(described.externalId).toBe("message:11111111:42");
  });

  it("nimmt die Bildunterschrift als Inhalt, wenn kein Text da ist", () => {
    const described = describeUpdate(
      textUpdate({
        text: undefined,
        caption: "Das hier bitte ablegen",
        document: {
          file_id: "BQACAgI",
          file_name: "notiz.md",
          mime_type: "text/markdown",
          file_size: 1234,
        },
      }),
      now,
    );

    expect(described.kind).toBe("message");
    if (described.kind !== "message") return;
    expect(described.content).toBe("Das hier bitte ablegen");
    expect(described.attachments).toEqual([
      { fileId: "BQACAgI", name: "notiz.md", mimeType: "text/markdown", sizeBytes: 1234 },
    ]);
  });

  it("nimmt bei einem Foto die größte Auflösung, nicht die erste", () => {
    // Telegram schickt dasselbe Bild mehrfach. Die Vorschau zu nehmen wäre bequem und falsch.
    const described = describeUpdate(
      textUpdate({
        text: undefined,
        caption: "schau mal",
        photo: [
          { file_id: "klein", file_size: 1000 },
          { file_id: "gross", file_size: 90000 },
          { file_id: "mittel", file_size: 20000 },
        ],
      }),
      now,
    );

    expect(described.kind).toBe("message");
    if (described.kind !== "message") return;
    expect(described.attachments).toEqual([
      { fileId: "gross", name: "foto_42.jpg", mimeType: "image/jpeg", sizeBytes: 90000 },
    ]);
  });

  it("rät den MIME-Typ aus der Endung und bleibt sonst ehrlich unbestimmt", () => {
    const withoutMime = describeUpdate(
      textUpdate({
        document: { file_id: "x", file_name: "bericht.pdf" },
      }),
      now,
    );
    const unknown = describeUpdate(
      textUpdate({ document: { file_id: "y", file_name: "daten.xyz" } }),
      now,
    );

    expect(withoutMime.kind === "message" && withoutMime.attachments[0].mimeType).toBe(
      "application/pdf",
    );
    expect(unknown.kind === "message" && unknown.attachments[0].mimeType).toBe(
      "application/octet-stream",
    );
  });

  it("hält Pfadzeichen und Steuerzeichen aus einem Dateinamen heraus", () => {
    // Der Name wird heute nie zu einem Pfad — der Artefaktspeicher vergibt seinen eigenen.
    // Er geht aber in einen Prompt und in eine Anzeige, und dorthin gehört so etwas nicht.
    const nasty = `..${String.fromCharCode(0)}/../etc/passwd${String.fromCharCode(27)}[2J`;
    const described = describeUpdate(
      textUpdate({ document: { file_id: "x", file_name: nasty } }),
      now,
    );

    expect(described.kind).toBe("message");
    if (described.kind !== "message") return;
    const name = described.attachments[0].name;
    expect(name).not.toContain("/");
    expect(name).not.toContain("\\");
    expect(name).not.toContain("..");
    expect([...name].some((char) => (char.codePointAt(0) ?? 0) < 0x20)).toBe(false);
    // Ein Bindestrich ist an einem Dateinamen normal und bleibt stehen.
    expect(
      describeUpdate(
        textUpdate({ document: { file_id: "x", file_name: "mein-bericht.pdf" } }),
        now,
      ),
    ).toMatchObject({ attachments: [{ name: "mein-bericht.pdf" }] });
  });

  it("übergeht, was den Bot nichts angeht, statt zu werfen", () => {
    // Ein Bot bekommt laufend Fremdverkehr. Ihn als Fehler zu behandeln hieße, die
    // Long-Polling-Schleife daran abbrechen zu lassen.
    const cases: TelegramUpdate[] = [
      { update_id: 1 },
      { update_id: 2, message: { message_id: 1, date: 1, chat: { id: 1 } } },
      textUpdate({ from: { id: 5, is_bot: true, first_name: "Bot" } }),
    ];

    for (const update of cases) {
      expect(describeUpdate(update, now).kind).toBe("ignored");
    }
  });
});

describe("Knopfdruck", () => {
  const callback: TelegramUpdate = {
    update_id: 8,
    callback_query: {
      id: "cbq_1",
      from: { id: 11111111, first_name: "Jakob" },
      data: "a1b2c3d4e5f6|once",
      message: { message_id: 43, chat: { id: 11111111 } },
    },
  };

  it("wird zur Entscheidung, mit Referenz und gewählter Option", () => {
    const described = describeUpdate(callback, now);

    expect(described.kind).toBe("decision");
    if (described.kind !== "decision") return;
    expect(described.askRef).toBe("a1b2c3d4e5f6");
    expect(described.choiceId).toBe("once");
    expect(described.callbackQueryId).toBe("cbq_1");
    expect(described.sender.chatId).toBe("11111111");
    // Die Kennung des Drucks, nicht die der Nachricht darunter: zwei Drücke sind zwei
    // Entscheidungen und dürfen sich nicht gegenseitig als Doppel wegkürzen.
    expect(described.externalId).toBe("callback:cbq_1");
    expect(described.receivedAt).toEqual(now());
  });

  it("kodiert und dekodiert callback_data verlustfrei", () => {
    expect(decodeCallbackData(encodeCallbackData("abc123", "session"))).toEqual({
      askRef: "abc123",
      choiceId: "session",
    });
  });

  it("weist eine kaputte callback_data benannt ab", () => {
    for (const data of ["", "nurref", "|once", "abc|"]) {
      expect("error" in decodeCallbackData(data)).toBe(true);
    }

    const broken: TelegramUpdate = {
      update_id: 9,
      callback_query: {
        id: "cbq_2",
        from: { id: 11111111, first_name: "Jakob" },
        data: "kaputt",
        message: { message_id: 43, chat: { id: 11111111 } },
      },
    };
    expect(describeUpdate(broken, now).kind).toBe("ignored");
  });
});
