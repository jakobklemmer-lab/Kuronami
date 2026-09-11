import type { JsonValue } from "../../runtime/steps/types.js";
import type { ToolCatalog, ToolDefinition, ToolInvocation, ToolOutput } from "../types.js";

/**
 * `tool.load` — der Gegenpart zum verzögerten Tool-Laden (S18b, Abschnitt 9). Ein `deferred`-
 * Tool steht mit voller Kurzbeschreibung im `<deferred_tools>`-Block (`context/request.ts`),
 * aber ohne Eingabeschema in der Werkzeugliste der Anfrage — das Modell kann für ein solches
 * Tool keinen nativen Aufruf bauen, bevor es hier war.
 *
 * `tool.load` selbst ist **immer** Teil der vollen Werkzeugliste (nie `deferred`): ohne einen
 * festen, von Anfang an sichtbaren Weg, ein Tool nachzuladen, gäbe es keinen Ausweg aus dem
 * `<deferred_tools>`-Block. Es ist `execution: "runtime"` wie `task.set`/`user.ask` (S10): reine
 * Nachschlage-Operation auf dem eingefrorenen Katalog, kein externer Seiteneffekt, kein Schritt.
 *
 * Der eigentliche Effekt entsteht **nicht** hier: `tool.load` schreibt nur `structured.loaded`
 * in sein eigenes `tool.completed` (über den Router, wie jedes Runtime-Tool, S07/S10). Beim
 * nächsten Modellaufruf liest `deriveLoadedToolNames` (`context/request.ts`) das zurück und legt
 * das volle Schema in die Werkzeugliste — derselbe "wiederanwenden statt wiederholen"-Grundsatz
 * wie bei Kontextstufe 2 und 3 (S18a): ein zweiter Aufruf mit denselben Namen liefert dieselbe
 * Auskunft, verdoppelt aber nichts.
 */

export class ToolLoadInputError extends Error {}

function schemaOf(tool: ToolDefinition): JsonValue {
  const fields: Record<string, JsonValue> = {};
  for (const [name, field] of Object.entries(tool.inputSchema.fields)) {
    fields[name] = { type: field.type, required: field.required, description: field.description };
  }
  return { description: tool.description, risk: tool.risk, repeatable: tool.repeatable, fields };
}

async function loadHandler(catalog: ToolCatalog, inv: ToolInvocation): Promise<ToolOutput> {
  const raw = inv.input.names;
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((entry) => typeof entry !== "string")) {
    throw new ToolLoadInputError("names muss eine nicht leere Liste von Toolnamen sein");
  }
  const names = raw as string[];

  const loaded: string[] = [];
  const notFound: string[] = [];
  const schemas: Record<string, JsonValue> = {};

  for (const name of names) {
    const tool = catalog.get(name);
    if (!tool) {
      notFound.push(name);
      continue;
    }
    loaded.push(name);
    schemas[name] = schemaOf(tool);
  }

  const summary =
    notFound.length === 0
      ? `${loaded.length} Tool(e) geladen: ${loaded.join(", ")}`
      : `${loaded.length} Tool(e) geladen (${loaded.join(", ") || "keins"}), unbekannt: ${notFound.join(", ")}`;

  return {
    summary,
    structured: { loaded, not_found: notFound, schemas },
  };
}

export interface ToolIntrospectionDeps {
  /**
   * Der Katalog **ohne** `tool.load` selbst — dieselbe zweistufige Einfrierung wie beim
   * verzögerten Tool-Laden insgesamt (`runtime/loop/api.ts`, `buildCatalog`): erst der übrige
   * Katalog, dann `tool.load` darüber, dann erst der endgültige, versionierte Katalog. Ein Tool
   * lädt nie sich selbst nach (es ist ohnehin nie `deferred`), also fehlt hier nichts, was ein
   * Aufrufer je bräuchte.
   */
  catalog: ToolCatalog;
}

export function createToolIntrospectionTools(deps: ToolIntrospectionDeps): ToolDefinition[] {
  return [
    {
      name: "tool.load",
      description:
        "Lädt das vollständige Eingabeschema eines oder mehrerer Tools, die bisher nur mit " +
        "Kurzbeschreibung im <deferred_tools>-Block stehen. Danach ist jedes davon wie jedes " +
        "andere Tool aufrufbar. Ein bereits geladenes oder ohnehin nicht verzögertes Tool " +
        "erneut zu laden ist folgenlos.",
      risk: "read",
      repeatable: true,
      execution: "runtime",
      inputSchema: {
        fields: {
          names: {
            type: "array",
            required: true,
            description: "Toolnamen aus dem <deferred_tools>-Block (namensraum.aktion).",
          },
        },
      },
      handler: (inv) => loadHandler(deps.catalog, inv),
    },
  ];
}
