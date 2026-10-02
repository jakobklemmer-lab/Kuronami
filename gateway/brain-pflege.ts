import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  type Verzeichnis,
  brainPfad,
  dateiname,
  erstenTitel,
  leseNotiz,
  schreibeNotiz,
  schreibeVerzeichnis,
  sichere,
} from "./brain.js";
import { JOURNAL_VERZEICHNISSE } from "./journal.js";

/**
 * Das Brain einrichten und in Ordnung halten: Gerüst anlegen (nur was fehlt), Strategien und
 * Analysen als lesbare Notizen erzeugen, Verzeichnisseiten schreiben, alles ins Brain-Git sichern.
 */

const ausfuehren = promisify(execFile);

/** Ordnername im Brain je Lehrgangs-Kanal. */
export const WISSEN_ORDNER: Record<string, string> = { tradinglab: "TradingLab", murphy: "Murphy" };

const HINWEIS_ERZEUGT =
  "_Automatisch aus Kuros Archiv erzeugt — Änderungen hier gehen beim nächsten Abgleich verloren._";

/** Seiten, die angelegt werden, wenn sie fehlen. Danach gehören sie Jakob und Kuro. */
const GERUEST: Record<string, string> = {
  "START.md": `# Brain

Jakobs Gedächtnis, gemeinsam mit Kuro geführt. Jede Notiz ist von hier aus mit höchstens drei
Links erreichbar.

- [[Bereiche/Trading|Trading]] — Journal, Watchlist, Lektionen, Regeln, Setups, Strategien, Analysen
- [[Bereiche/Finanzen|Finanzen]] — Konten und Monate
- [[Bereiche/Planung|Planung]] — Tage und Wochen
- [[Bereiche/Studium und Arbeit|Studium und Arbeit]]
- [[Bereiche/Wissen|Wissen]] — TradingLab, Murphy
- [[Gespräche/INDEX|Gespräche]] — Kuros Gespräche nach Tagen
- [[Eingang]] — Unsortiertes, das noch einen Platz braucht
`,
  "Bereiche/Trading.md": `# Trading

- [[Trading/Journal|Journal]] — jeder Trade eine Notiz
- [[Trading/Watchlist|Watchlist]] — was beobachtet wird und worauf
- [[Trading/Lektionen|Lektionen]] — Erkenntnisse mit Konsequenz
- [[Trading/Regeln|Regeln]] · [[Trading/Setups|Setups]] — gelten immer
- [[Trading/Strategien|Strategien]] — aus dem Strategie-Archiv
- [[Trading/Analysen|Analysen]] — Berichte von boerse, recherche, werkstatt
- [[Trading/Labor-Stand|Labor-Stand]] — was das Labor belegt und was nicht
`,
  "Bereiche/Finanzen.md":
    "# Finanzen\n\nNoch leer. Kommt mit der Anbindung von Raiffeisen und Revolut.\n",
  "Bereiche/Planung.md":
    "# Planung\n\nNoch leer. Kommt mit dem Apple-Kalender: Tagespläne, Wochen, Erledigtes.\n",
  "Bereiche/Studium und Arbeit.md": "# Studium und Arbeit\n\nNoch leer.\n",
  "Bereiche/Wissen.md": `# Wissen

- [[Wissen/TradingLab|TradingLab]] — Notizen zu jedem durchgearbeiteten Video
- [[Wissen/Murphy|Murphy]] — Technical Analysis of the Financial Markets, Kapitel für Kapitel
`,
  ".gitignore": "*.neu\n.obsidian/workspace*.json\n.trash/\n",
};

