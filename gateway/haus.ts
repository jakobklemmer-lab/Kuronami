import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  BEDIENSTETE,
  type BedienstetenName,
  WERKSTATT,
  ZUSATZ_DOMAENEN,
} from "../context/bedienstete.js";
import { redactText } from "../runtime/redaction/redact.js";
import { crvVermerk } from "./crv.js";
import { FRAGE_TEAM_TOOL, createHandelstisch } from "./handelstisch.js";
import { CRV_TOOL, KURSE_TOOLS, createKurse } from "./kurse.js";
import { createLabor } from "./labor.js";
import type { Papierhandel } from "./papierhandel.js";
import { createLesePostfach } from "./postfach-werkzeuge.js";
import { konten } from "./postfach.js";
import { sandkastenOptionen } from "./sandkasten.js";
import type { StrategienArchiv } from "./strategien.js";

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
 * in seinem Lauf. Bei Kuro kommt nur der Schlussbericht an — **aber nicht mehr stumm.** Seit
 * dem 2026-09-20 geht jeder Zwischensatz als Fortschritt hinaus, während er entsteht; vorher
 * klebten sie alle vorn am Schlussbericht, wo sie niemandem mehr halfen. Jakob wörtlich:
 * „irgendwie fühlt sich das ziemlich uninteraktiv an, wenn das so lange dauert, ohne dass ich
 * Bescheid weiß, was passiert."
 */

export interface HausDeps {
  /** Das Strategie-Archiv — der Stratege am Handelstisch legt dort ab. */
  strategien?: StrategienArchiv;
  /** Der Papierhandel — der Chefanalyst darf starten, der Tisch darf zusehen. */
  papier?: Papierhandel;
  /** Damit die Oberfläche anzeigen kann, wer gerade arbeitet. */
  onArbeitet?(wer: string, auftrag: string): void;
  onFertig?(wer: string, kostenUsd: number, dauerMs: number): void;
  /**
   * Ein Zwischenstand, während der Auftrag läuft.
   *
   * `wer` ist der Bedienstete, `wobei` der Spezialist, falls einer zuarbeitet — damit die
   * Oberfläche „boerse → technik" zeigen kann statt nur „boerse".
   */
  onFortschritt?(wer: string, text: string, wobei?: string): void;
  /**
   * Ein Bericht, der zu spät kam, um noch in die laufende Antwort zu passen.
   *
   * Der Butler soll einen Auftrag abgeben können, ohne dass Jakob vor einem offenen Fenster
   * sitzt: ein Marktbericht brauchte 201 Sekunden, und solange stand das Gespräch. Wer hier
   * zuhört, trägt den Bericht nach — Kuro fängt dazu einen neuen Zug an und sagt ihn an.
   */
  onNachgereicht?(wer: string, bericht: string): void;
  /**
   * Ein fertiger Bericht, der ins Archiv gehört — damit Jakob ihn vor einem Trade nachlesen
   * kann. Siehe `analysen.ts`; `beitraege` sind die Zuarbeiten der Spezialisten.
   */
  onAnalyse?(eintrag: {
    wer: string;
    auftrag: string;
    bericht: string;
    beitraege: Array<{ wer: string; frage: string; antwort: string }>;
    kostenUsd: number;
    dauerMs: number;
    /** Ob eine genannte Chance-Risiko-Kennzahl gerechnet wurde (`gateway/crv.ts`). */
    crvGerechnet?: boolean;
  }): void;
}

/** Obergrenze je Auftrag. Ein missverstandener Satz soll keine Kaskade auslösen. */
const BUDGET_JE_AUFTRAG = Number(process.env.KURO_BUDGET_AUFTRAG_USD ?? 2);

