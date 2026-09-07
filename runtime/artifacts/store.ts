import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { appendEventInTx } from "../events/log.js";
import { redactText } from "../redaction/redact.js";
import {
  ARTIFACT_COLUMNS,
  ARTIFACT_URI_SCHEME,
  type ArtifactContent,
  type ArtifactMeta,
  type ArtifactRow,
  type ArtifactSource,
  type WriteArtifactInput,
  toArtifactMeta,
} from "./types.js";

/** Die übergebene URI hat nicht die Form artifact://<session_id>/<artifact_id>. */
export class ArtifactUriError extends Error {}
/** Zur URI gibt es keine Metadatenzeile. Der Speicher hat dieses Handle nie vergeben. */
export class ArtifactNotFoundError extends Error {}
/** Die Zeile steht, aber die Datei am aufgelösten Pfad fehlt. */
export class ArtifactFileMissingError extends Error {}
/** Die Datei auf der Platte deckt sich nicht mehr mit dem, was beim Schreiben festgehalten wurde. */
export class ArtifactIntegrityError extends Error {}
/** Eine Eingabe an `writeArtifact` verletzt eine Pflicht (summary, mime_type, Herkunft). */
export class ArtifactInputError extends Error {}

/**
 * Wurzel der physischen Ablage. Fabrik wie `createPool`, kein Modul-Singleton: der Aufrufer
 * behält die Kontrolle, Tests zeigen sie auf ein Wegwerf-Verzeichnis. Legt nichts an — das
 * tut `writeArtifact` bei Bedarf.
 */
export function artifactRootFromEnv(root = process.env.ARTIFACT_ROOT): string {
  if (!root) {
    throw new Error("ARTIFACT_ROOT ist nicht gesetzt");
  }
  return path.resolve(root);
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Zerlegt eine Handle-URI in ihre zwei Pfadteile und prüft dabei die Form. Kein
 * Bestandteil, der hier durchkommt, kann in einem `path.join` den Speicher verlassen: eine
 * von uns vergebene Kennung ist `<präfix>_<uuid>`, und der Zeichensatz unten lässt weder
 * `.` noch einen Trenner zu. Die maßgebliche Auflösung geschieht ohnehin über die Felder
 * der Zeile (siehe `readArtifact`), das hier ist die Prüfung an der Grenze.
 */
export function parseArtifactUri(uri: string): { sessionId: string; artifactId: string } {
  if (typeof uri !== "string" || !uri.startsWith(ARTIFACT_URI_SCHEME)) {
    throw new ArtifactUriError(`"${uri}" ist keine ${ARTIFACT_URI_SCHEME}-URI`);
  }
  const parts = uri.slice(ARTIFACT_URI_SCHEME.length).split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new ArtifactUriError(
      `"${uri}" hat nicht die Form ${ARTIFACT_URI_SCHEME}<session_id>/<artifact_id>`,
    );
  }
  const [sessionId, artifactId] = parts;
  const allowed = /^[A-Za-z0-9_-]+$/;
  if (!allowed.test(sessionId) || !allowed.test(artifactId)) {
    throw new ArtifactUriError(
      `"${uri}" enthält Zeichen, die in keiner vergebenen Kennung vorkommen`,
    );
  }
  return { sessionId, artifactId };
}

/** <root>/<session_id>/<artifact_id>. Die URI bildet 1:1 hierauf ab (auflösbar zu Dateipfad). */
function artifactFilePath(root: string, sessionId: string, artifactId: string): string {
  return path.join(root, sessionId, artifactId);
}

const INSERT_ARTIFACT_SQL = `
  INSERT INTO kuronami.artifacts
    (artifact_id, uri, mime_type, summary, sha256, size_bytes, source)
  VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
  RETURNING ${ARTIFACT_COLUMNS}
`;

const SELECT_ARTIFACT_BY_URI_SQL = `
  SELECT ${ARTIFACT_COLUMNS} FROM kuronami.artifacts WHERE uri = $1
`;

/** Die geprüften und gefilterten Metadaten, wie sie in Zeile und Ereignis gehen. */
interface CheckedInput {
  mimeType: string;
  summary: string;
  source: ArtifactSource;
}

/**
 * Prüfung und Redaction an einem Ort, in dieser Reihenfolge: erst gilt die Pflicht, dann
 * läuft der Filter. Umgekehrt käme eine Zusammenfassung durch, die nur aus einem Geheimnis
 * bestand und nach dem Filter zufällig nicht mehr leer ist.
 *
 * Gefiltert wird alles, was die Zeile und das Ereignis `artifact.created` tragen — seit S06
 * gehen `summary` und `source` ungefiltert ins Protokoll, und `summary` ist obendrein genau
 * das Feld, das statt der Bytes in den Modellkontext wandert (Abschnitt 4.5). Ein Geheimnis
 * darin stünde also an beiden verbotenen Orten zugleich.
 *
 * Die **Bytes** laufen bewusst nicht durch den Filter. Ein Artefakt ist die byteweise
 * archivierte Wahrheit eines Tool-Laufs — der S06-Test schreibt einen Binärpuffer mit
 * Nullbytes und liest ihn bytegleich zurück; ein Textmuster über beliebige Bytes zu legen,
 * beschädigte genau diese Zusage und obendrein die SHA-256-Kette. Der Schutz greift an der
 * anderen Stelle: aus dem Speicher heraus führt in den Kontext kein Weg an `summary` und
 * dem Handle vorbei, und wer die Bytes doch in ein Tool-Ergebnis hebt, schreibt sie über
 * `appendEventInTx` und den Prompt-Aufbau — beide filtern.
 */
