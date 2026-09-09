import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ApprovalRequiredError,
  decidePolicyApproval,
  policyAskId,
} from "../../policy/approvals.js";
import { createPolicyEngine } from "../../policy/engine.js";
import { readArtifact } from "../../runtime/artifacts/store.js";
import { createPool } from "../../runtime/db/pool.js";
import { readEvents } from "../../runtime/events/log.js";
import { createOrResumeSession } from "../../runtime/session/manager.js";
import { readSessionState, replaySession } from "../../runtime/session/state.js";
import type { SessionRecord } from "../../runtime/session/types.js";
import type { JsonValue } from "../../runtime/steps/types.js";
import { ToolRegistry } from "../registry.js";
import { type ToolRouterDeps, callTool } from "../router.js";
import type { ToolResult } from "../types.js";
import { buildVaultRoot } from "./paths.js";
import { NOTES_READ_EXCERPT_MAX_CHARS, createNotesTools } from "./tools.js";

/**
 * `notes.read` / `notes.write` durch den **echten** Router (Datenbank, echte Policy, echte
 * Ausführungshülle), mit einem Wegwerf-Verzeichnis als Obsidian-Vault. Hier stehen zwei der
 * drei S15-Testpunkte: eine Notiz aus dem Vault lesen, und ein Schreibversuch, der korrekt
 * für eine Freigabe pausiert.
 */

const pool = createPool();
const threadIds: string[] = [];
let vaultDir: string;
let artifactRoot: string;

function notesDeps(): { deps: ToolRouterDeps; version: string } {
  const vault = { root: vaultDir };
  const catalog = new ToolRegistry()
    .registerAll(createNotesTools({ pool, artifactRoot, vault }))
    .freeze();
  // notes.* nimmt weder `path` noch `url` entgegen — der Resolver wird nie gerufen. Dass er
  // wirft, hält das fest (wie in router.test.ts).
  const policy = createPolicyEngine({
    resolvePath: async () => {
      throw new Error("Dieser Katalog kennt keine Pfad-Tools");
    },
  });
  return { deps: { pool, artifactRoot, catalog, policy }, version: catalog.version };
}

async function newSession(version: string): Promise<SessionRecord> {
  const threadId = `thread_test_${randomUUID()}`;
  threadIds.push(threadId);
  const { session } = await createOrResumeSession(pool, {
    threadId,
    channel: "web",
    defaults: { toolCatalogVersion: version },
  });
  return session;
}

function structured(result: ToolResult): Record<string, JsonValue> {
  return result.structured as Record<string, JsonValue>;
}

async function eventTypes(sessionId: string): Promise<string[]> {
  return (await readEvents(pool, sessionId)).map((event) => event.type);
}

beforeAll(async () => {
  vaultDir = await mkdtemp(path.join(tmpdir(), "kuronami-notes-vault-"));
  artifactRoot = await mkdtemp(path.join(tmpdir(), "kuronami-notes-art-"));
  await mkdir(path.join(vaultDir, "Projekte"), { recursive: true });
});

