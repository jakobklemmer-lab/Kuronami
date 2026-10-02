/**
 * Einmaliger Umzug des Trading-Journals aus Notion ins Brain (02.10.). Gegenüber Notion nur lesend;
 * im Brain wird nichts überschrieben — steht eine Datei schon da, bleibt sie.
 *
 *   npx tsx --env-file=.env werkzeuge/brain/notion-export.ts [workdir]
 *
 * Braucht NOTION_TOKEN und die NOTION_*-Kennungen aus der .env.
 */
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { brainPfad, dateiname, schreibeNotiz } from "../../gateway/brain.js";
import { createNotionClient, lies } from "../../gateway/integrations/notion.js";
import { type Felder, JOURNAL, ergebnisR, neueKennung } from "../../gateway/journal.js";

const workdir = process.argv[2] ?? "/opt/kuronami/workspace";
const env = (k: string): string => {
  const w = process.env[k]?.trim();
  if (!w) throw new Error(`${k} fehlt in der Umgebung.`);
  return w;
};
const notion = createNotionClient({ token: env("NOTION_TOKEN") });

const text = (e: Record<string, unknown>, k: string): string | null => {
  const w = lies(e[k]);
  return typeof w === "string" && w.trim() !== "" ? w.trim() : null;
};
const zahl = (e: Record<string, unknown>, k: string): number | null => {
  const w = lies(e[k]);
  return typeof w === "number" ? w : null;
};

let geschrieben = 0;
async function lege(datei: string, inhalt: string): Promise<void> {
  const ziel = brainPfad(workdir, datei);
  try {
    await access(ziel);
    console.log(`bleibt: ${datei}`);
    return;
  } catch {
    // frei
  }
  await mkdir(path.dirname(ziel), { recursive: true });
  await writeFile(ziel, inhalt, "utf8");
  geschrieben += 1;
  console.log(`neu: ${datei}`);
}

// Trades
for (const z of await notion.frage(env("NOTION_TRADES_DB"), { grenze: 100 })) {
  const e = z.eigenschaften;
  const instrument = text(e, "Instrument");
  // Leere Vorlagenzeilen in Notion (ohne Instrument) sind keine Trades.
  if (!instrument) continue;
  const datum = text(e, "Datum")?.slice(0, 10) ?? "ohne-datum";
  const richtung = text(e, "Richtung") ?? "";
  const exit = zahl(e, "Exit-Preis");
  const felder: Felder = {
    art: "trade",
    id: neueKennung(),
    nr: text(e, "Trade-Nr"),
    datum,
    instrument,
    richtung,
    entry: zahl(e, "Entry-Preis"),
    stop: zahl(e, "Initialer Stop"),
    ziel: zahl(e, "Ziel"),
    status: text(e, "Status") ?? "Offen",
    plan_befolgt: text(e, "Plan befolgt?"),
    setup: text(e, "Setup"),
    timeframe: text(e, "Timeframe"),
    positionsgroesse: zahl(e, "Positionsgröße"),
    risiko_prozent: zahl(e, "Risiko %"),
    emotion_vorher: text(e, "Emotion vorher"),
    emotion_waehrend: text(e, "Emotion während"),
    exit,
    rating: zahl(e, "Rating") ?? (text(e, "Rating") ? Number(text(e, "Rating")) : null),
    tags: text(e, "Tags")?.split(", ") ?? null,
    quelle: "Notion",
  };
  if (exit !== null) felder.ergebnis_r = ergebnisR(felder, exit);
  const inhalt = `# ${instrument} ${richtung}\n\n## These\n${text(e, "Notizen") ?? "_—_"}`;
  await lege(
    path.join(JOURNAL.trades, `${dateiname(`${datum} ${instrument} ${richtung}`)}.md`),
    schreibeNotiz(felder, inhalt),
  );
}

// Watchlist
for (const z of await notion.frage(env("NOTION_WATCHLIST_DB"), { grenze: 100 })) {
  const e = z.eigenschaften;
  const instrument = text(e, "Instrument") ?? "?";
  const grund = text(e, "Grund");
  await lege(
    path.join(JOURNAL.watchlist, `${dateiname(instrument)}.md`),
    schreibeNotiz(
      {
        art: "watchlist",
        instrument,
        status: text(e, "Status") ?? "Aktiv",
        aufnahme: text(e, "Aufnahme-Datum")?.slice(0, 10) ?? null,
        grund,
        unterstuetzung: zahl(e, "Support-Level"),
        widerstand: zahl(e, "Resistance-Level"),
        ausloeser: text(e, "Setup-Trigger"),
        quelle: "Notion",
      },
      `# ${instrument}\n\n${grund ?? ""}`,
    ),
  );
}

// Lektionen
for (const z of await notion.frage(env("NOTION_LEKTIONEN_DB"), { grenze: 100 })) {
  const e = z.eigenschaften;
  const titel = text(e, "Titel");
  if (!titel && !text(e, "Beschreibung")) continue;
  const konsequenz = text(e, "Konsequenz / Neue Regel");
  await lege(
    path.join(JOURNAL.lektionen, `${dateiname(titel ?? "Lektion")}.md`),
    schreibeNotiz(
      {
        art: "lektion",
        datum: text(e, "Datum")?.slice(0, 10) ?? null,
        kategorie: text(e, "Kategorie"),
        status: text(e, "Status"),
        quelle: "Notion",
      },
      `# ${titel ?? "Lektion"}\n\n${text(e, "Beschreibung") ?? ""}${konsequenz ? `\n\n## Konsequenz\n${konsequenz}` : ""}`,
    ),
  );
}

// Regeln und Setups im Wortlaut; die Setup-Namen als Eigenschaft — gegen sie prüft journal_anlegen.
const setups = [
  ...new Set([
    ...(await notion.auswahlOptionen(env("NOTION_TRADES_DB"), "Setup")),
    ...(await notion.auswahlOptionen(env("NOTION_WATCHLIST_DB"), "Setup-Trigger")),
  ]),
];
await lege(
  JOURNAL.regeln,
  schreibeNotiz(
    { art: "regeln", quelle: "Notion" },
    `${await notion.seitentext(env("NOTION_REGELN_PAGE"))}`,
  ),
);
await lege(
  JOURNAL.setups,
  schreibeNotiz(
    { art: "setups", setups, quelle: "Notion" },
    `${await notion.seitentext(env("NOTION_SETUPS_PAGE"))}`,
  ),
);
console.log(`${geschrieben} Notizen geschrieben.`);
