import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { ToolRegistry } from "../../tools/registry.js";
import { createUserTools } from "../../tools/user/tools.js";
import { createPool } from "../db/pool.js";
import { readEvents } from "../events/log.js";
import { createOrResumeSession } from "./manager.js";
import { readSessionState, replaySession } from "./state.js";
import { answerUserInput } from "./user-input.js";

/**
 * Das Fertig-Kriterium von S10, mit einem Befehl nachweisbar: ein Lauf pausiert sauber bei
 * `user.ask`, ein **frisch gestarteter Prozess** findet den Wartezustand unverändert vor,
 * und nach der Antwort setzt derselbe Aufruf den Lauf fort.
 *
 * Der Lauf läuft als eigener Betriebssystem-Prozess (`node --import tsx`, nicht über die
 * pnpm-Hülle — die ist unter Windows eine .cmd und stellte einen zweiten Prozess dazwischen),
 * damit "überlebt den Neustart" wörtlich geprüft wird und nicht an einem geteilten
 * Modulzustand vorbei.
 */

const pool = createPool();
const threadIds: string[] = [];

const PROCESS = path.join(path.dirname(fileURLToPath(import.meta.url)), "await-user.process.ts");

/**
 * Derselbe Katalog, den `await-user.process.ts` beim Start baut (`createUserTools({ pool })`
 * allein, kein `fs.*`/`web.*`). Die Session wird unten mit dessen Fingerabdruck **neu
 * angelegt** (nicht der Vorgabe `"v1"`) — Startwerte gelten laut S04 nur bei der Neuanlage,
 * ein Wiederfinden übernimmt sie nicht. Ohne diesen Abgleich hielte der gespawnte Prozess
 * einen anderen Katalog als die Session gespeichert hat, und jeder Aufruf schlüge mit
 * `ToolCatalogMismatchError` fehl, bevor er `user.ask` überhaupt erreicht — die S10-Disziplin
 * aus `tools/router.ts`, dass eine Session nicht klammheimlich mit einem anderen Toolsatz
 * weiterläuft, greift hier gegen den Test selbst.
 */
const catalog = new ToolRegistry().registerAll(createUserTools({ pool })).freeze();

function runProcess(
  threadId: string,
  callId: string,
  mode: "pause" | "resume",
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", PROCESS, threadId, "web", callId, mode],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code }));
  });
}

async function eventTypes(sessionId: string): Promise<string[]> {
  return (await readEvents(pool, sessionId)).map((event) => event.type);
}

afterAll(async () => {
  if (threadIds.length > 0) {
    const sessions = "SELECT session_id FROM kuronami.sessions WHERE thread_id = ANY($1)";
    await pool.query(`DELETE FROM kuronami.events WHERE session_id IN (${sessions})`, [threadIds]);
    await pool.query(`DELETE FROM kuronami.steps WHERE session_id IN (${sessions})`, [threadIds]);
    await pool.query("DELETE FROM kuronami.sessions WHERE thread_id = ANY($1)", [threadIds]);
  }
  await pool.end();
});

describe("user.ask · Pause überlebt den Prozess-Neustart", () => {
  it(
    "pausiert sauber, hält den Wartezustand und setzt nach der Antwort fort",
    async () => {
      const threadId = `thread_test_${randomUUID()}`;
      threadIds.push(threadId);
      const { session } = await createOrResumeSession(pool, {
        threadId,
        channel: "web",
        defaults: { toolCatalogVersion: catalog.version },
      });
      const sessionId = session.sessionId;

      // --- Lauf 1: bis zum Haltepunkt, dann Prozessende ---
      const first = await runProcess(threadId, "c1", "pause");
      expect(first.stderr).toBe("");
      expect(first.code).toBe(0); // sauber beendet, nicht abgeschossen
      expect(first.stdout).toBe("PAUSED ask:c1");

      // Der Wartezustand liegt jetzt nur in der Datenbank — der Prozess ist weg.
      const paused = await readSessionState(pool, sessionId);
      expect(paused.status).toBe("awaiting_user");
      expect(paused.steps).toEqual([]);
      expect(paused.pendingUserInput).toEqual([
        {
          askId: "ask:c1",
          question: "Welche Variante nehmen wir?",
          options: [
            { id: "opt_a", label: "Variante A" },
            { id: "opt_b", label: "Variante B" },
          ],
        },
      ]);

      // Sauberer Haltepunkt: kein step.*, kein tool.failed, runtime.stopped ist geschrieben.
      expect(await eventTypes(sessionId)).toEqual([
        "session.created",
        "session.resumed",
        "runtime.started",
        "tool.requested",
        "approval.requested",
        "runtime.stopped",
      ]);

      // --- Antwort von außen ---
      await answerUserInput(pool, sessionId, "ask:c1", "opt_b", { decidedBy: "test" });
      const answered = await readSessionState(pool, sessionId);
      expect(answered.status).toBe("running");
      expect(answered.pendingUserInput).toEqual([]);

      // --- Lauf 2: frischer Prozess, derselbe Aufruf, jetzt mit Antwort ---
      const second = await runProcess(threadId, "c1", "resume");
      expect(second.stderr).toBe("");
      expect(second.code).toBe(0);
      expect(second.stdout).toBe("ANSWERED opt_b ok");

      const done = await readSessionState(pool, sessionId);
      expect(done.status).toBe("running");
      expect(done.pendingUserInput).toEqual([]);

      // Die ganze Folge liest sich lückenlos: Haltepunkt, Antwort, Fortsetzung.
      expect(await eventTypes(sessionId)).toEqual([
        "session.created",
        "session.resumed",
        "runtime.started",
        "tool.requested",
        "approval.requested",
        "runtime.stopped",
        "approval.granted",
        "session.resumed",
        "runtime.started",
        "tool.requested",
        "tool.completed",
        "runtime.stopped",
      ]);

      // Replay aus dem Protokoll ergibt denselben Zustand wie der Snapshot.
      expect(await replaySession(pool, sessionId)).toEqual(await readSessionState(pool, sessionId));
    },
    { timeout: 40_000 },
  );
});
