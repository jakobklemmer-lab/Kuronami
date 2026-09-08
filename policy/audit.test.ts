import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../runtime/db/pool.js";
import { createOrResumeSession } from "../runtime/session/manager.js";
import type { SessionRecord } from "../runtime/session/types.js";
import { buildFsZones, policyResolver } from "../tools/fs/paths.js";
import { createFsTools } from "../tools/fs/tools.js";
import { ToolRegistry } from "../tools/registry.js";
import { type ToolRouterDeps, callTool } from "../tools/router.js";
import { ApprovalRequiredError, decidePolicyApproval, policyAskId } from "./approvals.js";
import { auditGaps, isComplete, readAuditTrail } from "./audit.js";
import { createPolicyEngine } from "./engine.js";

/**
 * "Jede ausgeführte Aktion hinterlässt: Auslöser, Eingaben, Freigabepfad, Ausgaben,
 * Zeitstempel" (Abschnitt 10, letzter Satz).
 *
 * Geprüft wird an einem Lauf, der absichtlich **nicht** nur aus Sonnenschein besteht: ein
 * erlaubtes Lesen, eine abgelehnte Aktion, eine freigegebene, ein Zugriff auf einen
 * Geheimnisträger und zwei Fehler, die vor der Policy passieren. Gerade die letzten beiden
 * sind der Grund, warum die Lückenprüfung eine Bedingung braucht und nicht "jeder Ausgang
 * hat eine Entscheidung" sagen kann.
 */

const pool = createPool();
const threadIds: string[] = [];

let sourceRoot: string;
let artifactRoot: string;
// biome-ignore lint/suspicious/noExplicitAny: in beforeAll gesetzt
let catalog: ReturnType<ToolRegistry["freeze"]> = undefined as any;
// biome-ignore lint/suspicious/noExplicitAny: in beforeAll gesetzt
let deps: ToolRouterDeps = undefined as any;

beforeAll(async () => {
  sourceRoot = await mkdtemp(path.join(tmpdir(), "kuronami-audit-src-"));
  artifactRoot = path.join(sourceRoot, "artifacts");
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, "notiz.md"), "# Notiz\n");
  await writeFile(path.join(sourceRoot, ".env"), "DB_PASSWORD=hunter2\n");

  const zones = await buildFsZones({ sourceRoot, artifactRoot });
  catalog = new ToolRegistry().registerAll(createFsTools({ pool, artifactRoot, zones })).freeze();
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

async function newSession(): Promise<SessionRecord> {
  const threadId = `thread_test_${randomUUID()}`;
  threadIds.push(threadId);
  const { session } = await createOrResumeSession(pool, {
    threadId,
    channel: "web",
    defaults: { toolCatalogVersion: catalog.version },
  });
  return session;
}

