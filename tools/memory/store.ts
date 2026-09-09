import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { redactText } from "../../runtime/redaction/redact.js";
import { type ParsedNote, parseNote, readList, renderNote, requireScalar } from "./frontmatter.js";
import { type IndexedNote, type MemoryIndex, type SearchHit, openIndex } from "./index-db.js";

const run = promisify(execFile);

/**
 * Das Langzeitgedächtnis als Ablage: Markdown-Dateien in einem eigenen Git-Repo, daneben ein
 * abgeleiteter SQLite-Volltextindex (`index-db.ts`).
 *
 * ## Die vier Zusagen dieser Datei
 *
 *   1. **Die Datei ist die Wahrheit.** Der Index wird beim Öffnen gegen die Platte abgeglichen
 *      (`syncFromDisk`); eine von Hand geänderte, per `git pull` hereingekommene oder gelöschte
 *      Notiz ist beim nächsten Öffnen richtig im Index. Ein Gedächtnis, das man nicht mit einem
 *      Texteditor reparieren kann, ist keins.
 *
 *   2. **Nichts wird still überschrieben.** Es gibt keinen Schreibpfad, der eine bestehende
 *      Notizdatei ersetzt. Kollidiert eine Kennung, hängt der Speicher `-2`, `-3` an — dieselbe
 *      Regel, die AGENTS.md für Artefakte aufstellt. Wer eine alte Notiz für überholt hält,
 *      sagt das über `supersedes`, und dann bleiben **beide** stehen (siehe unten).
 *
 *   3. **Widersprüche werden sichtbar, nicht aufgelöst.** `supersedes` löscht nichts und ändert
 *      keinen Text: die alte Notiz bekommt im Frontmatter ein `ersetzt_durch`, die neue ein
 *      `ersetzt`. Beide bleiben auffindbar, und wer die alte findet, sieht den Verweis auf die
 *      neue. Die Entscheidung, welche gilt, trifft der Leser mit beiden Daten vor Augen — nicht
 *      der Speicher hinter seinem Rücken.
 *
 *   4. **Konventionen gehören nicht hierher.** `art` hat genau zwei Werte, `ereignis` und
 *      `erkenntnis`. Wer eine Vorliebe oder eine Dauerregel ablegen will, findet keinen
 *      passenden Wert und bekommt einen Fehlertext, der auf AGENTS.md zeigt. Siehe `NOTE_KINDS`.
 *
 * ## Warum Git und nicht nur Dateien
 *
 * Weil ein Gedächtnis eine Historie braucht, die man lesen kann, ohne dem Programm zu glauben,
 * das sie geschrieben hat. `git log memory/` beantwortet „seit wann glaubt der Assistent das?"
 * und „was stand vorher da?" — Fragen, auf die eine Datei allein keine Antwort hat. Das Repo
 * ist **eigenständig** und nicht Teil des Code-Repos: das Gedächtnis ist persönliche Ablage,
 * kein Quelltext, und es soll nicht mit einem `git push` des Projekts irgendwo landen.
 */

/** Die Kennung, das Datum oder ein anderes Pflichtfeld einer Notiz ist unbrauchbar. */
export class MemoryNoteError extends Error {}
/** Die Gedächtniswurzel fehlt oder ist kein Verzeichnis. */
export class MemoryRootError extends Error {}
/** Eine Notizkennung zeigt aus der Gedächtniswurzel heraus. */
export class MemoryEscapeError extends Error {}

/**
 * Die zwei erlaubten Notizarten — und damit die technische Seite der Trennung, die S18
 * verlangt: **Konventionen und Vorlieben nach AGENTS.md, Ereignisse und Erkenntnisse nach
 * `memory/`.**
 *
 * Die Trennung lässt sich nicht vollständig erzwingen (ob ein Satz eine Dauerregel ist, sieht
 * man ihm nicht an), aber sie lässt sich **an einer sichtbaren Stelle festmachen**: es gibt
 * keinen Wert für „Konvention". Wer eine ablegen will, stößt hier an und liest, wohin sie
 * gehört, statt sie unbemerkt im falschen Speicher zu haben. Ergänzend weist
 * `conventionSmell` auf Notizen hin, die wie eine Dauerregel klingen — als Hinweis im
 * Ergebnis, nicht als Ablehnung: eine Erkenntnis darf das Wort „immer" enthalten.
 */