/**
 * So lange wartet der Butler am Tisch, bevor er weitergeht — je Bedienstetem.
 *
 * Vorher galt eine Zahl für alle: 25 Sekunden. Die hat jeder Auftrag voll verbraucht, bevor
 * Kuro überhaupt „Sehr wohl" sagen konnte — gemessen am 2026-09-20 dauerte die reine Zusage
 * 29,6 / 30,6 / 32,0 / 32,5 / 33,6 Sekunden, und Jakob fragte in die Stille hinein „Hallo,
 * Kuro?". Die Zahl war für den Sekretär richtig (30–60 s, da lohnt das Warten) und für den
 * Handelstisch falsch (an dem Tag 183, 188 und 594 s — der war nie unter drei Minuten fertig).
 *
 * Also je Bedienstetem: wer erfahrungsgemäß in einem Atemzug antwortet, wird abgewartet; wer
 * nie in einem Atemzug antwortet, wird zugesagt und nachgereicht.
 */
const GEDULD_MS: Record<string, number> = {
  korrespondenz: Number(process.env.KURO_GEDULD_KORRESPONDENZ_MS ?? 25_000),
  recherche: Number(process.env.KURO_GEDULD_RECHERCHE_MS ?? 20_000),
  boerse: Number(process.env.KURO_GEDULD_BOERSE_MS ?? 4_000),
  werkstatt: Number(process.env.KURO_GEDULD_WERKSTATT_MS ?? 4_000),
};

function geduldFuer(wer: string): number {
  return GEDULD_MS[wer] ?? Number(process.env.KURO_GEDULD_MS ?? 25_000);
}

/** Ein Auftrag, der gerade läuft. Daraus beantwortet Kuro „wie weit ist er?". */
export interface LaufenderAuftrag {
  wer: string;
  auftrag: string;
  begonnen: number;
  /** Der letzte Zwischensatz — oder der letzte Spezialist, der gerufen wurde. */
  stand: string;
  /** Wen der Bedienstete bisher zugezogen hat. */
  zuarbeit: string[];
  abbrechen(): void;
}

export interface Haus {
  server: ReturnType<typeof createSdkMcpServer>;
  /** Was gerade läuft — für Kuros `stand`-Werkzeug und die Oberfläche. */
  laufende(): LaufenderAuftrag[];
  /** Einen laufenden Auftrag abbrechen. `true`, wenn einer lief. */
  abbrechen(wer?: string): boolean;
}

