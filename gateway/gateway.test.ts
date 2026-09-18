import { createHmac, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { deriveLoopState } from "../context/transcript.js";
import { createPool } from "../runtime/db/pool.js";
import { type EventRecord, readEvents } from "../runtime/events/log.js";
import { type BuiltCatalog, buildCatalog } from "../runtime/loop/api.js";
import type {
  ModelClient,
  ModelContentBlock,
  ModelRequest,
  ModelResponse,
} from "../runtime/model/types.js";
import type { JsonValue } from "../runtime/steps/types.js";
import { createSlackChannel, handleSlackEvent } from "./channels/slack/channel.js";
import type { SlackChannelDeps } from "./channels/slack/channel.js";
import { createSlackClient } from "./channels/slack/client.js";
import { createTelegramChannel, handleUpdate } from "./channels/telegram/channel.js";
import type { TelegramChannelDeps } from "./channels/telegram/channel.js";
import { type TelegramUpdate, createTelegramClient } from "./channels/telegram/client.js";
import { type WebChannel, createWebChannel } from "./channels/web.js";
import { type Conversations, createConversations, threadIdFor } from "./conversation.js";
import { type GatewayDeps, type GatewayOutcome, receiveMessage, redeliverPending } from "./core.js";
import { type GatewayIdentity, authenticateWeb } from "./identity.js";
import type { ChannelId, ChannelPort } from "./types.js";

/**
 * Das Fertig-Kriterium von S16, durch das **echte** Gateway: echte Datenbank, echter Router,
 * echte Policy-Engine, echte Ausführungshülle. Gestellt sind genau zwei Dinge — das Modell
 * (ein Drehbuch, wie seit S12) und `fetch` für Telegram (wie die n8n-Brücke seit S13). Beides
 * sind die Stellen, an denen sonst Netz und Zufall hereinkämen.
 *
 * Geprüft werden die vier Punkte des Auftrags:
 *
 *   1. Nachricht über Web, Nachricht über Telegram, **beide im selben Gedächtnis**.
 *   2. **Freigabe per Telegram** erteilen funktioniert, und der Lauf läuft danach weiter.
 *   3. Freigabeanfragen gehen an den **passenden** Kanal.
 *   4. **Authentifizierung am Gateway**: ein Fremder erreicht die Runtime nicht.
 */

const pool = createPool();
const userIds: string[] = [];
let scratchRoot = "";
let artifactRoot = "";
let built: BuiltCatalog;

// ---------------------------------------------------------------------------
// Ein Modell nach Drehbuch
// ---------------------------------------------------------------------------

interface ScriptContext {
  /** Alle Nutzertexte der Historie, in Reihenfolge — das ist das Gedächtnis, aus Modellsicht. */
  userTexts: string[];
  /** Erledigte Werkzeugaufrufe. Steht in der Historie und überlebt damit einen Neustart. */
  toolResults: number;
}

type ScriptAnswer =
  | { text: string }
  | { tool: string; input: Record<string, JsonValue>; callId: string };

function textsOf(request: ModelRequest): string[] {
  const found: string[] = [];
  for (const message of request.messages) {
    if (message.role !== "user") continue;
    for (const block of message.content) {
      if (block.type === "text" && typeof block.text === "string") found.push(block.text);
    }
  }
  return found;
}

function scriptedModel(script: (ctx: ScriptContext) => ScriptAnswer): ModelClient {
  return {
    model: "modell-nach-drehbuch (gateway)",
    async complete(request: ModelRequest): Promise<ModelResponse> {
      let toolResults = 0;
      for (const message of request.messages) {
        for (const block of message.content) if (block.type === "tool_result") toolResults += 1;
      }

      const answer = script({ userTexts: textsOf(request), toolResults });
      const usage = {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      };

      if ("text" in answer) {
        return {
          model: "modell-nach-drehbuch (gateway)",
          stopReason: "end_turn",
          text: answer.text,
          toolCalls: [],
          usage,
          content: [{ type: "text", text: answer.text }],
        };
      }

      const apiName = answer.tool.replace(".", "__");
      const content: ModelContentBlock[] = [
        { type: "text", text: `Ich rufe ${answer.tool} auf.` },
        { type: "tool_use", id: answer.callId, name: apiName, input: answer.input as JsonValue },
      ];
      return {
        model: "modell-nach-drehbuch (gateway)",
        stopReason: "tool_use",
        text: `Ich rufe ${answer.tool} auf.`,
        toolCalls: [{ callId: answer.callId, name: apiName, input: answer.input }],
        usage,
        content,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Ein Telegram, das nur aufschreibt, was es bekommen hätte
// ---------------------------------------------------------------------------

interface TelegramCall {
  method: string;
  body: Record<string, unknown>;
}

interface TelegramFake {
  calls: TelegramCall[];
  fetchImpl: typeof globalThis.fetch;
  /** Dateien, die `downloadFile` ausliefert, nach `file_path`. */
  files: Map<string, Buffer>;
  /** Lässt `sendMessage` scheitern — Telegram ist gerade nicht erreichbar. */
  offline: boolean;
  sent(): TelegramCall[];
  reset(): void;
}

function telegramFake(): TelegramFake {
  const calls: TelegramCall[] = [];
  const files = new Map<string, Buffer>();
  const state = { offline: false };

  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);

    if (url.includes("/file/bot")) {
      const filePath = url.split("/file/bot")[1].split("/").slice(1).join("/");
      const bytes = files.get(filePath);
      calls.push({ method: "downloadFile", body: { filePath } });
      if (!bytes) return new Response("nicht da", { status: 404 });
      return new Response(bytes, {
        status: 200,
        headers: { "content-length": String(bytes.byteLength) },
      });
    }

    const method = url.split("/").pop() ?? "";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ method, body });

    if (state.offline && method === "sendMessage") {
      return new Response(
        JSON.stringify({ ok: false, error_code: 502, description: "bad gateway" }),
        { status: 502 },
      );
    }
    if (method === "getFile") {
      return new Response(
        JSON.stringify({ ok: true, result: { file_path: `documents/${body.file_id}` } }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: calls.length } }), {
      status: 200,
    });
  }) as unknown as typeof globalThis.fetch;

  return {
    calls,
    fetchImpl,
    files,
    get offline() {
      return state.offline;
    },
    set offline(value: boolean) {
      state.offline = value;
    },
    sent: () => calls.filter((call) => call.method === "sendMessage"),
    reset: () => {
      calls.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Ein Slack, das nur aufschreibt, was es bekommen hätte
// ---------------------------------------------------------------------------

interface SlackCall {
  method: string;
  body: Record<string, unknown>;
}

interface SlackFake {
  calls: SlackCall[];
  fetchImpl: typeof globalThis.fetch;
  /** Die `ts`, die der Fake je `chat.postMessage`-Aufruf "vergeben" hat, in Reihenfolge. */
  postedTs: string[];
  posted(): SlackCall[];
  reset(): void;
}

function slackFake(): SlackFake {
  const calls: SlackCall[] = [];
  const postedTs: string[] = [];
  let tsCounter = 1000;

  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = url.split("/").pop() ?? "";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ method, body });

    if (method === "chat.postMessage") {
      tsCounter += 1;
      const ts = `${tsCounter}.000000`;
      postedTs.push(ts);
      return new Response(JSON.stringify({ ok: true, ts }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;

  return {
    calls,
    fetchImpl,
    postedTs,
    posted: () => calls.filter((call) => call.method === "chat.postMessage"),
    reset: () => {
      calls.length = 0;
      postedTs.length = 0;
    },
  };
}

const SLACK_SIGNING_SECRET = "slack-geheim";

function slackSignature(secret: string, timestamp: string, rawBody: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`, "utf8").digest("hex")}`;
}

/** Baut einen signierten `event_callback`-Körper, wie ihn Slacks Events API wirklich schickt. */
function slackRequest(event: Record<string, unknown>): {
  body: unknown;
  timestamp: string;
  signature: string;
  rawBody: string;
} {
  const body = { type: "event_callback", event_id: `Ev${randomUUID().slice(0, 8)}`, event };
  const rawBody = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    body,
    timestamp,
    signature: slackSignature(SLACK_SIGNING_SECRET, timestamp, rawBody),
    rawBody,
  };
}

function slackMessage(text: string, ts: string, threadTs?: string): Record<string, unknown> {
  return {
    type: "message",
    user: SLACK_USER,
    channel: SLACK_CHANNEL,
    ts,
    text,
    ...(threadTs ? { thread_ts: threadTs } : {}),
  };
}

function slackReaction(reaction: string, itemTs: string): Record<string, unknown> {
  return {
    type: "reaction_added",
    user: SLACK_USER,
    reaction,
    item: { type: "message", channel: SLACK_CHANNEL, ts: itemTs },
  };
}

/** Schickt ein Slack-Ereignis über genau den Weg, den `server.ts` auch ginge: mit echter Signatur. */
async function sendSlack(rig: Rig, event: Record<string, unknown>) {
  const req = slackRequest(event);
  return handleSlackEvent(rig.slack, req.body, {
    timestamp: req.timestamp,
    signature: req.signature,
    rawBody: req.rawBody,
  });
}

// ---------------------------------------------------------------------------
// Aufbau
// ---------------------------------------------------------------------------

const TELEGRAM_USER = "11111111";
const TELEGRAM_CHAT = "11111111";
const SLACK_USER = "U0JAKOB";
const SLACK_CHANNEL = "D0JAKOB";

interface Rig {
  userId: string;
  identity: GatewayIdentity;
  gateway: GatewayDeps;
  conversations: Conversations;
  web: WebChannel;
  telegram: TelegramChannelDeps;
  fake: TelegramFake;
  slack: SlackChannelDeps;
  slackFake: SlackFake;
  sessionId(): Promise<string>;
  events(): Promise<EventRecord[]>;
  webMessage(content: string, extra?: Record<string, unknown>): Promise<GatewayOutcome>;
}

const rigs: Rig[] = [];

/**
 * Ein vollständiges Gateway. `reuseUserId` baut ein **zweites** auf derselben Unterhaltung —
 * das ist ein Prozessneustart: frische Läufer, frische Postfächer, dasselbe Protokoll.
 */
async function makeRig(
  script: (ctx: ScriptContext) => ScriptAnswer,
  reuseUserId?: string,
): Promise<Rig> {
  const userId = reuseUserId ?? `test_${randomUUID().slice(0, 8)}`;
  if (!reuseUserId) userIds.push(userId);

  const identity: GatewayIdentity = {
    userId,
    webToken: "web-geheim",
    telegramSecret: "hook-geheim",
    telegramUserIds: [TELEGRAM_USER],
    slackSigningSecret: "slack-geheim",
    slackUserIds: [SLACK_USER],
    voiceToken: "voice-geheim",
    voiceSessionToken: "",
  };

  const conversations = createConversations({
    pool,
    artifactRoot,
    catalog: built.catalog,
    policy: built.policy,
    model: scriptedModel(script),
    conventions: "Kein ORM. Fehler nie verstecken.",
  });

  const fake = telegramFake();
  const web = createWebChannel();
  const channels = new Map<ChannelId, ChannelPort>([["web", web]]);
  const gateway: GatewayDeps = { pool, artifactRoot, conversations, channels };

  const telegram: TelegramChannelDeps = {
    client: createTelegramClient({ token: "bot-token", fetchImpl: fake.fetchImpl }),
    identity,
    gateway,
  };
  channels.set("telegram", createTelegramChannel(telegram));

  const slackFakeClient = slackFake();
  const slack: SlackChannelDeps = {
    client: createSlackClient({ token: "xoxb-test", fetchImpl: slackFakeClient.fetchImpl }),
    identity,
    gateway,
    pendingByTs: new Map(),
  };
  channels.set("slack", createSlackChannel(slack));

  const rig: Rig = {
    userId,
    identity,
    gateway,
    conversations,
    web,
    telegram,
    fake,
    slack,
    slackFake: slackFakeClient,
    async sessionId() {
      return (await conversations.of(userId)).runner.session.sessionId;
    },
    async events() {
      return readEvents(pool, await rig.sessionId());
    },
    async webMessage(content, extra = {}) {
      const auth = authenticateWeb(identity, { token: "web-geheim", displayName: "CLI" });
      if (!auth.ok) throw new Error(auth.message);
      return receiveMessage(gateway, auth.principal, {
        channel: "web",
        sender: auth.principal.sender,
        content,
        attachments: [],
        receivedAt: new Date(),
        externalId: `web:${randomUUID()}`,
        ...extra,
      });
    },
  };

  rigs.push(rig);
  return rig;
}

function telegramMessage(text: string, messageId: number, from = TELEGRAM_USER): TelegramUpdate {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      from: { id: Number(from), first_name: "Jakob" },
      chat: { id: Number(TELEGRAM_CHAT) },
      text,
    },
  };
}