export const NOTE_KINDS = ["ereignis", "erkenntnis"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

/** Unterhalb dieser Länge ist eine Notiz keine Erkenntnis, sondern eine Notiz über nichts. */
export const MIN_BODY_CHARS = 40;
/** Der Ordner, in dem die Notizen liegen. Relativ zur Gedächtniswurzel. */
export const NOTES_DIR = "notizen";
/** Standardwurzel, wenn weder Konfiguration noch `MEMORY_ROOT` etwas sagen. */
export const DEFAULT_MEMORY_DIR = "memory";

export interface MemoryRoot {
  /** Absolut, per `realpath` aufgelöst, ohne abschließenden Trenner. */
  root: string;
}

export interface MemoryStoreOptions {
  root: MemoryRoot;
  /**
   * Wo der Index liegt. Vorgabe: `<root>/index.sqlite`. Tests setzen `:memory:` — ein
   * abgeleiteter Index darf ohne Datei auskommen.
   */
  indexFile?: string;
  /**
   * Jede geschriebene Notiz sofort committen. Vorgabe an. Aus, wenn die Wurzel kein Git-Repo
   * ist (das erkennt `createMemoryStore` selbst) oder ein Test es nicht braucht.
   */
  git?: boolean;
}

export interface WriteNoteInput {
  /** Der Notiztext (Markdown). Ohne Frontmatter — das baut der Speicher. */
  content: string;
  tags: string[];
  kind?: NoteKind;
  /** Erste Zeile als Überschrift. Fehlt sie, leitet der Speicher sie aus dem Text ab. */
  title?: string;
  /** Kennungen von Notizen, denen diese hier widerspricht. Beide bleiben stehen. */
  supersedes?: string[];
  /** Woher die Notiz stammt — Session und Zug, für die Nachvollziehbarkeit. */
  source?: string;
  /** Nur für Tests: das Datum der Notiz. Vorgabe: heute, lokal. */
  today?: Date;
}

export interface WriteNoteResult {
  note: IndexedNote;
  /** true, wenn die Kennung kollidierte und `-2`/`-3` angehängt wurde. */
  renamed: boolean;
  /** Notizen, die durch `supersedes` einen Verweis auf diese hier bekommen haben. */
  superseded: IndexedNote[];
  /**
   * Ältere Notizen mit überlappenden Tags, die **nicht** als überholt markiert wurden. Der
   * Verdacht auf einen Widerspruch, den niemand ausgesprochen hat — er wird gemeldet, nicht
   * entschieden.
   */
  related: IndexedNote[];
  /** Klingt die Notiz nach einer Dauerregel (also nach AGENTS.md)? */
  conventionSmell: boolean;
  git: { committed: boolean; error?: string };
}

export interface MemoryStore {
  readonly root: string;
  readonly gitEnabled: boolean;
  search(query: string, limit?: number): SearchHit[];
  byTags(tags: readonly string[], limit?: number): IndexedNote[];
  get(id: string): IndexedNote | null;
  all(): IndexedNote[];
  count(): number;
  write(input: WriteNoteInput): Promise<WriteNoteResult>;
  /** Index vollständig aus den Dateien neu aufbauen. Gibt die Zahl der Notizen zurück. */
  reindex(): Promise<number>;
  close(): void;
}

// ---------------------------------------------------------------------------
// Wurzel
// ---------------------------------------------------------------------------

/**
 * Baut die Gedächtniswurzel. Fabrik wie `buildVaultRoot` (S15) und `createPool` (S03): die
 * Konfiguration bleibt beim Aufrufer, Tests zeigen sie auf ein Wegwerf-Verzeichnis.
 *
 * Anders als der Obsidian-Vault wird die Wurzel **angelegt**, wenn sie fehlt. Der Vault ist
 * fremdes Gebiet — existiert er nicht, ist die Konfiguration falsch, und ein neu erzeugter
 * leerer Ordner verdeckte das. `memory/` gehört diesem System; ein leeres Gedächtnis beim
 * ersten Start ist der Normalfall und kein Fehler.
 */
export async function buildMemoryRoot(memoryPath?: string): Promise<MemoryRoot> {
  const raw = memoryPath?.trim() || process.env.MEMORY_ROOT?.trim() || DEFAULT_MEMORY_DIR;
  const resolved = path.resolve(raw);
  await mkdir(path.join(resolved, NOTES_DIR), { recursive: true });

  const root = await realpath(resolved);
  const info = await stat(root);
  if (!info.isDirectory()) {
    throw new MemoryRootError(`Gedächtniswurzel "${root}" ist kein Verzeichnis.`);
  }
  return { root };
}

// ---------------------------------------------------------------------------
// Kennungen und Pfade
// ---------------------------------------------------------------------------

/** Erlaubte Form einer Notizkennung. Sie ist zugleich der Dateiname (plus `.md`). */
const NOTE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,119}$/;

