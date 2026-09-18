import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { BEDIENSTETE, type BedienstetenName, WERKSTATT } from "../context/bedienstete.js";
import { createLesePostfach } from "./postfach-werkzeuge.js";
import { konten } from "./postfach.js";

/**
 * Das Gesindehaus: **ein** Werkzeug für Kuro, dahinter das ganze Personal.
 *
 * Der naheliegende Weg wäre die `agents`-Option des SDK gewesen — und genau den bin ich zuerst
 * gegangen. Er hat einen Haken, den erst die Messung zeigte: `disallowedTools` wirkt **global**.
 * Damit die Werkstatt bauen kann, muss `Bash` im ganzen Lauf erlaubt sein, und dann steht es
 * auch in Kuros Katalog. Seine Grundlast stieg dadurch von 13.500 auf 24.700 Token — bei jeder
 * Nachricht, auch bei „wie ist das Wetter". Der Butler wurde für die Werkzeuge seiner
 * Bediensteten mitbezahlt.
 *
 * Deshalb hier ein eigener Weg: Kuro sieht **ein** Werkzeug, `beauftrage`. Dahinter startet
 * jeder Bedienstete seinen **eigenen** Lauf mit eigenem System-Prompt, eigenem Werkzeugkasten
 * und eigenem Modell. Kuros Katalog und die Werkzeuge des Personals haben damit nichts mehr
 * miteinander zu tun — genau die Trennung, die ein Haushalt ohnehin hat: der Butler weiß, wen
 * er ruft, nicht womit der arbeitet.
 *
 * Nebeneffekt, der zur Architektur passt: was ein Bediensteter liest, denkt und aufruft, bleibt
 * in seinem Lauf. Bei Kuro kommt nur der Schlussbericht an.
 */

export interface HausDeps {
  /** Damit die Oberfläche anzeigen kann, wer gerade arbeitet. */
  onArbeitet?(wer: string, auftrag: string): void;
  onFertig?(wer: string, kostenUsd: number, dauerMs: number): void;
  /**
   * Ein Bericht, der zu spät kam, um noch in die laufende Antwort zu passen.
   *
   * Der Butler soll einen Auftrag abgeben können, ohne dass Jakob vor einem offenen Fenster
   * sitzt: ein Marktbericht brauchte 201 Sekunden, und solange stand das Gespräch. Wer hier
   * zuhört, trägt den Bericht nach — Kuro fängt dazu einen neuen Zug an und sagt ihn an.
   */
  onNachgereicht?(wer: string, bericht: string): void;
}

/** Obergrenze je Auftrag. Ein missverstandener Satz soll keine Kaskade auslösen. */
const BUDGET_JE_AUFTRAG = Number(process.env.KURO_BUDGET_AUFTRAG_USD ?? 2);

/**
 * So lange wartet der Butler am Tisch, bevor er weitergeht.
 *
 * Kurze Aufträge — ein Kurs, eine Mail, eine Nachfrage — sind darunter fertig und kommen
 * sofort zurück; da wäre ein „ich melde mich später" albern. Alles Längere läuft weiter,
 * und Kuro sagt Bescheid, statt Jakob warten zu lassen.
 */
const GEDULD_MS = Number(process.env.KURO_GEDULD_MS ?? 25_000);

