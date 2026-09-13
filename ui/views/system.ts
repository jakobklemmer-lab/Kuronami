import { ApiError } from "../api/client.js";
import type { BusMessage } from "../events/bus.js";
import { icon } from "../icons.js";
import { type RunStatus, runStatusClass, runStatusLabel } from "../runs/status.js";
import type { View, ViewContext } from "./types.js";

/**
 * Die System-Ansicht — der bisherige Home-Inhalt (Läufe S22, Freigaben & Fehler S23, Plan,
 * Kennzahlen S24), unveraendert in seiner Anbindung, nur umgezogen: Home ist seit dem
 * UI-Zwischenschub das persoenliche Cockpit (`ui/views/home.ts`), nicht mehr der Ort für
 * Projekt-/Buildstatus. Diese Ansicht ist eine eigene, direkt aufrufbare Route (`#/system`) und
 * die einzige Ansicht ausser `main.ts`s Hülle, die `ctx.api`/`ctx.bus` tatsächlich benutzt — der
 * Rest der Detailansichten läuft gegen Mock-Daten.
 *
 * Wie `ui/main.ts` vor diesem Umbau bleibt diese Datei aus Prinzip ungetestet: die eigentliche
 * Logik (Formatierung, Statusableitung) steht in geprueften Modulen (`ui/runs/status.ts`,
 * `ui/events/bus.ts`); hier steht nur die DOM-Verdrahtung.
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

/** Eine Zeile aus `/costs` (S28, `context/costs.ts`). */
interface AgentDaySpend {
  day: string;
  agent: string;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  unpricedCalls: number;
  unpricedModels: string[];
}

interface SpendReport {
  days: AgentDaySpend[];
  totals: { costUsd: number; modelCalls: number; unpricedCalls: number };
  windowDays: number;
  pricingAsOf: string;
}

interface PendingResponse {
  pending: PendingApproval[];
}

const ERROR_EVENT_TYPES = new Set(["step.failed", "tool.failed", "session.failed", "error.raised"]);
const ERROR_LIMIT = 20;
const REFRESH_DEBOUNCE_MS = 400;

function describeApiError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === "no_token") return "Kein Token hinterlegt — siehe Einstellungen › System.";
    if (error.status === 401) return "Token abgelehnt — in den Einstellungen › System prüfen.";
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