export function createHaus(deps: HausDeps = {}): Haus {
  const namen = Object.keys(BEDIENSTETE) as [BedienstetenName, ...BedienstetenName[]];
  const laufend = new Map<string, LaufenderAuftrag>();

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
      const abbruch = new AbortController();
      const eintrag: LaufenderAuftrag = {
        wer,
        auftrag,
        begonnen: Date.now(),
        stand: "fängt an",
        zuarbeit: [],
        abbrechen: () => abbruch.abort(),
      };
      laufend.set(wer, eintrag);
      deps.onArbeitet?.(wer, auftrag);
      const start = Date.now();

      const melde = (text: string, wobei?: string): void => {
        eintrag.stand = wobei ? `${wobei}: ${text}` : text;
        if (wobei && !eintrag.zuarbeit.includes(wobei)) eintrag.zuarbeit.push(wobei);
        deps.onFortschritt?.(wer, redactText(text), wobei);
      };

      // Der eigentliche Lauf. Er wird **nicht** abgebrochen, wenn die Geduld abläuft — er
      // läuft zu Ende und meldet sich dann über `onNachgereicht`.
      const lauf = fuehreAus(wer, person, auftrag, deps, start, melde, abbruch).finally(() => {
        if (laufend.get(wer) === eintrag) laufend.delete(wer);
      });

      const abgewartet = await Promise.race([
        lauf.then((ergebnis) => ({ fertig: true as const, ergebnis })),
        new Promise<{ fertig: false }>((resolve) =>
          setTimeout(() => resolve({ fertig: false }), geduldFuer(wer)).unref?.(),
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
            text: `${wer} arbeitet noch daran. Das dauert länger als einen Augenblick — sage Jakob zu, dass du dich mit dem Ergebnis meldest, sobald es da ist, und rede normal weiter. Der Bericht kommt von selbst zu dir; frage nicht nach und warte nicht. Willst du wissen, wie weit er ist, nimm \`stand\`.`,
          },
        ],
      };
    },
    { annotations: { title: "Bediensteten beauftragen" } },
  );

  /**
   * „Wie weit ist er?"
   *
   * Am 2026-09-20 musste Kuro darauf siebenmal passen — „ich sehe nicht, woran der
   * Chefanalyst gerade arbeitet", „ich habe keine Möglichkeit, ihn anzustupsen". Beides
   * stimmte, und beides war unnötig: der Gateway kennt Startzeit, Zwischenstand und
   * Zuarbeiter. Jetzt kann er antworten, und zwar mit Zahlen.
   */
  const stand = tool(
    "stand",
    "Nachsehen, was die Bediensteten gerade tun — Laufzeit, Zwischenstand, wer zuarbeitet. " +
      "Nimm das, wenn Jakob fragt, wie lange es noch dauert oder woran gerade gearbeitet wird.",
    {},
    async () => {
      const alle = [...laufend.values()];
      if (alle.length === 0) {
        return {
          content: [{ type: "text" as const, text: "Niemand arbeitet gerade an einem Auftrag." }],
        };
      }
      const zeilen = alle.map((a) => {
        const sekunden = Math.round((Date.now() - a.begonnen) / 1000);
        const dauer = sekunden < 90 ? `${sekunden} s` : `${Math.round(sekunden / 60)} min`;
        const zu = a.zuarbeit.length > 0 ? `, zugezogen: ${a.zuarbeit.join(", ")}` : "";
        return `${a.wer}: seit ${dauer} — ${redactText(a.stand)}${zu}`;
      });
      return { content: [{ type: "text" as const, text: zeilen.join("\n") }] };
    },
    { annotations: { title: "Stand der Aufträge", readOnlyHint: true } },
  );

  const abbrechenTool = tool(
    "abbrechen",
    "Einen laufenden Auftrag abbrechen — wenn Jakob ihn zurückzieht, es ihm zu lange dauert " +
      "oder die Frage sich erledigt hat. Ohne Namen wird alles abgebrochen.",
    {
      wer: z.enum(namen).optional().describe("Welcher Auftrag. Weglassen bricht alle ab."),
    },
    async ({ wer }) => {
      const getroffen = abbrechen(wer);
      return {
        content: [
          {
            type: "text" as const,
            text: getroffen
              ? `Abgebrochen${wer ? `: ${wer}` : ""}. Es kommt kein Bericht mehr.`
              : "Es lief nichts, was abzubrechen wäre.",
          },
        ],
      };
    },
    { annotations: { title: "Auftrag abbrechen" } },
  );

  function abbrechen(wer?: string): boolean {
    const ziele = wer ? [laufend.get(wer)].filter((x) => x !== undefined) : [...laufend.values()];
    for (const ziel of ziele) ziel.abbrechen();
    return ziele.length > 0;
  }

  return {
    server: createSdkMcpServer({
      name: "haus",
      version: "1",
      instructions:
        "Das Personal des Hauses. Über `beauftrage` gibst du eine Aufgabe ab und bekommst einen " +
        "Bericht zurück; was dazwischen passiert, betrifft dich nicht. Dauert ein Auftrag länger, " +
        "sagst du das zu und bekommst den Bericht später nachgereicht — `stand` sagt dir " +
        "währenddessen, wie weit er ist, `abbrechen` zieht ihn zurück.",
      tools: [beauftrage, stand, abbrechenTool],
    }),
    laufende: () => [...laufend.values()],
    abbrechen,
  };
}

