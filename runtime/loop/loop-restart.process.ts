import { createPolicyEngine } from "../../policy/engine.js";
import { buildFsZones, policyResolver } from "../../tools/fs/paths.js";
import { createFsTools } from "../../tools/fs/tools.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createTaskTools } from "../../tools/task/tools.js";
import type { ToolDefinition } from "../../tools/types.js";
import { createPool } from "../db/pool.js";
import type { ModelClient } from "../model/types.js";
import { createRunner } from "./api.js";
import { type ScriptedStep, completedCalls, createScriptedModel } from "./scripted.js";

/**
 * Ein echter Lauf der Schleife in einem eigenen Betriebssystem-Prozess, damit der Test ihn
 * **abschießen** kann (S12, Fertig-Kriterium: "einen erzwungenen Neustart in der Mitte
 * überleben"). Muster aus S05 (`crash-mid-step.process.ts`), S10 und S11.
 *
 * Warum ein eigener Prozess und nicht ein simulierter Absturz im Testprozess: dort liefe
 * immer noch ein `finally` oder wenigstens die Möglichkeit dazu, und der Kontext läge weiter
 * im Speicher desselben Laufs. Genau das soll der Nachweis ausschließen — der zweite Lauf
 * darf nichts wissen, was nicht in der Datenbank steht.
 *
 * Aufruf:
 *   node --import tsx loop-restart.process.ts <threadId> <sourceRoot> <artifactRoot> <steps>
 */
const [threadId, sourceRoot, artifactRoot, stepsArg] = process.argv.slice(2);
if (!threadId || !sourceRoot || !artifactRoot || !stepsArg) {
  throw new Error("Aufruf: loop-restart.process.ts <threadId> <sourceRoot> <artifactRoot> <steps>");
}
const steps = Number(stepsArg);
const hangAt = Number(process.env.KURONAMI_HANG_AT ?? "0");
const isResume = process.env.KURONAMI_RESUME === "1";

const pool = createPool();
const zones = await buildFsZones({ sourceRoot, artifactRoot });

/**
 * Ein Werkzeug, das beim ersten Lauf **hängen bleibt**, damit der Abschuss deterministisch in
 * das interessante Fenster fällt: nach `model.responded`, nach `step.started`, **vor**
 * `step.completed`. Genau dort hinterlässt ein abgestürzter Prozess einen offenen Aufruf und
 * einen offenen Schritt — und nur dort wird geprüft, dass der Loop erst die offenen Aufrufe
 * erledigt und nicht das Modell noch einmal fragt.
 *
 * Ohne diesen Halt hinge der Nachweis am Zufall: der Abschuss träfe mal dieses Fenster, mal
 * die Lücke zwischen zwei Zyklen, und eine Gegenprobe an der Wiederaufnahme bliebe grün, ohne
 * dass jemand den Grund sähe. Genau das ist beim Gegenprobieren aufgefallen.
 *
 * Namensraum `dev` — Prüf-Tools des Harness, die in keinem produktiven Katalog stehen
 * (Abschnitt 4.8, wie `tools/dummies.ts` seit S07). `repeatable: true`: der zweite Anlauf
 * darf laufen, und beim Wiederaufnehmen ist das genau die Zusage, an der S05 entscheidet.
 */
const DEV_HANG: ToolDefinition = {
  name: "dev.hang",
  description: "Prüf-Tool: bleibt im ersten Lauf hängen, im Wiederaufnahmelauf kommt es zurück.",
  risk: "read",
  repeatable: true,
  inputSchema: {
    fields: { note: { type: "string", required: true, description: "Beliebiger Text." } },
  },
  handler: async ({ input }) => {
    if (!isResume) {
      console.log("HANGING");
      // Kein Aufräumen, kein Zeitfenster: der Test schießt hier ab.
      await new Promise(() => {});
    }
    return { summary: `dev.hang: ${String(input.note)}`, structured: { resumed: isResume } };
  },
};

const catalog = new ToolRegistry()
  .registerAll(createFsTools({ pool, artifactRoot, zones }))
  .registerAll(createTaskTools({ pool }))
  .register(DEV_HANG)
  .freeze();

/**
 * Dasselbe Drehbuch in beiden Läufen. Es zählt die Ergebnisse in der Historie und nicht seine
 * eigenen Aufrufe — deshalb antwortet der frisch gestartete Prozess an derselben Stelle
 * dasselbe wie der abgeschossene.
 */
const scripted = createScriptedModel({
  steps,
  step(index: number): ScriptedStep {
    if (index === 1) {
      return {
        toolName: "task.set",
        input: { tasks: [{ id: "schreiben", title: "Dateien schreiben", status: "in_progress" }] },
      };
    }
    if (index === hangAt) {
      return { toolName: "dev.hang", input: { note: `Schritt ${index}` } };
    }
    return {
      toolName: "fs.write",
      input: { path: `artifacts/schritt-${index}.txt`, content: `Inhalt von Schritt ${index}\n` },
    };
  },
});

/** Meldet jeden Zyklus nach draußen, damit der Test genau in der Mitte abschießen kann. */
const model: ModelClient = {
  model: scripted.model,
  async complete(request) {
    console.log(`STEP ${completedCalls(request)}`);
    return await scripted.complete(request);
  },
};

const runner = await createRunner({
  pool,
  threadId,
  channel: "web",
  artifactRoot,
  catalog,
  policy: createPolicyEngine({ resolvePath: policyResolver(zones) }),
  model,
  conventions: "Kein ORM. Fehler nie verstecken.",
});

// Erster Lauf eröffnet den Zug, jeder folgende setzt den offenen fort. Die Unterscheidung
// trifft der Prozess nicht selbst — sie steht im Protokoll.
const result = await runner.run(isResume ? undefined : `Schreibe ${steps - 1} Dateien.`);

console.log(`DONE ${result.stop} ${result.toolCalls}`);
await runner.stop(result.stop);
await pool.end();
process.exit(0);
