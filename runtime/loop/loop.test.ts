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
import { type MemoryStore, buildMemoryRoot, createMemoryStore } from "../../tools/memory/store.js";
import { createMemoryTools } from "../../tools/memory/tools.js";
import { ToolRegistry } from "../../tools/registry.js";
import { loadSkillCatalog } from "../../tools/skill/catalog.js";
import { createSkillTools } from "../../tools/skill/tools.js";
import { createTaskTools } from "../../tools/task/tools.js";
import { createToolIntrospectionTools } from "../../tools/tool/tools.js";
import type { ToolCatalog } from "../../tools/types.js";
import { createUserTools } from "../../tools/user/tools.js";
import { readArtifact } from "../artifacts/store.js";
import { createPool } from "../db/pool.js";
import { type EventRecord, readEvents } from "../events/log.js";
import type { ModelClient, ModelContentBlock, ModelRequest } from "../model/types.js";
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
let memoryStore: MemoryStore;
const openRunners: Runner[] = [];

beforeAll(async () => {
  sourceRoot = await mkdtemp(path.join(tmpdir(), "kuronami-loop-"));
  artifactRoot = path.join(sourceRoot, "artifacts");
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, "AGENTS.md"), "# Konventionen\n\nKein ORM.\n");

  const zones = await buildFsZones({ sourceRoot, artifactRoot });
  const memoryRoot = await buildMemoryRoot(path.join(sourceRoot, "memory"));
  memoryStore = await createMemoryStore({ root: memoryRoot, indexFile: ":memory:", git: false });

  const prelim = new ToolRegistry()
    .registerAll(createFsTools({ pool, artifactRoot, zones }))
    .registerAll(createTaskTools({ pool }))
    .registerAll(createUserTools({ pool }))
    .registerAll(createMemoryTools({ store: memoryStore, pool }))
    .freeze();
  // `tool.load` (S18b) braucht denselben Zweischritt wie in `runtime/loop/api.ts`: erst der
  // übrige Katalog, dann `tool.load` darüber, damit es Namen darin nachschlagen kann und
  // trotzdem Teil des endgültigen, versionierten Katalogs ist.
  catalog = new ToolRegistry()
    .registerAll(prelim.tools)
    .registerAll(createToolIntrospectionTools({ catalog: prelim }))
    .freeze();
  policy = createPolicyEngine({ resolvePath: policyResolver(zones) });
});

