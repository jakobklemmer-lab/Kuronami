import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readArtifact } from "../runtime/artifacts/store.js";
import { createPool } from "../runtime/db/pool.js";
import { readEvents } from "../runtime/events/log.js";
import { createOrResumeSession } from "../runtime/session/manager.js";
import { readSessionState, replaySession } from "../runtime/session/state.js";
import type { SessionRecord } from "../runtime/session/types.js";
import type { JsonValue } from "../runtime/steps/types.js";
import { DEV_BLOB, DEV_ECHO } from "./dummies.js";
import { ToolRegistry } from "./registry.js";
import { ToolCatalogMismatchError, type ToolRouterDeps, callTool } from "./router.js";
import type { ToolDefinition, ToolResult } from "./types.js";

const pool = createPool();
const threadIds: string[] = [];
let root: string;

const catalog = new ToolRegistry().register(DEV_ECHO).register(DEV_BLOB).freeze();

function deps(overrides: Partial<ToolRouterDeps> = {}): ToolRouterDeps {
  return { pool, artifactRoot: root, catalog, ...overrides };
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kuronami-router-"));
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
  if (root) await rm(root, { recursive: true, force: true });
});

/** Eine Session, die denselben Tool-Katalog trägt wie der Router. */
async function newSession(version = catalog.version): Promise<SessionRecord> {
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

describe("Tool-Router · Fertig-Kriterium", () => {
  it("gibt bei 50 KB Ausgabe nur Zusammenfassung plus Handle zurück", async () => {
    const session = await newSession();

    const result = await callTool(deps(), session, {
      callId: "call_blob",
      name: "dev.blob",
      input: { size_bytes: 50 * 1024 },
    });

    expect(result.status).toBe("ok");
    expect(result.artifact_refs).toHaveLength(1);
    expect(structured(result).offloaded).toBe(true);
    expect(structured(result).uri).toBe(result.artifact_refs[0]);

    // Was tatsächlich in den Kontext ginge, ist klein — das ist der Punkt der Übung.
    expect(JSON.stringify(result).length).toBeLessThan(1_000);
    // Und es ist trotzdem aussagekräftig: Zusammenfassung und die ersten Zeilen stehen da.
    expect(result.summary).toMatch(/Zeilen/);
    expect(result.preview).toHaveLength(3);

    // Das Handle löst auf die vollständigen Bytes auf, nichts ist verloren gegangen.
    const stored = await readArtifact(pool, root, result.artifact_refs[0]);
    expect(stored.sizeBytes).toBeGreaterThan(50 * 1024);
    const parsed = JSON.parse(stored.bytes.toString("utf8")) as { rows: unknown[] };
    expect(parsed.rows.length).toBeGreaterThan(100);
    expect(stored.source).toEqual({
      tool: "dev.blob",
      sessionId: session.sessionId,
      // Die Herkunft trägt den Schritt, in dem der Aufruf lief (S06).
      stepId: expect.stringMatching(/^step_/) as unknown as string,
    });
  });

  it("gibt bei 200 Byte Ausgabe direkt zurück, ohne Artefakt", async () => {
    const session = await newSession();
    const message = "x".repeat(180);

    const result = await callTool(deps(), session, {
      callId: "call_echo",
      name: "dev.echo",
      input: { message },
    });

    expect(result.status).toBe("ok");
    expect(result.artifact_refs).toEqual([]);
    expect(structured(result).message).toBe(message);
    expect(structured(result).offloaded).toBeUndefined();

    // Kein Artefakt entstanden.
    const artifacts = await pool.query(
      "SELECT 1 FROM kuronami.artifacts WHERE (source ->> 'session_id') = $1",
      [session.sessionId],
    );
    expect(artifacts.rowCount).toBe(0);
  });

  it("entscheidet an der gemessenen Größe, nicht am Tool", async () => {
    // Dasselbe Tool, dieselbe Schwelle, nur eine größere Ausgabe: dev.echo lagert aus,
    // sobald seine Nachricht die Schwelle reißt. Ein Tool erklärt sich nicht selbst zu klein.
    const session = await newSession();

    const small = await callTool(deps(), session, {
      callId: "call_small",
      name: "dev.echo",
      input: { message: "kurz" },
    });
    const large = await callTool(deps(), session, {
      callId: "call_large",
      name: "dev.echo",
      input: { message: "y".repeat(40 * 1024) },
    });

    expect(small.artifact_refs).toEqual([]);
    expect(large.artifact_refs).toHaveLength(1);
    expect(structured(large).offloaded).toBe(true);
  });
});

describe("Tool-Router · Rückgabehülle und Ereignisse", () => {
  it("liefert immer die fünf Felder aus Abschnitt 9", async () => {
    const session = await newSession();
    const ok = await callTool(deps(), session, {
      callId: "call_shape_ok",
      name: "dev.echo",
      input: { message: "hallo" },
    });
    const failed = await callTool(deps(), session, {
      callId: "call_shape_err",
      name: "gibt.esnicht",
    });

    for (const result of [ok, failed]) {
      expect(Object.keys(result).sort()).toEqual([
        "artifact_refs",
        "preview",
        "status",
        "structured",
        "summary",
      ]);
    }
    expect(ok.status).toBe("ok");
    expect(failed.status).toBe("error");
  });

  it("umklammert den Schritt mit tool.requested und tool.completed", async () => {
    const session = await newSession();
    await callTool(deps(), session, {
      callId: "call_events",
      name: "dev.echo",
      input: { message: "hallo" },
    });

    // Die Schachtelung liest sich im Protokoll: das Tool außen, der Schritt innen.
    expect(await eventTypes(session.sessionId)).toEqual([
      "session.created",
      "tool.requested",
      "step.started",
      "step.completed",
      "tool.completed",
    ]);

    const events = await readEvents(pool, session.sessionId);
    const requested = events[1];
    expect(requested.payload).toMatchObject({
      call_id: "call_events",
      tool_name: "dev.echo",
      known: true,
      risk: "read",
      tool_catalog_version: catalog.version,
    });
    const completed = events[4];
    expect(completed.payload).toMatchObject({
      tool_name: "dev.echo",
      risk: "read",
      executed: true,
      artifact_refs: [],
    });
  });

  it("schreibt beim ausgelagerten Lauf artifact.created zwischen die Checkpoints", async () => {
    const session = await newSession();
    await callTool(deps(), session, {
      callId: "call_blob_events",
      name: "dev.blob",
      input: { size_bytes: 50 * 1024 },
    });

    expect(await eventTypes(session.sessionId)).toEqual([
      "session.created",
      "tool.requested",
      "step.started",
      // Das Artefakt gehört zu diesem Versuch: es entsteht innerhalb des Schritts.
      "artifact.created",
      "step.completed",
      "tool.completed",
    ]);
  });

  it("legt die vollständige Hülle als Ergebnis des Schritts ab", async () => {
    const session = await newSession();
    const result = await callTool(deps(), session, {
      callId: "call_result",
      name: "dev.echo",
      input: { message: "im Schritt" },
    });

    const snapshot = await readSessionState(pool, session.sessionId);
    expect(snapshot.steps).toHaveLength(1);
    expect(snapshot.steps[0].kind).toBe("tool_call");
    expect(snapshot.steps[0].toolName).toBe("dev.echo");
    expect(snapshot.steps[0].result).toEqual(result);

    // Und die Herleitung aus dem Protokoll ergibt denselben Zustand (S05, Abschnitt 6).
    expect(await replaySession(pool, session.sessionId)).toEqual(snapshot);
  });
});

describe("Tool-Router · Fehler als Ergebnis", () => {
  it("gibt einen unbekannten Toolnamen als Hülle zurück und protokolliert den Aufruf", async () => {
    const session = await newSession();

    const result = await callTool(deps(), session, { callId: "call_unknown", name: "fs.read" });

    expect(result.status).toBe("error");
    expect(result.summary).toContain("fs.read");
    expect(structured(result).reason).toBe("unknown_tool");
    // Das Modell bekommt gesagt, was es stattdessen hat — der Fehler ist ein Lernsignal
    // innerhalb derselben Session (Abschnitt 7).
    expect(structured(result).known_tools).toEqual(["dev.blob", "dev.echo"]);

    // Der Fehlgriff steht im Protokoll: Kennzahl "Tool-Auswahlgenauigkeit" (Abschnitt 12).
    expect(await eventTypes(session.sessionId)).toEqual([
      "session.created",
      "tool.requested",
      "tool.failed",
    ]);
    const events = await readEvents(pool, session.sessionId);
    expect(events[1].payload).toMatchObject({ known: false, risk: null });
    // Kein Schritt: es gab keinen Seiteneffekt, den ein Checkpoint umklammern müsste.
    expect((await readSessionState(pool, session.sessionId)).steps).toEqual([]);
  });

  it("nennt alle Schema-Verstöße auf einmal", async () => {
    const session = await newSession();

    const result = await callTool(deps(), session, {
      callId: "call_schema",
      name: "dev.echo",
      input: { nachricht: 42 as unknown as JsonValue },
    });

    expect(result.status).toBe("error");
    expect(structured(result).reason).toBe("invalid_input");
    const problems = structured(result).problems as string[];
    expect(problems).toHaveLength(2);
    expect(problems.join(" ")).toContain('Pflichtfeld "message"');
    // Unbekannte Felder werden nicht stillschweigend fallen gelassen.
    expect(problems.join(" ")).toContain('Unbekanntes Feld "nachricht"');
  });

  it("weist einen falschen Feldtyp ab", async () => {
    const session = await newSession();
    const result = await callTool(deps(), session, {
      callId: "call_type",
      name: "dev.echo",
      input: { message: 42 },
    });
    expect((structured(result).problems as string[])[0]).toBe(
      'Feld "message" ist number, erwartet wird string',
    );
  });

  it("reicht einen geworfenen Handler als Fehlerhülle durch, ohne den Text zu glätten", async () => {
    const boom: ToolDefinition = {
      name: "dev.boom",
      description: "Wirft immer.",
      risk: "read",
      repeatable: true,
      inputSchema: { fields: {} },
      handler: async () => {
        throw new Error("Der Dienst antwortet nicht");
      },
    };
    const withBoom = new ToolRegistry().register(boom).freeze();
    const session = await newSession(withBoom.version);

    const result = await callTool(deps({ catalog: withBoom }), session, {
      callId: "call_boom",
      name: "dev.boom",
    });

    expect(result.status).toBe("error");
    expect(structured(result).reason).toBe("handler_failed");
    // Wortlaut und Stacktrace bleiben erhalten (AGENTS.md).
    const text = structured(result).error as string;
    expect(text).toContain("Der Dienst antwortet nicht");
    expect(text).toContain("at Object.handler");
    expect(text).toContain("router.test.ts");

    // Der Schritt ist als fehlgeschlagen protokolliert, nicht als geglückt.
    expect(await eventTypes(session.sessionId)).toEqual([
      "session.created",
      "tool.requested",
      "step.started",
      "step.failed",
      "tool.failed",
    ]);
  });

  it("verwandelt eine Zeitüberschreitung in eine Fehlerhülle", async () => {
    const slow: ToolDefinition = {
      name: "dev.slow",
      description: "Kommt nie zurück.",
      risk: "read",
      repeatable: true,
      inputSchema: { fields: {} },
      handler: () => new Promise(() => {}),
    };
    const withSlow = new ToolRegistry().register(slow).freeze();
    const session = await newSession(withSlow.version);

    const result = await callTool(deps({ catalog: withSlow, timeoutMs: 50 }), session, {
      callId: "call_slow",
      name: "dev.slow",
    });

    expect(result.status).toBe("error");
    expect(structured(result).error).toContain("Zeitfenster");
  });

  it("gibt auch die Weigerung der Ausführungshülle als Hülle zurück", async () => {
    // Ein nicht wiederholbares Tool, dessen erster Versuch fehlgeschlagen ist: die Hülle
    // lässt keinen zweiten zu (S05). Für den Aufrufer des Routers ist das eine Antwort auf
    // seinen Aufruf, keine Ausnahme an ihm vorbei.
    let calls = 0;
    const once: ToolDefinition = {
      name: "dev.once",
      description: "Nicht wiederholbar.",
      risk: "hard_write",
      repeatable: false,
      inputSchema: { fields: {} },
      handler: async () => {
        calls += 1;
        throw new Error("erster Versuch gescheitert");
      },
    };
    const withOnce = new ToolRegistry().register(once).freeze();
    const session = await newSession(withOnce.version);
    const routerDeps = deps({ catalog: withOnce });

    const first = await callTool(routerDeps, session, { callId: "call_once", name: "dev.once" });
    expect(first.status).toBe("error");
    expect(structured(first).reason).toBe("handler_failed");

    const second = await callTool(routerDeps, session, { callId: "call_once", name: "dev.once" });
    expect(second.status).toBe("error");
    expect(structured(second).reason).toBe("step_refused");
    expect(structured(second).refused).toBe("StepNotRepeatableError");

    // Der Seiteneffekt lief genau einmal. Genau dafür ist der Schlüssel da.
    expect(calls).toBe(1);
  });
});

describe("Tool-Router · Idempotenz und eingefrorener Katalog", () => {
  it("führt denselben Aufruf nur einmal aus und gibt danach das gespeicherte Ergebnis", async () => {
    let calls = 0;
    const counting: ToolDefinition = {
      name: "dev.counter",
      description: "Zählt seine Aufrufe.",
      risk: "read",
      repeatable: true,
      inputSchema: { fields: {} },
      handler: async () => {
        calls += 1;
        return { summary: `Aufruf ${calls}`, structured: { calls } };
      },
    };
    const withCounter = new ToolRegistry().register(counting).freeze();
    const session = await newSession(withCounter.version);
    const routerDeps = deps({ catalog: withCounter });

    const first = await callTool(routerDeps, session, { callId: "call_x", name: "dev.counter" });
    const second = await callTool(routerDeps, session, { callId: "call_x", name: "dev.counter" });

    expect(calls).toBe(1);
    expect(second).toEqual(first);
    expect(structured(second).calls).toBe(1);

    // Der zweite Aufruf schreibt kein zweites step.started: es ist nichts geschehen.
    const types = await eventTypes(session.sessionId);
    expect(types.filter((type) => type === "step.started")).toHaveLength(1);
    expect(types.filter((type) => type === "tool.completed")).toHaveLength(2);

    const events = await readEvents(pool, session.sessionId);
    expect(events.at(-1)?.payload).toMatchObject({ executed: false });
  });

  it("bedient eine Session nicht mit einem anderen Katalog", async () => {
    const session = await newSession();

    // Ein Tool mehr im Katalog: neue Version, und diese Session gehört nicht mehr dazu.
    const grown = new ToolRegistry()
      .register(DEV_ECHO)
      .register(DEV_BLOB)
      .register({
        name: "dev.extra",
        description: "Kommt später dazu.",
        risk: "read",
        repeatable: true,
        inputSchema: { fields: {} },
        handler: async () => ({ summary: "extra" }),
      })
      .freeze();

    expect(grown.version).not.toBe(catalog.version);
    await expect(
      callTool(deps({ catalog: grown }), session, {
        callId: "call_frozen",
        name: "dev.echo",
        input: { message: "hallo" },
      }),
    ).rejects.toThrow(ToolCatalogMismatchError);

    // Nichts ist geschehen: kein Ereignis, kein Schritt. Die Weigerung liegt vor dem Tor.
    expect(await eventTypes(session.sessionId)).toEqual(["session.created"]);
  });

  it("weist eine Session ab, die noch die Vorgabeversion trägt", async () => {
    // `createOrResumeSession` vergibt ohne Angabe "v1" (S04). Ein Prozess mit echtem Katalog
    // darf sie nicht bedienen — sonst hinge das Einfrieren an einer Zeichenkette, die nie
    // jemand fortschreibt.
    const session = await newSession("v1");
    await expect(
      callTool(deps(), session, { callId: "call_v1", name: "dev.echo", input: { message: "x" } }),
    ).rejects.toThrow(/v1/);
  });
});
