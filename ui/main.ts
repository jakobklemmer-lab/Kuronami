import { ApiError, createApiClient } from "./api/client.js";
import { createRippleRenderer } from "./canvas/ripples.js";
import { type BusMessage, type UiState, createEventBus } from "./events/bus.js";
import { type RunStatus, runStatusClass, runStatusLabel } from "./runs/status.js";
import { loadToken, saveToken } from "./settings.js";

/**
 * Die Verdrahtung (S21, seit S22-S24 mit echtem Inhalt): Ereignisstrom → Zustand → Wasser und
 * Anzeige, dazu die Runs-Liste/-Detail (S22), Freigaben und Fehler (S23) und Kennzahlen (S24)
 * über den authentifizierten HTTP-Client (`api/client.ts`).
 *
 * Bewusst die einzige Datei der Oberfläche, die das Dokument anfasst. Alle anderen Module
 * kennen weder `document` noch `window` und bleiben dadurch ohne Browser prüfbar; hier steht
 * dafür jede Entscheidung, die einen DOM-Knoten braucht.
 */

interface RunSummary {
  sessionId: string;
  threadId: string;
  channel: string;
  createdAt: string;
  status: RunStatus | null;
  stepCount: number;
  pendingUserInput: number;
  foldError: string | null;
}

interface RunMetrics {
  modelCalls: number;
  toolCalls: number;
  failedToolCalls: number;
  cacheHitRate: number;
  approvalsRequested: number;
}

interface RunsResponse {
  runs: RunSummary[];
  metrics: RunMetrics;
}

interface RunStepArtifact {
  uri: string;
  mimeType: string;
  summary: string;
}

interface RunStepView {
  stepId: string;
  toolName: string | null;
  status: string;
  attempt: number;
  error: string | null;
  artifacts: RunStepArtifact[];
}

interface RunDetail {
  sessionId: string;
  channel: string;
  status: RunStatus | null;
  steps: RunStepView[];
}

interface AskOption {
  id: string;
  label: string;
}

interface PendingApproval {
  askId: string;
  question: string;
  options: AskOption[];
}

interface PendingResponse {
  pending: PendingApproval[];
}

const STATE_LABEL: Record<UiState, string> = {
  idle: "ruhig",
  processing: "arbeitet",
  speaking: "antwortet",
  complete: "fertig",
};

const STATUS_LABEL = {
  connecting: "verbindet",
  open: "verbunden",
  closed: "getrennt",
} as const;

/** Ereignistypen, die einen bleibenden Eintrag im Fehler-Verlauf verdienen (S23) — bewusst
 * eine handvoll, keine Ableitung aus der ganzen Taxonomie, dasselbe Prinzip wie `signalFor`
 * in `ui/events/bus.ts`: eine Stelle, eine reine Zuordnung. */
const ERROR_EVENT_TYPES = new Set(["step.failed", "tool.failed", "session.failed", "error.raised"]);

/** Wie viele Fehler das Panel hält, bevor die ältesten verschwinden. */
const ERROR_LIMIT = 20;

/** Wartezeit, bevor ein Ereignis die Runs-/Freigabenliste neu lädt — ein Zug löst mehrere
 * Ereignisse kurz hintereinander aus, und jedes einzelne einen eigenen Abruf wäre unnötiger
 * Verkehr für dieselbe, sich noch ändernde Antwort. */
const REFRESH_DEBOUNCE_MS = 400;

function element<T extends Element>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`Das Grundgerüst hat kein Element mit der id "${id}".`);
  return found as unknown as T;
}

function startClock(target: HTMLElement): void {
  const tick = (): void => {
    target.textContent = new Date().toLocaleTimeString("de-DE", { hour12: false });
  };
  tick();
  globalThis.setInterval(tick, 1000);
}

/** Eine Fehlermeldung, die auch ohne Netz und ohne Token etwas Konkretes sagt (AGENTS.md:
 * Fehler nie verstecken oder glätten). */
