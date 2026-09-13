import { assertPolicyFieldNames } from "../../policy/resource.js";
import type { RiskLevel } from "../../policy/risk.js";
import type { JsonValue } from "../../runtime/steps/types.js";
import type {
  ToolDefinition,
  ToolField,
  ToolFieldType,
  ToolInputSchema,
  ToolInvocation,
  ToolOutput,
} from "../types.js";
import { type McpClient, type McpTool, McpToolCallError } from "./client.js";

/**
 * Macht aus fremden MCP-Servern native `ToolDefinition`s (S27) — analog zu
 * `tools/n8n/workflows.ts`s `createN8nTools`, aber mit einem zentralen Unterschied: ein
 * n8n-Workflow ist ein **lokal versioniertes** Schema (`N8nWorkflowDef.inputSchema` steht im
 * Repo); ein MCP-Server **entdeckt** seine Tools dynamisch über `tools/list`. Genau das ist
 * die Angriffsfläche, die S27 absichert ("Eine fremde/manipulierte Tool-Beschreibung ändert
 * das Verhalten der Runtime nachweislich nicht") — und der Grund, warum diese Datei an drei
 * Stellen bewusst **nichts** vom Fernserver übernimmt, das über reine Anzeige hinausgeht:
 *
 *   1. **Risikostufe ist eine lokale, pro Server konfigurierte Obergrenze.** `tools/list`
 *      liefert kein Risikofeld — die Versuchung wäre, sie aus Stichworten in der Beschreibung
 *      zu raten ("liest nur", "sicher"). Das passiert hier nicht: `McpServerConfig.risk` ist
 *      eine Betreiberentscheidung (wie `N8nWorkflowDef.risk`) und gilt unverändert für **jedes**
 *      Tool dieses Servers, gleich was seine Beschreibung behauptet.
 *   2. **Namensraum-Isolation durch Konstruktion.** Der lokale Name ist zwingend
 *      `mcp.<serverId>__<sanitierter Fernname>` — ein Fern-Tool kann keinen bestehenden Namen
 *      (`fs.write`, `web.fetch`, …) vortäuschen, weil `assertToolName`/`TOOL_NAME_PATTERN`
 *      (`tools/registry.ts`) nach dem ersten Punkt keinen zweiten zulässt und der Namensraum
 *      hier immer `mcp` ist.
 *   3. **Einmalige Entdeckung.** `tools/list` wird genau einmal beim Katalogbau abgefragt
 *      (`createMcpTools`, aufgerufen aus `runtime/loop/api.ts`s `buildCatalog`); das Ergebnis
 *      wird zu statischen `ToolDefinition`s, danach ist der Katalog eingefroren wie jeder
 *      andere (Anti-Muster 2: "Toolsatz mitten in der Session umbauen"). Es gibt in diesem
 *      Modul **keine** zweite Methode, die mitten in einer Session erneut entdeckte — ein
 *      "Rug Pull" (Server ändert Beschreibung/Schema nach der ersten Zusage) hat hier
 *      strukturell keinen Angriffspunkt, nicht nur einen versprochenen.
 *
 * Die allgemeinere Aussage — dass eine Anweisung in externem Inhalt nie eine Freigabepflicht
 * aufhebt — ist keine neue Erfindung dieser Datei: sie steht seit Abschnitt 4.7/AGENTS.md
 * ("Fehler nie verstecken", die Policy-Engine als einziges Tor) und in der automatischen
 * Redaction an den Schreibtoren (`runtime/redaction/redact.ts` läuft an jedem Schreibpfad ins
 * Protokoll/den Prompt — nichts hier ruft sie manuell auf, das wäre eine zweite, überflüssige
 * Prüfung derselben Sache). Diese Datei beweist die Aussage nur konkret für MCP
 * (`tools/mcp/tools.test.ts`), sie erfindet keinen weiteren Schutzmechanismus dafür.
 */

/** Ein MCP-Server ist falsch konfiguriert (ungültige `id`, doppelte Fernnamen nach Sanitierung). */
export class McpServerConfigError extends Error {}

const SERVER_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

export interface McpServerConfig {
  /** Wird Teil des lokalen Toolnamens (`mcp.<id>__<...>`) — muss ^[a-z][a-z0-9_]*$ erfüllen. */
  id: string;
  client: McpClient;
  /**
   * Obergrenze für JEDES Tool dieses Servers. Niemals aus der Fernbeschreibung oder dem
   * Fernschema abgeleitet — siehe Modulkommentar, Punkt 1.
   */
  risk: RiskLevel;
  repeatable: boolean;
}

export interface McpToolsDeps {
  servers: readonly McpServerConfig[];
}

