import type { EventRecord } from "../runtime/events/log.js";
import type {
  ModelMessage,
  ModelRequest,
  ModelSystemBlock,
  ModelToolSpec,
} from "../runtime/model/types.js";
import { redactText } from "../runtime/redaction/redact.js";
import type { JsonValue } from "../runtime/steps/types.js";
import type { SkillCatalog } from "../tools/skill/catalog.js";
import type { ToolCatalog, ToolInputSchema } from "../tools/types.js";

/**
 * Der Prompt in der Form, in der die Messages-API ihn entgegennimmt — mit **ausdrücklich
 * gesetzten Cache-Haltepunkten** (S12, Abschnitt 7).
 *
 * ## Die sechs Abschnitte und die drei Sendeplätze
 *
 * Der Sessionauftrag nennt sechs Teile in bindender Reihenfolge; die API kennt drei Plätze
 * (`tools`, `system`, `messages`) und rendert sie in genau dieser Folge. Die Zuordnung:
 *
 *   | # | Abschnitt                        | Platz      |
 *   |---|----------------------------------|------------|
 *   | 2 | Tool-Stubs                       | `tools`    |
 *   | 1 | Statischer System-Prompt         | `system[0]`|
 *   | 3 | Konventionen aus AGENTS.md       | `system[1]`|
 *   | 4 | Sessionzustand                   | `messages` |
 *   | 5 | Nachrichten und Tool-Ergebnisse  | `messages` |
 *   | 6 | Aktuelle Eingabe                 | `messages` |
 *
 * Dass die Stubs damit **vor** dem System-Prompt liegen, ist keine Umsortierung des
 * Auftrags, sondern seine Umsetzung: Abschnitt 7 sagt wörtlich "Die Cache-Hierarchie läuft
 * von Tools über System-Prompt zu Nachrichten". Die Liste im Auftrag ordnet die Inhalte, die
 * Hierarchie ordnet die Bytes; wo beide sich berühren, gewinnt die Hierarchie, denn sie ist
 * die Aussage über den Cache. Innerhalb jedes Platzes bleibt die Reihenfolge des Auftrags.
 *
 * ## Drei Haltepunkte, und warum genau dort
 *
 *   1. **hinter dem letzten Tool** — friert den Katalog ein. Er ändert sich in einer Session
 *      nie (S07), also ist das der stabilste Präfix, den es gibt.
 *   2. **hinter dem letzten System-Block** — friert System-Prompt und Konventionen ein. Beide
 *      werden einmal beim Start gelesen und danach nicht mehr angefasst.
 *   3. **hinter der letzten Nachricht** — die Historie ist append-only (Grundprinzip 2), also
 *      ist alles bis hierher beim nächsten Zug unverändert und wird gelesen statt neu
 *      geschrieben.
 *
 * Der vierte mögliche Haltepunkt bleibt frei. Ihn zu setzen hieße, eine zweite Stelle in der
 * Historie zu markieren, und die läge bei einer wachsenden Historie immer an der falschen:
 * jeder Zug schöbe sie weiter, und jede Verschiebung ist genau die Cache-Entwertung, die zu
 * vermeiden der Zweck der Übung ist.
 *
 * ## Der Filter
 *
 * Alles, was **diese Datei** an Text beisteuert — System-Prompt, Konventionen, Tool-Namen und
 * -Beschreibungen —, läuft durch `redact`. Die Nachrichten laufen **nicht** noch einmal
 * durch: sie stammen ausschließlich aus `readEvents` und sind damit schon am Schreibtor des
 * Protokolls gefiltert (S03). Das ist keine Nachlässigkeit, sondern notwendig — ein zweiter
 * Durchlauf könnte die Signatur eines Denkblocks verändern, und der Anbieter lehnt eine
 * veränderte Signatur ab. Die Zusage "kein ungefilterter Text erreicht den Prompt" hängt
 * deshalb an der Bauart von `deriveTranscript`: es nimmt Ereignisse entgegen und sonst nichts.
 */

/** Der API-Name eines Tools verletzt die Namensform des Anbieters. */
export class ToolNameEncodingError extends Error {}

