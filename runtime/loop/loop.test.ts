import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deriveRunMetrics } from "../../context/metrics.js";
import { deriveLoopState } from "../../context/transcript.js";
import { createPolicyEngine } from "../../policy/engine.js";
import { buildFsZones, policyResolver } from "../../tools/fs/paths.js";
import { createFsTools } from "../../tools/fs/tools.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createTaskTools } from "../../tools/task/tools.js";
import type { ToolCatalog } from "../../tools/types.js";
import { createUserTools } from "../../tools/user/tools.js";
import { readArtifact } from "../artifacts/store.js";
import { createPool } from "../db/pool.js";
import { type EventRecord, readEvents } from "../events/log.js";
import type { ModelClient, ModelRequest } from "../model/types.js";
import { cancelSession } from "../session/lifecycle.js";
import { readSessionState, replaySession } from "../session/state.js";
import { readStepSnapshot } from "../session/state.js";
import { type Runner, createRunner } from "./api.js";
import { type ScriptedStep, type ScriptedTask, createScriptedModel } from "./scripted.js";

/**
 * Die Schleife gegen die echte Datenbank, den echten Router, die echte Policy und die echten
 * `fs.*`-Tools. Nur das Modell ist ein Drehbuch — es ist der einzige Teil, der Geld kostet
 * und bei jedem Lauf anders antwortet, und beides verträgt sich nicht mit einem Nachweis.
 */

const pool = createPool();
const threadIds: string[] = [];
let sourceRoot: string;
let artifactRoot: string;
let catalog: ToolCatalog;
let policy: ReturnType<typeof createPolicyEngine>;
const openRunners: Runner[] = [];

beforeAll(async () => {
  sourceRoot = await mkdtemp(path.join(tmpdir(), "kuronami-loop-"));
  artifactRoot = path.join(sourceRoot, "artifacts");
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, "AGENTS.md"), "# Konventionen\n\nKein ORM.\n");

  const zones = await buildFsZones({ sourceRoot, artifactRoot });
  catalog = new ToolRegistry()
    .registerAll(createFsTools({ pool, artifactRoot, zones }))
    .registerAll(createTaskTools({ pool }))
    .registerAll(createUserTools({ pool }))
    .freeze();
  policy = createPolicyEngine({ resolvePath: policyResolver(zones) });
});