function assertWriteInput(input: WriteArtifactInput): CheckedInput {
  if (typeof input.summary !== "string" || input.summary.trim() === "") {
    throw new ArtifactInputError(
      "summary ist Pflichtfeld und darf nicht leer sein: sie geht statt der Bytes in den Modellkontext",
    );
  }
  if (typeof input.mimeType !== "string" || input.mimeType.trim() === "") {
    throw new ArtifactInputError("mime_type fehlt");
  }
  const source = input.source;
  if (!source || typeof source.tool !== "string" || source.tool.trim() === "") {
    throw new ArtifactInputError(
      "source.tool fehlt: die Herkunft (Tool) wird immer mitgespeichert (Auftrag S06)",
    );
  }
  if (typeof source.sessionId !== "string" || source.sessionId === "") {
    throw new ArtifactInputError("source.sessionId fehlt");
  }
  const stepId = source.stepId ?? null;
  if (stepId !== null && typeof stepId !== "string") {
    throw new ArtifactInputError("source.stepId muss eine Zeichenkette oder null sein");
  }

  // `session_id` ist der einzige dieser Werte, der zusätzlich den physischen Ort adressiert:
  // die Datei liegt unter <root>/<session_id>/<artifact_id>, und `readArtifact` löst den Pfad
  // später aus genau diesem Feld der Zeile auf. Veränderte ihn der Filter, zeigte die Zeile
  // woandershin als die Datei. Eine von uns vergebene Kennung (`sess_<uuid>`) kann kein
  // Muster treffen — und wenn doch, ist das ein Fehler und keine Stelle zum Weitermachen.
  if (redactText(source.sessionId) !== source.sessionId) {
    throw new ArtifactInputError(
      `source.sessionId "${source.sessionId}" wird vom Redaction-Filter verändert und taugt damit nicht als Speicheradresse`,
    );
  }

  return {
    mimeType: redactText(input.mimeType),
    summary: redactText(input.summary),
    source: {
      tool: redactText(source.tool),
      sessionId: source.sessionId,
      stepId: stepId === null ? null : redactText(stepId),
    },
  };
}

async function assertSessionExists(pool: Pool, sessionId: string): Promise<void> {
  const found = await pool.query("SELECT 1 FROM kuronami.sessions WHERE session_id = $1", [
    sessionId,
  ]);
  if (found.rowCount === 0) {
    throw new Error(`Session ${sessionId} existiert nicht, Artefakt wurde nicht geschrieben`);
  }
}

/**
 * Schreibt ein Artefakt: Bytes auf die Platte, Metadatenzeile in `kuronami.artifacts`,
 * Ereignis `artifact.created`. Gibt das Handle (die URI) samt Metadaten zurück.
 *
 * Reihenfolge und ihr Grund: erst die Datei, dann die Transaktion aus Zeile und Ereignis.
 * Bricht der Prozess dazwischen ab, bleibt eine Datei ohne Zeile liegen — sie ist folgenlos,
 * kein Handle zeigt auf sie, ein späterer GC-Lauf kann sie abräumen. Die Umkehrung, eine
 * Zeile ohne Datei, wäre ein Handle, das ins Leere auflöst, und das darf es nicht geben.
 *
 * Die Datei entsteht als `.tmp` und wird erst nach `fsync` an ihren endgültigen Pfad
 * umbenannt: am gültigen Pfad liegt damit nie eine halb geschriebene Datei, auch nicht nach
 * einem Absturz mitten im Schreiben.
 *
 * Zeile und Ereignis in einer Transaktion ist der Checkpoint aus Abschnitt 6. Ein
 * Idempotenzschlüssel wie bei den Schritten (S05) ist hier keiner nötig: jeder Aufruf
 * bekommt eine frische `artifact_id`, und die Spalte `uri` ist UNIQUE — zweimal denselben
 * Inhalt zu schreiben ergibt zwei unabhängige, unveränderliche Artefakte.
 */