export const systemView: View = {
  mount(container: HTMLElement, ctx: ViewContext) {
    container.innerHTML = `
      <div class="detail-view">
        <header class="detail-view__head">
          ${icon("system", { className: "detail-view__icon" })}
          <div>
            <h1 class="detail-view__title">System</h1>
            <p class="detail-view__subtitle">Läufe, Freigaben, Fehler und Kennzahlen — echte Daten über das Gateway.</p>
          </div>
        </header>

        <div class="system-grid">
          <section class="card glass card--runs" aria-labelledby="panel-runs-title">
            <header class="card__head">
              ${icon("system", { className: "card__icon" })}
              <h2 class="card__title" id="panel-runs-title">Läufe</h2>
            </header>
            <p class="card__hint" data-role="runs-hint">Ohne Token keine Liste — siehe Einstellungen › System.</p>
            <ul class="card__runs-list" data-role="runs-list" hidden></ul>
            <div class="run-detail" data-role="run-detail" hidden>
              <button class="run-detail__back" type="button" data-role="run-detail-back">← Läufe</button>
              <div class="run-detail__head">
                <span class="run-status" data-role="run-detail-status"></span>
                <code data-role="run-detail-id"></code>
              </div>
              <ol class="run-detail__steps" data-role="run-detail-steps"></ol>
            </div>
          </section>

          <section class="card glass card--approvals" aria-labelledby="panel-approvals-title">
            <header class="card__head">
              ${icon("bell", { className: "card__icon" })}
              <h2 class="card__title" id="panel-approvals-title">Freigaben &amp; Fehler</h2>
            </header>
            <p class="card__hint" data-role="approvals-hint">Ohne Token keine Rückfragen — siehe Einstellungen › System.</p>
            <ul class="card__approvals-list" data-role="approvals-list"></ul>
            <p class="card__empty" data-role="approvals-empty">Nichts offen.</p>
            <h3 class="card__subtitle">Fehler</h3>
            <ul class="card__errors-list" data-role="errors-list"></ul>
            <p class="card__empty" data-role="errors-empty">Keiner seit dem Öffnen.</p>
          </section>

          <section class="card glass card--plan" aria-labelledby="panel-plan-title">
            <header class="card__head">
              ${icon("check", { className: "card__icon" })}
              <h2 class="card__title" id="panel-plan-title">Plan</h2>
            </header>
            <p class="card__hint">Aufgaben aus <code>task.*</code>.</p>
            <dl class="card__figures">
              <div class="figure"><dt>dazugekommen</dt><dd data-role="tasks-added">0</dd></div>
              <div class="figure"><dt>fertig</dt><dd data-role="tasks-done">0</dd></div>
            </dl>
          </section>

          <section class="card glass card--metrics" aria-labelledby="panel-metrics-title">
            <header class="card__head">
              ${icon("research", { className: "card__icon" })}
              <h2 class="card__title" id="panel-metrics-title">Kennzahlen</h2>
            </header>
            <p class="card__hint">Verbindung und Abschnitt 12, über alle Runs summiert.</p>
            <dl class="card__figures">
              <div class="figure"><dt>Ereignisse</dt><dd data-role="event-count">0</dd></div>
              <div class="figure"><dt>Versuche</dt><dd data-role="reconnect-count">0</dd></div>
              <div class="figure"><dt>Modellaufrufe</dt><dd data-role="metric-model-calls">–</dd></div>
              <div class="figure"><dt>Tool-Aufrufe</dt><dd data-role="metric-tool-calls">–</dd></div>
              <div class="figure"><dt>Cache-Trefferquote</dt><dd data-role="metric-cache-hit-rate">–</dd></div>
              <div class="figure"><dt>Rückfragen</dt><dd data-role="metric-approvals">–</dd></div>
            </dl>
          </section>

          <section class="card glass card--costs" aria-labelledby="panel-costs-title">
            <header class="card__head">
              ${icon("trading", { className: "card__icon" })}
              <h2 class="card__title" id="panel-costs-title">Kosten je Agent und Tag</h2>
              <span class="card__meta" data-role="costs-meta"></span>
            </header>
            <p class="card__hint" data-role="costs-hint">Lädt …</p>
            <table class="spend-table" data-role="costs-table" hidden>
              <thead>
                <tr><th>Tag</th><th>Agent</th><th>Aufrufe</th><th>Eingabe</th><th>Ausgabe</th><th>Cache</th><th>Kosten</th></tr>
              </thead>
              <tbody data-role="costs-rows"></tbody>
            </table>
          </section>
        </div>
      </div>
    `;

    const q = <T extends HTMLElement>(role: string) =>
      container.querySelector<T>(`[data-role="${role}"]`) as T;

    const runsHint = q<HTMLElement>("runs-hint");
    const runsList = q<HTMLElement>("runs-list");
    const runDetail = q<HTMLElement>("run-detail");
    const runDetailStatus = q<HTMLElement>("run-detail-status");
    const runDetailId = q<HTMLElement>("run-detail-id");
    const runDetailSteps = q<HTMLElement>("run-detail-steps");
    const metricModelCalls = q<HTMLElement>("metric-model-calls");
    const metricToolCalls = q<HTMLElement>("metric-tool-calls");
    const metricCacheHitRate = q<HTMLElement>("metric-cache-hit-rate");
    const metricApprovals = q<HTMLElement>("metric-approvals");
    const approvalsHint = q<HTMLElement>("approvals-hint");
    const approvalsList = q<HTMLElement>("approvals-list");
    const approvalsEmpty = q<HTMLElement>("approvals-empty");
    const errorsList = q<HTMLElement>("errors-list");
    const errorsEmpty = q<HTMLElement>("errors-empty");
    const eventCount = q<HTMLElement>("event-count");
    const reconnectCount = q<HTMLElement>("reconnect-count");
    const tasksAdded = q<HTMLElement>("tasks-added");
    const tasksDone = q<HTMLElement>("tasks-done");

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
            link.innerHTML = `${icon("artifact", { className: "run-step__artifact-icon" })} ${artifact.summary} (${artifact.mimeType})`;
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
        const detail = await ctx.api.get<RunDetail>(`/runs/${encodeURIComponent(sessionId)}`);
        renderRunDetail(detail);
      } catch (error) {
        runDetailId.textContent = describeApiError(error);
      }
    }

    q<HTMLButtonElement>("run-detail-back").addEventListener("click", () => {
      openRunId = null;
      runDetail.hidden = true;
      runsList.hidden = false;
    });

    async function refreshRuns(): Promise<void> {
      try {
        const data = await ctx.api.get<RunsResponse>("/runs");
        runsHint.hidden = true;
        renderRunsList(data.runs);
        renderMetrics(data.metrics);
        if (openRunId) {
          const detail = await ctx.api.get<RunDetail>(`/runs/${encodeURIComponent(openRunId)}`);
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

    /**
     * Tagesausgaben je Agent (S28). Ein unbepreister Aufruf wird als solcher ausgewiesen und
     * nicht als 0 verbucht — sonst sähe ein unvollständiger Betrag aus wie ein günstiger.
     */
    async function refreshCosts(): Promise<void> {
      const hint = q<HTMLElement>("costs-hint");
      const table = q<HTMLTableElement>("costs-table");
      const rows = q<HTMLElement>("costs-rows");
      const meta = q<HTMLElement>("costs-meta");
      try {
        const report = await ctx.api.get<SpendReport>("/costs");
        const money = (value: number) =>
          `$${value.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        const tokens = (value: number) => value.toLocaleString("de-DE");

        meta.textContent = `${report.windowDays} Tage · ${money(report.totals.costUsd)} · Preise vom ${report.pricingAsOf}`;

        if (report.days.length === 0) {
          table.hidden = true;
          hint.hidden = false;
          hint.textContent = "Keine Modellaufrufe im Fenster.";
          return;
        }

        rows.innerHTML = report.days
          .map(
            (entry) => `
              <tr>
                <td>${entry.day}</td>
                <td>${entry.agent}</td>
                <td class="spend-table__num">${entry.modelCalls}</td>
                <td class="spend-table__num">${tokens(entry.inputTokens)}</td>
                <td class="spend-table__num">${tokens(entry.outputTokens)}</td>
                <td class="spend-table__num">${tokens(entry.cacheReadTokens + entry.cacheCreationTokens)}</td>
                <td class="spend-table__num">${money(entry.costUsd)}${
                  entry.unpricedCalls > 0
                    ? `<span class="spend-table__warn" title="Ohne Preis in der Tabelle: ${entry.unpricedModels.join(", ")}"> +${entry.unpricedCalls} ohne Preis</span>`
                    : ""
                }</td>
              </tr>
            `,
          )
          .join("");
        table.hidden = false;
        hint.hidden = true;
      } catch (error) {
        table.hidden = true;
        hint.hidden = false;
        hint.textContent = describeApiError(error);
        meta.textContent = "";
      }
    }

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
        await ctx.api.post("/channels/web/answers", { askId, choiceId });
        await refreshApprovals();
        scheduleRefresh();
      } catch (error) {
        approvalsHint.hidden = false;
        approvalsHint.textContent = describeApiError(error);
      }
    }

    async function refreshApprovals(): Promise<void> {
      try {
        const data = await ctx.api.get<PendingResponse>("/channels/web/pending");
        approvalsHint.hidden = true;
        renderApprovals(data.pending);
      } catch (error) {
        approvalsHint.hidden = false;
        approvalsHint.textContent = describeApiError(error);
        renderApprovals([]);
      }
    }

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

    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    function scheduleRefresh(): void {
      if (refreshTimer !== null) return;
      refreshTimer = globalThis.setTimeout(() => {
        refreshTimer = null;
        void refreshRuns();
        void refreshApprovals();
        void refreshCosts();
      }, REFRESH_DEBOUNCE_MS);
    }

    let seen = 0;
    let added = 0;
    let done = 0;

    const unsubscribeMessage = ctx.bus.onMessage((message: BusMessage) => {
      seen += 1;
      eventCount.textContent = String(seen);
      if (message.type === "bus.connected") return;
      if (ERROR_EVENT_TYPES.has(message.type)) recordError(message);
      scheduleRefresh();
    });
    const unsubscribeStatus = ctx.bus.onStatus((_status, attempts) => {
      reconnectCount.textContent = String(attempts);
    });
    const unsubscribeAdded = ctx.bus.on("task_added", () => {
      added += 1;
      tasksAdded.textContent = String(added);
    });
    const unsubscribeDone = ctx.bus.on("task_done", () => {
      done += 1;
      tasksDone.textContent = String(done);
    });

    void refreshRuns();
    void refreshApprovals();
    void refreshCosts();

    return () => {
      if (refreshTimer !== null) globalThis.clearTimeout(refreshTimer);
      unsubscribeMessage();
      unsubscribeStatus();
      unsubscribeAdded();
      unsubscribeDone();
    };
  },
};
