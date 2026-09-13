import { describe, expect, it } from "vitest";
import {
  SlackApiError,
  SlackResponseError,
  SlackUnavailableError,
  createSlackClient,
} from "./client.js";

/**
 * Der Slack-Client mit injiziertem `fetch` — ohne Netz, ohne Datenbank. Dieselbe Bauart wie
 * der Telegram-Client (S16) und die n8n-Brücke (S13).
 */

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fakeApi(
  reply: (method: string, body: Record<string, unknown>) => Record<string, unknown>,
) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const headers = Object.fromEntries(new Headers(init?.headers).entries()) as Record<
      string,
      string
    >;
    calls.push({ url, headers, body });
    const method = url.split("/").pop() ?? "";
    return new Response(JSON.stringify({ ok: true, ...reply(method, body) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetchImpl };
}

describe("postMessage", () => {
  it("postet Text mit Bot-Token als Bearer-Header und liefert die ts zurück", async () => {
    const { calls, fetchImpl } = fakeApi(() => ({ ts: "123.456" }));
    const client = createSlackClient({ token: "xoxb-test", fetchImpl });

    const result = await client.postMessage({ channel: "D0JAKOB", text: "Freigabe?" });

    expect(result).toEqual({ ts: "123.456" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://slack.com/api/chat.postMessage");
    expect(calls[0].headers.authorization).toBe("Bearer xoxb-test");
    expect(calls[0].body).toEqual({ channel: "D0JAKOB", text: "Freigabe?" });
  });

  it("hängt thread_ts nur an, wenn eine Thread-Antwort gemeint ist", async () => {
    const { calls, fetchImpl } = fakeApi(() => ({ ts: "1" }));
    const client = createSlackClient({ token: "t", fetchImpl });

    await client.postMessage({ channel: "C1", text: "hi" });
    await client.postMessage({ channel: "C1", text: "hi im Thread", threadTs: "100.000" });

    expect(calls[0].body.thread_ts).toBeUndefined();
    expect(calls[1].body.thread_ts).toBe("100.000");
  });

  it("meldet einen Slack-Fehler unabhängig vom HTTP-Status", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), {
        status: 200,
      })) as unknown as typeof globalThis.fetch;
    const client = createSlackClient({ token: "t", fetchImpl });

    await expect(client.postMessage({ channel: "x", text: "hi" })).rejects.toThrow(SlackApiError);
    await expect(client.postMessage({ channel: "x", text: "hi" })).rejects.toThrow(
      /channel_not_found/,
    );
  });

  it("meldet eine Antwort, die kein JSON ist", async () => {
    const fetchImpl = (async () =>
      new Response("<html>502</html>", { status: 502 })) as unknown as typeof globalThis.fetch;
    const client = createSlackClient({ token: "t", fetchImpl });

    await expect(client.postMessage({ channel: "x", text: "hi" })).rejects.toThrow(
      SlackResponseError,
    );
  });

  it("ist ohne Bot-Token nicht bedienbar", async () => {
    const client = createSlackClient({});

    expect(client.configured).toBe(false);
    await expect(client.postMessage({ channel: "x", text: "hi" })).rejects.toThrow(
      SlackUnavailableError,
    );
  });
});

describe("addReaction", () => {
  it("setzt eine Reaktion auf eine Nachricht", async () => {
    const { calls, fetchImpl } = fakeApi(() => ({}));
    const client = createSlackClient({ token: "t", fetchImpl });

    await client.addReaction({ channel: "D1", timestamp: "100.001", name: "one" });

    expect(calls[0].url).toBe("https://slack.com/api/reactions.add");
    expect(calls[0].body).toEqual({ channel: "D1", timestamp: "100.001", name: "one" });
  });

  it("wertet already_reacted als Erfolg, nicht als Fehler", async () => {
    // Ein zweiter Versuch (z. B. nach einem Neustart mitten in der Zustellung) darf nicht
    // scheitern, nur weil die Reaktion schon dort klebt.
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: false, error: "already_reacted" }), {
        status: 200,
      })) as unknown as typeof globalThis.fetch;
    const client = createSlackClient({ token: "t", fetchImpl });

    await expect(
      client.addReaction({ channel: "D1", timestamp: "1", name: "one" }),
    ).resolves.toBeUndefined();
  });

  it("wirft trotzdem bei jedem anderen Fehler", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: false, error: "invalid_name" }), {
        status: 200,
      })) as unknown as typeof globalThis.fetch;
    const client = createSlackClient({ token: "t", fetchImpl });

    await expect(client.addReaction({ channel: "D1", timestamp: "1", name: "x" })).rejects.toThrow(
      SlackApiError,
    );
  });
});
