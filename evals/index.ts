import { compactionScenario } from "./scenarios/compaction.js";
import { deferredToolsScenario } from "./scenarios/deferred-tools.js";
import { freshSectionScenario } from "./scenarios/fresh-section.js";
import { skillsScenario } from "./scenarios/skills.js";
import type { EvalReport, EvalResult, EvalScenario } from "./types.js";

/**
 * Die Eval-Suite für lange Läufe (Auftrag S18f, `docs/ARCHITEKTUR.md` Abschnitt 3 und
 * Anti-Muster 9). Vier Szenarien, je eines für einen der vier Phase-4-Mechanismen, die genau
 * dafür gebaut wurden, dass ein Lauf lang werden darf, ohne am Kontextfenster zu scheitern
 * oder den Nutzer etwas merken zu lassen:
 *
 *   1. Kompaktierung (S18a) — ein 110-Schritte-Lauf bleibt unter dem Kontextfenster.
 *   2. Frisches Fenster + Gedächtnis (S18b/S18) — eine Unterhaltung bleibt über einen
 *      Themenwechsel hinweg durchgängig.
 *   3. Verzögertes Tool-Laden (S18b) — ein großer Assistenz-Katalog bleibt klein, bis
 *      gezielt nachgeladen wird, und bleibt es dann über mehrere weitere Züge.
 *   4. Skills (S18c) — dieselbe Zusage für Fähigkeiten statt Werkzeuge.
 *
 * Jedes Szenario ist eigenständig lauffähig (eigener Pool, eigene Verzeichnisse, eigene
 * Aufräumarbeit) — ein Fehlschlag in einem reißt die anderen drei nicht mit, und das ist der
 * Grund, warum `runEvals` jedes Szenario einzeln in ein `try/catch` fasst, statt die ganze
 * Suite bei der ersten Ausnahme abzubrechen.
 */
export const SCENARIOS: readonly EvalScenario[] = [
  compactionScenario,
  freshSectionScenario,
  deferredToolsScenario,
  skillsScenario,
];

export async function runEvals(
  scenarios: readonly EvalScenario[] = SCENARIOS,
): Promise<EvalReport> {
  const startedAt = new Date();
  const results: EvalResult[] = [];

  for (const scenario of scenarios) {
    const t0 = Date.now();
    try {
      const { checks, metrics } = await scenario.run();
      results.push({
        scenario: scenario.name,
        description: scenario.description,
        passed: checks.length > 0 && checks.every((c) => c.passed),
        durationMs: Date.now() - t0,
        checks,
        metrics,
      });
    } catch (error) {
      // Ein geworfenes Szenario ist ein Fehlschlag, kein Abbruch der ganzen Suite (AGENTS.md:
      // "Fehler nie verstecken oder glätten") — der Wortlaut landet im Bericht, die übrigen
      // Szenarien laufen trotzdem weiter.
      results.push({
        scenario: scenario.name,
        description: scenario.description,
        passed: false,
        durationMs: Date.now() - t0,
        checks: [],
        metrics: {},
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    passed: results.every((r) => r.passed),
    results,
  };
}

export type { EvalCheck, EvalOutcome, EvalReport, EvalResult, EvalScenario } from "./types.js";