afterAll(async () => {
  for (const runner of openRunners) await runner.stop("test-ende").catch(() => {});
  memoryStore?.close();
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

/**
 * Ein Modell, das dieselbe Datei wiederholt liest, bis `totalSteps` erreicht ist. Zählt seinen
 * Fortschritt in einem eigenen Zähler und **nicht** an der (möglicherweise kompaktierten)
 * gesendeten Historie — anders als `createScriptedModel` (das an Ergebnisblöcken in der
 * Historie zählt, siehe `scripted.ts`), das genau deshalb hier nicht passt: Stufe 3 nimmt
 * `tool_result`-Blöcke aus der gesendeten Historie heraus, und ein Drehbuch, das daraus seinen
 * nächsten Schritt herleitet, verwechselte "vom Modell noch nicht gesehen" mit "kompaktiert".
 * Für den hier geführten Nachweis reicht das: es geht um Kompaktierung innerhalb eines
 * Prozesses, nicht um den Absturz- und Wiederaufnahme-Nachweis von S12 (dafür bleibt
 * `createScriptedModel` der richtige Baustein).
 */
function manyReadsModel(
  totalSteps: number,
  filePath: string,
  model = "modell-viele-leseläufe",
): ModelClient {
  let done = 0;
  let first = true;
  return {
    model,
    async complete(request: ModelRequest) {
      const prefix =
        request.system.reduce((sum, block) => sum + block.text.length, 0) +
        request.tools.reduce((sum, tool) => sum + JSON.stringify(tool).length, 0);
      const prefixTokens = Math.ceil(prefix / 4);
      const usage = {
        inputTokens: Math.ceil(JSON.stringify(request.messages).length / 4),
        outputTokens: 30,
        cacheReadTokens: first ? 0 : prefixTokens,
        cacheCreationTokens: first ? prefixTokens : 0,
      };
      first = false;

      if (done >= totalSteps) {
        const text = `Fertig nach ${done} Leseläufen.`;
        return {
          model,
          stopReason: "end_turn",
          text,
          toolCalls: [],
          usage,
          content: [{ type: "text", text }],
        };
      }

      done += 1;
      const callId = `call_read_${done}`;
      const text = `Leselauf ${done}.`;
      const toolUse: ModelContentBlock = {
        type: "tool_use",
        id: callId,
        name: "fs__read",
        input: { path: filePath },
      };
      return {
        model,
        stopReason: "tool_use",
        text,
        toolCalls: [{ callId, name: "fs__read", input: { path: filePath } }],
        usage,
        content: [{ type: "text", text }, toolUse],
      };
    },
  };
}

/** Ein günstiges Modell für Stufe 3: antwortet immer mit derselben festen Zusammenfassung. */
function fixedSummaryModel(model = "modell-guenstig-kompaktierung"): ModelClient {
  return {
    model,
    async complete() {
      const text = [
        "ZIEL: die Datei viele Male lesen.",
        "STAND: mehrere Leseläufe abgeschlossen.",
        "OFFENE_AUFGABEN: weitere Leseläufe.",
        "ENTSCHEIDUNGEN: keine.",
        "ARTEFAKT_REFS: keine.",
        "NAECHSTER_SCHRITT: weiterlesen.",
      ].join("\n");
      return {
        model,
        stopReason: "end_turn",
        text,
        toolCalls: [],
        usage: { inputTokens: 60, outputTokens: 30, cacheReadTokens: 0, cacheCreationTokens: 0 },
        content: [{ type: "text", text }],
      };
    },
  };
}

describe("Loop · Kontextstufen 2 und 3", () => {
  it("hält einen Lauf mit 110 Schritten unter dem konfigurierten Kontextlimit, kompaktiert automatisch nachweisbar und macht die Cache-Trefferquote pro Lauf lesbar", async () => {
    const totalSteps = 110;
    await writeFile(
      path.join(artifactRoot, "blob-kompaktierung.txt"),
      "Fuellinhalt fuer die Kompaktierung. ".repeat(40),
    );

    // Klein und konfigurierbar (Auftrag S18a): mit den Startwerten aus Abschnitt 13 bräuchte
    // dieser Nachweis eine Historie von hunderttausenden Zeichen. Das Fenster hier ist
    // dieselbe Stellgröße, nur auf einen Wert gesetzt, der die Schwelle mit 110 kleinen
    // Leseläufen überschreitet statt erst mit zehntausend.
    const compactionConfig = {
      contextWindowTokens: 5_000,
      reservedContextShare: 0.2,
      stage2UtilizationThreshold: 0.85,
      stage2MinBlockBytes: 300,
      protectedTailMessages: 8,
      stage3MinMessages: 6,
    };
    const usableWindowBytes =
      compactionConfig.contextWindowTokens * (1 - compactionConfig.reservedContextShare) * 4;

    const spy = recording(manyReadsModel(totalSteps, "artifacts/blob-kompaktierung.txt"));
    const runner = await newRunner(spy.client, {
      maxSteps: totalSteps + 5,
      // Das günstige Modell aus Stufe 3 (Auftrag S18a) läuft getrennt vom Drehbuch-Modell
      // oben — sonst zählte `manyReadsModel` auch die Kompaktierungsanfrage als Leselauf.
      compactionModel: fixedSummaryModel(),
      compactionConfig,
    });

    const result = await runner.run("Lies dieselbe Datei 110 Mal.");
    expect(result.stop).toBe("done");
    expect(result.toolCalls).toBe(totalSteps);

    // Kein an das Modell gesendeter Prompt überschreitet das konfigurierte Fenster — die
    // Kompaktierung greift **vor** dem Senden, nicht als Aufräumarbeit danach.
    for (const request of spy.requests) {
      expect(JSON.stringify(request.messages).length).toBeLessThan(usableWindowBytes);
    }

    const events = await readEvents(pool, runner.session.sessionId);
    const stage2 = events.filter(
      (event) => event.type === "context.compacted" && event.payload.stage === 2,
    );
    const stage3 = events.filter(
      (event) => event.type === "context.compacted" && event.payload.stage === 3,
    );
    // "Kompaktierung greift automatisch nachweisbar" (Auftrag S18a) — beide Stufen, nicht
    // nur eine: 110 kleine, aber über der Referenzschwelle liegende Ergebnisse überfordern
    // Stufe 2 allein nicht lange, aber die schiere Zahl der Runden schon.
    expect(stage2.length).toBeGreaterThan(0);
    expect(stage3.length).toBeGreaterThan(0);

    // Der Rohverlauf bleibt als Artefakt abrufbar (Auftrag S18a) — für beide Stufen.
    const stage2Uri = (stage2[0]?.payload.rewritten as { artifact_uri: string }[])[0]?.artifact_uri;
    expect((await readArtifact(pool, artifactRoot, stage2Uri as string)).sizeBytes).toBeGreaterThan(
      0,
    );
    const stage3Uri = stage3[0]?.payload.raw_artifact_uri as string;
    expect((await readArtifact(pool, artifactRoot, stage3Uri)).sizeBytes).toBeGreaterThan(0);

    // Der Zusammenfassungs-Aufruf selbst steht als eigener Schritt im Protokoll, damit er in
    // der Kostenrechnung sichtbar ist (Auftrag S18a) — nicht nur sein Ergebnis.
    const compactionCalls = events.filter(
      (event) => event.type === "model.responded" && event.payload.purpose === "compaction",
    );
    expect(compactionCalls.length).toBe(stage3.length);

    // Die Cache-Trefferquote ist pro Lauf auslesbar (Auftrag S18a) — im Ereignis, das den Zug
    // abschließt, nicht nur über eine nachträgliche Faltung.
    const finished = events.find(
      (event) => event.type === "turn.completed" && event.payload.turn_id === result.turnId,
    );
    expect(typeof finished?.payload.cache_hit_rate).toBe("number");
    expect(finished?.payload.cache_hit_rate as number).toBeGreaterThan(0);
    expect(finished?.payload.cache_hit_rate as number).toBeLessThanOrEqual(1);
    expect(finished?.payload.context_compactions).toBe(stage2.length + stage3.length);
    expect(finished?.payload.cache_hit_rate).toBe(deriveRunMetrics(events).cacheHitRate);
  }, 60_000);
});

const FIXED_USAGE = {
  inputTokens: 20,
  outputTokens: 10,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

/** Antwortet immer ohne Werkzeugaufruf — für Züge, die nur "irgendetwas" antworten müssen. */
function plainTextModel(text = "Verstanden.", model = "modell-text-schlicht"): ModelClient {
  return {
    model,
    async complete() {
      return {
        model,
        stopReason: "end_turn",
        text,
        toolCalls: [],
        usage: FIXED_USAGE,
        content: [{ type: "text", text }],
      };
    },
  };
}

/** Setzt beim ersten Aufruf einen Plan mit einer sofort fertigen Aufgabe, danach nur noch Text. */
function taskDoneOnceModel(taskId: string, model = "modell-aufgabe-fertig"): ModelClient {
  let called = false;
  return {
    model,
    async complete() {
      if (!called) {
        called = true;
        const callId = "call_task_done";
        const input = { tasks: [{ id: taskId, title: "Testaufgabe", status: "done" }] };
        const toolUse: ModelContentBlock = {
          type: "tool_use",
          id: callId,
          name: "task__set",
          input,
        };
        const text = "Schließe die Aufgabe ab.";
        return {
          model,
          stopReason: "tool_use",
          text,
          toolCalls: [{ callId, name: "task__set", input }],
          usage: FIXED_USAGE,
          content: [{ type: "text", text }, toolUse],
        };
      }
      const text = "Erledigt.";
      return {
        model,
        stopReason: "end_turn",
        text,
        toolCalls: [],
        usage: FIXED_USAGE,
        content: [{ type: "text", text }],
      };
    },
  };
}

function firstUserText(request: ModelRequest): string {
  for (const message of request.messages) {
    if (message.role !== "user") continue;
    for (const block of message.content) {
      if (block.type === "text" && typeof block.text === "string") return block.text;
    }
  }
  return "";
}

/**
 * Beantwortet normale Züge mit knappem Text, die Zusammenfassungsanfrage des Langzeitgedächtnisses
 * (`tools/memory/summary.ts`, erkennbar an ihrer festen Eröffnungszeile) mit einer echten Notiz.
 * Die Übergabe eines frischen Abschnitts (S18b) fällt in denselben "sonst"-Zweig wie ein
 * normaler Zug — ihr Text wird in diesem Nachweis nicht geprüft.
 */
function memoryRoundTripModel(model = "modell-gedaechtnis-uebergang"): ModelClient {
  return {
    model,
    async complete(request) {
      const text = firstUserText(request).startsWith("Der Lauf ist zu Ende")
        ? [
            "TITEL: Lieblingscafé ist die Kornblume",
            "TAGS: café, vorlieben",
            "---",
            'Der Nutzer hat als Lieblingscafé "Kornblume" genannt.',
          ].join("\n")
        : "Notiert.";
      return {
        model,
        stopReason: "end_turn",
        text,
        toolCalls: [],
        usage: FIXED_USAGE,
        content: [{ type: "text", text }],
      };
    },
  };
}

describe("Loop · Kontextstufe 4 (frischer Abschnitt)", () => {
  it("beginnt einen frischen Abschnitt nach einer Ruhepause und entfernt das alte Thema aus der Anfrage", async () => {
    const spy = recording(plainTextModel());
    const runner = await newRunner(spy.client, {
      sectionConfig: { idleMs: 5, maxConsecutiveStage3: 1_000 },
    });

    await runner.run("Erstes Thema: Kaffeebohnen aus Äthiopien.");
    await new Promise((resolve) => setTimeout(resolve, 30));
    await runner.run("Zweites Thema: Fahrradreifen wechseln.");

    const events = await readEvents(pool, runner.session.sessionId);
    const sections = events.filter((event) => event.type === "context.section_started");
    expect(sections).toHaveLength(1);
    expect(sections[0]?.payload.reason).toBe("idle");
    expect(typeof sections[0]?.payload.idle_ms).toBe("number");

    const rawUri = sections[0]?.payload.raw_artifact_uri as string;
    expect((await readArtifact(pool, artifactRoot, rawUri)).bytes.toString("utf8")).toContain(
      "Kaffeebohnen",
    );

    // Ein dritter Zug schickt das alte Thema nicht mehr mit — es steht nur noch im Artefakt.
    await runner.run("Drittes Thema: noch etwas ganz anderes.");
    const lastRequest = spy.requests.at(-1);
    expect(JSON.stringify(lastRequest?.messages)).not.toContain("Kaffeebohnen");
  });

  it("beginnt einen frischen Abschnitt, wenn eine Aufgabe abgeschlossen wurde", async () => {
    const runner = await newRunner(taskDoneOnceModel("meine_aufgabe"), {
      sectionConfig: { idleMs: 60 * 60 * 1000, maxConsecutiveStage3: 1_000 },
    });

    await runner.run("Bitte die Aufgabe meine_aufgabe abschließen.");
    await runner.run("Ganz anderes Thema, ohne Bezug zur Aufgabe.");

    const events = await readEvents(pool, runner.session.sessionId);
    const sections = events.filter((event) => event.type === "context.section_started");
    expect(sections).toHaveLength(1);
    expect(sections[0]?.payload.reason).toBe("task_completed");
    expect(sections[0]?.payload.completed_task_id).toBe("meine_aufgabe");
  });

  it("beginnt einen frischen Abschnitt nach genug Stufe-3-Kompaktierungen, wenn weder Ruhepause noch Aufgabenabschluss eintreten", async () => {
    const totalSteps = 40;
    await writeFile(
      path.join(artifactRoot, "blob-abschnitt.txt"),
      "Fuellinhalt fuer den Abschnittswechsel. ".repeat(40),
    );
    const compactionConfig = {
      contextWindowTokens: 5_000,
      reservedContextShare: 0.2,
      stage2UtilizationThreshold: 0.85,
      stage2MinBlockBytes: 300,
      protectedTailMessages: 8,
      stage3MinMessages: 6,
    };

    const runner = await newRunner(manyReadsModel(totalSteps, "artifacts/blob-abschnitt.txt"), {
      maxSteps: totalSteps + 5,
      compactionModel: fixedSummaryModel(),
      compactionConfig,
      // Kein Weg über Ruhepause oder Aufgabenabschluss — nur der Fallback darf hier greifen.
      sectionConfig: { idleMs: 60 * 60 * 1000, maxConsecutiveStage3: 2 },
    });

    const result = await runner.run(`Lies dieselbe Datei ${totalSteps} Mal.`);
    expect(result.stop).toBe("done");

    const eventsAfterFirstTurn = await readEvents(pool, runner.session.sessionId);
    const stage3Count = eventsAfterFirstTurn.filter(
      (event) => event.type === "context.compacted" && event.payload.stage === 3,
    ).length;
    expect(stage3Count).toBeGreaterThanOrEqual(2);
    // Kein frischer Abschnitt mitten im langen Zug — er wird erst beim nächsten Zugbeginn
    // wirksam (siehe `context/section.ts`).
    expect(
      eventsAfterFirstTurn.filter((event) => event.type === "context.section_started"),
    ).toHaveLength(0);

    await runner.run("Kurze Folgefrage, ohne Ruhepause und ohne neue Aufgabe.");
    const events = await readEvents(pool, runner.session.sessionId);
    const sections = events.filter((event) => event.type === "context.section_started");
    expect(sections).toHaveLength(1);
    expect(sections[0]?.payload.reason).toBe("stage3_fallback");
    expect(sections[0]?.payload.stage3_streak).toBe(stage3Count);
  }, 60_000);

  it("schreibt eine Gedächtnisnotiz unabhängig von completeOnDone und findet sie über einen frischen Abschnitt hinweg wieder", async () => {
    const threadId = `thread_test_${randomUUID()}`;
    threadIds.push(threadId);
    const runner = await createRunner({
      pool,
      threadId,
      channel: "web",
      artifactRoot,
      catalog,
      policy,
      model: memoryRoundTripModel(),
      conventions: "Kein ORM. Fehler nie verstecken.",
      memory: memoryStore,
      // Wie das Gateway (S16): ein fertiger Zug ist kein fertiger Auftrag, die Unterhaltung
      // geht weiter. `summarizeToMemory` steht trotzdem unabhängig davon an (S18b) — das ist
      // der eigentliche Nachweis dieses Tests.
      completeOnDone: false,
      summarizeToMemory: true,
      sectionConfig: { idleMs: 5, maxConsecutiveStage3: 1_000 },
    });
    openRunners.push(runner);

    const first = await runner.run("Mein Lieblingscafé heißt Kornblume.");
    expect(first.stop).toBe("done");

    const afterFirst = await readEvents(pool, runner.session.sessionId);
    expect(afterFirst.some((event) => event.type === "memory.skipped")).toBe(false);
    // Kein `session.completed` — genau die Falschaussage, die `completeOnDone: false` vermeidet.
    expect(afterFirst.some((event) => event.type === "session.completed")).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = await runner.run("Ganz anderes Thema: Fahrradreifen wechseln.");
    expect(second.stop).toBe("done");

    const afterSecond = await readEvents(pool, runner.session.sessionId);
    expect(afterSecond.some((event) => event.type === "context.section_started")).toBe(true);

    const third = await runner.run("Wie hieß noch mein Lieblingscafé?");
    expect(third.stop).toBe("done");

    const afterThird = await readEvents(pool, runner.session.sessionId);
    const recalledForThird = afterThird.filter((event) => event.type === "memory.recalled").at(-1);
    expect((recalledForThird?.payload.found as number) ?? 0).toBeGreaterThan(0);
    const notes = recalledForThird?.payload.notes as { title: string }[];
    expect(notes.some((note) => note.title.includes("Kornblume"))).toBe(true);
  });
});

describe("Loop · Verzögertes Tool-Laden", () => {
  it("macht ein deferred-Tool erst nach tool.load nativ aufrufbar", async () => {
    const prelim = new ToolRegistry()
      .registerAll(createTaskTools({ pool }))
      .register({
        name: "mail.search",
        description: "Durchsucht das Postfach (Testdouble für S18b).",
        risk: "read",
        repeatable: true,
        deferred: true,
        inputSchema: {
          fields: {
            query: { type: "string", required: false, description: "Suchbegriff." },
          },
        },
        handler: async () => ({ summary: "0 Treffer", structured: { matches: [] } }),
      })
      .freeze();
    const testCatalog = new ToolRegistry()
      .registerAll(prelim.tools)
      .registerAll(createToolIntrospectionTools({ catalog: prelim }))
      .freeze();

    let step = 0;
    const model: ModelClient = {
      model: "modell-tool-load",
      async complete() {
        step += 1;
        if (step === 1) {
          const callId = "call_load";
          const input = { names: ["mail.search"] };
          const toolUse: ModelContentBlock = {
            type: "tool_use",
            id: callId,
            name: "tool__load",
            input,
          };
          const text = "Lade mail.search.";
          return {
            model: "modell-tool-load",
            stopReason: "tool_use",
            text,
            toolCalls: [{ callId, name: "tool__load", input }],
            usage: FIXED_USAGE,
            content: [{ type: "text", text }, toolUse],
          };
        }
        if (step === 2) {
          const callId = "call_mail";
          const input = { query: "irrelevant" };
          const toolUse: ModelContentBlock = {
            type: "tool_use",
            id: callId,
            name: "mail__search",
            input,
          };
          const text = "Suche jetzt.";
          return {
            model: "modell-tool-load",
            stopReason: "tool_use",
            text,
            toolCalls: [{ callId, name: "mail__search", input }],
            usage: FIXED_USAGE,
            content: [{ type: "text", text }, toolUse],
          };
        }
        const text = "Fertig.";
        return {
          model: "modell-tool-load",
          stopReason: "end_turn",
          text,
          toolCalls: [],
          usage: FIXED_USAGE,
          content: [{ type: "text", text }],
        };
      },
    };

    const spy = recording(model);
    const threadId = `thread_test_${randomUUID()}`;
    threadIds.push(threadId);
    const runner = await createRunner({
      pool,
      threadId,
      channel: "web",
      artifactRoot,
      catalog: testCatalog,
      policy,
      model: spy.client,
      conventions: "Kein ORM. Fehler nie verstecken.",
    });
    openRunners.push(runner);

    const result = await runner.run("Bitte im Postfach suchen.");
    expect(result.stop).toBe("done");
    expect(spy.requests).toHaveLength(3);

    expect(spy.requests[0]?.tools.some((entry) => entry.name === "mail__search")).toBe(false);
    expect(JSON.stringify(spy.requests[0]?.system)).toContain("mail.search");

    // Nach tool.load steht das volle Schema in der zweiten Anfrage — ohne dass der Katalog
    // selbst sich geändert hätte (derselbe `testCatalog`, dieselbe Version die ganze Zeit).
    const loadedSpec = spy.requests[1]?.tools.find((entry) => entry.name === "mail__search");
    expect(loadedSpec).toBeDefined();
    expect(loadedSpec?.inputSchema.properties.query).toBeDefined();

    const events = await readEvents(pool, runner.session.sessionId);
    const mailCompleted = events.find(
      (event) => event.type === "tool.completed" && event.payload.tool_name === "mail.search",
    );
    expect(mailCompleted).toBeDefined();
  });
});

describe("Loop · Skill-System (S18c)", () => {
  it("hält den Prompt-Präfix klein und lädt einen Skill erst bei Bedarf vollständig", async () => {
    const skillsRoot = await mkdtemp(path.join(tmpdir(), "kuronami-loop-skills-"));
    try {
      // Zehn Dummy-Skills, wie im Sessionauftrag verlangt.
      for (let i = 1; i <= 10; i += 1) {
        const name = `dummy-${String(i).padStart(2, "0")}`;
        const dir = path.join(skillsRoot, name);
        await mkdir(dir, { recursive: true });
        await writeFile(
          path.join(dir, "SKILL.md"),
          [
            "---",
            `titel: Dummy-Skill ${i}`,
            `beschreibung: Testfähigkeit Nummer ${i}.`,
            `wann: Wenn Dummy-Skill ${i} gebraucht wird.`,
            "---",
            "",
            `Vollständige Anleitung für Dummy-Skill ${i}. MARKER-${i} steht erst nach skill.load im Kontext.`,
            "",
          ].join("\n"),
          "utf8",
        );
      }
      const skillCatalog = await loadSkillCatalog(skillsRoot);

      const prelim = new ToolRegistry().registerAll(createTaskTools({ pool })).freeze();
      const testCatalog = new ToolRegistry()
        .registerAll(prelim.tools)
        .registerAll(createToolIntrospectionTools({ catalog: prelim }))
        .registerAll(createSkillTools({ catalog: skillCatalog, pool }))
        .freeze();

      let step = 0;
      const model: ModelClient = {
        model: "modell-skill-load",
        async complete() {
          step += 1;
          if (step === 1) {
            const callId = "call_skill_load";
            const input = { names: ["dummy-05"] };
            const toolUse: ModelContentBlock = {
              type: "tool_use",
              id: callId,
              name: "skill__load",
              input,
            };
            const text = "Lade Dummy-Skill 5, um seiner Anleitung zu folgen.";
            return {
              model: "modell-skill-load",
              stopReason: "tool_use",
              text,
              toolCalls: [{ callId, name: "skill__load", input }],
              usage: FIXED_USAGE,
              content: [{ type: "text", text }, toolUse],
            };
          }
          const text = "Anleitung gelesen und angewendet.";
          return {
            model: "modell-skill-load",
            stopReason: "end_turn",
            text,
            toolCalls: [],
            usage: FIXED_USAGE,
            content: [{ type: "text", text }],
          };
        },
      };

      const spy = recording(model);
      const threadId = `thread_test_${randomUUID()}`;
      threadIds.push(threadId);
      const runner = await createRunner({
        pool,
        threadId,
        channel: "web",
        artifactRoot,
        catalog: testCatalog,
        policy,
        model: spy.client,
        conventions: "Kein ORM. Fehler nie verstecken.",
        skills: skillCatalog,
      });
      openRunners.push(runner);

      const result = await runner.run("Bitte Dummy-Skill 5 anwenden.");
      expect(result.stop).toBe("done");
      expect(spy.requests).toHaveLength(2);

      // Der Prompt-Präfix bleibt klein: die erste Anfrage trägt nur die Kurzliste (Titel,
      // Beschreibung, Auslösebedingung) für alle zehn Skills — nicht ihre volle Anleitung.
      const firstSystemText = JSON.stringify(spy.requests[0]?.system);
      expect(firstSystemText).toContain("dummy-05");
      expect(firstSystemText).toContain("Testfähigkeit Nummer 5.");
      for (let i = 1; i <= 10; i += 1) expect(firstSystemText).not.toContain(`MARKER-${i}`);
      expect(firstSystemText.length).toBeLessThan(5000);

      // Nach skill.load steht die vollständige Anleitung im Verlauf der zweiten Anfrage — das
      // Modell hat sie "genutzt": seine Endantwort kommt erst, nachdem der Inhalt im Kontext lag.
      const secondMessages = JSON.stringify(spy.requests[1]?.messages);
      expect(secondMessages).toContain("MARKER-5");

      const events = await readEvents(pool, runner.session.sessionId);
      const invoked = events.find((event) => event.type === "skill.invoked");
      expect(invoked?.payload.names).toEqual(["dummy-05"]);
    } finally {
      await rm(skillsRoot, { recursive: true, force: true });
    }
  });
});

/**
 * Ein Modell, das zwei Rollen spielt: Klassifikator (Aufruf ohne Werkzeuge, wie `routeTask`
 * ihn schickt, `runtime/model/router.ts`) und, falls der Router es als Laufmodell wählt,
 * gewöhnliches Loop-Modell, das sofort ohne Werkzeugaufruf fertig antwortet. Die Unterscheidung
 * läuft über `request.tools.length`, nicht über einen Aufrufzähler — dieselbe Begründung wie
 * bei `scripted.ts`: eine reine Funktion der Anfrage, nichts, das ein Neustart verwirren könnte.
 */
function classifyingModel(name: string, classificationText: string): ModelClient {
  return {
    model: name,
    async complete(request) {
      const text = request.tools.length === 0 ? classificationText : "Fertig.";
      return {
        model: name,
        stopReason: "end_turn",
        text,
        toolCalls: [],
        usage: FIXED_USAGE,
        content: [{ type: "text", text }],
      };
    },
  };
}

describe("Loop · Modell-Routing (S18e)", () => {
  it("eine Routineaufgabe läuft nachweisbar mit dem günstigen Modell", async () => {
    const routineModel = classifyingModel(
      "routine-modell-test",
      "ROUTINE: kurzer Status-Ping ohne Planung",
    );
    const thinkingModel = plainTextModel("Nie benutzt.", "denk-modell-test");

    const threadId = `thread_test_${randomUUID()}`;
    threadIds.push(threadId);
    const runner = await createRunner({
      pool,
      threadId,
      channel: "web",
      artifactRoot,
      catalog,
      policy,
      conventions: "Kein ORM. Fehler nie verstecken.",
      router: { routineModel, thinkingModel, classifyInput: "Wie ist der Serverstatus?" },
    });
    openRunners.push(runner);

    const result = await runner.run("Wie ist der Serverstatus?");
    expect(result.stop).toBe("done");

    const events = await readEvents(pool, runner.session.sessionId);
    const routed = events.find((event) => event.type === "model.routed");
    expect(routed?.payload).toMatchObject({
      task_class: "routine",
      chosen_model: "routine-modell-test",
      classifier_model: "routine-modell-test",
    });
    // Vor dem eigentlichen Lauf: kein `turn.started` steht vor `model.routed`.
    expect(events.findIndex((event) => event.type === "model.routed")).toBeLessThan(
      events.findIndex((event) => event.type === "turn.started"),
    );

    const requested = events.find((event) => event.type === "model.requested");
    expect(requested?.payload.model).toBe("routine-modell-test");
  });

  it("eine Planungsaufgabe läuft nachweisbar mit dem starken Modell", async () => {
    const routineModel = classifyingModel(
      "routine-modell-test-2",
      "THINKING: mehrstufiger Plan mit Abwägung nötig",
    );
    const thinkingModel = plainTextModel("Plan entworfen.", "denk-modell-test-2");

    const threadId = `thread_test_${randomUUID()}`;
    threadIds.push(threadId);
    const input = "Entwirf einen Migrationsplan für die nächsten drei Sessions.";
    const runner = await createRunner({
      pool,
      threadId,
      channel: "web",
      artifactRoot,
      catalog,
      policy,
      conventions: "Kein ORM. Fehler nie verstecken.",
      router: { routineModel, thinkingModel, classifyInput: input },
    });
    openRunners.push(runner);

    const result = await runner.run(input);
    expect(result.stop).toBe("done");

    const events = await readEvents(pool, runner.session.sessionId);
    const routed = events.find((event) => event.type === "model.routed");
    expect(routed?.payload).toMatchObject({
      task_class: "thinking",
      chosen_model: "denk-modell-test-2",
      classifier_model: "routine-modell-test-2",
    });

    const requested = events.find((event) => event.type === "model.requested");
    expect(requested?.payload.model).toBe("denk-modell-test-2");
  });

  it("routet nicht ein zweites Mal in derselben Session (Abschnitt 7)", async () => {
    const routineModel = classifyingModel("routine-modell-test-3", "ROUTINE: erster Zug");
    const thinkingModel = plainTextModel("Nie benutzt.", "denk-modell-test-3");

    const threadId = `thread_test_${randomUUID()}`;
    threadIds.push(threadId);
    const runner = await createRunner({
      pool,
      threadId,
      channel: "web",
      artifactRoot,
      catalog,
      policy,
      conventions: "Kein ORM. Fehler nie verstecken.",
      completeOnDone: false,
      router: { routineModel, thinkingModel, classifyInput: "erster Zug" },
    });
    openRunners.push(runner);

    await runner.run("erster Zug");
    // Ein zweiter Zug in derselben Session — auch wenn der Klassifikator (bekäme er die neue
    // Eingabe zu sehen) etwas anderes ergäbe, greift die Klassifikation nur bei der Neuanlage.
    await runner.run("zweiter Zug, ganz anderer Inhalt");

    const events = await readEvents(pool, runner.session.sessionId);
    const routedEvents = events.filter((event) => event.type === "model.routed");
    expect(routedEvents).toHaveLength(1);

    const requestedModels = events
      .filter((event) => event.type === "model.requested")
      .map((event) => event.payload.model);
    expect(requestedModels.every((model) => model === "routine-modell-test-3")).toBe(true);
  });
});
