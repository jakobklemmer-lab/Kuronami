/**
 * Was ein Artefakt ist, unabhängig davon, wer es schreibt und wer es später auflöst.
 * Ein Artefakt ist eine ausgelagerte Tool-Ausgabe: die Bytes leben außerhalb des
 * Modellkontexts, in den Kontext geht nur `summary` plus das Handle (Abschnitt 4.5,
 * Grundprinzip 3).
 */

/** Präfix jeder Handle-URI. Siehe die Abweichungsnotiz zu Abschnitt 4.5 in `store.ts`. */
export const ARTIFACT_URI_SCHEME = "artifact://";

/**
 * Herkunft eines Artefakts (Abschnitt 5, Feld `source`). Der Auftrag verlangt, dass Tool,
 * Session und Schritt "immer" mitgespeichert werden — deshalb sind alle drei Pflichtfelder
 * des Typs. `stepId` darf `null` sein: das ist der Fall eines Artefakts, das jedem Schritt
 * vorausgeht. Der Loop (S12) ruft `writeArtifact` aus einem Schritt-Effekt und hat den
 * Schlüssel immer; heute gibt es keinen `null`-Fall, der Typ lässt ihn nur zu.
 */
export interface ArtifactSource {
  /** Das Tool, dessen Ausführung die Bytes erzeugt hat, z. B. "web.fetch". */
  tool: string;
  /** Die Session, zu der das Artefakt gehört. Zugleich der erste Pfadteil der Ablage. */
  sessionId: string;
  /** Der Schritt, in dessen Seiteneffekt das Artefakt entstand, oder `null`. */
  stepId: string | null;
}

/**
 * Die Metadatenzeile aus `kuronami.artifacts`, ohne die Bytes. Das ist alles, was `head()`
 * zurückgibt, und alles, was der Kontext-Aufbau (S07 aufwärts) braucht, um zu entscheiden,
 * ob ein Artefakt überhaupt geladen werden muss.
 */
export interface ArtifactMeta {
  artifactId: string;
  uri: string;
  mimeType: string;
  summary: string;
  /** Hex, 64 Zeichen. Beim Schreiben über die rohen Bytes gebildet. */
  sha256: string;
  /** Bytelänge des Inhalts. Kommt aus der Zeile, nie aus einem stat() der Datei. */
  sizeBytes: number;
  source: ArtifactSource;
  createdAt: Date;
}

/** Die Metadaten plus die rohen Bytes. Nur `readArtifact` liefert das, `headArtifact` nie. */
export interface ArtifactContent extends ArtifactMeta {
  bytes: Buffer;
}

/** Eingabe für `writeArtifact` — die vier Argumente aus `artifact.write(...)` des Auftrags. */
export interface WriteArtifactInput {
  /** Roher Inhalt. Eine Zeichenkette wird als UTF-8 kodiert, bevor die Prüfsumme läuft. */
  content: string | Uint8Array;
  mimeType: string;
  /** Pflichtfeld (Auftrag S06). Leer oder nur Whitespace wird am Schreibtor abgewiesen. */
  summary: string;
  source: ArtifactSource;
}

/** Eine Zeile aus `kuronami.artifacts`, so wie `pg` sie zurückgibt. */
export interface ArtifactRow {
  artifact_id: string;
  uri: string;
  mime_type: string;
  summary: string;
  sha256: string;
  /** `pg` gibt `bigint` als Zeichenkette zurück; `toArtifactMeta` setzt sie in `number` um. */
  size_bytes: string;
  source: { tool: string; session_id: string; step_id: string | null };
  created_at: Date;
}

export const ARTIFACT_COLUMNS = `
  artifact_id, uri, mime_type, summary, sha256, size_bytes, source, created_at
`;

export function toArtifactMeta(row: ArtifactRow): ArtifactMeta {
  return {
    artifactId: row.artifact_id,
    uri: row.uri,
    mimeType: row.mime_type,
    summary: row.summary,
    sha256: row.sha256,
    // Die eine Stelle, an der das bigint-als-string aus pg zu einer Zahl wird. Eine
    // Artefaktgröße, die Number.MAX_SAFE_INTEGER (~9 PB) überschreitet, gibt es nicht.
    sizeBytes: Number(row.size_bytes),
    source: {
      tool: row.source.tool,
      sessionId: row.source.session_id,
      stepId: row.source.step_id ?? null,
    },
    createdAt: row.created_at,
  };
}