/**
 * Die API erlaubt in Toolnamen `[a-zA-Z0-9_-]` — **keinen Punkt**. Unsere Namenskonvention
 * ist aber `namensraum.aktion` (Abschnitt 4.8), und die ist nicht verhandelbar: sie steht in
 * AGENTS.md, im Protokoll, in den Regeln der Policy und in jedem bisherigen Test.
 *
 * Also wird übersetzt, und zwar an genau einer Stelle. `fs.read` wird zu `fs__read`. Die
 * Rückübersetzung ist eindeutig, weil ein Namensraum nach Abschnitt 4.8 nur Buchstaben
 * enthält: das erste `__` ist damit immer der Trenner, auch wenn eine Aktion selbst einen
 * doppelten Unterstrich trüge.
 */
export const API_NAME_SEPARATOR = "__";

const API_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

export function encodeToolName(name: string): string {
  const encoded = name.replace(".", API_NAME_SEPARATOR);
  if (!API_NAME_PATTERN.test(encoded)) {
    throw new ToolNameEncodingError(
      `Toolname "${name}" ergibt den API-Namen "${encoded}", der die Namensform des Anbieters ([a-zA-Z0-9_-], höchstens 128 Zeichen) verletzt.`,
    );
  }
  return encoded;
}

/**
 * Die Rückübersetzung, gebaut aus dem Katalog statt geraten. Ein Name, den der Katalog nicht
 * kennt, kommt hier gar nicht erst an — der Router weist ihn ohnehin ab (S07) —, aber die
 * Karte macht aus "vermutlich `fs.read`" ein "genau dieses registrierte Tool".
 */
export function toolNameDecoder(catalog: ToolCatalog): (apiName: string) => string {
  const byApiName = new Map<string, string>();
  for (const tool of catalog.tools) {
    const apiName = encodeToolName(tool.name);
    const clash = byApiName.get(apiName);
    if (clash) {
      // Kann mit der heutigen Namenskonvention nicht auftreten. Die Prüfung steht trotzdem
      // da: sie kostet nichts und fällt an dem Tag, an dem ein Namensraum einen Unterstrich
      // bekommt — sonst zeigten zwei Katalogeinträge auf denselben API-Namen, und das Modell
      // riefe eines von beiden auf, ohne dass jemand sagen könnte welches.
      throw new ToolNameEncodingError(
        `Die Tools "${clash}" und "${tool.name}" ergeben denselben API-Namen "${apiName}".`,
      );
    }
    byApiName.set(apiName, tool.name);
  }
  return (apiName: string) => byApiName.get(apiName) ?? apiName;
}

/**
 * Unser winziges Schema (S07) in JSON Schema. `additionalProperties: false` und die
 * `required`-Liste sind nicht Zierrat, sondern die Bedingung für `strict: true` beim Anbieter
 * — und sie geben exakt das wieder, was `validateToolInput` ohnehin durchsetzt: bekannte
 * Felder, Pflichtfelder vorhanden, nichts darüber hinaus.
 */
function toJsonSchema(schema: ToolInputSchema): ModelToolSpec["inputSchema"] {
  const properties: Record<string, JsonValue> = {};
  const required: string[] = [];

  // Nach Namen sortiert. Eine Serialisierung, die an der Reihenfolge des Literals hinge,
  // bräche den Cache bei jeder harmlosen Umsortierung im Quelltext (Abschnitt 7).
  for (const name of Object.keys(schema.fields).sort()) {
    const field = schema.fields[name];
    properties[name] = {
      type: field.type,
      description: redactText(field.description),
    };
    if (field.required) required.push(name);
  }

  return { type: "object", properties, required, additionalProperties: false };
}

const NO_LOADED_TOOLS: ReadonlySet<string> = new Set();

