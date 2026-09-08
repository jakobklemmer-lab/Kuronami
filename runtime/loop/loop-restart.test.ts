import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deriveLoopState } from "../../context/transcript.js";
import { createPool } from "../db/pool.js";
import { type EventRecord, readEvents } from "../events/log.js";
import { readSessionState, readStepSnapshot, replaySession } from "../session/state.js";

/**
 * Das dritte Drittel des Fertig-Kriteriums von S12: die Aufgabe muss **einen erzwungenen
 * Neustart in der Mitte überleben**.
 *
 * Der Absturz wird nicht nachgestellt, sondern vorgeführt: ein echter Betriebssystem-Prozess
 * läuft die Schleife, wird vom Test mit `SIGKILL` abgeschossen, und ein **frisch gestarteter**
 * Prozess setzt fort. Er teilt mit dem ersten keine einzige Zeile Arbeitsspeicher; alles, was
 * er über den Lauf weiß, steht in `kuronami.events`.
 */

const STEPS = 30;
/** Bei diesem Schritt bleibt der erste Lauf im Werkzeugaufruf hängen und wird abgeschossen. */
const KILL_AT = 13;

const pool = createPool();
const threadIds: string[] = [];
const children: ChildProcess[] = [];
let sourceRoot: string;
let artifactRoot: string;

const PROCESS_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "loop-restart.process.ts",
);

beforeAll(async () => {
  sourceRoot = await mkdtemp(path.join(tmpdir(), "kuronami-restart-"));
  artifactRoot = path.join(sourceRoot, "artifacts");
  await mkdir(artifactRoot, { recursive: true });
});

afterAll(async () => {
  for (const child of children) child.kill("SIGKILL");
  if (threadIds.length > 0) {
    const sessions = "SELECT session_id FROM kuronami.sessions WHERE thread_id = ANY($1)";
    await pool.query(
      `DELETE FROM kuronami.artifacts WHERE (source ->> 'session_id') IN (${sessions})`,
      [threadIds],
    );
    for (const table of ["approvals", "tasks", "steps", "events"]) {
      await pool.query(`DELETE FROM kuronami.${table} WHERE session_id IN (${sessions})`, [
        threadIds,
      ]);
    }
    await pool.query("DELETE FROM kuronami.sessions WHERE thread_id = ANY($1)", [threadIds]);
  }
  await pool.end();
  if (sourceRoot) await rm(sourceRoot, { recursive: true, force: true });
});

/**
 * Über `node --import tsx` und nicht über die pnpm-Hülle: die ist unter Windows eine .cmd,
 * und der Umweg über eine Shell stellte einen zweiten Prozess zwischen Test und Ziel — den
 * träfe der Abschuss dann statt den richtigen (Befund aus S05).
 */
function start(threadId: string, resume: boolean): ChildProcess {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", PROCESS_FILE, threadId, sourceRoot, artifactRoot, String(STEPS)],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        KURONAMI_HANG_AT: String(KILL_AT),
        ...(resume ? { KURONAMI_RESUME: "1" } : {}),
      },
    },
  );
  children.push(child);
  return child;
}

/**
 * Wartet, bis der Prozess **im** Werkzeugaufruf steht: `model.responded` und `step.started`
 * sind geschrieben, `step.completed` nicht. Genau dieses Fenster soll der Abschuss treffen —
 * beim Gegenprobieren hat sich gezeigt, dass ein Abschuss "irgendwo in der Mitte" auch
 * zwischen zwei Zyklen landen kann, und dann prüft der Nachweis die Wiederaufnahme gar nicht.
 */
function waitForMarker(child: ChildProcess, marker: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let err = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes(marker)) resolve();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.on("exit", (code) =>
      reject(new Error(`Der Lauf endete vorzeitig mit Code ${code}: ${err}`)),
    );
    child.on("error", reject);
  });
}

function waitForDone(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.on("exit", (code) => {
      const match = out.match(/DONE (\S+) (\d+)/);
      if (code === 0 && match) resolve(`${match[1]} ${match[2]}`);
      else reject(new Error(`Lauf endete mit Code ${code}: ${err || out}`));
    });
    child.on("error", reject);
  });
}

/** Hartes Beenden ohne Aufräumen — kein `finally`, kein `runtime.stopped`, nichts. */
function kill(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
  });
}

function payloadsOf(events: EventRecord[], type: string): Record<string, unknown>[] {
  return events.filter((event) => event.type === type).map((event) => event.payload);
}

