import { createRequire } from "node:module";

/**
 * `node:sqlite` wird bewusst über `createRequire` geholt und nicht mit einem
 * `import`-Statement.
 *
 * Der Grund liegt außerhalb dieses Moduls: `sqlite` ist ein eingebautes Modul, das **nur**
 * unter seinem `node:`-Präfix ladbar ist, und steht deshalb nicht in `module.builtinModules`.
 * Die Werkzeuge um Vite herum (und damit vitest) erkennen ein Builtin an einer hartkodierten
 * Namensliste, in der `sqlite` fehlt; ein statischer Import scheitert dort mit „Failed to load
 * url sqlite", obwohl Node das Modul längst mitbringt. Über die Konfiguration ist das nicht zu
 * heilen — die Liste ist keine Einstellung.
 *
 * `createRequire` geht an der Modulanalyse vorbei und lädt zur Laufzeit aus Node, in jedem der
 * drei Wege gleich (`tsc`, `tsx`, vitest). Die Typen bleiben vollständig: `typeof import(...)`
 * ist ein reiner Typausdruck und erzeugt keinen Import. Der Tag, an dem `sqlite` in der Liste
 * steht, macht daraus wieder ein gewöhnliches `import` — bis dahin steht der Grund hier.
 */
// Der Typalias steht bewusst in einer eigenen Zeile: als Inline-Ausdruck bricht der Formatierer
// ihn über drei Zeilen um, und die mehrzeilige Form von `typeof import(...)` versteht der
// Transformator des Testrunners nicht (`Expected "{" but found ")"`).
type SqliteModule = typeof import("node:sqlite");
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as SqliteModule;
type DatabaseSync = InstanceType<typeof DatabaseSync>;

/**
 * Der Volltextindex des Langzeitgedächtnisses: SQLite mit FTS5, **keine Vektordatenbank**
 * (Auftrag S18).
 *
 * ## Warum kein Vektorindex
 *
 * Nicht aus Sparsamkeit. Ein Vektorindex beantwortet "was ähnelt dem hier" mit einer Zahl,
 * die niemand nachrechnen kann — und genau das ist in einem Gedächtnis die falsche
 * Eigenschaft. Wenn eine alte Notiz beim neuen Lauf **nicht** auftaucht, muss man sagen
 * können warum; bei BM25 über nachlesbare Wörter kann man das (das Wort steht nicht drin),
 * bei einer Einbettung nicht. Dazu kommt, dass ein Einbettungsmodell eine zweite, versionierte
 * Abhängigkeit wäre: wechselt es, ist der ganze Index ungültig, und zwar stumm. Der Preis ist
 * echt und wird bezahlt: wer „Zeitzone" schreibt, findet keine Notiz, die nur von „Sommerzeit"
 * spricht. Der Ausgleich sind Tags, die der Schreiber selbst vergibt.
 *
 * ## Der Index ist abgeleitet, die Dateien sind die Wahrheit
 *
 * Dieselbe Aussage wie „der Snapshot ist aus dem Protokoll herleitbar" (S05) und aus demselben
 * Grund: das Gedächtnis liegt als Markdown in einem Git-Repo, das ein Mensch in seinem Editor
 * bearbeitet, per `git pull` fortschreibt und im Zweifel von Hand repariert. Ein Index, der
 * das nicht mitbekäme, wäre nach der ersten Handänderung eine Falschaussage. Deshalb:
 *
 *   * `index.sqlite` gehört **nicht** ins Git-Repo (siehe `memory/.gitignore`),
 *   * `syncFromDisk` gleicht beim Öffnen Dateien gegen Index ab (mtime und Größe),
 *   * eine abweichende `SCHEMA_VERSION` verwirft den Index vollständig und baut ihn neu.
 *
 * Ein verlorener Index kostet einen Neuaufbau. Ein verlorenes Markdown kostet das Gedächtnis.
 */

