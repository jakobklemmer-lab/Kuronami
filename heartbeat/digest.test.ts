import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readArtifact } from "../runtime/artifacts/store.js";
import { createPool } from "../runtime/db/pool.js";
import { type EventRecord, readEvents } from "../runtime/events/log.js";
import { type BuiltCatalog, buildCatalog } from "../runtime/loop/api.js";
import { createScriptedModel } from "../runtime/loop/scripted.js";
import type { ModelClient } from "../runtime/model/types.js";
import type { DigestChannel } from "./delivery.js";
import { type HeartbeatDeps, handleNotification, runDigest } from "./digest.js";
import { ensureDiarySession } from "./service.js";

/**
 * **Erster Test von S17: Der Digest läuft ohne manuellen Anstoß.**
 *
 * `runDigest` bekommt keine Eingabe von außen — der Prompt entsteht im Dienst. Geprüft wird,
 * dass am Ende ein Artefakt liegt und über den Kanal etwas zugestellt wurde. Dazu die
 * Tagesobergrenze und "keine Meldung, wenn nichts gefunden wird" (`handleNotification`).
 *
 * Echte Datenbank, echter Loop, echter Hintergrundkatalog; nur Modell und Kanal sind gestellt.
 */

const pool = createPool();
const sessionIds: string[] = [];
let sourceRoot: string;
let artifactRoot: string;
let built: BuiltCatalog;
const FIXED_NOW = new Date(2026, 8, 9, 7, 5);

class RecordingChannel implements DigestChannel {
  readonly id = "test";
  readonly sent: string[] = [];
  async deliver(text: string): Promise<void> {
    this.sent.push(text);
  }
}

class FailingChannel implements DigestChannel {
  readonly id = "test-fail";
  async deliver(): Promise<void> {
    throw new Error("Zustellung kaputt");
  }
}

