import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool } from "../runtime/db/pool.js";
import { readEvents } from "../runtime/events/log.js";
import { redactText } from "../runtime/redaction/redact.js";
import { createOrResumeSession } from "../runtime/session/manager.js";
import { readSessionState } from "../runtime/session/state.js";
import type { ApprovalMode, SessionRecord } from "../runtime/session/types.js";
import type { JsonValue } from "../runtime/steps/types.js";
import { buildFsZones, policyResolver } from "../tools/fs/paths.js";
import { createFsTools } from "../tools/fs/tools.js";
import { ToolRegistry } from "../tools/registry.js";
import { type ToolRouterDeps, callTool } from "../tools/router.js";
import type { ToolDefinition, ToolResult } from "../tools/types.js";
import { ApprovalRequiredError, decidePolicyApproval, policyAskId } from "./approvals.js";
import { createPolicyEngine } from "./engine.js";
import { RiskLevelError } from "./risk.js";
import type { PolicyHook, PolicyRequest, PolicyRule } from "./types.js";

/**
 * Die vier Entscheidungsebenen durch den **echten Router**, gegen die echte Datenbank. Hier
 * steht das Fertig-Kriterium von S11: ein `hard_write`-Tool direkt aufgerufen, ohne Modell,
 * ohne Freigabe — und es passiert nichts.
 */

const pool = createPool();
const threadIds: string[] = [];

let sourceRoot: string;
let artifactRoot: string;
let markerPath: string;
/** Was `dev.send` tatsächlich verschickt hat. Bleibt leer, solange die Policy blockt. */
let sent: string[] = [];

// biome-ignore lint/suspicious/noExplicitAny: in beforeAll gesetzt
let catalog: ReturnType<ToolRegistry["freeze"]> = undefined as any;
// biome-ignore lint/suspicious/noExplicitAny: in beforeAll gesetzt
let resolve: ReturnType<typeof policyResolver> = undefined as any;

/** Ein Tool mit harter Schreibwirkung nach draußen und ohne Pfad — Mail, Shell, Produktivaktion. */
const DEV_SEND: ToolDefinition = {
  name: "dev.send",
  description: "Verschickt eine Nachricht nach draußen. Prüf-Tool der Stufe hartes Schreiben.",
  risk: "hard_write",
  repeatable: false,
  inputSchema: {
    fields: { message: { type: "string", required: true, description: "Was verschickt wird." } },
  },
  handler: async ({ input }) => {
    const message = input.message as string;
    sent.push(message);
    // Der Seiteneffekt hinterlässt eine Spur auf der Platte: "blockiert" heißt dann nicht
    // "ein Zähler blieb null", sondern "die Datei ist nicht da".
    await writeFile(markerPath, message, "utf8");
    return { summary: `verschickt: ${message}`, structured: { message } };
  },
};

const DEV_PURGE: ToolDefinition = {
  name: "dev.purge",
  description: "Löscht einen Produktivbestand. Prüf-Tool der Stufe zerstörend.",
  risk: "destructive",
  repeatable: false,
  inputSchema: { fields: {} },
  handler: async () => {
    sent.push("purge");
    return { summary: "gelöscht", structured: {} };
  },
};

function engine(opts: { hooks?: PolicyHook[]; rules?: PolicyRule[]; sandbox?: boolean } = {}) {
  return createPolicyEngine({
    resolvePath: resolve,
    hooks: opts.hooks,
    rules: opts.rules,
    sandbox: opts.sandbox
      ? { active: true, reason: "Testcontainer" }
      : { active: false, reason: "keine Sandbox verdrahtet" },
  });
}

function deps(overrides: Partial<ToolRouterDeps> = {}): ToolRouterDeps {
  return { pool, artifactRoot, catalog, policy: engine(), ...overrides };
}

beforeAll(async () => {
  sourceRoot = await mkdtemp(path.join(tmpdir(), "kuronami-policy-src-"));
  artifactRoot = path.join(sourceRoot, "artifacts");
  await mkdir(artifactRoot, { recursive: true });
  markerPath = path.join(artifactRoot, "gesendet.txt");

  await mkdir(path.join(sourceRoot, "src"), { recursive: true });
  await writeFile(path.join(sourceRoot, "src", "one.ts"), "const x = 1;\n");
  await writeFile(path.join(sourceRoot, ".env"), "ANTHROPIC_API_KEY=sk-ant-geheim\n");
  await writeFile(path.join(sourceRoot, ".env.example"), "ANTHROPIC_API_KEY=\n");

  const zones = await buildFsZones({ sourceRoot, artifactRoot });
  resolve = policyResolver(zones);
  catalog = new ToolRegistry()
    .registerAll(createFsTools({ pool, artifactRoot, zones }))
    .register(DEV_SEND)
    .register(DEV_PURGE)
    .freeze();
});

