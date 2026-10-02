import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  type Verzeichnis,
  type Wert,
  brainPfad,
  dateiname,
  leseNotiz,
  schreibeNotiz,
  schreibeVerzeichnis,
} from "./brain.js";

/**
 * Jakobs Trading-Journal im Brain (seit 02.10., vorher Notion): eine Notiz je Trade, je
 * Watchlist-Eintrag, je Lektion, dazu Regeln und Setups als eigene Seiten. Werkzeugnamen und
 * Parameter sind geblieben — die Prompts von journal und boerse gelten unverändert.
 *
 * Ein Regelverstoß verhindert keinen Eintrag; er setzt `plan_befolgt: Nein` und steht in der
 * Notiz. Ein Journal, das unbequeme Trades nicht enthält, sieht immer gut aus.
 */

export const JOURNAL = {
  trades: "Trading/Journal",
  watchlist: "Trading/Watchlist",
  lektionen: "Trading/Lektionen",
  regeln: "Trading/Regeln.md",
  setups: "Trading/Setups.md",
} as const;

/** Jakobs Kapitalregeln, als Zahlen — geprüft wird gegen diese, nicht gegen eine Erinnerung. */
export const KAPITALREGELN = {
  maxRisikoProzent: 1,
  maxOffenePositionen: 3,
  maxKumuliertesRisikoProzent: 3,
} as const;

export type Felder = Record<string, Wert>;
export interface Notiz {
  /** Pfad relativ zum Brain. */
  datei: string;
  felder: Felder;
  inhalt: string;
}

export interface JournalDeps {
  workdir?: string;
  /** Nur die Werkzeuge zum Nachsehen — für den Handelstisch, der nicht schreibt. */
  nurLesen?: boolean;
  heute?: () => string;
}

function antwort(inhalt: string, fehler = false) {
  return {
    content: [{ type: "text" as const, text: inhalt }],
    ...(fehler ? { isError: true } : {}),
  };
}

const zahlAus = (f: Felder, k: string): number | null => {
  const w = f[k];
  return typeof w === "number" ? w : null;
};
const textAus = (f: Felder, k: string): string => {
  const w = f[k];
  return typeof w === "string" ? w : "";
};

export function neueKennung(): string {
  return randomBytes(4).toString("hex");
}

/** Ein Trade, kurz — mit Kennung, damit er sich schließen lässt. */
export function zeileKurz(f: Felder): string {
  const risiko = zahlAus(f, "risiko_prozent");
  const risikoText = risiko !== null ? `${risiko.toFixed(2)} %` : "—";
  return `${textAus(f, "nr") || "(ohne Nummer)"}  ${textAus(f, "instrument") || "?"} ${textAus(f, "richtung")}  Entry ${zahlAus(f, "entry") ?? "?"}, Stop ${zahlAus(f, "stop") ?? "?"}, Ziel ${zahlAus(f, "ziel") ?? "?"}, Risiko ${risikoText}  (Kennung ${textAus(f, "id") || "?"})`;
}

/** Welche Kapitalregeln dieser Trade verletzt — gegen die offenen Trades im Journal. */
export function regelverstoesse(
  neu: { risikoProzent?: number },
  offene: readonly Felder[],
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
  const summe = offene.reduce((a, f) => a + (zahlAus(f, "risiko_prozent") ?? 0), 0) + risiko;
  if (summe > KAPITALREGELN.maxKumuliertesRisikoProzent) {
    verstoesse.push(
      `Kumuliertes Risiko der offenen Positionen wäre ${summe.toFixed(2)} %; erlaubt sind ${KAPITALREGELN.maxKumuliertesRisikoProzent} % (Kapitalregel 3).`,
    );
  }
  return verstoesse;
}

/** Ein Trade, wie das Werkzeug ihn annimmt. */
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

/** Liegen Stop und Ziel auf der richtigen Seite des Einstiegs? Vertauschte Zahlen werden nicht eingetragen. */
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

