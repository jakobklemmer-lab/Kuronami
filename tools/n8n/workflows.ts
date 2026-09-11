import type { RiskLevel } from "../../policy/risk.js";
import type { JsonValue } from "../../runtime/steps/types.js";
import type { ToolDefinition, ToolInputSchema, ToolInvocation, ToolOutput } from "../types.js";
import type { N8nBridge } from "./bridge.js";

/**
 * Ein n8n-Workflow, so beschrieben, dass die Runtime ihn wie ein natives Tool behandeln kann
 * (Auftrag S13: "Jeder Workflow bekommt Name, Eingabeschema, Risikostufe wie ein natives
 * Tool").
 *
 * `createN8nTools` macht aus jeder Beschreibung eine `ToolDefinition`. Von da an ist der
 * Workflow von einem `fs.*`- oder `web.*`-Tool nicht mehr zu unterscheiden: er läuft durch
 * denselben Router, dieselbe Policy-Prüfung, dieselbe Ausführungshülle (`execution: "step"`,
 * Vorgabe) und dieselbe automatische Auslagerung. **Die Brücke baut keine eigene Auslagerung**
 * — ein n8n-Ergebnis hat keine bekannte Form, aus der sich ein typisierter Ausschnitt
 * schneiden ließe (anders als `fs.read` mit seinen Rohbytes oder `web.fetch` mit seinem
 * excerpt). Der Router misst die fertige Hülle und lagert `structured` aus, wenn sie zu groß
 * wird (`materializeResult`, S07). Der Handler sorgt nur dafür, dass `summary` und `preview`
 * auch dann noch etwas aussagen.
 */
export interface N8nWorkflowDef {
  /** `namensraum.aktion` (Abschnitt 4.8). Muss zu einem erlaubten Namensraum gehören. */
  name: string;
  /** Die Fassung, die das Modell im Katalog liest. */
  description: string;
  risk: RiskLevel;
  /**
   * Darf ein unterbrochener Aufruf wiederholt werden? Gilt für die Ausführungshülle **und**
   * für den Retry der Brücke: nur ein `repeatable`-Workflow bekommt bei einem vorübergehenden
   * HTTP-Fehler einen zweiten Anlauf. Aussage über die Außenwelt — nur der Workflow-Autor
   * kann sie treffen (wie `StepSpec.repeatable`, S05).
   */
  repeatable: boolean;
  /** Der `path` des Webhook-Knotens im Workflow. Ergibt `${baseUrl}/webhook/${webhookPath}`. */
  webhookPath: string;
  inputSchema: ToolInputSchema;
}

export interface N8nToolsDeps {
  bridge: N8nBridge;
  workflows: readonly N8nWorkflowDef[];
}

const PREVIEW_LINES = 3;
const PREVIEW_LINE_CAP = 160;

/**
 * n8n gibt oft ein Array mit einem Element je Workflow-Durchlauf zurück. Ein einzelnes
 * Element wird ausgepackt; alles andere bleibt, wie es kam.
 */
function unwrapBody(body: JsonValue): JsonValue {
  if (Array.isArray(body) && body.length === 1) return body[0];
  return body;
}

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function summarize(workflowName: string, payload: JsonValue): string {
  if (isRecord(payload) && typeof payload.summary === "string" && payload.summary.trim() !== "") {
    return payload.summary.trim();
  }
  if (isRecord(payload)) {
    const keys = Object.keys(payload);
    return `n8n-Workflow "${workflowName}" ok — ${keys.length} Feld(er): ${keys.slice(0, 8).join(", ")}`;
  }
  if (Array.isArray(payload)) {
    return `n8n-Workflow "${workflowName}" ok — ${payload.length} Einträge`;
  }
  return `n8n-Workflow "${workflowName}" ok`;
}