beforeEach(async () => {
  sent = [];
  await rm(markerPath, { force: true });
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

async function newSession(approvalMode: ApprovalMode = "ask"): Promise<SessionRecord> {
  const threadId = `thread_test_${randomUUID()}`;
  threadIds.push(threadId);
  const { session } = await createOrResumeSession(pool, {
    threadId,
    channel: "web",
    defaults: { toolCatalogVersion: catalog.version, approvalMode },
  });
  return session;
}

function structured(result: ToolResult): Record<string, JsonValue> {
  return result.structured as Record<string, JsonValue>;
}

async function eventTypes(sessionId: string): Promise<string[]> {
  return (await readEvents(pool, sessionId)).map((event) => event.type);
}

async function lastPayload(sessionId: string, type: string): Promise<Record<string, unknown>> {
  const events = (await readEvents(pool, sessionId)).filter((event) => event.type === type);
  return events[events.length - 1]?.payload ?? {};
}

// ---------------------------------------------------------------------------

describe("Fertig-Kriterium · hard_write ohne Freigabe wird blockiert", () => {
  it("blockiert ein direkt aufgerufenes hard_write-Tool: kein Modell, keine Freigabe, keine Wirkung", async () => {
    const session = await newSession();

    // Direkt abgesetzt, ohne Modell dazwischen. Die Herkunft steht im Protokoll, ändert die
    // Entscheidung aber nicht: "ohne Modell aufrufen" ist kein Weg an der Governance vorbei.
    await expect(
      callTool(deps(), session, {
        callId: "c_send",
        name: "dev.send",
        origin: "direct",
        input: { message: "geht raus" },
      }),
    ).rejects.toThrow(ApprovalRequiredError);

    // Der Seiteneffekt hat nicht stattgefunden — weder im Speicher noch auf der Platte.
    expect(sent).toEqual([]);
    expect(existsSync(markerPath)).toBe(false);

    // Und die Ausführungshülle ist nie angelaufen: kein Schritt, keine Zeile in steps.
    expect(await eventTypes(session.sessionId)).toEqual([
      "session.created",
      "tool.requested",
      "approval.requested",
    ]);
    const state = await readSessionState(pool, session.sessionId);
    expect(state.steps).toEqual([]);
    expect(state.status).toBe("awaiting_user");

    // Die Rückfrage nennt Tool, Stufe, Subjekt und den Weg dorthin — sonst entschiede der
    // Mensch über eine Ja/Nein-Frage ohne Grundlage.
    const asked = await lastPayload(session.sessionId, "approval.requested");
    expect(asked).toMatchObject({
      kind: "policy",
      tool_name: "dev.send",
      effective_risk: "hard_write",
      subject: "dev.send|-",
    });
    expect((asked.options as { id: string }[]).map((entry) => entry.id)).toEqual([
      "once",
      "session",
      "always",
      "deny",
    ]);
  });

  it("blockiert fs.write in die Quellzone, weil die Regel es zu hartem Schreiben macht", async () => {
    const session = await newSession();
    const target = path.join(sourceRoot, "src", "neu.ts");

    await expect(
      callTool(deps(), session, {
        callId: "c_src_write",
        name: "fs.write",
        origin: "direct",
        input: { path: "src/neu.ts", content: "// neu" },
      }),
    ).rejects.toThrow(ApprovalRequiredError);

    expect(existsSync(target)).toBe(false);
    const asked = await lastPayload(session.sessionId, "approval.requested");
    expect(asked).toMatchObject({
      declared_risk: "soft_write",
      effective_risk: "hard_write",
      subject: "fs.write|zone/source",
    });
  });

  it("lässt denselben Aufruf nach der Freigabe durch und schreibt den Freigabepfad mit", async () => {
    const session = await newSession();
    const call = {
      callId: "c_send_ok",
      name: "dev.send",
      origin: "direct",
      input: { message: "jetzt aber" },
    };

    await expect(callTool(deps(), session, call)).rejects.toThrow(ApprovalRequiredError);

    const decided = await decidePolicyApproval(
      pool,
      session.sessionId,
      policyAskId("c_send_ok"),
      "once",
      { decidedBy: "betreiber" },
    );
    expect(decided).toMatchObject({ scope: "once", status: "granted", subject: "dev.send|-" });

    const result = await callTool(deps(), session, call);
    expect(result.status).toBe("ok");
    expect(sent).toEqual(["jetzt aber"]);
    expect(await readFile(markerPath, "utf8")).toBe("jetzt aber");

    const allowed = await lastPayload(session.sessionId, "policy.allowed");
    expect(allowed).toMatchObject({
      tool_name: "dev.send",
      origin: "direct",
      effective_risk: "hard_write",
      approval: { scope: "once", decidedBy: "betreiber", grantedInSession: session.sessionId },
    });
    // Der Freigabepfad trägt jede Ebene, die gesprochen hat — hier Boden und Freigabe.
    const layers = (allowed.path as { layer: string }[]).map((entry) => entry.layer);
    expect(layers).toContain("risk");
    expect(layers).toContain("approval");
  });
});

// ---------------------------------------------------------------------------

describe("Ebene 1 · Hooks", () => {
  it("lässt einen Hook ablehnen, und der Handler läuft nicht", async () => {
    const session = await newSession();
    const blocker: PolicyHook = {
      id: "kein-versand-freitags",
      check: (req) =>
        req.toolName === "dev.send" ? { decision: "deny", reason: "heute nicht" } : undefined,
    };

    const result = await callTool(deps({ policy: engine({ hooks: [blocker] }) }), session, {
      callId: "c_hook_deny",
      name: "dev.send",
      input: { message: "egal" },
    });

    // Eine Ablehnung ist eine Antwort: sie kommt als Hülle zurück, damit das Modell sie im
    // selben Lauf liest und einen anderen Weg wählt (Abschnitt 7).
    expect(result.status).toBe("error");
    expect(structured(result).reason).toBe("policy_denied");
    expect(JSON.stringify(structured(result))).toMatch(/heute nicht/);
    expect(sent).toEqual([]);
    expect(await eventTypes(session.sessionId)).toEqual([
      "session.created",
      "tool.requested",
      "policy.denied",
      "tool.failed",
    ]);
  });

  it("wertet einen abstürzenden Hook als Ablehnung", async () => {
    const session = await newSession();
    const broken: PolicyHook = {
      id: "kaputt",
      check: () => {
        throw new Error("undefined is not a function");
      },
    };
    const result = await callTool(deps({ policy: engine({ hooks: [broken] }) }), session, {
      callId: "c_hook_broken",
      name: "fs.read",
      input: { path: "src/one.ts" },
    });
    expect(result.status).toBe("error");
    expect(structured(result).reason).toBe("policy_denied");
    expect(JSON.stringify(structured(result))).toMatch(/undefined is not a function/);
  });

  it("lässt einen Hook auch ein Lesen verschärfen, das sonst automatisch liefe", async () => {
    const session = await newSession();
    const nosy: PolicyHook = {
      id: "lesen-nur-mit-nachfrage",
      check: () => ({ decision: "ask", reason: "in diesem Projekt wird auch Lesen gefragt" }),
    };
    await expect(
      callTool(deps({ policy: engine({ hooks: [nosy] }) }), session, {
        callId: "c_hook_ask",
        name: "fs.read",
        input: { path: "src/one.ts" },
      }),
    ).rejects.toThrow(ApprovalRequiredError);
  });
});

// ---------------------------------------------------------------------------

describe("Ebene 2 · statische Regeln und Geheimnisklassen", () => {
  it("fragt vor dem Lesen einer .env und protokolliert den Zugriff nach der Freigabe", async () => {
    const session = await newSession();
    const call = { callId: "c_env", name: "fs.read", input: { path: ".env" } };

    await expect(callTool(deps(), session, call)).rejects.toThrow(ApprovalRequiredError);

    await decidePolicyApproval(pool, session.sessionId, policyAskId("c_env"), "once", {
      decidedBy: "betreiber",
    });
    const result = await callTool(deps(), session, call);
    expect(result.status).toBe("ok");

    // "Zugriff protokollieren" — eigener Ereignistyp, nicht ein Feld in policy.allowed.
    expect(await eventTypes(session.sessionId)).toContain("policy.secret_accessed");
    expect(await lastPayload(session.sessionId, "policy.secret_accessed")).toMatchObject({
      secret_class: "dotenv",
      path: ".env",
      tool_name: "fs.read",
    });

    // Und der Wert selbst steht nicht im Protokoll: der Redaction-Filter (S07) greift am
    // Schreibtor. Die Policy regelt den **Zugriff**, der Filter das **Durchsickern** — beide
    // werden gebraucht, und keiner kann die Arbeit des anderen tun.
    const raw = JSON.stringify(await readEvents(pool, session.sessionId));
    expect(raw).not.toContain("sk-ant-geheim");
    expect(raw).toContain("[redacted:credential-field]");

    // Die Hülle, die der Router **im Speicher** zurückgibt, trägt den Klartext — sie ist die
    // Antwort des Tools an seinen Aufrufer, nicht der Modellkontext. Gefiltert wird an den
    // drei Toren (Protokoll, Artefaktmetadaten, Prompt-Aufbau), und auf dem Weg in den
    // Kontext läuft sie durch `buildPrompt`. Das hier hält fest, dass der Filter greift,
    // sobald sie ihn erreicht; die Behauptung "die Hülle ist schon gefiltert" wäre falsch
    // und würde die Grenze verschieben, statt sie zu benennen.
    expect(String(structured(result).content)).toContain("sk-ant-geheim");
    expect(redactText(String(structured(result).content))).toMatch(/\[redacted:/);
  });

  it("liest eine .env.example ohne Rückfrage", async () => {
    const session = await newSession();
    const result = await callTool(deps(), session, {
      callId: "c_env_example",
      name: "fs.read",
      input: { path: ".env.example" },
    });
    expect(result.status).toBe("ok");
    expect(await eventTypes(session.sessionId)).not.toContain("policy.secret_accessed");
  });

  it("verweigert das Überschreiben einer Zugangsdatei endgültig, ohne Rückfrage", async () => {
    const session = await newSession();
    const before = await readFile(path.join(sourceRoot, ".env"), "utf8");

    const result = await callTool(deps(), session, {
      callId: "c_env_write",
      name: "fs.write",
      input: { path: ".env", content: "ANTHROPIC_API_KEY=neu" },
    });

    // deny, nicht ask: es gibt keine Option, mit der das durchginge. Wer es doch will,
    // ändert die Regel — sichtbar und versioniert.
    expect(result.status).toBe("error");
    expect(structured(result).reason).toBe("policy_denied");
    expect(await readFile(path.join(sourceRoot, ".env"), "utf8")).toBe(before);
    expect(await eventTypes(session.sessionId)).not.toContain("approval.requested");
  });

  it("deckt mit einer Zonen-Freigabe nicht das Lesen eines Geheimnisträgers ab", async () => {
    const session = await newSession();

    // Sessionweite Freigabe für Schreibzugriffe in der Quellzone.
    await expect(
      callTool(deps(), session, {
        callId: "c_zone",
        name: "fs.write",
        input: { path: "src/zwei.ts", content: "// zwei" },
      }),
    ).rejects.toThrow(ApprovalRequiredError);
    await decidePolicyApproval(pool, session.sessionId, policyAskId("c_zone"), "session");

    // Ein weiterer Schreibzugriff in derselben Zone läuft jetzt durch …
    const second = await callTool(deps(), session, {
      callId: "c_zone_2",
      name: "fs.write",
      input: { path: "src/drei.ts", content: "// drei" },
    });
    expect(second.status).toBe("ok");

    // … das Lesen der .env aber nicht: anderes Subjekt, eigene Freigabe.
    await expect(
      callTool(deps(), session, { callId: "c_env_2", name: "fs.read", input: { path: ".env" } }),
    ).rejects.toThrow(ApprovalRequiredError);
  });
});

// ---------------------------------------------------------------------------

describe("Ebene 3 · Sessionmodus", () => {
  it("lässt accept_edits Dateiänderungen ohne Rückfrage durch", async () => {
    const session = await newSession("accept_edits");
    const result = await callTool(deps(), session, {
      callId: "c_accept",
      name: "fs.write",
      input: { path: "src/vier.ts", content: "// vier" },
    });

    expect(result.status).toBe("ok");
    expect(await readFile(path.join(sourceRoot, "src", "vier.ts"), "utf8")).toBe("// vier");
    expect(await eventTypes(session.sessionId)).not.toContain("approval.requested");

    const allowed = await lastPayload(session.sessionId, "policy.allowed");
    expect(allowed.path as { layer: string; id: string }[]).toContainEqual(
      expect.objectContaining({ layer: "mode", id: "accept_edits", decision: "allow" }),
    );
  });

  it("deckt accept_edits kein hartes Schreiben ohne Pfad ab", async () => {
    // Genau die Trennlinie: "Edits akzeptieren" heißt Dateiänderungen, nicht Mail, Shell
    // oder Datenbank.
    const session = await newSession("accept_edits");
    await expect(
      callTool(deps(), session, {
        callId: "c_accept_send",
        name: "dev.send",
        input: { message: "trotzdem?" },
      }),
    ).rejects.toThrow(ApprovalRequiredError);
    expect(sent).toEqual([]);
  });

  it("hebt accept_edits keine Regel auf", async () => {
    const session = await newSession("accept_edits");
    const result = await callTool(deps(), session, {
      callId: "c_accept_env",
      name: "fs.write",
      input: { path: ".env", content: "x" },
    });
    expect(result.status).toBe("error");
    expect(structured(result).reason).toBe("policy_denied");
  });

  it("greift bypass_in_sandbox nur mit Sandbox-Nachweis", async () => {
    const ohne = await newSession("bypass_in_sandbox");
    await expect(
      callTool(deps(), ohne, { callId: "c_bypass_1", name: "dev.send", input: { message: "a" } }),
    ).rejects.toThrow(ApprovalRequiredError);
    // Der Modus wird nicht stillschweigend übergangen: er steht mit seinem Grund im Antrag.
    const asked = await lastPayload(ohne.sessionId, "approval.requested");
    expect(JSON.stringify(asked.path)).toMatch(/kein Sandbox-Nachweis/);

    const mit = await newSession("bypass_in_sandbox");
    const result = await callTool(deps({ policy: engine({ sandbox: true }) }), mit, {
      callId: "c_bypass_2",
      name: "dev.send",
      input: { message: "b" },
    });
    expect(result.status).toBe("ok");
    expect(sent).toEqual(["b"]);
  });

  it("hebt kein Modus die Freigabepflicht für zerstörende Aktionen auf", async () => {
    for (const mode of ["ask", "accept_edits", "bypass_in_sandbox"] as ApprovalMode[]) {
      const session = await newSession(mode);
      await expect(
        callTool(deps({ policy: engine({ sandbox: true }) }), session, {
          callId: `c_purge_${mode}`,
          name: "dev.purge",
        }),
      ).rejects.toThrow(ApprovalRequiredError);

      // Und angeboten wird nur die Einmalfreigabe: "immer Freigabe" heißt jedes Mal.
      const asked = await lastPayload(session.sessionId, "approval.requested");
      expect((asked.options as { id: string }[]).map((entry) => entry.id)).toEqual([
        "once",
        "deny",
      ]);
    }
    expect(sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("Kein Tool ohne Zuordnung", () => {
  it("weist die Registry ein Tool ohne Risikostufe ab", () => {
    const nameless = {
      name: "dev.ohnestufe",
      description: "Hat keine Stufe.",
      repeatable: true,
      inputSchema: { fields: {} },
      handler: async () => ({ summary: "x" }),
    } as unknown as ToolDefinition;
    expect(() => new ToolRegistry().register(nameless)).toThrow(RiskLevelError);
  });

  it("verweigert auch die Engine, wenn eine Stufe doch fehlt", async () => {
    // Das zweite Tor. Ein Tool, das nicht als TypeScript-Literal entsteht (n8n-Bridge, S13),
    // kommt am Compiler und womöglich an der Registry vorbei — hier nicht mehr.
    const session = await newSession();
    const request = {
      sessionId: session.sessionId,
      callId: "c_norisk",
      toolName: "dev.ohnestufe",
      risk: undefined,
      input: {},
      approvalMode: "ask",
      origin: "direct",
    } as unknown as PolicyRequest;

    const outcome = await engine().check(pool, request);
    expect(outcome.kind).toBe("deny");
    expect(await eventTypes(session.sessionId)).toContain("policy.denied");
    expect(JSON.stringify(await lastPayload(session.sessionId, "policy.denied"))).toMatch(
      /keine der vier/,
    );
  });
});
