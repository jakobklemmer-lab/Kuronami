import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EventRecord } from "../../../runtime/events/log.js";
import type { GatewayDeps } from "../../core.js";
import {
  type GatewayIdentity,
  authenticateVoice,
  configuredChannels,
  identityFromEnv,
} from "../../identity.js";
import { deriveAskRoutes } from "../../routing.js";
import { createServer } from "../../server.js";
import { createWebChannel } from "../web.js";
import { VOICE_OUTBOX_LIMIT, createVoiceChannel } from "./channel.js";

/**
 * Der Sprach-Kanal (S30): Postfach, Ausweis, Rand.
 *
 * Diese Datei läuft mit `pnpm test` — anders als die übrigen `gateway/**`-Tests, die seit S21
 * aus dem Lauf genommen sind (`vitest.config.ts`). Die Ausnahme steht dort namentlich: neue
 * Arbeit ohne laufendes Netz zu bauen wäre der schlechtere Handel, und die 679 alten Tests
 * bleiben davon unberührt.
 *
 * Ohne Datenbank: geprüft werden Postfach, Authentifizierung und die Abweisungen am Rand. Was
 * ein Zug *tut*, prüft `gateway.test.ts` gegen echtes Postgres — und die Sprachseite davon
 * `voice/pipeline/tests/test_bridge.py` gegen eine echte Pipecat-Pipeline.
 */

const TOKEN = "sprach-geheim-4711";

const identity: GatewayIdentity = {
  userId: "kuronami",
  webToken: "web-geheim",
  telegramSecret: "",
  telegramUserIds: [],
  slackSigningSecret: "",
  slackUserIds: [],
  voiceToken: TOKEN,
  voiceSessionToken: "",
};

function sender(replyTo = "voice") {
  return {
    channel: "voice" as const,
    channelUserId: "kuronami",
    displayName: "Sprache",
    replyTo,
  };
}

describe("Postfach des Sprach-Kanals", () => {
  it("hält eine Zustellung bereit und gibt sie beim Abholen genau einmal heraus", async () => {
    const channel = createVoiceChannel();
    await channel.deliver(sender(), { kind: "reply", text: "Drei Termine heute." });

    expect(channel.peek("voice")).toHaveLength(1);
    const drained = channel.drain("voice");
    expect(drained.map((entry) => entry.message)).toEqual([
      { kind: "reply", text: "Drei Termine heute." },
    ]);
    expect(channel.drain("voice")).toEqual([]);
  });

  it("trennt die Postfächer nach Sitzung", async () => {
    const channel = createVoiceChannel();
    await channel.deliver(sender("sitzung-a"), { kind: "reply", text: "A" });
    await channel.deliver(sender("sitzung-b"), { kind: "reply", text: "B" });

    expect(channel.drain("sitzung-a").map((entry) => entry.message)).toEqual([
      { kind: "reply", text: "A" },
    ]);
    expect(channel.peek("sitzung-b")).toHaveLength(1);
  });

  it("wirft die ältesten heraus, nicht die neuesten", async () => {
    const channel = createVoiceChannel();
    for (let index = 0; index < VOICE_OUTBOX_LIMIT + 5; index += 1) {
      await channel.deliver(sender(), { kind: "reply", text: `n${index}` });
    }
    const drained = channel.drain("voice");
    expect(drained).toHaveLength(VOICE_OUTBOX_LIMIT);
    // Die jüngste Zustellung ist die, auf die jemand wartet.
    expect(drained.at(-1)?.message).toEqual({ kind: "reply", text: `n${VOICE_OUTBOX_LIMIT + 4}` });
    expect(drained.at(0)?.message).toEqual({ kind: "reply", text: "n5" });
  });

  it("nimmt eine Freigabeanfrage mit ihren Optionen auf, ohne sie umzuschreiben", async () => {
    const channel = createVoiceChannel();
    await channel.deliver(sender(), {
      kind: "approval",
      askId: "policy:call-1",
      question: "Darf ich die Datei überschreiben?",
      options: [
        { id: "genehmigen", label: "Genehmigen" },
        { id: "ablehnen", label: "Ablehnen" },
      ],
    });
    const [delivery] = channel.drain("voice");
    expect(delivery.message).toEqual({
      kind: "approval",
      askId: "policy:call-1",
      question: "Darf ich die Datei überschreiben?",
      options: [
        { id: "genehmigen", label: "Genehmigen" },
        { id: "ablehnen", label: "Ablehnen" },
      ],
    });
  });
});