/**
 * Aus einem Titel einen Dateinamensteil machen. Umlaute werden ausgeschrieben und nicht
 * weggeworfen: aus „Zeitzonenprüfung" wird `zeitzonenpruefung` und nicht `zeitzonenprfung` —
 * der zweite wäre als Dateiname unlesbar und beim Suchen im Verzeichnis nutzlos.
 */
export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/ä/g, "ae")
      .replace(/ö/g, "oe")
      .replace(/ü/g, "ue")
      .replace(/ß/g, "ss")
      .normalize("NFD")
      // Kombinierende Diakritika (U+0300–U+036F) nach der Zerlegung. Als Codepunkte
      // Die kombinierenden Zeichen nach der Zerlegung. \u00dcber die Unicode-Eigenschaft `M`
      // (Mark) und nicht \u00fcber einen Codepunkt-Bereich: eine Zeichenklasse aus kombinierenden
      // Zeichen liest sich je nach Editor anders, als sie gemeint ist.
      .replace(/\p{M}/gu, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/g, "")
  );
}

function assertNoteId(id: string): void {
  if (!NOTE_ID_PATTERN.test(id)) {
    throw new MemoryNoteError(
      `Notizkennung "${id}" ist unbrauchbar: erlaubt sind Kleinbuchstaben, Ziffern und Bindestriche, höchstens 120 Zeichen.`,
    );
  }
}

/** Der absolute Pfad einer Notiz — und die Zusage, dass er in der Wurzel bleibt. */
function notePath(root: string, id: string): string {
  assertNoteId(id);
  const abs = path.resolve(root, NOTES_DIR, `${id}.md`);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new MemoryEscapeError(`Notiz "${id}" läge außerhalb des Gedächtnisses (${abs}).`);
  }
  return abs;
}