afterAll(async () => {
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
  await rm(vaultDir, { recursive: true, force: true });
  await rm(artifactRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Aufbau
// ---------------------------------------------------------------------------

describe("notes.* · Aufbau", () => {
  it("stellt genau zwei Tools bereit, notes.write ist hard_write", () => {
    const tools = createNotesTools({ pool, artifactRoot, vault: { root: vaultDir } });
    expect(tools.map((tool) => tool.name).sort()).toEqual(["notes.read", "notes.write"]);
    expect(tools.find((tool) => tool.name === "notes.read")?.risk).toBe("read");
    expect(tools.find((tool) => tool.name === "notes.write")?.risk).toBe("hard_write");
  });

  it("baut die Vault-Wurzel aus buildVaultRoot", async () => {
    const vault = await buildVaultRoot(vaultDir);
    expect(vault.root.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// notes.read
// ---------------------------------------------------------------------------

describe("notes.read", () => {
  it("liest eine Notiz aus dem Vault: Volltext als Artefakt, Ausschnitt im Kontext", async () => {
    const deepMarker = `TIEF_${randomUUID()}`;
    const body = [
      "---",
      "tags: [projekt, kuronami]",
      "---",
      "",
      "# Kuronami — Architektur",
      "",
      "Persönlicher Assistent mit [[Runtime]] und [[Policy-Engine]].",
      "Fülltext. ".repeat(600),
      deepMarker,
      "Schluss.",
    ].join("\n");
    await writeFile(path.join(vaultDir, "Projekte", "Kuronami.md"), body, "utf8");

    const { deps, version } = notesDeps();
    const session = await newSession(version);

    const result = await callTool(deps, session, {
      callId: "call_read",
      name: "notes.read",
      input: { note: "Projekte/Kuronami" },
    });

    expect(result.status).toBe("ok");
    const s = structured(result);
    expect(s.note).toBe("Projekte/Kuronami.md");
    expect(s.title).toBe("Kuronami — Architektur");
    expect((s.excerpt as string).length).toBeLessThanOrEqual(NOTES_READ_EXCERPT_MAX_CHARS);
    expect(s.excerpt_truncated).toBe(true);
    expect(String(s.note_artifact_uri)).toContain("artifact://");

    // Der tief liegende Marker steht nicht in der Hülle, nur im Artefakt.
    expect(JSON.stringify(result)).not.toContain(deepMarker);

    const stored = await readArtifact(pool, artifactRoot, String(s.note_artifact_uri));
    expect(stored.bytes.toString("utf8")).toBe(body);
    expect(stored.mimeType).toBe("text/markdown");
    expect(stored.source).toMatchObject({ tool: "notes.read", sessionId: session.sessionId });
    expect(result.artifact_refs).toEqual([s.note_artifact_uri]);

    const types = await eventTypes(session.sessionId);
    expect(types).toEqual(
      expect.arrayContaining([
        "tool.requested",
        "policy.allowed",
        "step.started",
        "artifact.created",
        "step.completed",
        "tool.completed",
      ]),
    );
    expect(types).not.toContain("tool.failed");
    expect(await replaySession(pool, session.sessionId)).toEqual(
      await readSessionState(pool, session.sessionId),
    );
  });

  it("meldet eine fehlende Notiz als Fehlerhülle, ohne Artefakt", async () => {
    const { deps, version } = notesDeps();
    const session = await newSession(version);

    const result = await callTool(deps, session, {
      callId: "call_read_missing",
      name: "notes.read",
      input: { note: "Projekte/GibtsNicht" },
    });

    expect(result.status).toBe("error");
    expect(structured(result).reason).toBe("handler_failed");
    expect(await eventTypes(session.sessionId)).not.toContain("artifact.created");
  });

  it("weist ../ ab, ohne eine Datei außerhalb des Vaults zu berühren", async () => {
    const { deps, version } = notesDeps();
    const session = await newSession(version);

    const result = await callTool(deps, session, {
      callId: "call_read_escape",
      name: "notes.read",
      input: { note: "../../etc/passwd" },
    });

    expect(result.status).toBe("error");
    expect(String(structured(result).error)).toMatch(/Vault/);
  });
});

// ---------------------------------------------------------------------------
// notes.write — pausiert immer für eine Freigabe
// ---------------------------------------------------------------------------

describe("notes.write", () => {
  it("pausiert für eine Freigabe: nichts geschrieben, Session awaiting_user", async () => {
    const { deps, version } = notesDeps();
    const session = await newSession(version);

    await expect(
      callTool(deps, session, {
        callId: "call_write_pause",
        name: "notes.write",
        input: { note: "Inbox/Idee.md", content: "Ein Gedanke.\n" },
      }),
    ).rejects.toThrow(ApprovalRequiredError);

    const types = await eventTypes(session.sessionId);
    expect(types).toContain("approval.requested");
    expect(types).not.toContain("step.started");
    expect(types).not.toContain("tool.failed");

    expect((await readSessionState(pool, session.sessionId)).status).toBe("awaiting_user");

    // Die Notiz ist nicht entstanden.
    await expect(readFile(path.join(vaultDir, "Inbox", "Idee.md"))).rejects.toThrow();
  });

  it("schreibt nach der Freigabe die Notiz in den Vault (bytegleich)", async () => {
    const { deps, version } = notesDeps();
    const session = await newSession(version);
    const content = `Neue Idee ${randomUUID()}\n\n- Punkt eins\n- Punkt zwei\n`;

    await expect(
      callTool(deps, session, {
        callId: "call_write_ok",
        name: "notes.write",
        input: { note: "Inbox/Beschlossen.md", content },
      }),
    ).rejects.toThrow(ApprovalRequiredError);

    await decidePolicyApproval(pool, session.sessionId, policyAskId("call_write_ok"), "once", {
      decidedBy: "test",
    });

    const result = await callTool(deps, session, {
      callId: "call_write_ok",
      name: "notes.write",
      input: { note: "Inbox/Beschlossen.md", content },
    });

    expect(result.status).toBe("ok");
    const s = structured(result);
    expect(s.note).toBe("Inbox/Beschlossen.md");
    expect(s.created).toBe(true);

    const onDisk = await readFile(path.join(vaultDir, "Inbox", "Beschlossen.md"), "utf8");
    expect(onDisk).toBe(content);

    const types = await eventTypes(session.sessionId);
    expect(types).toEqual(
      expect.arrayContaining([
        "approval.requested",
        "approval.granted",
        "policy.allowed",
        "step.started",
        "step.completed",
        "tool.completed",
      ]),
    );
    expect(await replaySession(pool, session.sessionId)).toEqual(
      await readSessionState(pool, session.sessionId),
    );
  });

  it("weist auch nach der Freigabe einen leeren Inhalt ab (keine stille Kürzung)", async () => {
    const { deps, version } = notesDeps();
    const session = await newSession(version);
    // Erst existierende Notiz, damit ein leerer Inhalt eine echte Kürzung wäre.
    await mkdir(path.join(vaultDir, "Inbox"), { recursive: true });
    await writeFile(path.join(vaultDir, "Inbox", "Bestehend.md"), "# Wichtig\n\nInhalt.\n", "utf8");

    await expect(
      callTool(deps, session, {
        callId: "call_write_leer",
        name: "notes.write",
        input: { note: "Inbox/Bestehend.md", content: "" },
      }),
    ).rejects.toThrow(ApprovalRequiredError);

    await decidePolicyApproval(pool, session.sessionId, policyAskId("call_write_leer"), "once", {
      decidedBy: "test",
    });

    const result = await callTool(deps, session, {
      callId: "call_write_leer",
      name: "notes.write",
      input: { note: "Inbox/Bestehend.md", content: "" },
    });

    expect(result.status).toBe("error");
    expect(structured(result).reason).toBe("handler_failed");
    // Die bestehende Notiz steht unverändert da.
    expect(await readFile(path.join(vaultDir, "Inbox", "Bestehend.md"), "utf8")).toBe(
      "# Wichtig\n\nInhalt.\n",
    );
  });
});