/** Die Eigenschaften einer Trade-Notiz. Prozent stehen als Prozent: 1 heißt ein Prozent. */
export function tradeFelder(
  eingabe: TradeEintrag,
  verstoesse: readonly string[],
  tag: string,
  id: string,
): Felder {
  return {
    art: "trade",
    id,
    nr: eingabe.tradeNr ?? `${eingabe.instrument} ${tag}`,
    datum: tag,
    instrument: eingabe.instrument,
    richtung: eingabe.richtung,
    entry: eingabe.entry,
    stop: eingabe.stop,
    ziel: eingabe.ziel,
    status: "Offen",
    plan_befolgt: verstoesse.length > 0 ? "Nein" : "Ja",
    setup: eingabe.setup ?? null,
    timeframe: eingabe.timeframe ?? null,
    positionsgroesse: eingabe.positionsgroesse ?? null,
    risiko_prozent: eingabe.risikoProzent ?? null,
    emotion_vorher: eingabe.emotionVorher ?? null,
    tags: eingabe.tags && eingabe.tags.length > 0 ? [...eingabe.tags] : null,
  };
}

export function tradeInhalt(eingabe: TradeEintrag, verstoesse: readonly string[]): string {
  const teile = [
    `# ${eingabe.instrument} ${eingabe.richtung}`,
    "",
    "## These",
    eingabe.notizen?.trim() || "_—_",
  ];
  if (verstoesse.length > 0) teile.push("", "## Regelverstöße", ...verstoesse.map((v) => `- ${v}`));
  return teile.join("\n");
}

/** Ergebnis in R: wie viele Risikoeinheiten gewonnen oder verloren. */
export function ergebnisR(f: Felder, exit: number): number | null {
  const entry = zahlAus(f, "entry");
  const stop = zahlAus(f, "stop");
  if (entry === null || stop === null || entry === stop) return null;
  return Math.round(((exit - entry) / (entry - stop)) * 100) / 100;
}

/** Welche vorhandene Option gemeint ist: erst genau, dann eindeutig enthalten; sonst keine. */
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

/** Ein Watchlist-Eintrag, kurz — Instrument, Status, Marken, Auslöser, Grund. */
export function watchlistKurz(f: Felder): string {
  const unten = zahlAus(f, "unterstuetzung");
  const oben = zahlAus(f, "widerstand");
  const marken =
    unten !== null || oben !== null
      ? `  Unterstützung ${unten ?? "—"} / Widerstand ${oben ?? "—"}`
      : "";
  const ausloeser = textAus(f, "ausloeser");
  const grund = textAus(f, "grund");
  const status = textAus(f, "status");
  return `${textAus(f, "instrument") || "?"}${status ? ` [${status}]` : ""}${marken}${ausloeser ? `  Auslöser: ${ausloeser}` : ""}${grund ? `  — ${grund}` : ""}`;
}

// ------------------------------------------------------------------------------- Ablage

export async function liesOrdner(workdir: string, ordner: string): Promise<Notiz[]> {
  let namen: string[];
  try {
    namen = (await readdir(brainPfad(workdir, ordner))).filter((n) => n.endsWith(".md"));
  } catch {
    return [];
  }
  const notizen: Notiz[] = [];
  for (const name of namen.sort()) {
    const datei = path.join(ordner, name);
    const { felder, inhalt } = leseNotiz(await readFile(brainPfad(workdir, datei), "utf8"));
    notizen.push({ datei, felder, inhalt });
  }
  return notizen;
}

/** Die dokumentierten Setups: Eigenschaft `setups` der Setup-Seite. */
export async function dokumentierteSetups(workdir: string): Promise<string[]> {
  try {
    const { felder } = leseNotiz(await readFile(brainPfad(workdir, JOURNAL.setups), "utf8"));
    return Array.isArray(felder.setups) ? felder.setups : [];
  } catch {
    return [];
  }
}

/** Ein freier Dateiname im Ordner: „Name.md", sonst „Name (2).md" … */
async function freieDatei(workdir: string, ordner: string, titel: string): Promise<string> {
  const basis = dateiname(titel);
  for (let n = 1; ; n += 1) {
    const datei = path.join(ordner, `${n === 1 ? basis : `${basis} (${n})`}.md`);
    try {
      await stat(brainPfad(workdir, datei));
    } catch {
      return datei;
    }
  }
}

async function lege(workdir: string, datei: string, text: string): Promise<void> {
  await mkdir(path.dirname(brainPfad(workdir, datei)), { recursive: true });
  await writeFile(brainPfad(workdir, datei), text, "utf8");
}

