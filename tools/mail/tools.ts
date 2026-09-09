import type { Pool } from "pg";
import { writeArtifact } from "../../runtime/artifacts/store.js";
import type { JsonValue } from "../../runtime/steps/types.js";
import type { N8nBridge } from "../n8n/bridge.js";
import type { ToolDefinition, ToolInvocation, ToolOutput } from "../types.js";
import { type InjectionFlag, normalizeContent, scanForInjection } from "../web/normalize.js";

/**
 * `mail.search`, `mail.read`, `mail.draft` (S14) — die ersten Assistenz-Tools über n8n
 * (Abschnitt 4.8, "Assistenz-Tools über n8n"). Sie laufen durch denselben Router wie `fs.*`
 * und `web.*` und damit durch die Ausführungshülle (S05), die Policy-Engine (S11) und die
 * einheitliche Rückgabehülle. Der Transport nach n8n ist die Brücke aus S13
 * (`createN8nBridge`), injiziert wie das Backend von `web.search`.
 *
 * **`mail.send` gibt es nicht, und es ist kein Versehen.** Der Auftrag von S14 ist "Entwurf
 * entsteht, Senden ist technisch unmöglich". Das steht hier an drei Stellen im Weg:
 *
 *   1. `createMailTools` gibt genau drei Definitionen zurück, keine heißt `mail.send`.
 *   2. `MAIL_WEBHOOKS` ist die **vollständige** Liste der n8n-Webhook-Pfade, die diese Schicht
 *      je aufruft. Es gibt keinen Sende-Eintrag, und kein anderes Modul spricht n8n im Namen
 *      von `mail.*` an — der einzige Ausgang ist `deps.bridge.invoke`, und der bekommt immer
 *      einen dieser drei Pfade.
 *   3. `mail.draft` legt einen Entwurf ab (Ordner "Drafts", per IMAP-`append` bzw.
 *      "create draft"); der Workflow hat keinen SMTP-Knoten. Ein Entwurf muss von einem
 *      Menschen im Mailprogramm geöffnet und gesendet werden.
 *
 * **Warum eigene Handler statt eines generischen n8n-Workflows (`N8nWorkflowDef`).** S13 hat
 * angekündigt, S14 reiche `mail.*` durch `config.n8n.workflows` als generische Workflows
 * durch. Das trägt nicht: der generische Handler (`runWorkflow` in `n8n/workflows.ts`) reicht
 * `structured.body` unverändert durch. S14 verlangt aber drei Formen, die nur ein
 * tool-spezifischer Handler herstellen kann — dieselbe Lage, aus der `web.fetch` einen
 * bespoke Handler hat statt ein generisches Tool zu sein:
 *
 *   * **`mail.search`** gibt je Treffer **nur** Betreff, Absender, Datum, Kurzfassung — nie
 *     den Volltext. Der Handler baut jede Kopfzeile aus einem festen Satz Skalarfelder neu
 *     auf; ein body-artiges Feld aus dem Workflow wird nie mitkopiert.
 *   * **`mail.read`** legt den Volltext als Artefakt ab und lässt nur eine normalisierte
 *     Kurzfassung im Kontext; jeder Anhang wird zu einem eigenen Artefakt und kommt nie in
 *     den Kontext.
 *   * **Mailinhalt ist nicht vertrauenswürdig** (Abschnitt 4.7). `structured.trust` ist
 *     `"untrusted"`, `summary` beginnt mit einer Markierung, und Injection-Muster im Text
 *     werden **markiert, nicht entfernt** (`scanForInjection`) — eine Anweisung aus einer
 *     Mail hebt nie eine Freigabe auf, und ein still gelöschtes Muster wäre ein verstecktes
 *     Signal.
 *
 * Die **Bytes** eines Mail-Volltexts und eines Anhangs laufen nicht durch den
 * Redaction-Filter — dieselbe bewusste Grenze wie bei den `web.fetch`-Rohbytes (S09) und den
 * Artefaktbytes (S07): ein Textmuster über beliebige Bytes beschädigte die SHA-256-Kette. Der
 * Schutz greift an der anderen Stelle: `summary`, `excerpt` und `injection_flags` gehen durch
 * `appendEventInTx` (Protokoll) und `buildPrompt` (Kontext), und beide filtern.
 */