/**
 * Hochzählen, wenn sich Tabellenform, Tokenizer oder Spaltengewichte ändern. Der Index wird
 * dann verworfen und neu gebaut — er ist abgeleitet, das kostet nur Zeit. Eine Migration wie
 * für Postgres (S02) gibt es hier bewusst nicht: sie wäre Aufwand für Daten, die sich in
 * Sekunden aus den Dateien wiederherstellen lassen.
 */
export const SCHEMA_VERSION = 1;

/**
 * `remove_diacritics 2` faltet Umlaute: „Zeitzonenüberschreitung" findet auch, wer
 * „uberschreitung" tippt, und `öffentlich`/`offentlich` sind derselbe Begriff. Die Stufe 2
 * (nicht 1) ist die, die auch mehrbyteige Zeichen behandelt — Stufe 1 ließe genau die
 * deutschen Umlaute stehen und wäre damit für dieses Gedächtnis die falsche.
 */
const TOKENIZER = "unicode61 remove_diacritics 2";

/**
 * Spaltengewichte für BM25. Ein Treffer im Titel wiegt schwerer als einer im Rumpf, ein
 * Tag-Treffer am schwersten: Tags sind das einzige Feld, das der Schreiber **absichtlich**
 * vergibt, während ein Wort im Rumpf auch beiläufig fallen kann. Negativ, weil `bm25()` in
 * SQLite kleinere Werte für bessere Treffer liefert und wir aufsteigend sortieren.
 */
const BM25_WEIGHTS = { title: 6.0, tags: 10.0, body: 1.0 };

export interface IndexedNote {
  id: string;
  /** Relativ zur Gedächtniswurzel, mit `/` als Trenner. */
  path: string;
  /** ISO-Datum `JJJJ-MM-TT`. */
  date: string;
  title: string;
  /** `ereignis` oder `erkenntnis` — siehe `store.ts`, die Trennung zu AGENTS.md. */
  kind: string;
  tags: string[];
  body: string;
  /** Kennungen von Notizen, die diese hier überholt. */
  supersedes: string[];
  /** Kennungen neuerer Notizen, die dieser hier widersprechen. */
  supersededBy: string[];
  /** Dateizustand, um eine Handänderung zu erkennen. */
  mtimeMs: number;
  sizeBytes: number;
}

export interface SearchHit {
  note: IndexedNote;
  /** BM25, kleiner ist besser. Steht im Ergebnis, damit ein Ranking nachvollziehbar bleibt. */
  score: number;
  /** Textausschnitt um den Treffer, mit `«»` um die Fundstellen. */
  snippet: string;
  /**
   * Woher der Treffer kommt. `volltext` ist der Normalfall (BM25 über FTS5); `teilwort` ist
   * der Rückfall für deutsche Komposita (siehe `substringSearch`) und sagt zugleich, dass es
   * keinen einzigen Volltexttreffer gab.
   */
  matched: "volltext" | "teilwort";
}

/**
 * Was `node:sqlite` zurückgibt: ein Objekt mit Werten, die alles Mögliche sein können. Die
 * Zeilen werden deshalb **feldweise gelesen und geprüft** statt mit einem Cast durchgereicht.
 * Ein Cast wäre kürzer und stünde genau dort falsch, wo dieser Index verwundbar ist: er wird
 * von einer Datei gelesen, die außerhalb dieses Prozesses liegt und die jemand mit einem
 * beliebigen SQLite-Werkzeug angefasst haben kann.
 */
type SqlRow = Record<string, unknown>;

function text(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new TypeError(
      `Indexspalte "${column}" ist ${typeof value}, erwartet wird Text. Der Index passt nicht zum Schema — er wird beim nächsten Öffnen mit anderer SCHEMA_VERSION neu gebaut.`,
    );
  }
  return value;
}

function numeric(row: SqlRow, column: string): number {
  const value = row[column];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new TypeError(`Indexspalte "${column}" ist ${typeof value}, erwartet wird eine Zahl.`);
}