function describeApiError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === "no_token") return "Kein Token hinterlegt — siehe Einstellungen (⚙).";
    if (error.status === 401) return "Token abgelehnt — in den Einstellungen prüfen.";
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 16)}…` : id;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("de-DE", { hour12: false });
}

function main(): void {
  const canvas = element<HTMLCanvasElement>("ripples");
  const stateBadge = element<HTMLElement>("state-badge");
  const connection = element<HTMLElement>("connection");
  const eventCount = element<HTMLElement>("event-count");
  const reconnectCount = element<HTMLElement>("reconnect-count");
  const tasksAdded = element<HTMLElement>("tasks-added");
  const tasksDone = element<HTMLElement>("tasks-done");
  const notificationCount = element<HTMLElement>("notification-count");

  const runsHint = element<HTMLElement>("runs-hint");
  const runsList = element<HTMLElement>("runs-list");
  const runDetail = element<HTMLElement>("run-detail");
  const runDetailStatus = element<HTMLElement>("run-detail-status");
  const runDetailId = element<HTMLElement>("run-detail-id");
  const runDetailSteps = element<HTMLElement>("run-detail-steps");

  const metricModelCalls = element<HTMLElement>("metric-model-calls");
  const metricToolCalls = element<HTMLElement>("metric-tool-calls");
  const metricCacheHitRate = element<HTMLElement>("metric-cache-hit-rate");
  const metricApprovals = element<HTMLElement>("metric-approvals");

  const approvalsHint = element<HTMLElement>("approvals-hint");
  const approvalsList = element<HTMLElement>("approvals-list");
  const approvalsEmpty = element<HTMLElement>("approvals-empty");
  const errorsList = element<HTMLElement>("errors-list");
  const errorsEmpty = element<HTMLElement>("errors-empty");

  const settingsButton = element<HTMLButtonElement>("settings");
  const settingsPanel = element<HTMLElement>("settings-panel");
  const settingsToken = element<HTMLInputElement>("settings-token");
  const settingsSave = element<HTMLButtonElement>("settings-save");
  const settingsStatus = element<HTMLElement>("settings-status");

  startClock(element<HTMLElement>("clock"));

  const ripples = createRippleRenderer({ canvas });
  ripples.start();
  globalThis.addEventListener("resize", () => ripples.resize());

  // Der Port des Backends lässt sich über `?events=3005` überschreiben — historisch der Name
  // für den Ereignisstrom (S21), seit S22 aber auch die Basis für `/runs` und `/channels/*`:
  // wer auf einen anderen Prozess zeigt (typischerweise `pnpm gateway` statt `pnpm dev`),
  // bekommt beides von dort, nicht den Strom von hier und die REST-Antworten von woanders.
  const params = new URLSearchParams(globalThis.location.search);
  const backendPort = params.get("events") ?? "3000";
  const hostname = globalThis.location.hostname || "localhost";
  const backendOrigin = `http://${hostname}:${backendPort}`;
  const bus = createEventBus({ url: `ws://${hostname}:${backendPort}/events` });
  const api = createApiClient({ baseUrl: backendOrigin, token: () => loadToken() });

  // ---------------------------------------------------------------------
  // Einstellungen (S22): der Bearer-Token, den /runs und /channels/web/* verlangen.
  // ---------------------------------------------------------------------
  settingsToken.value = loadToken() ?? "";
  settingsButton.addEventListener("click", () => {
    settingsPanel.hidden = !settingsPanel.hidden;
  });
  settingsSave.addEventListener("click", () => {
    saveToken(settingsToken.value.trim());
    settingsStatus.textContent = "Gespeichert.";
    globalThis.setTimeout(() => {
      settingsStatus.textContent = "";
    }, 2000);
    void refreshRuns();
    void refreshApprovals();
  });

  // ---------------------------------------------------------------------
  // Läufe (S22): Liste und Detail, gefüttert aus /runs bzw. /runs/:id.
  // ---------------------------------------------------------------------
  let openRunId: string | null = null;

  function renderRunsList(runs: RunSummary[]): void {
    runsList.hidden = false;
    runsList.replaceChildren(
      ...runs.map((run) => {
        const item = document.createElement("li");
        item.className = "run-row";
        const badge = document.createElement("span");
        badge.className = runStatusClass(run.status);
        badge.textContent = runStatusLabel(run.status);
        const label = document.createElement("span");
        label.className = "run-row__id";
        label.textContent = `${shortId(run.sessionId)} · ${run.channel}`;
        const meta = document.createElement("span");
        meta.className = "run-row__meta";
        meta.textContent =
          run.foldError ??
          `${run.stepCount} Schritt(e)${run.pendingUserInput > 0 ? " · Rückfrage" : ""}`;
        item.append(badge, label, meta);
        item.addEventListener("click", () => void openRun(run.sessionId));
        return item;
      }),
    );
  }

  function renderRunDetail(detail: RunDetail): void {
    runDetailStatus.className = runStatusClass(detail.status);
    runDetailStatus.textContent = runStatusLabel(detail.status);
    runDetailId.textContent = `${detail.sessionId} · ${detail.channel}`;
    runDetailSteps.replaceChildren(
      ...detail.steps.map((step) => {
        const item = document.createElement("li");
        item.className = `run-step run-step--${step.status}`;
        const head = document.createElement("div");
        head.textContent = `${step.toolName ?? "(ohne Werkzeug)"} — ${step.status}`;
        item.append(head);
        if (step.error) {
          const error = document.createElement("p");
          error.className = "run-step__error";
          error.textContent = step.error;
          item.append(error);
        }
        for (const artifact of step.artifacts) {
          const link = document.createElement("p");
          link.className = "run-step__artifact";
          link.textContent = `📄 ${artifact.summary} (${artifact.mimeType})`;
          item.append(link);
        }
        return item;
      }),
    );
  }

  async function openRun(sessionId: string): Promise<void> {
    openRunId = sessionId;
    runsList.hidden = true;
    runDetail.hidden = false;
    try {
      const detail = await api.get<RunDetail>(`/runs/${encodeURIComponent(sessionId)}`);
      renderRunDetail(detail);
    } catch (error) {
      runDetailId.textContent = describeApiError(error);
    }
  }

  element<HTMLButtonElement>("run-detail-back").addEventListener("click", () => {
    openRunId = null;
    runDetail.hidden = true;
    runsList.hidden = false;
  });

  async function refreshRuns(): Promise<void> {
    try {
      const data = await api.get<RunsResponse>("/runs");
      runsHint.hidden = true;
      renderRunsList(data.runs);
      renderMetrics(data.metrics);
      if (openRunId) {
        const detail = await api.get<RunDetail>(`/runs/${encodeURIComponent(openRunId)}`);
        renderRunDetail(detail);
      }
    } catch (error) {
      runsHint.hidden = false;
      runsHint.textContent = describeApiError(error);
      runsList.hidden = true;
    }
  }

  function renderMetrics(metrics: RunMetrics): void {
    metricModelCalls.textContent = String(metrics.modelCalls);
    metricToolCalls.textContent = `${metrics.toolCalls} (${metrics.failedToolCalls} fehlgeschlagen)`;
    metricCacheHitRate.textContent = `${(metrics.cacheHitRate * 100).toFixed(1)} %`;
    metricApprovals.textContent = String(metrics.approvalsRequested);
  }

  // ---------------------------------------------------------------------
  // Freigaben (S23): offene Rückfragen aus /channels/web/pending beantworten.
  // ---------------------------------------------------------------------
  function renderApprovals(pending: PendingApproval[]): void {
    approvalsEmpty.hidden = pending.length > 0;
    approvalsList.replaceChildren(
      ...pending.map((ask) => {
        const item = document.createElement("li");
        item.className = "approval-row";
        const question = document.createElement("p");
        question.textContent = ask.question;
        item.append(question);
        const options = document.createElement("div");
        options.className = "approval-row__options";
        for (const option of ask.options) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = option.label;
          button.addEventListener("click", () => void answerApproval(ask.askId, option.id));
          options.append(button);
        }
        item.append(options);
        return item;
      }),
    );
  }

  async function answerApproval(askId: string, choiceId: string): Promise<void> {
    try {
      await api.post("/channels/web/answers", { askId, choiceId });
      await refreshApprovals();
      scheduleRefresh();
    } catch (error) {
      approvalsHint.hidden = false;
      approvalsHint.textContent = describeApiError(error);
    }
  }

  async function refreshApprovals(): Promise<void> {
    try {
      const data = await api.get<PendingResponse>("/channels/web/pending");
      approvalsHint.hidden = true;
      renderApprovals(data.pending);
    } catch (error) {
      approvalsHint.hidden = false;
      approvalsHint.textContent = describeApiError(error);
      renderApprovals([]);
    }
  }

  // ---------------------------------------------------------------------
  // Fehler (S23): bleibt sichtbar, solange die Seite offen ist — kein roter Punkt, der mit
  // dem nächsten Ereignis wieder verschwindet.
  // ---------------------------------------------------------------------
  function recordError(message: BusMessage): void {
    errorsEmpty.hidden = true;
    const item = document.createElement("li");
    item.className = "error-row";
    const stamp = document.createElement("time");
    stamp.dateTime = message.timestamp;
    stamp.textContent = formatTime(message.timestamp);
    const label = document.createElement("span");
    const reason =
      typeof message.data?.error === "string"
        ? message.data.error
        : typeof message.data?.reason === "string"
          ? message.data.reason
          : message.type;
    label.textContent = `${message.type}: ${reason}`;
    item.append(stamp, label);
    errorsList.prepend(item);
    while (errorsList.childElementCount > ERROR_LIMIT) errorsList.lastElementChild?.remove();
  }

  // ---------------------------------------------------------------------
  // Ereignisstrom → Wasser, Taskbar, Plansignale (S21) und ein gebündeltes Neuladen der
  // Läufe-/Freigabenliste (S22/S23): viele Ereignisse eines Zugs sollen genau einen Abruf
  // auslösen, nicht einen je Ereignis.
  // ---------------------------------------------------------------------
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleRefresh(): void {
    if (refreshTimer !== null) return;
    refreshTimer = globalThis.setTimeout(() => {
      refreshTimer = null;
      void refreshRuns();
      void refreshApprovals();
    }, REFRESH_DEBOUNCE_MS);
  }

  let seen = 0;
  let added = 0;
  let done = 0;
  let unread = 0;

  bus.onState((state) => {
    document.body.dataset.uiState = state;
    stateBadge.dataset.uiState = state;
    stateBadge.textContent = STATE_LABEL[state];
    ripples.setState(state);
  });

  bus.onStatus((status, attempts) => {
    connection.dataset.status = status;
    connection.textContent =
      status === "connecting" && attempts > 0
        ? `${STATUS_LABEL.connecting} (${attempts})`
        : STATUS_LABEL[status];
    reconnectCount.textContent = String(attempts);
  });

  bus.onMessage((message: BusMessage) => {
    seen += 1;
    eventCount.textContent = String(seen);
    if (message.type === "bus.connected") return;
    if (ERROR_EVENT_TYPES.has(message.type)) recordError(message);
    scheduleRefresh();
  });

  bus.on("task_added", () => {
    added += 1;
    tasksAdded.textContent = String(added);
  });
  bus.on("task_done", () => {
    done += 1;
    tasksDone.textContent = String(done);
  });
  bus.on("speaking", () => {
    unread += 1;
    notificationCount.textContent = String(unread);
    notificationCount.hidden = false;
  });

  element<HTMLElement>("notifications").addEventListener("click", () => {
    unread = 0;
    notificationCount.hidden = true;
  });

  bus.connect();
  void refreshRuns();
  void refreshApprovals();
}

main();