describe("Loop · erzwungener Neustart mitten im Lauf", () => {
  it("setzt nach dem Abschuss fort und führt jeden Seiteneffekt genau einmal aus", async () => {
    const threadId = `thread_test_${randomUUID()}`;
    threadIds.push(threadId);

    // --- Lauf 1: bis mitten in den 13. Werkzeugaufruf, dann abgeschossen.
    const first = start(threadId, false);
    await waitForMarker(first, "HANGING");
    await kill(first);

    const sessionRow = await pool.query<{ session_id: string }>(
      "SELECT session_id FROM kuronami.sessions WHERE thread_id = $1",
      [threadId],
    );
    const sessionId = sessionRow.rows[0].session_id;

    const midEvents = await readEvents(pool, sessionId);
    const midState = deriveLoopState(midEvents);
    // Mitten drin: der Zug ist offen, zwölf Aufrufe sind erledigt, der dreizehnte steht
    // **offen** — das Modell hat ihn genannt, ein Ergebnis gibt es nicht.
    expect(midState.turnId).not.toBeNull();
    expect(midState.toolCalls).toBe(KILL_AT - 1);
    expect(midState.pending.map((entry) => entry.callId)).toEqual([`call_step_${KILL_AT}`]);
    expect(midState.pending[0].toolName).toBe("dev.hang");
    // Und der Schritt dazu steht auf `running`: der Checkpoint davor hat stattgefunden, der
    // danach nicht (S05). Genau diese Lücke hinterlässt ein abgeschossener Prozess.
    const midSteps = await readStepSnapshot(pool, sessionId);
    expect(midSteps.filter((step) => step.status === "running")).toHaveLength(1);
    // Der abgeschossene Prozess hat kein `runtime.stopped` geschrieben — das Kennzeichen
    // eines abgestürzten Laufs seit S04, hier absichtlich stehen gelassen.
    expect(payloadsOf(midEvents, "runtime.started")).toHaveLength(1);
    expect(payloadsOf(midEvents, "runtime.stopped")).toHaveLength(0);
    expect(payloadsOf(midEvents, "turn.completed")).toHaveLength(0);

    // --- Lauf 2: ein frischer Prozess, der nur die Datenbank kennt.
    const second = start(threadId, true);
    const outcome = await waitForDone(second);
    expect(outcome).toBe(`done ${STEPS}`);

    // Alle Dateien da, jede mit dem richtigen Inhalt. Schritt 1 setzt den Plan, Schritt
    // KILL_AT ist der abgeschossene `dev.hang` — beide schreiben keine Datei.
    for (let index = 2; index <= STEPS; index += 1) {
      if (index === KILL_AT) continue;
      expect(await readFile(path.join(artifactRoot, `schritt-${index}.txt`), "utf8")).toBe(
        `Inhalt von Schritt ${index}\n`,
      );
    }

    const events = await readEvents(pool, sessionId);
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));

    // **Ein Zug, kein zweiter.** Die Wiederaufnahme hat den offenen fortgesetzt, statt einen
    // neuen zu beginnen — sonst wäre die halbe Arbeit aus dem Kontext gefallen.
    expect(payloadsOf(events, "turn.started")).toHaveLength(1);
    expect(payloadsOf(events, "turn.completed")).toHaveLength(1);
    expect(payloadsOf(events, "session.resumed")).toHaveLength(1);

    // **Jeder Seiteneffekt genau einmal.** 30 verschiedene Aufrufe, 29 Schritt-Zeilen
    // (`task.set` läuft als Runtime-Tool ohne Schritt), und jedes `tool.completed`, das ein
    // zweites Mal zu derselben Aufrufkennung geschrieben wurde, trägt `executed: false` —
    // das Ergebnis kam dann aus der Zeile, der Effekt lief nicht noch einmal (S05).
    const completed = payloadsOf(events, "tool.completed");
    const callIds = completed.map((payload) => String(payload.call_id));
    expect(new Set(callIds).size).toBe(STEPS);
    const seen = new Set<string>();
    for (const payload of completed) {
      const callId = String(payload.call_id);
      if (seen.has(callId)) expect(payload.executed).toBe(false);
      seen.add(callId);
    }

    const steps = await readStepSnapshot(pool, sessionId);
    expect(steps).toHaveLength(STEPS - 1);
    expect(steps.every((step) => step.status === "completed")).toBe(true);

    // Der unterbrochene Schritt ist **derselbe** und hat einen zweiten Versuch bekommen — er
    // wurde nicht als neuer Schritt noch einmal angelegt. Das ist der Idempotenzschlüssel
    // `tool:call_step_13` aus S05, über einen echten Prozessabsturz hinweg.
    const interrupted = steps.find((step) => step.idempotencyKey === `tool:call_step_${KILL_AT}`);
    expect(interrupted?.attempt).toBe(2);
    expect(steps.filter((step) => step.toolName === "dev.hang")).toHaveLength(1);

    // Und der Endzustand ist aus dem Protokoll herleitbar — über den Absturz hinweg.
    expect(await replaySession(pool, sessionId)).toEqual(await readSessionState(pool, sessionId));
  }, 120_000);
});
