import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import type { PolicyGrant } from "../../policy/engine.js";
import { writeArtifact } from "../../runtime/artifacts/store.js";
import type { ToolDefinition, ToolInvocation, ToolOutput } from "../types.js";
import { type VaultRoot, resolveNotePath } from "./paths.js";

/**
 * `notes.read` und `notes.write` (S15, Abschnitt 9) — direkter Dateizugriff auf den lokalen
 * Obsidian-Vault, **ohne n8n**. Der Vault-Pfad kommt aus `OBSIDIAN_VAULT_PATH`
 * (`runtime/loop/api.ts` baut daraus die `VaultRoot`, `tools/notes/paths.ts` sichert jeden
 * Pfad ab).
 *
 * Beide Tools laufen durch denselben Router wie `fs.*` und damit durch die Ausführungshülle
 * (S05), die Policy-Engine (S11) und die einheitliche Rückgabehülle. Diese Datei baut nur
 * Definitionen und Handler.
 *
 * Zwei tragende Entscheidungen:
 *
 *   1. **`notes.read` legt den Volltext immer als Artefakt ab** und lässt nur einen
 *      begrenzten Ausschnitt plus Metadaten im Kontext — der Auftrag von S15 ("Lesende
 *      Tools: Zusammenfassung im Kontext, Volltext als Artefakt"), dasselbe Muster wie
 *      `mail.read` und `web.fetch`. Auch eine kurze Notiz bekommt ihr Artefakt; die Regel
 *      hängt nicht an der Größe.
 *
 *   2. **`notes.write` ist `hard_write` und pausiert immer für eine Freigabe.** Abschnitt 10
 *      führt "Notizen schreiben" unter "Weiches Schreiben" — der Session-Auftrag hebt das
 *      ausdrücklich auf `hard_write` an, und das ist auch die strengere, richtige Lesart:
 *      ein direkter Schreibzugriff in den **echten** Vault des Nutzers ist nichts, was
 *      "automatisch im Arbeitsverzeichnis" erlaubt (der Vault liegt außerhalb jeder
 *      `fs`-Zone). Weil das Eingabefeld `note` heißt und nicht `path` (siehe `paths.ts`),
 *      ordnet die Policy-Engine den Aufruf als Ressource `none` ein, der Boden `hard_write`
 *      greift, und keine Sessionmodus-Ausnahme senkt ihn — auch `accept_edits` nicht, das
 *      nur Pfad-Aufrufe vorab entscheidet.
 *
 * Anders als bei `mail.*` und `web.*` ist der Notiz-Inhalt **vertrauenswürdig**: es ist das
 * eigene Langzeitgedächtnis des Nutzers (Abschnitt 8), kein abgerufener Fremdinhalt. Kein
 * `trust: "untrusted"`, keine Injection-Markierung. Sollte ein Vault später fremde Inhalte
 * aufnehmen (geteilte Notizen, importierte Web-Clips), ist das eine eigene, dann zu
 * begründende Ergänzung.
 */

/** Die Notiz zu einer Kennung gibt es nicht. */
export class NoteNotFoundError extends Error {}
/** Die Kennung zeigt auf etwas, das keine reguläre Datei ist. */
export class NoteNotAFileError extends Error {}
/** Die Eingabe an ein `notes.*`-Tool ist unbrauchbar (leere Kennung, leerer Inhalt). */
export class NoteInputError extends Error {}
/**
 * `notes.write` sieht einen Schreibzugriff in den Vault, die Policy-Engine hat ihn aber nicht
 * als `hard_write` freigegeben — die beiden Einschätzungen weichen voneinander ab. Parität zu
 * `SourceZoneWriteError` / `assertWritableZone` in `tools/fs/tools.ts`.
 */
export class NotesWriteGrantError extends Error {}

/** So viel Notiz-Text bleibt im Kontext. Die Wahrheit ist der Volltext im Artefakt. */
export const NOTES_READ_EXCERPT_MAX_CHARS = 2_000;
const PREVIEW_LINES = 3;
const PREVIEW_LINE_CAP = 120;
const TITLE_MAX = 200;

export interface NotesToolDeps {
  pool: Pool;
  /** Wurzel der Artefaktablage — für den Volltext von `notes.read`. */
  artifactRoot: string;
  /** Der Obsidian-Vault, absolut und `realpath`-aufgelöst (`buildVaultRoot`). */
  vault: VaultRoot;
}