/** Ein Bedienstetenlauf, von Anfang bis Bericht. */
async function fuehreAus(
  wer: string,
  person: (typeof BEDIENSTETE)[BedienstetenName],
  auftrag: string,
  deps: HausDeps,
  start: number,
  melde: (text: string, wobei?: string) => void,
  abbruch: AbortController,
): Promise<string> {
  /**
   * Jeder Textblock für sich — und **der letzte ist der Bericht.**
   *
   * Vorher wurde alles aneinandergehängt. Deshalb stand in Kuros Kontext „Ich beginne mit
   * `liste` für alle drei Konten…", „Die WebFetch-Zusammenfassungen sind widersprüchlich…"
   * und dann erst der Bericht — die Zwischenstände kamen also an, nur zum falschen Zeitpunkt
   * und an der falschen Stelle. Jetzt gehen sie live hinaus und bleiben aus dem Bericht
   * heraus.
   */
  const bloecke: string[] = [];
  const beitraege: Array<{ wer: string; frage: string; antwort: string }> = [];
  let kosten = 0;
  /** Wurde das Chance-Risiko-Verhältnis in diesem Lauf gerechnet oder nur behauptet? */
  let crvGerechnet = false;

  const zusatz = ZUSATZ_DOMAENEN[wer];

  try {
    for await (const nachricht of query({
      prompt: auftrag,
      options: {
        cwd: WERKSTATT,
        // Der Bedienstete bekommt **seinen** Prompt, nicht Kuros. Er ist kein Butler.
        systemPrompt: { type: "custom", prompt: person.prompt },
        model: person.model,
        abortController: abbruch,
        // Werkzeuge und Sandkasten in einem: `sandkastenOptionen` entscheidet auch, ob dieser
        // Lauf Bash bekommt — trägt der Sandkasten auf diesem Rechner nicht, fliegt es aus dem
        // Katalog, statt ungeschützt als root zu laufen. Siehe `sandkasten.ts`.
        // Hier — und nur hier — greift die Werkzeugbeschränkung: sie betrifft diesen einen
        // Lauf und nicht Kuros Katalog.
        ...sandkastenOptionen(
          wer,
          eigeneWerkzeuge(wer, person.tools),
          person.disallowedTools,
          zusatz,
        ),
        maxBudgetUsd: BUDGET_JE_AUFTRAG,
        ...(person.maxTurns ? { maxTurns: person.maxTurns } : {}),
        // Werkzeuge, die nur einem gehören. Die Postfächer hat der Sekretär — die Börse hat
        // in Jakobs Post nichts zu suchen; den Handelstisch hat die Börse — Kuro soll die
        // Spezialisten weder kennen noch einzeln beauftragen können.
        ...(wer === "korrespondenz" ? { mcpServers: { postfach: createLesePostfach() } } : {}),
        ...(wer === "boerse"
          ? {
              mcpServers: {
                kurse: createKurse(),
                // Der Chefanalyst bekommt das Labor **lesend**: Rückblick auf eine alte Idee
                // und der Blick von damals gehören zu seiner täglichen Arbeit. Ablegen darf
                // dort nur der Stratege — sonst landen Einfälle im Strategie-Archiv.
                labor: createLabor({
                  workdir: WERKSTATT,
                  wer: "boerse",
                  ...(deps.papier ? { papier: deps.papier, darfStarten: true } : {}),
                }),
                tisch: createHandelstisch({
                  ...(deps.strategien ? { strategien: deps.strategien } : {}),
                  ...(deps.papier ? { papier: deps.papier } : {}),
                  onArbeitet: (wen, frage) => {
                    console.log(`[tisch] ${wen}: ${redactText(frage.slice(0, 80))}`);
                    melde("fängt an", wen);
                  },
                  onFortschritt: (wen, text) => melde(text, wen),
                  onFertig: (wen, k, d) => {
                    console.log(
                      `[tisch] ${wen} fertig nach ${(d / 1000).toFixed(1)}s, $${k.toFixed(4)}`,
                    );
                    melde("ist fertig", wen);
                  },
                  onAntwort: (wen, frage, antwort) => beitraege.push({ wer: wen, frage, antwort }),
                }),
              },
            }
          : {}),
      },
    })) {
      if (nachricht.type === "assistant" && nachricht.parent_tool_use_id === null) {
        for (const block of nachricht.message.content) {
          if (block.type === "tool_use" && block.name === CRV_TOOL) crvGerechnet = true;
          if (block.type === "text" && block.text.trim() !== "") {
            // Was jetzt kommt, ist ein Zwischenstand — der vorherige Block war es
            // rückblickend auch. Nur der letzte bleibt am Ende als Bericht stehen.
            const vorheriger = bloecke[bloecke.length - 1];
            if (vorheriger !== undefined) melde(kurzfassung(vorheriger));
            bloecke.push(block.text);
          }
        }
      }
      if (nachricht.type === "result" && nachricht.subtype === "success") {
        kosten = nachricht.total_cost_usd;
      }
    }
  } catch (error) {
    // `onFertig` gehört auch hierher: die Oberfläche nimmt den Bediensteten erst auf dieses
    // Ereignis hin wieder aus der Arbeitsleiste. Ohne das bliebe ein abgebrochener oder
    // gescheiterter Auftrag dort für immer stehen und zählte weiter hoch.
    deps.onFertig?.(wer, kosten, Date.now() - start);
    if (abbruch.signal.aborted) {
      return `${wer} hat den Auftrag auf Zuruf abgebrochen.`;
    }
    const grund = error instanceof Error ? error.message : String(error);
    // Auch die Fehlermeldung: eine gescheiterte Anmeldung nennt gern den Schlüssel, mit dem
    // sie es versucht hat.
    return redactText(`${wer} konnte den Auftrag nicht ausführen: ${grund}`);
  }

  const dauerMs = Date.now() - start;
  deps.onFertig?.(wer, kosten, dauerMs);

  // Der Filter aus `runtime/redaction` — beim Motorwechsel war er ausgefallen und wird hier
  // wieder angeschlossen, an der Stelle, an der er jetzt zählt: **die Grenze zwischen einem
  // Bedienstetenlauf und Kuros dauerhafter Sitzung.** Ein Sekretär, der eine Mail mit einem
  // Zugangsschlüssel zitiert, oder eine Werkstatt, die eine Konfigurationsdatei liest, trüge
  // das Geheimnis sonst in eine Unterhaltung, die auf der Platte liegt und nie endet.
  //
  // Bewusst **nicht** auf Kuros eigene Antwort an Jakob angewandt: fragt der Hausherr nach
  // etwas, das er selbst hinterlegt hat, wäre ein `[redacted]` keine Sicherheit, sondern
  // eine Schikane.
  const bericht = crvVermerk(redactText((bloecke[bloecke.length - 1] ?? "").trim()), crvGerechnet);
  if (bericht.trim() === "") return `${wer} hat nichts berichtet.`;

  deps.onAnalyse?.({
    wer,
    auftrag,
    bericht,
    beitraege,
    kostenUsd: kosten,
    dauerMs,
    crvGerechnet: crvGerechnet || undefined,
  });
  return bericht;
}

