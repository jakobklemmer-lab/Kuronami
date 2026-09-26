import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { HANDELSTISCH, type HandelstischName, WERKSTATT } from "../context/bedienstete.js";
import { redactText } from "../runtime/redaction/redact.js";
import { crvVermerk } from "./crv.js";
import { CRV_TOOL, createKurse } from "./kurse.js";
import { createLabor } from "./labor.js";
import type { Papierhandel } from "./papierhandel.js";
import { sandkastenOptionen } from "./sandkasten.js";
import type { StrategienArchiv } from "./strategien.js";
import { type Posten, ausErgebnis } from "./verbrauch.js";

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

/**
 * Der Stratege ist die Ausnahme. Eine Strategie zu entwickeln heißt: Regel aufstellen, rechnen
 * lassen, Ergebnis lesen, Regel ändern — ein Dutzend Runden, jede mit einer Kerzentabelle
 * darin. Mit dem Budget einer Zuarbeit käme er über die erste Variante nicht hinaus, und eine
 * abgebrochene Prüfung ist schlimmer als keine: sie sieht aus wie ein Ergebnis.
 */
const BUDGET_STRATEGE = Number(process.env.KURO_BUDGET_STRATEGE_USD ?? 2.5);

export interface HandelstischDeps {
  /** Das Strategie-Archiv — ohne es fehlen dem Strategen die Ablage-Werkzeuge. */
  strategien?: StrategienArchiv;
  /**
   * Der Papierhandel. Die Spezialisten dürfen **zusehen**, nicht starten: wer eine Strategie
   * in den Betrieb gibt, hat sie selbst geprüft — und genau das soll hier getrennt bleiben.
   */
  papier?: Papierhandel;
  onArbeitet?(wer: string, frage: string): void;
  onFertig?(wer: string, kostenUsd: number, dauerMs: number): void;
  /** Was ein Spezialist verbraucht hat — das Gesindehaus trägt ein, in wessen Auftrag. */
  onVerbrauch?(posten: Posten): void;
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
      let verbraucht: ReturnType<typeof ausErgebnis> | null = null;
      const bucheVerbrauch = (): void => {
        if (verbraucht) {
          deps.onVerbrauch?.({
            zeit: new Date().toISOString(),
            wer: wen,
            ...verbraucht,
            dauerMs: Date.now() - start,
          });
        }
      };
      // Hat dieser Lauf wirklich gerechnet? Siehe `crv.ts` — eine behauptete Kennzahl ohne
      // Rechnung bekommt ihr Etikett, statt als Befund durchzugehen.
      let crvGerechnet = false;

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
            mcpServers: {
              kurse: createKurse(),
              // Das Labor: Wiedergabe, Rückblick, Backtest, Strategie-Ablage. Es steht nur
              // hier — Kuros Katalog bleibt frei davon.
              labor: createLabor({
                workdir: WERKSTATT,
                wer: wen,
                ...(deps.strategien ? { strategien: deps.strategien } : {}),
                ...(deps.papier ? { papier: deps.papier, darfStarten: false } : {}),
              }),
            },
            maxBudgetUsd: wen === "stratege" ? BUDGET_STRATEGE : BUDGET_JE_FRAGE,
            // Ein Spezialist beantwortet eine Frage; er führt kein Projekt. Die Grenze hält
            // ihn davon ab, sich in eine Recherche zu vertiefen, die niemand bestellt hat —
            // nur der Stratege braucht Runden, weil Prüfen aus Wiederholen besteht.
            maxTurns: person.maxTurns ?? 12,
          },
        })) {
          if (nachricht.type === "assistant" && nachricht.parent_tool_use_id === null) {
            for (const block of nachricht.message.content) {
              if (block.type === "tool_use" && block.name === CRV_TOOL) crvGerechnet = true;
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
          if (nachricht.type === "result") {
            if (nachricht.subtype === "success") kosten = nachricht.total_cost_usd;
            verbraucht = ausErgebnis(nachricht);
          }
        }
      } catch (error) {
        bucheVerbrauch();
        const grund = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: "text" as const, text: redactText(`${wen} konnte nicht antworten: ${grund}`) },
          ],
        };
      }

      bucheVerbrauch();
      deps.onFertig?.(wen, kosten, Date.now() - start);
      const antwort = crvVermerk(
        redactText((bloecke[bloecke.length - 1] ?? "").trim()),
        crvGerechnet,
      );
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
