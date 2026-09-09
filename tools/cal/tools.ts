import type { Pool } from "pg";
import { writeArtifact } from "../../runtime/artifacts/store.js";
import type { JsonValue } from "../../runtime/steps/types.js";
import type { N8nBridge } from "../n8n/bridge.js";
import type { ToolDefinition, ToolInvocation, ToolOutput } from "../types.js";

/**
 * `cal.list`, `cal.create`, `cal.update` (S15, Abschnitt 9) — Kalender-Tools **über n8n**.
 * Transport ist die Brücke aus S13 (`createN8nBridge`), injiziert wie das Backend von
 * `web.search` und wie bei `mail.*` (S14). Loop, Sessions, Checkpoints, Kontext und
 * Governance bleiben in der Runtime; ein Workflow ist nur ein HTTP-Eingang.
 *
 * **Warum eigene Handler statt generischer `N8nWorkflowDef`.** Dieselbe Lage wie bei `mail.*`
 * (S14) und `web.fetch` (S09): der generische n8n-Handler (`runWorkflow` in
 * `n8n/workflows.ts`) reicht `structured.body` unverändert durch. S15 verlangt für die
 * **lesenden** Tools "Zusammenfassung im Kontext, Volltext als Artefakt" — `cal.list` legt
 * deshalb die vollständige Terminliste als Artefakt ab und lässt nur eine knappe Auswahl
 * normalisierter Kopfzeilen im Kontext. Das kann nur ein tool-spezifischer Handler.
 *
 * **Schreiben pausiert immer.** `cal.create` und `cal.update` sind `hard_write` (Abschnitt
 * 10: "Produktivaktion"/Kalender-Eintrag; Session-Auftrag ausdrücklich `hard_write`). Sie
 * nehmen weder Pfad noch Adresse entgegen, die Ressource ist `none`, der Boden
 * `floorFor("hard_write")` ist `ask` — der Router lässt den `ApprovalRequiredError` der
 * Engine durch, der Lauf hält auf `awaiting_user`, und erst nach der Freigabe läuft der
 * Handler (und damit der n8n-Aufruf).
 *
 * Kalenderinhalt wird als **vertrauenswürdig** behandelt — es ist der eigene Kalender des
 * Nutzers. Fremde Meeting-Einladungen mit angreiferkontrolliertem Titel/Text sind ein
 * bekannter, später zu schließender Spalt (dieselbe Injection-Markierung, die `mail.*`
 * bereits macht) und bewusst nicht Teil von S15.
 */

/**
 * Die vollständige Liste der n8n-Webhook-Pfade, die `cal.*` aufruft. Eingefroren, wie
 * `MAIL_WEBHOOKS` (S14): ein vierter Pfad ist eine sichtbare Änderung an dieser Datei. Es
 * gibt bewusst **keinen** Lösch-Pfad — `cal.delete` wäre `destructive` und eine eigene,
 * spätere Entscheidung.
 */
export const CAL_WEBHOOKS = Object.freeze({
  list: "cal-list",
  create: "cal-create",
  update: "cal-update",
} as const);

/** So viele Termine stehen im Kontext; **alle** stehen im Artefakt ("Volltext als Artefakt"). */
export const CAL_LIST_CONTEXT_MAX = 25;
/** Tage im Vorgabefenster von `cal.list`, wenn kein Bereich angegeben ist ("diese Woche"). */
export const CAL_DEFAULT_RANGE_DAYS = 7;

const TITLE_MAX = 240;
const FIELD_MAX = 200;
const SUMMARY_MAX = 240;
const DATETIME_MAX = 40;
const PREVIEW_LINES = 3;

/** Der n8n-Workflow hat etwas zurückgegeben, das sich nicht als Kalender-Antwort lesen lässt. */
export class CalBackendResponseError extends Error {}
/** Die Eingabe an ein `cal.*`-Tool ist unbrauchbar (Pflichtfeld fehlt, nichts zu ändern). */
export class CalInputError extends Error {}

export interface CalToolDeps {
  pool: Pool;
  /** Wurzel der Artefaktablage — für die vollständige Terminliste von `cal.list`. */
  artifactRoot: string;
  /** Die n8n-Brücke (S13). Fehlt eine Basis-URL, meldet jeder Aufruf eine Fehlerhülle. */
  bridge: N8nBridge;
}

// ---------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------