/**
 * Die vollständige Liste der n8n-Webhook-Pfade, die `mail.*` aufruft. Eingefroren, damit ein
 * vierter Pfad eine sichtbare Änderung an dieser Datei ist und kein beiläufiger Zusatz. Kein
 * Eintrag für "send": Senden ist technisch nicht vorgesehen (siehe Kopfkommentar).
 */
export const MAIL_WEBHOOKS = Object.freeze({
  search: "mail-search",
  read: "mail-read",
  draft: "mail-draft",
} as const);

/** So viele Treffer stehen im Kontext; **alle** stehen (als Kopfzeilen) im Artefakt. */
export const MAIL_SEARCH_CONTEXT_MAX = 10;
/** So viel normalisierter Mailtext bleibt im Kontext. Die Wahrheit ist der Volltext im Artefakt. */
export const MAIL_READ_EXCERPT_MAX_CHARS = 800;
/** Mehr Anhänge als das lehnt `mail.read` ab, statt endlos Artefakte zu schreiben. */
export const MAIL_MAX_ATTACHMENTS = 25;
/** Harte Obergrenze je Anhang. */
export const MAIL_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const SUBJECT_MAX = 200;
const ADDRESS_MAX = 200;
const SUMMARY_MAX = 240;
const DATE_MAX = 40;
const FILENAME_MAX = 200;
const PREVIEW_LINES = 3;
const PREVIEW_LINE_CAP = 120;

const UNTRUSTED_MARK = "[nicht vertrauenswürdig · Mailinhalt]";

/** Der n8n-Workflow hat etwas zurückgegeben, das sich nicht als Mail-Antwort lesen lässt. */
export class MailBackendResponseError extends Error {}
/** Die Eingabe an ein Mail-Tool ist unbrauchbar (leere id, leerer Entwurf). */
export class MailInputError extends Error {}
/** Ein Anhang ist zu groß oder es sind zu viele. */
export class MailAttachmentError extends Error {}

export interface MailToolDeps {
  pool: Pool;
  /** Wurzel der Artefaktablage — für Volltext und Anhänge. */
  artifactRoot: string;
  /**
   * Die n8n-Brücke (S13). Injiziert wie `WebSearchBackend` in `web.search`: welche Instanz,
   * welcher `fetch` — Sache des Aufrufers. Fehlt eine Basis-URL, meldet jeder Mail-Aufruf eine
   * Fehlerhülle (`N8nUnavailableError`); das Tool bleibt registriert.
   */
  bridge: N8nBridge;
}

// ---------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------

