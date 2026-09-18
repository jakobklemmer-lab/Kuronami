import { describe, expect, it } from "vitest";
import { ApiError, createApiClient } from "./client.js";

function fakeFetch(handler: (url: string, init: RequestInit) => Response): typeof fetch {
  return ((url: string, init: RequestInit) => Promise.resolve(handler(url, init))) as typeof fetch;
}

describe("createApiClient", () => {
  it("weigert einen Aufruf ohne Token, ohne das Netz zu bemühen", async () => {
    let called = false;
    const client = createApiClient({
      baseUrl: "http://x",
      token: () => null,
      fetchImpl: fakeFetch(() => {
        called = true;
        return new Response("{}", { status: 200 });
      }),
    });
    await expect(client.get("/runs")).rejects.toThrow(ApiError);
    expect(called).toBe(false);
  });

  it("schickt den Token als Bearer-Header und liefert den JSON-Körper", async () => {
    let seenAuth: string | null = null;
    const client = createApiClient({
      baseUrl: "http://x",
      token: () => "abc",
      fetchImpl: fakeFetch((_url, init) => {
        seenAuth = (init.headers as Record<string, string>).authorization;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    });
    const body = await client.get<{ ok: boolean }>("/runs");
    expect(seenAuth).toBe("Bearer abc");
    expect(body.ok).toBe(true);
  });

  it("wirft mit der Fehlermeldung des Servers, nicht nur dem Statuscode", async () => {
    const client = createApiClient({
      baseUrl: "http://x",
      token: () => "abc",
      fetchImpl: fakeFetch(
        () => new Response(JSON.stringify({ error: "Token stimmt nicht." }), { status: 401 }),
      ),
    });
    await expect(client.get("/runs")).rejects.toThrow("Token stimmt nicht.");
  });

  it("schickt DELETE mit dem Token als Bearer-Header", async () => {
    let seenMethod: string | undefined;
    const client = createApiClient({
      baseUrl: "http://x",
      token: () => "abc",
      fetchImpl: fakeFetch((_url, init) => {
        seenMethod = init.method;
        return new Response(JSON.stringify({ deleted: true }), { status: 200 });
      }),
    });
    const body = await client.delete<{ deleted: boolean }>("/settings/mcp-servers/x");
    expect(seenMethod).toBe("DELETE");
    expect(body.deleted).toBe(true);
  });

  it("markiert einen Netzwerkfehler als solchen", async () => {
    const client = createApiClient({
      baseUrl: "http://x",
      token: () => "abc",
      fetchImpl: (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch,
    });
    await expect(client.get("/runs")).rejects.toMatchObject({ status: "network" });
  });
});
