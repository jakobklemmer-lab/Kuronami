import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

/**
 * Das Brain: Jakobs Obsidian-Vault auf dem Server (`workspace/brain`), ein eigenes, privates
 * Git-Repo ohne Remote. Kuro liest und schreibt dort, Obsidian am Mac gleicht per Git über SSH ab
 * (`receive.denyCurrentBranch updateInstead`). Single point of truth für alles, was Jakob lesen soll.
 *
 * Regel (Jakob, 02.10.): Kuro erreicht jede Notiz in höchstens vier Abfragen — START.md steht im
 * Prompt, von dort Bereich → Verzeichnis → Notiz. `pruefeErreichbarkeit` misst das.
 */

const ausfuehren = promisify(execFile);

export const BRAIN = "brain";
/** Höchstens so viele Links von START.md bis zu jeder Notiz. */
export const HOECHSTENS_SCHRITTE = 3;
/** Ordner, die nicht zum Lesestoff gehören. */
const AUSGENOMMEN = new Set([".git", ".obsidian", ".trash", "Anhänge"]);

export function brainPfad(workdir: string, ...teile: string[]): string {
  return path.join(workdir, BRAIN, ...teile);
}

// ------------------------------------------------------------------------- Eigenschaften

export type Wert = string | number | boolean | null | string[];

/** Flache YAML-Eigenschaften, wie Obsidian sie als „Properties" zeigt. Keine Verschachtelung. */
export function leseNotiz(text: string): { felder: Record<string, Wert>; inhalt: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { felder: {}, inhalt: text };
  const felder: Record<string, Wert> = {};
  let liste: string | null = null;
  for (const zeile of m[1].split("\n")) {
    const eintrag = /^\s+-\s+(.*)$/.exec(zeile);
    if (eintrag && liste) {
      (felder[liste] as string[]).push(entquote(eintrag[1]));
      continue;
    }
    const kv = /^([A-Za-z0-9_äöüÄÖÜß-]+):\s*(.*)$/.exec(zeile);
    if (!kv) continue;
    liste = null;
    const [, schluessel, roh] = kv;
    if (roh === "") {
      felder[schluessel] = [];
      liste = schluessel;
    } else if (roh.startsWith("[") && roh.endsWith("]")) {
      felder[schluessel] = roh
        .slice(1, -1)
        .split(",")
        .map((x) => entquote(x.trim()))
        .filter((x) => x !== "");
    } else {
      felder[schluessel] = skalar(roh);
    }
  }
  for (const [k, v] of Object.entries(felder))
    if (Array.isArray(v) && v.length === 0) felder[k] = null;
  return { felder, inhalt: text.slice(m[0].length).replace(/^\n+/, "") };
}

function entquote(roh: string): string {
  const t = roh.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).replace(/\\"/g, '"');
  }
  return t;
}

function skalar(roh: string): Wert {
  const t = roh.trim();
  if (t === "null" || t === "~") return null;
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return entquote(t);
}

function yamlWert(wert: string | number | boolean): string {
  if (typeof wert !== "string") return String(wert);
  // Anführungszeichen nur, wenn YAML sonst etwas anderes läse.
  return /^[\w äöüÄÖÜß.,/()€%+-]+$/.test(wert) && !/^(true|false|null|-?\d+(\.\d+)?)$/.test(wert)
    ? wert
    : `"${wert.replace(/"/g, '\\"')}"`;
}

export function schreibeNotiz(felder: Record<string, Wert | undefined>, inhalt: string): string {
  const zeilen: string[] = [];
  for (const [k, v] of Object.entries(felder)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      zeilen.push(`${k}:`, ...v.map((x) => `  - ${yamlWert(x)}`));
    } else {
      zeilen.push(`${k}: ${yamlWert(v)}`);
    }
  }
  const kopf = zeilen.length > 0 ? `---\n${zeilen.join("\n")}\n---\n\n` : "";
  return `${kopf}${inhalt.trim()}\n`;
}

