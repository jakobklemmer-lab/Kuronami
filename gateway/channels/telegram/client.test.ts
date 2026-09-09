import { describe, expect, it } from "vitest";
import {
  TELEGRAM_MAX_TEXT_LENGTH,
  TelegramApiError,
  TelegramFileTooLargeError,
  TelegramResponseError,
  TelegramUnavailableError,
  createTelegramClient,
  splitForTelegram,
} from "./client.js";

/**
 * Der Telegram-Client mit injiziertem `fetch` — ohne Netz, ohne Datenbank. Dieselbe Bauart
 * wie die n8n-Brücke (S13) und aus demselben Grund: ein Kanal, der fest an einem HTTP-Aufruf
 * hängt, lässt sich nicht behaupten.
 */

interface Call {
  url: string;
  body: Record<string, unknown>;
}

function fakeApi(reply: (method: string, body: Record<string, unknown>) => unknown) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url, body });
    const method = url.split("/").pop() ?? "";
    return new Response(JSON.stringify({ ok: true, result: reply(method, body) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetchImpl };
}

describe("splitForTelegram", () => {
  it("lässt kurzen Text unverändert", () => {
    expect(splitForTelegram("hallo")).toEqual(["hallo"]);
  });

  it("teilt langen Text, statt ihn zu kürzen — nichts geht verloren", () => {
    const text = `${"a".repeat(5000)}\n${"b".repeat(200)}`;
    const chunks = splitForTelegram(text);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MAX_TEXT_LENGTH);
    expect(chunks.join("").replace(/\n/g, "")).toBe(text.replace(/\n/g, ""));
  });

  it("trennt an einer Zeilengrenze, wo das sinnvoll ist", () => {
    const text = `${"zeile\n".repeat(1000)}ende`;
    const chunks = splitForTelegram(text);

    expect(chunks[0].endsWith("zeile")).toBe(true);
  });
});

describe("sendMessage", () => {
  it("schickt Text und baut aus den Optionen eine Inline-Tastatur", () => {
    const { calls, fetchImpl } = fakeApi(() => ({ message_id: 1 }));
    const client = createTelegramClient({ token: "bot-token", fetchImpl });

    return client
      .sendMessage({
        chatId: "555",
        text: "Freigabe?",
        buttons: [
          { text: "Nur einmal (once)", callbackData: "abc123|once" },
          { text: "Ablehnen (deny)", callbackData: "abc123|deny" },
        ],
      })
      .then(() => {
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe("https://api.telegram.org/botbot-token/sendMessage");
        expect(calls[0].body.chat_id).toBe("555");
        expect(calls[0].body.reply_markup).toEqual({
          inline_keyboard: [
            [{ text: "Nur einmal (once)", callback_data: "abc123|once" }],
            [{ text: "Ablehnen (deny)", callback_data: "abc123|deny" }],
          ],
        });
      });
  });

  it("hängt die Knöpfe an das letzte Stück eines geteilten Textes", async () => {
    // Sonst stünden sie über einem abgeschnittenen Text, und der Nutzer entschiede, ohne die
    // Frage zu Ende gelesen zu haben.
    const { calls, fetchImpl } = fakeApi(() => ({ message_id: 1 }));
    const client = createTelegramClient({ token: "t", fetchImpl });

    await client.sendMessage({
      chatId: "555",
      text: "x".repeat(9000),
      buttons: [{ text: "ok", callbackData: "a|once" }],
    });

    expect(calls.length).toBeGreaterThan(1);
    expect(calls[0].body.reply_markup).toBeUndefined();
    expect(calls[calls.length - 1].body.reply_markup).toBeDefined();
  });

  it("bricht ab, bevor Telegram einen zu langen Knopf ablehnt", async () => {
    const { calls, fetchImpl } = fakeApi(() => ({ message_id: 1 }));
    const client = createTelegramClient({ token: "t", fetchImpl });

    await expect(
      client.sendMessage({
        chatId: "555",
        text: "Freigabe?",
        buttons: [{ text: "ok", callbackData: "x".repeat(65) }],
      }),
    ).rejects.toThrow(TelegramApiError);
    // Und zwar ohne die Nachricht zu schicken: sonst stünde die Frage im Chat, aber ohne
    // Knöpfe — unbeantwortbar.
    expect(calls).toHaveLength(0);
  });

  it("meldet einen API-Fehler mit Code und Beschreibung", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ ok: false, error_code: 403, description: "bot was blocked by the user" }),
        { status: 403 },
      )) as unknown as typeof globalThis.fetch;
    const client = createTelegramClient({ token: "t", fetchImpl });

    await expect(client.sendMessage({ chatId: "555", text: "hallo" })).rejects.toThrow(
      /403.*blocked/,
    );
  });

  it("meldet eine Antwort, die kein JSON ist", async () => {
    const fetchImpl = (async () =>
      new Response("<html>502</html>", { status: 502 })) as unknown as typeof globalThis.fetch;
    const client = createTelegramClient({ token: "t", fetchImpl });

    await expect(client.sendMessage({ chatId: "555", text: "hallo" })).rejects.toThrow(
      TelegramResponseError,
    );
  });

  it("ist ohne Bot-Token nicht bedienbar", async () => {
    const client = createTelegramClient({});

    expect(client.configured).toBe(false);
    await expect(client.sendMessage({ chatId: "555", text: "hallo" })).rejects.toThrow(
      TelegramUnavailableError,
    );
  });
});

describe("Dateien", () => {
  it("holt den Pfad und lädt die Bytes", async () => {
    const bytes = Buffer.from("inhalt einer notiz");
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/getFile")) {
        return new Response(
          JSON.stringify({ ok: true, result: { file_path: "documents/x.md", file_size: 18 } }),
          { status: 200 },
        );
      }
      return new Response(bytes, {
        status: 200,
        headers: { "content-length": String(bytes.byteLength) },
      });
    }) as unknown as typeof globalThis.fetch;
    const client = createTelegramClient({ token: "t", fetchImpl });

    const info = await client.getFile({ fileId: "BQACAgI" });
    expect(info).toEqual({ filePath: "documents/x.md", fileSize: 18 });

    const loaded = await client.downloadFile({ filePath: info.filePath });
    expect(Buffer.from(loaded).toString("utf8")).toBe("inhalt einer notiz");
  });

  it("weist eine zu große Datei ab, bevor sie im Speicher steht", async () => {
    let bodyRead = false;
    const fetchImpl = (async () => {
      const response = new Response("egal", {
        status: 200,
        headers: { "content-length": String(50 * 1024 * 1024) },
      });
      return new Proxy(response, {
        get(target, property) {
          if (property === "arrayBuffer") bodyRead = true;
          return Reflect.get(target, property, target);
        },
      });
    }) as unknown as typeof globalThis.fetch;
    const client = createTelegramClient({ token: "t", fetchImpl, maxFileBytes: 1024 });

    await expect(client.downloadFile({ filePath: "x" })).rejects.toThrow(TelegramFileTooLargeError);
    expect(bodyRead).toBe(false);
  });
});

describe("getUpdates", () => {
  it("fragt nur nach den beiden Update-Arten, die das Gateway kennt", async () => {
    const { calls, fetchImpl } = fakeApi(() => []);
    const client = createTelegramClient({ token: "t", fetchImpl });

    await client.getUpdates({ offset: 12, timeoutSeconds: 25 });

    expect(calls[0].body).toEqual({
      offset: 12,
      timeout: 25,
      allowed_updates: ["message", "callback_query"],
    });
  });
});
