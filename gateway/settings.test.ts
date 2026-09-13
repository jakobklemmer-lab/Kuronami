import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWebChannel } from "./channels/web.js";
import type { GatewayDeps } from "./core.js";
import type { GatewayIdentity } from "./identity.js";
import { type SettingsSecretsDeps, createServer } from "./server.js";

/**
 * `GET`/`POST /settings/api-keys` (S32-Nachtrag) — ohne Datenbank und ohne Platte: `secrets`
 * bekommt einen Speicher im Arbeitsspeicher gestellt, `runtime/secrets/env-file.test.ts` prüft
 * das Dateiformat selbst. Hier zählt nur, dass Route, Auth und JSON-Form zusammenpassen, und
 * dass niemals ein Klartextwert den Weg zurück zum Aufrufer findet.
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
};

function fakeSecrets(initial: string): { deps: SettingsSecretsDeps; contents(): string } {
  let contents = initial;
  return {
    deps: {
      read: async () => contents,
      write: async (next) => {
        contents = next;
      },
    },
    contents: () => contents,
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

describe("GET/POST /settings/api-keys", () => {
  let server: Server;
  let baseUrl = "";
  let secrets: ReturnType<typeof fakeSecrets>;

  beforeAll(async () => {
    secrets = fakeSecrets(
      "ANTHROPIC_API_KEY=sk-ant-workspace-1234\n# Kommentar\nVOICE_MODE=live\n",
    );
    const gateway = {} as unknown as GatewayDeps;
    const app = createServer({ gateway, identity, web: createWebChannel(), secrets: secrets.deps });
    ({ server, baseUrl } = await listen(app));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("weist GET ohne Bearer-Token ab", async () => {
    const response = await fetch(`${baseUrl}/settings/api-keys`);
    expect(response.status).toBe(401);
  });

  it("zeigt Status und Vorschau, nie den Klartext", async () => {
    const response = await fetch(`${baseUrl}/settings/api-keys`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      keys: Record<string, { set: boolean; preview: string | null }>;
    };
    expect(body.keys.ANTHROPIC_API_KEY).toEqual({ set: true, preview: "…1234" });
    expect(body.keys.DEEPGRAM_API_KEY).toEqual({ set: false, preview: null });
    expect(JSON.stringify(body)).not.toContain("sk-ant-workspace");
  });

  it("weist POST ohne Bearer-Token ab, ohne etwas zu schreiben", async () => {
    const before = secrets.contents();
    const response = await fetch(`${baseUrl}/settings/api-keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keys: { DEEPGRAM_API_KEY: "sollte-nicht-landen" } }),
    });
    expect(response.status).toBe(401);
    expect(secrets.contents()).toBe(before);
  });

  it("schreibt neue Werte und lässt Kommentare/andere Zeilen unberührt", async () => {
    const response = await fetch(`${baseUrl}/settings/api-keys`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ keys: { DEEPGRAM_API_KEY: "dg-neu-5678" } }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { keys: Record<string, { set: boolean }> };
    expect(body.keys.DEEPGRAM_API_KEY.set).toBe(true);
    expect(secrets.contents()).toContain("# Kommentar");
    expect(secrets.contents()).toContain("DEEPGRAM_API_KEY=dg-neu-5678");
    expect(secrets.contents()).toContain("ANTHROPIC_API_KEY=sk-ant-workspace-1234");
  });

  it("weist einen nicht erlaubten Schlüssel mit 400 ab, ohne zu schreiben", async () => {
    const before = secrets.contents();
    const response = await fetch(`${baseUrl}/settings/api-keys`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ keys: { PATH: "/böse" } }),
    });
    expect(response.status).toBe(400);
    expect(secrets.contents()).toBe(before);
  });
});

describe("ohne eingerichtete Schlüsselverwaltung", () => {
  it("gibt 404 für GET und POST", async () => {
    const gateway = {} as unknown as GatewayDeps;
    const app = createServer({ gateway, identity, web: createWebChannel() });
    const { server, baseUrl } = await listen(app);
    try {
      const get = await fetch(`${baseUrl}/settings/api-keys`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(get.status).toBe(404);

      const post = await fetch(`${baseUrl}/settings/api-keys`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ keys: { DEEPGRAM_API_KEY: "x" } }),
      });
      expect(post.status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