beforeAll(async () => {
  sourceRoot = await mkdtemp(path.join(tmpdir(), "kuronami-hb-digest-"));
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

async function freshDiary(): Promise<string> {
  const id = await ensureDiarySession(pool, `thread_heartbeat_test_${randomUUID()}`);
  sessionIds.push(id);
  return id;
}

function deps(
  over: Partial<HeartbeatDeps> & { channel: DigestChannel; diarySessionId: string },
): HeartbeatDeps {
  return {
    pool,
    artifactRoot,
    catalog: built.catalog,
    policy: built.policy,
    model: over.model ?? digestModel("# Morgen-Digest\n\nAlles ruhig."),
    now: () => FIXED_NOW,
    conventions: "# Test",
    maxRunsPerDay: 8,
    maxSteps: 6,
    ...over,
  };
}

/** Ein Digest-Drehbuch: erst planen, dann das Arbeitsverzeichnis ansehen, dann den Text. */
function digestModel(finalText: string): ModelClient {
  return createScriptedModel({
    steps: 2,
    step: (index) =>
      index === 1
        ? {
            toolName: "task.set",
            input: { tasks: [{ id: "d1", title: "Digest", status: "in_progress" }] },
          }
        : { toolName: "fs.list", input: { path: "." } },
    finalText,
  });
}

function collectRun(events: EventRecord[]): void {
  for (const event of events) {
    const runSession = (event.payload as { run_session?: string }).run_session;
    if (runSession && !sessionIds.includes(runSession)) sessionIds.push(runSession);
  }
}

describe("Heartbeat · Morgen-Digest", () => {
  it("läuft ohne Eingabe, legt ein Artefakt ab und stellt zu", async () => {
    const channel = new RecordingChannel();
    const diarySessionId = await freshDiary();
    const digestText =
      "# Morgen-Digest\n\n## Mail\nNichts Neues.\n\n## Kalender\nEin Termin um 10:00.";

    const result = await runDigest(
      deps({ channel, diarySessionId, model: digestModel(digestText) }),
    );

    expect(result.status).toBe("delivered");
    expect(result.artifactUri).toMatch(/^artifact:\/\//);

    // Zugestellt: genau eine Nachricht, sie trägt den Digest-Text und das Handle.
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]).toContain("## Mail");
    expect(channel.sent[0]).toContain(result.artifactUri);

    // Das Artefakt trägt den Digest-Text byteweise.
    const artifact = await readArtifact(pool, artifactRoot, result.artifactUri ?? "");
    expect(artifact.bytes.toString("utf8")).toBe(digestText);
    expect(artifact.summary).toContain("Morgen-Digest 2026-09-09");
    expect(artifact.source.tool).toBe("heartbeat.digest");

    // Das Diarium hält den Lauf fest.
    const diary = await readEvents(pool, diarySessionId);
    collectRun(diary);
    const ran = diary.find((event) => event.type === "heartbeat.ran");
    expect((ran?.payload as { kind?: string; ok?: boolean; delivered?: boolean }).kind).toBe(
      "digest",
    );
    expect((ran?.payload as { ok?: boolean }).ok).toBe(true);
    expect((ran?.payload as { delivered?: boolean }).delivered).toBe(true);
    expect(diary.some((event) => event.type === "heartbeat.delivered")).toBe(true);

    // Die Session des Laufs lief auf dem Kanal heartbeat, Modus background.
    const runSessionId = (ran?.payload as { run_session?: string }).run_session ?? "";
    const runSession = await pool.query(
      "SELECT channel, mode FROM kuronami.sessions WHERE session_id = $1",
      [runSessionId],
    );
    expect(runSession.rows[0]).toEqual({ channel: "heartbeat", mode: "background" });
  });

  it("achtet die Tagesobergrenze: der zweite fällige Lauf wird übersprungen", async () => {
    const channel = new RecordingChannel();
    const diarySessionId = await freshDiary();
    const base = deps({ channel, diarySessionId, maxRunsPerDay: 1 });

    const first = await runDigest(base);
    const second = await runDigest(base);

    expect(first.status).toBe("delivered");
    expect(second.status).toBe("skipped");
    expect(channel.sent).toHaveLength(1);

    const diary = await readEvents(pool, diarySessionId);
    collectRun(diary);
    expect(diary.filter((event) => event.type === "heartbeat.ran")).toHaveLength(1);
    const skipped = diary.find((event) => event.type === "heartbeat.skipped");
    expect((skipped?.payload as { reason?: string }).reason).toBe("daily_cap");
  });

  it("stellt einen Fehlerhinweis zu, wenn der Lauf nicht sauber endet", async () => {
    const channel = new RecordingChannel();
    const diarySessionId = await freshDiary();
    // Ein Drehbuch, das nur Fehlaufrufe macht, endet an der Fehlerhäufung, nicht mit done.
    const model = createScriptedModel({
      steps: 10,
      step: () => ({ toolName: "fs.read", input: { path: "gibtsnicht.txt" } }),
      finalText: "unerreichbar",
    });
    const result = await runDigest(deps({ channel, diarySessionId, model, maxSteps: 20 }));

    expect(result.status).toBe("failed");
    expect(channel.sent[0]).toContain("konnte nicht erstellt werden");
    const diary = await readEvents(pool, diarySessionId);
    collectRun(diary);
    expect((diary.find((e) => e.type === "heartbeat.ran")?.payload as { ok?: boolean }).ok).toBe(
      false,
    );
  });

  it("meldet eine kaputte Zustellung, ohne den Digest zu verlieren", async () => {
    const diarySessionId = await freshDiary();
    const result = await runDigest(deps({ channel: new FailingChannel(), diarySessionId }));

    expect(result.status).toBe("failed");
    expect(result.artifactUri).toMatch(/^artifact:\/\//); // das Artefakt liegt trotzdem
    const diary = await readEvents(pool, diarySessionId);
    collectRun(diary);
    expect(diary.some((event) => event.type === "error.raised")).toBe(true);
    expect(diary.some((event) => event.type === "heartbeat.delivered")).toBe(false);
    expect(
      (diary.find((e) => e.type === "heartbeat.ran")?.payload as { delivered?: boolean }).delivered,
    ).toBe(false);
  });
});

describe("Heartbeat · ereignisgesteuerter Lauf", () => {
  it("schweigt, wenn der Lauf nichts Meldenswertes findet", async () => {
    const channel = new RecordingChannel();
    const diarySessionId = await freshDiary();

    const result = await handleNotification(
      deps({ channel, diarySessionId, model: digestModel("STILL") }),
      { kind: "mail", detail: "Newsletter" },
    );

    expect(result.status).toBe("silent");
    expect(channel.sent).toHaveLength(0);
    const diary = await readEvents(pool, diarySessionId);
    collectRun(diary);
    expect(diary.some((event) => event.type === "heartbeat.silent")).toBe(true);
    const ran = diary.find((event) => event.type === "heartbeat.ran");
    expect((ran?.payload as { kind?: string; delivered?: boolean }).kind).toBe("notify");
    expect((ran?.payload as { delivered?: boolean }).delivered).toBe(false);
  });

  it("stellt zu, wenn es etwas zu sagen gibt", async () => {
    const channel = new RecordingChannel();
    const diarySessionId = await freshDiary();

    const result = await handleNotification(
      deps({
        channel,
        diarySessionId,
        model: digestModel("Der Server meldet 95% Speicherauslastung — jetzt aufräumen."),
      }),
      { kind: "server", detail: "disk > 90%" },
    );

    expect(result.status).toBe("delivered");
    expect(channel.sent).toEqual(["Der Server meldet 95% Speicherauslastung — jetzt aufräumen."]);
    const diary = await readEvents(pool, diarySessionId);
    collectRun(diary);
    expect(
      diary.some(
        (event) =>
          event.type === "heartbeat.delivered" &&
          (event.payload as { trigger?: string }).trigger === "server",
      ),
    ).toBe(true);
  });
});
