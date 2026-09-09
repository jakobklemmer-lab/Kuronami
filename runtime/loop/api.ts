import type { Pool } from "pg";
import { type RunMetrics, deriveRunMetrics } from "../../context/metrics.js";
import { loadConventions } from "../../context/system-prompt.js";
import { decidePolicyApproval, policyAskId } from "../../policy/approvals.js";
import { createPolicyEngine } from "../../policy/engine.js";
import { BACKGROUND_RULES, DEFAULT_RULES } from "../../policy/rules.js";
import { createCalTools } from "../../tools/cal/tools.js";
import { buildFsZones, policyResolver } from "../../tools/fs/paths.js";
import { createFsTools } from "../../tools/fs/tools.js";
import { createMailTools } from "../../tools/mail/tools.js";
import { type MemoryStore, buildMemoryRoot, createMemoryStore } from "../../tools/memory/store.js";
import { summarizeRun } from "../../tools/memory/summary.js";
import { createMemoryTools } from "../../tools/memory/tools.js";
import { createN8nBridge } from "../../tools/n8n/bridge.js";
import { type N8nWorkflowDef, createN8nTools } from "../../tools/n8n/workflows.js";
import { buildVaultRoot } from "../../tools/notes/paths.js";
import { createNotesTools } from "../../tools/notes/tools.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createServerTools } from "../../tools/server/tools.js";
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
   *   * `cal` — `cal.list`/`cal.create`/`cal.update` (S15), ebenfalls mit eigenen Handlern:
   *     `cal.list` legt die volle Terminliste als Artefakt ab, `cal.create`/`cal.update`
   *     sind `hard_write` und pausieren für eine Freigabe.
   *   * `server` — `server.metrics` (S15), Kennzahlen aus derselben Quelle wie das
   *     bestehende Dashboard, voller Block als Artefakt.
   */
  n8n?: {
    baseUrl?: string;
    token?: string;
    workflows?: readonly N8nWorkflowDef[];
    mail?: boolean;
    cal?: boolean;
    server?: boolean;
  };
  /**
   * Der lokale Obsidian-Vault für `notes.read`/`notes.write` (S15) — **ohne n8n**, direkter
   * Dateizugriff. Wird das Feld gesetzt, kommen die `notes.*`-Tools in den Katalog; der Pfad
   * fällt auf `OBSIDIAN_VAULT_PATH` zurück. Ohne das Feld bleibt der Fingerabdruck unverändert
   * — genau wie bei `n8n` (env-Variablen liefern nur Zugangsdaten, ein ausdrückliches Feld
   * schaltet Tools frei). Ein fehlender oder kein-Verzeichnis-Vault wirft (`buildVaultRoot`).
   */
  obsidian?: { vaultPath?: string };
  /**
   * Das Langzeitgedächtnis (S18) — Markdown in `memory/` mit SQLite-Volltextindex, eigenes
   * Git-Repo. Gesetzt, kommen `memory.search`/`memory.write` in den Katalog **und** der
   * zurückgegebene `store` in den Loop (Recall vor jedem Zug) und in die Nachbereitung
   * (Zusammenfassung nach dem Lauf).
   *
   * Anders als `obsidian` und `n8n` ist ein leeres Objekt hier nicht nötig, um Voreinstellungen
   * zu ziehen: `root` fällt auf `MEMORY_ROOT` und dann auf `./memory` zurück. Ohne das Feld
   * bleibt der Katalog-Fingerabdruck unverändert — dieselbe Regel wie überall seit S14: ein
   * ausdrückliches Feld schaltet Tools frei, Umgebungsvariablen liefern nur den Pfad.
   */
  memory?: { root?: string; indexFile?: string; git?: boolean };
  /**
   * Das Profil des Katalogs. Vorgabe `"full"`: alles, was oben verdrahtet ist.
   *
   * `"background"` ist der **Hintergrundmodus** aus S17 — für Läufe, die der Heartbeat ohne
   * Nutzereingabe anstößt. Zwei Verschärfungen, beide technisch und nicht als Bitte:
   *
   *   1. **Engere Tool-Whitelist.** Nur lesende Tools plus `fs.write`/`fs.edit` (Vorschläge in
   *      die Artefaktzone) und `task.*` (Planung). Kein `user.ask` (niemand antwortet), kein
   *      `notes.write`/`cal.create`/`cal.update`/`mail.draft` (Seiteneffekte nach draußen),
   *      keine generischen n8n-Workflows. Der Fingerabdruck des Hintergrundkatalogs ist damit
   *      ein anderer als der des vollen — eine Hintergrund-Session und eine normale Session
   *      können denselben Prozess nicht teilen, und das ist richtig so (Anti-Muster 2).
   *   2. **`BACKGROUND_RULES` vor `DEFAULT_RULES`.** Schreiben in die Quellzone (und damit nach
   *      `memory/`) und das Lesen von Geheimnisträgern werden zu `deny` statt `ask` — siehe
   *      `policy/rules.ts`. Das ist die Schreibgrenze ans Langzeitgedächtnis, an dem einen Tor,
   *      an dem kein Weg vorbeiführt (Abschnitt 4.7).
   */
  profile?: "full" | "background";
}

