import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../runtime/db/pool.js";
import { appendEvent } from "../runtime/events/log.js";
import { createWebChannel } from "./channels/web.js";
import type { GatewayDeps } from "./core.js";
import type { GatewayIdentity } from "./identity.js";
import { createServer } from "./server.js";

/**
 * S22, die Gateway-Seite: `/runs` und `/runs/:id` sind dünne Hüllen um
 * `runtime/session/runs.ts` (dort steht die eigentliche Prüfung gegen die Datenbank) — hier
 * reicht der Nachweis, dass Route, Auth und JSON-Form zusammenpassen.
 */

const pool = createPool();
const createdSessions: string[] = [];
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
let sessionId = "";

async function createSession(): Promise<string> {
  const id = `sess_test_${randomUUID()}`;
  await pool.query(
    `INSERT INTO kuronami.sessions (session_id, thread_id, channel, model_profile, tool_catalog_version)
     VALUES ($1, $2, 'web', 'orchestrator-default', 'v1')`,
    [id, `thread_test_${randomUUID()}`],
  );
  createdSessions.push(id);
  return id;
}

beforeAll(async () => {
  sessionId = await createSession();
  await appendEvent(pool, sessionId, "session.created");
  await appendEvent(pool, sessionId, "session.completed");

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
  if (createdSessions.length > 0) {
    await pool.query("DELETE FROM kuronami.events WHERE session_id = ANY($1)", [createdSessions]);
    await pool.query("DELETE FROM kuronami.sessions WHERE session_id = ANY($1)", [createdSessions]);
  }
  await pool.end();
});

describe("GET /runs", () => {
  it("weist einen Aufruf ohne Bearer-Token ab", async () => {
    const response = await fetch(`${baseUrl}/runs`);
    expect(response.status).toBe(401);
  });

  it("zeigt den abgeschlossenen Run in der Liste, mit Kennzahlen", async () => {
    const response = await fetch(`${baseUrl}/runs`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { runs: Array<{ sessionId: string }>; metrics: object };
    expect(body.runs.some((run) => run.sessionId === sessionId)).toBe(true);
    expect(body.metrics).toBeTypeOf("object");
  });
});

describe("GET /runs/:id", () => {
  it("liefert den Detail-Verlauf des Runs", async () => {
    const response = await fetch(`${baseUrl}/runs/${sessionId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("completed");
  });

  it("gibt 404 für einen unbekannten Run", async () => {
    const response = await fetch(`${baseUrl}/runs/sess_gibt_es_nicht`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(404);
  });
});

describe("CORS", () => {
  // Gefunden beim echten Ausprobieren im Browser (S22): die Oberfläche läuft im Dev-Betrieb
  // auf einem eigenen Ursprung (`ui/dev.ts`, Port 3001) und ruft dieses Gateway auf einem
  // anderen — ohne diese Kopfzeilen schlägt `fetch()` mit "Failed to fetch" fehl, weil der
  // `Authorization`-Header einen Preflight auslöst, den der Server sonst nicht beantwortet.
  const LOCAL_ORIGIN = "http://localhost:3001";

  it("beantwortet einen Preflight für einen lokalen Ursprung mit den nötigen Kopfzeilen", async () => {
    const response = await fetch(`${baseUrl}/runs`, {
      method: "OPTIONS",
      headers: { origin: LOCAL_ORIGIN, "access-control-request-headers": "authorization" },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(LOCAL_ORIGIN);
    expect(response.headers.get("access-control-allow-headers")).toContain("authorization");
  });

  it("trägt dieselbe Kopfzeile auch auf der echten Antwort, nicht nur beim Preflight", async () => {
    const response = await fetch(`${baseUrl}/runs`, {
      headers: { authorization: `Bearer ${TOKEN}`, origin: LOCAL_ORIGIN },
    });
    expect(response.headers.get("access-control-allow-origin")).toBe(LOCAL_ORIGIN);
  });

  it("setzt keine Freigabe für einen fremden Ursprung", async () => {
    const response = await fetch(`${baseUrl}/runs`, {
      headers: { authorization: `Bearer ${TOKEN}`, origin: "https://beispiel.test" },
    });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});
