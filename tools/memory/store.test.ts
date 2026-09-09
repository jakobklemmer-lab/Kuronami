import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseNote } from "./frontmatter.js";
import {
  MIN_BODY_CHARS,
  MemoryNoteError,
  type MemoryStore,
  NOTES_DIR,
  buildMemoryRoot,
  createMemoryStore,
  initMemoryRepo,
  slugify,
} from "./store.js";

/**
 * Der Speicher gegen ein echtes Wegwerf-Verzeichnis (und für einen Test gegen ein echtes
 * Git-Repo), ohne Postgres. Hier stehen die vier Zusagen aus `store.ts`: die Datei ist die
 * Wahrheit, nichts wird still überschrieben, Widersprüche bleiben sichtbar, Konventionen
 * gehören nicht hierher.
 */

const run = promisify(execFile);

let root: string;
let store: MemoryStore;

/** Erfundener Schlüssel in echter Form, wie in `runtime/redaction/write-paths.test.ts`. */
const FAKE_KEY =
  "sk-ant-api03-Aa0Bb1Cc2Dd3Ee4Ff5Gg6Hh7Ii8Jj9Kk0Ll1Mm2Nn3Oo4Pp5Qq6Rr7Ss8Tt9-TESTONLY";

const LONG = "Ein Text, der über der Mindestlänge liegt und etwas aussagt.";

/**
 * Aufräumen mit Wiederholungen. SQLite läuft im WAL-Modus — richtig so, weil Runtime, Gateway
 * und Heartbeat getrennte Prozesse sind, die sich dasselbe Gedächtnis teilen — und legt dafür
 * `-wal`/`-shm` daneben. Windows gibt deren Handles nach dem Schließen nicht immer sofort
 * frei; ohne Wiederholung scheitert das Aufräumen dann mit `EBUSY`, und der Test meldete einen
 * Fehler des Testrahmens als Fehler des Speichers.
 */
async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kuronami-memory-"));
  await initMemoryRepo(root, { git: false });
  store = await createMemoryStore({ root: { root }, indexFile: ":memory:", git: false });
});

afterEach(async () => {
  store.close();
  await cleanup(root);
});

async function noteFileOf(id: string): Promise<string> {
  return await readFile(path.join(root, NOTES_DIR, `${id}.md`), "utf8");
}

// ---------------------------------------------------------------------------
// Kennungen
// ---------------------------------------------------------------------------

describe("Gedächtnis · Kennungen", () => {
  it("schreibt Umlaute aus, statt sie wegzuwerfen", () => {
    // `zeitzonenprfung` wäre als Dateiname unlesbar und beim Suchen im Verzeichnis nutzlos.
    expect(slugify("Zeitzonenprüfung")).toBe("zeitzonenpruefung");
    expect(slugify("Öffentlicher Port, groß")).toBe("oeffentlicher-port-gross");
    expect(slugify("cal.list & co.")).toBe("cal-list-co");
  });

  it("baut die Kennung aus Datum und Titel", async () => {
    const result = await store.write({
      content: LONG,
      tags: ["cal"],
      title: "Kalenderfenster ist lokale Zeit",
      today: new Date(2026, 8, 9),
    });
    expect(result.note.id).toBe("2026-09-09-kalenderfenster-ist-lokale-zeit");
    expect(result.note.date).toBe("2026-09-09");
    expect(result.note.path).toBe(`${NOTES_DIR}/${result.note.id}.md`);
  });

  it("nimmt die erste Zeile als Titel, wenn keiner übergeben wird", async () => {
    const result = await store.write({
      content: `# Der Port ist offen\n\n${LONG}`,
      tags: ["server"],
      today: new Date(2026, 8, 9),
    });
    expect(result.note.title).toBe("Der Port ist offen");
  });
});

// ---------------------------------------------------------------------------
// Nichts wird still überschrieben
// ---------------------------------------------------------------------------

