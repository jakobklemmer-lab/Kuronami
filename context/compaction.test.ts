import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readArtifact } from "../runtime/artifacts/store.js";
import { createPool } from "../runtime/db/pool.js";
import { type EventRecord, appendEvent, readEvents } from "../runtime/events/log.js";
import type { ModelClient, ModelContentBlock, ModelMessage } from "../runtime/model/types.js";
import { toolResultBlock } from "../runtime/model/types.js";
import { createOrResumeSession } from "../runtime/session/manager.js";
import {
  type CompactionConfig,
  type CompactionDeps,
  compactHistory,
  resolveCompactionConfig,
} from "./compaction.js";

/**
 * `context/compaction.ts` isoliert, ohne den Loop (S12) und ohne ein Drehbuch-Modell mit
 * Zählwerk (S07/S12) — nur die Kompaktierung selbst: schreibt sie Referenzen und Rohverlauf
 * als Artefakt, hält sie den Modellaufruf für die Kostenrechnung fest, und wiederholt sie
 * ihre eigene Arbeit nicht bei einem zweiten Aufruf. Der Router und der Loop sind hier bewusst
 * nicht verdrahtet — ein Test, der eine echte `fs.read`-Historie bräuchte, prüfte das
 * Zusammenspiel, nicht das Modul.
 */

const pool = createPool();
const threadIds: string[] = [];
let artifactRoot: string;

