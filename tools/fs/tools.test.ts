import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApprovalRequiredError } from "../../policy/approvals.js";
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
import { buildFsZones, policyResolver } from "./paths.js";
import { createFsTools } from "./tools.js";

/**
 * Die `fs.*`-Tools durch den echten Router (mit Datenbank). Hier steht das Fertig-Kriterium
 * von S08 (`fs.edit` auf einer zwischenzeitlich geänderten Datei) und der Beleg für
 * "Ausschnitt plus Artefakt" bei großen Dateien.
 */

const pool = createPool();
const threadIds: string[] = [];

let sourceRoot: string;
let artifactRoot: string;
let outsideRoot: string;
// biome-ignore lint/suspicious/noExplicitAny: in beforeAll gesetzt
let deps: ToolRouterDeps = undefined as any;
// biome-ignore lint/suspicious/noExplicitAny: in beforeAll gesetzt
let catalogVersion: string = undefined as any;

beforeAll(async () => {
  sourceRoot = await mkdtemp(path.join(tmpdir(), "kuronami-fs-src-"));
  artifactRoot = path.join(sourceRoot, "artifacts");
  await mkdir(artifactRoot, { recursive: true });
  outsideRoot = await mkdtemp(path.join(tmpdir(), "kuronami-fs-out-"));

  await mkdir(path.join(sourceRoot, "src"), { recursive: true });
  await writeFile(
    path.join(sourceRoot, "src", "one.ts"),
    "const x = 1;\nfunction foo() {}\nconst y = foo();\n",
  );
  await writeFile(path.join(sourceRoot, "src", "two.ts"), "// nichts Besonderes hier\n");
  await writeFile(path.join(sourceRoot, "README.md"), "# Titel\n\nEin kurzer Text.\n");

  const zones = await buildFsZones({ sourceRoot, artifactRoot });
  const catalog = new ToolRegistry()
    .registerAll(createFsTools({ pool, artifactRoot, zones }))
    .freeze();
  catalogVersion = catalog.version;
  // Die Policy-Engine mit dem ausgelieferten Regelsatz und denselben Zonen wie die Tools
  // (S11). Damit ist `fs.write`/`fs.edit` in die Quellzone hier ein `hard_write` ohne
  // Freigabe und wird geblockt — der Nachfolger der harten Verweigerung aus S08.
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
  await rm(outsideRoot, { recursive: true, force: true });
});

async function newSession(): Promise<SessionRecord> {
  const threadId = `thread_test_${randomUUID()}`;
  threadIds.push(threadId);
  const { session } = await createOrResumeSession(pool, {
    threadId,
    channel: "web",
    defaults: { toolCatalogVersion: catalogVersion },
  });
  return session;
}

function structured(result: ToolResult): Record<string, JsonValue> {
  return result.structured as Record<string, JsonValue>;
}

async function eventTypes(sessionId: string): Promise<string[]> {
  return (await readEvents(pool, sessionId)).map((event) => event.type);
}

describe("fs.* · Pfad-Traversal wird abgewiesen", () => {
  it("weist ../../etc/passwd als Fehlerhülle ab", async () => {
    const session = await newSession();
    const result = await callTool(deps, session, {
      callId: "c_trav",
      name: "fs.read",
      input: { path: "../../etc/passwd" },
    });
    expect(result.status).toBe("error");
    // Seit S11 fällt der Traversal eine Ebene früher: die Policy löst denselben Pfad auf,
    // bekommt denselben `PathEscapeError` und lehnt ab, bevor der Handler überhaupt läuft
    // (`unresolvable-resource`, fail closed). Der Wortlaut der Pfadprüfung steht unverändert
    // im Freigabepfad — geglättet wird nichts, er steht nur an einer anderen Stelle.
    expect(structured(result).reason).toBe("policy_denied");
    expect(JSON.stringify(structured(result))).toMatch(/außerhalb der erlaubten Zonen/);
    // Kein Schritt: es wird abgelehnt, bevor die Ausführungshülle anläuft.
    expect(await eventTypes(session.sessionId)).toEqual([
      "session.created",
      "tool.requested",
      "policy.denied",
      "tool.failed",
    ]);
  });

  it("weist einen Symlink nach außen ab", async () => {
    await symlink(outsideRoot, path.join(sourceRoot, "escape"), "junction");
    await writeFile(path.join(outsideRoot, "secret.txt"), "streng geheim");

    const session = await newSession();
    const result = await callTool(deps, session, {
      callId: "c_link",
      name: "fs.read",
      input: { path: "escape/secret.txt" },
    });
    expect(result.status).toBe("error");
    expect(JSON.stringify(structured(result))).toMatch(/Symlink|außerhalb/);
  });
});

