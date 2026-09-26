import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  type NotionClient,
  NotionFehler,
  auswahl,
  createNotionClient,
  datum,
  lies,
  mehrfach,
  status as statusWert,
  text as textWert,
  titel,
  zahl,
} from "./integrations/notion.js";

/**
 * Jakobs Trading Journal in Notion — die Werkzeuge, mit denen sein Personal darin schreibt.
 *
 * **Warum das ein Bediensteter bedient und nicht Kuro selbst.** Jakobs Einwand, wörtlich:
 * „bevor wir Kuro wieder zu viel erledigen lassen gib ihm einen Notion Agenten der Notion
 * bedienen kann für ihn, sonst läuft wieder zu viel Kontext mit." Jedes Werkzeugschema hier
 * kostet in **jedem** Modellaufruf Token, auch bei „wie wird das Wetter". Der Butler trägt
 * deshalb nichts selbst ein; er gibt es weiter, wie er es mit Post und Märkten auch tut.
 *
 * **Warum ein Regelverstoß den Eintrag nicht verhindert.** Jakobs Regelseite sagt: „Bei jedem
 * Verstoß gegen diese Regeln ist der Trade automatisch als ‚Plan befolgt = Nein' markiert,
 * unabhängig vom Ergebnis." Genau das tut `journal_anlegen` — es weist nicht ab, es
 * protokolliert. Ein Journal, das unbequeme Trades nicht enthält, ist die teuerste Art von
 * Statistik: eine, die immer gut aussieht. Die Regelseite sagt es selbst — „ein Journal, das
 * nicht aktualisiert wird, ist schlechter als keines".
 */

/** Die Kennungen aus Jakobs Arbeitsbereich. Über die Umgebung überschreibbar, falls er umzieht. */
export const JOURNAL_IDS = {
  trades: process.env.NOTION_TRADES_DB ?? "<notion_trades_db>",
  lektionen: process.env.NOTION_LEKTIONEN_DB ?? "<notion_lektionen_db>",
  regeln: process.env.NOTION_REGELN_PAGE ?? "<notion_regeln_page>",
  setups: process.env.NOTION_SETUPS_PAGE ?? "<notion_setups_page>",
  watchlist: process.env.NOTION_WATCHLIST_DB ?? "<notion_watchlist_db>",
} as const;

/** Jakobs Kapitalregeln, als Zahlen — geprüft wird gegen diese, nicht gegen eine Erinnerung. */
export const KAPITALREGELN = {
  maxRisikoProzent: 1,
  maxOffenePositionen: 3,
  maxKumuliertesRisikoProzent: 3,
} as const;

export interface JournalDeps {
  notion?: NotionClient;
  /** Nur die drei Werkzeuge zum Nachsehen — für den Handelstisch, der nicht schreibt. */
  nurLesen?: boolean;
}

function antwort(inhalt: string, fehler = false) {
  return {
    content: [{ type: "text" as const, text: inhalt }],
    ...(fehler ? { isError: true } : {}),
  };
}

const NICHT_VERBUNDEN =
  "Das Trading Journal ist nicht verbunden: in der Umgebung fehlt NOTION_TOKEN. Jakob legt " +
  "dafür unter notion.so/my-integrations eine interne Integration an, trägt das Geheimnis in " +
  "den Einstellungen ein und teilt die Seite „Trading Journal“ mit ihr. Bis dahin wird hier " +
  "nichts eingetragen — und nichts behauptet.";

