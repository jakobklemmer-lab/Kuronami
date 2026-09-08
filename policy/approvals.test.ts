import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../runtime/db/pool.js";
import { readEvents } from "../runtime/events/log.js";
import { createOrResumeSession } from "../runtime/session/manager.js";
import { readSessionState } from "../runtime/session/state.js";
import type { SessionRecord } from "../runtime/session/types.js";
import { buildFsZones, policyResolver } from "../tools/fs/paths.js";
import { createFsTools } from "../tools/fs/tools.js";
import { ToolRegistry } from "../tools/registry.js";
import { type ToolRouterDeps, callTool } from "../tools/router.js";
import type { ToolDefinition, ToolResult } from "../tools/types.js";
import {
  ApprovalNotPendingError,
  ApprovalRequiredError,
  UnknownApprovalChoiceError,
  decidePolicyApproval,
  derivePolicyApprovals,
  policyAskId,
  readApprovalSnapshot,
  requestPolicyApproval,
} from "./approvals.js";
import { createPolicyEngine } from "./engine.js";

/**
 * Freigaben mit Geltungsbereich (Auftrag S11: einmalig / Session / dauerhaft) und der
 * Nachweis, dass eine sessiongebundene Freigabe einen **Prozessneustart** überlebt.
 *
 * Alle Aufrufe gehen über den echten Router; das Tool ist `fs.write` in die Quellzone, das
 * die Regel `write-outside-artifact-zone` auf `hard_write` hebt.
 */

const pool = createPool();
const threadIds: string[] = [];

const PROCESS = path.join(path.dirname(fileURLToPath(import.meta.url)), "policy-resume.process.ts");

let sourceRoot: string;
let artifactRoot: string;
/** Was `dev.persist` ausgeführt hat. */
const persisted: string[] = [];

/**
 * Ein eigenes hartes Schreiben für die Tests zur **dauerhaften** Freigabe.
 *
 * Der Grund ist eine Eigenschaft, keine Umständlichkeit: eine dauerhafte Freigabe gilt über
 * Sessiongrenzen hinweg und damit auch über Testgrenzen. Liefe sie auf `fs.write|zone/source`,
 * hätte der erste "dauerhaft"-Test jeden späteren Test in dieser und jeder gleichzeitig
 * laufenden Datei stumm freigeschaltet — und die hätten grün gemeldet, dass nicht gefragt
 * wird. Ein eigener Toolname gibt diesen Tests ihr eigenes Subjekt.
 */
const DEV_PERSIST: ToolDefinition = {
  name: "dev.persist",
  description: "Schreibt dauerhaft nach draußen. Prüf-Tool der Stufe hartes Schreiben.",
  risk: "hard_write",
  repeatable: false,
  inputSchema: {
    fields: { path: { type: "string", required: true, description: "Ziel, nur zur Einordnung." } },
  },
  handler: async ({ input }) => {
    persisted.push(input.path as string);
    return { summary: `dauerhaft: ${String(input.path)}`, structured: {} };
  },
};
// biome-ignore lint/suspicious/noExplicitAny: in beforeAll gesetzt
let catalog: ReturnType<ToolRegistry["freeze"]> = undefined as any;
// biome-ignore lint/suspicious/noExplicitAny: in beforeAll gesetzt
let deps: ToolRouterDeps = undefined as any;

beforeAll(async () => {
  sourceRoot = await mkdtemp(path.join(tmpdir(), "kuronami-appr-src-"));
  artifactRoot = path.join(sourceRoot, "artifacts");
  await mkdir(path.join(sourceRoot, "src"), { recursive: true });
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, "src", "vorhanden.ts"), "// da\n");

  const zones = await buildFsZones({ sourceRoot, artifactRoot });
  catalog = new ToolRegistry()
    .registerAll(createFsTools({ pool, artifactRoot, zones }))
    .register(DEV_PERSIST)
    .freeze();
  deps = {
    pool,
    artifactRoot,
    catalog,
    policy: createPolicyEngine({ resolvePath: policyResolver(zones) }),
  };
});

afterAll(async () => {
  if (threadIds.length > 0) {
    const sessions = "SELECT session_id FROM kuronami.sessions WHERE thread_id = ANY($1)";
    await pool.query(`DELETE FROM kuronami.approvals WHERE session_id IN (${sessions})`, [
      threadIds,
    ]);
    await pool.query(
      `DELETE FROM kuronami.artifacts WHERE (source ->> 'session_id') IN (${sessions})`,
      [threadIds],
    );
    await pool.query(`DELETE FROM kuronami.events WHERE session_id IN (${sessions})`, [threadIds]);
    await pool.query(`DELETE FROM kuronami.steps WHERE session_id IN (${sessions})`, [threadIds]);
    await pool.query("DELETE FROM kuronami.sessions WHERE thread_id = ANY($1)", [threadIds]);
  }
  await pool.end();
  await rm(sourceRoot, { recursive: true, force: true });
});

