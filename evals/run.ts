import { runEvals } from "./index.js";
import type { EvalReport } from "./types.js";

/**
 * Der Kommandozeilen-Einstieg der Eval-Suite (`pnpm evals`). Trennt bewusst den Kern
 * (`runEvals`, `index.ts`) von der Ausgabe hier: derselbe Kern läuft auch aus
 * `evals/run.test.ts` heraus, damit die Suite Teil von `pnpm test` bleibt (AGENTS.md: "Jede
 * Session endet mit einem Commit", sobald `pnpm typecheck && pnpm lint && pnpm test" grün
 * sind) — dieser Prozess hier ist nur für den Menschen am Terminal.
 */

function printReport(report: EvalReport): void {
  console.log(`Eval-Suite gestartet ${report.startedAt}, ${report.durationMs} ms gesamt.\n`);

  for (const result of report.results) {
    const mark = result.passed ? "OK  " : "FAIL";
    console.log(`[${mark}] ${result.scenario} (${result.durationMs} ms)`);
    console.log(`       ${result.description}`);
    if (result.error) {
      console.log(`       Fehler: ${result.error}`);
    }
    for (const c of result.checks) {
      console.log(`       - ${c.passed ? "✓" : "✗"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
    }
    const metricEntries = Object.entries(result.metrics);
    if (metricEntries.length > 0) {
      console.log(`       Kennzahlen: ${metricEntries.map(([k, v]) => `${k}=${v}`).join(", ")}`);
    }
    console.log("");
  }

  console.log(`Gesamt: ${report.passed ? "BESTANDEN" : "FEHLGESCHLAGEN"}`);
  // Der strukturierte Report (Auftrag S18f, wörtlich) — als JSON auf einer eigenen Zeile, damit
  // ihn ein aufrufendes Werkzeug (CI, ein späteres Dashboard) parsen kann, ohne die
  // menschenlesbare Ausgabe oben zu verlieren.
  console.log("\n--- REPORT-JSON ---");
  console.log(JSON.stringify(report, null, 2));
}

async function main(): Promise<void> {
  const report = await runEvals();
  printReport(report);
  process.exitCode = report.passed ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
