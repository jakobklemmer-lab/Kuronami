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
import { loadSkillCatalog } from "../../tools/skill/catalog.js";
import { createSkillTools } from "../../tools/skill/tools.js";
import { createTaskTools } from "../../tools/task/tools.js";
import { createToolIntrospectionTools } from "../../tools/tool/tools.js";
import { FIXED_USAGE, check, cleanupSessions, recording } from "../harness.js";
import type { EvalOutcome, EvalScenario } from "../types.js";

const SKILL_COUNT = 8;
const CHOSEN = "dummy-05";
const MARKER = "MARKER-05";

async function writeDummySkills(root: string): Promise<void> {
  for (let i = 1; i <= SKILL_COUNT; i += 1) {
    const name = `dummy-${String(i).padStart(2, "0")}`;
    const dir = path.join(root, name);
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
        `Vollständige Anleitung für Dummy-Skill ${i}. MARKER-${String(i).padStart(2, "0")} steht erst nach skill.load im Kontext.`,
        "",
      ].join("\n"),
      "utf8",
    );
  }
}

/** Drehbuch: eine Kernaufgabe, `skill.load`, danach mehrere weitere Züge, dann Schluss. */
function skillLoadModel(): ModelClient {
  let step = 0;
  const name = "modell-eval-skill-load";
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
        return call("call_load", "skill__load", { names: [CHOSEN] }, `Lade ${CHOSEN}.`);
      }
      if (step === 3 || step === 4) {
        return call(
          `call_update_${step}`,
          "task__update",
          { task_id: "kern", status: step === 4 ? "done" : "in_progress" },
          `Wende die Anleitung an (Schritt ${step - 2}).`,
        );
      }
      return {
        model: name,
        stopReason: "end_turn" as const,
        text: "Fertig, Anleitung angewendet.",
        toolCalls: [],
        usage: FIXED_USAGE,
        content: [{ type: "text", text: "Fertig, Anleitung angewendet." }],
      };
    },
  };
}

/**
 * Szenario 4 (S18c, progressive Offenlegung von Skills): acht Skills bleiben als Kurzliste im
 * Prompt, bis `skill.load` einen davon vollständig nachlädt — und der volle Rumpf bleibt danach
 * über **mehrere** weitere Anfragen in der Historie sichtbar, nicht nur in der unmittelbar
 * nächsten. Dieselbe Erweiterung gegenüber dem knappen S18c-Unit-Test wie bei Szenario 3.
 */
export const skillsScenario: EvalScenario = {
  name: "skills-langer-lauf",
  description:
    "Acht Skills bleiben in der Kurzliste, bis skill.load einen vollständig nachlädt; der volle Rumpf bleibt über mehrere weitere Züge in der Historie sichtbar, und skill.invoked steht im Protokoll.",

  async run(): Promise<EvalOutcome> {
    const pool = createPool();
    const sourceRoot = await mkdtemp(path.join(tmpdir(), "kuronami-eval-skills-"));
    const artifactRoot = path.join(sourceRoot, "artifacts");
    const skillsRoot = await mkdtemp(path.join(tmpdir(), "kuronami-eval-skills-root-"));
    const threadIds: string[] = [];

    try {
      await mkdir(artifactRoot, { recursive: true });
      await writeFile(path.join(sourceRoot, "AGENTS.md"), "# Konventionen\n\nKein ORM.\n");
      await writeDummySkills(skillsRoot);
      const skillCatalog = await loadSkillCatalog(skillsRoot);

      const zones = await buildFsZones({ sourceRoot, artifactRoot });
      const prelim = new ToolRegistry().registerAll(createTaskTools({ pool })).freeze();
      const catalog = new ToolRegistry()
        .registerAll(prelim.tools)
        .registerAll(createToolIntrospectionTools({ catalog: prelim }))
        .registerAll(createSkillTools({ catalog: skillCatalog, pool }))
        .freeze();
      const policy = createPolicyEngine({ resolvePath: policyResolver(zones) });

      const spy = recording(skillLoadModel());
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
        skills: skillCatalog,
      });

      const checks = [];
      const metrics: Record<string, number> = {};
      try {
        const result = await runner.run(`Bitte die Kernaufgabe mit ${CHOSEN} erledigen.`);
        checks.push(check('Lauf schließt ab ("done")', result.stop === "done", result.reason));
        checks.push(
          check("Fünf Modellanfragen wie im Drehbuch vorgesehen", spy.requests.length === 5),
        );

        const beforeLoad = spy.requests.slice(0, 2);
        const ohneMarkerVorher = beforeLoad.every(
          (request) => !JSON.stringify(request.system).includes(MARKER),
        );
        checks.push(check("Kein Skill-Rumpf im Prompt vor skill.load", ohneMarkerVorher));
        const kurzlisteSize = Math.max(
          ...beforeLoad.map((request) => JSON.stringify(request.system).length),
        );
        checks.push(
          check(
            `Die Kurzliste bleibt trotz ${SKILL_COUNT} Skills klein (< 5000 Zeichen)`,
            kurzlisteSize < 5_000,
            String(kurzlisteSize),
          ),
        );

        const afterLoad = spy.requests.slice(2);
        const markerBleibtSichtbar = afterLoad.every((request) =>
          JSON.stringify(request.messages).includes(MARKER),
        );
        checks.push(
          check(
            `Der volle Rumpf von ${CHOSEN} bleibt über alle folgenden Anfragen in der Historie sichtbar`,
            markerBleibtSichtbar,
          ),
        );

        const events = await readEvents(pool, runner.session.sessionId);
        const invoked = events.find((event) => event.type === "skill.invoked");
        checks.push(
          check(
            "skill.invoked steht im Protokoll mit dem richtigen Namen",
            (invoked?.payload.names as string[] | undefined)?.[0] === CHOSEN,
          ),
        );
        checks.push(
          check(
            "Kein Werkzeugaufruf ist fehlgeschlagen",
            events.filter((event) => event.type === "tool.failed").length === 0,
          ),
        );

        metrics.model_requests = spy.requests.length;
        metrics.skill_count = SKILL_COUNT;
        metrics.kurzliste_max_bytes = kurzlisteSize;
      } finally {
        await runner.stop("eval-ende");
      }

      return { checks, metrics };
    } finally {
      await cleanupSessions(pool, threadIds);
      await pool.end();
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(skillsRoot, { recursive: true, force: true });
    }
  },
};
