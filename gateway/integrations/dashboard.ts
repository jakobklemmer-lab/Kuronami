import type { Pool } from "pg";
import type { IndexedNote } from "../../tools/memory/index-db.js";

/**
 * Die Datenquellen der Startseite und der Detailansichten, die nicht Markt oder Mail sind
 * (Nachtrag 2026-09-16, Ablösung der übrigen `ui/mock/data.ts`-Provider): Kalender, Notizen aus
 * dem Langzeitgedächtnis, Dateien und Recherche aus der Artefaktablage.
 * Reine Abbildungen plus dünne Abfragen — die Formen entsprechen denen, die die Oberfläche
 * bisher von den Mock-Providern bekam, damit die Ansichten sich nur in der Quelle unterscheiden.
 */

export interface AgendaEvent {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  location: string | null;
  allDay: boolean;
  account: string;
}

export interface CalendarData {
  /** `false`, wenn der Kalender-Workflow (noch) nicht erreichbar ist — kein Konto verbunden. */
  connected: boolean;
  reason: string | null;
  events: AgendaEvent[];
}

/** Noch ohne Quelle: n8n ist ausgebaut (02.10.), der Apple-Kalender kommt über CalDAV. */
export function loadCalendar(): CalendarData {
  return { connected: false, reason: "Noch kein Kalender verbunden.", events: [] };
}

// ---------------------------------------------------------------------------
// Mail
// ---------------------------------------------------------------------------

/** `"Beispiel Kaffee" <info@example.com>` → `Beispiel Kaffee`; eine nackte Adresse bleibt, wie
 * sie ist. Die Inbox-Karte hat Platz für einen Namen, nicht für die ganze Kopfzeile. */
export function displayNameOf(from: string): string {
  const match = /^\s*"?([^"<]*?)"?\s*<[^>]*>\s*$/.exec(from);
  if (match) {
    const name = match[1].trim();
    if (name.length > 0) return name;
    const address = /<([^>]*)>/.exec(from)?.[1];
    return address ?? from;
  }
  return from.trim();
}

// ---------------------------------------------------------------------------
// Notizen
// ---------------------------------------------------------------------------

export interface NoteSummary {
  id: string;
  title: string;
  kind: string;
  tags: string[];
  updatedAt: string;
  excerpt: string;
}

const EXCERPT_MAX = 180;

export function toNoteSummary(note: IndexedNote): NoteSummary {
  const body = note.body.replace(/\s+/g, " ").trim();
  return {
    id: note.id,
    title: note.title,
    kind: note.kind,
    tags: note.tags,
    // `date` ist nur ein Tag; der Dateizustand trägt die genaue Zeit der letzten Änderung.
    updatedAt: new Date(note.mtimeMs).toISOString(),
    excerpt: body.length > EXCERPT_MAX ? `${body.slice(0, EXCERPT_MAX)} …` : body,
  };
}

/** Neueste zuerst. */
export function summarizeNotes(notes: readonly IndexedNote[], limit = 50): NoteSummary[] {
  return [...notes]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map(toNoteSummary);
}

// ---------------------------------------------------------------------------
// Artefakte: Dateien und Recherche
// ---------------------------------------------------------------------------

export interface FileEntry {
  id: string;
  name: string;
  path: string;
  kind: "artifact" | "note";
  mimeType: string | null;
  sizeBytes: number | null;
  modifiedAt: string;
}

export interface ResearchFinding {
  id: string;
  /** Das Werkzeug, das den Befund hinterlassen hat — `web.search`, `web.fetch`. */
  tool: string;
  summary: string;
  artifactUri: string;
  savedAt: string;
}

interface ArtifactRow {
  artifact_id: string;
  uri: string;
  mime_type: string;
  summary: string;
  source: { tool?: unknown } | null;
  created_at: Date;
  size_bytes: string | number;
}

const ARTIFACT_COLUMNS = "artifact_id, uri, mime_type, summary, source, created_at, size_bytes";

export async function listArtifactFiles(pool: Pool, limit = 50): Promise<FileEntry[]> {
  const result = await pool.query<ArtifactRow>(
    `SELECT ${ARTIFACT_COLUMNS} FROM kuronami.artifacts ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return result.rows.map((row) => ({
    id: row.artifact_id,
    name: row.summary,
    path: row.uri,
    kind: "artifact",
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    modifiedAt: row.created_at.toISOString(),
  }));
}

export function notesAsFiles(notes: readonly NoteSummary[]): FileEntry[] {
  return notes.map((note) => ({
    id: `note:${note.id}`,
    name: note.title,
    path: `memory/notes/${note.id}.md`,
    kind: "note",
    mimeType: "text/markdown",
    sizeBytes: null,
    modifiedAt: note.updatedAt,
  }));
}

/** Alles, was `web.*` hinterlassen hat — Suchtreffer und geholte Seiten. */
export async function listResearch(pool: Pool, limit = 50): Promise<ResearchFinding[]> {
  const result = await pool.query<ArtifactRow>(
    `SELECT ${ARTIFACT_COLUMNS} FROM kuronami.artifacts
     WHERE source->>'tool' LIKE 'web.%'
     ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return result.rows.map((row) => ({
    id: row.artifact_id,
    tool: typeof row.source?.tool === "string" ? row.source.tool : "web",
    summary: row.summary,
    artifactUri: row.uri,
    savedAt: row.created_at.toISOString(),
  }));
}