function previewFrom(payload: JsonValue): string[] {
  const cap = (line: string): string =>
    line.length > PREVIEW_LINE_CAP ? `${line.slice(0, PREVIEW_LINE_CAP)} …` : line;
  if (isRecord(payload)) {
    return Object.entries(payload)
      .slice(0, PREVIEW_LINES)
      .map(([key, value]) => cap(`${key}: ${JSON.stringify(value)}`));
  }
  if (Array.isArray(payload)) {
    return payload.slice(0, PREVIEW_LINES).map((entry) => cap(JSON.stringify(entry)));
  }
  return [cap(JSON.stringify(payload))];
}

async function runWorkflow(
  deps: N8nToolsDeps,
  def: N8nWorkflowDef,
  inv: ToolInvocation,
): Promise<ToolOutput> {
  const invocation = await deps.bridge.invoke({
    webhookPath: def.webhookPath,
    input: inv.input,
    repeatable: def.repeatable,
    signal: inv.signal,
  });

  const payload = unwrapBody(invocation.body);

  return {
    summary: summarize(def.name, payload),
    structured: {
      workflow: def.name,
      http_status: invocation.status,
      attempts: invocation.attempts,
      duration_ms: invocation.durationMs,
      body: payload,
    },
    preview: previewFrom(payload),
  };
}

/**
 * Macht aus den Workflow-Beschreibungen native `ToolDefinition`s. `runtime/loop/api.ts`
 * registriert sie im Katalog neben `fs.*`/`web.*`, sobald ein Workflow-Satz konfiguriert ist
 * (S14 bringt die ersten echten); Tests bauen sich einen eigenen mit injizierter Brücke.
 *
 * Kein `execution`-Feld: ein Workflow hat einen externen Seiteneffekt und läuft durch die
 * Ausführungshülle wie jedes andere Werkzeug mit Wirkung nach draußen (Vorgabe `"step"`).
 */
export function createN8nTools(deps: N8nToolsDeps): ToolDefinition[] {
  return deps.workflows.map((def) => ({
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    risk: def.risk,
    repeatable: def.repeatable,
    // Generische n8n-Workflows sind Assistenz-Tools (Abschnitt 9) par excellence: genau die
    // wachsende, situative Klasse, für die S18b das verzögerte Tool-Laden baut (Auftrag: "S18d
    // und Phase 5 lassen ihn wachsen"). `mail.*`/`cal.*`/`server.*` haben eigene Handler und
    // stehen deshalb nicht hier, sind aber aus demselben Grund selbst `deferred: true`.
    deferred: true,
    handler: (inv) => runWorkflow(deps, def, inv),
  }));
}

/**
 * Der Testworkflow aus dem Auftrag von S13: nimmt Text entgegen, gibt ihn großgeschrieben
 * zurück. Namensraum `dev` — ein Prüf-Workflow des Harness, der in **keinen** produktiven
 * Katalog gehört (wie `dummies.ts`, Abschnitt 4.8). Die echten n8n-Tools (`mail.*`, `cal.*`,
 * …) kommen ab S14 und tragen ihre produktiven Namensräume.
 *
 * Der importierbare Workflow liegt in `workflows/uppercase.json`.
 */
export const UPPERCASE_WORKFLOW: N8nWorkflowDef = {
  name: "dev.uppercase",
  description:
    "Prüf-Workflow über n8n: nimmt ein Textfeld entgegen und gibt es großgeschrieben zurück. Zeigt, dass ein n8n-Workflow aus der Runtime wie ein natives Tool aufrufbar ist.",
  risk: "read",
  // Reine Transformation ohne Wirkung nach draußen: ein zweiter Anlauf ist folgenlos.
  repeatable: true,
  webhookPath: "uppercase",
  inputSchema: {
    fields: {
      text: {
        type: "string",
        required: true,
        description: "Text, der großgeschrieben zurückkommen soll.",
      },
    },
  },
};

/** Prüf-Workflows des Harness. Nicht Teil des ausgelieferten Katalogs. */
export const HARNESS_N8N_WORKFLOWS: readonly N8nWorkflowDef[] = [UPPERCASE_WORKFLOW];
