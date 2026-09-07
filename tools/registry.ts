import { createHash } from "node:crypto";
import type { JsonValue } from "../runtime/steps/types.js";
import {
  TOOL_NAMESPACES,
  type ToolCatalog,
  type ToolDefinition,
  type ToolInputSchema,
  type ToolStub,
} from "./types.js";

/** Der Name verletzt `namensraum.aktion` oder nennt einen nicht erlaubten Namensraum. */
export class ToolNameError extends Error {}
/** Zwei Tools unter demselben Namen. */
export class DuplicateToolError extends Error {}

/**
 * Präfix der Katalogversion. Der Rest ist ein Fingerabdruck über den Inhalt; bliebe die
 * Version von Hand gepflegt, wäre "eingefroren" eine Hoffnung darauf, dass jemand sie beim
 * Ändern hochzählt. Der Präfix bleibt, damit ein späterer Wechsel des Fingerabdruck-
 * verfahrens selbst unterscheidbar wird.
 */
export const CATALOG_VERSION_PREFIX = "v1";

const TOOL_NAME_PATTERN = /^([a-z]+)\.([a-z][a-z0-9_]*)$/;

/**
 * Prüft den Namen an der Grenze, so wie `assertEventType` die Ereignisnamen prüft (S03).
 * Der Katalog ist die Liste, die das Modell zu sehen bekommt; eine zweite Schreibweise
 * desselben Tools wäre dort teurer als im Protokoll, weil das Modell sie nachahmt.
 */
export function assertToolName(name: string): void {
  const match = TOOL_NAME_PATTERN.exec(name);
  if (!match) {
    throw new ToolNameError(
      `Ungültiger Toolname "${name}": erwartet wird namensraum.aktion, kleingeschrieben, ein Punkt als Trenner`,
    );
  }
  const namespace = match[1];
  if (!(TOOL_NAMESPACES as readonly string[]).includes(namespace)) {
    throw new ToolNameError(
      `Namensraum "${namespace}" ist nicht erlaubt (${TOOL_NAMESPACES.join(", ")}). Ein neuer Namensraum braucht eine Begründung in docs/.`,
    );
  }
}

/**
 * Kanonische Fassung eines Schemas: Felder nach Namen sortiert, jedes Feld mit ausdrücklich
 * aufgezählten Eigenschaften. Ein Spread (`{ name, ...field }`) übernähme die
 * Einfügereihenfolge des Literals, und zwei inhaltsgleiche Schemata bekämen je nach
 * Schreibweise verschiedene Fingerabdrücke.
 */
function canonicalSchema(schema: ToolInputSchema): JsonValue {
  return Object.keys(schema.fields)
    .sort()
    .map((name) => {
      const field = schema.fields[name];
      return {
        name,
        type: field.type,
        required: field.required,
        description: field.description,
      };
    });
}

/**
 * Der Fingerabdruck läuft über genau das, was das Modell sieht und wonach es seine Aufrufe
 * baut: Name, Beschreibung, Eingabeschema, Risikostufe, Wiederholbarkeit. Der Handler bleibt
 * draußen — er ist nicht serialisierbar, und eine Fehlerbehebung in seinem Rumpf soll keine
 * laufende Session ungültig machen. Ändert sich dagegen der Vertrag, ändert sich die
 * Version, und der Router weist die Session ab, statt ihr klammheimlich andere Tools
 * unterzuschieben.
 */
export function fingerprintTools(tools: readonly ToolDefinition[]): string {
  const canonical = JSON.stringify(
    [...tools]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        risk: tool.risk,
        repeatable: tool.repeatable,
        input_schema: canonicalSchema(tool.inputSchema),
      })),
  );
  return `${CATALOG_VERSION_PREFIX}-${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
}

/**
 * Sammelt Tools und gibt sie als eingefrorenen Katalog heraus.
 *
 * Die Trennung zwischen Registry (veränderlich, beim Hochfahren) und Katalog (unveränderlich,
 * für die Session) steht im Typ und nicht nur im Kommentar: `ToolCatalog` hat keine
 * schreibende Methode, `freeze()` kopiert die Liste. Wer danach noch registriert, ändert die
 * Registry und nicht den bereits ausgegebenen Katalog.
 */
export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition>();

  register(definition: ToolDefinition): this {
    assertToolName(definition.name);
    if (this.#tools.has(definition.name)) {
      throw new DuplicateToolError(`Tool "${definition.name}" ist bereits registriert`);
    }
    if (typeof definition.description !== "string" || definition.description.trim() === "") {
      throw new ToolNameError(
        `Tool "${definition.name}" hat keine Beschreibung; sie ist der Teil des Katalogs, an dem das Modell die Auswahl trifft`,
      );
    }
    this.#tools.set(definition.name, definition);
    return this;
  }

  registerAll(definitions: readonly ToolDefinition[]): this {
    for (const definition of definitions) this.register(definition);
    return this;
  }

  freeze(): ToolCatalog {
    const tools = [...this.#tools.values()].sort((a, b) => a.name.localeCompare(b.name));
    const version = fingerprintTools(tools);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    return {
      version,
      tools,
      get: (name: string) => byName.get(name),
      stubs: (): ToolStub[] =>
        tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          risk: tool.risk,
        })),
    };
  }
}