/**
 * Der Katalog als Tool-Liste der API. Nach Namen sortiert, Haltepunkt hinter dem letzten.
 *
 * **Verzögertes Tool-Laden (S18b, Abschnitt 9).** Ein Tool mit `deferred: true` steht hier nur,
 * wenn sein Name in `loadedTools` steht — sonst sieht der Anbieter sein Schema gar nicht, und
 * das Modell kann keinen nativen Aufruf dafür bauen. Es fehlt dem Modell trotzdem nicht ganz:
 * `buildModelRequest` legt Name und Kurzbeschreibung jedes noch nicht geladenen Tools in den
 * `<deferred_tools>`-Block neben die Konventionen, und `tool.load` (`tools/tool/tools.ts`) holt
 * das volle Schema nach — `deriveLoadedToolNames` liest zurück, welche Namen das schon betrifft.
 *
 * `loadedTools` wächst über eine Session nur (dieselbe Idempotenz wie bei `context.compacted`),
 * und ein neu geladenes Tool landet an seiner **alphabetischen** Stelle wie jedes andere — die
 * Liste bleibt so einfach herleitbar wie zuvor. Das kostet den Cache-Haltepunkt hinter dem
 * letzten Tool genau in dem einen Zug, in dem ein Tool neu dazukommt (Abschnitt 7); danach ist
 * die Liste wieder byteweise stabil, bis das nächste Tool geladen wird — ein seltenes Ereignis,
 * kein Preis, der bei jedem Zug anfiele.
 */
export function toolSpecs(
  catalog: ToolCatalog,
  loadedTools: ReadonlySet<string> = NO_LOADED_TOOLS,
): ModelToolSpec[] {
  const specs = catalog.tools
    .filter((tool) => tool.deferred !== true || loadedTools.has(tool.name))
    .map((tool) => ({
      name: encodeToolName(tool.name),
      description: redactText(tool.description),
      inputSchema: toJsonSchema(tool.inputSchema),
      cache: false,
    }));
  const last = specs.at(-1);
  if (last) last.cache = true;
  return specs;
}

/**
 * Kurzbeschreibung jedes noch nicht geladenen `deferred`-Tools, als Text neben die Konventionen
 * (S18b). Leer, wenn keines übrig ist — dann bleibt der Block ganz weg, statt eine leere Hülle
 * bei jedem Zug mitzuschleppen (dieselbe Zurückhaltung wie beim `<memory>`-Block in
 * `context/transcript.ts`, aus demselben Grund: eine Zeile, die nie etwas aussagt, ist keine
 * Zeile wert).
 */
function renderDeferredStubs(catalog: ToolCatalog, loadedTools: ReadonlySet<string>): string {
  const stubs = catalog.tools.filter(
    (tool) => tool.deferred === true && !loadedTools.has(tool.name),
  );
  if (stubs.length === 0) return "";

  const lines = stubs.map((tool) => `- ${tool.name}: ${redactText(tool.description)}`).join("\n");
  return [
    "",
    "",
    "<deferred_tools>",
    "Weitere Tools existieren, aber ihr volles Eingabeschema ist noch nicht geladen — sie stehen",
    "deshalb nicht in der Werkzeugliste oben. Ruf tool.load mit den passenden Namen auf, um eines",
    "nutzbar zu machen; danach ist es wie jedes andere Tool aufrufbar.",
    "",
    lines,
    "</deferred_tools>",
  ].join("\n");
}

/**
 * Kurzliste aller Skills, als Text neben die Konventionen (S18c) — Titel und Beschreibung, wie
 * beim `<deferred_tools>`-Block, ergänzt um die Auslösebedingung (`wann`): ohne sie wäre die
 * Liste eine Inhaltsangabe, aber keine Grundlage dafür, *wann* das Modell `skill.load` ziehen
 * sollte. Leer, wenn kein Skill konfiguriert ist oder `skills/` keinen trägt — dann bleibt der
 * Block ganz weg, dieselbe Zurückhaltung wie beim `<memory>`-Block und bei `<deferred_tools>`.
 *
 * Anders als `renderDeferredStubs` schrumpft diese Liste **nicht**, wenn ein Skill geladen
 * wurde: ein geladener Skill kann in einem späteren Zug erneut gebraucht werden (seine volle
 * Anleitung steht dann zwar schon einmal weiter oben in der Historie, aber sie dort
 * wiederzufinden ist teurer, als sie noch einmal zu laden), und anders als bei einem Tool-
 * Schema gibt es hier keine zweite, native Repräsentation, die den Kurzeintrag ersetzen könnte.
 */
