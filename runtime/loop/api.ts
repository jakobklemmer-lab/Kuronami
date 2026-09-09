import type { Pool } from "pg";
import { type RunMetrics, deriveRunMetrics } from "../../context/metrics.js";
import { loadConventions } from "../../context/system-prompt.js";
import { decidePolicyApproval, policyAskId } from "../../policy/approvals.js";
import { createPolicyEngine } from "../../policy/engine.js";
import { buildFsZones, policyResolver } from "../../tools/fs/paths.js";
import { createFsTools } from "../../tools/fs/tools.js";
import { createMailTools } from "../../tools/mail/tools.js";
import { createN8nBridge } from "../../tools/n8n/bridge.js";
import { type N8nWorkflowDef, createN8nTools } from "../../tools/n8n/workflows.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createTaskTools } from "../../tools/task/tools.js";
import type { ToolCatalog } from "../../tools/types.js";
import { createUserTools } from "../../tools/user/tools.js";
import { buildEgressPolicy } from "../../tools/web/egress.js";
import { createWebTools } from "../../tools/web/tools.js";
import { artifactRootFromEnv } from "../artifacts/store.js";
import { appendEvent, readEvents } from "../events/log.js";
import type { ModelClient } from "../model/types.js";
import { cancelSession } from "../session/lifecycle.js";
import { type RuntimeHandle, startRuntime } from "../session/manager.js";
import { type SessionState, readSessionState } from "../session/state.js";
import type { SessionChannel, SessionRecord } from "../session/types.js";
import { answerUserInput } from "../session/user-input.js";
import { readPlanSnapshot } from "../tasks/store.js";
import type { TaskState } from "../tasks/types.js";
import { type LoopDeps, type LoopOutcome, runTurn } from "./loop.js";

/**
 * Die kleine API-Oberfläche, um Läufe **ohne UI** anzustoßen (Auftrag S12).
 *
 * Klein heißt hier: fünf Verben, keine davon neu. `run`, `answer`, `cancel`, `status`, `stop`
 * sind genau die Handgriffe, die ein Kanal (S16), ein Heartbeat (S17) oder ein Test braucht —
 * und alle fünf sind nur Verdrahtung über Bausteine, die es seit S04 bis S11 gibt. Was hier
 * **nicht** steht, ist ebenso Absicht: kein HTTP, kein Port, keine Authentifizierung. Die
 * Oberfläche nach draußen ist die Surface-Schicht, und die ist austauschbar (Abschnitt 3,
 * harte Regel). Eine Runtime, die schon einen Server mitbrächte, wäre von ihr abhängig.
 *
 * Die Verdrahtung des Katalogs steht hier und nicht mehr in `runtime/index.ts`. Damit
 * bekommen der Prozess, der Test und der Probelauf denselben Katalog — und der eingefrorene
 * Katalog (S07) ist nur so viel wert, wie er an allen Stellen derselbe ist.
 */

export interface CatalogConfig {
  pool: Pool;
  artifactRoot: string;
  /** Quellzone. Vorgabe: das Arbeitsverzeichnis des Prozesses. */
  sourceRoot?: string;
  /** Kommagetrennte Hosts. Vorgabe: `WEB_EGRESS_ALLOWLIST`, leer heißt: nichts abrufbar. */
  egressAllowlist?: readonly string[];
  /**
   * n8n-Anbindung (S13/S14). Ohne Angabe: nichts — dann bleibt der Katalog-Fingerabdruck
   * unverändert (`v1-53a18ba0cb4e49c8`, 10 Tools). `baseUrl`/`token` fallen auf
   * `N8N_BASE_URL`/`N8N_WEBHOOK_TOKEN` zurück.
   *
   *   * `workflows` — generische n8n-Workflows als Tools (`createN8nTools`, S13).
   *   * `mail` — die Assistenz-Tools `mail.search`/`mail.read`/`mail.draft` (S14). Sie sind
   *     **keine** generischen Workflows: sie brauchen tool-spezifische Handler (nie Volltext
   *     in `mail.search`, Volltext/Anhänge als Artefakt in `mail.read`, Injection-Markierung)
   *     — dieselbe Lage, aus der `web.fetch` einen eigenen Handler hat. `mail.send` gibt es
   *     nicht (S14: "Senden ist technisch unmöglich").
   */
  n8n?: {
    baseUrl?: string;
    token?: string;
    workflows?: readonly N8nWorkflowDef[];
    mail?: boolean;
  };
}

