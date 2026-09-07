import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";

/**
 * Harte Pfadabsicherung für die `fs.*`-Tools (S08). Das hier ist der Teil, der laut
 * Auftrag "nicht verhandelbar" ist, und er steht bewusst in einer eigenen Datei mit einer
 * eigenen Testdatei ohne Datenbank: ein Leck hier ist ein Leck im ganzen Assistenten.
 *
 * Zwei Zonen, beide mit **absoluter, per realpath aufgelöster** Wurzel:
 *   - `"artifact"` — der `ARTIFACT_ROOT`. Frei beschreibbar: das ist der Arbeitsspeicher
 *     (Abschnitt 8), Risikostufe weiches Schreiben, "automatisch im Arbeitsverzeichnis"
 *     (Abschnitt 10).
 *   - `"source"` — die Workspace-Wurzel. Nur lesbar. Ein Schreibzugriff braucht eine
 *     Freigabe, und die erteilt erst die Policy-Engine (S11); bis dahin bleibt die Zone
 *     lesbar-nur. Der Router hat den Platz für die Policy-Prüfung schon markiert (S07).
 *
 * Jeder Eingabepfad wird gegen diese Zonen aufgelöst. Landet ein Pfad lexikalisch **oder**
 * nach Auflösung aller Symlinks außerhalb *beider* Zonen, wird er abgewiesen
 * (`PathEscapeError`) — das ist das Testkriterium von S08 (Abschnitt 4.7: "`fs.*` ist auf
 * die Workspace-Wurzel beschränkt, Pfad-Traversal wird abgewiesen").
 */

/** Der Eingabepfad ist keine brauchbare Zeichenkette (leer, kein String, Nullbyte). */
export class PathInputError extends Error {}
/** Der Pfad liegt — lexikalisch oder über einen Symlink — außerhalb jeder erlaubten Zone. */
export class PathEscapeError extends Error {}

export type FsZoneName = "artifact" | "source";

export interface FsZone {
  name: FsZoneName;
  /** Absolut und bereits durch `realpath` aufgelöst. Kein abschließender Trenner. */
  root: string;
}

export interface FsZones {
  /** Nach Wurzeltiefe absteigend sortiert: bei verschachtelten Zonen gewinnt die speziellere. */
  ordered: FsZone[];
  /** Basis, gegen die relative Eingabepfade aufgelöst werden. Absolut, `realpath`-aufgelöst. */
  sourceRoot: string;
}

export interface ResolvedPath {
  /** Absoluter, symlink-freier Pfad. Nur dieser geht an eine `fs`-Operation, nie die Eingabe. */
  path: string;
  zone: FsZoneName;
  /** true, wenn der vollständige Pfad schon existiert; false, wenn eine Endkomponente neu wäre. */
  existed: boolean;
}

/**
 * Baut die Zonen. Beide Wurzeln werden per `realpath` kanonisiert — nicht aus Ordnungsliebe,
 * sondern weil `os.tmpdir()` (die Tests) und `/var` auf macOS selbst Symlinks sind. Ohne die
 * Kanonisierung vergliche die Containment-Prüfung später einen aufgelösten Ist-Pfad gegen
 * eine nicht aufgelöste Wurzel und schlüge fälschlich an.
 *
 * Die Artefaktzone wird bei Bedarf angelegt (sie gehört uns, `writeArtifact` legt ihre
 * Unterverzeichnisse ohnehin lazy an). Die Quellzone nicht: fehlt sie, ist die Konfiguration
 * falsch, und das soll auffallen statt still ein leeres Verzeichnis zu erzeugen.
 */
export async function buildFsZones(opts: {
  sourceRoot: string;
  artifactRoot: string;
}): Promise<FsZones> {
  const sourceRoot = await realpath(path.resolve(opts.sourceRoot));

  const artifactResolved = path.resolve(opts.artifactRoot);
  await mkdir(artifactResolved, { recursive: true });
  const artifactRoot = await realpath(artifactResolved);

  if (sourceRoot === artifactRoot) {
    throw new Error(
      `Artefaktzone und Quellzone dürfen nicht dieselbe Wurzel haben (${sourceRoot}); sonst wäre die Quellzone über den Umweg der Artefaktzone frei beschreibbar`,
    );
  }

  const artifactZone: FsZone = { name: "artifact", root: artifactRoot };
  const sourceZone: FsZone = { name: "source", root: sourceRoot };
  // Absteigend nach Wurzeltiefe: bei verschachtelten Zonen wird die speziellere zuerst geprüft.
  const ordered = [artifactZone, sourceZone].sort((a, b) => b.root.length - a.root.length);

  return { ordered, sourceRoot };
}

