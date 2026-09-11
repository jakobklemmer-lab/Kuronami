import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readArtifact } from "../runtime/artifacts/store.js";
import { createPool } from "../runtime/db/pool.js";
import { appendEvent, readEvents } from "../runtime/events/log.js";
import type { ModelClient, ModelContentBlock, ModelMessage } from "../runtime/model/types.js";
import { toolResultBlock } from "../runtime/model/types.js";
import { createOrResumeSession } from "../runtime/session/manager.js";
import { type SectionConfig, maybeStartFreshSection, resolveSectionConfig } from "./section.js";

/**
 * `context/section.ts` isoliert (Kontextstufe 4, S18b) — dieselbe Bauart wie
 * `context/compaction.test.ts` für Stufe 2 und 3: kein Loop, kein Router, nur das Modul selbst
 * gegen die echte Datenbank. Geprüft werden die drei Auslöser einzeln und dass keiner von ihnen
 * ohne triftigen Grund feuert.
 */

const pool = createPool();
const threadIds: string[] = [];
let artifactRoot: string;

beforeAll(async () => {
  artifactRoot = await mkdtemp(path.join(tmpdir(), "kuronami-section-"));
});

afterAll(async () => {
  if (threadIds.length > 0) {
    const sessions = "SELECT session_id FROM kuronami.sessions WHERE thread_id = ANY($1)";
    await pool.query(
      `DELETE FROM kuronami.artifacts WHERE (source ->> 'session_id') IN (${sessions})`,
      [threadIds],
    );
    await pool.query(`DELETE FROM kuronami.events WHERE session_id IN (${sessions})`, [threadIds]);
    await pool.query("DELETE FROM kuronami.sessions WHERE thread_id = ANY($1)", [threadIds]);
  }
  await pool.end();
  if (artifactRoot) await rm(artifactRoot, { recursive: true, force: true });
});

async function newSession(): Promise<string> {
  const threadId = `thread_test_${randomUUID()}`;
  threadIds.push(threadId);
  const { session } = await createOrResumeSession(pool, { threadId, channel: "web" });
  return session.sessionId;
}

function toolUse(id: string): ModelContentBlock {
  return { type: "tool_use", id, name: "fs__read", input: { path: "x" } };
}

function round(callId: string, resultContent: string): ModelMessage[] {
  return [
    { role: "assistant", content: [toolUse(callId)] },
    { role: "user", content: [toolResultBlock(callId, resultContent, false)] },
  ];
}

const OPENING: ModelMessage = { role: "user", content: [{ type: "text", text: "Los geht's." }] };

function fixedModel(text: string, model = "modell-test-abschnitt"): ModelClient {
  return {
    model,
    async complete() {
      return {
        model,
        stopReason: "end_turn",
        text,
        toolCalls: [],
        usage: { inputTokens: 30, outputTokens: 15, cacheReadTokens: 0, cacheCreationTokens: 0 },
        content: [{ type: "text", text }],
      };
    },
  };
}

const HANDOVER_TEXT = "STAND: Test.\nOFFEN: keine.\nREFS: keine.";

function sectionEvents(events: Awaited<ReturnType<typeof readEvents>>) {
  return events.filter((event) => event.type === "context.section_started");
}

function config(overrides: Partial<SectionConfig> = {}): SectionConfig {
  return resolveSectionConfig({ idleMs: 60_000, maxConsecutiveStage3: 3, ...overrides });
}

describe("context/section · Ruhepause", () => {
  it("beginnt einen frischen Abschnitt, wenn seit dem letzten Ereignis genug Zeit vergangen ist", async () => {
    const sessionId = await newSession();
    const messages: ModelMessage[] = [OPENING, ...round("call_1", "erste Runde")];
    const messageSeqs = messages.map((_, index) => index + 1);
    const events = await readEvents(pool, sessionId);

    const farInFuture = new Date(Date.now() + 60_000 + 5_000);
    const result = await maybeStartFreshSection(
      { pool, artifactRoot, sessionId, model: fixedModel(HANDOVER_TEXT) },
      {
        turnId: "turn_1",
        now: farInFuture,
        messages,
        messageSeqs,
        events,
        config: config(),
      },
    );

    expect(result).toEqual({ started: true, reason: "idle" });
    const after = await readEvents(pool, sessionId);
    const started = sectionEvents(after);
    expect(started).toHaveLength(1);
    expect(started[0]?.payload.reason).toBe("idle");
    expect(started[0]?.payload.handover).toBe(HANDOVER_TEXT);
    expect(started[0]?.payload.through_seq).toBe(messageSeqs.at(-1));

    const rawUri = started[0]?.payload.raw_artifact_uri as string;
    const raw = (await readArtifact(pool, artifactRoot, rawUri)).bytes.toString("utf8");
    expect(raw).toContain("erste Runde");

    // Der Übergabe-Aufruf steht im Protokoll, damit er in der Kostenrechnung sichtbar ist —
    // dieselbe Zusage wie bei Stufe 3 (S18a).
    const responded = after.filter(
      (event) => event.type === "model.responded" && event.payload.purpose === "section_handover",
    );
    expect(responded).toHaveLength(1);
  });

  it("tut nichts, wenn die Ruhepause noch nicht erreicht ist und auch sonst nichts triggert", async () => {
    const sessionId = await newSession();
    const messages: ModelMessage[] = [OPENING, ...round("call_1", "erste Runde")];
    const messageSeqs = messages.map((_, index) => index + 1);
    const events = await readEvents(pool, sessionId);

    const result = await maybeStartFreshSection(
      { pool, artifactRoot, sessionId, model: fixedModel(HANDOVER_TEXT) },
      {
        turnId: "turn_1",
        now: new Date(),
        messages,
        messageSeqs,
        events,
        config: config(),
      },
    );

    expect(result).toEqual({ started: false });
    expect(sectionEvents(await readEvents(pool, sessionId))).toHaveLength(0);
  });
});