// ---------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Schreibt Bytes an ihren endgültigen Pfad, ohne dass dort je eine halb geschriebene Datei
 * liegt: erst `.tmp` im selben Verzeichnis, `fsync`, dann `rename`. Wortgleich mit
 * `atomicWrite` in `tools/fs/tools.ts` und dasselbe Muster wie `writeArtifact` (S06).
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

/** Erste `# `-Überschrift, sonst der Dateiname ohne Endung. */
function noteTitle(text: string, rel: string): string {
  for (const line of text.split("\n", 200)) {
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match) return match[1].slice(0, TITLE_MAX);
  }
  const base = rel.split("/").pop() ?? rel;
  return base.replace(/\.[a-z0-9]+$/i, "").slice(0, TITLE_MAX) || rel;
}

function previewLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, PREVIEW_LINES)
    .map((line) =>
      line.length > PREVIEW_LINE_CAP ? `${line.slice(0, PREVIEW_LINE_CAP)} …` : line,
    );
}

// ---------------------------------------------------------------------------
// notes.read
// ---------------------------------------------------------------------------

async function readHandler(deps: NotesToolDeps, inv: ToolInvocation): Promise<ToolOutput> {
  const noteInput = typeof inv.input.note === "string" ? inv.input.note : "";
  const resolved = await resolveNotePath(deps.vault, noteInput);
  if (!resolved.existed) {
    throw new NoteNotFoundError(`Notiz nicht gefunden: ${resolved.rel}`);
  }
  const info = await stat(resolved.path);
  if (!info.isFile()) {
    throw new NoteNotAFileError(`Kein reguläres File: ${resolved.rel}`);
  }

  const bytes = await readFile(resolved.path);
  const text = bytes.toString("utf8");
  const sha256 = sha256Hex(bytes);
  const lineCount = text.split("\n").length;
  const title = noteTitle(text, resolved.rel);

  // Volltext → Artefakt, immer und wortgetreu (Auftrag S15). `readArtifact` gibt die Bytes
  // bytegleich zurück.
  const meta = await writeArtifact(deps.pool, deps.artifactRoot, {
    content: bytes,
    mimeType: "text/markdown",
    summary: `Obsidian-Notiz „${title}“ (${resolved.rel}), ${lineCount} Zeilen`,
    source: { tool: "notes.read", sessionId: inv.sessionId, stepId: inv.stepId },
  });

  const excerpt = text.slice(0, NOTES_READ_EXCERPT_MAX_CHARS);
  const excerptTruncated = text.length > excerpt.length;

  return {
    summary:
      `Obsidian-Notiz „${title}“ (${resolved.rel}): ${lineCount} Zeilen, ${bytes.length} Bytes. ` +
      `Volltext im Artefakt ${meta.uri}.`,
    structured: {
      note: resolved.rel,
      title,
      chars: text.length,
      lines: lineCount,
      sha256,
      excerpt,
      excerpt_truncated: excerptTruncated,
      note_artifact_uri: meta.uri,
    },
    preview: previewLines(excerpt),
    artifact_refs: [meta.uri],
  };
}

// ---------------------------------------------------------------------------
// notes.write
// ---------------------------------------------------------------------------

/**
 * Der Abgleich zweier unabhängiger Einschätzungen, wie `assertWritableZone` in `fs/tools.ts`:
 * der Handler weiß, dass er in den Vault schreibt (hartes Schreiben), die Engine muss den
 * Aufruf als `hard_write`/`destructive` freigegeben haben. Weichen sie ab — etwa weil jemand
 * die Risikostufe der Definition versehentlich auf `soft_write` gesenkt hat —, wird nicht
 * geschrieben.
 */
function assertHardWriteGrant(rel: string, policy: PolicyGrant): void {
  if (policy.effectiveRisk === "hard_write" || policy.effectiveRisk === "destructive") return;
  throw new NotesWriteGrantError(
    `notes.write nach „${rel}“ schreibt direkt in den Obsidian-Vault (hartes Schreiben), aber die Policy hat diesen Aufruf als „${policy.effectiveRisk}“ freigegeben (Subjekt ${policy.subject}). Die beiden Einschätzungen weichen voneinander ab, deshalb wird nicht geschrieben.`,
  );
}