function jsonList(row: SqlRow, column: string): string[] {
  const parsed: unknown = JSON.parse(text(row, column));
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function toNote(row: SqlRow): IndexedNote {
  return {
    id: text(row, "id"),
    path: text(row, "path"),
    date: text(row, "date"),
    title: text(row, "title"),
    kind: text(row, "kind"),
    tags: jsonList(row, "tags"),
    body: text(row, "body"),
    supersedes: jsonList(row, "supersedes"),
    supersededBy: jsonList(row, "superseded_by"),
    mtimeMs: numeric(row, "mtime_ms"),
    sizeBytes: numeric(row, "size_bytes"),
  };
}

/**
 * Deutsche Füllwörter. Ohne sie besteht eine Anfrage wie „Wie war das nochmal mit der
 * Zeitzone im Kalender?" zur Hälfte aus Wörtern, die in jeder Notiz stehen — BM25 gewichtet
 * häufige Terme zwar ab, aber bei einem kleinen Bestand (Dutzende bis Hunderte Notizen) reicht
 * das nicht: dort ist „mit" nicht selten genug, um harmlos zu sein.
 *
 * Die Liste ist bewusst kurz und enthält **nur** Wörter ohne eigene Aussage. Kein Stemming:
 * das wäre für Deutsch ohne Bibliothek nicht seriös zu machen, und ein falsch gekürzter Stamm
 * verhindert Treffer, statt welche zu schaffen. Stattdessen sucht `buildMatchQuery` mit
 * Präfix, was den häufigsten Fall (Plural, Genitiv, Komposita-Anfang) mit abdeckt.
 */
const STOPWORDS = new Set([
  "aber",
  "alle",
  "als",
  "also",
  "am",
  "an",
  "auch",
  "auf",
  "aus",
  "bei",
  "beim",
  "bin",
  "bis",
  "das",
  "dass",
  "dem",
  "den",
  "denn",
  "der",
  "des",
  "die",
  "dies",
  "diese",
  "diesem",
  "diesen",
  "dieser",
  "dieses",
  "doch",
  "dort",
  "du",
  "durch",
  "ein",
  "eine",
  "einem",
  "einen",
  "einer",
  "eines",
  "er",
  "es",
  "etwas",
  "für",
  "gab",
  "gegen",
  "hab",
  "habe",
  "haben",
  "hat",
  "hatte",
  "hier",
  "ich",
  "ihr",
  "im",
  "in",
  "ist",
  "ja",
  "jetzt",
  "kann",
  "man",
  "mehr",
  "mein",
  "mit",
  "muss",
  "nach",
  "nicht",
  "noch",
  "nochmal",
  "nun",
  "nur",
  "ob",
  "oder",
  "ohne",
  "schon",
  "sehr",
  "sein",
  "seine",
  "sich",
  "sie",
  "sind",
  "so",
  "über",
  "um",
  "und",
  "uns",
  "unser",
  "vom",
  "von",
  "vor",
  "war",
  "waren",
  "was",
  "wenn",
  "wer",
  "werden",
  "wie",
  "wieder",
  "wir",
  "wird",
  "wo",
  "zu",
  "zum",
  "zur",
]);

/** Zeichen, die FTS5 als Syntax läse. Sie fliegen raus, statt die Anfrage scheitern zu lassen. */
const TERM_SPLIT = /[^\p{L}\p{N}_]+/u;

/** Mehr Terme verwässern das Ranking, statt es zu schärfen. */
const MAX_QUERY_TERMS = 12;

/**
 * Baut aus Freitext eine FTS5-Anfrage.
 *
 * Die Eingabe ist die Frage eines Menschen („Wie war das mit den Zeitzonen im Kalender?"),
 * nicht eine Suchsyntax. Sie **direkt** als MATCH-Ausdruck einzusetzen wäre der übliche Fehler:
 * ein Bindestrich, ein Doppelpunkt oder ein zufälliges `AND` machen daraus entweder einen
 * Syntaxfehler oder — schlimmer — eine stille andere Anfrage. Deshalb wird zerlegt, gefiltert,
 * jeder Term einzeln gequotet und mit `OR` verbunden.
 *
 * `OR` und nicht `AND`: ein Gedächtnis soll bei teilweiser Überschneidung antworten. Die
 * Reihenfolge macht dann BM25 — eine Notiz, die zwei der drei Terme trägt, steht über einer
 * mit nur einem. Mit `AND` fände eine thematisch verwandte Notiz gar nicht statt, sobald ein
 * Wort der Frage in ihr fehlt, und genau das ist der Fall, den S18 lösen soll.
 */
export function queryTerms(query: string): string[] {
  const terms = query
    .toLowerCase()
    .split(TERM_SPLIT)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3 && !STOPWORDS.has(term));
  // Doppelte Terme fallen weg: sie verschöben nur das Ranking zugunsten von Wiederholung.
  return [...new Set(terms)].slice(0, MAX_QUERY_TERMS);
}