describe("Gedächtnis · nichts wird still überschrieben", () => {
  it("hängt -2 an, wenn dieselbe Kennung am selben Tag noch einmal entsteht", async () => {
    const today = new Date(2026, 8, 9);
    const first = await store.write({
      content: LONG,
      tags: ["cal"],
      title: "Gleicher Titel",
      today,
    });
    const second = await store.write({
      content: `${LONG} Und noch etwas anderes.`,
      tags: ["cal"],
      title: "Gleicher Titel",
      today,
    });

    expect(first.renamed).toBe(false);
    expect(second.renamed).toBe(true);
    expect(second.note.id).toBe(`${first.note.id}-2`);

    // Beide Dateien stehen da, beide sind im Index, die erste ist unverändert.
    expect(await noteFileOf(first.note.id)).toContain(LONG);
    expect(store.count()).toBe(2);
    expect(store.get(first.note.id)).not.toBeNull();
    expect(store.get(second.note.id)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Widersprüche
// ---------------------------------------------------------------------------

describe("Gedächtnis · Widersprüche sichtbar machen", () => {
  it("markiert die alte Notiz, ohne ihren Text anzufassen", async () => {
    const alt = await store.write({
      content: "Das Kalenderfenster rechnet in UTC, so steht es im Workflow.",
      tags: ["cal", "zeitzone"],
      title: "Kalenderfenster ist UTC",
      today: new Date(2026, 8, 1),
    });
    const altText = await noteFileOf(alt.note.id);

    const neu = await store.write({
      content: "Nachgemessen: das Fenster rechnet in der lokalen Zeit des Läufers, nicht in UTC.",
      tags: ["cal", "zeitzone"],
      title: "Kalenderfenster ist lokale Zeit",
      supersedes: [alt.note.id],
      today: new Date(2026, 8, 9),
    });

    expect(neu.superseded.map((entry) => entry.id)).toEqual([alt.note.id]);

    // Die alte Notiz ist **da**, ihr Rumpf ist wortgleich, und sie trägt jetzt den Verweis.
    const altNachher = parseNote(await noteFileOf(alt.note.id));
    expect(altNachher.body).toBe(parseNote(altText).body);
    expect(altNachher.fields.ersetzt_durch).toEqual([neu.note.id]);
    expect(store.get(alt.note.id)?.supersededBy).toEqual([neu.note.id]);

    // Und die neue trägt den Gegenverweis. Beide bleiben auffindbar.
    expect(parseNote(await noteFileOf(neu.note.id)).fields.ersetzt).toEqual([alt.note.id]);
    expect(store.count()).toBe(2);
    expect(store.search("Kalenderfenster Zeitzone", 10)).toHaveLength(2);
  });

  it("meldet den bloßen Verdacht: gleiche Tags, kein ausgesprochener Widerspruch", async () => {
    await store.write({
      content: "Die Brücke liefert die Termine als flache Liste ohne Wiederholungsregeln.",
      tags: ["cal"],
      title: "Erste Notiz zum Kalender",
      today: new Date(2026, 8, 1),
    });
    const zweite = await store.write({
      content: "Das Vorgabefenster ist die laufende Woche ab Montag null Uhr.",
      tags: ["cal"],
      title: "Zweite Notiz zum Kalender",
      today: new Date(2026, 8, 9),
    });

    expect(zweite.related).toHaveLength(1);
    expect(zweite.related[0].title).toBe("Erste Notiz zum Kalender");
    // Gemeldet, nicht entschieden: keine der beiden Dateien behauptet einen Widerspruch.
    expect(zweite.superseded).toEqual([]);
    expect(store.get(zweite.related[0].id)?.supersededBy).toEqual([]);
  });

  it("zählt eine ausdrücklich ersetzte Notiz nicht zusätzlich als Verdacht", async () => {
    const alt = await store.write({
      content: "Die alte Annahme über den Kalender und sein Vorgabefenster.",
      tags: ["cal"],
      title: "Alte Annahme",
      today: new Date(2026, 8, 1),
    });
    const neu = await store.write({
      content: "Die neue Erkenntnis über den Kalender und sein Vorgabefenster.",
      tags: ["cal"],
      title: "Neue Erkenntnis",
      supersedes: [alt.note.id],
      today: new Date(2026, 8, 9),
    });
    expect(neu.superseded).toHaveLength(1);
    expect(neu.related).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Die Trennung zu AGENTS.md
// ---------------------------------------------------------------------------

describe("Gedächtnis · Trennung zu AGENTS.md", () => {
  it("kennt keine Notizart für Konventionen", async () => {
    await expect(
      // @ts-expect-error — genau das ist der Punkt: es gibt den Wert nicht, auch nicht im Typ.
      store.write({ content: LONG, tags: ["stil"], kind: "konvention" }),
    ).rejects.toThrow(/AGENTS\.md/);
  });

  it("weist eine Notiz ohne Tags ab", async () => {
    await expect(store.write({ content: LONG, tags: [] })).rejects.toThrow(MemoryNoteError);
    await expect(store.write({ content: LONG, tags: ["  ", ""] })).rejects.toThrow(/keine Tags/);
  });

  it("weist eine zu kurze Notiz ab — nicht alles gehört ins Gedächtnis", async () => {
    await expect(store.write({ content: "Erledigt.", tags: ["x"] })).rejects.toThrow(
      new RegExp(String(MIN_BODY_CHARS)),
    );
  });

  it("weist auf Konventionssprache hin, ohne die Notiz abzulehnen", async () => {
    // Ein Hinweis und keine Ablehnung: eine Erkenntnis darf „immer“ enthalten.
    const klingt = await store.write({
      content: "Ich möchte künftig lieber knappe Zusammenfassungen als lange Fließtexte.",
      tags: ["stil"],
      today: new Date(2026, 8, 9),
    });
    expect(klingt.conventionSmell).toBe(true);
    expect(store.get(klingt.note.id)).not.toBeNull();

    const klingtNicht = await store.write({
      content: "Am 9. September war der Kalender-Workflow in n8n nicht erreichbar.",
      tags: ["cal"],
      today: new Date(2026, 8, 9),
    });
    expect(klingtNicht.conventionSmell).toBe(false);
  });

  it("normalisiert Tags: klein, ohne Raute, ohne Doppelungen", async () => {
    const result = await store.write({
      content: LONG,
      tags: ["#Cal", "cal", "Zeit Zone", " "],
      today: new Date(2026, 8, 9),
    });
    expect(result.note.tags).toEqual(["cal", "zeit-zone"]);
  });
});

// ---------------------------------------------------------------------------
// Der Redaction-Filter (fünfter Schreibpfad)
// ---------------------------------------------------------------------------

describe("Gedächtnis · Redaction-Filter", () => {
  it("hält ein Geheimnis aus der Notizdatei fern", async () => {
    // Der heikelste Schreibpfad von allen: eine Notiz mit einem Schlüssel läge dauerhaft in
    // einer Git-Historie und käme über den Recall in jeden verwandten Lauf zurück.
    const result = await store.write({
      content: `Der Abruf lief mit ${FAKE_KEY} und ergab nichts Brauchbares.`,
      tags: ["web"],
      title: `Abruf mit ${FAKE_KEY}`,
      today: new Date(2026, 8, 9),
    });

    const onDisk = await noteFileOf(result.note.id);
    expect(onDisk).not.toContain(FAKE_KEY);
    expect(onDisk).toContain("[redacted:anthropic-api-key]");
    expect(result.note.body).not.toContain(FAKE_KEY);
    expect(result.note.title).not.toContain(FAKE_KEY);

    // Gegenprobe: das Unverdächtige steht noch da. Ein Filter, der alles ersetzt, bestünde
    // den Test auch — und wäre wertlos.
    expect(onDisk).toContain("ergab nichts Brauchbares");
    expect(JSON.stringify(store.search("Abruf", 5))).not.toContain(FAKE_KEY);
  });
});

// ---------------------------------------------------------------------------
// Die Datei ist die Wahrheit
// ---------------------------------------------------------------------------

describe("Gedächtnis · die Datei ist die Wahrheit", () => {
  it("nimmt eine von Hand geschriebene Notiz beim Öffnen auf", async () => {
    // Der Fall, für den `syncFromDisk` da ist: jemand legt eine Notiz mit dem Editor an oder
    // holt sie per `git pull` herein. Ein Index, der das nicht mitbekommt, ist eine
    // Falschaussage.
    await writeFile(
      path.join(root, NOTES_DIR, "2026-09-05-von-hand.md"),
      [
        "---",
        "id: 2026-09-05-von-hand",
        "datum: 2026-09-05",
        "titel: Von Hand geschrieben",
        "art: ereignis",
        "tags: [handarbeit, zeitzone]",
        "---",
        "",
        "Diese Notiz hat kein Programm geschrieben, sondern ein Mensch im Editor.",
        "",
      ].join("\n"),
      "utf8",
    );

    const zweiter = await createMemoryStore({ root: { root }, indexFile: ":memory:", git: false });
    expect(zweiter.count()).toBe(1);
    expect(zweiter.search("zeitzone", 5)).toHaveLength(1);
    expect(zweiter.get("2026-09-05-von-hand")?.kind).toBe("ereignis");
    zweiter.close();
  });

  it("bemerkt eine geänderte Notiz und nimmt eine gelöschte heraus", async () => {
    const indexFile = path.join(root, "index.sqlite");
    const erster = await createMemoryStore({ root: { root }, indexFile, git: false });
    const a = await erster.write({
      content: "Die erste Fassung dieser Notiz spricht ausdrücklich von Kalendern.",
      tags: ["cal"],
      title: "Bleibt",
      today: new Date(2026, 8, 9),
    });
    const b = await erster.write({
      content: "Diese Notiz wird gleich von außen gelöscht, wie durch einen Menschen.",
      tags: ["weg"],
      title: "Verschwindet",
      today: new Date(2026, 8, 9),
    });
    erster.close();

    // Von außen ändern und löschen — so, wie ein Mensch es täte.
    const abs = path.join(root, NOTES_DIR, `${a.note.id}.md`);
    const alt = await readFile(abs, "utf8");
    await writeFile(abs, alt.replace("Kalendern", "Zeitzonen"), "utf8");
    await rm(path.join(root, NOTES_DIR, `${b.note.id}.md`));

    const zweiter = await createMemoryStore({ root: { root }, indexFile, git: false });
    expect(zweiter.count()).toBe(1);
    expect(zweiter.search("zeitzonen", 5)).toHaveLength(1);
    expect(zweiter.search("kalendern", 5)).toEqual([]);
    expect(zweiter.get(b.note.id)).toBeNull();
    zweiter.close();
  });

  it("baut den Index vollständig aus den Dateien neu", async () => {
    await store.write({ content: LONG, tags: ["a"], title: "Eins", today: new Date(2026, 8, 9) });
    await store.write({ content: LONG, tags: ["b"], title: "Zwei", today: new Date(2026, 8, 9) });
    expect(await store.reindex()).toBe(2);
    expect(store.count()).toBe(2);
    expect(store.search("Text Mindestlänge", 5).length).toBeGreaterThan(0);
  });

  it("überspringt eine kaputte Notiz, statt den Start scheitern zu lassen", async () => {
    await writeFile(path.join(root, NOTES_DIR, "kaputt.md"), "kein Frontmatter", "utf8");
    await writeFile(
      path.join(root, NOTES_DIR, "heil.md"),
      "---\nid: heil\ndatum: 2026-09-09\ntitel: Heil\nart: erkenntnis\ntags: [ok]\n---\n\nAlles gut hier.\n",
      "utf8",
    );

    const zweiter = await createMemoryStore({ root: { root }, indexFile: ":memory:", git: false });
    // Die heile Notiz ist da, die kaputte bleibt draußen — und sie bleibt auf der Platte
    // stehen, damit man sie reparieren kann.
    expect(zweiter.count()).toBe(1);
    expect(zweiter.get("heil")).not.toBeNull();
    expect(zweiter.get("kaputt")).toBeNull();
    await expect(stat(path.join(root, NOTES_DIR, "kaputt.md"))).resolves.toBeDefined();
    zweiter.close();
  });
});

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

describe("Gedächtnis · Git-Repo", () => {
  // Eigenes Zeitfenster: der Test startet rund fünfzehn Git-Prozesse, und ein Prozessstart
  // kostet unter Windows ein paar hundert Millisekunden. Das ist keine Langsamkeit des
  // Speichers, sondern die Rechnung für einen Nachweis am echten Git statt an einer Attrappe.
  it("legt ein Repo an und committet jede Notiz", { timeout: 30_000 }, async () => {
    const gitRoot = await mkdtemp(path.join(tmpdir(), "kuronami-memory-git-"));
    let gitStore: MemoryStore | undefined;
    try {
      await initMemoryRepo(gitRoot);
      // Identität und Signierung ausdrücklich für dieses Wegwerf-Repo setzen, damit der Test
      // nicht an der Git-Konfiguration des Entwicklers hängt: ohne Identität schlägt der
      // Commit fehl, mit erzwungener Signierung wartet er auf eine Passphrase.
      await run("git", ["config", "user.email", "test@kuronami.local"], { cwd: gitRoot });
      await run("git", ["config", "user.name", "Kuronami Test"], { cwd: gitRoot });
      await run("git", ["config", "commit.gpgsign", "false"], { cwd: gitRoot });

      gitStore = await createMemoryStore({ root: { root: gitRoot } });
      expect(gitStore.gitEnabled).toBe(true);

      const alt = await gitStore.write({
        content: "Die alte Annahme: das Kalenderfenster rechnet durchgehend in UTC.",
        tags: ["zeitzone"],
        title: "Alte Annahme",
        today: new Date(2026, 8, 1),
      });
      expect(alt.git.committed).toBe(true);
      expect(alt.git.error).toBeUndefined();

      const neu = await gitStore.write({
        content: "Nachgemessen: das Kalenderfenster rechnet in der lokalen Zeit des Läufers.",
        tags: ["zeitzone"],
        title: "Neue Erkenntnis",
        supersedes: [alt.note.id],
        today: new Date(2026, 8, 9),
      });
      expect(neu.git.committed).toBe(true);

      // Die Historie ist lesbar, und der Widerspruch steht in der Commit-Nachricht.
      const { stdout: log } = await run("git", ["log", "--format=%s%n%b"], { cwd: gitRoot });
      expect(log).toContain("notiz: Alte Annahme");
      expect(log).toContain("notiz: Neue Erkenntnis");
      expect(log).toContain(`Widerspricht: ${alt.note.id}`);

      // Der zweite Commit fasst beide Dateien: die neue Notiz und den Verweis in der alten.
      const { stdout: files } = await run("git", ["show", "--name-only", "--format=", "HEAD"], {
        cwd: gitRoot,
      });
      expect(files).toContain(`${NOTES_DIR}/${neu.note.id}.md`);
      expect(files).toContain(`${NOTES_DIR}/${alt.note.id}.md`);

      // Der Index ist abgeleitet und gehört nicht in die Historie.
      const { stdout: tracked } = await run("git", ["ls-files"], { cwd: gitRoot });
      expect(tracked).not.toContain("index.sqlite");
      expect(tracked).toContain(".gitignore");

      // Der Arbeitsbaum ist sauber: es bleibt nichts Uncommittetes liegen.
      const { stdout: status } = await run("git", ["status", "--porcelain"], { cwd: gitRoot });
      expect(status.trim()).toBe("");
    } finally {
      // Schließen **vor** dem Aufräumen und auch dann, wenn eine Erwartung vorher gescheitert
      // ist: eine offene SQLite-Datei hält unter Windows ihr Handle, und `rm` läuft dann in
      // seine Wiederholungen, bis der Test in ein Zeitfenster fällt. Der Testrahmen meldete
      // dann einen Hänger, wo eine Erwartung nicht erfüllt war.
      gitStore?.close();
      await cleanup(gitRoot);
    }
  });

  it("hält ein umgebendes Repo nicht für sein eigenes", async () => {
    // Der Fall aus dem echten Betrieb: `memory/` liegt **im** Quellbaum, und der ist ein
    // Git-Repo. `rev-parse --is-inside-work-tree` antwortet dort mit `true`, obwohl es kein
    // eigenes Repo gibt — der Speicher hielte das Code-Repo für seins, `git init` unterbliebe,
    // und jede Notiz landete als Commit in der Code-Historie. Beim Einrichten der echten
    // Ablage genau so beobachtet und deshalb hier festgehalten.
    const outer = await mkdtemp(path.join(tmpdir(), "kuronami-memory-outer-"));
    let inner: MemoryStore | undefined;
    try {
      await run("git", ["init", "--initial-branch=main"], { cwd: outer });
      await run("git", ["config", "user.email", "outer@kuronami.local"], { cwd: outer });
      await run("git", ["config", "user.name", "Outer"], { cwd: outer });
      await run("git", ["config", "commit.gpgsign", "false"], { cwd: outer });

      const nested = path.join(outer, "memory");
      await initMemoryRepo(nested);

      // Ein **eigenes** Repo, nicht das umgebende.
      const { stdout: top } = await run("git", ["rev-parse", "--show-toplevel"], { cwd: nested });
      expect(path.resolve(top.trim())).toBe(path.resolve(nested));

      inner = await createMemoryStore({ root: { root: nested } });
      const note = await inner.write({
        content: "Diese Notiz gehört ins Gedächtnis, nicht in die Code-Historie.",
        tags: ["trennung"],
        title: "Eigene Historie",
        today: new Date(2026, 8, 9),
      });
      expect(note.git.committed).toBe(true);

      // Das umgebende Repo hat davon nichts mitbekommen: kein Commit, und das Verzeichnis
      // steht dort als ungetracktes Etwas — nicht mit der Notiz darin.
      const { stdout: outerLog } = await run("git", ["log", "--oneline", "--all"], { cwd: outer });
      expect(outerLog.trim()).toBe("");
      const { stdout: outerFiles } = await run("git", ["ls-files"], { cwd: outer });
      expect(outerFiles.trim()).toBe("");
    } finally {
      inner?.close();
      await cleanup(outer);
    }
  }, 30_000);

  it("verliert die Notiz nicht, wenn der Commit scheitert", async () => {
    // Kein Repo, aber Git ausdrücklich verlangt: der Commit kann nicht gelingen. Die Notiz
    // liegt trotzdem — sie ist das Gedächtnis, die Historie ist die Zugabe. Der Fehler wird
    // gemeldet und nicht verschwiegen (AGENTS.md).
    const bare = await mkdtemp(path.join(tmpdir(), "kuronami-memory-nogit-"));
    let noGit: MemoryStore | undefined;
    try {
      await initMemoryRepo(bare, { git: false });
      noGit = await createMemoryStore({ root: { root: bare } });
      expect(noGit.gitEnabled).toBe(false);

      const result = await noGit.write({
        content: LONG,
        tags: ["x"],
        title: "Ohne Repo",
        today: new Date(2026, 8, 9),
      });
      expect(result.git.committed).toBe(false);
      expect(noGit.get(result.note.id)).not.toBeNull();
      await expect(
        readFile(path.join(bare, NOTES_DIR, `${result.note.id}.md`), "utf8"),
      ).resolves.toContain(LONG);
    } finally {
      noGit?.close();
      await cleanup(bare);
    }
  });
});

// ---------------------------------------------------------------------------
// Wurzel
// ---------------------------------------------------------------------------

describe("Gedächtnis · Wurzel", () => {
  it("legt die Wurzel an, wenn sie fehlt — ein leeres Gedächtnis ist kein Fehler", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "kuronami-memory-neu-"));
    try {
      const target = path.join(parent, "gibt-es-noch-nicht");
      const built = await buildMemoryRoot(target);
      await expect(stat(path.join(built.root, NOTES_DIR))).resolves.toBeDefined();
    } finally {
      await cleanup(parent);
    }
  });
});
