import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HeartbeatRunResult, Notification } from "./digest.js";
import { createHeartbeatServer } from "./server.js";
import type { Heartbeat } from "./service.js";

/**
 * Der HTTP-Rand ohne Datenbank: ein gestelltes `Heartbeat` zeichnet auf, was `POST /notify`
 * durchreicht. Geprüft wird die Authentifizierung und die Eingabeprüfung — die eigentliche
 * Lauflogik hat `digest.test.ts`.
 */

const calls: Notification[] = [];
const heartbeat: Heartbeat = {
  diarySessionId: "sess_diary_test",
  async tick() {},
  async notify(notification: Notification): Promise<HeartbeatRunResult> {
    calls.push(notification);
    return { status: "delivered", reason: "ok" };
  },
  start() {},
  stop() {},
  nextDigest() {
    return new Date(2026, 8, 10, 7, 0);
  },
};

let baseUrl: string;
let close: () => void;

beforeAll(async () => {
  const app = createHeartbeatServer({
    heartbeat,
    notifySecret: "geheim",
    nextDigest: () => heartbeat.nextDigest(),
  });
  await new Promise<void>((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${port}`;
      close = () => server.close();
      resolve();
    });
  });
});

afterAll(() => close?.());

describe("Heartbeat · POST /notify", () => {
  it("nimmt eine gültige Meldung mit richtigem Token an", async () => {
    const response = await fetch(`${baseUrl}/notify`, {
      method: "POST",
      headers: { authorization: "Bearer geheim", "content-type": "application/json" },
      body: JSON.stringify({ kind: "server", detail: "disk 95%" }),
    });
    expect(response.status).toBe(200);
    expect(calls.at(-1)).toEqual({ kind: "server", detail: "disk 95%" });
  });

  it("weist einen falschen Token mit 401 ab, ohne Hinweis", async () => {
    const before = calls.length;
    const response = await fetch(`${baseUrl}/notify`, {
      method: "POST",
      headers: { authorization: "Bearer falsch", "content-type": "application/json" },
      body: JSON.stringify({ kind: "mail", detail: "" }),
    });
    expect(response.status).toBe(401);
    expect(calls.length).toBe(before);
  });

  it("weist eine unbekannte Auslöserart mit 400 ab", async () => {
    const response = await fetch(`${baseUrl}/notify`, {
      method: "POST",
      headers: { authorization: "Bearer geheim", "content-type": "application/json" },
      body: JSON.stringify({ kind: "bogus" }),
    });
    expect(response.status).toBe(400);
  });

  it("/health nennt den nächsten Digest", async () => {
    const response = await fetch(`${baseUrl}/health`);
    const body = (await response.json()) as { ok: boolean; notify: boolean; nextDigest: string };
    expect(body.ok).toBe(true);
    expect(body.notify).toBe(true);
    expect(body.nextDigest).toBe(new Date(2026, 8, 10, 7, 0).toISOString());
  });
});