beforeAll(async () => {
  artifactRoot = await mkdtemp(path.join(tmpdir(), "kuronami-compaction-"));
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

/** Eine Runde: Aufruf und Ergebnis, wie `deriveLoopState` sie faltet. */
function round(callId: string, resultContent: string): ModelMessage[] {
  return [
    { role: "assistant", content: [toolUse(callId)] },
    { role: "user", content: [toolResultBlock(callId, resultContent, false)] },
  ];
}

const OPENING: ModelMessage = { role: "user", content: [{ type: "text", text: "Los geht's." }] };

/** Zählt Aufrufe und antwortet immer mit demselben Text — kein Drehbuch, nur ein Zähler. */
function countingModel(text: string): ModelClient & { calls: number } {
  const client = {
    model: "modell-test-kompaktierung",
    calls: 0,
    async complete() {
      client.calls += 1;
      return {
        model: client.model,
        stopReason: "end_turn",
        text,
        toolCalls: [],
        usage: { inputTokens: 40, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 },
        content: [{ type: "text", text }],
      };
    },
  };
  return client;
}

function stage2Events(events: readonly EventRecord[]): EventRecord[] {
  return events.filter((event) => event.type === "context.compacted" && event.payload.stage === 2);
}
function stage3Events(events: readonly EventRecord[]): EventRecord[] {
  return events.filter((event) => event.type === "context.compacted" && event.payload.stage === 3);
}

function deps(sessionId: string, model: ModelClient): CompactionDeps {
  return { pool, artifactRoot, sessionId, model };
}

function config(overrides: Partial<CompactionConfig>): CompactionConfig {
  return resolveCompactionConfig(overrides);
}

describe("context/compaction · Stufe 2", () => {
  it("schreibt große Tool-Ergebnisse zu Referenzen um und ist danach idempotent", async () => {
    const sessionId = await newSession();
    const messages: ModelMessage[] = [
      OPENING,
      ...round("call_1", "x".repeat(300)),
      ...round("call_2", "y".repeat(300)),
      ...round("call_3", "z".repeat(300)),
    ];
    const messageSeqs = messages.map((_, index) => index + 1);
    const cfg = config({
      stage2UtilizationThreshold: 0,
      protectedTailMessages: 0,
      stage2MinBlockBytes: 50,
      stage3MinMessages: 1_000,
      maxRoundsPerCall: 3,
    });

    const firstEvents = await readEvents(pool, sessionId);
    const first = await compactHistory(deps(sessionId, countingModel("ungenutzt")), {
      turnId: "turn_1",
      messages,
      messageSeqs,
      events: firstEvents,
      fixedOverheadTokens: 0,
      config: cfg,
    });

    expect(first.compacted).toBe(true);
    const rewrittenBlocks = first.messages.flatMap((message) =>
      message.content.filter((block) => block.type === "tool_result"),
    );
    expect(rewrittenBlocks).toHaveLength(3);
    for (const block of rewrittenBlocks) {
      const parsed = JSON.parse(String(block.content));
      expect(parsed.compacted).toBe(true);
      expect(String(parsed.uri)).toContain("artifact://");
    }
    // Der Rohinhalt bleibt abrufbar (Auftrag S18a) — der erste Block deckt für alle drei.
    const uri = JSON.parse(String(rewrittenBlocks[0]?.content)).uri as string;
    expect((await readArtifact(pool, artifactRoot, uri)).bytes.toString("utf8")).toBe(
      "x".repeat(300),
    );

    const afterFirst = await readEvents(pool, sessionId);
    expect(stage2Events(afterFirst)).toHaveLength(1);
    expect((stage2Events(afterFirst)[0]?.payload.rewritten as unknown[]).length).toBe(3);

    // Zweiter Aufruf, dieselbe Rohhistorie: keine neue Auslagerung, kein zweites Ereignis.
    const second = await compactHistory(deps(sessionId, countingModel("ungenutzt")), {
      turnId: "turn_1",
      messages,
      messageSeqs,
      events: afterFirst,
      fixedOverheadTokens: 0,
      config: cfg,
    });
    expect(second.messages).toEqual(first.messages);
    const afterSecond = await readEvents(pool, sessionId);
    expect(stage2Events(afterSecond)).toHaveLength(1);
  });
});

describe("context/compaction · Stufe 3", () => {
  it("fasst einen alten Ausschnitt zusammen, protokolliert den Aufruf, und ist danach idempotent", async () => {
    const sessionId = await newSession();
    const messages: ModelMessage[] = [
      OPENING,
      ...round("call_1", "erste Runde"),
      ...round("call_2", "zweite Runde"),
      ...round("call_3", "geschützte Runde"),
    ];
    const messageSeqs = messages.map((_, index) => index + 1);
    // protectedTailMessages: 2 schützt genau die letzte Runde (die letzten zwei Nachrichten);
    // stage2MinBlockBytes hoch genug, dass Stufe 2 hier nichts findet — nur Stufe 3 soll wirken.
    const cfg = config({
      stage2UtilizationThreshold: 0,
      protectedTailMessages: 2,
      stage2MinBlockBytes: 1_000_000,
      stage3MinMessages: 2,
      maxRoundsPerCall: 3,
    });

    const model = countingModel(
      [
        "ZIEL: Test.",
        "STAND: läuft.",
        "OFFENE_AUFGABEN: keine.",
        "ENTSCHEIDUNGEN: keine.",
        "ARTEFAKT_REFS: keine.",
        "NAECHSTER_SCHRITT: weiter.",
      ].join("\n"),
    );

    const firstEvents = await readEvents(pool, sessionId);
    const first = await compactHistory(deps(sessionId, model), {
      turnId: "turn_1",
      messages,
      messageSeqs,
      events: firstEvents,
      fixedOverheadTokens: 0,
      config: cfg,
    });

    expect(first.compacted).toBe(true);
    expect(model.calls).toBe(1);
    // Fünf Nachrichten (Eröffnung + 2 Runden) werden zu zwei; die geschützte Runde bleibt.
    expect(first.messages).toHaveLength(4);
    expect(first.messages[0]?.role).toBe("assistant");
    expect(first.messages[1]?.role).toBe("user");
    expect(JSON.stringify(first.messages[1]?.content)).toContain("ZIEL: Test.");
    expect(first.messages[2]?.content).toEqual(round("call_3", "geschützte Runde")[0]?.content);

    const afterFirst = await readEvents(pool, sessionId);
    expect(stage3Events(afterFirst)).toHaveLength(1);
    // Der Modellaufruf selbst zählt als eigener Schritt im Protokoll (Auftrag S18a), damit er
    // in der Kostenrechnung sichtbar ist — nicht nur die fertige Zusammenfassung.
    const requested = afterFirst.filter(
      (event) => event.type === "model.requested" && event.payload.purpose === "compaction",
    );
    const responded = afterFirst.filter(
      (event) => event.type === "model.responded" && event.payload.purpose === "compaction",
    );
    expect(requested).toHaveLength(1);
    expect(responded).toHaveLength(1);

    const rawUri = stage3Events(afterFirst)[0]?.payload.raw_artifact_uri as string;
    const raw = (await readArtifact(pool, artifactRoot, rawUri)).bytes.toString("utf8");
    expect(raw).toContain("erste Runde");
    expect(raw).toContain("zweite Runde");

    // Zweiter Aufruf: derselbe Rohverlauf, aber das Protokoll trägt die Zusammenfassung schon
    // — kein zweiter Modellaufruf, kein zweites Ereignis.
    const second = await compactHistory(deps(sessionId, model), {
      turnId: "turn_1",
      messages,
      messageSeqs,
      events: afterFirst,
      fixedOverheadTokens: 0,
      config: cfg,
    });
    expect(model.calls).toBe(1);
    expect(second.messages).toEqual(first.messages);
    const afterSecond = await readEvents(pool, sessionId);
    expect(stage3Events(afterSecond)).toHaveLength(1);
  });

  it("lässt einen offenen Werkzeugaufruf ohne Ergebnis unangetastet", async () => {
    const sessionId = await newSession();
    const dangling: ModelMessage = { role: "assistant", content: [toolUse("call_offen")] };
    const messages: ModelMessage[] = [OPENING, ...round("call_1", "abgeschlossen"), dangling];
    const messageSeqs = messages.map((_, index) => index + 1);
    const cfg = config({
      stage2UtilizationThreshold: 0,
      protectedTailMessages: 0,
      stage3MinMessages: 1,
      maxRoundsPerCall: 3,
    });

    const events = await readEvents(pool, sessionId);
    const result = await compactHistory(deps(sessionId, countingModel("ungenutzt")), {
      turnId: "turn_1",
      messages,
      messageSeqs,
      events,
      fixedOverheadTokens: 0,
      config: cfg,
    });

    // Der offene Aufruf bleibt wortgleich stehen — würde er in eine Zusammenfassung fallen,
    // fehlte dem nächsten Modellaufruf sein `tool_result`, und der Anbieter wiese ihn ab.
    expect(result.messages.at(-1)).toEqual(dangling);
  });
});

describe("context/compaction · Kontextstufe 4 (context.section_started)", () => {
  it("wendet einen frischen Abschnitt genauso an wie eine Stufe-3-Zusammenfassung", async () => {
    // `context/section.ts` schreibt `context.section_started` nie selbst hier — dieser Test
    // prüft nur, dass `compactHistory` ein solches Ereignis zurückliest und respektiert, ohne
    // dass diese Datei je davon erfahren müsste, dass Stufe 4 überhaupt existiert (S18b).
    const sessionId = await newSession();
    const messages: ModelMessage[] = [
      OPENING,
      ...round("call_1", "erste Runde"),
      ...round("call_2", "zweite Runde"),
    ];
    const messageSeqs = messages.map((_, index) => index + 1);

    await appendEvent(pool, sessionId, "context.section_started", {
      turn_id: "turn_0",
      reason: "idle",
      idle_ms: 3_000_000,
      completed_task_id: null,
      stage3_streak: null,
      through_seq: messageSeqs[2], // nach der ersten Runde
      covered_messages: 3,
      raw_artifact_uri: "artifact://test/section",
      handover: "STAND: knappe Übergabe.\nOFFEN: keine.\nREFS: keine.",
      model: "modell-test",
    });

    const events = await readEvents(pool, sessionId);
    const cfg = config({ contextWindowTokens: 1_000_000 }); // keine Stufe 2/3 soll zusätzlich greifen

    const result = await compactHistory(deps(sessionId, countingModel("ungenutzt")), {
      turnId: "turn_1",
      messages,
      messageSeqs,
      events,
      fixedOverheadTokens: 0,
      config: cfg,
    });

    // Eröffnung + erste Runde (2 Nachrichten) werden zur Übergabe; die zweite Runde bleibt.
    expect(result.messages).toHaveLength(4);
    expect(result.messages[0]?.role).toBe("assistant");
    expect(result.messages[1]?.role).toBe("user");
    expect(JSON.stringify(result.messages[1]?.content)).toContain("knappe Übergabe");
    expect(result.messages[2]?.content).toEqual(round("call_2", "zweite Runde")[0]?.content);
  });
});

describe("context/compaction · Schwellenwert", () => {
  it("tut nichts, wenn die Historie unter der konfigurierten Auslastung bleibt", async () => {
    const sessionId = await newSession();
    const messages: ModelMessage[] = [OPENING, ...round("call_1", "klein")];
    const messageSeqs = messages.map((_, index) => index + 1);
    const cfg = config({ contextWindowTokens: 1_000_000 });

    const events = await readEvents(pool, sessionId);
    const result = await compactHistory(deps(sessionId, countingModel("ungenutzt")), {
      turnId: "turn_1",
      messages,
      messageSeqs,
      events,
      fixedOverheadTokens: 0,
      config: cfg,
    });

    expect(result.compacted).toBe(false);
    expect(result.messages).toEqual(messages);
    expect(
      (await readEvents(pool, sessionId)).filter((e) => e.type === "context.compacted"),
    ).toHaveLength(0);
  });
});