function heute(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Der Ergebnistext einer offenen Zeile, kurz. */
export function zeileKurz(eigenschaften: Record<string, unknown>): string {
  const nr = lies(eigenschaften["Trade-Nr"]);
  const instrument = lies(eigenschaften.Instrument);
  const richtung = lies(eigenschaften.Richtung);
  const entry = lies(eigenschaften["Entry-Preis"]);
  const stop = lies(eigenschaften["Initialer Stop"]);
  const ziel = lies(eigenschaften.Ziel);
  const risiko = lies(eigenschaften["Risiko %"]);
  const risikoText = typeof risiko === "number" ? `${risiko.toFixed(2)} %` : "—";
  return `${nr || "(ohne Nummer)"}  ${instrument || "?"} ${richtung || ""}  Entry ${entry ?? "?"}, Stop ${stop ?? "?"}, Ziel ${ziel ?? "?"}, Risiko ${risikoText}`;
}

/**
 * Welche Kapitalregeln dieser Trade verletzt — geprüft gegen die offenen Zeilen im Journal,
 * nicht gegen das Gedächtnis des Modells.
 */
export function regelverstoesse(
  neu: { risikoProzent?: number },
  offene: readonly Record<string, unknown>[],
): string[] {
  const verstoesse: string[] = [];
  const risiko = neu.risikoProzent ?? 0;
  if (risiko > KAPITALREGELN.maxRisikoProzent) {
    verstoesse.push(
      `Risiko ${risiko.toFixed(2)} % über der Grenze von ${KAPITALREGELN.maxRisikoProzent} % je Trade (Kapitalregel 1).`,
    );
  }
  if (offene.length >= KAPITALREGELN.maxOffenePositionen) {
    verstoesse.push(
      `Mit diesem Trade wären ${offene.length + 1} Positionen offen; erlaubt sind ${KAPITALREGELN.maxOffenePositionen} (Kapitalregel 2).`,
    );
  }
  const summe =
    offene.reduce((a, zeile) => {
      const wert = lies(zeile["Risiko %"]);
      return a + (typeof wert === "number" ? wert : 0);
    }, 0) + risiko;
  if (summe > KAPITALREGELN.maxKumuliertesRisikoProzent) {
    verstoesse.push(
      `Kumuliertes Risiko der offenen Positionen wäre ${summe.toFixed(2)} %; erlaubt sind ${KAPITALREGELN.maxKumuliertesRisikoProzent} % (Kapitalregel 3).`,
    );
  }
  return verstoesse;
}

/** Ein Trade, wie das Werkzeug ihn annimmt. Eigene Form, damit die Zuordnung auf die
 *  Notion-Spalten prüfbar ist, ohne einen Modellauf zu starten. */
export interface TradeEintrag {
  instrument: string;
  richtung: "Long" | "Short";
  entry: number;
  stop: number;
  ziel: number;
  setup?: string;
  timeframe?: string;
  positionsgroesse?: number;
  risikoProzent?: number;
  emotionVorher?: string;
  notizen?: string;
  tags?: readonly string[];
  tradeNr?: string;
}

/**
 * Liegen Stop und Ziel auf der richtigen Seite des Einstiegs?
 *
 * Das ist keine Geschmacksfrage: ein Long mit Stop über dem Einstieg ist keine Position,
 * sondern ein Tippfehler — und eine Zeile mit vertauschten Zahlen verdirbt jede spätere
 * Auswertung, ohne dass man es der Statistik ansieht. Deshalb wird sie nicht eingetragen.
 */
export function zahlenFehler(eingabe: {
  richtung: "Long" | "Short";
  entry: number;
  stop: number;
  ziel: number;
}): string | null {
  const long = eingabe.richtung === "Long";
  if (long ? eingabe.stop >= eingabe.entry : eingabe.stop <= eingabe.entry) {
    return `${eingabe.richtung} mit Stop ${eingabe.stop} auf der falschen Seite des Einstiegs ${eingabe.entry}. Nicht eingetragen — eine Zeile mit vertauschten Zahlen verdirbt jede spätere Auswertung.`;
  }
  if (long ? eingabe.ziel <= eingabe.entry : eingabe.ziel >= eingabe.entry) {
    return `Das Ziel ${eingabe.ziel} liegt auf der falschen Seite des Einstiegs ${eingabe.entry}. Nicht eingetragen.`;
  }
  return null;
}

/**
 * Der Trade als Notion-Eigenschaften.
 *
 * Die Spaltennamen stehen hier als Zeichenketten und müssen auf das Zeichen zu Jakobs
 * Datenbank passen — „Plan befolgt?" mit Fragezeichen, „Positionsgröße" mit ß, „Risiko %"
 * mit Leerzeichen. Notion nimmt eine unbekannte Spalte nicht stillschweigend an, aber sie
 * fällt erst beim Eintragen auf, und dann steht Jakob mit einem halben Journal da. Darum
 * eine eigene Funktion, die ein Test nachrechnen kann.
 */
export function eintragEigenschaften(
  eingabe: TradeEintrag,
  verstoesse: readonly string[],
  tag = heute(),
): Record<string, unknown> {
  const notizen = [
    eingabe.notizen ?? "",
    verstoesse.length > 0 ? `Regelverstoß: ${verstoesse.join(" ")}` : "",
  ]
    .filter((zeile) => zeile !== "")
    .join("\n\n");

  return {
    "Trade-Nr": titel(eingabe.tradeNr ?? `${eingabe.instrument} ${tag}`),
    Datum: datum(tag),
    Instrument: textWert(eingabe.instrument),
    Richtung: auswahl(eingabe.richtung),
    "Entry-Preis": zahl(eingabe.entry),
    "Initialer Stop": zahl(eingabe.stop),
    Ziel: zahl(eingabe.ziel),
    Status: auswahl("Offen"),
    "Plan befolgt?": auswahl(verstoesse.length > 0 ? "Nein" : "Ja"),
    ...(eingabe.setup ? { Setup: auswahl(eingabe.setup) } : {}),
    ...(eingabe.timeframe ? { Timeframe: auswahl(eingabe.timeframe) } : {}),
    ...(eingabe.positionsgroesse ? { Positionsgröße: zahl(eingabe.positionsgroesse) } : {}),
    // **Prozent stehen als Prozent in der Spalte, nicht als Dezimalanteil**: 1 heißt ein
    // Prozent, nicht 0,01. Jakobs Vorgabe vom 2026-09-21 („zwecks Prüfzeile hätt ich gern,
    // dass tatsächlich prozent geschrieben werden nicht prozent in dezimal") — und so stehen
    // auch seine vorhandenen Zeilen da. Wer das später auf den Anteil umstellt, muss die drei
    // Lesestellen mitnehmen: `zeileKurz`, `regelverstoesse` und die Summe in `journal_offen`.
    ...(eingabe.risikoProzent !== undefined ? { "Risiko %": zahl(eingabe.risikoProzent) } : {}),
    ...(eingabe.emotionVorher ? { "Emotion vorher": textWert(eingabe.emotionVorher) } : {}),
    ...(notizen ? { Notizen: textWert(notizen) } : {}),
    ...(eingabe.tags && eingabe.tags.length > 0 ? { Tags: mehrfach(eingabe.tags) } : {}),
  };
}

/**
 * Welche der vorhandenen Optionen gemeint ist — oder keine.
 *
 * Erst genau (ohne Rücksicht auf Groß- und Kleinschreibung), dann eindeutig enthalten: „Setup 1"
 * trifft „Setup 1 Pullback EMA 20", solange es nur eines gibt, das so anfängt. Bei zwei
 * Treffern ist nichts gemeint — dann soll gefragt und nicht geraten werden. Ein Treffer ist
 * immer eine **vorhandene** Option; diese Funktion kann keine neue erfinden.
 */
export function passendeOption(wunsch: string, optionen: readonly string[]): string | null {
  const gesucht = wunsch.trim().toLowerCase();
  if (gesucht === "") return null;
  const genau = optionen.find((o) => o.toLowerCase() === gesucht);
  if (genau !== undefined) return genau;
  const enthalten = optionen.filter(
    (o) => o.toLowerCase().includes(gesucht) || gesucht.includes(o.toLowerCase()),
  );
  return enthalten.length === 1 ? enthalten[0] : null;
}

/** Eine Zeile der Watchlist, kurz — Instrument, Grund, die beiden Marken, der Auslöser. */
export function watchlistKurz(eigenschaften: Record<string, unknown>): string {
  const instrument = lies(eigenschaften.Instrument) || "?";
  const grund = lies(eigenschaften.Grund);
  const unten = lies(eigenschaften["Support-Level"]);
  const oben = lies(eigenschaften["Resistance-Level"]);
  const ausloeser = lies(eigenschaften["Setup-Trigger"]);
  const status = lies(eigenschaften.Status);
  const marken =
    unten !== null || oben !== null
      ? `  Unterstützung ${unten ?? "—"} / Widerstand ${oben ?? "—"}`
      : "";
  return `${instrument}${status ? ` [${status}]` : ""}${marken}${ausloeser ? `  Auslöser: ${ausloeser}` : ""}${grund ? `  — ${grund}` : ""}`;
}

export function createJournal(deps: JournalDeps = {}) {
  const notion =
    deps.notion ??
    (process.env.NOTION_TOKEN?.trim()
      ? createNotionClient({ token: process.env.NOTION_TOKEN.trim() })
      : null);

  async function offeneZeilen(): Promise<Record<string, unknown>[]> {
    if (!notion) return [];
    const zeilen = await notion.frage(JOURNAL_IDS.trades, {
      filter: { property: "Status", select: { equals: "Offen" } },
      grenze: 25,
    });
    return zeilen.map((z) => z.eigenschaften);
  }

  const offen = tool(
    "journal_offen",
    "Die offenen Trades im Journal — Instrument, Richtung, Einstieg, Stop, Ziel, Risiko. " +
      "Sieh hier nach, bevor eine neue Idee vorgeschlagen wird: Jakobs Regeln erlauben höchstens " +
      "drei offene Positionen und drei Prozent kumuliertes Risiko.",
    {},
    async () => {
      if (!notion) return antwort(NICHT_VERBUNDEN, true);
      try {
        const zeilen = await offeneZeilen();
        if (zeilen.length === 0) return antwort("Keine offenen Trades im Journal.");
        const summe = zeilen.reduce((a, z) => {
          const wert = lies(z["Risiko %"]);
          return a + (typeof wert === "number" ? wert : 0);
        }, 0);
        return antwort(
          [
            `${zeilen.length} offene Position(en), zusammen ${summe.toFixed(2)} % Risiko (erlaubt: ${KAPITALREGELN.maxKumuliertesRisikoProzent} %):`,
            "",
            ...zeilen.map(zeileKurz),
          ].join("\n"),
        );
      } catch (fehler) {
        return antwort(fehler instanceof NotionFehler ? fehler.message : String(fehler), true);
      }
    },
    { annotations: { title: "Offene Trades ansehen", readOnlyHint: true } },
  );

  const regeln = tool(
    "journal_regeln",
    "Jakobs Trading-Regeln und die dokumentierten Setups, direkt aus Notion gelesen. " +
      "Er passt sie am Monatsende an — lies sie nach, statt dich auf eine ältere Fassung zu " +
      "verlassen, wenn es um Regelkonformität geht.",
    {
      was: z
        .enum(["regeln", "setups", "beides"])
        .default("beides")
        .describe("Regelseite, Setup-Seite oder beides."),
    },
    async ({ was }) => {
      if (!notion) return antwort(NICHT_VERBUNDEN, true);
      try {
        const teile: string[] = [];
        if (was === "regeln" || was === "beides") {
          teile.push(`# Meine Trading-Regeln\n${await notion.seitentext(JOURNAL_IDS.regeln)}`);
        }
        if (was === "setups" || was === "beides") {
          teile.push(`# Strategie und Setups\n${await notion.seitentext(JOURNAL_IDS.setups)}`);
        }
        return antwort(teile.join("\n\n"));
      } catch (fehler) {
        return antwort(fehler instanceof NotionFehler ? fehler.message : String(fehler), true);
      }
    },
    { annotations: { title: "Regeln und Setups lesen", readOnlyHint: true } },
  );

  const letzte = tool(
    "journal_letzte",
    "Die zuletzt eingetragenen Trades, offen wie geschlossen — für Rückblicke und die Frage, " +
      "ob ein Muster sich wiederholt.",
    { grenze: z.number().int().min(1).max(25).default(10) },
    async ({ grenze }) => {
      if (!notion) return antwort(NICHT_VERBUNDEN, true);
      try {
        const zeilen = await notion.frage(JOURNAL_IDS.trades, {
          sorts: [{ property: "Datum", direction: "descending" }],
          grenze,
        });
        if (zeilen.length === 0) return antwort("Das Journal ist leer.");
        return antwort(
          zeilen
            .map((z) => {
              const st = lies(z.eigenschaften.Status);
              const plan = lies(z.eigenschaften["Plan befolgt?"]);
              const exit = lies(z.eigenschaften["Exit-Preis"]);
              return `${lies(z.eigenschaften.Datum) ?? "—"}  ${zeileKurz(z.eigenschaften)}  [${st ?? "?"}${exit !== null ? `, Exit ${exit}` : ""}${plan === "Nein" ? ", Plan NICHT befolgt" : ""}]`;
            })
            .join("\n"),
        );
      } catch (fehler) {
        return antwort(fehler instanceof NotionFehler ? fehler.message : String(fehler), true);
      }
    },
    { annotations: { title: "Letzte Trades ansehen", readOnlyHint: true } },
  );

  const watchlist = tool(
    "journal_watchlist",
    "Jakobs Watchlist: was er beobachtet, warum, mit Unterstützung, Widerstand und dem " +
      "Auslöser, auf den er wartet. Sieh hier nach, bevor du ein Instrument vorschlägst — " +
      "steht es schon drauf, ist die Frage nicht „ob“, sondern „ist der Auslöser da“.",
    {},
    async () => {
      if (!notion) return antwort(NICHT_VERBUNDEN, true);
      try {
        const zeilen = await notion.frage(JOURNAL_IDS.watchlist, {
          sorts: [{ property: "Aufnahme-Datum", direction: "descending" }],
          grenze: 25,
        });
        if (zeilen.length === 0) return antwort("Die Watchlist ist leer.");
        return antwort(zeilen.map((z) => watchlistKurz(z.eigenschaften)).join("\n"));
      } catch (fehler) {
        return antwort(fehler instanceof NotionFehler ? fehler.message : String(fehler), true);
      }
    },
    { annotations: { title: "Watchlist ansehen", readOnlyHint: true } },
  );

  const leseWerkzeuge = [offen, regeln, letzte, watchlist];
  if (deps.nurLesen) {
    return createSdkMcpServer({
      name: "journal",
      version: "1",
      instructions:
        "Jakobs Trading Journal in Notion, lesend. `journal_offen` zeigt die offenen Positionen " +
        "samt Risiko, `journal_regeln` seine Regeln und Setups im Wortlaut, `journal_letzte` die " +
        "jüngsten Einträge, `journal_watchlist` was er beobachtet. Eintragen und streichen tut " +
        "der Bedienstete `journal`, nicht du — sag im Bericht, was eingetragen werden soll.",
      tools: leseWerkzeuge,
    });
  }

  const anlegen = tool(
    "journal_anlegen",
    [
      "Einen Trade im Journal anlegen — **vor** dem Einstieg, so verlangt es Jakobs Regel.",
      "",
      "Status wird „Offen“. Geprüft werden dabei seine Kapitalregeln gegen die tatsächlich",
      "offenen Positionen: höchstens 1 % Risiko je Trade, höchstens drei offene Positionen,",
      "höchstens 3 % kumuliertes Risiko.",
      "",
      "Ein Verstoß verhindert den Eintrag **nicht** — er setzt „Plan befolgt?“ auf „Nein“ und",
      "steht in den Notizen. So will Jakob es: das Journal soll die Wahrheit enthalten, auch",
      "die unbequeme. Sag ihm im Bericht klar, welche Regel gerissen ist.",
    ].join("\n"),
    {
      instrument: z.string().min(1).max(60).describe("Z. B. AAPL, ^GDAXI, BTC-USD."),
      richtung: z.enum(["Long", "Short"]),
      entry: z.number().positive().describe("Geplanter Einstiegskurs."),
      stop: z.number().positive().describe("Initialer Stop. Bei Long darunter, bei Short darüber."),
      ziel: z.number().positive(),
      setup: z
        .string()
        .max(80)
        .optional()
        .describe(
          'Name eines **dokumentierten** Setups, z. B. "Setup 1 Pullback EMA 20". Ein Name, ' +
            "den die Setup-Seite nicht kennt, wird nicht eingetragen, sondern als Regelverstoß " +
            "vermerkt — erfinde keinen.",
        ),
      timeframe: z.enum(["Weekly", "Daily", "4h", "2h", "1h"]).optional(),
      positionsgroesse: z.number().positive().optional(),
      risikoProzent: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe("Risiko in Prozent des Kapitals, z. B. 1 für ein Prozent."),
      emotionVorher: z.string().max(300).optional(),
      notizen: z.string().max(1500).optional().describe("Die These und woran sie widerlegt wäre."),
      tags: z.array(z.string().max(40)).max(4).optional(),
      tradeNr: z
        .string()
        .max(40)
        .optional()
        .describe("Eigene Nummer/Bezeichnung. Ohne Angabe: Instrument und Datum."),
    },
    async (eingabe) => {
      if (!notion) return antwort(NICHT_VERBUNDEN, true);
      const fehler = zahlenFehler(eingabe);
      if (fehler) return antwort(fehler, true);

      try {
        const offene = await offeneZeilen();
        const verstoesse = regelverstoesse({ risikoProzent: eingabe.risikoProzent }, offene);

        // Das Setup muss auf Jakobs Setup-Seite stehen. Ein unbekannter Name legte in Notion
        // sonst still eine **neue** Option an (passiert am 2026-09-21) — und seine
        // Ausführungsregel 4 wäre damit nicht mehr prüfbar, sondern nur noch behauptet.
        let setup = eingabe.setup;
        if (setup) {
          const optionen = await notion.auswahlOptionen(JOURNAL_IDS.trades, "Setup");
          const treffer = passendeOption(setup, optionen);
          if (treffer) {
            setup = treffer;
          } else {
            verstoesse.push(
              `Setup „${setup}“ ist nicht dokumentiert (Ausführungsregel 4: kein Trade, der nicht vollständig einem dokumentierten Setup entspricht). Dokumentiert sind: ${optionen.join(", ") || "noch keines"}. Die Spalte bleibt leer.`,
            );
            setup = undefined;
          }
        }

        const seite = await notion.erstelle(
          JOURNAL_IDS.trades,
          eintragEigenschaften({ ...eingabe, setup }, verstoesse),
        );
        const kopf = `Eingetragen: ${eingabe.instrument} ${eingabe.richtung}, Entry ${eingabe.entry}, Stop ${eingabe.stop}, Ziel ${eingabe.ziel} (Status Offen, Kennung ${seite.id.slice(0, 8)}).`;
        if (verstoesse.length === 0) return antwort(`${kopf} Plan befolgt: Ja.`);
        return antwort(
          [
            kopf,
            "",
            "**Plan befolgt: Nein** — so verlangt es Jakobs Regelseite bei jedem Verstoß:",
            ...verstoesse.map((v) => `- ${v}`),
            "",
            "Sag ihm das im Bericht. Der Eintrag steht, der Verstoß auch.",
          ].join("\n"),
        );
      } catch (fehler) {
        return antwort(fehler instanceof NotionFehler ? fehler.message : String(fehler), true);
      }
    },
    { annotations: { title: "Trade eintragen" } },
  );

  const schliessen = tool(
    "journal_schliessen",
    "Einen offenen Trade schließen: Ausstiegskurs, wie es lief, was zu lernen war. Setzt den " +
      "Status auf „Geschlossen“. Jakobs Regel: am Tag des Ausstiegs, nicht später.",
    {
      seitenId: z
        .string()
        .min(8)
        .describe("Kennung der Zeile aus `journal_offen` oder `journal_anlegen`."),
      exit: z.number().positive(),
      rating: z
        .enum(["1", "2", "3", "4", "5"])
        .optional()
        .describe("Wie gut ausgeführt, nicht wie profitabel."),
      emotionWaehrend: z.string().max(300).optional(),
      notizen: z.string().max(1500).optional(),
      planBefolgt: z.enum(["Ja", "Nein"]).optional(),
    },
    async ({ seitenId, exit, rating, emotionWaehrend, notizen, planBefolgt }) => {
      if (!notion) return antwort(NICHT_VERBUNDEN, true);
      try {
        await notion.aktualisiere(seitenId, {
          "Exit-Preis": zahl(exit),
          Status: auswahl("Geschlossen"),
          ...(rating ? { Rating: auswahl(rating) } : {}),
          ...(emotionWaehrend ? { "Emotion während": textWert(emotionWaehrend) } : {}),
          ...(notizen ? { Notizen: textWert(notizen) } : {}),
          ...(planBefolgt ? { "Plan befolgt?": auswahl(planBefolgt) } : {}),
        });
        return antwort(`Geschlossen zu ${exit}. Das P&L rechnet Notion selbst aus der Formel.`);
      } catch (fehler) {
        return antwort(fehler instanceof NotionFehler ? fehler.message : String(fehler), true);
      }
    },
    { annotations: { title: "Trade schließen" } },
  );

  const lektion = tool(
    "journal_lektion",
    "Eine Lektion in „Lessons Learned“ festhalten — was passiert ist und welche Regel daraus " +
      "folgt. Nur für Erkenntnisse mit Konsequenz; eine Sammlung von Beobachtungen ohne Folge " +
      "liest niemand zweimal.",
    {
      titel: z.string().min(3).max(120),
      kategorie: z.string().max(60).optional().describe("Z. B. Psychologie, Ausführung, Risiko."),
      beschreibung: z.string().min(10).max(1500),
      konsequenz: z.string().max(600).optional().describe("Die neue oder geschärfte Regel."),
    },
    async (eingabe) => {
      if (!notion) return antwort(NICHT_VERBUNDEN, true);
      try {
        const seite = await notion.erstelle(JOURNAL_IDS.lektionen, {
          Titel: titel(eingabe.titel),
          Datum: datum(heute()),
          Beschreibung: textWert(eingabe.beschreibung),
          Status: statusWert("Nicht begonnen"),
          ...(eingabe.kategorie ? { Kategorie: textWert(eingabe.kategorie) } : {}),
          ...(eingabe.konsequenz
            ? { "Konsequenz / Neue Regel": textWert(eingabe.konsequenz) }
            : {}),
        });
        return antwort(`Lektion festgehalten (${seite.id.slice(0, 8)}): ${eingabe.titel}`);
      } catch (fehler) {
        return antwort(fehler instanceof NotionFehler ? fehler.message : String(fehler), true);
      }
    },
    { annotations: { title: "Lektion festhalten" } },
  );

  const beobachten = tool(
    "journal_beobachten",
    "Ein Instrument auf die Watchlist nehmen — für eine Idee, die noch keinen Einstieg hat. " +
      "Das ist der richtige Platz für „interessant, aber der Auslöser fehlt noch“: eine " +
      "solche Idee gehört nicht als Trade ins Journal, denn dort steht, was gehandelt wurde.",
    {
      instrument: z.string().min(1).max(60),
      grund: z.string().min(5).max(600).describe("Warum beobachtet — in einem Satz."),
      unterstuetzung: z.number().positive().optional().describe("Die Marke darunter."),
      widerstand: z.number().positive().optional().describe("Die Marke darüber."),
      ausloeser: z
        .string()
        .max(80)
        .optional()
        .describe('Das Setup, auf das gewartet wird, z. B. "Setup 1 Pullback EMA 20".'),
    },
    async (eingabe) => {
      if (!notion) return antwort(NICHT_VERBUNDEN, true);
      try {
        // Wie beim Eintragen: der Auslöser muss ein dokumentiertes Setup sein, sonst entsteht
        // in Jakobs Spalte eine Option, die er nie angelegt hat.
        let ausloeser = eingabe.ausloeser;
        let hinweis = "";
        if (ausloeser) {
          const optionen = await notion.auswahlOptionen(JOURNAL_IDS.watchlist, "Setup-Trigger");
          const treffer = passendeOption(ausloeser, optionen);
          if (treffer) {
            ausloeser = treffer;
          } else {
            hinweis = ` Der Auslöser „${ausloeser}“ steht nicht in der Spalte und wurde weggelassen — auswählbar sind: ${optionen.join(", ") || "noch nichts"}.`;
            ausloeser = undefined;
          }
        }
        await notion.erstelle(JOURNAL_IDS.watchlist, {
          Instrument: titel(eingabe.instrument),
          Grund: textWert(eingabe.grund),
          "Aufnahme-Datum": datum(heute()),
          Status: auswahl("Aktiv"),
          ...(eingabe.unterstuetzung !== undefined
            ? { "Support-Level": zahl(eingabe.unterstuetzung) }
            : {}),
          ...(eingabe.widerstand !== undefined
            ? { "Resistance-Level": zahl(eingabe.widerstand) }
            : {}),
          ...(ausloeser ? { "Setup-Trigger": auswahl(ausloeser) } : {}),
        });
        return antwort(`${eingabe.instrument} steht auf der Watchlist: ${eingabe.grund}${hinweis}`);
      } catch (fehler) {
        return antwort(fehler instanceof NotionFehler ? fehler.message : String(fehler), true);
      }
    },
    { annotations: { title: "Auf die Watchlist nehmen" } },
  );

  return createSdkMcpServer({
    name: "journal",
    version: "1",
    instructions:
      "Jakobs Trading Journal in Notion. `journal_anlegen` trägt einen Trade **vor** dem " +
      "Einstieg ein, `journal_schliessen` schließt ihn am Tag des Ausstiegs, `journal_offen` " +
      "zeigt die offenen Positionen samt Risiko, `journal_regeln` seine Regeln und Setups, " +
      "`journal_letzte` die jüngsten Einträge, `journal_lektion` hält eine Erkenntnis fest. " +
      "`journal_watchlist` und `journal_beobachten` führen die Beobachtungsliste — dort " +
      "gehört hin, was noch keinen Einstieg hat. " +
      "Regelverstöße werden eingetragen und markiert, nicht verschwiegen.",
    tools: [...leseWerkzeuge, anlegen, schliessen, lektion, beobachten],
  });
}

/** Alles, was der Journal-Bedienstete darf. */
export const JOURNAL_TOOLS = [
  "mcp__journal__journal_offen",
  "mcp__journal__journal_regeln",
  "mcp__journal__journal_letzte",
  "mcp__journal__journal_watchlist",
  "mcp__journal__journal_anlegen",
  "mcp__journal__journal_schliessen",
  "mcp__journal__journal_lektion",
  "mcp__journal__journal_beobachten",
];

/** Was der Handelstisch darf: nachsehen, nicht schreiben. */
export const JOURNAL_LESEN = [
  "mcp__journal__journal_offen",
  "mcp__journal__journal_regeln",
  "mcp__journal__journal_letzte",
  "mcp__journal__journal_watchlist",
];
