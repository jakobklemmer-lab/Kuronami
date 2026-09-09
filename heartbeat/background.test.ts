import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApprovalRequiredError } from "../policy/approvals.js";
import { createPolicyEngine } from "../policy/engine.js";
import { BACKGROUND_RULES, DEFAULT_RULES } from "../policy/rules.js";
import type { PolicyVerdict } from "../policy/types.js";
import { createPool } from "../runtime/db/pool.js";
import { readEvents } from "../runtime/events/log.js";
import { type Runner, buildCatalog, createRunner } from "../runtime/loop/api.js";
import { type ScriptedStep, createScriptedModel } from "../runtime/loop/scripted.js";
import type { ModelClient } from "../runtime/model/types.js";
import { createOrResumeSession } from "../runtime/session/manager.js";
import { buildFsZones, policyResolver } from "../tools/fs/paths.js";

/**
 * **Zweiter Test von S17: Ein Hintergrundlauf kann nachweislich nicht ins Langzeitgedächtnis
 * schreiben.**
 *
 * Der Nachweis läuft durch den echten Loop, den echten Router und die echte Policy — nur das
 * Modell ist ein Drehbuch. Der Hintergrundkatalog (`profile: "background"`) bringt
 * `BACKGROUND_RULES` mit: ein Schreibzugriff in die Quellzone (und `memory/` liegt darin) ist
 * `deny`, kein `ask`. Die Gegenproben zeigen beide Ränder: dieselbe Aufgabe in die
 * Artefaktzone geht durch, und dieselbe Aufgabe gegen den Standard-Regelsatz fragt nur nach,
 * statt abzulehnen — die Sperre ist also der Zusatzregelsatz und nicht der Router.
 */

const pool = createPool();
const sessionIds: string[] = [];
let sourceRoot: string;
let artifactRoot: string;

beforeAll(async () => {
  sourceRoot = await mkdtemp(path.join(tmpdir(), "kuronami-hb-bg-"));
  artifactRoot = path.join(sourceRoot, "artifacts");
  await mkdir(artifactRoot, { recursive: true });
  await mkdir(path.join(sourceRoot, "memory"), { recursive: true });
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

function scriptedWrite(target: string): ModelClient {
  const step: ScriptedStep = {
    toolName: "fs.write",
    input: { path: target, content: "vom Hintergrundlauf" },
  };
  return createScriptedModel({ steps: 1, step: () => step, finalText: "Fertig." });
}

async function backgroundRunner(model: ModelClient): Promise<Runner> {
  const { catalog, policy } = await buildCatalog({
    pool,
    artifactRoot,
    sourceRoot,
    profile: "background",
  });
  const runner = await createRunner({
    pool,
    threadId: `thread_test_hb_${randomUUID()}`,
    channel: "heartbeat",
    sessionMode: "background",
    artifactRoot,
    catalog,
    policy,
    model,
    conventions: "# Test",
    maxSteps: 5,
  });
  sessionIds.push(runner.session.sessionId);
  return runner;
}

describe("Hintergrundlauf · Schreibgrenze ans Langzeitgedächtnis", () => {
  it("der Katalog hat kein user.ask und keine schreibenden Assistenz-Tools", async () => {
    const { catalog } = await buildCatalog({
      pool,
      artifactRoot,
      sourceRoot,
      profile: "background",
    });
    const names = catalog.tools.map((tool) => tool.name);
    expect(names).not.toContain("user.ask");
    expect(names).not.toContain("notes.write");
    expect(names).not.toContain("cal.create");
    // Lesen und Vorschlagen bleibt: fs.read und fs.write (in die Artefaktzone) sind da.
    expect(names).toContain("fs.read");
    expect(names).toContain("fs.write");
  });

  it("fs.write nach memory/ wird von der Policy abgelehnt (deny, kein ask) und legt nichts an", async () => {
    const runner = await backgroundRunner(scriptedWrite("memory/heartbeat-notiz.md"));
    try {
      const outcome = await runner.run("Schreib dir eine Notiz.");
      // Der Lauf hängt nicht: die Ablehnung ist eine Antwort, das Drehbuch antwortet danach.
      expect(outcome.stop).toBe("done");
    } finally {
      await runner.stop("test").catch(() => {});
    }

    const events = await readEvents(pool, runner.session.sessionId);
    const denied = events.find(
      (event) =>
        event.type === "policy.denied" &&
        (event.payload as { tool_name?: string }).tool_name === "fs.write",
    );
    expect(denied, "es muss ein policy.denied für fs.write geben").toBeDefined();

    const verdicts = (denied?.payload as { path?: PolicyVerdict[] }).path ?? [];
    const ids = verdicts.filter((v) => v.decision === "deny").map((v) => v.id);
    expect(ids).toContain("background-longterm-memory-write");

    // Und keine Datei — auch kein .tmp.
    await expect(access(path.join(sourceRoot, "memory", "heartbeat-notiz.md"))).rejects.toThrow();

    // Kein step.started: die Ausführungshülle wurde nie betreten.
    expect(events.some((event) => event.type === "step.started")).toBe(false);
  });

  it("Gegenprobe: dieselbe Aufgabe in die Artefaktzone geht durch", async () => {
    const runner = await backgroundRunner(scriptedWrite("artifacts/heartbeat-notiz.md"));
    try {
      await runner.run("Leg einen Entwurf ab.");
    } finally {
      await runner.stop("test").catch(() => {});
    }

    const events = await readEvents(pool, runner.session.sessionId);
    expect(
      events.some(
        (event) =>
          event.type === "tool.completed" &&
          (event.payload as { tool_name?: string }).tool_name === "fs.write",
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "policy.denied" &&
          (event.payload as { tool_name?: string }).tool_name === "fs.write",
      ),
    ).toBe(false);
    await access(path.join(artifactRoot, "heartbeat-notiz.md")); // wirft, wenn sie fehlt
  });

  it("Gegenprobe: gegen den Standard-Regelsatz fragt derselbe Schreibzugriff nur nach", async () => {
    const zones = await buildFsZones({ sourceRoot, artifactRoot });
    const resolvePath = policyResolver(zones);
    const { session } = await createOrResumeSession(pool, {
      threadId: `thread_test_hb_${randomUUID()}`,
      channel: "heartbeat",
    });
    sessionIds.push(session.sessionId);

    const request = {
      sessionId: session.sessionId,
      callId: `call_${randomUUID()}`,
      toolName: "fs.write",
      risk: "soft_write" as const,
      input: { path: "memory/x.md", content: "y" },
      approvalMode: "ask" as const,
      origin: "model",
    };

    const background = createPolicyEngine({
      resolvePath,
      rules: [...BACKGROUND_RULES, ...DEFAULT_RULES],
    });
    const standard = createPolicyEngine({ resolvePath, rules: DEFAULT_RULES });

    const backgroundOutcome = await background.check(pool, {
      ...request,
      callId: `call_${randomUUID()}`,
    });
    expect(backgroundOutcome.kind).toBe("deny");

    await expect(
      standard.check(pool, { ...request, callId: `call_${randomUUID()}` }),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
  });
});