afterAll(async () => {
  for (const runner of openRunners) await runner.stop("test-ende").catch(() => {});
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

/** Zeichnet auf, was das Modell wirklich zu sehen bekam. */
function recording(client: ModelClient): { client: ModelClient; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    client: {
      model: client.model,
      complete: async (request) => {
        requests.push(request);
        return await client.complete(request);
      },
    },
  };
}

async function newRunner(model: ModelClient, overrides: Record<string, unknown> = {}) {
  const threadId = `thread_test_${randomUUID()}`;
  threadIds.push(threadId);
  const runner = await createRunner({
    pool,
    threadId,
    channel: "web",
    artifactRoot,
    catalog,
    policy,
    model,
    conventions: "Kein ORM. Fehler nie verstecken.",
    ...overrides,
  });
  openRunners.push(runner);
  return runner;
}

/** Die 30-Schritt-Aufgabe: einen Plan setzen, 28 Dateien schreiben, eine wieder lesen. */
function thirtyStepTask(steps = 30): ScriptedTask {
  return {
    steps,
    step(index: number): ScriptedStep {
      if (index === 1) {
        return {
          toolName: "task.set",
          input: {
            tasks: [
              { id: "schreiben", title: "Dateien schreiben", status: "in_progress" },
              { id: "pruefen", title: "Ergebnis prüfen", status: "queued" },
            ],
          },
        };
      }
      if (index === steps) {
        return { toolName: "fs.read", input: { path: "artifacts/schritt-2.txt" } };
      }
      return {
        toolName: "fs.write",
        input: {
          path: `artifacts/schritt-${index}.txt`,
          content: `Inhalt von Schritt ${index}\n`,
        },
      };
    },
  };
}

function typesOf(events: EventRecord[]): string[] {
  return events.map((event) => event.type);
}

describe("Loop · Fertig-Kriterium: Aufgabe mit 30 Schritten", () => {
  it("läuft vollständig durch und hinterlässt ein lückenloses Protokoll", async () => {
    const spy = recording(createScriptedModel(thirtyStepTask()));
    const runner = await newRunner(spy.client);

    const result = await runner.run("Schreibe 28 Dateien und lies eine davon wieder.");

    expect(result.stop).toBe("done");
    expect(result.toolCalls).toBe(30);

    // Die Seiteneffekte sind wirklich passiert, nicht nur protokolliert.
    for (const index of [2, 15, 29]) {
      expect(await readFile(path.join(artifactRoot, `schritt-${index}.txt`), "utf8")).toBe(
        `Inhalt von Schritt ${index}\n`,
      );
    }

    const sessionId = runner.session.sessionId;
    const events = await readEvents(pool, sessionId);
    // Lückenlos ab 1, wie seit S03 zugesichert.
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));

    const types = typesOf(events);
    expect(types.at(0)).toBe("session.created");
    expect(types.filter((type) => type === "turn.started")).toHaveLength(1);
    expect(types.filter((type) => type === "turn.completed")).toHaveLength(1);
    expect(types.filter((type) => type === "tool.completed")).toHaveLength(30);
    expect(types.filter((type) => type === "tool.failed")).toHaveLength(0);
    // 31 Modellaufrufe: 30 mit einem Werkzeugaufruf, einer für die Schlussantwort.
    expect(types.filter((type) => type === "model.responded")).toHaveLength(31);
    expect(types.at(-1)).toBe("session.completed");

    // 29 Schritt-Tools (fs.*), `task.set` läuft als Runtime-Tool ohne Schritt (S10).
    const steps = await readStepSnapshot(pool, sessionId);
    expect(steps).toHaveLength(29);
    expect(steps.every((step) => step.status === "completed")).toBe(true);

    // Der Plan aus Schritt 1 steht.
    const status = await runner.status();
    expect(status.plan.map((task) => task.taskId)).toEqual(["schreiben", "pruefen"]);

    // Und die Herleitung ergibt denselben Zustand wie der Schnappschuss (S05-Disziplin).
    expect(await replaySession(pool, sessionId)).toEqual(await readSessionState(pool, sessionId));
    expect(spy.requests).toHaveLength(31);
  }, 60_000);

  it("hält den Tool-Katalog über den ganzen Lauf byteweise unverändert", async () => {
    const spy = recording(createScriptedModel(thirtyStepTask(8)));
    const runner = await newRunner(spy.client);
    await runner.run("Acht Schritte.");

    // Anti-Muster 2 und die Cache-Hierarchie aus Abschnitt 7: eine Änderung an den Tools
    // entwertete alles darunter. Geprüft wird nicht die Absicht, sondern die Bytes.
    const first = JSON.stringify(spy.requests[0].tools);
    for (const request of spy.requests) {
      expect(JSON.stringify(request.tools)).toBe(first);
    }
    const [systemFirst, ...rest] = spy.requests.map((request) => JSON.stringify(request.system));
    for (const entry of rest) expect(entry).toBe(systemFirst);

    // Und die Historie wächst nur hinten an (Grundprinzip 2, Append-only).
    for (let i = 1; i < spy.requests.length; i += 1) {
      const previous = spy.requests[i - 1].messages;
      const current = spy.requests[i].messages;
      expect(current.length).toBeGreaterThan(previous.length);
      expect(JSON.stringify(current.slice(0, previous.length).map((m) => m.content))).toBe(
        JSON.stringify(previous.map((m) => m.content)),
      );
    }
  }, 60_000);

  it("setzt drei Cache-Haltepunkte je Aufruf und macht die Trefferquote messbar", async () => {
    const spy = recording(createScriptedModel(thirtyStepTask(6)));
    const runner = await newRunner(spy.client);
    await runner.run("Sechs Schritte.");

    const events = await readEvents(pool, runner.session.sessionId);
    const requested = events.filter((event) => event.type === "model.requested");
    expect(requested).toHaveLength(7);
    for (const event of requested) {
      expect(event.payload.cache_breakpoints).toBe(3);
    }

    const metrics = deriveRunMetrics(events);
    expect(metrics.modelCalls).toBe(7);
    expect(metrics.cacheReadTokens).toBeGreaterThan(0);
    expect(metrics.cacheHitRate).toBeGreaterThan(0);
    expect(metrics.cacheHitRate).toBeLessThanOrEqual(1);
  }, 60_000);
});

