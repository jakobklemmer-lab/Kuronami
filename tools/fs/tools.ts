import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { writeArtifact } from "../../runtime/artifacts/store.js";
import type { ToolDefinition, ToolInvocation, ToolOutput } from "../types.js";
import { type FsZones, type ResolvedPath, displayPath, resolvePath } from "./paths.js";

/**
 * Die fünf Kern-Primitive `fs.list`, `fs.read`, `fs.write`, `fs.edit`, `fs.search`
 * (Abschnitt 9). Jedes läuft über `tools/router.ts` und damit durch die Ausführungshülle
 * aus S05 — Checkpoint davor und danach, Idempotenzschlüssel, Zeitfenster. Diese Datei
 * baut nur die Definitionen und die Handler; die einheitliche Rückgabehülle, die
 * Auslagerung großer Ergebnisse und die Ereignisse macht der Router.
 *
 * Die Pfadabsicherung steckt vollständig in `resolvePath` (`./paths.ts`). Kein Handler
 * hier arbeitet je mit einem Pfad, den er nicht durch `resolvePath` geschickt hat, und
 * keiner öffnet je die rohe Eingabe.
 */

/** Schreiben in die Quellzone ist ohne Freigabe verboten; die Freigabe erteilt S11. */
export class SourceZoneWriteError extends Error {}
/** Ziel existiert nicht. */
export class FsNotFoundError extends Error {}
/** Ziel ist keine reguläre Datei, obwohl eine erwartet wurde. */
export class FsNotAFileError extends Error {}
/** Ziel ist kein Verzeichnis, obwohl eines erwartet wurde. */
export class FsNotADirectoryError extends Error {}
/** Die Datei wurde seit dem letzten `fs.read` verändert (stale read). `fs.edit` bricht ab. */
export class StaleFileError extends Error {}
/** `old_string` kommt in der Datei nicht vor. */
export class EditTargetNotFoundError extends Error {}
/** `old_string` kommt mehrfach vor und `replace_all` ist nicht gesetzt. */
export class EditTargetAmbiguousError extends Error {}
/** Der Suchausdruck ist kein gültiger regulärer Ausdruck oder zu lang. */
export class FsSearchPatternError extends Error {}

export interface FsToolDeps {
  pool: Pool;
  /** Wurzel der Artefaktablage, für die Selbst-Auslagerung großer `fs.read`-Ergebnisse. */
  artifactRoot: string;
  zones: FsZones;
}

/**
 * `fs.read` gibt eine Datei, deren Slice **komplett** unter diese Grenzen passt, unverändert
 * im Kontext zurück. Alles darüber wird zu Ausschnitt plus Artefakt (Auftrag S08). Die Werte
 * liegen deutlich unter der Auslagerungsschwelle des Routers (8k Token ≈ 32 KB), damit der
 * Router die schon knappe `fs.read`-Hülle nicht ein zweites Mal auslagert.
 */
const READ_INLINE_MAX_BYTES = 64 * 1024;
const READ_INLINE_MAX_LINES = 2_000;
/** Größe des Ausschnitts, der bei einer großen Datei im Kontext bleibt. */
const READ_EXCERPT_LINES = 40;
/** Eine einzelne Ausschnittszeile wird hierauf gekürzt, damit ein Minified-Blob die Hülle nicht sprengt. */
const READ_EXCERPT_LINE_CAP = 400;
/** So viele Bytes vom Anfang werden auf ein Nullbyte abgetastet, um Binärdateien zu erkennen. */
const BINARY_SNIFF_BYTES = 8_192;

/** Verzeichnisse, die `fs.list --recursive` und `fs.search` nie betreten. */
const PRUNE_DIRS: ReadonlySet<string> = new Set([".git", "node_modules"]);
const LIST_MAX_ENTRIES = 2_000;