export function buildMatchQuery(query: string): string | null {
  const unique = queryTerms(query);
  if (unique.length === 0) return null;

  // `"term"*` — die Anführungszeichen machen den Term zu einem Literal (kein `AND`, kein
  // `NEAR`, kein `-` als Operator), der Stern sucht mit Präfix. Ein `"` im Term selbst kann
  // nach dem Zerlegen nicht mehr vorkommen.
  return unique.map((term) => `"${term}"*`).join(" OR ");
}

export interface MemoryIndex {
  /** Legt eine Notiz an oder ersetzt sie vollständig. Kennung ist `note.id`. */
  put(note: IndexedNote): void;
  remove(id: string): void;
  get(id: string): IndexedNote | null;
  all(): IndexedNote[];
  /** Freitextsuche. Leer, wenn die Anfrage nach dem Filtern keine Terme mehr hat. */
  search(query: string, limit: number): SearchHit[];
  /** Alle Notizen mit mindestens einem der Tags, neueste zuerst. */
  byTags(tags: readonly string[], limit: number): IndexedNote[];
  /** Dateizustand für den Abgleich beim Öffnen: Kennung → mtime/Größe. */
  fileState(): Map<string, { mtimeMs: number; sizeBytes: number; path: string }>;
  count(): number;
  close(): void;
}

/**
 * Öffnet (oder erstellt) den Index an `file`. `:memory:` ist erlaubt und wird von den Tests
 * genutzt — ein Index ohne Datei ist genau das, was ein abgeleiteter Index sein darf.
 *
 * Die Tabellen: `notes` trägt die Metadaten und den Rumpf, `notes_fts` ist der Suchindex
 * darüber. Bewusst **keine** `content=`-Kopplung (externer Inhalt) mit Triggern: die spart
 * Plattenplatz und kostet dafür eine Klasse von Fehlern, bei denen Index und Tabelle
 * auseinanderlaufen und die Suche Zeilen liefert, die es nicht mehr gibt. Bei einem Bestand in
 * der Größenordnung von Hunderten Notizen ist die doppelte Ablage nicht messbar.
 */
