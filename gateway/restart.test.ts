import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWebChannel } from "./channels/web.js";
import type { GatewayDeps } from "./core.js";
import type { GatewayIdentity } from "./identity.js";
import { type RestartService, createServer } from "./server.js";

/**
 * `POST /settings/restart` (Nachtrag 2026-09-16).
 *
 * Der Kern dieser Route ist eine Verneinung: aus dem Browser kommt **nur** die Wahl zwischen
 * drei Namen, nie ein Kommando. Die Tests unten prüfen deshalb vor allem, was *nicht* durchgeht
 * — ein fremder Dienstname, ein zusammengebautes Kommando, ein Aufruf ohne Ausweis. Dass der
 * gewählte Dienst ankommt, ist der einfachere Teil.
 */

const TOKEN = "test-token";

const identity: GatewayIdentity = {
  userId: "kuronami",
  webToken: TOKEN,
  telegramSecret: "",
  telegramUserIds: [],
  slackSigningSecret: "",
  slackUserIds: [],
  voiceToken: "",
  voiceSessionToken: "",
};

function fakeRestart(): { deps: { restart(s: RestartService): Promise<void> }; calls: string[] } {
  const calls: string[] = [];
  return {
    deps: {
      restart: async (service) => {
        calls.push(service);
      },
    },
    calls,
  };
}

async function listen(
  app: ReturnType<typeof createServer>,
): Promise<{ server: Server; baseUrl: string }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function post(baseUrl: string, body: unknown, token = TOKEN): Promise<Response> {
  return fetch(`${baseUrl}/settings/restart`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /settings/restart", () => {
  let server: Server;
  let baseUrl = "";
  let restart: ReturnType<typeof fakeRestart>;

  beforeAll(async () => {
    restart = fakeRestart();
    const app = createServer({
      gateway: {} as unknown as GatewayDeps,
      identity,
      web: createWebChannel(),
      restart: restart.deps,
    });
    ({ server, baseUrl } = await listen(app));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("weist einen Aufruf ohne Bearer-Token ab, ohne etwas zu starten", async () => {
    const response = await fetch(`${baseUrl}/settings/restart`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ service: "gateway" }),
    });
    expect(response.status).toBe(401);
    expect(restart.calls).toEqual([]);
  });

  it("startet den gewählten Dienst", async () => {
    const response = await post(baseUrl, { service: "voice" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ service: "voice", started: true });
    // Der Neustart hängt an `res.on("finish")` — er läuft, nachdem die Antwort draußen ist.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(restart.calls).toEqual(["voice"]);
  });

  it("weist einen unbekannten Dienstnamen ab", async () => {
    const before = [...restart.calls];
    const response = await post(baseUrl, { service: "postgres" });
    expect(response.status).toBe(400);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(restart.calls).toEqual(before);
  });

  it("lässt kein Kommando durch, das wie ein Dienstname aussieht", async () => {
    const before = [...restart.calls];
    for (const attempt of [
      "gateway; rm -rf /",
      "gateway && curl evil.test",
      "$(reboot)",
      "../../bin/sh",
      "",
    ]) {
      const response = await post(baseUrl, { service: attempt });
      expect(response.status).toBe(400);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(restart.calls).toEqual(before);
  });

  it("weist einen Dienstnamen ab, der kein String ist", async () => {
    const before = [...restart.calls];
    for (const attempt of [null, 42, ["gateway"], { service: "gateway" }]) {
      const response = await post(baseUrl, { service: attempt });
      expect(response.status).toBe(400);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(restart.calls).toEqual(before);
  });

  it("antwortet mit 404, wenn das Gateway keine Neustarts eingerichtet hat", async () => {
    const app = createServer({
      gateway: {} as unknown as GatewayDeps,
      identity,
      web: createWebChannel(),
    });
    const { server: bare, baseUrl: bareUrl } = await listen(app);
    try {
      const response = await post(bareUrl, { service: "gateway" });
      expect(response.status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => bare.close(() => resolve()));
    }
  });
});
