import type { ModelClient, ModelRequest, ModelResponse } from "../../runtime/model/types.js";

/**
 * Das Token-Budget eines Subagenten (S20, Abschnitt 14: "Obergrenze für parallele Worker und
 * Token-Budget").
 *
 * ## Warum als Hülle um den Modell-Client und nicht als Zähler im Loop
 *
 * Der Loop (`runtime/loop/loop.ts`) kennt keine Kosten, und er soll sie auch nicht kennen: er
 * beantwortet die Frage, **wann** gefragt, gehandelt und aufgehört wird (S12). Eine Grenze, die
 * je Agent gilt, wäre dort ein Sonderfall für einen Aufrufer — und der nächste Aufrufer mit
 * einer anderen Grenze bekäme den nächsten. Der `ModelClient` dagegen ist genau die Stelle, an
 * der Token entstehen, und er ist seit S12 ein injizierter Vertrag; eine Hülle darum ist
 * dieselbe Bauart wie `recording(...)` in den Tests und wie der Klassifikator-Client aus S18e.
 *
 * ## Vorher prüfen, nicht hinterher
 *
 * Gezählt wird nach jeder Antwort, geprüft **vor** jedem Aufruf: ein Budget, das erst nach dem
 * Überschreiten auffällt, hat den Aufruf, der es überschritt, schon bezahlt. Der erste Aufruf
 * läuft immer (`spent` ist dann null) — ein Agent, der nie fragen darf, wäre keiner.
 *
 * Gezählt werden **alle vier** Zahlen aus `ModelUsage`, auch die aus dem Cache gelesenen: sie
 * sind billiger, aber nicht umsonst (Abschnitt 11), und ein Budget, das die Hälfte des
 * Verbrauchs nicht sieht, ist keine Obergrenze, sondern eine Schätzung.
 */

/** Das Budget dieses Arbeiters ist aufgebraucht. Trägt die Zahlen, nicht ihre Glättung. */
export class TokenBudgetExceededError extends Error {
  constructor(
    readonly spent: number,
    readonly budget: number,
  ) {
    super(
      `Token-Budget aufgebraucht: ${spent} von ${budget} Token verbraucht. Der Lauf wird abgebrochen, bevor der nächste Modellaufruf ihn weiter verteuert.`,
    );
    this.name = "TokenBudgetExceededError";
  }
}

export interface BudgetedModel extends ModelClient {
  /** Was dieser Lauf bisher verbraucht hat. */
  spent(): number;
  /** Das Budget, gegen das gezählt wird. */
  readonly budget: number;
}

export function budgetedModel(model: ModelClient, budget: number): BudgetedModel {
  let spent = 0;

  return {
    model: model.model,
    budget,
    spent: () => spent,

    async complete(request: ModelRequest): Promise<ModelResponse> {
      if (spent >= budget) throw new TokenBudgetExceededError(spent, budget);

      const response = await model.complete(request);
      const usage = response.usage;
      spent +=
        usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
      return response;
    },
  };
}
