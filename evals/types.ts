/**
 * Die Formen der Eval-Suite (S18f, `docs/ARCHITEKTUR.md` Abschnitt 3: "`evals/` (Harness-
 * Evals)"). Ein Eval ist kein Unit-Test: es prüft das Gesamtsystem über einen ganzen Lauf
 * hinweg (Anti-Muster 9: "Das Harness selbst nicht evaluieren, Tool-Tests reichen nicht"), mit
 * einem strukturierten Ergebnis statt einer grünen/roten Zeile — dieselbe Haltung wie bei der
 * einheitlichen Tool-Rückgabehülle (`status`/`summary`/`structured`).
 */

export type EvalMetricValue = number | string | boolean;

/** Eine einzelne Aussage innerhalb eines Szenarios — bestanden oder nicht, mit Begründung. */
export interface EvalCheck {
  name: string;
  passed: boolean;
  detail?: string;
}

/** Was ein Szenario zurückgibt, wenn es durchgelaufen ist (mit oder ohne Fehlschlag). */
export interface EvalOutcome {
  checks: EvalCheck[];
  metrics: Record<string, EvalMetricValue>;
}

/** Ein Eval-Szenario: eigenständig lauffähig, öffnet und schließt seine eigenen Ressourcen. */
export interface EvalScenario {
  name: string;
  description: string;
  run(): Promise<EvalOutcome>;
}

/** Das Ergebnis eines Szenarios im fertigen Bericht — auch wenn es geworfen hat. */
export interface EvalResult {
  scenario: string;
  description: string;
  passed: boolean;
  durationMs: number;
  checks: EvalCheck[];
  metrics: Record<string, EvalMetricValue>;
  /** Gesetzt, wenn das Szenario selbst geworfen hat, statt kontrolliert Checks zu melden. */
  error?: string;
}

/** Der strukturierte Report über einen ganzen Eval-Lauf (Auftrag S18f, wörtlich). */
export interface EvalReport {
  startedAt: string;
  durationMs: number;
  passed: boolean;
  results: EvalResult[];
}