function isRecord(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** n8n gibt oft ein Array mit einem Element je Durchlauf zurück — ein einzelnes wird ausgepackt. */
function unwrapSingle(body: JsonValue): JsonValue {
  return Array.isArray(body) && body.length === 1 ? body[0] : body;
}

/**
 * Findet in der n8n-Antwort das Objekt mit den Nutzdaten. n8n verpackt je nach Knoten in
 * `{ json: … }` oder `{ body: … }`; höchstens zwei Ebenen tief, und nur, solange die aktuelle
 * Ebene keinen der erwarteten Schlüssel selbst trägt (sonst descendeten wir in einen
 * String-`body`, der der Mailtext ist).
 */
function payloadRecord(body: JsonValue): { [key: string]: JsonValue } {
  const markers = ["messages", "subject", "id", "body_text", "draft_id", "mailbox", "created"];
  let current: JsonValue = unwrapSingle(body);
  for (let hop = 0; hop < 3; hop += 1) {
    if (!isRecord(current)) return {};
    const record = current;
    if (markers.some((key) => key in record)) return record;
    const next = isRecord(record.json) ? record.json : isRecord(record.body) ? record.body : null;
    if (next === null) return record;
    current = next;
  }
  return isRecord(current) ? current : {};
}

/** Zeichenkette, Whitespace zusammengefasst, auf `max` gekürzt. Alles andere → "". */
function str(value: JsonValue | undefined, max: number): string {
  if (typeof value !== "string") return "";
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)} …` : clean;
}

function firstString(...values: (JsonValue | undefined)[]): JsonValue | undefined {
  for (const value of values) if (typeof value === "string") return value;
  return undefined;
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
// mail.search
// ---------------------------------------------------------------------------

/**
 * Genau die vier erlaubten Angaben je Treffer (plus id und unread-Flag) — nie mehr.
 *
 * `type` und kein `interface`: nur ein Typalias mit reinen Primitivfeldern bekommt in
 * TypeScript die implizite Indexsignatur, mit der der Wert als `JsonValue` durch die
 * Rückgabehülle geht (dieselbe Überlegung wie bei `ToolResult` und `InjectionFlag`).
 */
type MailHeader = {
  id: string;
  subject: string;
  from: string;
  date: string;
  summary: string;
  unread: boolean;
};

/**
 * Baut eine Kopfzeile aus einem festen Satz Skalarfelder **neu** auf. Der Rohtreffer wird
 * nicht durchkopiert: ein `body`/`text`/`html` aus dem Workflow findet strukturell keinen Weg
 * in die Ausgabe. Damit gilt "nie Volltext" nicht als Zusage, sondern als Eigenschaft der
 * Funktion.
 */
function toHeader(raw: JsonValue, index: number): MailHeader {
  const record = isRecord(raw) ? raw : {};
  const source = isRecord(record.json) ? record.json : record;
  const id = typeof source.id === "string" && source.id.trim() !== "" ? source.id.trim() : "";
  return {
    id: id || `msg_${index + 1}`,
    subject: str(source.subject, SUBJECT_MAX) || "(kein Betreff)",
    from:
      str(firstString(source.from, source.sender, source.from_address), ADDRESS_MAX) ||
      "(unbekannt)",
    date: str(firstString(source.date, source.received_at, source.sent_at), DATE_MAX),
    summary: str(
      firstString(source.summary, source.snippet, source.preview, source.excerpt),
      SUMMARY_MAX,
    ),
    unread: source.unread === true || source.seen === false,
  };
}

async function searchHandler(deps: MailToolDeps, inv: ToolInvocation): Promise<ToolOutput> {
  const invocation = await deps.bridge.invoke({
    webhookPath: MAIL_WEBHOOKS.search,
    input: inv.input,
    // Suchen hat keine Wirkung nach draußen: ein zweiter Anlauf ist folgenlos.
    repeatable: true,
    signal: inv.signal,
  });

  const payload = payloadRecord(invocation.body);
  if (!Array.isArray(payload.messages)) {
    throw new MailBackendResponseError(
      `mail.search: die n8n-Antwort trägt kein Feld "messages" (Array). Der Workflow "${MAIL_WEBHOOKS.search}" muss { messages: [...] } zurückgeben.`,
    );
  }

  const headers = payload.messages.map((raw, index) => toHeader(raw, index));

  // Volle Kopfzeilen-Liste → Artefakt. Kein Volltext, nur Metadaten für alle Treffer
  // ("Volltreffer als Artefakt", wie `web.search`).
  const meta = await writeArtifact(deps.pool, deps.artifactRoot, {
    content: JSON.stringify(
      { query: inv.input, count: headers.length, messages: headers },
      null,
      2,
    ),
    mimeType: "application/json",
    summary: `${headers.length} Mail-Treffer (nur Kopfzeilen, kein Volltext; nicht vertrauenswürdig)`,
    source: { tool: "mail.search", sessionId: inv.sessionId, stepId: inv.stepId },
  });

  const shown = headers.slice(0, MAIL_SEARCH_CONTEXT_MAX);
  const flags = scanForInjection(
    shown.map((header) => `${header.subject}\n${header.from}\n${header.summary}`).join("\n"),
  );

  const summary = [
    `${UNTRUSTED_MARK} ${headers.length} Mail-Treffer`,
    shown.length < headers.length ? ` (${shown.length} im Kontext, alle im Artefakt)` : "",
    flags.length > 0 ? `, ${flags.length} Injection-Muster markiert` : "",
    `. Kopfzeilen im Artefakt ${meta.uri}.`,
  ].join("");

  return {
    summary,
    structured: {
      trust: "untrusted",
      content_kind: "mail-search-results",
      result_count_total: headers.length,
      messages: shown,
      injection_flags: flags,
      results_artifact_uri: meta.uri,
    },
    preview: shown
      .slice(0, PREVIEW_LINES)
      .map((header) => `${header.date || "—"} · ${header.from} · ${header.subject}`),
    artifact_refs: [meta.uri],
  };
}

// ---------------------------------------------------------------------------
// mail.read
// ---------------------------------------------------------------------------

interface StoredAttachment {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  uri: string;
}

async function materializeAttachments(
  deps: MailToolDeps,
  inv: ToolInvocation,
  raw: JsonValue | undefined,
  subject: string,
): Promise<StoredAttachment[]> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new MailBackendResponseError('mail.read: "attachments" ist kein Array.');
  }
  if (raw.length > MAIL_MAX_ATTACHMENTS) {
    throw new MailAttachmentError(
      `mail.read: ${raw.length} Anhänge überschreiten die Obergrenze von ${MAIL_MAX_ATTACHMENTS}.`,
    );
  }

  const stored: StoredAttachment[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const entry = isRecord(raw[index]) ? (raw[index] as { [key: string]: JsonValue }) : {};
    const filename =
      str(firstString(entry.filename, entry.name), FILENAME_MAX) || `anhang-${index + 1}`;
    const mimeType =
      str(firstString(entry.mime_type, entry.content_type, entry.mimeType), 200) ||
      "application/octet-stream";
    const base64 = firstString(entry.content_base64, entry.content, entry.data);
    const bytes = Buffer.from(typeof base64 === "string" ? base64 : "", "base64");
    if (bytes.length > MAIL_MAX_ATTACHMENT_BYTES) {
      throw new MailAttachmentError(
        `mail.read: Anhang "${filename}" ist ${bytes.length} Bytes groß, erlaubt sind ${MAIL_MAX_ATTACHMENT_BYTES}.`,
      );
    }
    // Anhang → eigenes Artefakt, byteweise, nie in den Kontext.
    const meta = await writeArtifact(deps.pool, deps.artifactRoot, {
      content: bytes,
      mimeType,
      summary: `Mail-Anhang (nicht vertrauenswürdig): ${filename} zu „${subject}“`,
      source: { tool: "mail.read", sessionId: inv.sessionId, stepId: inv.stepId },
    });
    stored.push({ filename, mimeType, sizeBytes: meta.sizeBytes, uri: meta.uri });
  }
  return stored;
}

async function readHandler(deps: MailToolDeps, inv: ToolInvocation): Promise<ToolOutput> {
  const id = typeof inv.input.id === "string" ? inv.input.id.trim() : "";
  if (id === "") {
    throw new MailInputError('mail.read: Pflichtfeld "id" fehlt oder ist leer.');
  }

  const invocation = await deps.bridge.invoke({
    webhookPath: MAIL_WEBHOOKS.read,
    input: inv.input,
    // Lesen hat keine Wirkung nach draußen.
    repeatable: true,
    signal: inv.signal,
  });

  const source = payloadRecord(invocation.body);
  if (Object.keys(source).length === 0) {
    throw new MailBackendResponseError(
      `mail.read: die n8n-Antwort ist leer oder kein Objekt. Der Workflow "${MAIL_WEBHOOKS.read}" muss die Mail als JSON-Objekt zurückgeben.`,
    );
  }

  const subject = str(source.subject, SUBJECT_MAX) || "(kein Betreff)";
  const from = str(firstString(source.from, source.sender), ADDRESS_MAX) || "(unbekannt)";
  const to = str(source.to, ADDRESS_MAX);
  const date = str(firstString(source.date, source.received_at, source.sent_at), DATE_MAX);

  const rawBody = firstString(source.body_text, source.body, source.text, source.body_html);
  const bodyText = typeof rawBody === "string" ? rawBody : "";
  const bodyMime =
    str(source.body_mime, 60) ||
    (typeof source.body_html === "string" &&
    typeof source.body_text !== "string" &&
    typeof source.body !== "string" &&
    typeof source.text !== "string"
      ? "text/html"
      : "text/plain");

  // Volltext → Artefakt, immer und wortgetreu. Nicht vertrauenswürdige Rohfassung; sie läuft
  // nicht durch den Redaction-Filter (siehe Kopfkommentar).
  const bodyArtifact = await writeArtifact(deps.pool, deps.artifactRoot, {
    content: bodyText,
    mimeType: bodyMime,
    summary: `Mail-Volltext (nicht vertrauenswürdig): „${subject}“ von ${from}`,
    source: { tool: "mail.read", sessionId: inv.sessionId, stepId: inv.stepId },
  });

  const attachments = await materializeAttachments(deps, inv, source.attachments, subject);

  // Normalisierte Kurzfassung → nur Kontext. Trägt nie den vollständigen Text.
  const normalized = normalizeContent(bodyText, bodyMime);
  const flags = scanForInjection(normalized.text);
  const excerpt = normalized.text.slice(0, MAIL_READ_EXCERPT_MAX_CHARS);
  const excerptTruncated = normalized.text.length > excerpt.length;

  const summary = [
    `${UNTRUSTED_MARK} „${subject}“ von ${from}`,
    date ? `, ${date}` : "",
    `. Volltext im Artefakt ${bodyArtifact.uri}`,
    attachments.length > 0
      ? `, ${attachments.length} Anhang/Anhänge als Artefakt`
      : ", keine Anhänge",
    flags.length > 0 ? `, ${flags.length} Injection-Muster markiert` : "",
    ".",
  ].join("");

  return {
    summary,
    structured: {
      trust: "untrusted",
      content_kind: "mail-normalized-summary",
      id,
      subject,
      from,
      to,
      date,
      excerpt,
      excerpt_truncated: excerptTruncated,
      body_chars: normalized.text.length,
      body_mime: bodyMime,
      body_artifact_uri: bodyArtifact.uri,
      injection_flags: flags,
      attachments: attachments.map((attachment) => ({
        filename: attachment.filename,
        mime_type: attachment.mimeType,
        size_bytes: attachment.sizeBytes,
        artifact_uri: attachment.uri,
      })),
    },
    preview: previewLines(excerpt),
    artifact_refs: [bodyArtifact.uri, ...attachments.map((attachment) => attachment.uri)],
  };
}

// ---------------------------------------------------------------------------
// mail.draft
// ---------------------------------------------------------------------------

async function draftHandler(deps: MailToolDeps, inv: ToolInvocation): Promise<ToolOutput> {
  const to = typeof inv.input.to === "string" ? inv.input.to.trim() : "";
  const subject = typeof inv.input.subject === "string" ? inv.input.subject : "";
  const body = typeof inv.input.body === "string" ? inv.input.body : "";
  if (to === "") {
    throw new MailInputError('mail.draft: Pflichtfeld "to" fehlt oder ist leer.');
  }
  if (body.trim() === "") {
    throw new MailInputError(
      'mail.draft: Pflichtfeld "body" ist leer. Ein leerer Entwurf hat keinen Zweck.',
    );
  }

  const invocation = await deps.bridge.invoke({
    webhookPath: MAIL_WEBHOOKS.draft,
    input: inv.input,
    // Ein zweiter Anlauf legte einen zweiten Entwurf an. Nicht wiederholbar — die Brücke
    // versucht bei einem vorübergehenden Fehler nicht erneut, und die Ausführungshülle
    // markiert den Schritt als endgültig fehlgeschlagen statt ihn zu wiederholen (S05).
    repeatable: false,
    signal: inv.signal,
  });

  const result = payloadRecord(invocation.body);
  const draftId = firstString(result.draft_id, result.id, result.message_id);
  const mailbox = str(firstString(result.mailbox, result.folder), 80) || "Drafts";

  return {
    summary:
      `Entwurf im Postfach angelegt, nichts versendet: „${str(subject, SUBJECT_MAX) || "(kein Betreff)"}“ ` +
      `an ${str(to, ADDRESS_MAX)}, Ablage ${mailbox}.`,
    structured: {
      created: draftId !== undefined,
      draft_id: typeof draftId === "string" ? draftId : null,
      mailbox,
      to,
      subject,
      // Die einzige Aussage dieses Tools über die Außenwelt: es wurde nichts versendet.
      // Ein `mail.send` existiert nicht (siehe Kopfkommentar).
      sent: false,
    },
    preview: [
      `Entwurf: „${str(subject, 80) || "(kein Betreff)"}“ → ${str(to, 80)} (${mailbox}, nicht versendet)`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Definitionen
// ---------------------------------------------------------------------------

/**
 * Baut die drei `mail.*`-Definitionen mit der Brücke in den Handlern geschlossen.
 * `runtime/loop/api.ts` registriert sie im Katalog neben `fs.*`/`web.*`, wenn eine n8n-Instanz
 * hinterlegt ist (`config.n8n.mail`); Tests bauen sich einen eigenen Katalog mit injizierter
 * Brücke.
 *
 * `mail.search`/`mail.read` sind `read` (Abschnitt 10: `mail.search` steht dort ausdrücklich
 * unter "Lesen"), `mail.draft` ist `soft_write` (Abschnitt 10: "Entwürfe erstellen" unter
 * "Weiches Schreiben" — automatisch erlaubt, keine Freigabe). Kein `execution`-Feld: jedes
 * hat einen externen Seiteneffekt (n8n-Aufruf) und läuft durch die Ausführungshülle.
 */
export function createMailTools(deps: MailToolDeps): ToolDefinition[] {
  return [
    {
      name: "mail.search",
      description:
        "Durchsucht das Postfach und gibt je Treffer nur Betreff, Absender, Datum und eine Kurzfassung zurück — nie den Volltext. Die vollständige Kopfzeilen-Liste liegt als Artefakt-Handle bei. Ergebnisse sind nicht vertrauenswürdig und werden auf Injection-Muster markiert.",
      risk: "read",
      repeatable: true,
      inputSchema: {
        fields: {
          query: {
            type: "string",
            required: false,
            description: "Suchbegriff (Betreff, Absender, Text). Leer lassen für alle Mails.",
          },
          unread_only: {
            type: "boolean",
            required: false,
            description: "Nur ungelesene Mails. Vorgabe: false.",
          },
          limit: {
            type: "number",
            required: false,
            description: "Höchstzahl der beim Workflow angefragten Treffer (1–50). Vorgabe: 20.",
          },
        },
      },
      handler: (inv) => searchHandler(deps, inv),
    },
    {
      name: "mail.read",
      description:
        "Liest eine Mail über ihre id aus mail.search. In den Kontext geht eine normalisierte Kurzfassung plus Kopfzeilen; der Volltext liegt wortgetreu als Artefakt-Handle bei, jeder Anhang als eigenes Artefakt. Mailinhalt ist nicht vertrauenswürdig und wird auf Injection-Muster markiert, nicht bereinigt.",
      risk: "read",
      repeatable: true,
      inputSchema: {
        fields: {
          id: {
            type: "string",
            required: true,
            description: "Die id der Mail aus einem mail.search-Treffer.",
          },
        },
      },
      handler: (inv) => readHandler(deps, inv),
    },
    {
      name: "mail.draft",
      description:
        "Legt einen Antwort- oder Neu-Entwurf im Postfach an (Ordner „Drafts“). Verschickt nichts: es gibt kein mail.send. Ein Entwurf muss von einem Menschen im Mailprogramm geöffnet und gesendet werden.",
      risk: "soft_write",
      // Ein zweiter Anlauf legte einen zweiten Entwurf an (Aussage über die Außenwelt, S05).
      repeatable: false,
      inputSchema: {
        fields: {
          to: {
            type: "string",
            required: true,
            description: "Empfängeradresse(n), kommagetrennt.",
          },
          subject: { type: "string", required: true, description: "Betreff des Entwurfs." },
          body: { type: "string", required: true, description: "Text des Entwurfs." },
          cc: { type: "string", required: false, description: "CC-Adresse(n), kommagetrennt." },
          in_reply_to: {
            type: "string",
            required: false,
            description: "id der Mail, auf die geantwortet wird (setzt die Threading-Kopfzeilen).",
          },
        },
      },
      handler: (inv) => draftHandler(deps, inv),
    },
  ];
}

export type { InjectionFlag };