async function newSession(threadId = `thread_test_${randomUUID()}`): Promise<SessionRecord> {
  threadIds.push(threadId);
  const { session } = await createOrResumeSession(pool, {
    threadId,
    channel: "web",
    defaults: { toolCatalogVersion: catalog.version },
  });
  return session;
}

/** Ein Schreibversuch in die Quellzone — hartes Schreiben, also freigabepflichtig. */
function write(callId: string, rel: string) {
  return { callId, name: "fs.write", origin: "direct", input: { path: rel, content: `// ${rel}` } };
}

async function expectAsks(session: SessionRecord, callId: string, rel: string): Promise<void> {
  await expect(callTool(deps, session, write(callId, rel))).rejects.toThrow(ApprovalRequiredError);
}

function structured(result: ToolResult): Record<string, unknown> {
  return result.structured as Record<string, unknown>;
}

// ---------------------------------------------------------------------------

describe("Geltungsbereich · einmalig", () => {
  it("deckt genau den Aufruf, für den sie erteilt wurde", async () => {
    const session = await newSession();
    await expectAsks(session, "c_once_1", "src/a.ts");
    await decidePolicyApproval(pool, session.sessionId, policyAskId("c_once_1"), "once");

    const first = await callTool(deps, session, write("c_once_1", "src/a.ts"));
    expect(first.status).toBe("ok");
    expect(existsSync(path.join(sourceRoot, "src", "a.ts"))).toBe(true);

    // Ein anderer Aufruf mit demselben Subjekt fragt erneut. "Einmalig" heißt genau dieser
    // Aufruf und nicht "der nächste beliebige" — sonst griffe die Freigabe an einer Stelle,
    // an der niemand sie erteilt hat.
    await expectAsks(session, "c_once_2", "src/b.ts");
    expect(existsSync(path.join(sourceRoot, "src", "b.ts"))).toBe(false);
  });

  it("bleibt an ihren Aufruf gebunden, auch wenn er wiederholt wird", async () => {
    // Die Kehrseite: ein wiederaufgenommener Lauf leitet dieselbe `call_id` aus seinem Plan
    // wieder her (S07) und darf seine eigene Freigabe wiederfinden, ohne erneut zu fragen.
    const session = await newSession();
    await expectAsks(session, "c_once_repeat", "src/c.ts");
    await decidePolicyApproval(pool, session.sessionId, policyAskId("c_once_repeat"), "once");

    const first = await callTool(deps, session, write("c_once_repeat", "src/c.ts"));
    const second = await callTool(deps, session, write("c_once_repeat", "src/c.ts"));
    expect(first.status).toBe("ok");
    // Derselbe Schlüssel: die Ausführungshülle gibt das gespeicherte Ergebnis zurück (S05).
    expect(second).toEqual(first);
  });
});

describe("Geltungsbereich · Session", () => {
  it("deckt weitere Aufrufe derselben Session, aber keine andere Session", async () => {
    const first = await newSession();
    await expectAsks(first, "c_sess_1", "src/d.ts");
    await decidePolicyApproval(pool, first.sessionId, policyAskId("c_sess_1"), "session", {
      decidedBy: "betreiber",
    });

    for (const [callId, rel] of [
      ["c_sess_1", "src/d.ts"],
      ["c_sess_2", "src/e.ts"],
    ]) {
      const result = await callTool(deps, first, write(callId, rel));
      expect(result.status).toBe("ok");
    }

    // Eine zweite Session erbt nichts. Genau das unterscheidet "für diese Session" von
    // "dauerhaft", und es wäre der stille Fehler, wenn die Suche die Session vergäße.
    const other = await newSession();
    await expectAsks(other, "c_sess_3", "src/f.ts");
    expect(existsSync(path.join(sourceRoot, "src", "f.ts"))).toBe(false);
  });
});

