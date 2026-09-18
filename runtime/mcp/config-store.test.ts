import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "../db/pool.js";
import {
  McpServerConfigInputError,
  deleteMcpServer,
  listEnabledMcpServers,
  listMcpServers,
  upsertMcpServer,
} from "./config-store.js";

/** Gegen die echte Datenbank, wie `runtime/agents/store.test.ts`. */

const pool = createPool();
const serverIds: string[] = [];

function id(suffix: string): string {
  const value = `test_mcp_${suffix}`;
  serverIds.push(value);
  return value;
}

afterAll(async () => {
  if (serverIds.length > 0) {
    await pool.query("DELETE FROM kuronami.mcp_servers WHERE server_id = ANY($1)", [serverIds]);
  }
  await pool.end();
});

describe("MCP-Server-Konfiguration", () => {
  it("legt einen Server an und liest ihn zurück", async () => {
    const serverId = id("basic");
    const created = await upsertMcpServer(pool, {
      serverId,
      command: "npx",
      args: ["-y", "@example/mcp-server"],
      env: { API_KEY: "geheim" },
      risk: "read",
    });

    expect(created.serverId).toBe(serverId);
    expect(created.command).toBe("npx");
    expect(created.args).toEqual(["-y", "@example/mcp-server"]);
    expect(created.env).toEqual({ API_KEY: "geheim" });
    expect(created.risk).toBe("read");
    expect(created.repeatable).toBe(true);
    expect(created.enabled).toBe(true);

    const all = await listMcpServers(pool);
    expect(all.some((s) => s.serverId === serverId)).toBe(true);
  });

  it("ersetzt bei einem zweiten Aufruf mit derselben Kennung (Upsert)", async () => {
    const serverId = id("upsert");
    await upsertMcpServer(pool, { serverId, command: "old-cmd", risk: "read" });
    const updated = await upsertMcpServer(pool, {
      serverId,
      command: "new-cmd",
      risk: "hard_write",
      enabled: false,
    });

    expect(updated.command).toBe("new-cmd");
    expect(updated.risk).toBe("hard_write");
    expect(updated.enabled).toBe(false);

    const all = await listMcpServers(pool);
    const matches = all.filter((s) => s.serverId === serverId);
    expect(matches).toHaveLength(1);
  });

  it("behält env/args bei einer Bearbeitung, die sie weglässt", async () => {
    const serverId = id("keepenv");
    await upsertMcpServer(pool, {
      serverId,
      command: "cmd",
      args: ["--flag"],
      env: { TOKEN: "top-secret" },
      risk: "read",
    });

    const edited = await upsertMcpServer(pool, { serverId, command: "cmd-neu", risk: "read" });

    expect(edited.command).toBe("cmd-neu");
    expect(edited.args).toEqual(["--flag"]);
    expect(edited.env).toEqual({ TOKEN: "top-secret" });
  });

  it("listEnabledMcpServers lässt ausgeschaltete Server weg", async () => {
    const onId = id("on");
    const offId = id("off");
    await upsertMcpServer(pool, { serverId: onId, command: "cmd", risk: "read", enabled: true });
    await upsertMcpServer(pool, { serverId: offId, command: "cmd", risk: "read", enabled: false });

    const enabled = await listEnabledMcpServers(pool);
    const ids = enabled.map((s) => s.serverId);
    expect(ids).toContain(onId);
    expect(ids).not.toContain(offId);
  });

  it("lehnt eine ungültige server_id ab, ohne die Datenbank anzufassen", async () => {
    await expect(
      upsertMcpServer(pool, { serverId: "Nicht Gueltig!", command: "cmd", risk: "read" }),
    ).rejects.toThrow(McpServerConfigInputError);
  });

  it("lehnt eine ungültige Risikostufe ab", async () => {
    await expect(
      upsertMcpServer(pool, { serverId: id("badrisk"), command: "cmd", risk: "supersafe" }),
    ).rejects.toThrow();
  });

  it("lehnt ein leeres Kommando ab", async () => {
    await expect(
      upsertMcpServer(pool, { serverId: id("emptycmd"), command: "   ", risk: "read" }),
    ).rejects.toThrow(McpServerConfigInputError);
  });

  it("löscht einen Server und meldet, ob es ihn gab", async () => {
    const serverId = id("delete");
    await upsertMcpServer(pool, { serverId, command: "cmd", risk: "read" });

    expect(await deleteMcpServer(pool, serverId)).toBe(true);
    expect(await deleteMcpServer(pool, serverId)).toBe(false);

    const all = await listMcpServers(pool);
    expect(all.some((s) => s.serverId === serverId)).toBe(false);
  });
});
