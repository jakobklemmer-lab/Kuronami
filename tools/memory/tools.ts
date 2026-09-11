import type { Pool } from "pg";
import { appendEvent } from "../../runtime/events/log.js";
import type { JsonValue } from "../../runtime/steps/types.js";
import type { ToolDefinition, ToolInvocation, ToolOutput } from "../types.js";
import { DEFAULT_SEARCH_LIMIT, type MemoryStore, NOTE_KINDS, type NoteKind } from "./store.js";

/**
 * Die zwei Werkzeuge des Langzeitgedächtnisses (S18): **suchen** und **schreiben**.
 *
 * ## Abweichung vom Auftragswortlaut: `memory.*` statt `notes.*`
 *
 * Der Sessionauftrag nennt sie `notes.search` und `notes.write`. Diese Namen sind seit S15
 * vergeben: `notes.read`/`notes.write` greifen direkt auf den **Obsidian-Vault** des Nutzers
 * zu (`tools/notes/`). Die drei denkbaren Auflösungen und warum diese gewählt wurde:
 *
 *   * **`notes.write` überladen** — ein Aufruf mit `note` schriebe in den Vault, einer mit
 *     `tags` ins Gedächtnis. Ein Tool mit zwei Zielen, zwei Risikostufen und zwei Zonen; das
 *     Modell entschiede über den Speicherort, indem es ein Feld weglässt. Das ist die Art
 *     stiller Falle, gegen die dieses Projekt an jeder anderen Stelle baut.
 *   * **Nur `notes.search` bauen** — dann zeigte `search` auf `memory/` und `read` daneben auf
 *     den Vault. Ein Namensraum, dessen Verben verschiedene Korpora meinen, ist schlimmer als
 *     zwei Namensräume.
 *   * **Die Obsidian-Tools umbenennen** — kostet dieselbe Namensraum-Erweiterung *plus* eine
 *     Umbenennung ausgelieferter, getesteter Tools und einen neuen Katalog-Fingerabdruck.
 *
 * Also ein eigener Namensraum, wie ihn S17 bereits vorgezeichnet hat („kommt der Namespace,
 * ist die zusätzliche Regel eine Zeile"). Der sachliche Unterschied trägt ihn: der Vault
 * gehört dem **Menschen** und der Assistent schreibt nur mit Freigabe hinein; `memory/` ist das
 * Gedächtnis des **Assistenten**, das er selbst führt. Begründung in `docs/GEDAECHTNIS.md`,
 * wie AGENTS.md es für einen neuen Namensraum verlangt.
 *
 * ## Die Risikostufen
 *
 * `memory.search` ist `read`. `memory.write` ist **`soft_write`** und pausiert damit nicht —
 * anders als `notes.write` (`hard_write`, S15), und das ist kein Widerspruch, sondern der
 * Unterschied zwischen den beiden Ablagen: das Gedächtnis ist die eigene Ablage dieses Systems,
 * sie liegt in einem Git-Repo (jede Änderung ist rückholbar), und ein Assistent, der für jede
 * Notiz nachfragen muss, führt kein Gedächtnis — er führt ein Formular. Abschnitt 10 führt
 * „Notizen schreiben" ohnehin unter weichem Schreiben.
 *
 * Wo die Grenze **doch** hart ist: im Hintergrundlauf. `BACKGROUND_RULES` verbietet
 * `memory.write` (S17), und zwar als `deny` und nicht als `ask`. Ein proaktiver Lauf ohne
 * Menschen am anderen Ende darf das Gedächtnis nicht selbst füllen.
 *
 * ## Kein `path`-Feld, und das ist Absicht
 *
 * Der Aufrufer sagt **nicht**, wohin geschrieben wird — der Dateiname folgt aus Datum und
 * Titel (`store.ts`). Damit kann `memory.write` strukturell nur ins Gedächtnis schreiben, und
 * die Policy-Engine ordnet den Aufruf als Ressource `none` ein statt ihn über den `fs`-Resolver
 * zu schicken, der `memory/` als Quellzone sähe und auf `hard_write` anhöbe (dieselbe
 * Überlegung wie beim Feld `note` in S15).
 */

