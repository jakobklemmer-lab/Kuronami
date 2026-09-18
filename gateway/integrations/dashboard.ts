import type { Pool } from "pg";
import type { IndexedNote } from "../../tools/memory/index-db.js";
import type { N8nBridge } from "../../tools/n8n/bridge.js";

/**
 * Die Datenquellen der Startseite und der Detailansichten, die nicht Markt oder Mail sind
 * (Nachtrag 2026-09-16, Ablösung der übrigen `ui/mock/data.ts`-Provider): Kalender über die
 * n8n-Brücke, Notizen aus dem Langzeitgedächtnis, Dateien und Recherche aus der Artefaktablage.
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

/** Heute, lokal: Mitternacht bis Mitternacht. */
export function todayRange(now = new Date()): { start: string; end: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Die Form aus `cal-list.json` (`{ events: [{ id, title, start, end, all_day, location, account }] }`). */
export function mapCalendarEvents(body: unknown): AgendaEvent[] {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const raw = Array.isArray(record.events) ? record.events : [];
  const events: AgendaEvent[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const startsAt = str(e.start);
    if (startsAt === "") continue;
    events.push({
      id: str(e.id),
      title: str(e.title) || "(kein Titel)",
      startsAt,
      endsAt: str(e.end),
      location: str(e.location) || null,
      allDay: e.all_day === true,
      account: str(e.account),
    });
  }
  events.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return events;
}

export async function loadCalendar(
  bridge: N8nBridge | undefined,
  signal: AbortSignal,
  now = new Date(),
): Promise<CalendarData> {
  if (!bridge || !bridge.configured) {
    return { connected: false, reason: "n8n ist nicht eingerichtet.", events: [] };
  }
  const { start, end } = todayRange(now);
  try {
    const invocation = await bridge.invoke({
      webhookPath: "cal-list",
      input: { start, end, limit: 50 },
      repeatable: true,
      signal,
    });
    return { connected: true, reason: null, events: mapCalendarEvents(invocation.body) };
  } catch (error) {
    // Der Workflow ist inaktiv (kein Kalender-Konto verbunden) oder n8n antwortet nicht — für
    // die Oberfläche derselbe Zustand: kein Kalender, mit Grund. Kein 500, weil das kein
    // Fehler des Gateways ist, sondern ein noch nicht angeschlossener Dienst.
    const message = error instanceof Error ? error.message : String(error);
    return {
      connected: false,
      // n8n antwortet auf einen inaktiven Workflow mit 404 „not registered" — für den Nutzer
      // heißt das schlicht: noch kein Kalender-Konto hinterlegt.
      reason: /not registered|HTTP 404/.test(message)
        ? "Der Kalender-Workflow in n8n ist noch nicht aktiv (kein Konto verbunden)."
        : message,
      events: [],
    };
  }
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
