import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPolicyEngine } from "../../policy/engine.js";
import { createPool } from "../../runtime/db/pool.js";
import { readEvents } from "../../runtime/events/log.js";
import { createRunner } from "../../runtime/loop/api.js";
import { buildFsZones, policyResolver } from "../../tools/fs/paths.js";
import { createFsTools } from "../../tools/fs/tools.js";
import { type MemoryStore, buildMemoryRoot, createMemoryStore } from "../../tools/memory/store.js";
import { createMemoryTools } from "../../tools/memory/tools.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createTaskTools } from "../../tools/task/tools.js";
import { createToolIntrospectionTools } from "../../tools/tool/tools.js";
import { createUserTools } from "../../tools/user/tools.js";
import { check, cleanupSessions, memoryRoundTripModel } from "../harness.js";
import type { EvalOutcome, EvalScenario } from "../types.js";

/**
 * Szenario 2 (S18b, Kontextstufe 4 + Langzeitgedächtnis): eine lange Unterhaltung mit
 * Themenwechseln bleibt für den Nutzer durchgängig, auch wenn im Hintergrund ein frisches
 * Fenster beginnt — eine vor dem Themenwechsel geschriebene Notiz ist danach über einen
 * dritten Zug hinweg wiederauffindbar. Dasselbe Fertig-Kriterium wie der
 * "Gedächtnis-Rundlauf"-Test in `runtime/loop/loop.test.ts` (S18b), hier als eigenständiges
 * Eval-Szenario über drei Züge statt einem einzelnen Unit-Test.
 */
export const freshSectionScenario: EvalScenario = {
  name: "frisches-fenster-und-gedaechtnis",
  description:
    "Eine Ruhepause löst ein frisches Fenster aus (Kontextstufe 4); eine zuvor geschriebene Notiz bleibt über den Abschnittswechsel hinweg auffindbar.",

  async run(): Promise<EvalOutcome> {
    const pool = createPool();
    const sourceRoot = await mkdtemp(path.join(tmpdir(), "kuronami-eval-section-"));
    const artifactRoot = path.join(sourceRoot, "artifacts");
    const memoryRoot = await mkdtemp(path.join(tmpdir(), "kuronami-eval-section-memory-"));
    const threadIds: string[] = [];
    let memoryStore: MemoryStore | undefined;

    try {
      await mkdir(artifactRoot, { recursive: true });
      await writeFile(path.join(sourceRoot, "AGENTS.md"), "# Konventionen\n\nKein ORM.\n");

      const zones = await buildFsZones({ sourceRoot, artifactRoot });
      memoryStore = await createMemoryStore({
        root: await buildMemoryRoot(memoryRoot),
        indexFile: ":memory:",
        git: false,
      });
      const prelim = new ToolRegistry()
        .registerAll(createFsTools({ pool, artifactRoot, zones }))
        .registerAll(createTaskTools({ pool }))
        .registerAll(createUserTools({ pool }))
        .registerAll(createMemoryTools({ store: memoryStore, pool }))
        .freeze();
      const catalog = new ToolRegistry()
        .registerAll(prelim.tools)
        .registerAll(createToolIntrospectionTools({ catalog: prelim }))
        .freeze();
      const policy = createPolicyEngine({ resolvePath: policyResolver(zones) });

      const threadId = `thread_eval_${randomUUID()}`;
      threadIds.push(threadId);
      const runner = await createRunner({
        pool,
        threadId,
        channel: "web",
        artifactRoot,
        catalog,
        policy,
        model: memoryRoundTripModel("modell-eval-gedaechtnis"),
        conventions: "Kein ORM. Fehler nie verstecken.",
        memory: memoryStore,
        // Wie das Gateway (S16): eine lange Unterhaltung, kein Auftrag, der mit einer Antwort endet.
        completeOnDone: false,
        summarizeToMemory: true,
        sectionConfig: { idleMs: 5, maxConsecutiveStage3: 1_000 },
      });

      const checks = [];
      const metrics: Record<string, number> = {};
      try {
        const first = await runner.run("Mein Lieblingscafé heißt Kornblume.");
        checks.push(check("Erster Zug schließt ab", first.stop === "done", first.reason));

        const afterFirst = await readEvents(pool, runner.session.sessionId);
        checks.push(
          check(
            "Der Zug hinterlässt eine Notiz statt memory.skipped",
            !afterFirst.some((event) => event.type === "memory.skipped"),
          ),
        );
        checks.push(
          check(
            "Kein session.completed trotz Notiz — die Unterhaltung geht weiter",
            !afterFirst.some((event) => event.type === "session.completed"),
          ),
        );

        await new Promise((resolve) => setTimeout(resolve, 30));
        const second = await runner.run("Ganz anderes Thema: Fahrradreifen wechseln.");
        checks.push(check("Zweiter Zug schließt ab", second.stop === "done", second.reason));

        const afterSecond = await readEvents(pool, runner.session.sessionId);
        const sections = afterSecond.filter((event) => event.type === "context.section_started");
        checks.push(check("Ruhepause löst ein frisches Fenster aus", sections.length === 1));
        metrics.fresh_sections = sections.length;

        const third = await runner.run("Wie hieß noch mein Lieblingscafé?");
        checks.push(check("Dritter Zug schließt ab", third.stop === "done", third.reason));

        const afterThird = await readEvents(pool, runner.session.sessionId);
        const recalledForThird = afterThird
          .filter((event) => event.type === "memory.recalled")
          .at(-1);
        const found =
          typeof recalledForThird?.payload.found === "number" ? recalledForThird.payload.found : 0;
        checks.push(check("Der dritte Zug findet mindestens eine Notiz wieder", found > 0));
        const notes = (recalledForThird?.payload.notes as { title: string }[] | undefined) ?? [];
        checks.push(
          check(
            "Die wiedergefundene Notiz ist die über das Lieblingscafé",
            notes.some((note) => note.title.includes("Kornblume")),
          ),
        );
        metrics.notes_recalled_third_turn = found;
      } finally {
        await runner.stop("eval-ende");
      }

      return { checks, metrics };
    } finally {
      memoryStore?.close();
      await cleanupSessions(pool, threadIds);
      await pool.end();
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(memoryRoot, { recursive: true, force: true });
    }
  },
};