function localIsoDate(when: Date): string {
  const year = when.getFullYear();
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// ---------------------------------------------------------------------------
// Lesen und Schreiben einzelner Dateien
// ---------------------------------------------------------------------------

/** Eine Notizdatei in ihre Indexform bringen. Wirft, wenn ein Pflichtfeld fehlt. */
function toIndexed(
  id: string,
  relPath: string,
  parsed: ParsedNote,
  mtimeMs: number,
  sizeBytes: number,
): IndexedNote {
  const kind = requireScalar(parsed, "art");
  if (!(NOTE_KINDS as readonly string[]).includes(kind)) {
    throw new MemoryNoteError(
      `Notiz "${id}": art ist "${kind}", erlaubt sind ${NOTE_KINDS.join(" und ")}. Konventionen, Vorlieben und Dauerregeln gehören nicht ins Gedächtnis, sondern nach AGENTS.md.`,
    );
  }
  return {
    id,
    path: relPath,
    date: requireScalar(parsed, "datum"),
    title: requireScalar(parsed, "titel"),
    kind,
    tags: readList(parsed, "tags"),
    body: parsed.body,
    supersedes: readList(parsed, "ersetzt"),
    supersededBy: readList(parsed, "ersetzt_durch"),
    mtimeMs,
    sizeBytes,
  };
}

async function readNoteFile(root: string, id: string): Promise<IndexedNote> {
  const abs = notePath(root, id);
  const [text, info] = await Promise.all([readFile(abs, "utf8"), stat(abs)]);
  return toIndexed(id, `${NOTES_DIR}/${id}.md`, parseNote(text), info.mtimeMs, info.size);
}

/**
 * Schreibt Bytes atomar: `.tmp` im selben Verzeichnis, `fsync`, dann `rename`. Wortgleich mit
 * `atomicWrite` in `tools/fs/tools.ts` und `tools/notes/tools.ts` — am gültigen Pfad liegt nie
 * eine halb geschriebene Notiz.
 */
async function atomicWrite(absPath: string, text: string): Promise<void> {
  await mkdir(path.dirname(absPath), { recursive: true });
  const tmpPath = `${absPath}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(tmpPath, "w");
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmpPath, absPath);
}

/** Die Frontmatter-Felder einer Notiz, in der Reihenfolge, in der ein Mensch sie lesen will. */
function noteFields(note: IndexedNote, source: string | undefined) {
  const fields: Record<string, string | string[]> = {
    id: note.id,
    datum: note.date,
    titel: note.title,
    art: note.kind,
    tags: note.tags,
  };
  if (source) fields.quelle = source;
  if (note.supersedes.length > 0) fields.ersetzt = note.supersedes;
  if (note.supersededBy.length > 0) fields.ersetzt_durch = note.supersededBy;
  return fields;
}

// ---------------------------------------------------------------------------
// Widerspruchserkennung
// ---------------------------------------------------------------------------

/**
 * Wörter, die eine Notiz nach einer **Dauerregel** klingen lassen — also nach AGENTS.md und
 * nicht nach einem Ereignis. Das ist ein Hinweis und keine Ablehnung: „das Zeitfenster ist
 * immer lokale Zeit" ist eine legitime Erkenntnis. Wer den Hinweis liest, entscheidet.
 */
const CONVENTION_MARKERS = [
  /\bab (?:jetzt|sofort|heute)\b/i,
  /\bgrundsätzlich\b/i,
  /\bbitte (?:immer|nie|niemals|künftig)\b/i,
  /\b(?:immer|nie|niemals) (?:zuerst|verwenden|benutzen|nehmen|schreiben)\b/i,
  /\bkonvention\b/i,
  /\bregel:\s/i,
  /\bich (?:möchte|will|hätte gern|bevorzuge)\b/i,
  /\blieber\b.*\bals\b/i,
];

function conventionSmell(text: string): boolean {
  return CONVENTION_MARKERS.some((pattern) => pattern.test(text));
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

/**
 * Ist `root` die **Wurzel** eines eigenen Git-Repos?
 *
 * Die Frage ist bewusst enger als „liegt in einem Repo". `rev-parse --is-inside-work-tree`
 * antwortet für jedes Unterverzeichnis eines Repos mit `true` — und `memory/` liegt im
 * Quellbaum. Mit dieser Prüfung hielte der Speicher das Hauptrepo für sein eigenes: `git init`
 * unterbliebe, und jede Notiz landete als Commit **in der Code-Historie**. Genau das soll die
 * Trennung verhindern (`docs/GEDAECHTNIS.md`).
 *
 * Also wird die Wurzel verglichen, nicht die Zugehörigkeit. `--show-toplevel` liefert einen
 * Pfad mit Schrägstrichen, auch unter Windows; `path.resolve` bringt beide Seiten auf dieselbe
 * Schreibweise.
 */
async function isGitRepo(root: string): Promise<boolean> {
  try {
    const { stdout } = await run("git", ["rev-parse", "--show-toplevel"], { cwd: root });
    return path.resolve(stdout.trim()) === path.resolve(root);
  } catch {
    return false;
  }
}

/**
 * Gibt dem Gedächtnis-Repo eine Identität — **nur**, wenn Git von sich aus keine auflösen
 * kann.
 *
 * Der Fall ist real und nicht selten: auf einem Rechner ohne globales `user.email` scheitert
 * jeder Commit, und zwar jeder einzelne. Das Gedächtnis liefe dann dauerhaft ohne Historie und
 * meldete bei jeder Notiz denselben Fehler — die Zusage „als Git-Repo" wäre eine
 * Absichtserklärung.
 *
 * Gesetzt wird **lokal in diesem Repo**, nie global, und nur ersatzweise: hat der Mensch eine
 * Identität, gewinnt seine. Der Name ist der des Systems und nicht der des Nutzers, denn das
 * ist die wahre Zuschreibung — diese Commits schreibt der Assistent.
 */
async function ensureGitIdentity(root: string): Promise<void> {
  try {
    await run("git", ["var", "GIT_COMMITTER_IDENT"], { cwd: root });
    return;
  } catch {
    // Keine auflösbare Identität — die Ablage bekommt ihre eigene.
  }
  try {
    await run("git", ["config", "user.name", "Kuronami"], { cwd: root });
    await run("git", ["config", "user.email", "kuronami@localhost"], { cwd: root });
  } catch {
    // Auch das kann scheitern (kein Git, kein Schreibrecht). Dann bleibt es beim Fehler pro
    // Commit, den `commitNotes` sichtbar meldet.
  }
}

/**
 * Committet die Notizdateien.
 *
 * Ein fehlgeschlagener Commit macht die Notiz **nicht** ungültig: die Datei liegt bereits auf
 * der Platte und steht im Index, sie ist das Gedächtnis. Der Fehler wird deshalb im Ergebnis
 * gemeldet (`git.error`) statt geworfen — verschwiegen wird er nicht (AGENTS.md, „Fehler nie
 * verstecken"). Wer die Historie braucht, sieht sofort, dass sie fehlt.
 */
async function commitNotes(
  root: string,
  files: string[],
  message: string,
): Promise<{ committed: boolean; error?: string }> {
  try {
    await run("git", ["add", "--", ...files], { cwd: root });
    await run("git", ["commit", "--no-verify", "-m", message, "--", ...files], { cwd: root });
    return { committed: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // "nothing to commit" ist kein Fehler: derselbe Inhalt noch einmal geschrieben.
    if (/nothing to commit|nichts zu committen/i.test(detail)) return { committed: false };
    return { committed: false, error: detail };
  }
}

// ---------------------------------------------------------------------------
// Der Speicher
// ---------------------------------------------------------------------------

/** Wie viele verwandte Notizen beim Schreiben gemeldet werden. */
const RELATED_LIMIT = 5;
/** Vorgabe für die Trefferzahl einer Suche. */
export const DEFAULT_SEARCH_LIMIT = 8;

export async function createMemoryStore(options: MemoryStoreOptions): Promise<MemoryStore> {
  const root = options.root.root;
  const index = openIndex(options.indexFile ?? path.join(root, "index.sqlite"));
  const gitEnabled = options.git === false ? false : await isGitRepo(root);

  await syncFromDisk(root, index);

  async function loadAll(): Promise<IndexedNote[]> {
    const dir = path.join(root, NOTES_DIR);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return [];
    }
    const notes: IndexedNote[] = [];
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".md")) continue;
      notes.push(await readNoteFile(root, entry.slice(0, -3)));
    }
    return notes;
  }

  /** Eine bestehende Notiz um einen `ersetzt_durch`-Verweis ergänzen — ohne ihren Text anzufassen. */
  async function markSuperseded(oldId: string, newId: string): Promise<IndexedNote | null> {
    const existing = index.get(oldId);
    if (!existing) return null;
    if (existing.supersededBy.includes(newId)) return existing;

    const updated: IndexedNote = {
      ...existing,
      supersededBy: [...existing.supersededBy, newId],
    };
    const abs = notePath(root, oldId);
    const parsed = parseNote(await readFile(abs, "utf8"));
    const source = typeof parsed.fields.quelle === "string" ? parsed.fields.quelle : undefined;
    // Der Rumpf wird wortgetreu übernommen. Der einzige Unterschied zur alten Datei ist das
    // neue Frontmatter-Feld: der Widerspruch steht daneben, nicht anstelle des alten Texts.
    await atomicWrite(abs, renderNote(noteFields(updated, source), existing.body));
    const info = await stat(abs);
    const refreshed = { ...updated, mtimeMs: info.mtimeMs, sizeBytes: info.size };
    index.put(refreshed);
    return refreshed;
  }

  return {
    root,
    gitEnabled,

    search(query: string, limit = DEFAULT_SEARCH_LIMIT): SearchHit[] {
      return index.search(query, limit);
    },

    byTags(tags: readonly string[], limit = DEFAULT_SEARCH_LIMIT): IndexedNote[] {
      return index.byTags(tags, limit);
    },

    get: (id: string) => index.get(id),
    all: () => index.all(),
    count: () => index.count(),

    async write(input: WriteNoteInput): Promise<WriteNoteResult> {
      // **Der fünfte Schreibpfad des Redaction-Filters** (AGENTS.md, Abschnitt 4.7). Er ist
      // der heikelste von allen: eine Notiz mit einem Zugangsschlüssel läge nicht nur im
      // Klartext auf der Platte, sondern **dauerhaft in einer Git-Historie**, aus der sie sich
      // nicht mehr entfernen lässt, und der Recall legte sie bei jedem thematisch verwandten
      // Lauf erneut in den Modellkontext. Gefiltert werden Text und Titel; Tags und Kennungen
      // bleiben unangetastet, weil sie als Schlüssel wieder nachgeschlagen werden (AGENTS.md).
      const body = redactText(input.content).trim();
      const tags = normalizeTags(input.tags);
      const kind = input.kind ?? "erkenntnis";

      if (body.length < MIN_BODY_CHARS) {
        throw new MemoryNoteError(
          `Die Notiz ist mit ${body.length} Zeichen zu kurz (mindestens ${MIN_BODY_CHARS}). Nicht alles gehört ins Gedächtnis; was hinein soll, soll in einem halben Jahr noch verständlich sein.`,
        );
      }
      if (tags.length === 0) {
        throw new MemoryNoteError(
          "Die Notiz hat keine Tags. Ohne Tags ist sie nur über zufällige Wortgleichheit auffindbar — und damit praktisch nicht.",
        );
      }
      if (!(NOTE_KINDS as readonly string[]).includes(kind)) {
        throw new MemoryNoteError(
          `art "${kind}" gibt es nicht, erlaubt sind ${NOTE_KINDS.join(" und ")}. Konventionen und Vorlieben gehören nach AGENTS.md.`,
        );
      }

      const date = localIsoDate(input.today ?? new Date());
      const title = redactText(input.title?.trim() || firstLine(body)).slice(0, 200);
      const { id, renamed } = await freeNoteId(root, `${date}-${slugify(title) || "notiz"}`);

      // Ältere Notizen zu denselben Tags — der Verdacht auf einen Widerspruch. Wird gemeldet,
      // nicht entschieden: gleiche Tags heißen gleiches Thema, nicht gegenteilige Aussage.
      const supersedes = [...new Set(input.supersedes ?? [])].filter((entry) => entry !== id);
      const related = index
        .byTags(tags, RELATED_LIMIT + supersedes.length)
        .filter((note) => !supersedes.includes(note.id) && note.id !== id)
        .slice(0, RELATED_LIMIT);

      const note: IndexedNote = {
        id,
        path: `${NOTES_DIR}/${id}.md`,
        date,
        title,
        kind,
        tags,
        body,
        supersedes,
        supersededBy: [],
        mtimeMs: 0,
        sizeBytes: 0,
      };

      const abs = notePath(root, id);
      await atomicWrite(abs, renderNote(noteFields(note, input.source), body));
      const info = await stat(abs);
      const stored = { ...note, mtimeMs: info.mtimeMs, sizeBytes: info.size };
      index.put(stored);

      const superseded: IndexedNote[] = [];
      for (const oldId of supersedes) {
        const marked = await markSuperseded(oldId, id);
        if (marked) superseded.push(marked);
      }

      const files = [stored.path, ...superseded.map((entry) => entry.path)];
      const gitResult = gitEnabled
        ? await commitNotes(root, files, commitMessage(stored, superseded))
        : { committed: false };

      return {
        note: stored,
        renamed,
        superseded,
        related,
        conventionSmell: conventionSmell(body),
        git: gitResult,
      };
    },

    async reindex(): Promise<number> {
      for (const note of index.all()) index.remove(note.id);
      const notes = await loadAll();
      for (const note of notes) index.put(note);
      return notes.length;
    },

    close(): void {
      index.close();
    },
  };
}

function commitMessage(note: IndexedNote, superseded: readonly IndexedNote[]): string {
  const head = `notiz: ${note.title}`;
  if (superseded.length === 0) return head;
  return `${head}\n\nWiderspricht: ${superseded.map((entry) => entry.id).join(", ")}`;
}

/** Erste nicht leere Zeile, ohne Markdown-Überschriftenzeichen. */
function firstLine(body: string): string {
  for (const line of body.split("\n")) {
    const trimmed = line.replace(/^#+\s*/, "").trim();
    if (trimmed !== "") return trimmed;
  }
  return "Notiz";
}

/** Tags klein, ohne Leerzeichen, ohne Duplikate, ohne leere. */
function normalizeTags(tags: readonly string[]): string[] {
  const cleaned = tags
    .map((tag) =>
      tag
        .trim()
        .toLowerCase()
        .replace(/^#/, "")
        .replace(/[\s,]+/g, "-"),
    )
    .filter((tag) => tag.length > 0 && tag.length <= 40);
  return [...new Set(cleaned)];
}

/**
 * Findet eine freie Kennung. Kollidiert der Wunschname, wird `-2`, `-3` angehängt — die Regel,
 * die AGENTS.md für Artefakte aufstellt, hier für Notizen. Zwei Erkenntnisse am selben Tag zum
 * selben Thema sind keine Doppelung, sondern zwei Notizen; die zweite die erste überschreiben
 * zu lassen, wäre der stille Verlust, den S18 ausschließt.
 */
async function freeNoteId(root: string, wanted: string): Promise<{ id: string; renamed: boolean }> {
  for (let suffix = 1; suffix < 100; suffix += 1) {
    const id = suffix === 1 ? wanted : `${wanted}-${suffix}`;
    try {
      await stat(notePath(root, id));
    } catch {
      return { id, renamed: suffix > 1 };
    }
  }
  throw new MemoryNoteError(
    `Keine freie Kennung für "${wanted}" gefunden (100 Versuche). Das deutet auf eine Schleife, die dieselbe Notiz immer wieder schreibt.`,
  );
}

/**
 * Gleicht den Index gegen die Platte ab: neue Dateien kommen hinein, geänderte werden neu
 * gelesen, verschwundene fliegen raus. Verglichen wird über mtime **und** Größe — eine
 * Änderung, die beide gleich lässt, ist mit einem Texteditor kaum herzustellen, und der volle
 * Vergleich über eine Prüfsumme kostete bei jedem Start das Lesen jeder Datei.
 *
 * Läuft bei **jedem** Öffnen. Das ist der Preis dafür, dass die Dateien die Wahrheit sind, und
 * er ist klein: ein `readdir` plus ein `stat` je Notiz.
 */
async function syncFromDisk(root: string, index: MemoryIndex): Promise<void> {
  const dir = path.join(root, NOTES_DIR);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }

  const known = index.fileState();
  const seen = new Set<string>();

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const id = entry.slice(0, -3);
    seen.add(id);

    const info = await stat(path.join(dir, entry));
    const previous = known.get(id);
    if (
      previous &&
      Math.round(previous.mtimeMs) === Math.round(info.mtimeMs) &&
      previous.sizeBytes === info.size
    ) {
      continue;
    }
    // Eine kaputte Datei bringt nicht den ganzen Start zu Fall: sie wird übersprungen und
    // bleibt unindiziert. Sie stillschweigend zu verlieren wäre schlimmer, aber der Abbruch
    // des Starts wegen einer einzigen von Hand verunglückten Notiz auch.
    try {
      index.put(await readNoteFile(root, id));
    } catch (error) {
      process.emitWarning(
        `Gedächtnisnotiz "${id}" ist nicht lesbar und bleibt außerhalb des Index: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  for (const id of known.keys()) {
    if (!seen.has(id)) index.remove(id);
  }
}

/** SHA-256 einer Notizdatei — für Tests und die Nachweisführung. */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Legt die Ablage an: Notizordner, `.gitignore` (der Index gehört nicht ins Repo) und, wenn
 * gewünscht, das Git-Repo selbst. Idempotent — ein zweiter Aufruf ändert nichts.
 */
export async function initMemoryRepo(root: string, options: { git?: boolean } = {}): Promise<void> {
  await mkdir(path.join(root, NOTES_DIR), { recursive: true });

  const gitignore = path.join(root, ".gitignore");
  try {
    await stat(gitignore);
  } catch {
    await writeFile(
      gitignore,
      [
        "# Der Volltextindex ist aus den Notizen abgeleitet und wird beim Öffnen abgeglichen.",
        "# Er gehört nicht in die Historie: er wäre bei jedem Schreiben eine Binärdifferenz",
        "# und ließe sich in einem Merge nicht zusammenführen.",
        "index.sqlite",
        "index.sqlite-wal",
        "index.sqlite-shm",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  const readme = path.join(root, "README.md");
  try {
    await stat(readme);
  } catch {
    await writeFile(readme, MEMORY_README, "utf8");
  }

  if (options.git !== false && !(await isGitRepo(root))) {
    await run("git", ["init", "--initial-branch=main"], { cwd: root });
    await ensureGitIdentity(root);
    // Grundcommit: `.gitignore` und README kommen **in** die Historie, bevor die erste Notiz
    // entsteht. Ohne ihn bliebe die `.gitignore` uncommittet liegen — und genau sie ist es,
    // die den abgeleiteten Index aus der Historie hält. Ein `git add -A` von Hand nähme ihn
    // sonst mit auf, und das fiele erst beim ersten Merge-Konflikt auf einer Binärdatei auf.
    //
    // Fehlertolerant wie `commitNotes`: auf einem frischen System ohne `user.email` scheitert
    // der Commit, und das darf das Gedächtnis nicht am Starten hindern. Die Dateien liegen
    // dann trotzdem da, nur eben noch ungetrackt.
    await commitNotes(root, [".gitignore", "README.md"], "gedaechtnis: Ablage angelegt");
  }
}

const MEMORY_README = `# Langzeitgedächtnis

Ereignisse und Erkenntnisse aus vergangenen Läufen, eine Notiz je Markdown-Datei in
\`notizen/\`. Dieses Verzeichnis ist ein **eigenes Git-Repo**, getrennt vom Quelltext: es ist
persönliche Ablage und soll nicht mit einem \`git push\` des Projekts irgendwo landen.

## Was hierher gehört — und was nicht

| Hierher (\`memory/\`) | Nach \`AGENTS.md\` |
| --- | --- |
| Ereignisse mit Folgen für später | Konventionen und Arbeitsregeln |
| Erkenntnisse über die Welt außerhalb des Codes | Vorlieben und Dauerregeln |
| Widerlegte Annahmen, Entscheidungen samt Grund | Alles, was *immer* gilt |

Die Trennung steht auch im Format: das Feld \`art\` kennt genau die Werte \`ereignis\` und
\`erkenntnis\`. Für eine Konvention gibt es bewusst keinen.

**Nicht alles wird gespeichert.** Die meisten Läufe hinterlassen nichts; das ist der
Normalfall und keine Panne.

## Von Hand arbeiten ist vorgesehen

Die Dateien sind die Wahrheit, der SQLite-Index daneben ist abgeleitet und wird beim Öffnen
gegen die Platte abgeglichen. Eine Notiz mit dem Editor zu ändern, zu löschen oder per
\`git pull\` hereinzuholen ist also ein normaler Vorgang — beim nächsten Start stimmt der
Index wieder. Geht \`index.sqlite\` verloren, wird er neu gebaut.

## Widersprüche

Eine neue Notiz überschreibt nie eine alte. Widerspricht sie einer, bekommt die alte im
Frontmatter ein \`ersetzt_durch\` und behält ihren Text; beide bleiben lesbar und tauchen
beide in der Suche auf. Welche gilt, entscheidet der Leser mit beiden Daten vor Augen.
`;