describe("Geltungsbereich · dauerhaft", () => {
  const persist = (callId: string, rel: string) => ({
    callId,
    name: "dev.persist",
    origin: "direct",
    input: { path: rel },
  });

  it("gilt über Sessiongrenzen hinweg", async () => {
    const first = await newSession();
    await expect(callTool(deps, first, persist("c_always_1", "src/g.ts"))).rejects.toThrow(
      ApprovalRequiredError,
    );
    expect(persisted).toEqual([]);

    await decidePolicyApproval(pool, first.sessionId, policyAskId("c_always_1"), "always", {
      decidedBy: "betreiber",
    });
    expect((await callTool(deps, first, persist("c_always_1", "src/g.ts"))).status).toBe("ok");

    // Neue Session, neuer Faden, keine Rückfrage: die Freigabe lebt außerhalb der Session.
    const later = await newSession();
    const result = await callTool(deps, later, persist("c_always_2", "src/h.ts"));
    expect(result.status).toBe("ok");
    expect(persisted).toEqual(["src/g.ts", "src/h.ts"]);

    const allowed = (await readEvents(pool, later.sessionId)).find(
      (event) => event.type === "policy.allowed",
    );
    expect(allowed?.payload.approval).toMatchObject({
      scope: "always",
      // Erteilt wurde sie in der **ersten** Session — das steht im Freigabepfad, damit
      // hinterher nachvollziehbar bleibt, woher die Erlaubnis stammt.
      grantedInSession: first.sessionId,
    });
  });

  it("legt je Subjekt nur eine dauerhafte Freigabe an", async () => {
    // Eigenes Subjekt über einen eigenen Pfad: `dev.persist` bekommt seine Zone aus dem
    // aufgelösten Pfad, hier also dieselbe wie oben. Deshalb prüft dieser Test die Zeile in
    // der Tabelle und nicht noch einmal das Nachfragen.
    const session = await newSession();
    const before = await pool.query<{ approval_id: string }>(
      "SELECT approval_id FROM kuronami.approvals WHERE subject = $1 AND scope = 'always' AND status = 'granted'",
      ["dev.persist|zone/source"],
    );
    const existing = before.rows[0]?.approval_id;
    expect(existing).toBeDefined();

    // Eine zweite Rückfrage zum selben Subjekt kann nur entstehen, wenn sie schon offen war,
    // bevor die erste entschieden wurde. Genau das wird hier gestellt.
    await callTool(deps, session, persist("c_dup_seed", "src/i.ts"));
    await requestPolicyApproval(pool, {
      sessionId: session.sessionId,
      callId: "c_dup_2",
      toolName: "dev.persist",
      declaredRisk: "hard_write",
      effectiveRisk: "hard_write",
      subject: "dev.persist|zone/source",
      resource: { kind: "path", path: "src/j.ts", zone: "source", secret_class: null },
      path: [],
    });

    const second = await decidePolicyApproval(
      pool,
      session.sessionId,
      policyAskId("c_dup_2"),
      "always",
    );

    // Die zweite Entscheidung benutzt die bestehende Freigabe, statt am UNIQUE-Index zu
    // zerschellen: für den Betreiber ist "nochmal dauerhaft" keine Fehlbedienung.
    expect(second.approvalId).toBe(existing);
    const rows = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM kuronami.approvals WHERE subject = $1 AND scope = 'always'",
      ["dev.persist|zone/source"],
    );
    expect(rows.rows[0].n).toBe(1);
  });
});

describe("Ablehnung", () => {
  it("bleibt an ihrem Aufruf haften, auch über einen Neuversuch hinweg", async () => {
    const session = await newSession();
    await expectAsks(session, "c_deny", "src/k.ts");
    await decidePolicyApproval(pool, session.sessionId, policyAskId("c_deny"), "deny", {
      decidedBy: "betreiber",
      reason: "will ich nicht",
    });

    // Der Lauf fragt nicht erneut — er bekommt eine Fehlerhülle. Ohne diese Bindung fragte
    // ein wiederaufgenommener Lauf denselben Menschen dieselbe Frage noch einmal, und ein
    // abgelehnter Aufruf käme so lange wieder, bis jemand aus Versehen zustimmt.
    const result = await callTool(deps, session, write("c_deny", "src/k.ts"));
    expect(result.status).toBe("error");
    expect(structured(result).reason).toBe("policy_denied");
    expect(JSON.stringify(structured(result))).toMatch(/will ich nicht/);
    expect(existsSync(path.join(sourceRoot, "src", "k.ts"))).toBe(false);
  });

  it("weist eine zweite Entscheidung zur selben Rückfrage ab", async () => {
    const session = await newSession();
    await expectAsks(session, "c_twice", "src/l.ts");
    await decidePolicyApproval(pool, session.sessionId, policyAskId("c_twice"), "once");
    await expect(
      decidePolicyApproval(pool, session.sessionId, policyAskId("c_twice"), "always"),
    ).rejects.toThrow(ApprovalNotPendingError);
  });

  it("weist eine nicht angebotene Option ab", async () => {
    const session = await newSession();
    await expectAsks(session, "c_badopt", "src/m.ts");
    await expect(
      decidePolicyApproval(pool, session.sessionId, policyAskId("c_badopt"), "vielleicht"),
    ).rejects.toThrow(UnknownApprovalChoiceError);
  });
});

