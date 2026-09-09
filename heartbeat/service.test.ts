import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../runtime/db/pool.js";
import { type EventRecord, readEvents } from "../runtime/events/log.js";
import { type BuiltCatalog, buildCatalog } from "../runtime/loop/api.js";
import { createScriptedModel } from "../runtime/loop/scripted.js";
import type { DigestChannel } from "./delivery.js";
import { parseCron } from "./schedule.js";
import { type Heartbeat, createHeartbeat } from "./service.js";

/**
 * Der Zeitplan: `tick` mit einer gestellten Uhr. Geprüft wird, dass ein fälliger Digest genau
 * einmal je Zeitplan-Anlass läuft — auch wenn `tick` mehrfach kommt (Poll-Intervall) und über
 * einen Prozess-Neustart hinweg (die Idempotenz sitzt im Protokoll, nicht im Speicher).
 */

const pool = createPool();
const sessionIds: string[] = [];
let sourceRoot: string;
let artifactRoot: string;
let built: BuiltCatalog;

let clock = new Date(2026, 8, 9, 6, 0);

const channel: DigestChannel = { id: "test", async deliver() {} };

beforeAll(async () => {
  sourceRoot = await mkdtemp(path.join(tmpdir(), "kuronami-hb-svc-"));
  artifactRoot = path.join(sourceRoot, "artifacts");
  await mkdir(artifactRoot, { recursive: true });
  built = await buildCatalog({ pool, artifactRoot, sourceRoot, profile: "background" });
});

afterAll(async () => {
  if (sessionIds.length > 0) {
    await pool.query("DELETE FROM kuronami.artifacts WHERE (source ->> 'session_id') = ANY($1)", [
      sessionIds,
    ]);
    for (const table of ["approvals", "tasks", "steps", "events"]) {
      await pool.query(`DELETE FROM kuronami.${table} WHERE session_id = ANY($1)`, [sessionIds]);
    }
    await pool.query("DELETE FROM kuronami.sessions WHERE session_id = ANY($1)", [sessionIds]);
  }
  await pool.end();
  if (sourceRoot) await rm(sourceRoot, { recursive: true, force: true });
});

function digestModel() {
  return createScriptedModel({
    steps: 1,
    step: () => ({ toolName: "fs.list", input: { path: "." } }),
    finalText: "# Digest\n\nRuhig.",
  });
}

async function makeHeartbeat(diaryThread: string): Promise<Heartbeat> {
  const hb = await createHeartbeat({
    pool,
    artifactRoot,
    catalog: built.catalog,
    policy: built.policy,
    model: digestModel(),
    channel,
    conventions: "# Test",
    maxRunsPerDay: 8,
    maxSteps: 6,
    digestCron: parseCron("0 7 * * *"),
    pollMs: 10_000_000,
    diaryThread,
    now: () => clock,
  });
  sessionIds.push(hb.diarySessionId);
  return hb;
}

function runsIn(events: EventRecord[]): number {
  for (const event of events) {
    const runSession = (event.payload as { run_session?: string }).run_session;
    if (runSession && !sessionIds.includes(runSession)) sessionIds.push(runSession);
  }
  return events.filter((event) => event.type === "heartbeat.ran").length;
}

describe("Heartbeat · Zeitplan", () => {
  it("feuert den Digest genau einmal je Tag, egal wie oft getickt wird", async () => {
    const thread = `thread_heartbeat_test_${randomUUID()}`;
    const hb = await makeHeartbeat(thread);

    clock = new Date(2026, 8, 9, 6, 30);
    await hb.tick();
    expect(runsIn(await readEvents(pool, hb.diarySessionId))).toBe(0);

    clock = new Date(2026, 8, 9, 7, 4);
    await hb.tick();
    await hb.tick();
    await hb.tick();
    expect(runsIn(await readEvents(pool, hb.diarySessionId))).toBe(1);

    // Ein Neustart: neuer Dienst, dieselbe Diarium-Session. Der schon gelaufene Anlass wird
    // aus dem Protokoll erkannt, nicht wiederholt.
    const restarted = await makeHeartbeat(thread);
    clock = new Date(2026, 8, 9, 9, 0);
    await restarted.tick();
    expect(runsIn(await readEvents(pool, restarted.diarySessionId))).toBe(1);

    // Nächster Tag: neuer Anlass, neuer Lauf.
    clock = new Date(2026, 8, 10, 7, 2);
    await restarted.tick();
    expect(runsIn(await readEvents(pool, restarted.diarySessionId))).toBe(2);
  });

  it("holt einen weit verpassten Anlass nicht mehr nach (MAX_LATENESS_MS)", async () => {
    const hb = await makeHeartbeat(`thread_heartbeat_test_${randomUUID()}`);
    // 14:00 ist mehr als sechs Stunden nach 07:00 — der Dienst wurde spät gestartet.
    clock = new Date(2026, 8, 9, 14, 0);
    await hb.tick();
    expect(runsIn(await readEvents(pool, hb.diarySessionId))).toBe(0);
  });

  it("nextDigest zeigt auf den nächsten 07:00", async () => {
    const hb = await makeHeartbeat(`thread_heartbeat_test_${randomUUID()}`);
    expect(hb.nextDigest(new Date(2026, 8, 9, 8, 0))).toEqual(new Date(2026, 8, 10, 7, 0));
  });
});