function telegramCallback(callbackData: string, id: string): TelegramUpdate {
  return {
    update_id: 900,
    callback_query: {
      id,
      from: { id: Number(TELEGRAM_USER), first_name: "Jakob" },
      data: callbackData,
      message: { message_id: 5, chat: { id: Number(TELEGRAM_CHAT) } },
    },
  };
}

/** Die Inline-Tastatur der letzten gesendeten Nachricht. */
function keyboardOf(call: TelegramCall): { text: string; callback_data: string }[] {
  const markup = call.body.reply_markup as
    | { inline_keyboard: { text: string; callback_data: string }[][] }
    | undefined;
  return (markup?.inline_keyboard ?? []).map((row) => row[0]);
}

beforeAll(async () => {
  scratchRoot = await mkdtemp(path.join(tmpdir(), "kuronami-gateway-"));
  artifactRoot = path.join(scratchRoot, "artifacts");
  await mkdir(artifactRoot, { recursive: true });
  built = await buildCatalog({ pool, artifactRoot, sourceRoot: scratchRoot });
});

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.conversations.stopAll("test");
});

afterAll(async () => {
  if (userIds.length > 0) {
    const threads = userIds.map(threadIdFor);
    const sessions = "SELECT session_id FROM kuronami.sessions WHERE thread_id = ANY($1)";
    await pool.query(
      `DELETE FROM kuronami.artifacts WHERE (source ->> 'session_id') IN (${sessions})`,
      [threads],
    );
    for (const table of ["approvals", "tasks", "steps", "events"]) {
      await pool.query(`DELETE FROM kuronami.${table} WHERE session_id IN (${sessions})`, [
        threads,
      ]);
    }
    await pool.query("DELETE FROM kuronami.sessions WHERE thread_id = ANY($1)", [threads]);
  }
  await pool.end();
  await rm(scratchRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1 · Ein Nutzer, ein Gedächtnis, unabhängig vom Kanal
// ---------------------------------------------------------------------------

/** Antwortet nur richtig, wenn die frühere Nachricht wirklich in der Historie steht. */
const codewordScript = (ctx: ScriptContext): ScriptAnswer => {
  const last = ctx.userTexts[ctx.userTexts.length - 1] ?? "";
  if (!last.includes("Wie lautet das Codewort")) return { text: "Gemerkt." };

  const earlier = ctx.userTexts.slice(0, -1).find((text) => text.includes("Das Codewort ist "));
  if (!earlier) return { text: "Ich kenne kein Codewort." };
  const word = earlier.split("Das Codewort ist ")[1].split(/[\s.]/)[0];
  return { text: `Das Codewort ist ${word}.` };
};

describe("Fertig-Kriterium · zwei Kanäle, ein Agent, ein Gedächtnis", () => {
  it("beantwortet über Telegram, was über Web gesagt wurde", async () => {
    const rig = await makeRig(codewordScript);

    const first = await rig.webMessage("Merk dir: Das Codewort ist Kirschbluete.");
    expect(first.status).toBe("answered");

    const second = await handleUpdate(
      rig.telegram,
      telegramMessage("Wie lautet das Codewort?", 101),
      { transport: "polling" },
    );

    expect(second.kind).toBe("handled");
    if (second.kind !== "handled") return;
    expect(second.outcome.status).toBe("answered");

    // Das ist der Nachweis: das Modell **kann** das Codewort nur nennen, wenn die Web-Nachricht
    // in der Historie des Telegram-Zugs steht. Zwei Sessions ergäben hier "Ich kenne kein
    // Codewort" — und genau das passiert, wenn man in `conversation.ts` den Kanal der Nachricht
    // statt der Konstanten `gateway` nimmt (Gegenprobe).
    const sent = rig.fake.sent();
    expect(sent).toHaveLength(1);
    expect(sent[0].body.chat_id).toBe(TELEGRAM_CHAT);
    expect(String(sent[0].body.text)).toContain("Kirschbluete");
  });

  it("führt beide Kanäle in genau eine Session auf dem Kanal gateway", async () => {
    const rig = await makeRig(codewordScript);

    await rig.webMessage("Merk dir: Das Codewort ist Kirschbluete.");
    await handleUpdate(rig.telegram, telegramMessage("Wie lautet das Codewort?", 102), {
      transport: "polling",
    });

    const rows = await pool.query<{ session_id: string; channel: string }>(
      "SELECT session_id, channel FROM kuronami.sessions WHERE thread_id = $1",
      [threadIdFor(rig.userId)],
    );

    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].channel).toBe("gateway");
    expect(rows.rows[0].session_id).toBe(await rig.sessionId());
  });

  it("hält den Kanal je Nachricht im Protokoll fest, nicht in der Session", async () => {
    const rig = await makeRig(codewordScript);

    await rig.webMessage("Merk dir: Das Codewort ist Kirschbluete.");
    await handleUpdate(rig.telegram, telegramMessage("Wie lautet das Codewort?", 103), {
      transport: "polling",
    });

    const received = (await rig.events()).filter((event) => event.type === "gateway.received");
    expect(received.map((event) => event.payload.channel)).toEqual(["web", "telegram"]);

    // Die normalisierte Form steht vollständig im Protokoll: Kanal, Absender, Inhalt,
    // Anhänge, Zeit.
    const telegramEvent = received[1];
    expect(telegramEvent.payload.kind).toBe("message");
    expect(telegramEvent.payload.sender).toMatchObject({
      channel_user_id: TELEGRAM_USER,
      display_name: "Jakob",
      reply_to: TELEGRAM_CHAT,
    });
    expect(telegramEvent.payload.content).toBe("Wie lautet das Codewort?");
    expect(telegramEvent.payload.attachments).toEqual([]);
    expect(typeof telegramEvent.payload.received_at).toBe("string");
    expect(telegramEvent.payload.user_id).toBe(rig.userId);
    // `auth_method` und nicht `auth`: der zweite Name steht in `SECRET_FIELD_NAMES`, und der
    // Redaction-Filter ersetzte den Wert (beim Bauen genau so passiert). Der Filter hatte
    // recht — hier steht der Weg der Prüfung, nie ein Nachweis.
    expect(telegramEvent.payload.auth_method).toBe("telegram:polling");
  });

  it("legt beide Nachrichten als Züge in dieselbe Historie", async () => {
    const rig = await makeRig(codewordScript);

    await rig.webMessage("Merk dir: Das Codewort ist Kirschbluete.");
    await handleUpdate(rig.telegram, telegramMessage("Wie lautet das Codewort?", 104), {
      transport: "polling",
    });

    const loop = deriveLoopState(await rig.events());
    const history = JSON.stringify(loop.messages);

    expect(history).toContain("Das Codewort ist Kirschbluete");
    expect(history).toContain("Wie lautet das Codewort");
    // Der Zug ist zu, aber die Session bleibt offen: eine Unterhaltung ist nicht nach der
    // ersten Antwort fertig (`completeOnDone: false`).
    expect(loop.turnId).toBeNull();
    expect((await rig.events()).some((event) => event.type === "session.completed")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2 · Freigabe per Telegram
// ---------------------------------------------------------------------------

/** Schreibt in die Quellzone — hartes Schreiben, braucht nach Abschnitt 10 eine Freigabe. */
const reportScript = (ctx: ScriptContext): ScriptAnswer => {
  if (ctx.toolResults === 0) {
    return {
      tool: "fs.write",
      callId: "call_write_1",
      input: { path: "bericht.txt", content: "Bericht aus dem Gateway-Test.\n" },
    };
  }
  return { text: "Bericht geschrieben." };
};

/** Wie `reportScript`, aber auf eine eigene Datei — `scratchRoot`/die Quellzone sind über die
 * ganze Datei hinweg geteilt (ein `beforeAll`), und die Telegram-Freigabetests oben schreiben
 * "bericht.txt" bereits fertig. Ein eigener Zielname hält die Slack-Tests unten unabhängig von
 * der Ausführungsreihenfolge der übrigen `describe`-Blöcke. */
const slackReportScript = (ctx: ScriptContext): ScriptAnswer => {
  if (ctx.toolResults === 0) {
    return {
      tool: "fs.write",
      callId: "call_write_slack_1",
      input: { path: "bericht-slack.txt", content: "Bericht aus dem Gateway-Test.\n" },
    };
  }
  return { text: "Bericht geschrieben." };
};

describe("Fertig-Kriterium · Freigabe per Telegram", () => {
  it("hält an, schickt die Frage mit Knöpfen nach Telegram und schreibt nichts", async () => {
    const rig = await makeRig(reportScript);

    const outcome = await handleUpdate(rig.telegram, telegramMessage("Schreib den Bericht.", 201), {
      transport: "polling",
    });

    expect(outcome.kind).toBe("handled");
    if (outcome.kind !== "handled") return;
    expect(outcome.outcome.status).toBe("awaiting_user");

    const sent = rig.fake.sent();
    expect(sent).toHaveLength(1);
    expect(sent[0].body.chat_id).toBe(TELEGRAM_CHAT);
    const keyboard = keyboardOf(sent[0]);
    expect(keyboard.map((button) => button.callback_data.split("|")[1])).toContain("once");
    expect(keyboard.map((button) => button.callback_data.split("|")[1])).toContain("deny");
    for (const button of keyboard) {
      expect(Buffer.byteLength(button.callback_data, "utf8")).toBeLessThanOrEqual(64);
    }

    // Nichts geschrieben, und die Frage ging **nicht** ins Web-Postfach.
    await expect(stat(path.join(scratchRoot, "bericht.txt"))).rejects.toThrow();
    expect(rig.web.peek(rig.userId)).toEqual([]);

    const events = await rig.events();
    expect(events.some((event) => event.type === "approval.requested")).toBe(true);
    expect(events.some((event) => event.type === "step.started")).toBe(false);
    const delivered = events.filter((event) => event.type === "gateway.delivered");
    expect(delivered).toHaveLength(1);
    expect(delivered[0].payload.channel).toBe("telegram");
    expect(delivered[0].payload.kind).toBe("approval");
  });

  it("setzt den Lauf nach einem Knopfdruck fort und führt den Schritt aus", async () => {
    const rig = await makeRig(reportScript);

    await handleUpdate(rig.telegram, telegramMessage("Schreib den Bericht.", 202), {
      transport: "polling",
    });
    const button = keyboardOf(rig.fake.sent()[0]).find((entry) =>
      entry.callback_data.endsWith("|once"),
    );
    expect(button).toBeDefined();
    if (!button) return;
    rig.fake.reset();

    const answered = await handleUpdate(
      rig.telegram,
      telegramCallback(button.callback_data, "cbq_202"),
      { transport: "polling" },
    );

    expect(answered.kind).toBe("handled");
    if (answered.kind !== "handled") return;
    expect(answered.outcome.status).toBe("answered");

    // Der Knopfdruck wurde quittiert, und die Antwort ging zurück nach Telegram.
    expect(rig.fake.calls.map((call) => call.method)).toContain("answerCallbackQuery");
    expect(String(rig.fake.sent()[0].body.text)).toContain("Bericht geschrieben");

    // Und der Seiteneffekt ist wirklich passiert.
    expect(await readFile(path.join(scratchRoot, "bericht.txt"), "utf8")).toBe(
      "Bericht aus dem Gateway-Test.\n",
    );

    const events = await rig.events();
    const types = events.map((event) => event.type);
    expect(types).toContain("approval.granted");
    expect(types).toContain("policy.allowed");
    expect(types).toContain("step.completed");
    expect(types).toContain("turn.completed");

    // Der Freigabepfad nennt den Menschen auf seinem Kanal, nicht "operator" (Abschnitt 10).
    const granted = events.find((event) => event.type === "approval.granted");
    expect(granted?.payload.decided_by).toBe(`telegram:${TELEGRAM_USER}`);

    // Die Entscheidung selbst steht als eingegangene Nachricht im Protokoll — daran hängt die
    // Zuordnung späterer Rückfragen.
    const decision = events.find(
      (event) => event.type === "gateway.received" && event.payload.kind === "decision",
    );
    expect(decision?.payload.channel).toBe("telegram");
    expect(decision?.payload.choice_id).toBe("once");
  });

  it("weist einen Knopf ab, dessen Frage nicht mehr offen ist", async () => {
    const rig = await makeRig(reportScript);

    await handleUpdate(rig.telegram, telegramMessage("Schreib den Bericht.", 203), {
      transport: "polling",
    });
    const button = keyboardOf(rig.fake.sent()[0]).find((entry) =>
      entry.callback_data.endsWith("|once"),
    );
    if (!button) throw new Error("kein Knopf");

    await handleUpdate(rig.telegram, telegramCallback(button.callback_data, "cbq_a"), {
      transport: "polling",
    });
    rig.fake.reset();

    // Zweiter Druck auf denselben Knopf, mit eigener Kennung: die Frage ist entschieden.
    const again = await handleUpdate(
      rig.telegram,
      telegramCallback(button.callback_data, "cbq_b"),
      { transport: "polling" },
    );

    expect(again.kind).toBe("rejected");
    expect(String(rig.fake.sent()[0].body.text)).toContain("keine offene Rückfrage");
  });
});

// ---------------------------------------------------------------------------
// 3 · Der passende Kanal
// ---------------------------------------------------------------------------

describe("Freigabeanfragen gehen an den passenden Kanal", () => {
  it("schickt die Frage eines Web-Zugs ins Web-Postfach und nicht nach Telegram", async () => {
    const rig = await makeRig(reportScript);

    const outcome = await rig.webMessage("Schreib den Bericht.");

    expect(outcome.status).toBe("awaiting_user");
    expect(outcome.delivered).toHaveLength(1);
    expect(outcome.delivered[0].kind).toBe("approval");
    // Telegram ist eingerichtet und wurde trotzdem nicht angefasst.
    expect(rig.fake.sent()).toHaveLength(0);

    const delivered = (await rig.events()).filter((event) => event.type === "gateway.delivered");
    expect(delivered[0].payload.channel).toBe("web");
  });

  it("stellt eine Rückfrage nach einem Neustart nach, an ihren Kanal und genau einmal", async () => {
    // Der Fall, für den `gateway.delivered` und die Faltung überhaupt existieren: die Frage
    // steht im Protokoll, ist aber nie hinausgegangen. Ein neu gestarteter Prozess hat keinen
    // "Absender von gerade eben" mehr, an den er sie hängen könnte — er muss sie aus dem
    // Protokoll wiederfinden, samt Kanal.
    const rig = await makeRig(reportScript);
    rig.fake.offline = true;

    await handleUpdate(rig.telegram, telegramMessage("Schreib den Bericht.", 501), {
      transport: "polling",
    });

    const before = await rig.events();
    expect(before.some((event) => event.type === "approval.requested")).toBe(true);
    // Zustellung gescheitert, also **kein** `gateway.delivered` — und der Fehlschlag steht im
    // Protokoll statt still zu verschwinden.
    expect(before.some((event) => event.type === "gateway.delivered")).toBe(false);
    expect(before.some((event) => event.type === "error.raised")).toBe(true);

    // Neustart: zweites Gateway auf derselben Unterhaltung.
    const restarted = await makeRig(reportScript, rig.userId);
    const conversation = await restarted.conversations.of(rig.userId);
    expect(conversation.runner.session.sessionId).toBe(await rig.sessionId());

    const redelivered = await redeliverPending(restarted.gateway, conversation);

    expect(redelivered).toHaveLength(1);
    expect(redelivered[0].kind).toBe("approval");
    const sent = restarted.fake.sent();
    expect(sent).toHaveLength(1);
    expect(sent[0].body.chat_id).toBe(TELEGRAM_CHAT);
    expect(keyboardOf(sent[0]).length).toBeGreaterThan(0);

    // Ein zweiter Anlauf schickt nichts mehr: jetzt steht ein `gateway.delivered` da.
    expect(await redeliverPending(restarted.gateway, conversation)).toEqual([]);
    expect(restarted.fake.sent()).toHaveLength(1);
  });

  it("stellt eine offene Frage nicht zweimal zu", async () => {
    const rig = await makeRig(reportScript);

    await rig.webMessage("Schreib den Bericht.");
    const drained = rig.web.drain(rig.userId);
    expect(drained).toHaveLength(1);

    // Eine zweite Nachricht, während die Frage offen ist: sie geht **nicht** in einen Zug, und
    // die Frage wird nicht erneut als Freigabeanfrage verschickt.
    const second = await rig.webMessage("Und noch was.");

    expect(second.status).toBe("busy");
    expect(second.delivered).toHaveLength(1);
    expect(second.delivered[0].kind).toBe("reply");
    const turns = (await rig.events()).filter((event) => event.type === "turn.started");
    expect(turns).toHaveLength(1);
  });

  it("nimmt eine getippte Antwort im Wortlaut als Entscheidung (Nachtrag 2026-09-16)", async () => {
    // Der Fall, an dem die Web-Unterhaltung stillstand: der Nutzer tippt (oder spricht) die
    // Antwort, statt zu klicken. Trifft sie eindeutig eine Option, ist sie die Entscheidung —
    // derselbe strenge Abgleich wie in der Sprachbrücke (`gateway/choices.ts`).
    const rig = await makeRig(reportScript);

    const asked = await rig.webMessage("Schreib den Bericht.");
    expect(asked.status).toBe("awaiting_user");

    const answered = await rig.webMessage("Nur dieses eine Mal erlauben");

    expect(answered.status).toBe("answered");
    const events = await rig.events();
    const types = events.map((event) => event.type);
    expect(types).toContain("approval.granted");
    expect(types).toContain("step.completed");
    expect(types).toContain("turn.completed");

    // Beides steht im Protokoll: der Wortlaut als Nachricht, die Zuordnung als Entscheidung.
    const received = events.filter((event) => event.type === "gateway.received");
    expect(received.map((event) => event.payload.kind)).toEqual(["message", "message", "decision"]);
    const decision = received[2];
    expect(decision.payload.channel).toBe("web");
    expect(decision.payload.choice_id).toBe("once");
    // Entschieden hat ein Mensch am Web-Kanal, nicht "operator" (Abschnitt 10).
    const granted = events.find((event) => event.type === "approval.granted");
    expect(String(granted?.payload.decided_by)).toMatch(/^web:/);
  });
});

// ---------------------------------------------------------------------------
// 4 · Authentifizierung am Gateway
// ---------------------------------------------------------------------------

describe("Authentifizierung am Gateway", () => {
  it("lässt einen fremden Telegram-Absender nicht an die Runtime", async () => {
    const rig = await makeRig(codewordScript);

    const result = await handleUpdate(
      rig.telegram,
      telegramMessage("Lösch mal alles.", 301, "99999999"),
      { transport: "polling" },
    );

    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") return;
    expect(result.reason).toContain("99999999");

    // Keine Unterhaltung, keine Session, kein Ereignis — und kein einziger Telegram-Aufruf:
    // dem Fremden wird nicht einmal geantwortet.
    expect(rig.conversations.open()).toEqual([]);
    expect(rig.fake.calls).toEqual([]);
    const rows = await pool.query("SELECT 1 FROM kuronami.sessions WHERE thread_id = $1", [
      threadIdFor(rig.userId),
    ]);
    expect(rows.rowCount).toBe(0);
  });

  it("holt für einen fremden Absender nicht einmal den Anhang", async () => {
    const rig = await makeRig(codewordScript);
    rig.fake.files.set("documents/FILE1", Buffer.from("geheim"));

    const update: TelegramUpdate = {
      update_id: 302,
      message: {
        message_id: 302,
        date: Math.floor(Date.now() / 1000),
        from: { id: 99999999, first_name: "Fremd" },
        chat: { id: 99999999 },
        caption: "hier",
        document: { file_id: "FILE1", file_name: "x.txt", mime_type: "text/plain" },
      },
    };

    expect((await handleUpdate(rig.telegram, update, { transport: "polling" })).kind).toBe(
      "rejected",
    );
    // Beschreiben, authentifizieren, **dann** holen: getFile und downloadFile sind nie gelaufen.
    expect(rig.fake.calls.map((call) => call.method)).toEqual([]);
  });

  it("weist ein Webhook-Update mit falschem Geheimnis ab", async () => {
    const rig = await makeRig(codewordScript);

    const result = await handleUpdate(rig.telegram, telegramMessage("Hallo", 303), {
      transport: "webhook",
      secretHeader: "falsch",
    });

    expect(result.kind).toBe("rejected");
    expect(rig.conversations.open()).toEqual([]);
  });

  it("nimmt dasselbe Update mit richtigem Geheimnis an", async () => {
    const rig = await makeRig(codewordScript);

    const result = await handleUpdate(rig.telegram, telegramMessage("Hallo", 304), {
      transport: "webhook",
      secretHeader: "hook-geheim",
    });

    expect(result.kind).toBe("handled");
  });
});

// ---------------------------------------------------------------------------
// 5 · Anhänge und Doppelzustellung
// ---------------------------------------------------------------------------

describe("Anhänge und Doppelzustellung", () => {
  it("legt einen Anhang als Artefakt ab und gibt dem Lauf nur das Handle", async () => {
    const rig = await makeRig(() => ({ text: "Angekommen." }));
    const bytes = Buffer.from("Zeile eins\nZeile zwei\n", "utf8");

    const outcome = await rig.webMessage("Das hier bitte ablegen", {
      attachments: [{ name: "notiz.txt", mimeType: "text/plain", bytes: new Uint8Array(bytes) }],
    });

    expect(outcome.status).toBe("answered");
    const sessionId = await rig.sessionId();

    const rows = await pool.query<{
      uri: string;
      source: { tool: string; step_id: string | null };
    }>("SELECT uri, source FROM kuronami.artifacts WHERE (source ->> 'session_id') = $1", [
      sessionId,
    ]);
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].source.tool).toBe("gateway:web");
    // Der erste echte `step_id: null`-Fall (S06 hat ihn zugelassen, aber nie erzeugt): ein
    // Anhang entsteht, bevor irgendein Schritt geplant ist.
    expect(rows.rows[0].source.step_id).toBeNull();

    const events = await rig.events();
    const received = events.find((event) => event.type === "gateway.received");
    expect(received?.payload.attachments).toMatchObject([
      { name: "notiz.txt", mime_type: "text/plain", size_bytes: bytes.byteLength },
    ]);

    // Im Zugtext steht das Handle, nicht der Inhalt.
    const turn = events.find((event) => event.type === "turn.started");
    const prompt = String(turn?.payload.prompt);
    expect(prompt).toContain(rows.rows[0].uri);
    expect(prompt).toContain("notiz.txt");
    expect(prompt).not.toContain("Zeile zwei");
  });

  it("macht aus einem erneut zugestellten Telegram-Update keinen zweiten Zug", async () => {
    const rig = await makeRig(() => ({ text: "Angekommen." }));
    const update = telegramMessage("Einmal ist genug.", 401);

    const first = await handleUpdate(rig.telegram, update, { transport: "polling" });
    const second = await handleUpdate(rig.telegram, update, { transport: "polling" });

    expect(first.kind === "handled" && first.outcome.status).toBe("answered");
    expect(second.kind === "handled" && second.outcome.status).toBe("duplicate");

    const turns = (await rig.events()).filter((event) => event.type === "turn.started");
    expect(turns).toHaveLength(1);
    // Und kein zweites Echo im Chat.
    expect(rig.fake.sent()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 6 · Freigabe per Slack (Reaktion und Thread-Antwort) — S26
// ---------------------------------------------------------------------------

describe("Freigabe per Slack (Reaktion und Thread-Antwort)", () => {
  it("nimmt eine neue Slack-Nachricht als Zug an und antwortet im selben Kanal", async () => {
    const rig = await makeRig(() => ({ text: "Angekommen." }));

    const outcome = await sendSlack(rig, slackMessage("Hallo Kuronami.", "200.001"));
    expect(outcome.kind).toBe("handled");
    if (outcome.kind !== "handled") return;
    expect(outcome.outcome.status).toBe("answered");

    const posted = rig.slackFake.posted();
    expect(posted).toHaveLength(1);
    expect(posted[0].body.channel).toBe(SLACK_CHANNEL);
    expect(String(posted[0].body.text)).toContain("Angekommen");
  });

  it("hält an, postet die Frage mit nummerierten Optionen und setzt Ziffern-Reaktionen", async () => {
    const rig = await makeRig(slackReportScript);

    const outcome = await sendSlack(rig, slackMessage("Schreib den Bericht.", "201.001"));
    expect(outcome.kind).toBe("handled");
    if (outcome.kind !== "handled") return;
    expect(outcome.outcome.status).toBe("awaiting_user");

    const posted = rig.slackFake.posted();
    expect(posted).toHaveLength(1);
    expect(posted[0].body.channel).toBe(SLACK_CHANNEL);
    expect(String(posted[0].body.text)).toContain("1. ");

    const reactions = rig.slackFake.calls.filter((call) => call.method === "reactions.add");
    expect(reactions.length).toBeGreaterThan(0);
    expect(reactions.map((call) => call.body.name)).toContain("one");
    expect(reactions.every((call) => call.body.timestamp === rig.slackFake.postedTs[0])).toBe(true);

    // Nichts geschrieben, kein Web-Eintrag.
    await expect(stat(path.join(scratchRoot, "bericht-slack.txt"))).rejects.toThrow();
    expect(rig.web.peek(rig.userId)).toEqual([]);
  });

  it("löst eine Freigabe über eine Reaktion auf und führt den Schritt aus", async () => {
    const rig = await makeRig(slackReportScript);
    await sendSlack(rig, slackMessage("Schreib den Bericht.", "202.001"));
    const messageTs = rig.slackFake.postedTs[0];
    rig.slackFake.reset();

    const answered = await sendSlack(rig, slackReaction("one", messageTs));
    expect(answered.kind).toBe("handled");
    if (answered.kind !== "handled") return;
    expect(answered.outcome.status).toBe("answered");

    expect(await readFile(path.join(scratchRoot, "bericht-slack.txt"), "utf8")).toBe(
      "Bericht aus dem Gateway-Test.\n",
    );

    const events = await rig.events();
    const granted = events.find((event) => event.type === "approval.granted");
    expect(granted?.payload.decided_by).toBe(`slack:${SLACK_USER}`);
    const decision = events.find(
      (event) => event.type === "gateway.received" && event.payload.kind === "decision",
    );
    expect(decision?.payload.channel).toBe("slack");
    expect(decision?.payload.choice_id).toBe("once");
  });

  it("löst eine Freigabe über eine Thread-Antwort mit Options-Text auf", async () => {
    const rig = await makeRig(slackReportScript);
    await sendSlack(rig, slackMessage("Schreib den Bericht.", "203.001"));
    const messageTs = rig.slackFake.postedTs[0];
    rig.slackFake.reset();

    const answered = await sendSlack(rig, slackMessage("once", "203.099", messageTs));
    expect(answered.kind).toBe("handled");
    if (answered.kind !== "handled") return;
    expect(answered.outcome.status).toBe("answered");

    expect(await readFile(path.join(scratchRoot, "bericht-slack.txt"), "utf8")).toBe(
      "Bericht aus dem Gateway-Test.\n",
    );
    const decision = (await rig.events()).find(
      (event) => event.type === "gateway.received" && event.payload.kind === "decision",
    );
    expect(decision?.payload.choice_id).toBe("once");
  });

  it("ignoriert eine Nachricht/Reaktion eines nicht erlaubten Slack-Absenders", async () => {
    const rig = await makeRig(() => ({ text: "Angekommen." }));

    const result = await sendSlack(rig, {
      type: "message",
      user: "U_FREMD",
      channel: SLACK_CHANNEL,
      ts: "300.001",
      text: "Lösch mal alles.",
    });

    expect(result.kind).toBe("rejected");
    expect(rig.conversations.open()).toEqual([]);
    expect(rig.slackFake.calls).toEqual([]);
  });

  it("weist eine Zustellung mit falscher Signatur ab", async () => {
    const rig = await makeRig(() => ({ text: "Angekommen." }));
    const req = slackRequest(slackMessage("Hallo", "301.001"));

    const result = await handleSlackEvent(rig.slack, req.body, {
      timestamp: req.timestamp,
      signature: "v0=falsch",
      rawBody: req.rawBody,
    });

    expect(result.kind).toBe("rejected");
    expect(rig.conversations.open()).toEqual([]);
  });

  it("verwirft eine Nachricht des eigenen Bots und eine mit subtype", async () => {
    const rig = await makeRig(() => ({ text: "Angekommen." }));

    const botResult = await sendSlack(rig, {
      type: "message",
      user: SLACK_USER,
      bot_id: "B123",
      channel: SLACK_CHANNEL,
      ts: "302.001",
      text: "Ich bin der Bot.",
    });
    expect(botResult.kind).toBe("ignored");

    const editResult = await sendSlack(rig, {
      type: "message",
      subtype: "message_changed",
      user: SLACK_USER,
      channel: SLACK_CHANNEL,
      ts: "302.002",
      text: "bearbeitet",
    });
    expect(editResult.kind).toBe("ignored");

    expect(rig.slackFake.calls).toEqual([]);
  });
});