/**
 * Die Tools, die ein Hintergrundlauf (S17) bekommt. Lesen und Vorschlagen, sonst nichts.
 *
 * `fs.write`/`fs.edit` sind dabei, weil ein Vorschlag ein Entwurf sein darf — er landet in der
 * Artefaktzone, und `BACKGROUND_RULES` sperrt jeden anderen Schreibpfad. `task.*` ist dabei,
 * weil ein Digest ein mehrschrittiger Auftrag ist und ohne Plan im Kreis liefe. Alles, was
 * einen Seiteneffekt nach draußen hätte oder auf eine Antwort wartet, fehlt bewusst.
 */
export const BACKGROUND_TOOLSET: readonly string[] = [
  "fs.list",
  "fs.read",
  "fs.search",
  "fs.write",
  "fs.edit",
  "web.search",
  "web.fetch",
  "mail.search",
  "mail.read",
  "cal.list",
  "server.metrics",
  "notes.read",
  // Lesen aus dem Langzeitgedächtnis ist erlaubt und erwünscht: ein Digest, der nicht weiß,
  // was letzte Woche entschieden wurde, wiederholt sich. **Schreiben** steht bewusst nicht
  // hier, und `BACKGROUND_RULES` verbietet es zusätzlich (S17/S18) — der Katalog ist die
  // Obergrenze, die Regel die Zusage.
  "memory.search",
  "task.set",
  "task.update",
];

export interface BuiltCatalog {
  catalog: ToolCatalog;
  policy: ReturnType<typeof createPolicyEngine>;
  /**
   * Das Langzeitgedächtnis, wenn es konfiguriert wurde. Der Aufrufer reicht es an
   * `createRunner` weiter; wer es geöffnet hat, schließt es auch (`store.close()`) — dasselbe
   * Eigentumsmuster wie beim Pool seit S03.
   */
  memory?: MemoryStore;
}