export interface BuiltCatalog {
  catalog: ToolCatalog;
  policy: ReturnType<typeof createPolicyEngine>;
}

/**
 * Der ausgelieferte Tool-Katalog und die Governance-Schicht dazu: `fs.*` (S08), `web.*` (S09),
 * `task.*` und `user.ask` (S10), Policy-Engine mit dem versionierten Regelsatz (S11).
 *
 * Die Sandbox bleibt unverdrahtet, solange `exec.run` und der Container aus Abschnitt 4.6
 * nicht stehen: `bypass_in_sandbox` fällt damit sichtbar auf `ask` zurück statt still zu
 * wirken (S11).
 */
export async function buildCatalog(config: CatalogConfig): Promise<BuiltCatalog> {
  const zones = await buildFsZones({
    sourceRoot: config.sourceRoot ?? process.cwd(),
    artifactRoot: config.artifactRoot,
  });

  const allowlist =
    config.egressAllowlist ??
    (process.env.WEB_EGRESS_ALLOWLIST ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

  const registry = new ToolRegistry()
    .registerAll(createFsTools({ pool: config.pool, artifactRoot: config.artifactRoot, zones }))
    .registerAll(
      createWebTools({
        pool: config.pool,
        artifactRoot: config.artifactRoot,
        egress: buildEgressPolicy({ allowlist: [...allowlist] }),
      }),
    )
    .registerAll(createTaskTools({ pool: config.pool }))
    .registerAll(createUserTools({ pool: config.pool }));

  // n8n-Tools (S13/S14). Nur wenn etwas konfiguriert ist — sonst bleibt der Fingerabdruck
  // des ausgelieferten Katalogs unverändert (`v1-53a18ba0cb4e49c8`, 10 Tools). Eine Brücke,
  // beide Wege teilen sie.
  const n8nWorkflows = config.n8n?.workflows ?? [];
  const wantMail = config.n8n?.mail === true;
  if (n8nWorkflows.length > 0 || wantMail) {
    const bridge = createN8nBridge({
      baseUrl: config.n8n?.baseUrl ?? process.env.N8N_BASE_URL,
      token: config.n8n?.token ?? process.env.N8N_WEBHOOK_TOKEN,
    });
    if (n8nWorkflows.length > 0) {
      registry.registerAll(createN8nTools({ bridge, workflows: n8nWorkflows }));
    }
    if (wantMail) {
      registry.registerAll(
        createMailTools({ pool: config.pool, artifactRoot: config.artifactRoot, bridge }),
      );
    }
  }

  const catalog = registry.freeze();

  return { catalog, policy: createPolicyEngine({ resolvePath: policyResolver(zones) }) };
}

export interface RunnerConfig extends Omit<LoopDeps, "conventions" | "signal" | "artifactRoot"> {
  threadId: string;
  channel: SessionChannel;
  artifactRoot?: string;
  /** Einmal beim Start gelesen. Vorgabe: AGENTS.md aus dem Arbeitsverzeichnis. */
  conventions?: string;
  /**
   * Schreibt `session.completed` bzw. `session.failed`, wenn ein Zug endgültig endet.
   *
   * Vorgabe an, weil ein **Lauf** die Einheit ist, die diese API startet und beendet: eine
   * Aufgabe, die durchläuft, ist fertig. Ein Kanal, der eine lange mehrzügige Unterhaltung
   * führt (S16), setzt das ab — dort ist ein fertiger Zug kein fertiger Auftrag, und eine
   * Session, die nach jeder Antwort als abgeschlossen im Protokoll steht, wäre eine
   * Falschaussage über den Verlauf.
   */
  completeOnDone?: boolean;
}

export interface RunStatus {
  session: SessionState;
  plan: TaskState[];
  metrics: RunMetrics;
}

export interface Runner {
  readonly session: SessionRecord;
  readonly runtimeId: string;
  readonly catalog: ToolCatalog;
  /** Startet einen Zug (`input`) oder setzt den offenen fort (ohne `input`). */
  run(input?: string): Promise<LoopOutcome>;
  /**
   * Beantwortet eine offene Rückfrage. Die `ask_id` sagt, um welche Art es sich handelt:
   * `policy:<call_id>` ist eine Freigabe (S11), `ask:<call_id>` eine Rückfrage aus `user.ask`
   * (S10). Beide über einen Aufruf, weil der Aufrufer die Unterscheidung nicht treffen
   * können muss — er hat die Frage samt ihrer Kennung aus dem Wartezustand bekommen.
   */
  answer(askId: string, choiceId: string, decidedBy?: string): Promise<void>;
  cancel(reason?: string): Promise<void>;
  status(): Promise<RunStatus>;
  stop(reason?: string): Promise<void>;
}

/** Die `ask_id` einer Policy-Rückfrage trägt seit S11 dieses Präfix. */
function isPolicyAsk(askId: string): boolean {
  return askId.startsWith(policyAskId(""));
}

/**
 * Nimmt die Session auf und gibt den Läufer zurück.
 *
 * Wie `startRuntime` (S04): der Aufrufer besitzt Pool und Lebenszyklus. Wer `createRunner`
 * ruft, ruft am Ende `stop()` — sonst bleibt ein `runtime.started` ohne Gegenstück stehen,
 * und genau das ist seit S04 das Kennzeichen eines abgestürzten Laufs.
 */
export async function createRunner(config: RunnerConfig): Promise<Runner> {
  const pool = config.pool;
  const artifactRoot = config.artifactRoot ?? artifactRootFromEnv();
  const conventions = config.conventions ?? (await loadConventions());
  const completeOnDone = config.completeOnDone ?? true;

  const runtime: RuntimeHandle = await startRuntime(pool, {
    threadId: config.threadId,
    channel: config.channel,
    defaults: {
      toolCatalogVersion: config.catalog.version,
      modelProfile: config.model.model,
    },
  });

  const loopDeps: LoopDeps = {
    ...config,
    artifactRoot,
    conventions,
    signal: runtime.signal,
  };

  return {
    session: runtime.session,
    runtimeId: runtime.runtimeId,
    catalog: config.catalog,

    async run(input?: string): Promise<LoopOutcome> {
      const result = await runTurn(loopDeps, runtime.session, input === undefined ? {} : { input });

      if (completeOnDone && result.stop === "done") {
        await appendEvent(pool, runtime.session.sessionId, "session.completed", {
          turn_id: result.turnId,
          tool_calls: result.toolCalls,
          reason: result.reason,
        });
      }
      if (completeOnDone && (result.stop === "step_limit" || result.stop === "error_rate")) {
        // Kein Erfolg und kein Warten: der Lauf ist an einer Grenze gescheitert. Das gehört
        // ins Protokoll, sonst sähe eine abgebrochene Aufgabe später aus wie eine, an der
        // nur gerade niemand weiterarbeitet.
        await appendEvent(pool, runtime.session.sessionId, "session.failed", {
          turn_id: result.turnId,
          stop: result.stop,
          reason: result.reason,
        });
      }
      return result;
    },

    async answer(askId: string, choiceId: string, decidedBy = "operator"): Promise<void> {
      if (isPolicyAsk(askId)) {
        await decidePolicyApproval(pool, runtime.session.sessionId, askId, choiceId, { decidedBy });
        return;
      }
      await answerUserInput(pool, runtime.session.sessionId, askId, choiceId, { decidedBy });
    },

    async cancel(reason = "user_request"): Promise<void> {
      await cancelSession(pool, runtime.session.sessionId, reason);
    },

    async status(): Promise<RunStatus> {
      const sessionId = runtime.session.sessionId;
      return {
        session: await readSessionState(pool, sessionId),
        plan: await readPlanSnapshot(pool, sessionId),
        metrics: deriveRunMetrics(await readEvents(pool, sessionId)),
      };
    },

    stop: (reason?: string) => runtime.stop(reason),
  };
}

export type { LoopOutcome, ModelClient };
