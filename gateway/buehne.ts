import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

/**
 * Die Bühne: Kuro zeigt etwas.
 *
 * In der Präsenz-Oberfläche liegen keine Karten herum. Wetter, Kurse, Post, Kalender,
 * Systemstand — das alles erscheint nur, wenn es gerade gebraucht wird, und verschwindet
 * wieder. Wer entscheidet, was gebraucht wird? Der Butler, nicht ein Layout: Jakob fragt „wie
 * steht der DAX", Kuro antwortet **und** stellt die Kurstafel hin, so wie ein Butler die Zeitung
 * aufgeschlagen auf den Tisch legt, statt sie vorzulesen.
 *
 * Technisch ist das ein Werkzeug mit zwei Handgriffen, `zeige` und `verberge`, das nichts
 * berechnet — es sagt der Oberfläche über den Ereignisbus, was sie einblenden soll. Die Daten
 * holt die Oberfläche selbst über dieselben `/integrations/*`-Routen wie das Dashboard. So
 * bleibt der Butler billig (das Werkzeug kostet ein paar hundert Token Katalog, nicht die
 * Daten) und die Oberfläche ehrlich (sie zeigt, was der Gateway wirklich weiß).
 */

export const TAFELN = ["wetter", "kurse", "post", "kalender", "system"] as const;
export type Tafel = (typeof TAFELN)[number];

export interface BuehneDeps {
  /** Ein Ereignis an die Oberfläche. `type` ist `ui.zeige` oder `ui.verberge`. */
  publish(type: string, data: Record<string, unknown>): void;
}

export function createBuehne(deps: BuehneDeps) {
  const zeige = tool(
    "zeige",
    [
      "Jakob eine Tafel hinstellen — sie erscheint neben dir auf der Oberfläche.",
      "",
      "- wetter: aktuelle Lage und die nächsten Tage",
      "- kurse: die Beobachtungsliste mit Kursen",
      "- post: die letzten Nachrichten aus allen Postfächern",
      "- kalender: die nächsten Termine",
      "- system: Auslastung des Rechners",
      "",
      "Tu das, wenn Jakob danach fragt oder wenn ein Blick auf die Tafel mehr sagt als deine",
      "Worte. Nicht ungefragt zur Begrüßung — die Ruhe der Oberfläche ist Absicht.",
    ].join("\n"),
    {
      tafel: z.enum(TAFELN),
      hinweis: z
        .string()
        .max(120)
        .optional()
        .describe("Ein kurzer Satz über der Tafel, wenn einer nötig ist."),
    },
    async ({ tafel, hinweis }) => {
      deps.publish("ui.zeige", { tafel, ...(hinweis ? { hinweis } : {}) });
      return { content: [{ type: "text" as const, text: `Die Tafel „${tafel}" steht.` }] };
    },
    { annotations: { title: "Tafel zeigen", readOnlyHint: true } },
  );

  const verberge = tool(
    "verberge",
    "Alle Tafeln wieder wegnehmen. Selten nötig — sie verschwinden nach einer Weile von selbst.",
    {},
    async () => {
      deps.publish("ui.verberge", {});
      return { content: [{ type: "text" as const, text: "Die Tafeln sind weg." }] };
    },
    { annotations: { title: "Tafeln verbergen", readOnlyHint: true } },
  );

  return createSdkMcpServer({
    name: "buehne",
    version: "1",
    instructions:
      "Die Oberfläche vor Jakob. Mit `zeige` stellst du ihm eine Tafel hin, mit `verberge` " +
      "räumst du ab. Deine Worte kommen ohnehin an — die Tafel ist für das, was man besser sieht " +
      "als hört.",
    tools: [zeige, verberge],
  });
}

export const BUEHNE_TOOLS = ["mcp__buehne__zeige", "mcp__buehne__verberge"];
