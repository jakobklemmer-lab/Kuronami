import type {
  ModelMessage,
  ModelRequest,
  ModelSystemBlock,
  ModelToolSpec,
} from "../runtime/model/types.js";
import { redactText } from "../runtime/redaction/redact.js";
import type { JsonValue } from "../runtime/steps/types.js";
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

/** Der Katalog als Tool-Liste der API. Nach Namen sortiert, Haltepunkt hinter dem letzten. */
export function toolSpecs(catalog: ToolCatalog): ModelToolSpec[] {
  const specs = catalog.tools.map((tool) => ({
    name: encodeToolName(tool.name),
    description: redactText(tool.description),
    inputSchema: toJsonSchema(tool.inputSchema),
    cache: false,
  }));
  const last = specs.at(-1);
  if (last) last.cache = true;
  return specs;
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
  const system: ModelSystemBlock[] = [
    { text: redactText(input.systemPrompt) },
    { text: redactText(input.conventions), cache: true },
  ];

  const messages = input.messages.map((message, index) => ({
    ...message,
    cache: index === input.messages.length - 1,
  }));

  return {
    system,
    tools: toolSpecs(input.catalog),
    messages,
    maxTokens: input.maxTokens,
    signal: input.signal,
  };
}