describe("fs.read", () => {
  it("gibt eine kleine Datei ganz zurück, ohne Artefakt", async () => {
    const session = await newSession();
    const result = await callTool(deps, session, {
      callId: "c_read_small",
      name: "fs.read",
      input: { path: "README.md" },
    });

    expect(result.status).toBe("ok");
    expect(result.artifact_refs).toEqual([]);
    expect(structured(result).truncated).toBe(false);
    expect(structured(result).content).toBe("# Titel\n\nEin kurzer Text.\n");
    expect(structured(result).total_lines).toBe(3);
    expect(structured(result).sha256).toBe(
      createHash("sha256").update("# Titel\n\nEin kurzer Text.\n").digest("hex"),
    );
  });

  it("gibt bei einer großen Datei Ausschnitt plus Artefakt zurück", async () => {
    const session = await newSession();
    const big = `${Array.from({ length: 5000 }, (_, i) => `Zeile ${i + 1}`).join("\n")}\n`;
    await writeFile(path.join(sourceRoot, "big.log"), big);

    const result = await callTool(deps, session, {
      callId: "c_read_big",
      name: "fs.read",
      input: { path: "big.log" },
    });

    expect(result.status).toBe("ok");
    expect(structured(result).truncated).toBe(true);
    expect(structured(result).total_lines).toBe(5000);
    expect(result.artifact_refs).toHaveLength(1);
    // Der Ausschnitt bleibt im Kontext ...
    expect(String(structured(result).excerpt).split("\n")[0]).toBe("Zeile 1");
    expect(structured(result).sha256).toBeTruthy();
    // ... und der Router hat die schon knappe Hülle nicht ein zweites Mal ausgelagert.
    expect(structured(result).offloaded).toBeUndefined();

    // Das Handle löst auf die vollständige Datei auf, bytegleich.
    const stored = await readArtifact(pool, artifactRoot, String(result.artifact_refs[0]));
    expect(stored.bytes.toString("utf8")).toBe(big);
    expect(stored.source.tool).toBe("fs.read");
    expect(stored.source.sessionId).toBe(session.sessionId);

    // artifact.created steht zwischen den Checkpoints des Schritts.
    expect(await eventTypes(session.sessionId)).toEqual([
      "session.created",
      "tool.requested",
      "policy.allowed",
      "step.started",
      "artifact.created",
      "step.completed",
      "tool.completed",
    ]);
  });

  it("gibt einen ausdrücklichen Zeilenausschnitt zurück", async () => {
    const session = await newSession();
    const result = await callTool(deps, session, {
      callId: "c_read_slice",
      name: "fs.read",
      input: { path: "src/one.ts", offset: 2, limit: 1 },
    });
    expect(result.status).toBe("ok");
    expect(structured(result).excerpt).toBe("function foo() {}");
    expect(structured(result).truncated).toBe(true);
  });

  it("legt eine Binärdatei komplett ins Artefakt", async () => {
    const session = await newSession();
    const bytes = Buffer.from([1, 2, 0, 3, 255, 0, 42]);
    await writeFile(path.join(sourceRoot, "blob.bin"), bytes);

    const result = await callTool(deps, session, {
      callId: "c_read_bin",
      name: "fs.read",
      input: { path: "blob.bin" },
    });
    expect(result.status).toBe("ok");
    expect(structured(result).binary).toBe(true);
    expect(result.artifact_refs).toHaveLength(1);
    const stored = await readArtifact(pool, artifactRoot, String(result.artifact_refs[0]));
    expect(stored.bytes.equals(bytes)).toBe(true);
  });

  it("weist eine fehlende Datei als Fehlerhülle ab", async () => {
    const session = await newSession();
    const result = await callTool(deps, session, {
      callId: "c_read_missing",
      name: "fs.read",
      input: { path: "gibt-es-nicht.txt" },
    });
    expect(result.status).toBe("error");
    expect(String(structured(result).error)).toMatch(/nicht gefunden/);
  });
});

