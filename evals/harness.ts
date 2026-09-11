import type { Pool } from "pg";
import type { ModelClient, ModelContentBlock, ModelRequest } from "../runtime/model/types.js";
import type { EvalCheck, EvalMetricValue } from "./types.js";

/**
 * Gemeinsamer Unterbau für die Eval-Szenarien (S18f) — kein Testrunner, kein `expect`: jedes
 * Szenario sammelt seine Aussagen selbst als `EvalCheck[]` (siehe `types.ts`) statt zu werfen,
 * damit ein einzelner Fehlschlag im Bericht sichtbar bleibt und nicht die übrigen Prüfungen
 * desselben Laufs verschluckt.
 *
 * Die Modell-Doubles hier sind bewusst kleine, eigene Kopien der Muster aus
 * `runtime/loop/loop.test.ts` (Auftrag S18a/S18b) — nicht von dort importiert: eine Testdatei
 * ist kein Modul, von dem Produktions- oder Eval-Code abhängen sollte (dieselbe Trennung, aus
 * der `runtime/loop/scripted.ts` überhaupt existiert).
 */

export const FIXED_USAGE = {
  inputTokens: 20,
  outputTokens: 10,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

/** Antwortet immer ohne Werkzeugaufruf. */
export function plainTextModel(text: string, model: string): ModelClient {
  return {
    model,
    async complete() {
      return {
        model,
        stopReason: "end_turn",
        text,
        toolCalls: [],
        usage: FIXED_USAGE,
        content: [{ type: "text", text }],
      };
    },
  };
}

/** Antwortet auf jede Zusammenfassungsanfrage (Kontextstufe 3, S18a) mit den sechs Abschnitten. */
export function fixedSummaryModel(model: string): ModelClient {
  const text = [
    "ZIEL: die Datei viele Male lesen.",
    "STAND: mehrere Leseläufe abgeschlossen.",
    "OFFENE_AUFGABEN: weitere Leseläufe.",
    "ENTSCHEIDUNGEN: keine.",
    "ARTEFAKT_REFS: keine.",
    "NAECHSTER_SCHRITT: weiterlesen.",
  ].join("\n");
  return {
    model,
    async complete() {
      return {
        model,
        stopReason: "end_turn",
        text,
        toolCalls: [],
        usage: { inputTokens: 60, outputTokens: 30, cacheReadTokens: 0, cacheCreationTokens: 0 },
        content: [{ type: "text", text }],
      };
    },
  };
}

/**
 * Liest dieselbe Datei wiederholt, bis `totalSteps` erreicht ist. Zählt den Fortschritt in
 * einem eigenen Zähler und **nicht** an der (möglicherweise kompaktierten) gesendeten Historie
 * — anders als `createScriptedModel` (`runtime/loop/scripted.ts`, das an `tool_result`-Blöcken
 * in der Historie zählt): Kontextstufe 3 nimmt genau solche Blöcke aus der gesendeten Historie
 * heraus, und ein Drehbuch, das daraus seinen nächsten Schritt herleitet, verwechselte "vom
 * Modell noch nicht gesehen" mit "kompaktiert" und liefe nie fertig.
 */
export function manyReadsModel(totalSteps: number, filePath: string, model: string): ModelClient {
  let done = 0;
  let first = true;
  return {
    model,
    async complete(request: ModelRequest) {
      const prefix =
        request.system.reduce((sum, block) => sum + block.text.length, 0) +
        request.tools.reduce((sum, tool) => sum + JSON.stringify(tool).length, 0);
      const prefixTokens = Math.ceil(prefix / 4);
      const usage = {
        inputTokens: Math.ceil(JSON.stringify(request.messages).length / 4),
        outputTokens: 30,
        cacheReadTokens: first ? 0 : prefixTokens,
        cacheCreationTokens: first ? prefixTokens : 0,
      };
      first = false;

      if (done >= totalSteps) {
        const text = `Fertig nach ${done} Leseläufen.`;
        return {
          model,
          stopReason: "end_turn" as const,
          text,
          toolCalls: [],
          usage,
          content: [{ type: "text", text }],
        };
      }

      done += 1;
      const callId = `call_read_${done}`;
      const text = `Leselauf ${done}.`;
      const toolUse: ModelContentBlock = {
        type: "tool_use",
        id: callId,
        name: "fs__read",
        input: { path: filePath },
      };
      return {
        model,
        stopReason: "tool_use" as const,
        text,
        toolCalls: [{ callId, name: "fs__read", input: { path: filePath } }],
        usage,
        content: [{ type: "text", text }, toolUse],
      };
    },
  };
}

function firstUserText(request: ModelRequest): string {
  for (const message of request.messages) {
    if (message.role !== "user") continue;
    for (const block of message.content) {
      if (block.type === "text" && typeof block.text === "string") return block.text;
    }
  }
  return "";
}

/**
 * Beantwortet normale Züge knapp, die Zusammenfassungsanfrage des Langzeitgedächtnisses
 * (erkennbar an ihrer festen Eröffnungszeile, `tools/memory/summary.ts`) mit einer echten
 * Notiz — derselbe Zweck wie `memoryRoundTripModel` in `runtime/loop/loop.test.ts` (S18b).
 */
export function memoryRoundTripModel(model: string): ModelClient {
  return {
    model,
    async complete(request) {
      const text = firstUserText(request).startsWith("Der Lauf ist zu Ende")
        ? [
            "TITEL: Lieblingscafé ist die Kornblume",
            "TAGS: café, vorlieben",
            "---",
            'Der Nutzer hat als Lieblingscafé "Kornblume" genannt.',
          ].join("\n")
        : "Notiert.";
      return {
        model,
        stopReason: "end_turn",
        text,
        toolCalls: [],
        usage: FIXED_USAGE,
        content: [{ type: "text", text }],
      };
    },
  };
}

/** Zeichnet jede an das Modell geschickte Anfrage auf. */
export function recording(client: ModelClient): { client: ModelClient; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    client: {
      model: client.model,
      complete: async (request) => {
        requests.push(request);
        return await client.complete(request);
      },
    },
  };
}

/** Löscht alles, was ein Szenario unter den übergebenen Fäden angelegt hat. */
export async function cleanupSessions(pool: Pool, threadIds: string[]): Promise<void> {
  if (threadIds.length === 0) return;
  const sessions = "SELECT session_id FROM kuronami.sessions WHERE thread_id = ANY($1)";
  await pool.query(
    `DELETE FROM kuronami.artifacts WHERE (source ->> 'session_id') IN (${sessions})`,
    [threadIds],
  );
  for (const table of ["approvals", "tasks", "steps", "events"]) {
    await pool.query(`DELETE FROM kuronami.${table} WHERE session_id IN (${sessions})`, [
      threadIds,
    ]);
  }
  await pool.query("DELETE FROM kuronami.sessions WHERE thread_id = ANY($1)", [threadIds]);
}

/** Kleiner Baustein, damit jedes Szenario dieselbe Form für seine Prüfungen benutzt. */
export function check(name: string, passed: boolean, detail?: string): EvalCheck {
  return { name, passed, detail };
}

export type MetricRecord = Record<string, EvalMetricValue>;