const VERZEICHNISSE: Verzeichnis[] = [
  ...JOURNAL_VERZEICHNISSE,
  {
    seite: "Wissen/TradingLab.md",
    ordner: "Wissen/TradingLab",
    titel: "TradingLab",
    satz: "Je Video eine Notiz: Begriffe, Regeln mit Zeitmarken, Behauptungen des Videos (keine Belege).",
    anzeige: (_f, name, inhalt) => erstenTitel(inhalt, name),
  },
  {
    seite: "Wissen/Murphy.md",
    ordner: "Wissen/Murphy",
    titel: "Murphy",
    satz: "John J. Murphy, Technical Analysis of the Financial Markets — je Abschnitt eine Notiz.",
    anzeige: (_f, name, inhalt) => erstenTitel(inhalt, name),
  },
  {
    seite: "Trading/Strategien.md",
    ordner: "Trading/Strategien",
    titel: "Strategien",
    satz: "Aus dem Strategie-Archiv erzeugt; gerechnet wird weiter im Labor.",
    anzeige: (f, name) => `${name}${f.status ? ` — ${f.status}` : ""}`,
  },
  {
    seite: "Trading/Analysen.md",
    ordner: "Trading/Analysen",
    titel: "Analysen",
    satz: "Berichte von boerse, recherche und werkstatt, neueste zuerst.",
    absteigend: true,
    anzeige: (f, name) => `${name}${f.status ? ` — ${f.status}` : ""}`,
  },
  {
    seite: "Eingang.md",
    ordner: "Eingang",
    titel: "Eingang",
    satz: "Was noch keinen Platz hat: Sprachnotizen, Importe, schnelle Gedanken.",
  },
];

/** Legt das Brain an, wenn es fehlt — Repo, Einstellungen, Gerüst. Überschreibt nichts. */
export async function richteEin(workdir: string): Promise<void> {
  const wurzel = brainPfad(workdir);
  await mkdir(wurzel, { recursive: true });
  try {
    await stat(path.join(wurzel, ".git"));
  } catch {
    const git = (...a: string[]) => ausfuehren("git", a, { cwd: wurzel });
    await git("init", "-q", "-b", "main");
    await git("config", "receive.denyCurrentBranch", "updateInstead");
    await git("config", "user.name", "Kuro");
    await git("config", "user.email", "kuro@kuronami.local");
    await git("config", "core.quotepath", "false");
  }
  for (const [datei, inhalt] of Object.entries(GERUEST)) {
    const ziel = path.join(wurzel, datei);
    try {
      await stat(ziel);
    } catch {
      await mkdir(path.dirname(ziel), { recursive: true });
      await writeFile(ziel, inhalt, "utf8");
    }
  }
}

interface Quelle {
  ordner: string;
  json: string;
  datei: (d: Record<string, unknown>) => string;
  felder: (d: Record<string, unknown>) => Record<string, string | number | boolean | null>;
  inhalt: (d: Record<string, unknown>) => string;
}

const text = (x: unknown): string => (typeof x === "string" ? x : "");

function kennzahlen(k: unknown): string {
  if (typeof k !== "object" || k === null) return "";
  const zeilen = Object.entries(k as Record<string, unknown>)
    .filter(([, v]) => typeof v === "number")
    .slice(0, 14)
    .map(([n, v]) => `- ${n}: ${Number(v).toLocaleString("de-DE", { maximumFractionDigits: 3 })}`);
  return zeilen.length > 0 ? `## Kennzahlen\n${zeilen.join("\n")}` : "";
}

