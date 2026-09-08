import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "../db/pool.js";
import { readEvents } from "../events/log.js";
import { createOrResumeSession } from "../session/manager.js";
import {
  TaskInputError,
  TaskNotFoundError,
  readPlanSnapshot,
  replayPlan,
  setPlan,
  updateTask,
} from "./store.js";
import { TaskStatusError } from "./types.js";

/**
 * `task.set` / `task.update` gegen die echte Datenbank. Der rote Faden ist die S05-Disziplin:
 * die Zeilen in `kuronami.tasks` (Snapshot) und die Faltung über `task.created`/`task.updated`
 * (Replay) müssen bei jeder Änderung übereinstimmen.
 */

const pool = createPool();
const threadIds: string[] = [];

async function newSession(): Promise<string> {
  const threadId = `thread_test_${randomUUID()}`;
  threadIds.push(threadId);
  const { session } = await createOrResumeSession(pool, { threadId, channel: "web" });
  return session.sessionId;
}

async function eventTypes(sessionId: string): Promise<string[]> {
  return (await readEvents(pool, sessionId)).map((event) => event.type);
}

/** Snapshot und Faltung Seite an Seite — die eine Aussage, die diese Datei immer wieder macht. */
async function expectSnapshotEqualsReplay(sessionId: string) {
  const snapshot = await readPlanSnapshot(pool, sessionId);
  expect(await replayPlan(pool, sessionId)).toEqual(snapshot);
  return snapshot;
}

afterAll(async () => {
  if (threadIds.length > 0) {
    const sessions = "SELECT session_id FROM kuronami.sessions WHERE thread_id = ANY($1)";
    await pool.query(`DELETE FROM kuronami.tasks WHERE session_id IN (${sessions})`, [threadIds]);
    await pool.query(`DELETE FROM kuronami.events WHERE session_id IN (${sessions})`, [threadIds]);
    await pool.query(`DELETE FROM kuronami.steps WHERE session_id IN (${sessions})`, [threadIds]);
    await pool.query("DELETE FROM kuronami.sessions WHERE thread_id = ANY($1)", [threadIds]);
  }
  await pool.end();
});

describe("task.set", () => {
  it("legt einen Plan an: Positionen, task.created je Aufgabe, Snapshot == Faltung", async () => {
    const sessionId = await newSession();

    const change = await setPlan(pool, sessionId, [
      { id: "t1", title: "Mails lesen", status: "in_progress" },
      { id: "t2", title: "Zusammenfassen", dependencies: ["t1"] },
      { id: "t3", title: "Antwort entwerfen", blockers: ["wartet auf Freigabe"] },
    ]);

    expect(change.created).toEqual(["t1", "t2", "t3"]);
    expect(change.updated).toEqual([]);
    expect(change.dropped).toEqual([]);
    expect(change.plan.map((task) => task.taskId)).toEqual(["t1", "t2", "t3"]);
    expect(change.plan.map((task) => task.position)).toEqual([0, 1, 2]);
    expect(change.plan[0].status).toBe("in_progress");
    expect(change.plan[1].dependencies).toEqual(["t1"]);
    expect(change.plan[2].blockers).toEqual(["wartet auf Freigabe"]);
    expect(change.plan[0].owner).toBe("main-agent");

    expect(await eventTypes(sessionId)).toEqual([
      "session.created",
      "task.created",
      "task.created",
      "task.created",
    ]);

    const snapshot = await expectSnapshotEqualsReplay(sessionId);
    expect(snapshot.map((task) => task.title)).toEqual([
      "Mails lesen",
      "Zusammenfassen",
      "Antwort entwerfen",
    ]);
  });

  it("schreibt den Plan komplett neu: neu, geändert, unverändert, entfernt", async () => {
    const sessionId = await newSession();
    await setPlan(pool, sessionId, [
      { id: "t1", title: "Bleibt gleich" },
      { id: "t2", title: "Wird geändert" },
      { id: "t3", title: "Verschwindet" },
    ]);

    const change = await setPlan(pool, sessionId, [
      { id: "t1", title: "Bleibt gleich" },
      { id: "t2", title: "Wird geändert", status: "done" },
      { id: "t4", title: "Kommt neu dazu" },
    ]);

    expect(change.created).toEqual(["t4"]);
    expect(change.updated).toEqual(["t2"]);
    expect(change.dropped).toEqual(["t3"]);
    expect(change.plan.map((task) => task.taskId)).toEqual(["t1", "t2", "t4"]);
    expect(change.plan.map((task) => task.position)).toEqual([0, 1, 2]);

    // Unverändert = kein Ereignis (wie beginStep bei einem schon fertigen Schritt).
    const types = await eventTypes(sessionId);
    expect(types.filter((type) => type === "task.created")).toHaveLength(4); // 3 + t4
    expect(types.filter((type) => type === "task.updated")).toHaveLength(2); // t2 geändert, t3 dropped

    await expectSnapshotEqualsReplay(sessionId);
    expect(
      (await readPlanSnapshot(pool, sessionId)).find((task) => task.taskId === "t3"),
    ).toBeUndefined();
  });

  it("leert den Plan bei einer leeren Liste", async () => {
    const sessionId = await newSession();
    await setPlan(pool, sessionId, [{ id: "t1", title: "Nur kurz da" }]);

    const change = await setPlan(pool, sessionId, []);
    expect(change.dropped).toEqual(["t1"]);
    expect(await readPlanSnapshot(pool, sessionId)).toEqual([]);
    await expectSnapshotEqualsReplay(sessionId);
  });

  it("weist doppelte ids ab", async () => {
    const sessionId = await newSession();
    await expect(
      setPlan(pool, sessionId, [
        { id: "t1", title: "Eins" },
        { id: "t1", title: "Noch eins" },
      ]),
    ).rejects.toThrow(TaskInputError);
    expect(await eventTypes(sessionId)).toEqual(["session.created"]);
  });

  it("weist eine id ab, die der Redaction-Filter verändern würde", async () => {
    const sessionId = await newSession();
    await expect(
      setPlan(pool, sessionId, [
        { id: "postgres://u:p@host/db", title: "id ist ein Connection-String" },
      ]),
    ).rejects.toThrow(/stabiler Schlüssel/);
  });

  it("weist einen ungültigen Status ab, ohne etwas zu schreiben", async () => {
    const sessionId = await newSession();
    await expect(
      setPlan(pool, sessionId, [{ id: "t1", title: "X", status: "erledigt" as unknown as "done" }]),
    ).rejects.toThrow(TaskStatusError);
    expect(await eventTypes(sessionId)).toEqual(["session.created"]);
  });

  it("filtert ein Secret in einem Blocker, in Zeile und Ereignis gleich", async () => {
    const sessionId = await newSession();
    await setPlan(pool, sessionId, [
      {
        id: "t1",
        title: "Deploy",
        blockers: ["DB-Zugang: postgres://user:pass@db.intern/kuronami"],
      },
    ]);

    const snapshot = await readPlanSnapshot(pool, sessionId);
    expect(snapshot[0].blockers[0]).not.toContain("pass");
    expect(snapshot[0].blockers[0]).toContain("[redacted:");
    // Zeile und Ereignis tragen bitweise denselben Wert — sonst schlägt der Vergleich fehl.
    await expectSnapshotEqualsReplay(sessionId);
  });
});