describe("fs.search", () => {
  it("liefert Treffer mit Zeilennummer, keine ganzen Dateien", async () => {
    const session = await newSession();
    const result = await callTool(deps, session, {
      callId: "c_search",
      name: "fs.search",
      input: { query: "foo", path: "src" },
    });

    expect(result.status).toBe("ok");
    expect(structured(result).matches).toEqual([
      { path: "src/one.ts", line: 2, text: "function foo() {}" },
      { path: "src/one.ts", line: 3, text: "const y = foo();" },
    ]);
    // Die nicht passende Zeile aus derselben Datei taucht nirgends auf.
    expect(JSON.stringify(structured(result))).not.toContain("const x = 1;");
  });

  it("filtert nach glob und ignoriert Groß-/Kleinschreibung", async () => {
    const session = await newSession();
    const hit = await callTool(deps, session, {
      callId: "c_search_glob",
      name: "fs.search",
      input: { query: "TITEL", path: ".", glob: "*.md", ignore_case: true },
    });
    expect((hit.structured as { matches: unknown[] }).matches).toEqual([
      { path: "README.md", line: 1, text: "# Titel" },
    ]);
  });

  it("meldet einen kaputten regulären Ausdruck als Fehlerhülle", async () => {
    const session = await newSession();
    const result = await callTool(deps, session, {
      callId: "c_search_bad",
      name: "fs.search",
      input: { query: "(" },
    });
    expect(result.status).toBe("error");
    expect(String(structured(result).error)).toMatch(/regulär/i);
  });
});

describe("fs.list", () => {
  it("listet ein Verzeichnis und markiert Symlinks, ohne sie zu verfolgen", async () => {
    await symlink(outsideRoot, path.join(sourceRoot, "src", "outlink"), "junction");
    const session = await newSession();
    const result = await callTool(deps, session, {
      callId: "c_list",
      name: "fs.list",
      input: { path: "src" },
    });

    expect(result.status).toBe("ok");
    const entries = structured(result).entries as { path: string; type: string }[];
    const byPath = new Map(entries.map((entry) => [entry.path, entry.type]));
    expect(byPath.get("src/one.ts")).toBe("file");
    expect(byPath.get("src/outlink")).toBe("symlink");
    // Nichts aus dem Symlink-Ziel ist in die Liste geraten.
    expect(entries.some((entry) => entry.path.includes("secret.txt"))).toBe(false);
  });
});

describe("fs.write · Zonen", () => {
  it("erlaubt fs.write in die Artefaktzone", async () => {
    const session = await newSession();
    const result = await callTool(deps, session, {
      callId: "c_write_ok",
      name: "fs.write",
      input: { path: "artifacts/entwurf.md", content: "# Entwurf\n" },
    });
    expect(result.status).toBe("ok");
    expect(structured(result).created).toBe(true);
    expect(await readFile(path.join(artifactRoot, "entwurf.md"), "utf8")).toBe("# Entwurf\n");

    expect(await eventTypes(session.sessionId)).toEqual([
      "session.created",
      "tool.requested",
      "policy.allowed",
      "step.started",
      "step.completed",
      "tool.completed",
    ]);
  });

  it("verweigert fs.write in die Quellzone ohne Freigabe", async () => {
    const session = await newSession();
    // Seit S11 endet dieser Aufruf nicht mehr in einer harten Verweigerung des Handlers,
    // sondern eine Ebene davor: die Regel `write-outside-artifact-zone` hebt ihn auf
    // `hard_write`, der Boden verlangt eine Freigabe, es gibt keine — der Lauf hält an.
    // Die maßgebliche Aussage ist unverändert und steht in der letzten Zeile: **es wird
    // nichts geschrieben.**
    await expect(
      callTool(deps, session, {
        callId: "c_write_denied",
        name: "fs.write",
        input: { path: "src/neu.ts", content: "// neu" },
      }),
    ).rejects.toThrow(ApprovalRequiredError);
    expect(existsSync(path.join(sourceRoot, "src", "neu.ts"))).toBe(false);
    // Kein Schritt: die Ausführungshülle ist nie angelaufen.
    expect(await eventTypes(session.sessionId)).toEqual([
      "session.created",
      "tool.requested",
      "approval.requested",
    ]);
  });

  it("führt denselben fs.write-Aufruf nur einmal aus", async () => {
    const session = await newSession();
    const call = {
      callId: "c_write_idem",
      name: "fs.write",
      input: { path: "artifacts/idem.txt", content: "eins" },
    };
    const first = await callTool(deps, session, call);
    const second = await callTool(deps, session, call);
    expect(second).toEqual(first);

    const types = await eventTypes(session.sessionId);
    expect(types.filter((type) => type === "step.started")).toHaveLength(1);
  });
});

