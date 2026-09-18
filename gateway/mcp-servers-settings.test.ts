import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../runtime/db/pool.js";
import { deleteMcpServer } from "../runtime/mcp/config-store.js";
import { createWebChannel } from "./channels/web.js";
import type { GatewayDeps } from "./core.js";
import type { GatewayIdentity } from "./identity.js";
import { createServer } from "./server.js";

/**
 * `GET`/`POST`/`DELETE /settings/mcp-servers` (Nachtrag 2026-09-16) — gegen die echte
 * Datenbank, wie `gateway/runs.test.ts`: die Route ist eine dünne Hülle um
 * `runtime/mcp/config-store.ts` (dort steht die eigentliche Prüfung). Hier zählt Route, Auth,
 * JSON-Form — und dass `env`-Werte nie zurückgehen.
 */

const pool = createPool();
const createdIds: string[] = [];
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

let server: Server;
let baseUrl = "";

function trackedId(suffix: string): string {
  const id = `test_gw_mcp_${suffix}`;
  createdIds.push(id);
  return id;
}

beforeAll(async () => {
  const gateway = { pool } as unknown as GatewayDeps;
  const app = createServer({ gateway, identity, web: createWebChannel() });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (createdIds.length > 0) {
    await pool.query("DELETE FROM kuronami.mcp_servers WHERE server_id = ANY($1)", [createdIds]);
  }
  await pool.end();
});

describe("GET/POST/DELETE /settings/mcp-servers", () => {
  it("weist GET ohne Bearer-Token ab", async () => {
    const response = await fetch(`${baseUrl}/settings/mcp-servers`);
    expect(response.status).toBe(401);
  });

  it("weist POST ohne Bearer-Token ab, ohne etwas zu schreiben", async () => {
    const serverId = trackedId("noauth");
    const response = await fetch(`${baseUrl}/settings/mcp-servers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serverId, command: "npx", risk: "read" }),
    });
    expect(response.status).toBe(401);

    const list = await fetch(`${baseUrl}/settings/mcp-servers`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = (await list.json()) as { servers: Array<{ serverId: string }> };
    expect(body.servers.some((s) => s.serverId === serverId)).toBe(false);
  });

  it("legt einen Server an, gibt env nie im Klartext zurück, und listet ihn", async () => {
    const serverId = trackedId("basic");
    const created = await fetch(`${baseUrl}/settings/mcp-servers`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        serverId,
        command: "npx",
        args: ["-y", "@example/server"],
        env: { API_KEY: "geheim-123" },
        risk: "read",
      }),
    });
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as {
      server: { envKeys: string[]; args: string[] };
    };
    expect(JSON.stringify(createdBody)).not.toContain("geheim-123");
    expect(createdBody.server.envKeys).toEqual(["API_KEY"]);
    expect(createdBody.server.args).toEqual(["-y", "@example/server"]);

    const list = await fetch(`${baseUrl}/settings/mcp-servers`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const listBody = (await list.json()) as { servers: Array<{ serverId: string }> };
    expect(listBody.servers.some((s) => s.serverId === serverId)).toBe(true);
    expect(JSON.stringify(listBody)).not.toContain("geheim-123");
  });

  it("weist eine ungültige Risikostufe mit 400 ab", async () => {
    const serverId = trackedId("badrisk");
    const response = await fetch(`${baseUrl}/settings/mcp-servers`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ serverId, command: "npx", risk: "supersafe" }),
    });
    expect(response.status).toBe(400);
  });

  it("löscht einen Server", async () => {
    const serverId = trackedId("delete");
    await fetch(`${baseUrl}/settings/mcp-servers`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ serverId, command: "npx", risk: "read" }),
    });

    const del = await fetch(`${baseUrl}/settings/mcp-servers/${serverId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(del.status).toBe(200);

    const again = await fetch(`${baseUrl}/settings/mcp-servers/${serverId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(again.status).toBe(404);
  });

  it("gibt 404 für DELETE einer unbekannten Kennung", async () => {
    await deleteMcpServer(pool, "does_not_exist_at_all");
    const response = await fetch(`${baseUrl}/settings/mcp-servers/does_not_exist_at_all`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(404);
  });
});
