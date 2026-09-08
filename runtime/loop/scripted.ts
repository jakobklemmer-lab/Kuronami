import type {
  ModelClient,
  ModelContentBlock,
  ModelRequest,
  ModelResponse,
  ModelToolCall,
} from "../model/types.js";
import type { JsonValue } from "../steps/types.js";

/**
 * Ein Modell, das nach Drehbuch antwortet. **Prüf-Baustein, kein produktiver Teil** — dieselbe
 * Rolle wie `tools/dummies.ts` seit S07, und aus demselben Grund im Quellbaum und nicht in
 * einer Testdatei: der Absturznachweis läuft in einem eigenen Betriebssystem-Prozess
 * (`loop-restart.process.ts`), und der kann nichts importieren, was nur der Testrunner kennt.
 *
 * Die eine Eigenschaft, auf die es ankommt: **die Antwort ist eine reine Funktion der
 * Historie.** Nicht der Aufrufzahl, nicht eines Zählers im Objekt — der Historie. Ein
 * Drehbuch, das mitzählt, wie oft es gefragt wurde, gäbe nach einem Neustart die falsche
 * Antwort, und der Absturznachweis prüfte dann die Buchführung des Drehbuchs statt die des
 * Loops. Gezählt werden deshalb die Ergebnisblöcke in der eingehenden Historie: sie stehen im
 * Protokoll und überleben den Prozess.
 *
 * Die Aufrufkennungen sind aus demselben Grund fest vergeben (`call_step_7` und nicht eine
 * frische UUID). Damit trifft ein zweiter Anlauf auf denselben Idempotenzschlüssel
 * `tool:call_step_7` — der Seiteneffekt läuft genau einmal, auch wenn der Prozess zwischen
 * Modellantwort und Werkzeugaufruf abgeschossen wurde.
 */

export interface ScriptedStep {
  toolName: string;
  input: Record<string, JsonValue>;
}

export interface ScriptedTask {
  /** Wie viele Werkzeugaufrufe der Lauf machen soll. */
  steps: number;
  /** Der Aufruf Nummer `index` (1-basiert). */
  step(index: number): ScriptedStep;
  /** Wie viele Aufrufe pro Antwort. 1 ist der Normalfall, >1 prüft Nebenläufigkeit. */
  batchSize?: number;
  finalText?: string;
}

/** Ergebnisblöcke in der Historie — also erledigte Aufrufe, ob geglückt oder nicht. */
export function completedCalls(request: ModelRequest): number {
  let count = 0;
  for (const message of request.messages) {
    for (const block of message.content) {
      if (block.type === "tool_result") count += 1;
    }
  }
  return count;
}

/**
 * Eine Nutzungsangabe, die sich wie eine echte verhält: der erste Aufruf schreibt den Präfix
 * in den Cache, jeder folgende liest ihn. Sie ist ein **Platzhalter** und kein Messwert — was
 * der Cache wirklich trägt, sagt nur der Anbieter, und das steht im Probelauf. Geprüft wird
 * damit die Faltung der Kennzahl, nicht der Cache.
 */
function scriptedUsage(request: ModelRequest, first: boolean) {
  const prefix =
    request.system.reduce((sum, block) => sum + block.text.length, 0) +
    request.tools.reduce((sum, tool) => sum + JSON.stringify(tool).length, 0);
  const prefixTokens = Math.ceil(prefix / 4);
  const fresh = Math.ceil(JSON.stringify(request.messages).length / 4);
  return {
    inputTokens: fresh,
    outputTokens: 40,
    cacheReadTokens: first ? 0 : prefixTokens,
    cacheCreationTokens: first ? prefixTokens : 0,
  };
}

export function createScriptedModel(
  task: ScriptedTask,
  model = "modell-nach-drehbuch",
): ModelClient {
  const batchSize = task.batchSize ?? 1;

  return {
    model,

    async complete(request: ModelRequest): Promise<ModelResponse> {
      const done = completedCalls(request);
      const first = done === 0;

      if (done >= task.steps) {
        const text = task.finalText ?? `Fertig nach ${done} Schritten.`;
        return {
          model,
          stopReason: "end_turn",
          text,
          toolCalls: [],
          usage: scriptedUsage(request, first),
          content: [{ type: "text", text }],
        };
      }

      const toolCalls: ModelToolCall[] = [];
      for (let offset = 0; offset < batchSize && done + offset < task.steps; offset += 1) {
        const index = done + offset + 1;
        const step = task.step(index);
        toolCalls.push({
          callId: `call_step_${index}`,
          // Der API-Name, wie ihn ein echtes Modell zurückgäbe. Der Loop übersetzt zurück —
          // täte das Drehbuch es selbst, bliebe die Übersetzung ungeprüft.
          name: step.toolName.replace(".", "__"),
          input: step.input,
        });
      }

      const content: ModelContentBlock[] = [
        { type: "text", text: `Schritt ${done + 1}.` },
        ...toolCalls.map((call) => ({
          type: "tool_use",
          id: call.callId,
          name: call.name,
          input: call.input as JsonValue,
        })),
      ];

      return {
        model,
        stopReason: "tool_use",
        text: `Schritt ${done + 1}.`,
        toolCalls,
        usage: scriptedUsage(request, first),
        content,
      };
    },
  };
}