describe("task.update", () => {
  it("ändert Status, Blocker und Artefakt-Refs einer einzelnen Aufgabe", async () => {
    const sessionId = await newSession();
    await setPlan(pool, sessionId, [
      { id: "t1", title: "Recherche" },
      { id: "t2", title: "Bericht" },
    ]);

    const change = await updateTask(pool, sessionId, "t1", {
      status: "done",
      blockers: [],
      artifactRefs: ["artifact://sess/artifact_x"],
    });

    expect(change.updated).toEqual(["t1"]);
    const t1 = change.plan.find((task) => task.taskId === "t1");
    expect(t1?.status).toBe("done");
    expect(t1?.artifactRefs).toEqual(["artifact://sess/artifact_x"]);
    // t2 unberührt, Positionen stabil.
    expect(change.plan.map((task) => task.position)).toEqual([0, 1]);

    await expectSnapshotEqualsReplay(sessionId);
  });

  it("wirft bei einer unbekannten Aufgabe", async () => {
    const sessionId = await newSession();
    await setPlan(pool, sessionId, [{ id: "t1", title: "Da" }]);
    await expect(updateTask(pool, sessionId, "t99", { status: "done" })).rejects.toThrow(
      TaskNotFoundError,
    );
  });

  it("wirft bei einem leeren Patch", async () => {
    const sessionId = await newSession();
    await setPlan(pool, sessionId, [{ id: "t1", title: "Da" }]);
    await expect(updateTask(pool, sessionId, "t1", {})).rejects.toThrow(TaskInputError);
  });

  it("wirft bei einem Status außerhalb des Enums", async () => {
    const sessionId = await newSession();
    await setPlan(pool, sessionId, [{ id: "t1", title: "Da" }]);
    await expect(
      updateTask(pool, sessionId, "t1", { status: "fertig" as unknown as "done" }),
    ).rejects.toThrow(TaskStatusError);
  });

  it("hält Snapshot und Faltung über eine ganze Folge von Änderungen deckungsgleich", async () => {
    const sessionId = await newSession();
    await setPlan(pool, sessionId, [
      { id: "a", title: "A" },
      { id: "b", title: "B" },
      { id: "c", title: "C" },
    ]);
    await updateTask(pool, sessionId, "a", { status: "in_progress" });
    await updateTask(pool, sessionId, "b", { status: "blocked", blockers: ["wartet auf a"] });
    await setPlan(pool, sessionId, [
      { id: "a", title: "A", status: "done" },
      { id: "b", title: "B", status: "in_progress" },
      { id: "d", title: "D" },
    ]);
    await updateTask(pool, sessionId, "d", { status: "ready", dependencies: ["a", "b"] });

    const snapshot = await expectSnapshotEqualsReplay(sessionId);
    expect(snapshot.map((task) => `${task.taskId}:${task.status}`)).toEqual([
      "a:done",
      "b:in_progress",
      "d:ready",
    ]);
    expect(snapshot.find((task) => task.taskId === "d")?.dependencies).toEqual(["a", "b"]);
  });
});
