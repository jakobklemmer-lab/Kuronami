import type { Pool } from "pg";
import { writeArtifact } from "../../runtime/artifacts/store.js";
import type { JsonValue } from "../../runtime/steps/types.js";
import type { N8nBridge } from "../n8n/bridge.js";
import type { ToolDefinition, ToolInvocation, ToolOutput } from "../types.js";

/**
 * `server.metrics` (S15, Abschnitt 9) — Server-Kennzahlen **über n8n**, aus **derselben
 * Quelle wie das bestehende Dashboard** (Abschnitt 4.1: "das bestehende Dashboard ist
 * Node"). Der Workflow `server-metrics` fragt diese Quelle ab (Postgres im `public`-Schema
 * bzw. der Metrik-Endpunkt des Dashboards — siehe `workflows/server-metrics.json` und
 * `README.md`); dieser Handler formt das Ergebnis in die einheitliche Hülle.
 *
 * **Eigener Handler statt generischer `N8nWorkflowDef`** aus demselben Grund wie `cal.list`
 * und `mail.*`: der Auftrag von S15 verlangt für lesende Tools "Zusammenfassung im Kontext,
 * Volltext als Artefakt". `server.metrics` legt den vollständigen Kennzahlen-Block als
 * Artefakt ab und lässt nur eine knappe, aus bekannten Feldern synthetisierte Zusammenfassung
 * plus Handle im Kontext.
 */

/** Die vollständige Liste der n8n-Webhook-Pfade von `server.*`. Eingefroren wie `MAIL_WEBHOOKS`. */
export const SERVER_WEBHOOKS = Object.freeze({ metrics: "server-metrics" } as const);

/** So viele "Feld: Wert"-Zeilen stehen als Vorschau im Kontext. */
const PREVIEW_LINES = 6;
const PREVIEW_VALUE_CAP = 120;

/** Der n8n-Workflow hat etwas zurückgegeben, das sich nicht als Kennzahlen-Antwort lesen lässt. */
export class ServerBackendResponseError extends Error {}