describe("Loop · Abbruchbedingungen", () => {
  it("hält an einer Freigabestelle an, schreibt nichts und setzt nach der Antwort fort", async () => {
    // Schritt 2 schreibt in die Quellzone. Das ist hartes Schreiben und braucht nach
    // Abschnitt 10 eine Freigabe — hier ist der Haltepunkt des Fertig-Kriteriums.
    const target = path.join(sourceRoot, "freigabe.txt");
    const model = createScriptedModel({
      steps: 3,
      step(index: number) {
        if (index === 2) {
          return {
            toolName: "fs.write",
            input: { path: "freigabe.txt", content: "in der Quellzone\n" },
          };
        }
        return {
          toolName: "fs.write",
          input: { path: `artifacts/frei-${index}.txt`, content: `frei ${index}\n` },
        };
      },
    });

    const runner = await newRunner(model);
    const sessionId = runner.session.sessionId;
    const paused = await runner.run("Schreib auch in die Quellzone.");

    expect(paused.stop).toBe("awaiting_user");
    expect(paused.reason).toContain("Freigabe nötig");
    // Nichts geschrieben — die maßgebliche Zusicherung.
    await expect(readFile(target, "utf8")).rejects.toThrow();

    const state = await readSessionState(pool, sessionId);
    expect(state.status).toBe("awaiting_user");
    expect(state.pendingUserInput).toHaveLength(1);
    const ask = state.pendingUserInput[0];
    expect(ask.askId).toBe("policy:call_step_2");
    expect(ask.options.map((option) => option.id)).toEqual(["once", "session", "always", "deny"]);

    // Der Zug bleibt offen: kein `turn.completed`, damit die Antwort ihn an derselben Stelle
    // fortsetzt statt einen neuen zu beginnen.
    const beforeAnswer = typesOf(await readEvents(pool, sessionId));
    expect(beforeAnswer).not.toContain("turn.completed");
    expect(beforeAnswer).not.toContain("session.completed");
    expect(deriveLoopState(await readEvents(pool, sessionId)).turnId).not.toBeNull();

    await runner.answer(ask.askId, "once");
    const finished = await runner.run();

    expect(finished.stop).toBe("done");
    expect(finished.turnId).toBe(paused.turnId);
    expect(await readFile(target, "utf8")).toBe("in der Quellzone\n");
    expect(finished.toolCalls).toBe(3);
    expect(typesOf(await readEvents(pool, sessionId))).toContain("session.completed");
  }, 60_000);

  it("endet an der Schrittobergrenze, ohne den Zug als erledigt zu melden", async () => {
    const runner = await newRunner(createScriptedModel(thirtyStepTask(30)), { maxSteps: 5 });
    const result = await runner.run("Dreißig Schritte, aber nur fünf erlaubt.");

    expect(result.stop).toBe("step_limit");
    expect(result.toolCalls).toBe(5);
    expect(result.reason).toContain("Schrittobergrenze");

    const types = typesOf(await readEvents(pool, runner.session.sessionId));
    // Ein `turn.completed` mit Grund, aber kein `session.completed`: der Lauf ist nicht
    // fertig geworden, er wurde gestoppt.
    expect(types).toContain("turn.completed");
    expect(types).toContain("session.failed");
    expect(types).not.toContain("session.completed");
  }, 60_000);

  it("endet bei Fehlern in Folge und hält jeden Fehlschlag im Kontext sichtbar", async () => {
    // Jeder Schritt zielt aus den Zonen heraus. Die Policy lehnt ab (fail closed), der
    // Router macht daraus eine Fehlerhülle — genau die Lage, in der ein Lauf sich festfrisst.
    const spy = recording(
      createScriptedModel({
        steps: 30,
        step: () => ({
          toolName: "fs.write",
          input: { path: "../../ausserhalb.txt", content: "nein\n" },
        }),
      }),
    );
    const runner = await newRunner(spy.client, { maxConsecutiveErrors: 3 });
    const result = await runner.run("Schreib nach draußen.");

    expect(result.stop).toBe("error_rate");
    expect(result.toolCalls).toBe(3);
    expect(result.reason).toContain("Fehlerhäufung");

    // Fehler bleiben im Kontext sichtbar (Abschnitt 7): der letzte Prompt trägt jeden
    // Fehlschlag mitsamt seinem Grund, nicht eine Zusammenfassung davon.
    const last = spy.requests.at(-1);
    const results = last?.messages
      .flatMap((message) => message.content)
      .filter((block) => block.type === "tool_result");
    expect(results).toHaveLength(2);
    for (const block of results ?? []) {
      expect(block.is_error).toBe(true);
      expect(String(block.content)).toContain("policy_denied");
    }

    const metrics = deriveRunMetrics(await readEvents(pool, runner.session.sessionId));
    expect(metrics.failedToolCalls).toBe(3);
  }, 60_000);

  it("endet, wenn die Session mitten im Lauf abgebrochen wird", async () => {
    const runner = await newRunner(
      createScriptedModel({
        steps: 30,
        step: (index) => ({
          toolName: "fs.write",
          input: { path: `artifacts/abbruch-${index}.txt`, content: "x\n" },
        }),
      }),
    );
    // Der Abbruch wirkt über die Datenbank, ohne dass ein Signal jemanden erreichen muss
    // (S05): `beginStep` liest ihn in derselben Transaktion, in der der Schritt entstünde.
    await cancelSession(pool, runner.session.sessionId, "test");
    const result = await runner.run("Los.");

    expect(result.stop).toBe("canceled");
    expect(result.toolCalls).toBe(0);
    expect((await readSessionState(pool, runner.session.sessionId)).status).toBe("canceled");
  }, 60_000);
});