export async function writeArtifact(
  pool: Pool,
  root: string,
  input: WriteArtifactInput,
): Promise<ArtifactMeta> {
  const { mimeType, summary, source } = assertWriteInput(input);
  const bytes =
    typeof input.content === "string"
      ? Buffer.from(input.content, "utf8")
      : Buffer.from(input.content);

  const artifactId = `artifact_${randomUUID()}`;
  const uri = `${ARTIFACT_URI_SCHEME}${source.sessionId}/${artifactId}`;
  const sha256 = sha256Hex(bytes);
  const sourceJson = JSON.stringify({
    tool: source.tool,
    session_id: source.sessionId,
    step_id: source.stepId,
  });

  // Vor dem ersten Dateizugriff: existiert die Session überhaupt? `appendEventInTx` würde
  // später ohnehin daran scheitern, aber dann läge schon ein verwaistes Verzeichnis da.
  await assertSessionExists(pool, source.sessionId);

  const finalPath = artifactFilePath(root, source.sessionId, artifactId);
  const tmpPath = `${finalPath}.tmp`;
  await mkdir(path.dirname(finalPath), { recursive: true });

  const handle = await open(tmpPath, "w");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmpPath, finalPath);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const inserted = await client.query<ArtifactRow>(INSERT_ARTIFACT_SQL, [
      artifactId,
      uri,
      mimeType,
      summary,
      sha256,
      bytes.length,
      sourceJson,
    ]);
    const meta = toArtifactMeta(inserted.rows[0]);

    await appendEventInTx(client, source.sessionId, "artifact.created", {
      artifact_id: meta.artifactId,
      uri: meta.uri,
      mime_type: meta.mimeType,
      summary: meta.summary,
      sha256: meta.sha256,
      size_bytes: meta.sizeBytes,
      source: { tool: source.tool, session_id: source.sessionId, step_id: source.stepId },
    });

    await client.query("COMMIT");
    return meta;
  } catch (error) {
    await client.query("ROLLBACK");
    // Die Datei ist jetzt verwaist. Best effort wegräumen; klappt es nicht, ist es toter
    // Speicher, kein falscher Zustand — maßgeblich ist die fehlende Zeile.
    await rm(finalPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Metadaten zu einem Handle, ohne die Datei anzufassen.
 *
 * Die Signatur ist der Beweis: `headArtifact` bekommt `pool` und die URI und sonst nichts,
 * insbesondere kein `root`. Dass es die Datei nie öffnet, ist damit eine Eigenschaft der
 * Signatur, kein Versprechen der Sorgfalt — dasselbe Muster wie `deriveSessionState` in
 * `session/state.ts`. Genau das macht `head()` auch bei einem 5-MB-Artefakt billig: es ist
 * eine Zeilenabfrage, kein Dateizugriff.
 */
export async function headArtifact(pool: Pool, uri: string): Promise<ArtifactMeta> {
  parseArtifactUri(uri);
  const found = await pool.query<ArtifactRow>(SELECT_ARTIFACT_BY_URI_SQL, [uri]);
  if (found.rowCount === 0) {
    throw new ArtifactNotFoundError(`Kein Artefakt zu ${uri}`);
  }
  return toArtifactMeta(found.rows[0]);
}

/**
 * Metadaten plus Bytes. Liest die Zeile über `headArtifact`, löst den Pfad aus deren
 * Feldern auf (nicht aus der übergebenen URI: die Zeile existiert nur für Handles, die
 * dieser Speicher selbst vergeben hat) und prüft die Datei gegen das, was beim Schreiben
 * festgehalten wurde.
 *
 * Die erneute SHA-256-Prüfung ist bewusst der Normalfall und nicht abschaltbar: ein
 * Artefakt ist die ausgelagerte Wahrheit eines Tool-Laufs, und eine stumme Abweichung
 * zwischen Prüfsumme und Datei wäre genau das Verstecken eines Fehlers, das AGENTS.md
 * untersagt. Sollte sich das bei großen Artefakten (S09) als zu teuer zeigen, ist das eine
 * spätere, ausdrücklich zu begründende Ausnahme.
 */
export async function readArtifact(
  pool: Pool,
  root: string,
  uri: string,
): Promise<ArtifactContent> {
  const meta = await headArtifact(pool, uri);
  const filePath = artifactFilePath(root, meta.source.sessionId, meta.artifactId);

  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch (cause) {
    throw new ArtifactFileMissingError(
      `Artefakt ${uri}: die Metadatenzeile steht, aber die Datei unter ${filePath} fehlt`,
      { cause },
    );
  }

  if (bytes.length !== meta.sizeBytes) {
    throw new ArtifactIntegrityError(
      `Artefakt ${uri}: Datei ist ${bytes.length} Bytes groß, beim Schreiben waren es ${meta.sizeBytes}`,
    );
  }
  const actual = sha256Hex(bytes);
  if (actual !== meta.sha256) {
    throw new ArtifactIntegrityError(
      `Artefakt ${uri}: SHA-256 der Datei (${actual}) weicht von der Prüfsumme beim Schreiben (${meta.sha256}) ab`,
    );
  }

  return { ...meta, bytes };
}