const SEARCH_MAX_RESULTS = 200;
const SEARCH_MAX_PER_FILE = 50;
const SEARCH_MAX_FILES = 5_000;
const SEARCH_LINE_CAP = 240;
const SEARCH_PATTERN_MAX = 1_000;

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Ein Nullbyte im Kopf der Datei heißt: das ist kein Text, nicht zeilenweise behandeln. */
function looksBinary(buf: Buffer): boolean {
  const end = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < end; i += 1) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function guessMimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".json":
      return "application/json";
    case ".md":
    case ".markdown":
      return "text/markdown";
    case ".html":
    case ".htm":
      return "text/html";
    case ".csv":
      return "text/csv";
    case ".txt":
    case ".log":
    case ".ts":
    case ".tsx":
    case ".js":
    case ".mjs":
    case ".cjs":
    case ".css":
    case ".sql":
    case ".yml":
    case ".yaml":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

/**
 * Schreibt Bytes an ihren endgültigen Pfad, ohne dass dort je eine halb geschriebene Datei
 * liegt: erst in eine `.tmp`-Datei im selben Verzeichnis, `fsync`, dann `rename`. Dasselbe
 * Muster wie `writeArtifact` (S06).
 */
async function atomicWrite(absPath: string, bytes: Buffer): Promise<void> {
  await mkdir(path.dirname(absPath), { recursive: true });
  const tmpPath = `${absPath}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(tmpPath, "w");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmpPath, absPath);
}

/**
 * Der eine Ort, an dem die Zonenregel für Schreibzugriffe hängt. Die Artefaktzone ist frei,
 * die Quellzone braucht eine Freigabe — und weil es die Policy-Engine (S11) noch nicht gibt,
 * heißt das heute schlicht: abgelehnt. Wenn S11 kommt, läuft ihre Prüfung *vor* diesem
 * Aufruf und kann eine erteilte Freigabe durchreichen; die Kaskade "Schreiben nur mit
 * Freigabe" bleibt trotzdem hier festgemacht.
 */
function assertWritableZone(resolved: ResolvedPath, inputPath: string): void {
  if (resolved.zone !== "artifact") {
    throw new SourceZoneWriteError(
      `Schreiben nach "${inputPath}" trifft die Quellzone. Die Quellzone ist ohne Freigabe nur lesbar; die Freigabe erteilt die Policy-Engine (S11). Die Artefaktzone (ARTIFACT_ROOT) ist frei beschreibbar.`,
    );
  }
}

function toInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

// ---------------------------------------------------------------------------
// fs.read
// ---------------------------------------------------------------------------

async function readHandler(deps: FsToolDeps, inv: ToolInvocation): Promise<ToolOutput> {
  const inputPath = inv.input.path as string;
  const resolved = await resolvePath(deps.zones, inputPath);
  if (!resolved.existed) throw new FsNotFoundError(`Datei nicht gefunden: ${inputPath}`);

  const info = await stat(resolved.path);
  if (!info.isFile()) throw new FsNotAFileError(`Kein reguläres File: ${inputPath}`);

  const bytes = await readFile(resolved.path);
  const sha256 = sha256Hex(bytes);
  const shown = displayPath(deps.zones, resolved.path);

  if (looksBinary(bytes)) {
    const meta = await offloadFull(deps, inv, resolved.path, bytes, {
      summary: `Binärdatei ${shown}: ${bytes.length} Bytes, vollständig im Artefakt`,
    });
    return {
      summary: `Binärdatei ${shown} (${bytes.length} Bytes) — Inhalt im Artefakt ${meta.uri}`,
      structured: {
        path: shown,
        zone: resolved.zone,
        binary: true,
        total_bytes: bytes.length,
        sha256,
        truncated: true,
        artifact_uri: meta.uri,
      },
      artifact_refs: [meta.uri],
      preview: [],
    };
  }

  const text = bytes.toString("utf8");
  const lines = splitLines(text);
  const totalLines = lines.length;

  const offset = Math.max(1, toInt(inv.input.offset) ?? 1);
  const limit = Math.max(1, toInt(inv.input.limit) ?? READ_INLINE_MAX_LINES);
  const start = offset - 1;
  const slice = lines.slice(start, start + limit);
  const sliceText = slice.join("\n");

  const coversWholeFile = start === 0 && start + limit >= totalLines;
  const withinBudget =
    slice.length <= READ_INLINE_MAX_LINES &&
    Buffer.byteLength(sliceText, "utf8") <= READ_INLINE_MAX_BYTES;

  if (coversWholeFile && withinBudget) {
    return {
      summary: `${shown}: ${totalLines} Zeilen, ${bytes.length} Bytes`,
      structured: {
        path: shown,
        zone: resolved.zone,
        sha256,
        total_lines: totalLines,
        total_bytes: bytes.length,
        offset: 1,
        line_count: totalLines,
        truncated: false,
        content: text,
      },
      preview: capLines(lines.slice(0, READ_EXCERPT_LINES)),
      artifact_refs: [],
    };
  }

  // Zu groß oder ein ausdrücklicher Ausschnitt einer größeren Datei: der Ausschnitt bleibt
  // im Kontext, die vollständige Datei geht ins Artefakt (Auftrag S08). Das Artefakt trägt
  // die Rohbytes, nicht die JSON-verpackten Zeilen — ein späteres `readArtifact` liefert die
  // Datei bytegleich zurück.
  const excerpt = capLines(slice.slice(0, READ_EXCERPT_LINES));
  const meta = await offloadFull(deps, inv, resolved.path, bytes, {
    summary: `${shown}: ${totalLines} Zeilen, ${bytes.length} Bytes, vollständig im Artefakt`,
  });
  return {
    summary: `${shown}: ${totalLines} Zeilen (${bytes.length} Bytes). Zeilen ${offset}–${offset + excerpt.length - 1} eingebettet, Rest im Artefakt ${meta.uri}.`,
    structured: {
      path: shown,
      zone: resolved.zone,
      sha256,
      total_lines: totalLines,
      total_bytes: bytes.length,
      offset,
      line_count: excerpt.length,
      truncated: true,
      excerpt: excerpt.join("\n"),
      artifact_uri: meta.uri,
    },
    preview: excerpt.slice(0, 10),
    artifact_refs: [meta.uri],
  };
}

async function offloadFull(
  deps: FsToolDeps,
  inv: ToolInvocation,
  absPath: string,
  bytes: Buffer,
  opts: { summary: string },
): Promise<{ uri: string }> {
  // Läuft innerhalb des Schritts, wie die Auslagerung im Router (S07): das Artefakt braucht
  // die `step_id` als Herkunft (S06) und gehört zum Ergebnis dieses Versuchs.
  const meta = await writeArtifact(deps.pool, deps.artifactRoot, {
    content: bytes,
    mimeType: guessMimeType(absPath),
    summary: opts.summary,
    source: { tool: "fs.read", sessionId: inv.sessionId, stepId: inv.stepId },
  });
  return { uri: meta.uri };
}

/** `split("\n")`, aber ein einzelnes abschließendes `\n` erzeugt keine leere Schlusszeile. */
function splitLines(text: string): string[] {
  const parts = text.split("\n");
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function capLines(lines: string[]): string[] {
  return lines.map((line) =>
    line.length > READ_EXCERPT_LINE_CAP ? `${line.slice(0, READ_EXCERPT_LINE_CAP)} …` : line,
  );
}

// ---------------------------------------------------------------------------
// fs.write
// ---------------------------------------------------------------------------

async function writeHandler(deps: FsToolDeps, inv: ToolInvocation): Promise<ToolOutput> {
  const inputPath = inv.input.path as string;
  const content = inv.input.content as string;

  const resolved = await resolvePath(deps.zones, inputPath);
  assertWritableZone(resolved, inputPath);

  if (inv.input.expect_absent === true && resolved.existed) {
    throw new Error(`Datei existiert bereits: ${inputPath} (expect_absent ist gesetzt)`);
  }

  const bytes = Buffer.from(content, "utf8");
  await atomicWrite(resolved.path, bytes);

  const shown = displayPath(deps.zones, resolved.path);
  return {
    summary: `${resolved.existed ? "überschrieben" : "geschrieben"}: ${shown} (${bytes.length} Bytes)`,
    structured: {
      path: shown,
      zone: resolved.zone,
      bytes: bytes.length,
      sha256: sha256Hex(bytes),
      created: !resolved.existed,
    },
    preview: capLines(splitLines(content).slice(0, 3)),
    artifact_refs: [],
  };
}

// ---------------------------------------------------------------------------
// fs.edit
// ---------------------------------------------------------------------------

async function editHandler(deps: FsToolDeps, inv: ToolInvocation): Promise<ToolOutput> {
  const inputPath = inv.input.path as string;
  const oldString = inv.input.old_string as string;
  const newString = inv.input.new_string as string;
  const expectedSha256 = inv.input.expected_sha256 as string;
  const replaceAll = inv.input.replace_all === true;

  const resolved = await resolvePath(deps.zones, inputPath);
  assertWritableZone(resolved, inputPath);
  if (!resolved.existed) throw new FsNotFoundError(`Datei nicht gefunden: ${inputPath}`);

  const info = await stat(resolved.path);
  if (!info.isFile()) throw new FsNotAFileError(`Kein reguläres File: ${inputPath}`);

  const before = await readFile(resolved.path);
  const shaBefore = sha256Hex(before);
  const shown = displayPath(deps.zones, resolved.path);

  // Der stale-read-Test von S08. Der erwartete SHA-256 stammt aus dem letzten `fs.read`;
  // weicht der aktuelle ab, hat jemand die Datei zwischenzeitlich geändert, und ein Edit auf
  // dem alten Stand überschriebe diese Änderung stillschweigend.
  if (shaBefore !== expectedSha256) {
    throw new StaleFileError(
      `Datei ${shown} wurde seit dem Lesen geändert: erwartet SHA-256 ${expectedSha256}, aktuell ${shaBefore}. Neu lesen und den Edit auf dem aktuellen Stand wiederholen.`,
    );
  }
  if (looksBinary(before)) {
    throw new FsNotAFileError(`Binärdatei, fs.edit arbeitet nur auf Text: ${inputPath}`);
  }

  const text = before.toString("utf8");
  const occurrences = countOccurrences(text, oldString);
  if (occurrences === 0) {
    throw new EditTargetNotFoundError(`old_string kommt in ${shown} nicht vor`);
  }
  if (occurrences > 1 && !replaceAll) {
    throw new EditTargetAmbiguousError(
      `old_string kommt ${occurrences}× in ${shown} vor; für einen eindeutigen Edit mehr Kontext mitgeben oder replace_all setzen`,
    );
  }

  const next = replaceAll
    ? text.split(oldString).join(newString)
    : text.replace(oldString, newString);
  const nextBytes = Buffer.from(next, "utf8");
  await atomicWrite(resolved.path, nextBytes);
  const shaAfter = sha256Hex(nextBytes);

  return {
    summary: `${shown}: ${replaceAll ? occurrences : 1} Ersetzung(en), ${nextBytes.length} Bytes`,
    structured: {
      path: shown,
      zone: resolved.zone,
      replacements: replaceAll ? occurrences : 1,
      sha256_before: shaBefore,
      sha256_after: shaAfter,
      bytes: nextBytes.length,
    },
    preview: [],
    artifact_refs: [],
  };
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

// ---------------------------------------------------------------------------
// fs.list
// ---------------------------------------------------------------------------

/** `type`, kein `interface`: nur ein Typalias bekommt die implizite Indexsignatur, mit der er als `JsonValue` durchgeht (siehe `tools/types.ts`). */
type ListEntry = {
  path: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number;
};

async function listHandler(deps: FsToolDeps, inv: ToolInvocation): Promise<ToolOutput> {
  const inputPath = typeof inv.input.path === "string" ? inv.input.path : ".";
  const recursive = inv.input.recursive === true;

  const resolved = await resolvePath(deps.zones, inputPath);
  if (!resolved.existed) throw new FsNotFoundError(`Verzeichnis nicht gefunden: ${inputPath}`);
  const info = await stat(resolved.path);
  if (!info.isDirectory()) throw new FsNotADirectoryError(`Kein Verzeichnis: ${inputPath}`);

  const entries: ListEntry[] = [];
  let truncated = false;

  const walk = async (absDir: string): Promise<void> => {
    if (entries.length >= LIST_MAX_ENTRIES) {
      truncated = true;
      return;
    }
    if (inv.signal.aborted) return;

    const dirents = await readdir(absDir, { withFileTypes: true });
    dirents.sort((a, b) => a.name.localeCompare(b.name));

    for (const dirent of dirents) {
      if (entries.length >= LIST_MAX_ENTRIES) {
        truncated = true;
        return;
      }
      const abs = path.join(absDir, dirent.name);
      let type: ListEntry["type"] = "other";
      let size = 0;

      if (dirent.isSymbolicLink()) {
        type = "symlink";
      } else if (dirent.isDirectory()) {
        type = "dir";
      } else if (dirent.isFile()) {
        type = "file";
        try {
          size = (await stat(abs)).size;
        } catch {
          size = 0;
        }
      }

      entries.push({ path: displayPath(deps.zones, abs), type, size });

      // Symlinks werden gemeldet, aber nie betreten: ein Symlink-Verzeichnis, in das
      // hineingelaufen würde, wäre ein Weg an der Zonenprüfung vorbei.
      if (recursive && type === "dir" && !PRUNE_DIRS.has(dirent.name)) {
        await walk(abs);
      }
    }
  };

  await walk(resolved.path);
  const shown = displayPath(deps.zones, resolved.path);

  return {
    summary: `${shown}: ${entries.length} Einträge${truncated ? " (abgeschnitten)" : ""}`,
    structured: { path: shown, zone: resolved.zone, recursive, truncated, entries },
    preview: entries.slice(0, 20).map((entry) => `${typeMark(entry.type)} ${entry.path}`),
    artifact_refs: [],
  };
}

function typeMark(type: ListEntry["type"]): string {
  if (type === "dir") return "d";
  if (type === "symlink") return "l";
  if (type === "file") return "-";
  return "?";
}

// ---------------------------------------------------------------------------
// fs.search
// ---------------------------------------------------------------------------

/** `type`, kein `interface` — dieselbe Indexsignatur-Frage wie bei `ListEntry`. */
type SearchMatch = {
  path: string;
  line: number;
  text: string;
};

async function searchHandler(deps: FsToolDeps, inv: ToolInvocation): Promise<ToolOutput> {
  const pattern = inv.input.query as string;
  if (pattern.length === 0) throw new FsSearchPatternError("query ist leer");
  if (pattern.length > SEARCH_PATTERN_MAX) {
    throw new FsSearchPatternError(`query ist zu lang (höchstens ${SEARCH_PATTERN_MAX} Zeichen)`);
  }

  const ignoreCase = inv.input.ignore_case === true;
  const maxResults = clampInt(inv.input.max_results, SEARCH_MAX_RESULTS, 1, SEARCH_MAX_RESULTS);
  const glob =
    typeof inv.input.glob === "string" && inv.input.glob.length > 0 ? inv.input.glob : undefined;
  const globRe = glob ? globToRegExp(glob) : undefined;

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, ignoreCase ? "i" : "");
  } catch (error) {
    throw new FsSearchPatternError(
      `ungültiger regulärer Ausdruck: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const inputPath = typeof inv.input.path === "string" ? inv.input.path : ".";
  const base = await resolvePath(deps.zones, inputPath);
  if (!base.existed) throw new FsNotFoundError(`Pfad nicht gefunden: ${inputPath}`);

  const matches: SearchMatch[] = [];
  let filesScanned = 0;
  let truncated = false;

  const searchFile = async (abs: string): Promise<void> => {
    if (matches.length >= maxResults || filesScanned >= SEARCH_MAX_FILES) {
      truncated = true;
      return;
    }
    let buf: Buffer;
    try {
      buf = await readFile(abs);
    } catch {
      return;
    }
    if (looksBinary(buf)) return;
    filesScanned += 1;

    const shown = displayPath(deps.zones, abs);
    const fileLines = buf.toString("utf8").split("\n");
    let perFile = 0;
    for (let i = 0; i < fileLines.length; i += 1) {
      if (matches.length >= maxResults) {
        truncated = true;
        return;
      }
      if (perFile >= SEARCH_MAX_PER_FILE) {
        truncated = true;
        return;
      }
      if (regex.test(fileLines[i])) {
        matches.push({ path: shown, line: i + 1, text: fileLines[i].slice(0, SEARCH_LINE_CAP) });
        perFile += 1;
      }
    }
  };

  const walk = async (absDir: string): Promise<void> => {
    if (inv.signal.aborted || matches.length >= maxResults) return;
    const dirents = await readdir(absDir, { withFileTypes: true });
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of dirents) {
      if (matches.length >= maxResults) {
        truncated = true;
        return;
      }
      if (dirent.isSymbolicLink()) continue; // Symlinks nie folgen
      const abs = path.join(absDir, dirent.name);
      if (dirent.isDirectory()) {
        if (!PRUNE_DIRS.has(dirent.name)) await walk(abs);
      } else if (dirent.isFile()) {
        if (globRe && !globRe.test(dirent.name)) continue;
        await searchFile(abs);
      }
    }
  };

  const info = await stat(base.path);
  if (info.isDirectory()) await walk(base.path);
  else if (info.isFile()) await searchFile(base.path);
  else throw new FsNotAFileError(`Weder Datei noch Verzeichnis: ${inputPath}`);

  const shown = displayPath(deps.zones, base.path);
  return {
    summary: `${matches.length} Treffer in ${filesScanned} Dateien für /${pattern}/${ignoreCase ? "i" : ""}${truncated ? " (abgeschnitten)" : ""}`,
    structured: {
      query: pattern,
      ignore_case: ignoreCase,
      path: shown,
      files_scanned: filesScanned,
      truncated,
      matches,
    },
    preview: matches
      .slice(0, 10)
      .map((match) => `${match.path}:${match.line}: ${match.text.trim().slice(0, 120)}`),
    artifact_refs: [],
  };
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