describe("Loop · Kontextstufen 0 und 1", () => {
  it("lagert ein großes Ergebnis aus und legt nur das Handle in den Kontext", async () => {
    // 400 KB — deutlich über der Auslagerungsschwelle von 8k Token-Äquivalent (Abschnitt 13).
    const marker = `MARKE_${randomUUID()}`;
    await writeFile(
      path.join(artifactRoot, "gross.txt"),
      `${marker}\n${"Fuellzeile fuer den Auslagerungstest.\n".repeat(11_000)}`,
    );

    const spy = recording(
      createScriptedModel({
        steps: 1,
        step: () => ({ toolName: "fs.read", input: { path: "artifacts/gross.txt" } }),
      }),
    );
    const runner = await newRunner(spy.client);
    const result = await runner.run("Lies die große Datei.");

    expect(result.stop).toBe("done");

    const events = await readEvents(pool, runner.session.sessionId);
    const state = deriveLoopState(events);
    expect(state.offloadedResults).toBe(1);
    expect(deriveRunMetrics(events).offloadShare).toBe(1);

    // Der letzte Prompt trägt das Handle und **nicht** die Bytes: Kontextstufe 1 wörtlich.
    const last = JSON.stringify(spy.requests.at(-1)?.messages);
    expect(last).toContain("artifact://");
    expect(last).toContain('truncated\\":true');
    // 418 KB auf der Platte, unter 8 KB im Kontext.
    expect(last).toContain("418043");
    expect(last.length).toBeLessThan(8_000);
    // Der Ausschnitt bleibt sichtbar (Kontextstufe 0), der Rumpf nicht: 40 Zeilen von 11001.
    expect(last).toContain(marker);
    expect(last.split("Fuellzeile").length - 1).toBeLessThan(60);

    // Gegenprobe: die vollständigen Bytes sind nicht verloren, sie liegen hinter dem Handle.
    const uri = String(events.find((event) => event.type === "artifact.created")?.payload.uri);
    expect(uri).toContain("artifact://");
    expect((await readArtifact(pool, artifactRoot, uri)).sizeBytes).toBe(418_043);
  }, 60_000);
});