describe("Audit-Pfad", () => {
  it("hinterlässt zu jeder ausgeführten Aktion alle fünf Angaben aus Abschnitt 10", async () => {
    const session = await newSession();

    // 1. Lesen, automatisch erlaubt.
    await callTool(deps, session, {
      callId: "a_read",
      name: "fs.read",
      origin: "model",
      input: { path: "notiz.md" },
    });

    // 2. Schreiben in die Artefaktzone, weiches Schreiben.
    await callTool(deps, session, {
      callId: "a_write",
      name: "fs.write",
      origin: "model",
      input: { path: "artifacts/ausgabe.txt", content: "ergebnis" },
    });

    // 3. Ein Geheimnisträger — erst gefragt, dann freigegeben.
    await expect(
      callTool(deps, session, {
        callId: "a_secret",
        name: "fs.read",
        origin: "operator",
        input: { path: ".env" },
      }),
    ).rejects.toThrow(ApprovalRequiredError);
    await decidePolicyApproval(pool, session.sessionId, policyAskId("a_secret"), "once", {
      decidedBy: "betreiber",
    });
    await callTool(deps, session, {
      callId: "a_secret",
      name: "fs.read",
      origin: "operator",
      input: { path: ".env" },
    });

    // 4. Eine Ablehnung durch eine Regel.
    await callTool(deps, session, {
      callId: "a_denied",
      name: "fs.write",
      origin: "model",
      input: { path: ".env", content: "x" },
    });

    // 5. und 6. Zwei Fehler, die vor der Policy liegen.
    await callTool(deps, session, { callId: "a_unknown", name: "gibt.esnicht" });
    await callTool(deps, session, { callId: "a_badinput", name: "fs.read", input: {} });

    const trail = await readAuditTrail(pool, session.sessionId);
    expect(trail.map((entry) => entry.callId)).toEqual([
      "a_read",
      "a_write",
      "a_secret",
      "a_denied",
      "a_unknown",
      "a_badinput",
    ]);

    // **Keine Lücke**: nichts ist gelaufen, ohne dass die Policy es gesehen hat.
    expect(auditGaps(trail)).toEqual([]);

    // Die vier Aufrufe, die die Policy erreicht haben, sind vollständig.
    for (const entry of trail.filter((e) => e.decision !== null)) {
      expect(isComplete(entry)).toBe(true);
      expect(entry.origin).not.toBe("unbekannt");
      expect(entry.requestedAt).toBeInstanceOf(Date);
      expect(entry.decidedAt).toBeInstanceOf(Date);
      expect(entry.outcome?.at).toBeInstanceOf(Date);
      expect(entry.subject).toBeTruthy();
      expect(entry.path.length).toBeGreaterThan(0);
    }

    const read = trail[0];
    expect(read).toMatchObject({
      toolName: "fs.read",
      origin: "model",
      decision: "allow",
      declaredRisk: "read",
      effectiveRisk: "read",
      subject: "fs.read|zone/source",
    });
    expect(read.input).toEqual({ path: "notiz.md" });
    expect(read.outcome).toMatchObject({ status: "ok", executed: true });

    // Der Freigabepfad der freigegebenen Aktion nennt den Menschen, der entschieden hat.
    const secret = trail[2];
    expect(secret.origin).toBe("operator");
    expect(secret.approval).toMatchObject({ scope: "once", decidedBy: "betreiber" });
    expect(secret.secretAccess).toEqual([{ secretClass: "dotenv", path: ".env" }]);

    // Die Ablehnung ist genauso ein Audit-Eintrag wie ein Erfolg: sie hat einen Ausgang, und
    // der Weg dorthin steht vollständig da. Ein Protokoll, das nur die geglückten Aktionen
    // kennt, beantwortet die interessanteste Frage nicht.
    const denied = trail[3];
    expect(denied.decision).toBe("deny");
    expect(denied.outcome?.reason).toBe("policy_denied");
    expect(denied.path.some((entry) => entry.id === "secret-write")).toBe(true);

    // Und die beiden Fehler vor der Policy: kein Freigabepfad, aber auch keine Lücke — es
    // wurde nichts ausgeführt und nichts freigegeben.
    for (const entry of [trail[4], trail[5]]) {
      expect(entry.decision).toBeNull();
      expect(entry.outcome?.status).toBe("error");
      expect(["unknown_tool", "invalid_input"]).toContain(entry.outcome?.reason);
    }
  });

  it("verbindet Entscheidung und Ausgang über dieselbe audit_id", async () => {
    const session = await newSession();
    await callTool(deps, session, {
      callId: "a_link",
      name: "fs.read",
      input: { path: "notiz.md" },
    });

    const [entry] = await readAuditTrail(pool, session.sessionId);
    expect(entry.auditId).toMatch(/^audit_/);

    // Die Kennung steht in beiden Hälften; ohne sie ließen sie sich nur über die call_id und
    // die Reihenfolge zusammensuchen.
    const rows = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM kuronami.events
       WHERE session_id = $1 AND payload ->> 'audit_id' = $2`,
      [session.sessionId, entry.auditId],
    );
    expect(rows.rows[0].n).toBe(2);
  });

  it("meldet eine Lücke, wenn ein Ausgang ohne Entscheidung dasteht", async () => {
    // Gegenprobe zur Lückenprüfung selbst: ohne sie bewiese der Test oben nur, dass eine
    // leere Liste leer ist. Hier steht ein Ausgang mit einem Grund, der nicht vor der Policy
    // liegt — genau die Lage, die `auditGaps` finden muss.
    const gaps = auditGaps([
      {
        callId: "c",
        toolName: "fs.write",
        origin: "model",
        input: {},
        requestedAt: new Date(),
        auditId: null,
        decision: null,
        declaredRisk: "soft_write",
        effectiveRisk: null,
        subject: null,
        approval: null,
        path: [],
        decidedAt: null,
        secretAccess: [],
        outcome: {
          status: "ok",
          summary: "gelaufen",
          stepId: "step_1",
          executed: true,
          artifactRefs: [],
          reason: null,
          at: new Date(),
        },
      },
    ]);
    expect(gaps).toHaveLength(1);
  });
});