/** Die Verzeichnisseiten des Journals — über sie finden Kuro und Jakob jede Notiz. */
export const JOURNAL_VERZEICHNISSE: Verzeichnis[] = [
  {
    seite: "Trading/Journal.md",
    ordner: JOURNAL.trades,
    titel: "Journal",
    satz: "Jeder Trade eine Notiz, neueste zuerst. Geschlossene mit Ergebnis in R.",
    absteigend: true,
    anzeige: (f, name) => {
      const ergebnis = typeof f.ergebnis_r === "number" ? `, ${f.ergebnis_r} R` : "";
      return `${name} — ${f.status ?? "?"}${ergebnis}${f.plan_befolgt === "Nein" ? ", Plan nicht befolgt" : ""}`;
    },
  },
  {
    seite: "Trading/Watchlist.md",
    ordner: JOURNAL.watchlist,
    titel: "Watchlist",
    satz: "Was Jakob beobachtet und auf welchen Auslöser er wartet.",
    anzeige: (f, name) =>
      `${name}${f.status ? ` [${f.status}]` : ""}${typeof f.grund === "string" ? ` — ${f.grund}` : ""}`,
  },
  {
    seite: "Trading/Lektionen.md",
    ordner: JOURNAL.lektionen,
    titel: "Lektionen",
    satz: "Erkenntnisse mit Konsequenz — jede mit der Regel, die daraus folgt.",
  },
];

// ------------------------------------------------------------------------------ Werkzeuge