export function openIndex(file: string): MemoryIndex {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  const version = currentSchemaVersion(db);
  if (version !== SCHEMA_VERSION) {
    db.exec("DROP TABLE IF EXISTS notes_fts");
    db.exec("DROP TABLE IF EXISTS notes");
    db.exec("DROP TABLE IF EXISTS meta");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notes (
      id            TEXT PRIMARY KEY,
      path          TEXT NOT NULL UNIQUE,
      date          TEXT NOT NULL,
      title         TEXT NOT NULL,
      kind          TEXT NOT NULL,
      tags          TEXT NOT NULL,
      body          TEXT NOT NULL,
      supersedes    TEXT NOT NULL,
      superseded_by TEXT NOT NULL,
      mtime_ms      INTEGER NOT NULL,
      size_bytes    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notes_date ON notes(date DESC);
  `);
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
       note_id UNINDEXED, title, tags, body, tokenize='${TOKENIZER}'
     )`,
  );
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)").run(
    String(SCHEMA_VERSION),
  );

  const insertNote = db.prepare(
    `INSERT OR REPLACE INTO notes
       (id, path, date, title, kind, tags, body, supersedes, superseded_by, mtime_ms, size_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const deleteNote = db.prepare("DELETE FROM notes WHERE id = ?");
  const deleteFts = db.prepare("DELETE FROM notes_fts WHERE note_id = ?");
  const insertFts = db.prepare(
    "INSERT INTO notes_fts(note_id, title, tags, body) VALUES (?, ?, ?, ?)",
  );
  const selectOne = db.prepare("SELECT * FROM notes WHERE id = ?");
  const selectAll = db.prepare("SELECT * FROM notes ORDER BY date DESC, id DESC");
  const selectState = db.prepare("SELECT id, path, mtime_ms, size_bytes FROM notes");
  const countAll = db.prepare("SELECT count(*) AS n FROM notes");

  const searchStatement = db.prepare(
    `SELECT n.*,
            bm25(notes_fts, 0.0, ${BM25_WEIGHTS.title}, ${BM25_WEIGHTS.tags}, ${BM25_WEIGHTS.body}) AS score,
            snippet(notes_fts, 3, '«', '»', '…', 18) AS snippet
       FROM notes_fts
       JOIN notes n ON n.id = notes_fts.note_id
      WHERE notes_fts MATCH ?
      ORDER BY score
      LIMIT ?`,
  );

  return {
    put(note: IndexedNote): void {
      const tags = note.tags.join(" ");
      insertNote.run(
        note.id,
        note.path,
        note.date,
        note.title,
        note.kind,
        JSON.stringify(note.tags),
        note.body,
        JSON.stringify(note.supersedes),
        JSON.stringify(note.supersededBy),
        Math.round(note.mtimeMs),
        note.sizeBytes,
      );
      // Erst löschen, dann einfügen: FTS5 kennt kein UPSERT, und ohne das Löschen stünde eine
      // geänderte Notiz zweimal im Index und träfe doppelt.
      deleteFts.run(note.id);
      insertFts.run(note.id, note.title, tags, note.body);
    },

    remove(id: string): void {
      deleteNote.run(id);
      deleteFts.run(id);
    },

    get(id: string): IndexedNote | null {
      const row = selectOne.get(id) as SqlRow | undefined;
      return row ? toNote(row) : null;
    },

    all(): IndexedNote[] {
      return (selectAll.all() as SqlRow[]).map(toNote);
    },

    search(query: string, limit: number): SearchHit[] {
      const match = buildMatchQuery(query);
      if (match === null) return [];

      const hits = (searchStatement.all(match, limit) as SqlRow[]).map(
        (row): SearchHit => ({
          note: toNote(row),
          score: numeric(row, "score"),
          snippet: text(row, "snippet"),
          matched: "volltext",
        }),
      );
      if (hits.length > 0) return hits;

      // **Rückfall für deutsche Komposita.** FTS5 sucht mit Präfix, und das trägt im Deutschen
      // nur in eine Richtung: „kalender" findet „Kalenderfenster", aber „Terminkalender"
      // findet „Kalender" nicht — Komposita hängen hinten an, der Präfix greift vorn. Genau
      // dieser Fall ist beim Nachweis am echten Gedächtnis aufgefallen: die Frage „Wie
      // berechnet der Terminkalender die Sommerzeit?" fand die Kalendernotiz nicht.
      //
      // Deshalb ein zweiter Durchgang mit Teilwortsuche, aber **nur wenn der erste leer
      // blieb**. So zahlt der Normalfall nichts, und die unschärferen Treffer verwässern kein
      // Ranking, das es sonst gäbe. Ein Trigram-Index wäre die Lösung für einen Bestand, den
      // dieses Gedächtnis nie erreicht; bei Hunderten Notizen ist ein Durchgang durch die
      // Tabelle nicht messbar.
      return substringSearch(selectAll.all() as SqlRow[], queryTerms(query), limit);
    },

    byTags(tags: readonly string[], limit: number): IndexedNote[] {
      if (tags.length === 0) return [];
      const wanted = new Set(tags.map((tag) => tag.toLowerCase()));
      // Über `all()` statt über FTS: die Tag-Menge ist klein, und ein exakter Mengenvergleich
      // ist hier richtiger als ein Volltexttreffer — `cal` soll nicht auf `calendar` passen.
      return (selectAll.all() as SqlRow[])
        .map(toNote)
        .filter((note) => note.tags.some((tag) => wanted.has(tag.toLowerCase())))
        .slice(0, limit);
    },

    fileState(): Map<string, { mtimeMs: number; sizeBytes: number; path: string }> {
      return new Map(
        (selectState.all() as SqlRow[]).map((row) => [
          text(row, "id"),
          {
            mtimeMs: numeric(row, "mtime_ms"),
            sizeBytes: numeric(row, "size_bytes"),
            path: text(row, "path"),
          },
        ]),
      );
    },

    count(): number {
      return (countAll.get() as { n: number }).n;
    },

    close(): void {
      db.close();
    },
  };
}

/** Mindestlänge eines Terms für die Teilwortsuche. Kürzere träfen fast überall. */
const SUBSTRING_MIN_TERM = 4;

/**
 * Der Rückfall: Teilwortsuche in **beiden** Richtungen.
 *
 * Beide Richtungen sind nötig, und die zweite ist die eigentlich interessante:
 *
 *   * **Term im Notizwort** — die Suche nach „kalender" trifft „Terminkalender". Das deckt
 *     FTS5 nur ab, wenn der Term am Wortanfang steht.
 *   * **Notizwort im Term** — die Suche nach „Terminkalender" trifft eine Notiz über
 *     „Kalender". Das ist der Fall aus dem Nachweis am echten Gedächtnis, und FTS5 kann ihn
 *     grundsätzlich nicht: der Index kennt die Wörter der Notiz, nicht ihre Bestandteile.
 *
 * Gewertet wird nach der Zahl der getroffenen Terme, dann nach Datum (neuere zuerst). BM25
 * gibt es hier nicht, und eine erfundene Zahl wäre schlechter als eine ehrliche Reihenfolge:
 * der `score` bleibt `0`, und `matched: "teilwort"` sagt, woher der Treffer stammt.
 */
function substringSearch(rows: SqlRow[], terms: readonly string[], limit: number): SearchHit[] {
  const usable = terms.filter((term) => term.length >= SUBSTRING_MIN_TERM);
  if (usable.length === 0) return [];

  const scored: { note: IndexedNote; hits: number; term: string }[] = [];
  for (const row of rows) {
    const note = toNote(row);
    const haystack = `${note.title}\n${note.tags.join(" ")}\n${note.body}`.toLowerCase();
    const words = haystack.split(TERM_SPLIT).filter((word) => word.length >= SUBSTRING_MIN_TERM);

    let hits = 0;
    let first = "";
    for (const term of usable) {
      const word = haystack.includes(term)
        ? term
        : words.find((candidate) => term.includes(candidate));
      if (word === undefined) continue;
      hits += 1;
      if (first === "") first = word;
    }
    if (hits > 0) scored.push({ note, hits, term: first });
  }

  return scored
    .sort((a, b) => b.hits - a.hits || b.note.date.localeCompare(a.note.date))
    .slice(0, limit)
    .map((entry) => ({
      note: entry.note,
      score: 0,
      snippet: substringSnippet(entry.note.body, entry.term),
      matched: "teilwort" as const,
    }));
}

/** Ein Ausschnitt um die Fundstelle, in denselben Marken wie `snippet()` von FTS5. */
function substringSnippet(body: string, term: string): string {
  const flat = body.replace(/\s+/g, " ");
  const at = flat.toLowerCase().indexOf(term);
  if (at === -1) return flat.slice(0, 120);
  const from = Math.max(0, at - 40);
  const to = Math.min(flat.length, at + term.length + 60);
  const inner = `${flat.slice(from, at)}«${flat.slice(at, at + term.length)}»${flat.slice(at + term.length, to)}`;
  return `${from > 0 ? "…" : ""}${inner}${to < flat.length ? "…" : ""}`;
}

/** Die Schemaversion des vorhandenen Index, oder `null` bei einem frischen/fremden. */
function currentSchemaVersion(db: DatabaseSync): number | null {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    return row ? Number(row.value) : null;
  } catch {
    // Kein `meta` — also ein frischer oder ein Index aus der Zeit vor dieser Tabelle.
    return null;
  }
}