export interface ServerToolDeps {
  pool: Pool;
  /** Wurzel der Artefaktablage — für den vollständigen Kennzahlen-Block. */
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

/** Wie `readPayload` in `tools/cal/tools.ts`: 1-Element-Array auspacken, `json`/`body`-Wrapper abtragen. */
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

function firstDefined(
  record: { [key: string]: JsonValue },
  ...keys: string[]
): JsonValue | undefined {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function numOrNull(value: JsonValue | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function strOrNull(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Prozent-artigen Wert für die Zusammenfassung formatieren; `null` → "?". */
function pct(value: number | null): string {
  return value === null ? "?" : `${value.toFixed(value >= 10 ? 0 : 1)} %`;
}

/**
 * `type` und kein `interface`: nur ein Typalias mit reinen Primitivfeldern bekommt in
 * TypeScript die implizite Indexsignatur, mit der der Wert als `JsonValue` durch die
 * Rückgabehülle geht (dieselbe Überlegung wie bei `ToolResult` und `MailHeader`).
 */
type Recognized = {
  host: string | null;
  cpu_percent: number | null;
  memory_percent: number | null;
  disk_percent: number | null;
  load1: number | null;
  uptime_seconds: number | null;
};

/** Zieht die üblichen Kennzahlen aus einem Block mit unbekannter, aber flacher Form. */
function recognize(payload: { [key: string]: JsonValue }): Recognized {
  return {
    host: strOrNull(firstDefined(payload, "host", "hostname", "server", "node")),
    cpu_percent: numOrNull(firstDefined(payload, "cpu_percent", "cpu", "cpu_usage", "cpuLoad")),
    memory_percent: numOrNull(
      firstDefined(payload, "memory_percent", "mem_percent", "memory", "mem_usage"),
    ),
    disk_percent: numOrNull(firstDefined(payload, "disk_percent", "disk", "disk_usage", "storage")),
    load1: numOrNull(firstDefined(payload, "load1", "load_1m", "loadavg_1", "load")),
    uptime_seconds: numOrNull(firstDefined(payload, "uptime_seconds", "uptime", "uptimeSec")),
  };
}

function humanUptime(seconds: number | null): string {
  if (seconds === null) return "?";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  return days > 0 ? `${days} d ${hours} h` : `${hours} h`;
}

function previewFrom(payload: { [key: string]: JsonValue }): string[] {
  return Object.entries(payload)
    .slice(0, PREVIEW_LINES)
    .map(([key, value]) => {
      const rendered = typeof value === "object" ? JSON.stringify(value) : String(value);
      const line = `${key}: ${rendered}`;
      return line.length > PREVIEW_VALUE_CAP ? `${line.slice(0, PREVIEW_VALUE_CAP)} …` : line;
    });
}

// ---------------------------------------------------------------------------
// server.metrics
// ---------------------------------------------------------------------------

async function metricsHandler(deps: ServerToolDeps, inv: ToolInvocation): Promise<ToolOutput> {
  const invocation = await deps.bridge.invoke({
    webhookPath: SERVER_WEBHOOKS.metrics,
    input: inv.input,
    // Kennzahlen abfragen hat keine Wirkung nach draußen.
    repeatable: true,
    signal: inv.signal,
  });

  const payload = readPayload(invocation.body);
  if (Object.keys(payload).length === 0) {
    throw new ServerBackendResponseError(
      `server.metrics: die n8n-Antwort ist leer oder kein Objekt. Der Workflow "${SERVER_WEBHOOKS.metrics}" muss den Kennzahlen-Block als JSON-Objekt zurückgeben.`,
    );
  }

  // Vollständiger Kennzahlen-Block → Artefakt. "Volltext als Artefakt".
  const meta = await writeArtifact(deps.pool, deps.artifactRoot, {
    content: JSON.stringify({ query: inv.input, metrics: payload }, null, 2),
    mimeType: "application/json",
    summary: "Server-Kennzahlen (vollständig), Quelle wie das bestehende Dashboard",
    source: { tool: "server.metrics", sessionId: inv.sessionId, stepId: inv.stepId },
  });

  const found = recognize(payload);
  const parts: string[] = [];
  if (found.cpu_percent !== null) parts.push(`CPU ${pct(found.cpu_percent)}`);
  if (found.memory_percent !== null) parts.push(`RAM ${pct(found.memory_percent)}`);
  if (found.disk_percent !== null) parts.push(`Disk ${pct(found.disk_percent)}`);
  if (found.load1 !== null) parts.push(`Load ${found.load1.toFixed(2)}`);
  if (found.uptime_seconds !== null) parts.push(`Uptime ${humanUptime(found.uptime_seconds)}`);

  const head = `Server-Kennzahlen${found.host ? ` (${found.host})` : ""}`;
  const body =
    parts.length > 0
      ? parts.join(", ")
      : `${Object.keys(payload).length} Feld(er): ${Object.keys(payload).slice(0, 8).join(", ")}`;
  const summary = `${head}: ${body}. Vollständig im Artefakt ${meta.uri}.`;

  return {
    summary,
    structured: {
      content_kind: "server-metrics",
      source: `n8n:${SERVER_WEBHOOKS.metrics}`,
      recognized: found,
      field_count: Object.keys(payload).length,
      metrics_artifact_uri: meta.uri,
    },
    preview: previewFrom(payload),
    artifact_refs: [meta.uri],
  };
}

// ---------------------------------------------------------------------------
// Definitionen
// ---------------------------------------------------------------------------

/**
 * Baut die `server.*`-Definition mit der Brücke im Handler geschlossen. `runtime/loop/api.ts`
 * registriert sie, wenn `config.n8n.server` gesetzt ist; Tests bauen sich einen eigenen
 * Katalog mit injizierter Brücke.
 *
 * `server.metrics` ist `read` (Abschnitt 10). Kein `execution`-Feld: der n8n-Aufruf ist ein
 * externer Seiteneffekt und läuft durch die Ausführungshülle.
 */
export function createServerTools(deps: ServerToolDeps): ToolDefinition[] {
  return [
    {
      name: "server.metrics",
      description:
        "Liest die aktuellen Server-Kennzahlen (CPU, RAM, Disk, Load, Uptime u. a.) aus derselben Quelle wie das bestehende Dashboard. In den Kontext geht eine knappe Zusammenfassung; der vollständige Kennzahlen-Block liegt als Artefakt-Handle bei.",
      risk: "read",
      repeatable: true,
      // Assistenz-Tool (Abschnitt 9), nicht Kern-Primitiv — verzögertes Laden (S18b).
      deferred: true,
      inputSchema: {
        fields: {
          window: {
            type: "string",
            required: false,
            description:
              "Zeitfenster für Verlaufswerte, z. B. „1h“, „24h“, „7d“. Vorgabe: Momentaufnahme.",
          },
        },
      },
      handler: (inv) => metricsHandler(deps, inv),
    },
  ];
}