const QUELLEN: Quelle[] = [
  {
    ordner: "Trading/Strategien",
    json: "strategien",
    datei: (d) => dateiname(text(d.name) || text(d.id)),
    felder: (d) => ({
      art: "strategie",
      id: text(d.id),
      status: text(d.status) || null,
      symbol: text(d.symbol) || null,
      intervall: text(d.intervall) || null,
      von: text(d.von).slice(0, 10) || null,
      bis: text(d.bis).slice(0, 10) || null,
      erzeugt: true,
    }),
    inhalt: (d) =>
      [
        `# ${text(d.name) || text(d.id)}`,
        HINWEIS_ERZEUGT,
        kennzahlen(d.kennzahlen),
        text(d.notiz) ? `## Notiz\n${text(d.notiz)}` : "",
        text(d.bericht) ? `## Bericht\n${text(d.bericht)}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
  },
  {
    ordner: "Trading/Analysen",
    json: "analysen",
    datei: (d) => dateiname(`${text(d.zeit).slice(0, 10)} ${text(d.titel) || text(d.id)}`),
    felder: (d) => ({
      art: "analyse",
      id: text(d.id),
      status: text(d.status) || null,
      von: text(d.wer) || null,
      zeit: text(d.zeit) || null,
      erzeugt: true,
    }),
    inhalt: (d) =>
      [
        `# ${text(d.titel) || text(d.id)}`,
        HINWEIS_ERZEUGT,
        text(d.auftrag) ? `## Auftrag\n${text(d.auftrag)}` : "",
        text(d.bericht) ? `## Bericht\n${text(d.bericht)}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
  },
];

/** Erzeugt die Notizen einer Quelle neu, wenn sie sich ändern, und räumt verwaiste weg. */
async function erzeuge(workdir: string, q: Quelle): Promise<void> {
  let namen: string[] = [];
  try {
    namen = (await readdir(path.join(workdir, q.json))).filter((n) => n.endsWith(".json"));
  } catch {
    return;
  }
  const soll = new Set<string>();
  for (const name of namen) {
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(await readFile(path.join(workdir, q.json, name), "utf8"));
    } catch {
      continue;
    }
    let datei = `${q.datei(d)}.md`;
    if (soll.has(datei)) datei = `${q.datei(d)} (${text(d.id).slice(-6)}).md`;
    soll.add(datei);
    const ziel = brainPfad(workdir, q.ordner, datei);
    const neu = schreibeNotiz(q.felder(d), q.inhalt(d));
    let alt = "";
    try {
      alt = await readFile(ziel, "utf8");
    } catch {
      // neu
    }
    if (alt === neu) continue;
    await mkdir(path.dirname(ziel), { recursive: true });
    await writeFile(ziel, neu, "utf8");
  }
  let vorhanden: string[] = [];
  try {
    vorhanden = await readdir(brainPfad(workdir, q.ordner));
  } catch {
    return;
  }
  for (const name of vorhanden) {
    if (!name.endsWith(".md") || soll.has(name)) continue;
    const pfad = brainPfad(workdir, q.ordner, name);
    if (leseNotiz(await readFile(pfad, "utf8")).felder.erzeugt === true) await rm(pfad);
  }
}

/** Erzeugen, Verzeichnisse schreiben, sichern. Gibt zurück, ob etwas committet wurde. */
export async function pflege(workdir: string, anlass = "Stand"): Promise<boolean> {
  for (const q of QUELLEN) await erzeuge(workdir, q);
  for (const v of VERZEICHNISSE) await schreibeVerzeichnis(workdir, v);
  return sichere(workdir, anlass);
}

/** START.md für Kuros Prompt — der erste Schritt jeder Suche steht damit schon im Kontext. */
export async function startAbschnitt(workdir: string): Promise<string> {
  try {
    const { inhalt } = leseNotiz(await readFile(brainPfad(workdir, "START.md"), "utf8"));
    return `\n\n## Dein Brain (workspace/brain, START.md)\n\n${inhalt.trim().slice(0, 3000)}`;
  } catch {
    return "";
  }
}

/** Beim Start einrichten und pflegen, danach alle fünf Minuten. */
export function starteBrainTakt(workdir: string, ms = 5 * 60_000): () => void {
  let laeuft = false;
  const lauf = async (anlass: string) => {
    if (laeuft) return;
    laeuft = true;
    try {
      await pflege(workdir, anlass);
    } catch (fehler) {
      console.warn(
        `[brain] Pflege misslungen: ${fehler instanceof Error ? fehler.message : fehler}`,
      );
    } finally {
      laeuft = false;
    }
  };
  void richteEin(workdir)
    .then(() => lauf("Start"))
    .catch((fehler) => console.warn(`[brain] Einrichten misslungen: ${fehler}`));
  const uhr = setInterval(() => void lauf("Stand"), ms);
  uhr.unref();
  return () => clearInterval(uhr);
}