/**
 * Die Werkzeuge, die nur einem gehören.
 *
 * Die Postfächer hat der Sekretär — die Börse hat in Jakobs Post nichts zu suchen; den
 * Handelstisch hat die Börse — Kuro soll die Spezialisten weder kennen noch einzeln
 * beauftragen können.
 */
function eigeneWerkzeuge(wer: string, tools: string[] | undefined): string[] | undefined {
  if (!tools) return undefined;
  if (wer === "korrespondenz") {
    return [...tools, "mcp__postfach__liste", "mcp__postfach__lies", "mcp__postfach__entwurf"];
  }
  if (wer === "boerse") return [...tools, FRAGE_TEAM_TOOL];
  return tools;
}

/** Ein Zwischenstand ist eine Zeile, kein Absatz. */
function kurzfassung(text: string): string {
  const erster = text.trim().split("\n")[0]?.trim() ?? "";
  return erster.length > 120 ? `${erster.slice(0, 117)}…` : erster;
}

/** Der Werkzeugname, wie er in `allowedTools` stehen muss. */
export const BEAUFTRAGE_TOOL = "mcp__haus__beauftrage";
export const HAUS_TOOLS = [BEAUFTRAGE_TOOL, "mcp__haus__stand", "mcp__haus__abbrechen"];

/** Damit `kurse` auch dort erlaubt ist, wo es gebraucht wird. */
export { KURSE_TOOLS };