/** Die erste Überschrift einer Notiz — sonst der Ersatz. */
export function erstenTitel(inhalt: string, ersatz: string): string {
  return /^#\s+(.+)$/m.exec(inhalt)?.[1].trim() || ersatz;
}

/** Ein Dateiname, den Mac, Windows und Obsidian vertragen. */
export function dateiname(titel: string): string {
  return (
    titel
      .replace(/[\\/:*?"<>|#^[\]]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 90) || "Ohne Titel"
  );
}

// ------------------------------------------------------------------------------- Dateien

export async function alleNotizen(workdir: string): Promise<string[]> {
  const wurzel = brainPfad(workdir);
  const funde: string[] = [];
  async function lauf(ordner: string): Promise<void> {
    let namen: string[];
    try {
      namen = await readdir(ordner);
    } catch {
      return;
    }
    for (const name of namen) {
      if (AUSGENOMMEN.has(name)) continue;
      const voll = path.join(ordner, name);
      const info = await stat(voll);
      if (info.isDirectory()) await lauf(voll);
      else if (name.endsWith(".md")) funde.push(path.relative(wurzel, voll));
    }
  }
  await lauf(wurzel);
  return funde.sort();
}

// --------------------------------------------------------------------------------- Suche

export interface BrainFund {
  pfad: string;
  zeilen: string[];
}

/** Notizen, in denen alle Wörter vorkommen (ohne Groß/klein), mit den passenden Zeilen. */
export async function suche(workdir: string, text: string, hoechstens = 12): Promise<BrainFund[]> {
  const woerter = text
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1);
  if (woerter.length === 0) return [];
  const funde: BrainFund[] = [];
  for (const pfad of await alleNotizen(workdir)) {
    const inhalt = await readFile(brainPfad(workdir, pfad), "utf8");
    const klein = `${pfad}\n${inhalt}`.toLowerCase();
    if (!woerter.every((w) => klein.includes(w))) continue;
    const zeilen = inhalt
      .split("\n")
      .filter((z) => woerter.some((w) => z.toLowerCase().includes(w)))
      .slice(0, 4)
      .map((z) => z.trim().slice(0, 220));
    funde.push({ pfad, zeilen });
    if (funde.length >= hoechstens) break;
  }
  return funde;
}

// ----------------------------------------------------------------- Erreichbarkeit (2–4)

/** Ziele der Links einer Notiz: `[[Name]]`, `[[Ordner/Name|Text]]`, `[Text](relativ.md)`. */
export function linksIn(inhalt: string): { wiki: string[]; relativ: string[] } {
  const wiki = [...inhalt.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)].map((m) =>
    m[1].trim(),
  );
  const relativ = [...inhalt.matchAll(/\]\(([^)\s]+\.md)\)/g)].map((m) => decodeURI(m[1]));
  return { wiki, relativ };
}

export interface Erreichbarkeit {
  /** Notiz → Zahl der Links von START.md. */
  tiefe: Map<string, number>;
  zuTief: string[];
  unerreichbar: string[];
}

/** Breitensuche von START.md über alle Links — wie Obsidian sie auflöst. */
export function erreichbarkeit(notizen: Map<string, string>): Erreichbarkeit {
  const nachName = new Map<string, string>();
  for (const pfad of notizen.keys()) {
    const ohne = pfad.replace(/\.md$/, "");
    nachName.set(ohne.toLowerCase(), pfad);
    const kurz = path.basename(ohne).toLowerCase();
    if (!nachName.has(kurz)) nachName.set(kurz, pfad);
  }
  const tiefe = new Map<string, number>();
  const start = "START.md";
  if (!notizen.has(start)) return { tiefe, zuTief: [], unerreichbar: [...notizen.keys()] };
  tiefe.set(start, 0);
  const schlange = [start];
  while (schlange.length > 0) {
    const pfad = schlange.shift() as string;
    const t = tiefe.get(pfad) as number;
    const { wiki, relativ } = linksIn(notizen.get(pfad) ?? "");
    const ziele = [
      ...wiki.map(
        (w) => nachName.get(w.toLowerCase()) ?? nachName.get(path.basename(w).toLowerCase()),
      ),
      ...relativ.map((r) => path.normalize(path.join(path.dirname(pfad), r))),
    ];
    for (const ziel of ziele) {
      if (!ziel || !notizen.has(ziel) || tiefe.has(ziel)) continue;
      tiefe.set(ziel, t + 1);
      schlange.push(ziel);
    }
  }
  const zuTief = [...tiefe].filter(([, t]) => t > HOECHSTENS_SCHRITTE).map(([p]) => p);
  const unerreichbar = [...notizen.keys()].filter((p) => !tiefe.has(p));
  return { tiefe, zuTief, unerreichbar };
}