describe("Ausweis des Sprach-Kanals", () => {
  it("lässt den richtigen Token durch und trägt den Kanal ein", () => {
    const result = authenticateVoice(identity, { token: TOKEN });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal.userId).toBe("kuronami");
    expect(result.principal.sender.channel).toBe("voice");
    expect(result.principal.sender.replyTo).toBe("voice");
    expect(result.principal.authMethod).toBe("voice:bearer");
  });

  it("weist einen falschen Token ab", () => {
    const result = authenticateVoice(identity, { token: "daneben" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("bad_credential");
  });

  it("weist einen fehlenden Token ab", () => {
    const result = authenticateVoice(identity, { token: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("missing_credential");
  });

  it("ist ohne VOICE_BRIDGE_TOKEN gar nicht erst bedienbar", () => {
    const result = authenticateVoice({ ...identity, voiceToken: "" }, { token: TOKEN });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("channel_not_configured");
  });

  it("nimmt den Web-Token nicht an — zwei Prozesse, zwei Ausweise", () => {
    const result = authenticateVoice(identity, { token: "web-geheim" });
    expect(result.ok).toBe(false);
  });

  it("kommt aus der Umgebung und schaltet den Kanal an", () => {
    const found = identityFromEnv({ VOICE_BRIDGE_TOKEN: " s3cr3t " } as NodeJS.ProcessEnv);
    expect(found.voiceToken).toBe("s3cr3t");
    expect(configuredChannels(found)).toEqual(["voice"]);
  });
});

describe("Rückfragen gehen an den Kanal, von dem die Sprache kam", () => {
  it("ordnet eine Freigabeanfrage nach einer Sprachnachricht dem Sprach-Kanal zu", () => {
    const events: EventRecord[] = [
      {
        type: "gateway.received",
        payload: {
          kind: "message",
          channel: "voice",
          sender: { channel_user_id: "kuronami", display_name: "Sprache", reply_to: "voice" },
          external_id: "voice:1",
        },
      },
      {
        type: "approval.requested",
        payload: {
          ask_id: "policy:call-9",
          kind: "policy",
          question: "Darf ich?",
          options: [{ id: "ja", label: "Ja" }],
        },
      },
    ] as unknown as EventRecord[];

    const routes = deriveAskRoutes(events);
    expect(routes).toHaveLength(1);
    expect(routes[0].to.channel).toBe("voice");
    expect(routes[0].delivered).toBe(false);
  });
});

describe("HTTP-Rand des Sprach-Kanals", () => {
  let server: Server;
  let baseUrl = "";

  beforeAll(async () => {
    // Kein Pool und keine Unterhaltung: jede Anfrage dieses Blocks wird **vor** dem Kern
    // abgewiesen. Käme eine davon doch bis zur Runtime, fiele der Test mit einem Fehler auf —
    // und genau das soll er.
    const gateway = { channels: new Map() } as unknown as GatewayDeps;
    const app = createServer({
      gateway,
      identity,
      web: createWebChannel(),
      voice: createVoiceChannel(),
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function post(path: string, body: unknown, token?: string) {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  it("weist eine Nachricht ohne Token mit 401 ab", async () => {
    const response = await post("/channels/voice/messages", { content: "Lösch alles" });
    expect(response.status).toBe(401);
  });

  it("weist einen falschen Token mit 401 ab", async () => {
    const response = await post("/channels/voice/messages", { content: "Hallo" }, "daneben");
    expect(response.status).toBe(401);
  });

  it("verlangt einen Inhalt", async () => {
    const response = await post("/channels/voice/messages", { content: 42 }, TOKEN);
    expect(response.status).toBe(400);
  });

  it("verlangt askId und choiceId für eine Entscheidung", async () => {
    const response = await post("/channels/voice/answers", { askId: "policy:x" }, TOKEN);
    expect(response.status).toBe(400);
  });

  it("nennt den Kanal in /health, wenn er eingerichtet ist", async () => {
    const health = (await (await fetch(`${baseUrl}/health`)).json()) as { channels: string[] };
    expect(health.channels).toContain("voice");
  });

  it("gibt das leere Postfach hinter dem Token heraus", async () => {
    const response = await fetch(`${baseUrl}/channels/voice/outbox`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deliveries: [] });
  });
});

describe("Ein Gateway ohne Sprachschicht", () => {
  let server: Server;
  let baseUrl = "";

  beforeAll(async () => {
    const gateway = { channels: new Map() } as unknown as GatewayDeps;
    const app = createServer({
      gateway,
      identity: { ...identity, voiceToken: "" },
      web: createWebChannel(),
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("antwortet auf eine Sprachnachricht mit 404 statt sie durchzulassen", async () => {
    const response = await fetch(`${baseUrl}/channels/voice/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "Hallo" }),
    });
    expect(response.status).toBe(404);
  });

  it("nennt den Kanal nicht in /health", async () => {
    const health = (await (await fetch(`${baseUrl}/health`)).json()) as { channels: string[] };
    expect(health.channels).not.toContain("voice");
  });
});