function renderSkillStubs(catalog: SkillCatalog | undefined): string {
  if (!catalog || catalog.skills.length === 0) return "";

  const lines = catalog.skills
    .map(
      (skill) =>
        `- ${skill.name}: ${redactText(skill.description)} — wann: ${redactText(skill.when)}`,
    )
    .join("\n");
  return [
    "",
    "",
    "<skills>",
    "Weitere Fähigkeiten stehen als Skills bereit, hier nur mit Kurzbeschreibung. Ruf skill.load",
    "mit dem passenden Namen auf, um die vollständige Anleitung zu lesen — erst danach, nicht",
    "blind, danach handeln. Auch ein eigener Skill kann veraltet oder falsch sein.",
    "",
    lines,
    "</skills>",
  ].join("\n");
}

/**
 * Welche `deferred`-Tools diese Session schon nachgeladen hat — zurückgelesen aus dem
 * Protokoll, nicht aus einem Zustand im Prozess (dieselbe Bauart wie `collectStage2Map` in
 * `context/compaction.ts`). `tool.load` ist ein `execution: "runtime"`-Tool (wie `task.set`);
 * seine volle Ergebnishülle steht deshalb im `result`-Feld seines `tool.completed` (S10/S07).
 */
export function deriveLoadedToolNames(events: readonly EventRecord[]): Set<string> {
  const loaded = new Set<string>();
  for (const event of events) {
    if (event.type !== "tool.completed" || event.payload.tool_name !== "tool.load") continue;
    const result = event.payload.result;
    if (typeof result !== "object" || result === null) continue;
    const structured = (result as Record<string, unknown>).structured;
    if (typeof structured !== "object" || structured === null) continue;
    const names = (structured as Record<string, unknown>).loaded;
    if (!Array.isArray(names)) continue;
    for (const name of names) if (typeof name === "string") loaded.add(name);
  }
  return loaded;
}

export interface ModelRequestInput {
  /** Abschnitt 1 des Auftrags: der statische System-Prompt. */
  systemPrompt: string;
  /** Abschnitt 3: die Konventionen aus AGENTS.md, einmal beim Start gelesen. */
  conventions: string;
  catalog: ToolCatalog;
  /** Abschnitte 4 bis 6, vollständig aus dem Protokoll gefaltet. */
  messages: ModelMessage[];
  maxTokens: number;
  signal?: AbortSignal;
  /** Namen bereits nachgeladener `deferred`-Tools (S18b). Vorgabe: keine. */
  loadedTools?: ReadonlySet<string>;
  /** Der Skill-Katalog (S18c), für die Kurzliste neben den Konventionen. Vorgabe: keiner. */
  skills?: SkillCatalog;
}

/** Zusammenzählung der gesetzten Haltepunkte. Geht als Kennzahl ins `model.requested`. */
export function countCacheBreakpoints(request: ModelRequest): number {
  return (
    request.tools.filter((tool) => tool.cache).length +
    request.system.filter((block) => block.cache).length +
    request.messages.filter((message) => message.cache).length
  );
}

export function buildModelRequest(input: ModelRequestInput): ModelRequest {
  const loadedTools = input.loadedTools ?? NO_LOADED_TOOLS;
  const system: ModelSystemBlock[] = [
    { text: redactText(input.systemPrompt) },
    {
      // Der `<deferred_tools>`-Block (S18b) hängt an dieselbe Nachricht wie die Konventionen,
      // statt einen vierten Eintrag zu eröffnen: beide ändern sich nur selten (Konventionen bei
      // einer AGENTS.md-Bearbeitung, der Block bei einem neu geladenen Tool), beide tragen den
      // einen Cache-Haltepunkt des System-Abschnitts, und ein zusätzlicher Eintrag hätte an
      // jeder bestehenden Prüfung der Reihenfolge (Abschnitt 7) etwas verschoben, ohne dass sich
      // am Cache-Verhalten etwas geändert hätte. Der `<skills>`-Block (S18c) hängt aus demselben
      // Grund daneben: er ändert sich nur, wenn `skills/` sich ändert — nicht öfter als AGENTS.md.
      text:
        redactText(input.conventions) +
        renderDeferredStubs(input.catalog, loadedTools) +
        renderSkillStubs(input.skills),
      cache: true,
    },
  ];

  const messages = input.messages.map((message, index) => ({
    ...message,
    cache: index === input.messages.length - 1,
  }));

  return {
    system,
    tools: toolSpecs(input.catalog, loadedTools),
    messages,
    maxTokens: input.maxTokens,
    signal: input.signal,
  };
}
