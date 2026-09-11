import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deriveRunMetrics } from "../../context/metrics.js";
import { createPolicyEngine } from "../../policy/engine.js";
import { createPool } from "../../runtime/db/pool.js";
import { readEvents } from "../../runtime/events/log.js";
import { createRunner } from "../../runtime/loop/api.js";
import { buildFsZones, policyResolver } from "../../tools/fs/paths.js";
import { createFsTools } from "../../tools/fs/tools.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createTaskTools } from "../../tools/task/tools.js";
import { createToolIntrospectionTools } from "../../tools/tool/tools.js";
import { createUserTools } from "../../tools/user/tools.js";
import {
  check,
  cleanupSessions,
  fixedSummaryModel,
  manyReadsModel,
  recording,
} from "../harness.js";
import type { EvalOutcome, EvalScenario } from "../types.js";

/**
 * Szenario 1 (S18a, Kontextstufen 2+3): ein Lauf mit 110 Werkzeugaufrufen bleibt unter dem
 * konfigurierten Kontextfenster, weil die Kompaktierung automatisch greift — dasselbe
 * Fertig-Kriterium, das `runtime/loop/loop.test.ts` schon als Unit-Test führt, hier als
 * eigenständiges, für sich lauffähiges Eval-Szenario.
 */
export const compactionScenario: EvalScenario = {
  name: "kompaktierung-langer-lauf",
  description:
    "Ein Lauf mit 110 Werkzeugaufrufen bleibt unter dem konfigurierten Kontextfenster; Kontextstufe 2 und 3 greifen automatisch und die Cache-Trefferquote ist pro Lauf ablesbar.",

  async run(): Promise<EvalOutcome> {
    const pool = createPool();
    const sourceRoot = await mkdtemp(path.join(tmpdir(), "kuronami-eval-compaction-"));
    const artifactRoot = path.join(sourceRoot, "artifacts");
    const threadIds: string[] = [];

    try {
      await mkdir(artifactRoot, { recursive: true });
      await writeFile(path.join(sourceRoot, "AGENTS.md"), "# Konventionen\n\nKein ORM.\n");
      await writeFile(
        path.join(artifactRoot, "blob-kompaktierung.txt"),
        "Fuellinhalt fuer die Kompaktierung. ".repeat(40),
      );

      const zones = await buildFsZones({ sourceRoot, artifactRoot });
      const prelim = new ToolRegistry()
        .registerAll(createFsTools({ pool, artifactRoot, zones }))
        .registerAll(createTaskTools({ pool }))
        .registerAll(createUserTools({ pool }))
        .freeze();
      const catalog = new ToolRegistry()
        .registerAll(prelim.tools)
        .registerAll(createToolIntrospectionTools({ catalog: prelim }))
        .freeze();
      const policy = createPolicyEngine({ resolvePath: policyResolver(zones) });

      const totalSteps = 110;
      // Klein und konfigurierbar (Auftrag S18a): mit den Startwerten aus Abschnitt 13 bräuchte
      // dieser Nachweis eine Historie von hunderttausenden Zeichen.
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

      const spy = recording(
        manyReadsModel(
          totalSteps,
          "artifacts/blob-kompaktierung.txt",
          "modell-eval-viele-leseläufe",
        ),
      );

      const threadId = `thread_eval_${randomUUID()}`;
      threadIds.push(threadId);
      const runner = await createRunner({
        pool,
        threadId,
        channel: "web",
        artifactRoot,
        catalog,
        policy,
        model: spy.client,
        conventions: "Kein ORM. Fehler nie verstecken.",
        maxSteps: totalSteps + 5,
        compactionModel: fixedSummaryModel("modell-guenstig-kompaktierung"),
        compactionConfig,
      });

      const checks = [];
      const metrics: Record<string, number> = {};
      try {
        const result = await runner.run(`Lies dieselbe Datei ${totalSteps} Mal.`);
        checks.push(check('Lauf schließt ab ("done")', result.stop === "done", result.reason));
        checks.push(check(`Alle ${totalSteps} Aufrufe liefen`, result.toolCalls === totalSteps));

        const oversized = spy.requests.filter(
          (request) => JSON.stringify(request.messages).length >= usableWindowBytes,
        );
        checks.push(
          check(
            "Keine gesendete Anfrage überschreitet das konfigurierte Fenster",
            oversized.length === 0,
            oversized.length > 0
              ? `${oversized.length} von ${spy.requests.length} zu groß`
              : undefined,
          ),
        );

        const events = await readEvents(pool, runner.session.sessionId);
        const stage2 = events.filter(
          (event) => event.type === "context.compacted" && event.payload.stage === 2,
        );
        const stage3 = events.filter(
          (event) => event.type === "context.compacted" && event.payload.stage === 3,
        );
        checks.push(check("Kontextstufe 2 griff mindestens einmal", stage2.length > 0));
        checks.push(check("Kontextstufe 3 griff mindestens einmal", stage3.length > 0));

        const finished = events.find(
          (event) => event.type === "turn.completed" && event.payload.turn_id === result.turnId,
        );
        const cacheHitRate =
          typeof finished?.payload.cache_hit_rate === "number"
            ? finished.payload.cache_hit_rate
            : Number.NaN;
        checks.push(
          check(
            "Cache-Trefferquote steht im turn.completed und liegt in (0, 1]",
            cacheHitRate > 0 && cacheHitRate <= 1,
            String(cacheHitRate),
          ),
        );
        checks.push(
          check(
            "turn.completed.context_compactions summiert Stufe 2 und 3",
            finished?.payload.context_compactions === stage2.length + stage3.length,
          ),
        );
        checks.push(
          check(
            "Die im turn.completed gemeldete Quote stimmt mit der gefalteten Kennzahl überein",
            finished?.payload.cache_hit_rate === deriveRunMetrics(events).cacheHitRate,
          ),
        );

        metrics.tool_calls = result.toolCalls;
        metrics.model_requests = spy.requests.length;
        metrics.stage2_events = stage2.length;
        metrics.stage3_events = stage3.length;
        metrics.cache_hit_rate = cacheHitRate;
      } finally {
        await runner.stop("eval-ende");
      }

      return { checks, metrics };
    } finally {
      await cleanupSessions(pool, threadIds);
      await pool.end();
      await rm(sourceRoot, { recursive: true, force: true });
    }
  },
};