describe("Schnappschuss und Faltung", () => {
  it("ergibt aus dem Protokoll dasselbe wie aus der Tabelle", async () => {
    const session = await newSession();

    // Erst ablehnen, dann freigeben — in dieser Reihenfolge, weil eine Ablehnung an ihren
    // Aufruf gebunden ist und den nächsten deshalb weiter fragen lässt. Umgekehrt deckte die
    // sessionweite Freigabe den zweiten Aufruf schon ab, und es gäbe nichts zu entscheiden.
    await expectAsks(session, "c_fold_1", "src/n.ts");
    await decidePolicyApproval(pool, session.sessionId, policyAskId("c_fold_1"), "deny", {
      decidedBy: "betreiber",
    });
    await expectAsks(session, "c_fold_2", "src/o.ts");
    await decidePolicyApproval(pool, session.sessionId, policyAskId("c_fold_2"), "session", {
      decidedBy: "betreiber",
    });

    // Zwei unabhängig geschriebene Darstellungen, in einer Transaktion entstanden. Der
    // Vergleich trägt hier sein volles Gewicht, weil beide Wege getrennt geschrieben werden
    // (INSERT gegen Ereignis) — dasselbe Muster wie Schritte in S05 und Aufgaben in S10.
    const fromLog = derivePolicyApprovals(await readEvents(pool, session.sessionId));
    const fromTable = await readApprovalSnapshot(pool, session.sessionId);
    expect(fromLog).toEqual(fromTable);
    expect(fromLog.map((entry) => entry.status)).toEqual(["denied", "granted"]);
    expect(fromLog.map((entry) => entry.scope)).toEqual(["once", "session"]);
  });
});

// ---------------------------------------------------------------------------

function runProcess(
  threadId: string,
  callId: string,
  rel: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", PROCESS, threadId, "web", callId, sourceRoot, rel],
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

describe("Sessiongebundene Freigabe · überlebt den Prozessneustart", () => {
  it(
    "hält den ersten Lauf an und lässt einen frisch gestarteten Prozess durchlaufen",
    async () => {
      const threadId = `thread_test_${randomUUID()}`;
      threadIds.push(threadId);

      // --- Lauf 1: eigener Betriebssystem-Prozess, keine Freigabe ---
      const paused = await runProcess(threadId, "c_proc_1", "src/proc-a.ts");
      expect(paused.stderr).toBe("");
      expect(paused.code).toBe(0);
      expect(paused.stdout).toContain("PAUSED policy:c_proc_1");
      expect(existsSync(path.join(sourceRoot, "src", "proc-a.ts"))).toBe(false);

      const found = await pool.query<{ session_id: string }>(
        "SELECT session_id FROM kuronami.sessions WHERE thread_id = $1",
        [threadId],
      );
      const sessionId = found.rows[0].session_id;
      expect((await readSessionState(pool, sessionId)).status).toBe("awaiting_user");

      // --- Der Mensch entscheidet, zwischen den Prozessen ---
      await decidePolicyApproval(pool, sessionId, policyAskId("c_proc_1"), "session", {
        decidedBy: "betreiber",
      });

      // --- Lauf 2: **anderer** Prozess, **andere** call_id, **andere** Datei ---
      // Er kennt beim Start nichts als Faden, Kanal und Pfad. Findet er die Freigabe
      // trotzdem, kann sie nicht aus einem Speicher im Prozess gekommen sein.
      const wrote = await runProcess(threadId, "c_proc_2", "src/proc-b.ts");
      expect(wrote.stderr).toBe("");
      expect(wrote.code).toBe(0);
      expect(wrote.stdout).toContain("WROTE ok");
      expect(existsSync(path.join(sourceRoot, "src", "proc-b.ts"))).toBe(true);

      // Und sie steht auch dann noch da, wenn man ausschließlich das Protokoll liest — die
      // Tabelle ist der Schnappschuss, das Protokoll die Wahrheit (Abschnitt 4.4).
      const fromLog = derivePolicyApprovals(await readEvents(pool, sessionId));
      expect(fromLog).toEqual([
        expect.objectContaining({
          subject: "fs.write|zone/source",
          scope: "session",
          status: "granted",
          decidedBy: "betreiber",
        }),
      ]);

      const types = (await readEvents(pool, sessionId)).map((event) => event.type);
      expect(types).toEqual([
        "session.created",
        "runtime.started",
        "tool.requested",
        "approval.requested",
        "runtime.stopped",
        "approval.granted",
        "session.resumed",
        "runtime.started",
        "tool.requested",
        "policy.allowed",
        "step.started",
        "step.completed",
        "tool.completed",
        "runtime.stopped",
      ]);
    },
    { timeout: 40_000 },
  );
});