/** Nur Dateinamen, kein `/`. `*` → beliebig, `?` → ein Zeichen, alles andere wörtlich. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

// ---------------------------------------------------------------------------
// Definitionen
// ---------------------------------------------------------------------------

/**
 * Baut die fünf `fs.*`-Definitionen mit ihren Abhängigkeiten (Pool, Artefaktwurzel, Zonen)
 * in den Handlern geschlossen. `runtime/index.ts` registriert sie im Katalog, Tests bauen
 * sich einen eigenen mit einer Wegwerf-Wurzel.
 */
export function createFsTools(deps: FsToolDeps): ToolDefinition[] {
  return [
    {
      name: "fs.list",
      description:
        "Listet ein Verzeichnis relativ zur Workspace-Wurzel. Symlinks werden gemeldet, aber nicht verfolgt. Mit recursive absteigend, .git und node_modules ausgenommen.",
      risk: "read",
      repeatable: true,
      inputSchema: {
        fields: {
          path: {
            type: "string",
            required: false,
            description: "Verzeichnis relativ zur Workspace-Wurzel. Vorgabe: die Wurzel selbst.",
          },
          recursive: {
            type: "boolean",
            required: false,
            description: "Rekursiv absteigen. Vorgabe: nein.",
          },
        },
      },
      handler: (inv) => listHandler(deps, inv),
    },
    {
      name: "fs.read",
      description:
        "Liest eine Textdatei relativ zur Workspace-Wurzel. Kleine Dateien kommen ganz zurück; große Dateien als Ausschnitt plus Artefakt-Handle auf den vollständigen Inhalt. Gibt den SHA-256 der Datei zurück, den fs.edit als expected_sha256 braucht.",
      risk: "read",
      repeatable: true,
      inputSchema: {
        fields: {
          path: {
            type: "string",
            required: true,
            description: "Datei relativ zur Workspace-Wurzel.",
          },
          offset: {
            type: "number",
            required: false,
            description: "Erste Zeile (1-basiert), die zurückkommt. Vorgabe: 1.",
          },
          limit: {
            type: "number",
            required: false,
            description: "Anzahl Zeilen ab offset. Vorgabe: bis zum Inline-Budget.",
          },
        },
      },
      handler: (inv) => readHandler(deps, inv),
    },
    {
      name: "fs.write",
      description:
        "Schreibt eine Datei (atomar, überschreibt standardmäßig). Nur in der Artefaktzone (ARTIFACT_ROOT) erlaubt; ein Ziel in der Quellzone wird ohne Freigabe abgewiesen.",
      risk: "soft_write",
      // Ein unterbrochener Schreibvorgang mit denselben Bytes ist der klassische
      // gefahrlos wiederholbare Fall: der atomare Rename hinterlässt keinen Zwischenzustand.
      repeatable: true,
      inputSchema: {
        fields: {
          path: {
            type: "string",
            required: true,
            description: "Zieldatei relativ zur Workspace-Wurzel. Muss in der Artefaktzone liegen.",
          },
          content: { type: "string", required: true, description: "Vollständiger neuer Inhalt." },
          expect_absent: {
            type: "boolean",
            required: false,
            description: "Fehlschlagen, wenn die Datei schon existiert. Vorgabe: nein.",
          },
        },
      },
      handler: (inv) => writeHandler(deps, inv),
    },
    {
      name: "fs.edit",
      description:
        "Ersetzt old_string durch new_string in einer Textdatei. Verlangt expected_sha256 aus dem letzten fs.read und bricht ab, wenn die Datei sich seither geändert hat. Nur in der Artefaktzone erlaubt.",
      risk: "soft_write",
      // Bewusst nicht wiederholbar: nach einem Abbruch ist unklar, ob der Edit schon
      // angewandt wurde, und ein zweiter Lauf träfe auf einen geänderten SHA-256 oder ein
      // fehlendes old_string. Diese Lage entscheidet die Wiederaufnahme (S05), nicht die Hülle.
      repeatable: false,
      inputSchema: {
        fields: {
          path: {
            type: "string",
            required: true,
            description: "Datei relativ zur Workspace-Wurzel.",
          },
          old_string: {
            type: "string",
            required: true,
            description:
              "Exakter Text, der ersetzt wird. Muss eindeutig sein oder replace_all setzen.",
          },
          new_string: { type: "string", required: true, description: "Ersatztext." },
          expected_sha256: {
            type: "string",
            required: true,
            description:
              "SHA-256 der Datei aus dem letzten fs.read. Weicht er ab, wird der Edit abgewiesen.",
          },
          replace_all: {
            type: "boolean",
            required: false,
            description: "Alle Vorkommen ersetzen statt genau eines. Vorgabe: nein.",
          },
        },
      },
      handler: (inv) => editHandler(deps, inv),
    },
    {
      name: "fs.search",
      description:
        "Sucht mit einem regulären Ausdruck (JavaScript-Syntax) in Dateien unter path. Liefert Treffer als Pfad, Zeilennummer und die Trefferzeile — nie ganze Dateien. .git und node_modules und Symlinks werden ausgelassen.",
      risk: "read",
      repeatable: true,
      inputSchema: {
        fields: {
          query: {
            type: "string",
            required: true,
            description: "Regulärer Ausdruck (JavaScript-Syntax).",
          },
          path: {
            type: "string",
            required: false,
            description:
              "Datei oder Verzeichnis, unter dem gesucht wird. Vorgabe: Workspace-Wurzel.",
          },
          glob: {
            type: "string",
            required: false,
            description: "Dateinamensfilter, z. B. *.ts. Nur der Name, kein Pfad.",
          },
          ignore_case: {
            type: "boolean",
            required: false,
            description: "Groß-/Kleinschreibung ignorieren. Vorgabe: nein.",
          },
          max_results: {
            type: "number",
            required: false,
            description: `Höchstzahl Treffer (bis ${SEARCH_MAX_RESULTS}).`,
          },
        },
      },
      handler: (inv) => searchHandler(deps, inv),
    },
  ];
}
