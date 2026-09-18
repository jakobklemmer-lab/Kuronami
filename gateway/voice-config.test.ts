import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWebChannel } from "./channels/web.js";
import type { GatewayDeps } from "./core.js";
import type { GatewayIdentity } from "./identity.js";
import { createServer } from "./server.js";

/**
 * `GET /channels/web/voice` (Nachtrag 2026-09-16) — die Selbstkonfiguration der Sprachschicht.
 *
 * Geprüft wird das, woran sie scheitern könnte: dass sie hinter demselben Ausweis liegt wie
 * jeder andere Web-Lesepfad, und dass "nicht eingerichtet" als eigener Zustand ankommt statt
 * als leerer Token, den der Aufrufer für einen gültigen halten könnte.
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
  voiceSessionToken: "sitzung-geheim",
};

async function listen(
  app: ReturnType<typeof createServer>,
): Promise<{ server: Server; baseUrl: string }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe("GET /channels/web/voice", () => {
  let server: Server;
  let baseUrl = "";

  beforeAll(async () => {
    const gateway = {} as unknown as GatewayDeps;
    const app = createServer({ gateway, identity, web: createWebChannel() });
    ({ server, baseUrl } = await listen(app));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("weist einen Aufruf ohne Bearer-Token ab", async () => {
    const response = await fetch(`${baseUrl}/channels/web/voice`);
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("sitzung-geheim");
  });

  it("weist einen falschen Bearer-Token ab", async () => {
    const response = await fetch(`${baseUrl}/channels/web/voice`, {
      headers: { authorization: "Bearer falsch" },
    });
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("sitzung-geheim");
  });

  it("liefert das Sitzungsgeheimnis an eine ausgewiesene Oberfläche", async () => {
    const response = await fetch(`${baseUrl}/channels/web/voice`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ configured: true, sessionToken: "sitzung-geheim" });
  });

  it("meldet eine nicht eingerichtete Sprachschicht als eigenen Zustand", async () => {
    const app = createServer({
      gateway: {} as unknown as GatewayDeps,
      identity: { ...identity, voiceSessionToken: "" },
      web: createWebChannel(),
    });
    const { server: bare, baseUrl: bareUrl } = await listen(app);
    try {
      const response = await fetch(`${bareUrl}/channels/web/voice`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ configured: false, sessionToken: null });
    } finally {
      await new Promise<void>((resolve) => bare.close(() => resolve()));
    }
  });
});