async function writeHandler(deps: NotesToolDeps, inv: ToolInvocation): Promise<ToolOutput> {
  const noteInput = typeof inv.input.note === "string" ? inv.input.note : "";
  const content = typeof inv.input.content === "string" ? inv.input.content : "";
  if (noteInput.trim() === "") {
    throw new NoteInputError('notes.write: Pflichtfeld "note" fehlt oder ist leer.');
  }
  if (content === "") {
    throw new NoteInputError(
      'notes.write: Pflichtfeld "content" ist leer. Eine Notiz ohne Inhalt hat keinen Zweck; zum bewussten Leeren mindestens ein Leerzeichen übergeben.',
    );
  }

  const resolved = await resolveNotePath(deps.vault, noteInput);
  assertHardWriteGrant(resolved.rel, inv.policy);

  if (inv.input.expect_absent === true && resolved.existed) {
    throw new NoteInputError(
      `notes.write: Notiz existiert bereits: ${resolved.rel} (expect_absent ist gesetzt).`,
    );
  }

  const bytes = Buffer.from(content, "utf8");
  await atomicWrite(resolved.path, bytes);

  return {
    summary: `${resolved.existed ? "überschrieben" : "geschrieben"}: ${resolved.rel} (${bytes.length} Bytes) im Obsidian-Vault`,
    structured: {
      note: resolved.rel,
      bytes: bytes.length,
      sha256: sha256Hex(bytes),
      created: !resolved.existed,
    },
    preview: previewLines(content),
    artifact_refs: [],
  };
}

// ---------------------------------------------------------------------------
// Definitionen
// ---------------------------------------------------------------------------

/**
 * Baut die zwei `notes.*`-Definitionen mit Pool, Artefaktwurzel und Vault in den Handlern
 * geschlossen. `runtime/loop/api.ts` registriert sie im Katalog, sobald `OBSIDIAN_VAULT_PATH`
 * gesetzt ist; Tests bauen sich einen eigenen Vault in einem Wegwerf-Verzeichnis.
 *
 * `notes.read` ist `read` (Abschnitt 10). `notes.write` ist `hard_write` (Session-Auftrag,
 * siehe Kopfkommentar) — der Boden `floorFor("hard_write")` ist `ask`, also pausiert jeder
 * erste Schreibversuch für eine Freigabe. Kein `execution`-Feld: beide laufen als Schritt
 * durch die Ausführungshülle (`notes.read` braucht die `step_id` als Artefakt-Herkunft).
 */
export function createNotesTools(deps: NotesToolDeps): ToolDefinition[] {
  return [
    {
      name: "notes.read",
      description:
        "Liest eine Notiz aus dem lokalen Obsidian-Vault (Kennung relativ zum Vault, z. B. „Projekte/Kuronami“; .md wird angehängt). In den Kontext geht ein Ausschnitt plus Metadaten; der vollständige Text liegt wortgetreu als Artefakt-Handle bei.",
      risk: "read",
      repeatable: true,
      inputSchema: {
        fields: {
          note: {
            type: "string",
            required: true,
            description:
              "Notiz-Kennung relativ zum Vault, z. B. „Projekte/Kuronami“ oder „Daily/2026-09-09.md“. Kein absoluter Pfad, kein „..“.",
          },
        },
      },
      handler: (inv) => readHandler(deps, inv),
    },
    {
      name: "notes.write",
      description:
        "Schreibt eine Notiz in den lokalen Obsidian-Vault (atomar, überschreibt vorhandene). Hartes Schreiben: jeder Aufruf pausiert für eine Freigabe, bevor etwas auf die Platte geht.",
      risk: "hard_write",
      // Ein unterbrochener Schreibvorgang mit denselben Bytes ist gefahrlos wiederholbar:
      // der atomare Rename hinterlässt keinen Zwischenzustand (wie fs.write, S08).
      repeatable: true,
      inputSchema: {
        fields: {
          note: {
            type: "string",
            required: true,
            description:
              "Zielnotiz relativ zum Vault, z. B. „Inbox/Idee.md“. Kein absoluter Pfad, kein „..“.",
          },
          content: {
            type: "string",
            required: true,
            description: "Vollständiger neuer Inhalt der Notiz (Markdown).",
          },
          expect_absent: {
            type: "boolean",
            required: false,
            description: "Fehlschlagen, wenn die Notiz schon existiert. Vorgabe: nein.",
          },
        },
      },
      handler: (inv) => writeHandler(deps, inv),
    },
  ];
}