export function createHaus(deps: HausDeps = {}) {
  const namen = Object.keys(BEDIENSTETE) as [BedienstetenName, ...BedienstetenName[]];

  const beauftrage = tool(
    "beauftrage",
    // Diese Beschreibung ist das, woran Kuro seine Wahl trifft — sie ist der eigentliche
    // "Katalog des Personals" und deshalb ausführlicher als der Rest.
    [
      "Einen Bediensteten des Hauses mit einer Aufgabe betrauen und seinen Bericht abwarten.",
      "",
      ...namen.map((name) => `- ${name}: ${BEDIENSTETE[name].description}`),
      "",
      "Der Auftrag muss für sich stehen: der Bedienstete kennt das Gespräch mit Jakob nicht.",
      "Nenne also alles, was er wissen muss — Namen, Zahlen, Fristen, was zuvor vereinbart wurde.",
    ].join("\n"),
    {
      wer: z.enum(namen).describe("Welcher Bedienstete."),
      auftrag: z
        .string()
        .min(10)
        .describe("Die Aufgabe, vollständig und aus sich heraus verständlich."),
    },
    async ({ wer, auftrag }) => {
      const person = BEDIENSTETE[wer];
      deps.onArbeitet?.(wer, auftrag);
      const start = Date.now();

      // Der eigentliche Lauf. Er wird **nicht** abgebrochen, wenn die Geduld abläuft — er
      // läuft zu Ende und meldet sich dann über `onNachgereicht`.
      const lauf = fuehreAus(wer, person, auftrag, deps, start);

      const abgewartet = await Promise.race([
        lauf.then((ergebnis) => ({ fertig: true as const, ergebnis })),
        new Promise<{ fertig: false }>((resolve) =>
          setTimeout(() => resolve({ fertig: false }), GEDULD_MS).unref?.(),
        ),
      ]);

      if (abgewartet.fertig) {
        return { content: [{ type: "text" as const, text: abgewartet.ergebnis }] };
      }

      // Zu lang. Der Auftrag läuft weiter; sein Ergebnis wird nachgereicht.
      void lauf.then((ergebnis) => deps.onNachgereicht?.(wer, ergebnis));
      return {
        content: [
          {
            type: "text" as const,
            text:
              `${wer} arbeitet noch daran. Das dauert länger als einen Augenblick — sage Jakob ` +
              `zu, dass du dich mit dem Ergebnis meldest, sobald es da ist, und rede normal ` +
              `weiter. Der Bericht kommt von selbst zu dir; frage nicht nach und warte nicht.`,
          },
        ],
      };
    },
    { annotations: { title: "Bediensteten beauftragen" } },
  );

  return createSdkMcpServer({
    name: "haus",
    version: "1",
    instructions:
      "Das Personal des Hauses. Über `beauftrage` gibst du eine Aufgabe ab und bekommst einen " +
      "Bericht zurück; was dazwischen passiert, betrifft dich nicht. Dauert ein Auftrag länger, " +
      "sagst du das zu und bekommst den Bericht später nachgereicht.",
    tools: [beauftrage],
  });
}

/** Ein Bedienstetenlauf, von Anfang bis Bericht. */
async function fuehreAus(
  wer: string,
  person: (typeof BEDIENSTETE)[BedienstetenName],
  auftrag: string,
  deps: HausDeps,
  start: number,
): Promise<string> {
  let bericht = "";
  let kosten = 0;

  try {
    for await (const nachricht of query({
      prompt: auftrag,
      options: {
        cwd: WERKSTATT,
        // Der Bedienstete bekommt **seinen** Prompt, nicht Kuros. Er ist kein Butler.
        systemPrompt: { type: "custom", prompt: person.prompt },
        model: person.model,
        ...(person.tools
          ? {
              allowedTools:
                wer === "korrespondenz"
                  ? [...person.tools, "mcp__postfach__liste", "mcp__postfach__lies", "mcp__postfach__entwurf"]
                  : person.tools,
            }
          : {}),
        // Hier — und nur hier — darf die Werkzeugbeschränkung greifen: sie betrifft
        // diesen einen Lauf und nicht Kuros Katalog.
        ...(person.disallowedTools ? { disallowedTools: person.disallowedTools } : {}),
        maxBudgetUsd: BUDGET_JE_AUFTRAG,
        ...(person.maxTurns ? { maxTurns: person.maxTurns } : {}),
        // Die Postfächer gehören dem Sekretär. Kein anderer Bediensteter bekommt sie —
        // die Börse hat in Jakobs Post nichts zu suchen.
        ...(wer === "korrespondenz" ? { mcpServers: { postfach: createLesePostfach() } } : {}),
      },
    })) {
      if (nachricht.type === "assistant" && nachricht.parent_tool_use_id === null) {
        for (const block of nachricht.message.content) {
          if (block.type === "text") bericht += block.text;
        }
      }
      if (nachricht.type === "result" && nachricht.subtype === "success") {
        kosten = nachricht.total_cost_usd;
      }
    }
  } catch (error) {
    const grund = error instanceof Error ? error.message : String(error);
    return `${wer} konnte den Auftrag nicht ausführen: ${grund}`;
  }

  deps.onFertig?.(wer, kosten, Date.now() - start);
  return bericht.trim() || `${wer} hat nichts berichtet.`;
}

/** Der Werkzeugname, wie er in `allowedTools` stehen muss. */
export const BEAUFTRAGE_TOOL = "mcp__haus__beauftrage";
