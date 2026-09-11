import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parseNote, requireScalar } from "../memory/frontmatter.js";

/**
 * Der Skill-Katalog (S18c) — Fähigkeiten mit **progressiver Offenlegung**.
 *
 * Ein Skill ist ein Verzeichnis unter `skills/` mit genau einer `SKILL.md` darin. Ihr
 * Frontmatter trägt drei Felder — `titel`, `beschreibung`, `wann` (wann anwenden) — danach
 * folgt die vollständige Anleitung als Markdown-Rumpf, beliebig lang.
 *
 * ## Wiederverwendeter Parser, keine zweite Wahrheit
 *
 * `parseNote`/`requireScalar` kommen aus `tools/memory/frontmatter.ts`. Der Parser dort ist
 * bewusst generisch gehalten (zwei Formen, `schlüssel: wert` und `schlüssel: [a, b, c]`, ohne
 * jede Kopplung an Notizen) — genau das, was eine `SKILL.md` auch braucht. Ihn hier ein
 * zweites Mal zu schreiben wäre die "zweite Wahrheit über dieselbe Frage", die S18b für die
 * Kompaktierung ausdrücklich vermieden hat (siehe `context/section.ts`).
 *
 * ## Einmal gelesen, für die ganze Session eingefroren
 *
 * `loadSkillCatalog` scannt `skills/` **einmal**, so wie `loadConventions()` `AGENTS.md`
 * einmal beim Start liest (Abschnitt 7). Der volle Rumpf jeder `SKILL.md` steht schon in
 * dieser einen Lesung im Speicher — `skill.load` (`tools/skill/tools.ts`) braucht danach
 * keinen zweiten Plattenzugriff mehr, es schlägt nur im schon geladenen Katalog nach. Das ist
 * dieselbe Bauart wie beim verzögerten Tool-Laden (S18b): der Katalog kennt alles die ganze
 * Zeit, nur was in der Anfrage an den Anbieter steht, wächst erst auf Anfrage.
 */

/** Eine `SKILL.md` fehlt ein Pflichtfeld oder ist sonst unbrauchbar. */
export class SkillFileError extends Error {}

export const SKILL_FILENAME = "SKILL.md";

/** Wie ein Toolname (Abschnitt 4.8): kleingeschrieben, Bindestrich statt Punkt erlaubt. */
const SKILL_NAME_PATTERN = /^[a-z][a-z0-9-]{0,79}$/;

export interface SkillMeta {
  /** Der Verzeichnisname unter der Skill-Wurzel, zugleich die Kennung für `skill.load`. */
  name: string;
  title: string;
  description: string;
  /** Wann anwenden — die Auslösebedingung, in einem Satz. */
  when: string;
  /** Relativ zur Skill-Wurzel, für Nachvollziehbarkeit im Protokoll. */
  path: string;
  /** Die vollständige Anleitung (Markdown), ohne Frontmatter. */
  body: string;
}

export interface SkillCatalog {
  /** Absolut, für Diagnose. */
  readonly root: string;
  /** Nach Namen sortiert, damit die Kurzliste nicht an der Verzeichnisreihenfolge hängt. */
  readonly skills: readonly SkillMeta[];
  get(name: string): SkillMeta | undefined;
}

/** Eine `SKILL.md` in ihre Metadaten zerlegen. `null`, wenn das Verzeichnis keine trägt. */
async function readSkillDir(root: string, name: string): Promise<SkillMeta | null> {
  const file = path.join(root, name, SKILL_FILENAME);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    // Ein Verzeichnis ohne SKILL.md ist kein Skill — kein Fehler, einfach nichts hier.
    return null;
  }

  const parsed = parseNote(text);
  const title = requireScalar(parsed, "titel");
  const description = requireScalar(parsed, "beschreibung");
  const when = requireScalar(parsed, "wann");
  if (parsed.body.trim() === "") {
    throw new SkillFileError(
      `Skill "${name}": die Anleitung (Rumpf nach dem Frontmatter) ist leer. Ohne sie gäbe es nichts, das skill.load nachladen könnte.`,
    );
  }

  return { name, title, description, when, path: `${name}/${SKILL_FILENAME}`, body: parsed.body };
}

/**
 * Scannt eine Skill-Wurzel und gibt den eingefrorenen Katalog zurück.
 *
 * Fehlt die Wurzel oder ist sie leer, ist das Ergebnis ein Katalog ohne Skills — kein Fehler:
 * ein System ohne konfigurierte Skills soll genauso laufen wie eines mit welchen (dieselbe
 * Zurückhaltung wie bei einem leeren Langzeitgedächtnis, S18). Eine einzelne kaputte `SKILL.md`
 * reißt den ganzen Katalog nicht mit — sie bleibt draußen und wird gemeldet, dieselbe
 * Fehlertoleranz wie `syncFromDisk` in `tools/memory/store.ts`.
 */
export async function loadSkillCatalog(rootInput: string): Promise<SkillCatalog> {
  const root = path.resolve(rootInput);

  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    entries = [];
  }

  const skills: SkillMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SKILL_NAME_PATTERN.test(entry.name)) continue;

    let meta: SkillMeta | null;
    try {
      meta = await readSkillDir(root, entry.name);
    } catch (error) {
      process.emitWarning(
        `Skill "${entry.name}" ist nicht lesbar und bleibt außerhalb des Katalogs: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }
    if (meta) skills.push(meta);
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  const byName = new Map(skills.map((skill) => [skill.name, skill]));

  return {
    root,
    skills,
    get: (name: string) => byName.get(name),
  };
}