/**
 * Der ausgelieferte Tool-Katalog und die Governance-Schicht dazu: `fs.*` (S08), `web.*` (S09),
 * `task.*` und `user.ask` (S10), Policy-Engine mit dem versionierten Regelsatz (S11). Optional
 * dazu die Assistenz-Tools über n8n (`mail.*` S14, `cal.*`/`server.metrics` S15) und der
 * direkte Obsidian-Zugriff (`notes.*` S15) — jeweils nur, wenn ausdrücklich konfiguriert.
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

  // n8n-Tools (S13/S14/S15). Nur wenn etwas konfiguriert ist — sonst bleibt der Fingerabdruck
  // des ausgelieferten Katalogs unverändert (`v1-53a18ba0cb4e49c8`, 10 Tools). Eine Brücke,
  // alle Wege teilen sie.
  const n8nWorkflows = config.n8n?.workflows ?? [];
  const wantMail = config.n8n?.mail === true;
  const wantCal = config.n8n?.cal === true;
  const wantServer = config.n8n?.server === true;
  if (n8nWorkflows.length > 0 || wantMail || wantCal || wantServer) {
    const bridge = createN8nBridge({
      baseUrl: config.n8n?.baseUrl ?? process.env.N8N_BASE_URL,
      token: config.n8n?.token ?? process.env.N8N_WEBHOOK_TOKEN,
    });
    const assistDeps = { pool: config.pool, artifactRoot: config.artifactRoot, bridge };
    if (n8nWorkflows.length > 0) {
      registry.registerAll(createN8nTools({ bridge, workflows: n8nWorkflows }));
    }
    if (wantMail) registry.registerAll(createMailTools(assistDeps));
    if (wantCal) registry.registerAll(createCalTools(assistDeps));
    if (wantServer) registry.registerAll(createServerTools(assistDeps));
  }

  // notes.* (S15). Direkter Dateizugriff auf den Obsidian-Vault, kein n8n. Wie bei den
  // n8n-Tools: nur wenn `obsidian` ausdrücklich gesetzt ist — ein leeres `OBSIDIAN_VAULT_PATH`
  // in der Umgebung schaltet nichts frei und lässt den Fingerabdruck unverändert.
  if (config.obsidian) {
    const vault = await buildVaultRoot(
      config.obsidian.vaultPath ?? process.env.OBSIDIAN_VAULT_PATH,
    );
    registry.registerAll(
      createNotesTools({ pool: config.pool, artifactRoot: config.artifactRoot, vault }),
    );
  }

  // memory.* (S18). Wie `notes.*`: nur wenn ausdrücklich konfiguriert. Der Store wird hier
  // geöffnet und nicht erst im Runner, weil er zwei Verbraucher hat — die Tools im Katalog und
  // den Recall im Loop —, und beide müssen denselben Index sehen. Zwei Verbindungen auf
  // dieselbe SQLite-Datei wären zwei Sichten auf denselben Bestand, mit allen Fragen zur
  // Sichtbarkeit, die man sich damit einhandelt.
  let memory: MemoryStore | undefined;
  if (config.memory) {
    memory = await createMemoryStore({
      root: await buildMemoryRoot(config.memory.root),
      indexFile: config.memory.indexFile,
      git: config.memory.git,
    });
    registry.registerAll(createMemoryTools({ store: memory, pool: config.pool }));
  }

  const full = registry.freeze();

  // Hintergrundprofil (S17): auf die Whitelist einschränken und mit einem eigenen
  // Fingerabdruck neu einfrieren. Ein Tool aus der Liste, das gar nicht verdrahtet wurde
  // (z. B. `mail.*` ohne n8n), fällt still weg — die Whitelist ist eine Obergrenze, keine
  // Zusicherung.
  const catalog =
    config.profile === "background"
      ? new ToolRegistry()
          .registerAll(full.tools.filter((tool) => BACKGROUND_TOOLSET.includes(tool.name)))
          .freeze()
      : full;

  const rules =
    config.profile === "background" ? [...BACKGROUND_RULES, ...DEFAULT_RULES] : undefined;

  return {
    catalog,
    policy: createPolicyEngine({ resolvePath: policyResolver(zones), rules }),
    memory,
  };
}

export interface RunnerConfig extends Omit<LoopDeps, "conventions" | "signal" | "artifactRoot"> {
  threadId: string;
  channel: SessionChannel;
  artifactRoot?: string;
  /**
   * `kuronami.sessions.mode` bei der Neuanlage. Vorgabe: der Startwert `"execute"`. Der
   * Heartbeat (S17) setzt `"background"` — das Feld ist dokumentierend (die Governance-Schicht
   * hängt am Katalog- und Regelsatz, nicht an dieser Spalte), macht aber im Protokoll und in
   * der DevUI auf einen Blick sichtbar, dass eine Session ohne Nutzer läuft. Greift nur bei
   * der Neuanlage, wie alle `SessionDefaults` (S04).
   */
  sessionMode?: string;
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
  /**
   * Nach einem abgeschlossenen Lauf die strukturierte Zusammenfassung ziehen und — wenn der
   * Lauf etwas hinterlässt — als Notiz ablegen (S18, `tools/memory/summary.ts`).
   *
   * Vorgabe: an, sobald ein Gedächtnis verdrahtet ist **und** `completeOnDone` gilt. Die
   * Kopplung ist die Antwort auf die Frage, was „ein Lauf" ist: dort, wo ein fertiger Zug ein
   * fertiger Auftrag ist (Heartbeat, Aufgabe über die API, Test), ist er auch die Einheit, die
   * eine Erinnerung hinterlässt. Ein Kanal mit einer langen Unterhaltung (S16) setzt
   * `completeOnDone` ab, und dort wäre eine Notiz nach jeder Antwort falsch — sie beschriebe
   * einen Zwischenstand als Ergebnis. Wann eine **Unterhaltung** endet, weiß dieses System
   * noch nicht; siehe die offenen Befunde zu S18.
   */
  summarizeToMemory?: boolean;
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
 * Die Ereignisse **eines** Zugs, aus dem Protokoll geschnitten.
 *
 * Nötig, weil die Tool-Ereignisse seit S07 keine `turn_id` tragen — sie kennen ihre
 * `call_id`, nicht den Zug. Statt die Taxonomie dafür zu erweitern (ein bestehendes Ereignis
 * um ein Feld zu ergänzen ist die teurere Änderung: jeder Leser eines alten Protokolls müsste
 * mit seinem Fehlen rechnen), wird geschnitten: alles zwischen dem `turn.started` dieses Zugs
 * und dem nächsten `turn.started` gehört zu ihm. Das ist herleitbar und braucht keine
 * Migration.
 */