export interface MemoryToolDeps {
  store: MemoryStore;
  /**
   * Für `memory.conflicted`. Ein Widerspruch ist eine eigene Aussage und keine Eigenschaft
   * eines geglückten Schreibvorgangs — dieselbe Überlegung wie bei `policy.secret_accessed`
   * (S11): „wann hat sich das Gedächtnis widersprochen" muss beantwortbar sein, ohne einen
   * Filter über die Payloads aller `tool.completed` zu legen.
   */
  pool: Pool;
}

/** So viele Treffer gibt `memory.search` höchstens zurück. */
export const SEARCH_MAX_LIMIT = 20;
/** So viel Text je Treffer bleibt im Kontext. */
export const SEARCH_EXCERPT_CHARS = 400;

function asStringArray(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

// ---------------------------------------------------------------------------
// memory.search
// ---------------------------------------------------------------------------

async function searchHandler(deps: MemoryToolDeps, inv: ToolInvocation): Promise<ToolOutput> {
  const query = typeof inv.input.query === "string" ? inv.input.query.trim() : "";
  if (query === "") {
    throw new Error('memory.search: Pflichtfeld "query" fehlt oder ist leer.');
  }
  const requested = typeof inv.input.limit === "number" ? Math.trunc(inv.input.limit) : undefined;
  const limit = Math.max(1, Math.min(requested ?? DEFAULT_SEARCH_LIMIT, SEARCH_MAX_LIMIT));

  const hits = deps.store.search(query, limit);
  const total = deps.store.count();

  const rows = hits.map((hit) => ({
    id: hit.note.id,
    datum: hit.note.date,
    titel: hit.note.title,
    art: hit.note.kind,
    tags: hit.note.tags,
    // Der Rang steht im Ergebnis, damit ein knapper Treffer als knapper Treffer erkennbar ist.
    rang: Math.round(hit.score * 1000) / 1000,
    ausschnitt: hit.snippet,
    text: hit.note.body.slice(0, SEARCH_EXCERPT_CHARS),
    text_gekuerzt: hit.note.body.length > SEARCH_EXCERPT_CHARS,
    // Widersprüche stehen an jedem Treffer, nicht nur im Recall: wer gezielt sucht, muss
    // genauso erfahren, dass es eine neuere Gegennotiz gibt.
    ersetzt: hit.note.supersedes,
    ersetzt_durch: hit.note.supersededBy,
  }));

  const contested = rows.filter((row) => row.ersetzt_durch.length > 0).length;
  const summary =
    hits.length === 0
      ? `Keine Notiz zu „${query}“ (${total} im Gedächtnis). Das Gedächtnis weiß dazu nichts — das ist eine Auskunft, kein Fehler.`
      : `${hits.length} von ${total} Notizen passen zu „${query}“${
          contested > 0 ? `, davon ${contested} von einer neueren Notiz bestritten` : ""
        }.`;

  return {
    summary,
    structured: { query, gefunden: hits.length, gesamt: total, treffer: rows as JsonValue },
    preview: rows.slice(0, 3).map((row) => `${row.datum} ${row.titel}`),
    artifact_refs: [],
  };
}

// ---------------------------------------------------------------------------
// memory.write
// ---------------------------------------------------------------------------

async function writeHandler(deps: MemoryToolDeps, inv: ToolInvocation): Promise<ToolOutput> {
  const content = typeof inv.input.content === "string" ? inv.input.content : "";
  const tags = asStringArray(inv.input.tags);
  const kindInput = typeof inv.input.kind === "string" ? inv.input.kind : "erkenntnis";
  const title = typeof inv.input.title === "string" ? inv.input.title : undefined;
  const supersedes = asStringArray(inv.input.supersedes);

  if (!(NOTE_KINDS as readonly string[]).includes(kindInput)) {
    throw new Error(
      `memory.write: kind "${kindInput}" gibt es nicht, erlaubt sind ${NOTE_KINDS.join(" und ")}. Konventionen, Vorlieben und Dauerregeln gehören nicht ins Gedächtnis, sondern in AGENTS.md.`,
    );
  }

  // Eine Kennung, die es nicht gibt, wird abgewiesen statt ignoriert: ein `supersedes` ins
  // Leere sähe im Ergebnis aus wie eine erledigte Korrektur und wäre keine.
  for (const id of supersedes) {
    if (!deps.store.get(id)) {
      throw new Error(
        `memory.write: die zu ersetzende Notiz "${id}" gibt es nicht. Erst mit memory.search die richtige Kennung suchen.`,
      );
    }
  }

  const result = await deps.store.write({
    content,
    tags,
    kind: kindInput as NoteKind,
    title,
    supersedes,
    source: `session ${inv.sessionId} / call ${inv.callId}`,
  });

  // Der Widerspruch ins Protokoll — auch der bloße Verdacht (gleiche Tags, niemand hat etwas
  // dazu gesagt). Genau der ist die Stelle, an der ein Gedächtnis still auseinanderläuft:
  // zwei Notizen zum selben Thema, die einander nicht kennen.
  if (result.superseded.length > 0 || result.related.length > 0) {
    await appendEvent(deps.pool, inv.sessionId, "memory.conflicted", {
      call_id: inv.callId,
      note_id: result.note.id,
      tags: result.note.tags,
      // Ausgesprochen: der Schreiber hat gesagt, dass er diesen Notizen widerspricht.
      supersedes: result.superseded.map((note) => note.id),
      // Vermutet: gleiche Tags, kein ausgesprochener Widerspruch.
      related: result.related.map((note) => note.id),
    });
  }

  const parts = [`Notiz „${result.note.title}“ abgelegt als ${result.note.id}.`];
  if (result.superseded.length > 0) {
    parts.push(
      `Widerspruch vermerkt: ${result.superseded
        .map((note) => `${note.id} (${note.date})`)
        .join(", ")} bleibt bestehen und trägt jetzt einen Verweis hierher.`,
    );
  }
  if (result.related.length > 0) {
    parts.push(
      `Zu denselben Tags gibt es bereits ${result.related.length} ältere Notiz(en): ${result.related
        .map((note) => `${note.id} (${note.date})`)
        .join(
          ", ",
        )}. Wenn eine davon dieser hier widerspricht, sag das mit supersedes — sonst stehen beide unverbunden nebeneinander.`,
    );
  }
  if (result.conventionSmell) {
    parts.push(
      "Hinweis: der Text klingt nach einer Dauerregel oder Vorliebe. Solche gehören nach AGENTS.md, nicht ins Gedächtnis — dort stehen Ereignisse und Erkenntnisse.",
    );
  }
  if (result.git.error) {
    parts.push(`Der Git-Commit ist fehlgeschlagen: ${result.git.error}. Die Notiz liegt trotzdem.`);
  }

  return {
    summary: parts.join(" "),
    structured: {
      id: result.note.id,
      pfad: result.note.path,
      datum: result.note.date,
      titel: result.note.title,
      art: result.note.kind,
      tags: result.note.tags,
      umbenannt: result.renamed,
      ersetzt: result.superseded.map((note) => note.id),
      verwandt: result.related.map((note) => note.id),
      klingt_nach_konvention: result.conventionSmell,
      committet: result.git.committed,
      git_fehler: result.git.error ?? null,
    },
    preview: [result.note.title, `tags: ${result.note.tags.join(", ")}`],
    artifact_refs: [],
  };
}

// ---------------------------------------------------------------------------
// Definitionen
// ---------------------------------------------------------------------------

export function createMemoryTools(deps: MemoryToolDeps): ToolDefinition[] {
  return [
    {
      name: "memory.search",
      description:
        "Durchsucht das Langzeitgedächtnis (Volltext über frühere Notizen: Ereignisse und Erkenntnisse aus vergangenen Läufen). Zu Beginn jedes Zugs wird bereits automatisch gesucht; dieses Werkzeug ist für gezielte Nachfragen mit anderen Suchwörtern. Treffer, denen eine neuere Notiz widerspricht, sind als solche gekennzeichnet.",
      risk: "read",
      repeatable: true,
      // Assistenz-Tool (Abschnitt 9), nicht Kern-Primitiv — verzögertes Laden (S18b). Der
      // automatische Recall vor jedem Zug (`recallForTurn`) läuft direkt auf dem Speicher, nicht
      // über dieses Tool oder den Katalog — er ist davon unberührt.
      deferred: true,
      inputSchema: {
        fields: {
          query: {
            type: "string",
            required: true,
            description:
              "Suchwörter oder eine Frage in natürlicher Sprache. Füllwörter werden entfernt, der Rest mit Präfix gesucht.",
          },
          limit: {
            type: "number",
            required: false,
            description: `Höchstzahl der Treffer (1 bis ${SEARCH_MAX_LIMIT}). Vorgabe ${DEFAULT_SEARCH_LIMIT}.`,
          },
        },
      },
      handler: (inv) => searchHandler(deps, inv),
    },
    {
      name: "memory.write",
      description:
        "Legt eine Notiz im Langzeitgedächtnis ab (Markdown mit Datum und Tags, versioniert in Git). Für Ereignisse und Erkenntnisse, die über den heutigen Lauf hinaus gelten — nicht für Konventionen, Vorlieben oder Dauerregeln, die gehören in die Konventionsdatei. Die meisten Läufe hinterlassen keine Notiz. Bestehende Notizen werden nie überschrieben: widerspricht diese einer älteren, wird das über supersedes vermerkt und beide bleiben stehen.",
      risk: "soft_write",
      // Derselbe Aufruf ein zweites Mal legt dieselbe Datei erneut an (atomarer Rename, kein
      // Zwischenzustand) — die Kennung folgt aus Datum und Titel, ein wiederholter Versuch
      // trifft auf `-2`. Das ist eine sichtbare Doppelung und kein Datenverlust, also
      // wiederholbar (wie fs.write, S08).
      repeatable: true,
      // Assistenz-Tool (Abschnitt 9) — verzögertes Laden (S18b). `summarizeRun` ruft es über
      // `callTool` direkt am Namen auf, nicht über einen Modellaufruf, und ist davon unberührt
      // (`deferred` betrifft nur, was in der an den Anbieter gesendeten Werkzeugliste steht).
      deferred: true,
      inputSchema: {
        fields: {
          content: {
            type: "string",
            required: true,
            description:
              "Der Notiztext als Markdown, ohne Frontmatter. So schreiben, dass er in einem halben Jahr ohne den heutigen Zusammenhang noch verständlich ist: was war der Fall, was folgt daraus.",
          },
          tags: {
            type: "array",
            required: true,
            description:
              'Schlagwörter für das Wiederfinden, kleingeschrieben (z. B. ["kalender", "zeitzone"]). Mindestens eines. Sie wiegen bei der Suche am schwersten.',
          },
          title: {
            type: "string",
            required: false,
            description:
              "Überschrift in einem Satz. Fehlt sie, wird die erste Zeile des Texts genommen.",
          },
          kind: {
            type: "string",
            required: false,
            description: `"erkenntnis" (Vorgabe) oder "ereignis". Für Konventionen gibt es bewusst keinen Wert.`,
          },
          supersedes: {
            type: "array",
            required: false,
            description:
              "Kennungen älterer Notizen, denen diese hier widerspricht. Sie werden nicht gelöscht und nicht geändert, sondern bekommen einen Verweis hierher — beide bleiben lesbar.",
          },
        },
      },
      handler: (inv) => writeHandler(deps, inv),
    },
  ];
}
