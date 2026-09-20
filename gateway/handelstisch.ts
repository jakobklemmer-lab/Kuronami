import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { HANDELSTISCH, type HandelstischName, WERKSTATT } from "../context/bedienstete.js";
import { redactText } from "../runtime/redaction/redact.js";
import { createKurse } from "./kurse.js";
import { sandkastenOptionen } from "./sandkasten.js";

/**
 * Der Handelstisch: das Team hinter dem Chefanalysten.
 *
 * Dieselbe Bauweise wie das Gesindehaus eine Ebene darüber (`haus.ts`) — ein Werkzeug, hinter
 * dem eigene Läufe stehen —, aber mit zwei Regeln, die Jakob ausdrücklich gesetzt hat:
 *
 *  1. **Nur die Leitung darf rufen.** Die drei Spezialisten stehen nicht in `BEDIENSTETE`;
 *     Kuro kennt sie gar nicht. Ein Butler, der den Chartanalysten direkt anspricht, umgeht
 *     den Chefanalysten, und niemand führt mehr zusammen, was die drei sagen.
 *
 *  2. **Sie sprechen nicht untereinander.** Jeder bekommt seine Frage, arbeitet, berichtet
 *     zurück. Agenten, die einander frei befragen dürfen, erzeugen Runden, die niemand
 *     bestellt hat und deren Ende niemand absehen kann — und jede Runde kostet.
 *
 * Wer wirklich gebraucht wird, entscheidet die Leitung; ihr Prompt nennt dafür Beispiele.
 * „Wie steht der DAX" kommt ohne einen einzigen Spezialisten aus.
 */

/** Obergrenze je Spezialist. Enger als beim Gesindehaus: das hier sind Zuarbeiten, keine Aufträge. */
const BUDGET_JE_FRAGE = Number(process.env.KURO_BUDGET_TISCH_USD ?? 0.75);

export interface HandelstischDeps {
  onArbeitet?(wer: string, frage: string): void;
  onFertig?(wer: string, kostenUsd: number, dauerMs: number): void;
  /** Ein Zwischensatz aus dem Lauf eines Spezialisten, während er arbeitet. */
  onFortschritt?(wer: string, text: string): void;
  /** Frage und Antwort im Wortlaut — fürs Analysen-Archiv, nicht für die Anzeige. */
  onAntwort?(wer: string, frage: string, antwort: string): void;
}

export function createHandelstisch(deps: HandelstischDeps = {}) {
  const namen = Object.keys(HANDELSTISCH) as [HandelstischName, ...HandelstischName[]];

  const frageTeam = tool(
    "frage_team",
    [
      "Einen Spezialisten des Handelstischs befragen und seine Antwort abwarten.",
      "",
      ...namen.map((n) => `- ${n}: ${HANDELSTISCH[n].description}`),
      "",
      "Jeder Aufruf kostet. Frage nur, wen die Aufgabe wirklich verlangt — die meisten",
      "Fragen beantwortest du selbst. Die Spezialisten kennen weder das Gespräch noch",
      "einander: schreibe in die Frage alles, was sie wissen müssen.",
    ].join("\n"),
    {
      wen: z.enum(namen).describe("Welcher Spezialist."),
      frage: z
        .string()
        .min(10)
        .describe(
          "Die Frage, vollständig und aus sich heraus verständlich — mit Symbol, Zahlen, Zeitraum.",
        ),
    },
    async ({ wen, frage }) => {
      const person = HANDELSTISCH[wen];
      deps.onArbeitet?.(wen, frage);
      const start = Date.now();

      // Wie eine Ebene höher: der letzte Textblock ist die Antwort, alles davor ein
      // Zwischenstand, der sofort hinausgeht statt am Ende vorn zu kleben.
      const bloecke: string[] = [];
      let kosten = 0;

      try {
        for await (const nachricht of query({
          prompt: frage,
          options: {
            cwd: WERKSTATT,
            systemPrompt: { type: "custom", prompt: person.prompt },
            model: person.model,
            ...sandkastenOptionen(wen, person.tools, person.disallowedTools),
            // Kursdaten aus erster Hand statt durch ein Zusammenfassungsmodell — der Grund,
            // warum eine Chartanalyse am 2026-09-20 volle 279 Sekunden brauchte, lag hier.
            mcpServers: { kurse: createKurse() },
            maxBudgetUsd: BUDGET_JE_FRAGE,
            // Ein Spezialist beantwortet eine Frage; er führt kein Projekt. Die Grenze hält
            // ihn davon ab, sich in eine Recherche zu vertiefen, die niemand bestellt hat.
            maxTurns: 12,
          },
        })) {
          if (nachricht.type === "assistant" && nachricht.parent_tool_use_id === null) {
            for (const block of nachricht.message.content) {
              if (block.type === "text" && block.text.trim() !== "") {
                const vorheriger = bloecke[bloecke.length - 1];
                if (vorheriger !== undefined) {
                  const zeile = vorheriger.trim().split("\n")[0]?.trim() ?? "";
                  if (zeile !== "") deps.onFortschritt?.(wen, redactText(zeile.slice(0, 120)));
                }
                bloecke.push(block.text);
              }
            }
          }
          if (nachricht.type === "result" && nachricht.subtype === "success") {
            kosten = nachricht.total_cost_usd;
          }
        }
      } catch (error) {
        const grund = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: "text" as const, text: redactText(`${wen} konnte nicht antworten: ${grund}`) },
          ],
        };
      }

      deps.onFertig?.(wen, kosten, Date.now() - start);
      const antwort = redactText((bloecke[bloecke.length - 1] ?? "").trim());
      if (antwort === "") {
        return { content: [{ type: "text" as const, text: `${wen} hat nichts gesagt.` }] };
      }
      deps.onAntwort?.(wen, frage, antwort);
      return { content: [{ type: "text" as const, text: antwort }] };
    },
    { annotations: { title: "Spezialisten befragen" } },
  );

  return createSdkMcpServer({
    name: "tisch",
    version: "1",
    instructions:
      "Dein Handelstisch. Über `frage_team` ziehst du einen Spezialisten hinzu. Sie arbeiten " +
      "einzeln und sprechen nicht miteinander — du führst zusammen, was sie sagen.",
    tools: [frageTeam],
  });
}

/** Der Werkzeugname, wie er in `allowedTools` der Leitung stehen muss. */
export const FRAGE_TEAM_TOOL = "mcp__tisch__frage_team";