function isRecord(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Findet in der n8n-Antwort das Objekt mit den Nutzdaten. n8n gibt oft ein 1-Element-Array je
 * Durchlauf zurück und verpackt je nach Knoten in `{ json: … }` oder `{ body: … }`. Es wird
 * nur solange abgestiegen, wie die aktuelle Ebene **ausschließlich** einen dieser Wrapper
 * trägt — sonst descendeten wir aus den eigentlichen Nutzdaten heraus.
 */
function readPayload(body: JsonValue): { [key: string]: JsonValue } {
  let current: JsonValue = Array.isArray(body) && body.length === 1 ? body[0] : body;
  for (let hop = 0; hop < 3; hop += 1) {
    if (!isRecord(current)) return {};
    const keys = Object.keys(current);
    const onlyWrapper = keys.length > 0 && keys.every((key) => key === "json" || key === "body");
    if (!onlyWrapper) return current;
    const next = isRecord(current.json)
      ? current.json
      : isRecord(current.body)
        ? current.body
        : null;
    if (next === null) return current;
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

/** Nur die definierten Felder — n8n bekommt keinen Rattenschwanz aus `undefined`/`null`. */
function compactInput(input: Record<string, JsonValue>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== null && value !== "") out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// cal.list
// ---------------------------------------------------------------------------

/**
 * Genau die erlaubten Angaben je Termin — als Typalias mit reinen Primitivfeldern, damit der
 * Wert die implizite Indexsignatur bekommt und als `JsonValue` durch die Hülle geht (wie
 * `MailHeader` in S14). Der Rohtermin wird **nicht** durchkopiert: ein `description`/
 * `attendees`/`raw` aus dem Workflow findet strukturell keinen Weg in den Kontext — nur in
 * das Artefakt.
 */
type CalEventRow = {
  id: string;
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  location: string;
  calendar: string;
  status: string;
  summary: string;
};

function toEventRow(raw: JsonValue, index: number): CalEventRow {
  const record = isRecord(raw) ? raw : {};
  const source = isRecord(record.json) ? record.json : record;
  const id =
    typeof source.id === "string" && source.id.trim() !== ""
      ? source.id.trim()
      : `evt_${index + 1}`;
  return {
    id,
    title:
      str(firstString(source.title, source.summary, source.subject), TITLE_MAX) || "(kein Titel)",
    start: str(firstString(source.start, source.start_time, source.starts_at), DATETIME_MAX),
    end: str(firstString(source.end, source.end_time, source.ends_at), DATETIME_MAX),
    all_day: source.all_day === true || source.allDay === true,
    location: str(source.location, FIELD_MAX),
    calendar: str(firstString(source.calendar, source.calendar_id, source.organizer), FIELD_MAX),
    status: str(source.status, 40),
    summary: str(firstString(source.description, source.notes, source.preview), SUMMARY_MAX),
  };
}

/** ISO-Zeitpunkt für den Beginn der laufenden Woche (Montag 00:00 lokal). */
function startOfCurrentWeek(now: Date): Date {
  const day = now.getDay(); // 0 = Sonntag
  const mondayOffset = (day + 6) % 7;
  const monday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - mondayOffset,
    0,
    0,
    0,
    0,
  );
  return monday;
}

async function listHandler(deps: CalToolDeps, inv: ToolInvocation): Promise<ToolOutput> {
  const givenStart = typeof inv.input.start === "string" ? inv.input.start.trim() : "";
  const givenEnd = typeof inv.input.end === "string" ? inv.input.end.trim() : "";

  // Kein Bereich angegeben → Vorgabefenster "diese Woche" (Montag bis Montag, sieben Tage).
  let rangeStart = givenStart;
  let rangeEnd = givenEnd;
  if (givenStart === "" && givenEnd === "") {
    const start = startOfCurrentWeek(new Date());
    const end = new Date(start.getTime() + CAL_DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000);
    rangeStart = start.toISOString();
    rangeEnd = end.toISOString();
  }

  const query = compactInput({
    ...inv.input,
    start: rangeStart,
    end: rangeEnd,
  });

  const invocation = await deps.bridge.invoke({
    webhookPath: CAL_WEBHOOKS.list,
    input: query,
    // Termine lesen hat keine Wirkung nach draußen: ein zweiter Anlauf ist folgenlos.
    repeatable: true,
    signal: inv.signal,
  });

  const payload = readPayload(invocation.body);
  const rawEvents = payload.events ?? payload.items;
  if (!Array.isArray(rawEvents)) {
    throw new CalBackendResponseError(
      `cal.list: die n8n-Antwort trägt kein Feld "events" (Array). Der Workflow "${CAL_WEBHOOKS.list}" muss { events: [...] } zurückgeben.`,
    );
  }

  const rows = rawEvents.map((raw, index) => toEventRow(raw, index));

  // Vollständige Terminliste (roh, mit allen Feldern) → Artefakt. "Volltext als Artefakt".
  const meta = await writeArtifact(deps.pool, deps.artifactRoot, {
    content: JSON.stringify(
      { range: { start: rangeStart, end: rangeEnd }, count: rawEvents.length, events: rawEvents },
      null,
      2,
    ),
    mimeType: "application/json",
    summary: `${rawEvents.length} Kalender-Termine (${rangeStart || "?"} – ${rangeEnd || "?"})`,
    source: { tool: "cal.list", sessionId: inv.sessionId, stepId: inv.stepId },
  });

  const shown = rows.slice(0, CAL_LIST_CONTEXT_MAX);
  const rangeText = rangeStart || rangeEnd ? ` (${rangeStart || "?"} – ${rangeEnd || "?"})` : "";
  const contextNote =
    shown.length < rows.length ? `, ${shown.length} im Kontext, alle im Artefakt` : "";
  const summary = `${rows.length} Termine${rangeText}${contextNote}. Vollständige Liste im Artefakt ${meta.uri}.`;

  return {
    summary,
    structured: {
      content_kind: "calendar-events",
      range: { start: rangeStart, end: rangeEnd },
      result_count_total: rows.length,
      events: shown,
      events_artifact_uri: meta.uri,
    },
    preview: shown
      .slice(0, PREVIEW_LINES)
      .map(
        (row) => `${row.start || "—"} · ${row.title}${row.location ? ` @ ${row.location}` : ""}`,
      ),
    artifact_refs: [meta.uri],
  };
}

// ---------------------------------------------------------------------------
// cal.create / cal.update
// ---------------------------------------------------------------------------

/** Die Felder, die `cal.update` ändern kann — mindestens eins muss gesetzt sein. */
const UPDATABLE_FIELDS = ["title", "start", "end", "location", "description", "calendar"] as const;

function writeConfirmation(
  action: "angelegt" | "aktualisiert",
  input: Record<string, JsonValue>,
  payload: { [key: string]: JsonValue },
): ToolOutput {
  const eventId = firstString(payload.event_id, payload.id, payload.uid);
  const calendar = str(firstString(payload.calendar, input.calendar), FIELD_MAX) || "(Standard)";
  const title = str(firstString(input.title, payload.title), TITLE_MAX) || "(kein Titel)";
  const start = str(firstString(input.start, payload.start), DATETIME_MAX);
  const htmlLink = firstString(payload.html_link, payload.htmlLink, payload.url);

  const idNote = typeof eventId === "string" ? ` id ${eventId}.` : "";
  return {
    summary: `Termin ${action}: „${title}“${start ? ` am ${start}` : ""}, Kalender ${calendar}.${idNote}`,
    structured: {
      [action === "angelegt" ? "created" : "updated"]: eventId !== undefined || payload.ok === true,
      event_id: typeof eventId === "string" ? eventId : null,
      calendar,
      title,
      start: start || null,
      end: str(firstString(input.end, payload.end), DATETIME_MAX) || null,
      html_link: typeof htmlLink === "string" ? htmlLink : null,
    },
    preview: [`Termin ${action}: „${str(title, 80)}“${start ? ` (${start})` : ""} → ${calendar}`],
  };
}

async function createHandler(deps: CalToolDeps, inv: ToolInvocation): Promise<ToolOutput> {
  const title = typeof inv.input.title === "string" ? inv.input.title.trim() : "";
  const start = typeof inv.input.start === "string" ? inv.input.start.trim() : "";
  const end = typeof inv.input.end === "string" ? inv.input.end.trim() : "";
  if (title === "") throw new CalInputError('cal.create: Pflichtfeld "title" fehlt oder ist leer.');
  if (start === "") throw new CalInputError('cal.create: Pflichtfeld "start" fehlt oder ist leer.');
  if (end === "") throw new CalInputError('cal.create: Pflichtfeld "end" fehlt oder ist leer.');

  const invocation = await deps.bridge.invoke({
    webhookPath: CAL_WEBHOOKS.create,
    input: compactInput(inv.input),
    // Ein zweiter Anlauf legte einen zweiten Termin an. Nicht wiederholbar — wie mail.draft.
    repeatable: false,
    signal: inv.signal,
  });

  return writeConfirmation("angelegt", inv.input, readPayload(invocation.body));
}

async function updateHandler(deps: CalToolDeps, inv: ToolInvocation): Promise<ToolOutput> {
  const eventId = typeof inv.input.event_id === "string" ? inv.input.event_id.trim() : "";
  if (eventId === "") {
    throw new CalInputError('cal.update: Pflichtfeld "event_id" fehlt oder ist leer.');
  }
  const hasChange = UPDATABLE_FIELDS.some(
    (field) => typeof inv.input[field] === "string" && (inv.input[field] as string).trim() !== "",
  );
  if (!hasChange) {
    throw new CalInputError(
      `cal.update: kein zu änderndes Feld angegeben (mindestens eines von ${UPDATABLE_FIELDS.join(", ")}).`,
    );
  }

  const invocation = await deps.bridge.invoke({
    webhookPath: CAL_WEBHOOKS.update,
    input: compactInput(inv.input),
    // Ein zweiter Anlauf mit denselben Feldern wäre zwar oft folgenlos, aber das weiß nur der
    // Workflow-Autor (Datum-Verschiebung relativ vs. absolut). Vorsichtige Seite wie mail.draft.
    repeatable: false,
    signal: inv.signal,
  });

  return writeConfirmation("aktualisiert", inv.input, readPayload(invocation.body));
}

// ---------------------------------------------------------------------------
// Definitionen
// ---------------------------------------------------------------------------

/**
 * Baut die drei `cal.*`-Definitionen mit der Brücke in den Handlern geschlossen.
 * `runtime/loop/api.ts` registriert sie im Katalog neben `fs.*`/`web.*`/`mail.*`, wenn
 * `config.n8n.cal` gesetzt ist; Tests bauen sich einen eigenen Katalog mit injizierter
 * Brücke.
 *
 * `cal.list` ist `read` (Abschnitt 10: `cal.list` steht dort ausdrücklich unter "Lesen"),
 * `cal.create`/`cal.update` sind `hard_write` (Session-Auftrag). Kein `execution`-Feld: jedes
 * hat einen externen Seiteneffekt (n8n-Aufruf) und läuft durch die Ausführungshülle.
 */
export function createCalTools(deps: CalToolDeps): ToolDefinition[] {
  return [
    {
      name: "cal.list",
      description:
        "Listet Kalender-Termine in einem Zeitbereich. Ohne start/end wird die laufende Woche (Montag–Montag) genommen. In den Kontext geht eine knappe Terminliste; die vollständige Liste mit allen Feldern liegt als Artefakt-Handle bei.",
      risk: "read",
      repeatable: true,
      inputSchema: {
        fields: {
          start: {
            type: "string",
            required: false,
            description:
              "Beginn des Bereichs als ISO-8601-Zeitpunkt. Vorgabe: Montag dieser Woche.",
          },
          end: {
            type: "string",
            required: false,
            description:
              "Ende des Bereichs als ISO-8601-Zeitpunkt. Vorgabe: sieben Tage nach start.",
          },
          calendar: {
            type: "string",
            required: false,
            description: "Nur dieser Kalender (Name oder id). Vorgabe: alle.",
          },
          limit: {
            type: "number",
            required: false,
            description: "Höchstzahl der beim Workflow angefragten Termine.",
          },
        },
      },
      handler: (inv) => listHandler(deps, inv),
    },
    {
      name: "cal.create",
      description:
        "Legt einen Kalender-Termin an. Hartes Schreiben: der Aufruf pausiert für eine Freigabe, bevor der Termin entsteht.",
      risk: "hard_write",
      repeatable: false,
      inputSchema: {
        fields: {
          title: { type: "string", required: true, description: "Titel des Termins." },
          start: {
            type: "string",
            required: true,
            description: "Beginn als ISO-8601-Zeitpunkt (für Ganztags das Datum).",
          },
          end: {
            type: "string",
            required: true,
            description: "Ende als ISO-8601-Zeitpunkt.",
          },
          location: { type: "string", required: false, description: "Ort des Termins." },
          description: { type: "string", required: false, description: "Beschreibung / Notiz." },
          calendar: {
            type: "string",
            required: false,
            description: "Zielkalender (Name oder id). Vorgabe: der Standardkalender.",
          },
          attendees: {
            type: "string",
            required: false,
            description: "Teilnehmer-Adressen, kommagetrennt.",
          },
        },
      },
      handler: (inv) => createHandler(deps, inv),
    },
    {
      name: "cal.update",
      description:
        "Ändert einen bestehenden Kalender-Termin über seine event_id. Mindestens ein zu änderndes Feld angeben. Hartes Schreiben: der Aufruf pausiert für eine Freigabe.",
      risk: "hard_write",
      repeatable: false,
      inputSchema: {
        fields: {
          event_id: {
            type: "string",
            required: true,
            description: "id des Termins aus einem cal.list-Eintrag.",
          },
          title: { type: "string", required: false, description: "Neuer Titel." },
          start: { type: "string", required: false, description: "Neuer Beginn (ISO 8601)." },
          end: { type: "string", required: false, description: "Neues Ende (ISO 8601)." },
          location: { type: "string", required: false, description: "Neuer Ort." },
          description: { type: "string", required: false, description: "Neue Beschreibung." },
          calendar: {
            type: "string",
            required: false,
            description: "Termin in diesen Kalender verschieben.",
          },
        },
      },
      handler: (inv) => updateHandler(deps, inv),
    },
  ];
}