export async function pruefeErreichbarkeit(workdir: string): Promise<Erreichbarkeit> {
  const notizen = new Map<string, string>();
  for (const pfad of await alleNotizen(workdir)) {
    notizen.set(pfad, await readFile(brainPfad(workdir, pfad), "utf8"));
  }
  return erreichbarkeit(notizen);
}

// ------------------------------------------------------------------------ Verzeichnisse

export interface Verzeichnis {
  /** Datei der Verzeichnisseite, relativ zum Brain. */
  seite: string;
  /** Ordner, dessen Notizen sie auflistet. */
  ordner: string;
  titel: string;
  satz: string;
  /** Anzeigename je Notiz; Vorgabe: der Dateiname. */
  anzeige?: (felder: Record<string, Wert>, name: string, inhalt: string) => string;
  /** Neueste zuerst (nach Dateiname absteigend). */
  absteigend?: boolean;
}

/** Schreibt eine Verzeichnisseite neu, wenn sich ihr Inhalt ändert. */
export async function schreibeVerzeichnis(workdir: string, v: Verzeichnis): Promise<boolean> {
  let namen: string[] = [];
  try {
    namen = (await readdir(brainPfad(workdir, v.ordner))).filter((n) => n.endsWith(".md"));
  } catch {
    // Ordner gibt es noch nicht — dann ist das Verzeichnis leer.
  }
  namen.sort();
  if (v.absteigend) namen.reverse();
  const zeilen: string[] = [];
  for (const name of namen) {
    const ohne = name.replace(/\.md$/, "");
    const { felder, inhalt } = leseNotiz(
      await readFile(brainPfad(workdir, v.ordner, name), "utf8"),
    );
    // Eckige Klammern und „|" würden den Link brechen.
    const text = (v.anzeige ? v.anzeige(felder, ohne, inhalt) : ohne)
      .replace(/\[/g, "(")
      .replace(/\]/g, ")")
      .replace(/\|/g, "/");
    zeilen.push(
      text === ohne ? `- [[${v.ordner}/${ohne}|${ohne}]]` : `- [[${v.ordner}/${ohne}|${text}]]`,
    );
  }
  const inhalt = schreibeNotiz(
    { erzeugt: true },
    `# ${v.titel}\n\n${v.satz}\n\n${zeilen.length > 0 ? zeilen.join("\n") : "_Noch leer._"}`,
  );
  const datei = brainPfad(workdir, v.seite);
  let bisher = "";
  try {
    bisher = await readFile(datei, "utf8");
  } catch {
    // neu
  }
  if (bisher === inhalt) return false;
  await mkdir(path.dirname(datei), { recursive: true });
  await writeFile(datei, inhalt, "utf8");
  return true;
}

// -------------------------------------------------------------------------------- Sichern

/** Committet, was sich im Brain geändert hat. Ohne Änderung nichts. Gibt zurück, ob committet wurde. */
export async function sichere(workdir: string, anlass: string): Promise<boolean> {
  const cwd = brainPfad(workdir);
  const git = (...args: string[]) => ausfuehren("git", args, { cwd });
  await git("add", "-A");
  const { stdout } = await git("status", "--porcelain");
  if (stdout.trim() === "") return false;
  await git("commit", "-q", "-m", `Kuro: ${anlass}`);
  return true;
}