async function turnSlice(
  pool: Pool,
  sessionId: string,
  turnId: string,
): Promise<{ type: string; payload: Record<string, unknown> }[]> {
  const events = await readEvents(pool, sessionId);
  const start = events.findIndex(
    (event) => event.type === "turn.started" && event.payload.turn_id === turnId,
  );
  if (start === -1) return [];

  const slice: { type: string; payload: Record<string, unknown> }[] = [];
  for (let i = start; i < events.length; i += 1) {
    if (i > start && events[i].type === "turn.started") break;
    slice.push({ type: events[i].type, payload: events[i].payload as Record<string, unknown> });
  }
  return slice;
}

/** Die Eingabe, mit der dieser Zug begann. */
async function turnInput(pool: Pool, sessionId: string, turnId: string): Promise<string> {
  const slice = await turnSlice(pool, sessionId, turnId);
  const started = slice.find((event) => event.type === "turn.started");
  return typeof started?.payload.input === "string" ? started.payload.input : "";
}

/**
 * Was der Zug getan hat, als knappe Zeilen für die Zusammenfassung. Nur Toolname und
 * `summary` — der volle Verlauf gehört nicht in einen zweiten Modellaufruf, und die
 * Zusammenfassungen sind genau die Fassung, die das Tool selbst für die richtige hält.
 * Fehlgeschlagene Aufrufe stehen mit dabei: aus ihnen kommt oft die eigentliche Erkenntnis.
 */
async function turnSteps(pool: Pool, sessionId: string, turnId: string): Promise<string[]> {
  const slice = await turnSlice(pool, sessionId, turnId);
  const lines: string[] = [];
  for (const event of slice) {
    if (event.type !== "tool.completed" && event.type !== "tool.failed") continue;
    const name = typeof event.payload.tool_name === "string" ? event.payload.tool_name : "?";
    const summary = typeof event.payload.summary === "string" ? event.payload.summary : "";
    const mark = event.type === "tool.failed" ? "FEHLER" : "ok";
    lines.push(`- ${name} (${mark}): ${summary}`);
  }
  return lines;
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
  const memory = config.memory;
  const summarize = config.summarizeToMemory ?? (completeOnDone && memory !== undefined);

  const runtime: RuntimeHandle = await startRuntime(pool, {
    threadId: config.threadId,
    channel: config.channel,
    defaults: {
      mode: config.sessionMode,
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

      // Die Nachbereitung (S18): erst wenn der Lauf wirklich fertig ist. Nicht bei
      // `awaiting_user` (der Lauf ist offen, nicht vorbei), nicht bei `canceled` (er wurde
      // abgebrochen — daraus eine Erkenntnis abzuleiten hieße, ein halbes Ergebnis als ganzes
      // zu erinnern) und nicht an einer Grenze. `summarizeRun` wirft nie; ein Fehler dort
      // steht als `error.raised` im Protokoll und macht den geglückten Lauf nicht ungültig.
      if (summarize && result.stop === "done" && memory) {
        await summarizeRun({
          pool,
          model: config.model,
          catalog: config.catalog,
          policy: config.policy,
          artifactRoot,
          store: memory,
          session: runtime.session,
          turnId: result.turnId,
          input: await turnInput(pool, runtime.session.sessionId, result.turnId),
          outcomeText: result.text,
          steps: await turnSteps(pool, runtime.session.sessionId, result.turnId),
          signal: runtime.signal,
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