describe("fs.edit · stale read (Fertig-Kriterium)", () => {
  it("weist fs.edit auf einer zwischenzeitlich geänderten Datei ab", async () => {
    const session = await newSession();
    const abs = path.join(artifactRoot, "notiz.txt");
    await writeFile(abs, "hallo A welt\n");

    const read = await callTool(deps, session, {
      callId: "c_edit_read",
      name: "fs.read",
      input: { path: "artifacts/notiz.txt" },
    });
    const staleSha = String(structured(read).sha256);

    // Zwischenzeitliche Änderung von außen — der Text enthält weiterhin "A".
    await writeFile(abs, "hallo A welt, veraendert\n");

    const stale = await callTool(deps, session, {
      callId: "c_edit_stale",
      name: "fs.edit",
      input: {
        path: "artifacts/notiz.txt",
        old_string: "A",
        new_string: "B",
        expected_sha256: staleSha,
      },
    });
    expect(stale.status).toBe("error");
    expect(String(structured(stale).error)).toMatch(/zwischenzeitlich geändert|SHA-256/);
    // Der Edit wurde nicht angewandt.
    expect(await readFile(abs, "utf8")).toBe("hallo A welt, veraendert\n");

    // Mit frischem SHA-256 geht derselbe Edit durch.
    const freshSha = createHash("sha256")
      .update(await readFile(abs))
      .digest("hex");
    const ok = await callTool(deps, session, {
      callId: "c_edit_fresh",
      name: "fs.edit",
      input: {
        path: "artifacts/notiz.txt",
        old_string: "A",
        new_string: "B",
        expected_sha256: freshSha,
      },
    });
    expect(ok.status).toBe("ok");
    expect(structured(ok).replacements).toBe(1);
    expect(await readFile(abs, "utf8")).toBe("hallo B welt, veraendert\n");
  });

  it("weist einen mehrdeutigen Edit ohne replace_all ab", async () => {
    const session = await newSession();
    const abs = path.join(artifactRoot, "doppelt.txt");
    await writeFile(abs, "x und x\n");
    const sha = createHash("sha256")
      .update(await readFile(abs))
      .digest("hex");

    const result = await callTool(deps, session, {
      callId: "c_edit_ambig",
      name: "fs.edit",
      input: {
        path: "artifacts/doppelt.txt",
        old_string: "x",
        new_string: "y",
        expected_sha256: sha,
      },
    });
    expect(result.status).toBe("error");
    expect(String(structured(result).error)).toMatch(/2×|replace_all/);
    expect(await readFile(abs, "utf8")).toBe("x und x\n");
  });

  it("verweigert fs.edit in der Quellzone", async () => {
    const session = await newSession();
    const sha = createHash("sha256")
      .update(await readFile(path.join(sourceRoot, "src", "two.ts")))
      .digest("hex");
    await expect(
      callTool(deps, session, {
        callId: "c_edit_src",
        name: "fs.edit",
        input: {
          path: "src/two.ts",
          old_string: "nichts",
          new_string: "etwas",
          expected_sha256: sha,
        },
      }),
    ).rejects.toThrow(ApprovalRequiredError);
    expect(await readFile(path.join(sourceRoot, "src", "two.ts"), "utf8")).toBe(
      "// nichts Besonderes hier\n",
    );
  });
});

describe("fs.* · Protokoll-Herleitung", () => {
  it("Replay ergibt denselben Zustand wie der Snapshot", async () => {
    const session = await newSession();
    await callTool(deps, session, {
      callId: "c_replay",
      name: "fs.write",
      input: { path: "artifacts/replay.txt", content: "hallo" },
    });
    const snapshot = await readSessionState(pool, session.sessionId);
    expect(await replaySession(pool, session.sessionId)).toEqual(snapshot);
  });
});