/**
 * Kleinschreiben, alles außer `[a-z0-9_]` durch `_` ersetzen, mehrfache `_` zusammenfassen,
 * Rand-`_` trimmen. Beginnt das Ergebnis nicht mit einem Buchstaben (leer, oder ein Fernname,
 * der nur aus Ziffern/Symbolen bestand), wird `t_` vorangestellt — `TOOL_NAME_PATTERN` verlangt
 * `[a-z]` als erstes Zeichen der Aktion.
 */
function sanitizeRemoteName(remoteName: string): string {
  const lowered = remoteName.toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  const collapsed = lowered.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  const base = collapsed.length > 0 ? collapsed : "tool";
  return /^[a-z]/.test(base) ? base : `t_${base}`;
}

/** Reserviert für die Policy-Engine (`policy/resource.ts`) — siehe Modulkommentar, Punkt 1
 * dieser Datei betrifft die Risikostufe; hier geht es um die Feldnamen der Eingabe. Ein
 * Fernfeld, das zufällig oder absichtlich `path`/`url` heißt, wird trotzdem umbenannt: dieses
 * Modul lässt kein Fernfeld unter einem Namen durch, der der Policy-Engine eine Bedeutung
 * vorspiegelte (Dateizone, Domain-Egress), die für einen MCP-Server nicht gilt — bis MCP
 * eine eigene Ressourcen-Achse in der Policy-Engine bekommt (nicht Teil dieser Session), ist
 * "gar nicht erst wie ein Pfad/eine Adresse aussehen" die sichere Vorgabe. */
const RESERVED_POLICY_FIELDS = new Set(["path", "url"]);

/**
 * Ein lokal sicherer Feldname für ein Fernfeld. Gibt `null` zurück, wenn keine Umbenennung
 * nötig ist (der Normalfall).
 */
function safePolicyFieldName(remoteFieldName: string, toolName: string): string | null {
  if (RESERVED_POLICY_FIELDS.has(remoteFieldName)) return `${remoteFieldName}_arg`;
  try {
    assertPolicyFieldNames(toolName, [remoteFieldName]);
    return null;
  } catch {
    return `${remoteFieldName}_arg`;
  }
}

function jsonSchemaTypeToToolFieldType(value: unknown): ToolFieldType {
  switch (value) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return "array";
    default:
      return "object";
  }
}

interface FieldMapping {
  /** Lokaler Feldname → ursprünglicher Fernfeldname. Leer heißt: keine Umbenennung nötig. */
  renamed: Record<string, string>;
  inputSchema: ToolInputSchema;
}

/**
 * Bildet das rohe, JSON-Schema-artige `inputSchema` eines MCP-Tools auf das winzige lokale
 * `ToolInputSchema` ab (`tools/types.ts`: "bewusst winzig und ohne Bibliothek"). Nur die
 * obersten `properties` werden übernommen; alles Verschachtelte oder unbekannt Typisierte wird
 * **sichtbar** vereinfacht (Hinweis in der Feldbeschreibung), nicht sauber verschwiegen —
 * dieselbe Haltung wie der Kommentar über `ToolInputSchema` selbst sie für das ganze
 * Schema-System schon festhält.
 */
function mapInputSchema(toolName: string, rawSchema: unknown): FieldMapping {
  const fields: Record<string, ToolField> = {};
  const renamed: Record<string, string> = {};

  const schema = (typeof rawSchema === "object" && rawSchema !== null ? rawSchema : {}) as {
    properties?: Record<string, unknown>;
    required?: unknown;
  };
  const properties =
    typeof schema.properties === "object" && schema.properties !== null ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((entry) => typeof entry === "string")
      : [],
  );

  for (const [remoteFieldName, rawProperty] of Object.entries(properties)) {
    const property = (
      typeof rawProperty === "object" && rawProperty !== null ? rawProperty : {}
    ) as {
      type?: unknown;
      description?: unknown;
    };
    const isNested =
      property.type === "object" || property.type === undefined || Array.isArray(property.type);
    const type = jsonSchemaTypeToToolFieldType(property.type);
    const baseDescription =
      typeof property.description === "string" && property.description.trim().length > 0
        ? property.description.trim()
        : `Fernfeld "${remoteFieldName}" von "${toolName}".`;
    const description = isNested
      ? `${baseDescription} (vereinfachtes Schema — ursprünglich verschachtelt/nicht eindeutig typisiert, MCP-Rohschema siehe Serverbeschreibung)`
      : baseDescription;

    const localFieldName = safePolicyFieldName(remoteFieldName, toolName);
    const fieldName = localFieldName ?? remoteFieldName;
    if (localFieldName) renamed[fieldName] = remoteFieldName;

    fields[fieldName] = { type, required: required.has(remoteFieldName), description };
  }

  return { renamed, inputSchema: { fields } };
}

const PREVIEW_LINES = 3;
const PREVIEW_LINE_CAP = 160;

function textOf(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim();
}