export function createJournal(deps: JournalDeps = {}) {
  const workdir = deps.workdir ?? process.env.KURO_WORKDIR?.trim() ?? "/opt/kuronami/workspace";
  const heute = deps.heute ?? (() => new Date().toISOString().slice(0, 10));

  const offeneTrades = async (): Promise<Notiz[]> =>
    (await liesOrdner(workdir, JOURNAL.trades)).filter((n) => n.felder.status === "Offen");
  const verzeichnis = async (seite: string): Promise<void> => {
    const v = JOURNAL_VERZEICHNISSE.find((x) => x.seite === seite);
    if (v) await schreibeVerzeichnis(workdir, v);
  };

  const offen = tool(
    "journal_offen",
    "Die offenen Trades im Journal — Instrument, Richtung, Einstieg, Stop, Ziel, Risiko, Kennung. " +
      "Sieh hier nach, bevor eine neue Idee vorgeschlagen wird: Jakobs Regeln erlauben höchstens " +
      "drei offene Positionen und drei Prozent kumuliertes Risiko.",
    {},
    async () => {
      const zeilen = (await offeneTrades()).map((n) => n.felder);
      if (zeilen.length === 0) return antwort("Keine offenen Trades im Journal.");
      const summe = zeilen.reduce((a, f) => a + (zahlAus(f, "risiko_prozent") ?? 0), 0);
      return antwort(
        [
          `${zeilen.length} offene Position(en), zusammen ${summe.toFixed(2)} % Risiko (erlaubt: ${KAPITALREGELN.maxKumuliertesRisikoProzent} %):`,
          "",
          ...zeilen.map(zeileKurz),
        ].join("\n"),
      );
    },
    { annotations: { title: "Offene Trades ansehen", readOnlyHint: true } },
  );

  const regeln = tool(
    "journal_regeln",
    "Jakobs Trading-Regeln und die dokumentierten Setups im Wortlaut. Er passt sie am Monatsende " +
      "an — lies sie nach, statt dich auf eine ältere Fassung zu verlassen.",
    {
      was: z
        .enum(["regeln", "setups", "beides"])
        .default("beides")
        .describe("Regelseite, Setup-Seite oder beides."),
    },
    async ({ was }) => {
      const teile: string[] = [];
      for (const [art, datei] of [
        ["regeln", JOURNAL.regeln],
        ["setups", JOURNAL.setups],
      ] as const) {
        if (was !== "beides" && was !== art) continue;
        try {
          teile.push(leseNotiz(await readFile(brainPfad(workdir, datei), "utf8")).inhalt.trim());
        } catch {
          teile.push(`(${datei} fehlt im Brain)`);
        }
      }
      return antwort(teile.join("\n\n"));
    },
    { annotations: { title: "Regeln und Setups lesen", readOnlyHint: true } },
  );

  const letzte = tool(
    "journal_letzte",
    "Die zuletzt eingetragenen Trades, offen wie geschlossen — für Rückblicke und die Frage, " +
      "ob ein Muster sich wiederholt.",
    { grenze: z.number().int().min(1).max(25).default(10) },
    async ({ grenze }) => {
      const alle = (await liesOrdner(workdir, JOURNAL.trades)).sort((a, b) =>
        String(b.felder.datum ?? "").localeCompare(String(a.felder.datum ?? "")),
      );
      if (alle.length === 0) return antwort("Das Journal ist leer.");
      return antwort(
        alle
          .slice(0, grenze)
          .map(({ felder: f }) => {
            const exit = zahlAus(f, "exit");
            const r = zahlAus(f, "ergebnis_r");
            return `${f.datum ?? "—"}  ${zeileKurz(f)}  [${f.status ?? "?"}${exit !== null ? `, Exit ${exit}` : ""}${r !== null ? `, ${r} R` : ""}${f.plan_befolgt === "Nein" ? ", Plan NICHT befolgt" : ""}]`;
          })
          .join("\n"),
      );
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
      const eintraege = await liesOrdner(workdir, JOURNAL.watchlist);
      if (eintraege.length === 0) return antwort("Die Watchlist ist leer.");
      return antwort(eintraege.map((n) => watchlistKurz(n.felder)).join("\n"));
    },
    { annotations: { title: "Watchlist ansehen", readOnlyHint: true } },
  );

  const leseWerkzeuge = [offen, regeln, letzte, watchlist];
  if (deps.nurLesen) {
    return createSdkMcpServer({
      name: "journal",
      version: "1",
      instructions:
        "Jakobs Trading-Journal im Brain, lesend. `journal_offen` zeigt die offenen Positionen " +
        "samt Risiko, `journal_regeln` seine Regeln und Setups im Wortlaut, `journal_letzte` die " +
        "jüngsten Einträge, `journal_watchlist` was er beobachtet. Eintragen tut der Bedienstete " +
        "`journal`, nicht du — sag im Bericht, was eingetragen werden soll.",
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
      "Ein Verstoß verhindert den Eintrag **nicht** — er setzt „Plan befolgt“ auf „Nein“ und",
      "steht in der Notiz. Sag Jakob im Bericht klar, welche Regel gerissen ist.",
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
          "Name eines **dokumentierten** Setups (Trading/Setups.md). Ein unbekannter Name wird nicht " +
            "eingetragen, sondern als Regelverstoß vermerkt — erfinde keinen.",
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
      const fehler = zahlenFehler(eingabe);
      if (fehler) return antwort(fehler, true);
      const verstoesse = regelverstoesse(
        { risikoProzent: eingabe.risikoProzent },
        (await offeneTrades()).map((n) => n.felder),
      );
      let setup = eingabe.setup;
      if (setup) {
        const optionen = await dokumentierteSetups(workdir);
        const treffer = passendeOption(setup, optionen);
        if (treffer) {
          setup = treffer;
        } else {
          verstoesse.push(
            `Setup „${setup}“ ist nicht dokumentiert (Ausführungsregel 4: kein Trade, der nicht vollständig einem dokumentierten Setup entspricht). Dokumentiert sind: ${optionen.join(", ") || "noch keines"}.`,
          );
          setup = undefined;
        }
      }
      const tag = heute();
      const id = neueKennung();
      const datei = await freieDatei(
        workdir,
        JOURNAL.trades,
        `${tag} ${eingabe.instrument} ${eingabe.richtung}`,
      );
      await lege(
        workdir,
        datei,
        schreibeNotiz(
          tradeFelder({ ...eingabe, setup }, verstoesse, tag, id),
          tradeInhalt(eingabe, verstoesse),
        ),
      );
      await verzeichnis("Trading/Journal.md");
      const kopf = `Eingetragen: ${eingabe.instrument} ${eingabe.richtung}, Entry ${eingabe.entry}, Stop ${eingabe.stop}, Ziel ${eingabe.ziel} (Status Offen, Kennung ${id}, ${datei}).`;
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
    },
    { annotations: { title: "Trade eintragen" } },
  );

  const schliessen = tool(
    "journal_schliessen",
    "Einen offenen Trade schließen: Ausstiegskurs, wie es lief, was zu lernen war. Setzt den " +
      "Status auf „Geschlossen“ und rechnet das Ergebnis in R. Jakobs Regel: am Tag des Ausstiegs.",
    {
      seitenId: z.string().min(6).describe("Kennung aus `journal_offen` oder `journal_anlegen`."),
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
      const trade = (await liesOrdner(workdir, JOURNAL.trades)).find(
        (n) => n.felder.id === seitenId.trim(),
      );
      if (!trade) return antwort(`Kein Trade mit der Kennung ${seitenId} im Journal.`, true);
      const r = ergebnisR(trade.felder, exit);
      const felder: Felder = {
        ...trade.felder,
        status: "Geschlossen",
        exit,
        ausstieg: heute(),
        ergebnis_r: r,
        ...(rating ? { rating: Number(rating) } : {}),
        ...(emotionWaehrend ? { emotion_waehrend: emotionWaehrend } : {}),
        ...(planBefolgt ? { plan_befolgt: planBefolgt } : {}),
      };
      const inhalt = `${trade.inhalt.trim()}\n\n## Abschluss\nExit ${exit}${r !== null ? ` · ${r} R` : ""}${notizen ? `\n\n${notizen.trim()}` : ""}`;
      await lege(workdir, trade.datei, schreibeNotiz(felder, inhalt));
      await verzeichnis("Trading/Journal.md");
      return antwort(`Geschlossen zu ${exit}${r !== null ? ` — ${r} R` : ""} (${trade.datei}).`);
    },
    { annotations: { title: "Trade schließen" } },
  );

  const lektion = tool(
    "journal_lektion",
    "Eine Lektion festhalten — was passiert ist und welche Regel daraus folgt. Nur für " +
      "Erkenntnisse mit Konsequenz; Beobachtungen ohne Folge liest niemand zweimal.",
    {
      titel: z.string().min(3).max(120),
      kategorie: z.string().max(60).optional().describe("Z. B. Psychologie, Ausführung, Risiko."),
      beschreibung: z.string().min(10).max(1500),
      konsequenz: z.string().max(600).optional().describe("Die neue oder geschärfte Regel."),
    },
    async (eingabe) => {
      const datei = await freieDatei(workdir, JOURNAL.lektionen, eingabe.titel);
      await lege(
        workdir,
        datei,
        schreibeNotiz(
          {
            art: "lektion",
            datum: heute(),
            kategorie: eingabe.kategorie ?? null,
            status: "Nicht begonnen",
          },
          `# ${eingabe.titel}\n\n${eingabe.beschreibung.trim()}${eingabe.konsequenz ? `\n\n## Konsequenz\n${eingabe.konsequenz.trim()}` : ""}`,
        ),
      );
      await verzeichnis("Trading/Lektionen.md");
      return antwort(`Lektion festgehalten: ${eingabe.titel} (${datei}).`);
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
      let ausloeser = eingabe.ausloeser;
      let hinweis = "";
      if (ausloeser) {
        const optionen = await dokumentierteSetups(workdir);
        const treffer = passendeOption(ausloeser, optionen);
        if (treffer) {
          ausloeser = treffer;
        } else {
          hinweis = ` Der Auslöser „${ausloeser}“ ist kein dokumentiertes Setup und wurde weggelassen — dokumentiert sind: ${optionen.join(", ") || "noch keine"}.`;
          ausloeser = undefined;
        }
      }
      const datei = await freieDatei(workdir, JOURNAL.watchlist, eingabe.instrument);
      await lege(
        workdir,
        datei,
        schreibeNotiz(
          {
            art: "watchlist",
            instrument: eingabe.instrument,
            status: "Aktiv",
            aufnahme: heute(),
            grund: eingabe.grund,
            unterstuetzung: eingabe.unterstuetzung ?? null,
            widerstand: eingabe.widerstand ?? null,
            ausloeser: ausloeser ?? null,
          },
          `# ${eingabe.instrument}\n\n${eingabe.grund.trim()}`,
        ),
      );
      await verzeichnis("Trading/Watchlist.md");
      return antwort(`${eingabe.instrument} steht auf der Watchlist: ${eingabe.grund}${hinweis}`);
    },
    { annotations: { title: "Auf die Watchlist nehmen" } },
  );

  return createSdkMcpServer({
    name: "journal",
    version: "1",
    instructions:
      "Jakobs Trading-Journal im Brain (Obsidian). `journal_anlegen` trägt einen Trade **vor** dem " +
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
