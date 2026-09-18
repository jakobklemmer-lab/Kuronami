import { createHmac, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../../../runtime/db/pool.js";
import { createWebChannel } from "../../channels/web.js";
import type { GatewayDeps } from "../../core.js";
import type { GatewayIdentity } from "../../identity.js";
import { createServer } from "../../server.js";
import type { SlackChannelDeps } from "./channel.js";
import { createSlackClient } from "./client.js";

/**
 * Der HTTP-Rand von `/channels/slack/events` (S26): Signaturprüfung, `url_verification` und
 * die 3-Sekunden-Zusage ("antwortet sofort, verarbeitet danach"). Was `handleSlackEvent`
 * selbst mit einer offenen Rückfrage tut, prüft `gateway.test.ts` end-to-end mit echter
 * Datenbank — hier geht es nur um den Rand.
 */

const pool = createPool();
const SIGNING_SECRET = "test-signing-secret";
const identity: GatewayIdentity = {
  userId: "kuronami",
  webToken: "web-token",
  telegramSecret: "",
  telegramUserIds: [],
  slackSigningSecret: SIGNING_SECRET,
  slackUserIds: ["U1"],
  voiceToken: "",
  voiceSessionToken: "",
};

let server: Server;
let baseUrl = "";
let resolveConversation: (() => void) | null = null;

function sign(timestamp: string, rawBody: string): string {
  return `v0=${createHmac("sha256", SIGNING_SECRET).update(`v0:${timestamp}:${rawBody}`, "utf8").digest("hex")}`;
}

beforeAll(async () => {
  // Eine Unterhaltung, die absichtlich nie von selbst fertig wird — das ist der Nachweis für
  // die 3-Sekunden-Zusage: die HTTP-Antwort muss da sein, lange bevor dieses Promise auflöst.
  const conversations = {
    of: () =>
      new Promise((resolve) => {
        resolveConversation = () =>
          resolve({ runner: { session: { sessionId: "sess_never_used" } } } as never);
      }),
  } as unknown as GatewayDeps["conversations"];

  const gateway = { pool, conversations, channels: new Map() } as unknown as GatewayDeps;
  const slack: SlackChannelDeps = {
    client: createSlackClient({ token: "xoxb-test" }),
    identity,
    gateway,
    pendingByTs: new Map(),
  };

  const app = createServer({ gateway, identity, web: createWebChannel(), slack });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  resolveConversation?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

describe("POST /channels/slack/events", () => {
  it("beantwortet die url_verification-Herausforderung bei gültiger Signatur", async () => {
    const body = JSON.stringify({ type: "url_verification", token: "x", challenge: "echo-mich" });
    const timestamp = String(Math.floor(Date.now() / 1000));

    const response = await fetch(`${baseUrl}/channels/slack/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": sign(timestamp, body),
      },
      body,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challenge: "echo-mich" });
  });

  it("weist url_verification mit falscher Signatur ab", async () => {
    const body = JSON.stringify({ type: "url_verification", token: "x", challenge: "echo-mich" });
    const timestamp = String(Math.floor(Date.now() / 1000));

    const response = await fetch(`${baseUrl}/channels/slack/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": "v0=falsch",
      },
      body,
    });

    expect(response.status).toBe(401);
  });

  it("weist url_verification ohne Signaturkopfzeilen ab", async () => {
    const response = await fetch(`${baseUrl}/channels/slack/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "url_verification", token: "x", challenge: "echo-mich" }),
    });

    expect(response.status).toBe(401);
  });

  it("antwortet sofort auf ein event_callback, bevor die Verarbeitung fertig ist", async () => {
    const event = {
      type: "event_callback",
      event_id: `Ev${randomUUID().slice(0, 8)}`,
      event: { type: "message", user: "U1", channel: "D1", ts: "1.1", text: "hallo" },
    };
    const body = JSON.stringify(event);
    const timestamp = String(Math.floor(Date.now() / 1000));

    const started = Date.now();
    const response = await fetch(`${baseUrl}/channels/slack/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": sign(timestamp, body),
      },
      body,
    });
    const elapsedMs = Date.now() - started;

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    // `conversations.of` oben löst erst am Ende der ganzen Testdatei auf — die Antwort kam also
    // nachweislich zurück, während die eigentliche Verarbeitung noch aussteht.
    expect(elapsedMs).toBeLessThan(1000);
  });

  it("ist unbekannt, wenn kein Slack-Kanal eingerichtet ist", async () => {
    const gateway = { pool, conversations: {}, channels: new Map() } as unknown as GatewayDeps;
    const app = createServer({ gateway, identity, web: createWebChannel() });
    const withoutSlack = app.listen(0);
    await new Promise<void>((resolve) => withoutSlack.once("listening", resolve));
    const address = withoutSlack.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    const response = await fetch(`http://127.0.0.1:${port}/channels/slack/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "event_callback" }),
    });
    expect(response.status).toBe(404);

    await new Promise<void>((resolve) => withoutSlack.close(() => resolve()));
  });
});