function summarize(localName: string, text: string): string {
  if (text.length === 0) return `MCP-Tool "${localName}" ok — keine Textantwort.`;
  const firstLine = text.split("\n")[0];
  return firstLine.length > PREVIEW_LINE_CAP
    ? `${firstLine.slice(0, PREVIEW_LINE_CAP)} …`
    : firstLine;
}

function previewFrom(text: string): string[] {
  if (text.length === 0) return [];
  return text
    .split("\n")
    .slice(0, PREVIEW_LINES)
    .map((line) =>
      line.length > PREVIEW_LINE_CAP ? `${line.slice(0, PREVIEW_LINE_CAP)} …` : line,
    );
}

async function callRemoteTool(
  server: McpServerConfig,
  remoteName: string,
  localName: string,
  renamed: Record<string, string>,
  inv: ToolInvocation,
): Promise<ToolOutput> {
  // Lokale (evtl. umbenannte) Feldnamen zurück auf die vom Fernserver erwarteten übersetzen —
  // die Policy-Engine sieht die lokalen Namen, der Server nie etwas anderes als seine eigenen.
  const args: Record<string, unknown> = {};
  for (const [localField, value] of Object.entries(inv.input)) {
    const remoteField = renamed[localField] ?? localField;
    args[remoteField] = value;
  }

  const result = await server.client.callTool({
    name: remoteName,
    arguments: args,
    signal: inv.signal,
  });
  const text = textOf(result.content);

  if (result.isError) {
    // AGENTS.md: Fehler nie verstecken oder glätten. Ein `isError`-Ergebnis ist ein
    // Fehlschlag des Fern-Tools und wird als solcher geworfen, nicht als "ok" zurückgegeben —
    // der Router markiert den Aufruf dadurch als `tool.failed`, wie jeden anderen Fehlschlag.
    throw new McpToolCallError(
      `MCP-Tool "${localName}" (Fernname "${remoteName}") ist fehlgeschlagen: ${text || "(kein Text in der Antwort)"}`,
      remoteName,
      result.content,
    );
  }

  return {
    summary: summarize(localName, text),
    structured: {
      server: server.id,
      remote_tool: remoteName,
      content: result.content,
    } as JsonValue,
    preview: previewFrom(text),
  };
}

/**
 * Fragt jeden konfigurierten Server **einmal** über `tools/list` ab und macht daraus native
 * `ToolDefinition`s. Wird aus `runtime/loop/api.ts`s `buildCatalog` gerufen — dort, und nur
 * dort, mit einem async-Katalogbau, der ohnehin schon auf n8n/Skills/Notes wartet.
 */
export async function createMcpTools(deps: McpToolsDeps): Promise<ToolDefinition[]> {
  const definitions: ToolDefinition[] = [];

  for (const server of deps.servers) {
    if (!SERVER_ID_PATTERN.test(server.id)) {
      throw new McpServerConfigError(
        `MCP-Server-Id "${server.id}" ist ungültig — erlaubt ist ^[a-z][a-z0-9_]*$ (wird Teil des lokalen Toolnamens "mcp.${server.id}__...").`,
      );
    }

    const remoteTools = await server.client.listTools();
    const seenLocalNames = new Map<string, string>(); // lokaler Name -> Fernname, zur Kollisionsprüfung

    for (const remoteTool of remoteTools) {
      const sanitized = sanitizeRemoteName(remoteTool.name);
      const localName = `mcp.${server.id}__${sanitized}`;

      const priorRemoteName = seenLocalNames.get(localName);
      if (priorRemoteName !== undefined) {
        throw new McpServerConfigError(
          `MCP-Server "${server.id}": die Fernnamen "${priorRemoteName}" und "${remoteTool.name}" ergeben nach der Sanitierung denselben lokalen Namen "${localName}". Einer von beiden muss serverseitig umbenannt oder hier ausdrücklich behandelt werden.`,
        );
      }
      seenLocalNames.set(localName, remoteTool.name);

      const { renamed, inputSchema } = mapInputSchema(localName, remoteTool.inputSchema);
      const remoteName = remoteTool.name;

      definitions.push({
        name: localName,
        // Sichtbar mit Herkunft präfixiert — reine Kennzeichnung, ändert nichts an Vertrauen
        // oder Risiko (die kommen ausschließlich aus `server.risk`), hilft aber jedem, der den
        // Katalog liest, sofort zu sehen: dieser Text kommt von außen (Abschnitt 4.7).
        description: `[MCP:${server.id}] ${remoteTool.description || `Fern-Tool "${remoteName}" ohne Beschreibung.`}`,
        inputSchema,
        risk: server.risk,
        repeatable: server.repeatable,
        // Assistenz-Tool wie generische n8n-Workflows/`mail.*`/`cal.*` — dynamisch entdeckt,
        // nicht Teil der Kern-Primitive (Abschnitt 9).
        deferred: true,
        handler: (inv) => callRemoteTool(server, remoteName, localName, renamed, inv),
      });
    }
  }

  return definitions;
}
