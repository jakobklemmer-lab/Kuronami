import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeArtifact } from "../artifacts/store.js";
import { createPool } from "../db/pool.js";
import { appendEvent } from "../events/log.js";
import { getRunDetail, listRuns } from "./runs.js";

/**
 * S22: `listRuns`/`getRunDetail` gegen die echte Datenbank, mit einem echten Artefakt. Geprüft
 * wird das Fertig-Kriterium wörtlich — ein laufender und ein abgeschlossener Run, beide korrekt
 * in Liste und Detail sichtbar, samt Artefakt im Schritt-Verlauf.
 */

const pool = createPool();
const createdSessions: string[] = [];
let artifactRoot = "";

async function createSession(): Promise<string> {
  const sessionId = `sess_test_${randomUUID()}`;
  await pool.query(
    `INSERT INTO kuronami.sessions (session_id, thread_id, channel, model_profile, tool_catalog_version)
     VALUES ($1, $2, 'web', 'orchestrator-default', 'v1')`,
    [sessionId, `thread_test_${randomUUID()}`],
  );
  createdSessions.push(sessionId);
  return sessionId;
}

let runningId = "";
let completedId = "";
let artifactUri = "";

beforeAll(async () => {
  artifactRoot = await mkdtemp(path.join(tmpdir(), "kuronami-runs-test-"));

  runningId = await createSession();
  await appendEvent(pool, runningId, "session.created");
  await appendEvent(pool, runningId, "runtime.started", { runtime_id: "run_1" });
  await appendEvent(pool, runningId, "turn.started", { turn_id: "t1" });
  await appendEvent(pool, runningId, "step.started", {
    step_id: "step_a",
    idempotency_key: "key:a",
    kind: "tool_call",
    tool_name: "fs.write",
    repeatable: true,
    attempt: 1,
    timeout_ms: 60_000,
  });

  completedId = await createSession();
  await appendEvent(pool, completedId, "session.created");
  await appendEvent(pool, completedId, "runtime.started", { runtime_id: "run_2" });
  await appendEvent(pool, completedId, "turn.started", { turn_id: "t1" });
  await appendEvent(pool, completedId, "step.started", {
    step_id: "step_b",
    idempotency_key: "key:b",
    kind: "tool_call",
    tool_name: "fs.write",
    repeatable: true,
    attempt: 1,
    timeout_ms: 60_000,
  });
  const meta = await writeArtifact(pool, artifactRoot, {
    content: "Bericht aus dem Runs-Test.\n",
    mimeType: "text/plain",
    summary: "Testbericht",
    source: { tool: "fs.write", sessionId: completedId, stepId: "step_b" },
  });
  artifactUri = meta.uri;
  await appendEvent(pool, completedId, "step.completed", {
    step_id: "step_b",
    attempt: 1,
    result: { bytes: 27 },
    artifact_refs: [artifactUri],
  });
  await appendEvent(pool, completedId, "turn.completed", { turn_id: "t1" });
  await appendEvent(pool, completedId, "session.completed");
});

afterAll(async () => {
  if (createdSessions.length > 0) {
    await pool.query("DELETE FROM kuronami.artifacts WHERE source->>'session_id' = ANY($1)", [
      createdSessions,
    ]);
    await pool.query("DELETE FROM kuronami.events WHERE session_id = ANY($1)", [createdSessions]);
    await pool.query("DELETE FROM kuronami.sessions WHERE session_id = ANY($1)", [createdSessions]);
  }
  await rm(artifactRoot, { recursive: true, force: true }).catch(() => {});
  await pool.end();
});

describe("listRuns", () => {
  it("zeigt einen laufenden und einen abgeschlossenen Run mit Status und Kennzahlen", async () => {
    const { runs, metrics } = await listRuns(pool);
    const running = runs.find((run) => run.sessionId === runningId);
    const completed = runs.find((run) => run.sessionId === completedId);

    expect(running?.status).toBe("running");
    expect(running?.stepCount).toBe(1);
    expect(completed?.status).toBe("completed");
    expect(completed?.stepCount).toBe(1);
    expect(metrics.toolCalls).toBeGreaterThanOrEqual(0);
  });
});

describe("getRunDetail", () => {
  it("liefert den Schritt-Verlauf des abgeschlossenen Runs samt aufgelöstem Artefakt", async () => {
    const detail = await getRunDetail(pool, completedId);
    expect(detail?.status).toBe("completed");
    expect(detail?.steps).toHaveLength(1);
    const step = detail?.steps[0];
    expect(step?.status).toBe("completed");
    expect(step?.artifacts).toHaveLength(1);
    expect(step?.artifacts[0].uri).toBe(artifactUri);
    expect(step?.artifacts[0].summary).toBe("Testbericht");
  });

  it("liefert den laufenden Run mit seinem offenen Schritt", async () => {
    const detail = await getRunDetail(pool, runningId);
    expect(detail?.status).toBe("running");
    expect(detail?.steps[0].status).toBe("running");
    expect(detail?.steps[0].artifacts).toHaveLength(0);
  });

  it("gibt null für eine unbekannte Session zurück", async () => {
    expect(await getRunDetail(pool, "sess_gibt_es_nicht")).toBeNull();
  });
});
