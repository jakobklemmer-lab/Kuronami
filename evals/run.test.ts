import { describe, expect, it } from "vitest";
import { SCENARIOS, runEvals } from "./index.js";

/**
 * Hält die Eval-Suite (S18f) an `pnpm test` angeschlossen: ohne diese Datei liefe sie nur über
 * `pnpm evals` von Hand, und AGENTS.md verlangt einen grünen `pnpm test` vor jedem Commit — eine
 * Suite, die dabei nicht mitläuft, verrottet unbemerkt (dieselbe Sorge wie bei jedem anderen
 * Fertig-Kriterium in diesem Projekt).
 *
 * Läuft bewusst als **ein** Test über alle vier Szenarien statt vier einzelner `it`s: die
 * Szenarien sind voneinander unabhängig (eigener Pool, eigene Verzeichnisse), aber der Bericht
 * ist die Aussage dieser Session — "vier Szenarien laufen automatisiert, strukturierter
 * Report" — und die prüft man an einem Bericht, nicht an vier verstreuten Erwartungen.
 */
describe("Eval-Suite für lange Läufe (S18f)", () => {
  it("alle vier Szenarien laufen automatisiert durch und liefern einen strukturierten Report", async () => {
    const report = await runEvals();

    expect(report.results).toHaveLength(SCENARIOS.length);
    expect(report.results.map((r) => r.scenario)).toEqual(SCENARIOS.map((s) => s.name));

    for (const result of report.results) {
      // Jeder einzelne Check steht mit seinem Namen im Fehlertext, nicht nur "passed: false" —
      // dieselbe Haltung wie "Fehler nie verstecken" (AGENTS.md), hier auf einen Testfehlschlag
      // angewendet: wer das rot sieht, soll sofort wissen, welche Aussage nicht stimmte.
      const failed = result.checks.filter((c) => !c.passed);
      expect(failed, `${result.scenario}: ${result.error ?? "siehe checks"}`).toEqual([]);
      expect(result.error).toBeUndefined();
      expect(result.checks.length).toBeGreaterThan(0);
    }

    expect(report.passed).toBe(true);
  }, 120_000);
});
