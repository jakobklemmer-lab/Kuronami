import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPolicyEngine } from "../../policy/engine.js";
import { createPool } from "../../runtime/db/pool.js";
import { readEvents } from "../../runtime/events/log.js";
import { createRunner } from "../../runtime/loop/api.js";
import type { ModelClient, ModelContentBlock } from "../../runtime/model/types.js";
import type { JsonValue } from "../../runtime/steps/types.js";
import { buildFsZones, policyResolver } from "../../tools/fs/paths.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createTaskTools } from "../../tools/task/tools.js";
import { createToolIntrospectionTools } from "../../tools/tool/tools.js";
import { FIXED_USAGE, check, cleanupSessions, recording } from "../harness.js";
import type { EvalOutcome, EvalScenario } from "../types.js";

const DEFERRED_NAMES = ["dev.alpha", "dev.beta", "dev.gamma", "dev.delta", "dev.epsilon"];

function dummyDeferredTool(name: string) {
  return {
    name,
    description: `Assistenz-Tool (Testdouble für S18f): ${name}.`,
    risk: "read" as const,
    repeatable: true,
    deferred: true,
    inputSchema: {
      fields: { note: { type: "string" as const, required: false, description: "frei" } },
    },
    handler: async () => ({ summary: `${name} ausgeführt`, structured: { ok: true } }),
  };
}

/** Ein Drehbuch: erst eine Kernaufgabe, dann `tool.load`, dann dasselbe Assistenz-Tool viermal. */
function toolLoadModel(): ModelClient {
  let step = 0;
  const name = "modell-eval-tool-load";
  const call = (
    callId: string,
    apiName: string,
    input: Record<string, JsonValue>,
    text: string,
  ) => {
    const toolUse: ModelContentBlock = { type: "tool_use", id: callId, name: apiName, input };
    return {
      model: name,
      stopReason: "tool_use" as const,
      text,
      toolCalls: [{ callId, name: apiName, input }],
      usage: FIXED_USAGE,
      content: [{ type: "text", text }, toolUse],
    };
  };
  return {
    model: name,
    async complete() {
      step += 1;
      if (step === 1) {
        return call(
          "call_task",
          "task__set",
          { tasks: [{ id: "kern", title: "Kernaufgabe", status: "in_progress" }] },
          "Plan gesetzt.",
        );
      }
      if (step === 2) {
        return call("call_load", "tool__load", { names: ["dev.alpha"] }, "Lade dev.alpha.");
      }
      if (step >= 3 && step <= 6) {
        return call(
          `call_alpha_${step}`,
          "dev__alpha",
          { note: `Aufruf ${step}` },
          `Nutze dev.alpha (${step - 2}/4).`,
        );
      }
      return {
        model: name,
        stopReason: "end_turn" as const,
        text: "Fertig.",
        toolCalls: [],
        usage: FIXED_USAGE,
        content: [{ type: "text", text: "Fertig." }],
      };
    },
  };
}

/**
 * Szenario 3 (S18b, verzögertes Tool-Laden): ein Katalog mit fünf Assistenz-Tools hält alle
 * fünf außerhalb der an den Anbieter gesendeten Werkzeugliste, bis `tool.load` eines davon
 * nachlädt — und danach bleibt es über **mehrere** folgende Anfragen hinweg mit vollem Schema
 * aufrufbar, nicht nur in der unmittelbar nächsten. Genau das unterscheidet dieses
 * Eval-Szenario vom knappen Drei-Schritte-Unit-Test in `runtime/loop/loop.test.ts`: der
 * Nachweis über einen länger laufenden Zug, nicht nur den einen Übergang.
 */
export const deferredToolsScenario: EvalScenario = {
  name: "verzoegertes-tool-laden-langer-lauf",
  description:
    "Fünf Assistenz-Tools bleiben bis zum Nachladen außerhalb der Werkzeugliste; nach tool.load bleibt das genutzte Tool über mehrere weitere Anfragen hinweg mit vollem Schema aufrufbar, der Katalog-Fingerabdruck ändert sich nie.",

  async run(): Promise<EvalOutcome> {
    const pool = createPool();
    const sourceRoot = await mkdtemp(path.join(tmpdir(), "kuronami-eval-deferred-"));
    const artifactRoot = path.join(sourceRoot, "artifacts");
    const threadIds: string[] = [];

    try {
      await mkdir(artifactRoot, { recursive: true });
      await writeFile(path.join(sourceRoot, "AGENTS.md"), "# Konventionen\n\nKein ORM.\n");
      const zones = await buildFsZones({ sourceRoot, artifactRoot });

      const prelim = new ToolRegistry()
        .registerAll(createTaskTools({ pool }))
        .registerAll(DEFERRED_NAMES.map(dummyDeferredTool))
        .freeze();
      const catalog = new ToolRegistry()
        .registerAll(prelim.tools)
        .registerAll(createToolIntrospectionTools({ catalog: prelim }))
        .freeze();
      const policy = createPolicyEngine({ resolvePath: policyResolver(zones) });

      const spy = recording(toolLoadModel());
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
      });

      const checks = [];
      const metrics: Record<string, number> = {};
      try {
        const result = await runner.run(
          "Bitte die Kernaufgabe erledigen und dann dev.alpha nutzen.",
        );
        checks.push(check('Lauf schließt ab ("done")', result.stop === "done", result.reason));
        // 1 Kernaufgabe + 1 tool.load + 4 dev.alpha-Aufrufe + 1 Schlussantwort = 7 Anfragen.
        checks.push(
          check("Sieben Modellanfragen wie im Drehbuch vorgesehen", spy.requests.length === 7),
        );

        const beforeLoad = spy.requests.slice(0, 2);
        const fehltVorher = beforeLoad.every(
          (request) => !request.tools.some((tool) => tool.name === "dev__alpha"),
        );
        checks.push(check("dev.alpha fehlt in der Werkzeugliste vor tool.load", fehltVorher));
        const kurzlisteVorher = beforeLoad.every((request) =>
          DEFERRED_NAMES.every((name) => JSON.stringify(request.system).includes(name)),
        );
        checks.push(
          check(
            "Alle fünf Assistenz-Tools stehen als Kurzeintrag im <deferred_tools>-Block",
            kurzlisteVorher,
          ),
        );

        const afterLoad = spy.requests.slice(2);
        const vollständigNachher = afterLoad.every((request) => {
          const spec = request.tools.find((tool) => tool.name === "dev__alpha");
          return spec !== undefined && spec.inputSchema.properties.note !== undefined;
        });
        checks.push(
          check(
            "dev.alpha bleibt über alle folgenden Anfragen hinweg mit vollem Schema aufrufbar",
            vollständigNachher,
          ),
        );

        const catalogVersions = new Set(spy.requests.map((_, index) => catalog.version));
        checks.push(
          check(
            "Der Katalog-Fingerabdruck bleibt über den ganzen Lauf derselbe",
            catalogVersions.size === 1,
          ),
        );

        const events = await readEvents(pool, runner.session.sessionId);
        const alphaCompleted = events.filter(
          (event) => event.type === "tool.completed" && event.payload.tool_name === "dev.alpha",
        );
        checks.push(check("dev.alpha lief genau viermal erfolgreich", alphaCompleted.length === 4));
        checks.push(
          check(
            "Kein Werkzeugaufruf ist fehlgeschlagen",
            events.filter((event) => event.type === "tool.failed").length === 0,
          ),
        );

        metrics.model_requests = spy.requests.length;
        metrics.dev_alpha_calls = alphaCompleted.length;
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