/**
 * Liegt `p` auf oder unter `root`? Rein lexikalisch — beide müssen bereits absolut und
 * normalisiert sein. `path.relative` trägt die Last: ein Ergebnis, das mit `..` beginnt oder
 * selbst absolut ist (anderes Laufwerk unter Windows), heißt "außerhalb".
 */
function contains(root: string, p: string): boolean {
  if (p === root) return true;
  const rel = path.relative(root, p);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function classify(zones: FsZones, absPath: string): FsZone | undefined {
  return zones.ordered.find((zone) => contains(zone.root, absPath));
}

/**
 * `realpath` auf den tiefsten existierenden Vorfahren von `p`; der noch nicht existierende
 * Rest wird unverändert wieder angehängt. So wirkt die Symlink-Auflösung auch auf einen
 * Pfad, dessen letzte Komponente(n) noch fehlen — der Normalfall bei `fs.write` auf eine
 * neue Datei. Ein Symlink *mitten* im Pfad (`<zone>/link/darunter/x`) wird damit genauso
 * enttarnt wie einer an der Spitze.
 *
 * Rekursiv statt mit `while (true)`: die Rekursionstiefe ist die Zahl der Pfadkomponenten,
 * also winzig, und `tail` entsteht in der richtigen Reihenfolge (Wurzel zuerst) ohne ein
 * nachträgliches `reverse()`.
 */
async function realpathDeepest(
  p: string,
  tail: string[] = [],
): Promise<{ real: string; existed: boolean }> {
  try {
    const real = await realpath(p);
    return tail.length === 0
      ? { real, existed: true }
      : { real: path.join(real, ...tail), existed: false };
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code !== "ENOENT") throw error;
    const parent = path.dirname(p);
    if (parent === p) {
      throw new PathEscapeError(
        `Kein Teil des Pfades "${p}" existiert; er lässt sich nicht gegen die Zonen prüfen`,
      );
    }
    return realpathDeepest(parent, [path.basename(p), ...tail]);
  }
}

/**
 * Löst einen Eingabepfad zu einem absoluten, symlink-freien Pfad innerhalb einer Zone auf —
 * oder wirft. Relative Eingaben zählen ab der Quellzonen-Wurzel; eine absolute Eingabe wird
 * übernommen, muss dann aber selbst in einer Zone liegen. Über beide Wege entscheidet am
 * Ende dieselbe Frage: Liegt der **aufgelöste** Pfad in einer Zone?
 */
export async function resolvePath(zones: FsZones, input: string): Promise<ResolvedPath> {
  if (typeof input !== "string" || input.length === 0) {
    throw new PathInputError("Pfad fehlt oder ist leer");
  }
  if (input.includes("\0")) {
    throw new PathInputError("Pfad enthält ein Nullbyte");
  }

  const lexical = path.isAbsolute(input)
    ? path.normalize(input)
    : path.resolve(zones.sourceRoot, input);

  // Erste, rein lexikalische Prüfung. Sie fängt `../../etc/passwd` auch dann, wenn nichts
  // davon existiert, und hält `realpath` von Pfaden fern, die ohnehin außerhalb liegen.
  if (!classify(zones, lexical)) {
    throw new PathEscapeError(
      `Pfad "${input}" liegt außerhalb der erlaubten Zonen (Artefaktzone, Quellzone)`,
    );
  }

  // Zweite Prüfung nach Auflösung aller Symlinks. Ein Pfad, der eben noch drin lag, kann
  // über einen Symlink nach draußen zeigen — genau das ist der zweite S08-Test.
  const { real, existed } = await realpathDeepest(lexical);
  const zone = classify(zones, real);
  if (!zone) {
    throw new PathEscapeError(
      `Pfad "${input}" verlässt die erlaubten Zonen über einen Symlink (Ziel: ${real})`,
    );
  }

  return { path: real, zone: zone.name, existed };
}

/**
 * Pfad relativ zur Quellzonen-Wurzel, mit `/` als Trenner — eine stabile, plattformneutrale
 * Kennung für Kontext, Zusammenfassungen und JSON. `fs.*` nimmt sie unverändert wieder als
 * Eingabe an.
 */
export function displayPath(zones: FsZones, absPath: string): string {
  const rel = path.relative(zones.sourceRoot, absPath);
  return rel === "" ? "." : rel.split(path.sep).join("/");
}