describe("context/section · Aufgabenabschluss", () => {
  it("beginnt einen frischen Abschnitt, wenn eine Aufgabe seit dem letzten Abschnitt fertig wurde", async () => {
    const sessionId = await newSession();
    const messages: ModelMessage[] = [OPENING, ...round("call_1", "erste Runde")];
    const messageSeqs = messages.map((_, index) => index + 1);

    await appendEvent(pool, sessionId, "task.created", {
      task_id: "aufgabe_1",
      session_id: sessionId,
      title: "Testaufgabe",
      status: "done",
      owner: "main-agent",
      dependencies: [],
      blockers: [],
      artifact_refs: [],
      position: 0,
    });
    const events = await readEvents(pool, sessionId);

    const result = await maybeStartFreshSection(
      { pool, artifactRoot, sessionId, model: fixedModel(HANDOVER_TEXT) },
      {
        turnId: "turn_1",
        // Kein Ruhepause-Trigger: `now` liegt direkt bei der Ereigniszeit.
        now: new Date(),
        messages,
        messageSeqs,
        events,
        config: config({ idleMs: 60 * 60 * 1000 }),
      },
    );

    expect(result.started).toBe(true);
    expect(result.reason).toBe("task_completed");
    const started = sectionEvents(await readEvents(pool, sessionId));
    expect(started[0]?.payload.completed_task_id).toBe("aufgabe_1");
  });

  it("ignoriert eine fallengelassene Aufgabe (dropped) und eine, die nicht auf done steht", async () => {
    const sessionId = await newSession();
    const messages: ModelMessage[] = [OPENING, ...round("call_1", "erste Runde")];
    const messageSeqs = messages.map((_, index) => index + 1);

    await appendEvent(pool, sessionId, "task.created", {
      task_id: "aufgabe_1",
      session_id: sessionId,
      title: "Testaufgabe",
      status: "in_progress",
      owner: "main-agent",
      dependencies: [],
      blockers: [],
      artifact_refs: [],
      position: 0,
    });
    await appendEvent(pool, sessionId, "task.updated", {
      task_id: "aufgabe_1",
      session_id: sessionId,
      status: "done",
      dropped: true,
    });
    const events = await readEvents(pool, sessionId);

    const result = await maybeStartFreshSection(
      { pool, artifactRoot, sessionId, model: fixedModel(HANDOVER_TEXT) },
      {
        turnId: "turn_1",
        now: new Date(),
        messages,
        messageSeqs,
        events,
        config: config({ idleMs: 60 * 60 * 1000 }),
      },
    );

    expect(result).toEqual({ started: false });
  });
});

describe("context/section · Stufe-3-Fallback", () => {
  it("beginnt einen frischen Abschnitt nach genug aufeinanderfolgenden Stufe-3-Kompaktierungen ohne die beiden anderen Auslöser", async () => {
    const sessionId = await newSession();
    const messages: ModelMessage[] = [OPENING, ...round("call_1", "erste Runde")];
    const messageSeqs = messages.map((_, index) => index + 1);

    for (let i = 0; i < 3; i += 1) {
      await appendEvent(pool, sessionId, "context.compacted", {
        turn_id: `turn_${i}`,
        stage: 3,
        reason: "context_window_utilization",
        utilization_before: 0.9,
        through_seq: i + 1,
        covered_messages: 2,
        raw_artifact_uri: `artifact://test/${i}`,
        summary: `Zusammenfassung ${i}`,
        model: "modell-test",
      });
    }
    const events = await readEvents(pool, sessionId);

    const result = await maybeStartFreshSection(
      { pool, artifactRoot, sessionId, model: fixedModel(HANDOVER_TEXT) },
      {
        turnId: "turn_neu",
        now: new Date(),
        messages,
        messageSeqs,
        events,
        config: config({ idleMs: 60 * 60 * 1000, maxConsecutiveStage3: 3 }),
      },
    );

    expect(result.started).toBe(true);
    expect(result.reason).toBe("stage3_fallback");
    const started = sectionEvents(await readEvents(pool, sessionId));
    expect(started[0]?.payload.stage3_streak).toBe(3);
  });

  it("feuert nicht unterhalb der konfigurierten Kette", async () => {
    const sessionId = await newSession();
    const messages: ModelMessage[] = [OPENING, ...round("call_1", "erste Runde")];
    const messageSeqs = messages.map((_, index) => index + 1);

    await appendEvent(pool, sessionId, "context.compacted", {
      turn_id: "turn_0",
      stage: 3,
      reason: "context_window_utilization",
      utilization_before: 0.9,
      through_seq: 1,
      covered_messages: 2,
      raw_artifact_uri: "artifact://test/0",
      summary: "Zusammenfassung",
      model: "modell-test",
    });
    const events = await readEvents(pool, sessionId);

    const result = await maybeStartFreshSection(
      { pool, artifactRoot, sessionId, model: fixedModel(HANDOVER_TEXT) },
      {
        turnId: "turn_neu",
        now: new Date(),
        messages,
        messageSeqs,
        events,
        config: config({ idleMs: 60 * 60 * 1000, maxConsecutiveStage3: 3 }),
      },
    );

    expect(result).toEqual({ started: false });
  });
});
