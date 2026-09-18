import { ApiError } from "../api/client.js";
import { icon } from "../icons.js";
import type {
  MarketChart,
  MarketQuote,
  MarketQuotesData,
  MarketSearchHit,
} from "../integrations/types.js";
import { describeQuoteType, formatChange, formatPercent, formatPrice } from "../markets/format.js";
import {
  addSymbol,
  hasSymbol,
  loadWatchlist,
  recallSelectedSymbol,
  removeSymbol,
  saveWatchlist,
} from "../markets/watchlist.js";
import { createChart } from "../vendor/lightweight-charts.standalone.production.mjs";
import type {
  CandlestickSeriesApi,
  ChartApi,
} from "../vendor/lightweight-charts.standalone.production.mjs";
import { sparklinePoints } from "./chart.js";
import { escapeHtml } from "./html.js";
import type { View, ViewContext } from "./types.js";

/**
 * Die Trading-Ansicht (Neubau 2026-09-16). Drei Dinge, eine Seite: eine Suche über alles, was
 * Yahoo Finance kennt (Aktien, Indizes, ETFs, Devisen, Krypto), die eigene Beobachtungsliste
 * links, der Chart des gewählten Symbols rechts mit dem Kurs groß darüber. Alle Daten kommen über
 * das Gateway (`/integrations/markets/*`), nichts steht fest im Code — die Liste gehört dem Nutzer
 * (`settings.markets.watchlist`), die Vorgabe ist nur ein Startpunkt.
 *
 * Yahoo hat keinen öffentlichen Live-Strom, deshalb Abfrage im Takt: Kurse alle 30 s, der Chart
 * jede Minute. Für Tages- und Wochenkerzen ist das mehr als genug, für Minutenkerzen ehrlich
 * „fast live" — der Zeitstempel unter dem Chart sagt, wie alt der Stand ist.
 */

const RANGES = [
  { id: "1d", label: "1T" },
  { id: "5d", label: "5T" },
  { id: "1mo", label: "1M" },
  { id: "3mo", label: "3M" },
  { id: "6mo", label: "6M" },
  { id: "1y", label: "1J" },
  { id: "5y", label: "5J" },
  { id: "max", label: "Max" },
] as const;
type RangeId = (typeof RANGES)[number]["id"];

const CHART_HEIGHT = 420;
const QUOTES_EVERY_MS = 30_000;
const CHART_EVERY_MS = 60_000;
const SEARCH_DEBOUNCE_MS = 220;

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
}

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === "no_token") return "Kein Token hinterlegt — siehe Einstellungen › System.";
    if (error.status === 401) return "Token abgelehnt — in den Einstellungen › System prüfen.";
    if (error.status === 404) return "Marktdaten sind auf diesem Gateway nicht eingerichtet.";
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function clockNow(): string {
  return new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

function watchRow(quote: MarketQuote, symbol: string, selected: boolean): string {
  const up = quote.changePct >= 0;
  const tone = up ? "up" : "down";
  const safe = escapeHtml(symbol);
  return `
    <li class="watch-row${selected ? " is-selected" : ""}" data-symbol="${safe}"
        tabindex="0" role="option" aria-selected="${selected ? "true" : "false"}">
      <span class="watch-row__symbol">${safe}</span>
      <span class="watch-row__price">${escapeHtml(formatPrice(quote.price))}</span>
      <span class="watch-row__name">${escapeHtml(quote.name)}</span>
      <span class="watch-row__change watch-row__change--${tone}">${escapeHtml(formatPercent(quote.changePct))}</span>
      <svg class="watch-row__spark" viewBox="0 0 64 18" fill="none"
        stroke="var(--state-${tone})" stroke-width="1.3" stroke-linecap="round"
        stroke-linejoin="round" aria-hidden="true">
        <polyline points="${sparklinePoints(quote.spark, 64, 18)}" />
      </svg>
      <button class="watch-row__remove" type="button" data-remove="${safe}"
        aria-label="${safe} aus der Liste entfernen">${icon("close")}</button>
    </li>
  `;
}

function pendingRow(symbol: string, selected: boolean, failed: boolean): string {
  const safe = escapeHtml(symbol);
  return `
    <li class="watch-row watch-row--pending${selected ? " is-selected" : ""}" data-symbol="${safe}"
        tabindex="0" role="option" aria-selected="${selected ? "true" : "false"}">
      <span class="watch-row__symbol">${safe}</span>
      <span class="watch-row__price">${failed ? "—" : "…"}</span>
      <span class="watch-row__name">${failed ? "Kein Kurs von Yahoo Finance" : "Lädt"}</span>
      <span class="watch-row__change"></span>
      <span class="watch-row__spark"></span>
      <button class="watch-row__remove" type="button" data-remove="${safe}"
        aria-label="${safe} aus der Liste entfernen">${icon("close")}</button>
    </li>
  `;
}

function searchHitRow(hit: MarketSearchHit, alreadyListed: boolean): string {
  const meta = [hit.exchange, describeQuoteType(hit.type)].filter((s) => s.length > 0).join(" · ");
  return `
    <li>
      <button class="search-hit" type="button" data-hit="${escapeHtml(hit.symbol)}">
        <span class="search-hit__symbol">${escapeHtml(hit.symbol)}</span>
        <span class="search-hit__name">${escapeHtml(hit.name)}</span>
        <span class="search-hit__meta">${escapeHtml(meta)}</span>
        <span class="search-hit__action">${alreadyListed ? "Anzeigen" : "Hinzufügen"}</span>
      </button>
    </li>
  `;
}

export const tradingView: View = {
  mount(container: HTMLElement, ctx: ViewContext) {
    let watchlist = loadWatchlist();
    const remembered = recallSelectedSymbol();
    let selected: string | null =
      remembered && hasSymbol(watchlist, remembered) ? remembered : (watchlist[0] ?? null);
    let range: RangeId = "1d";
    let quotesBySymbol = new Map<string, MarketQuote>();
    let failedSymbols = new Set<string>();

    container.innerHTML = `
      <div class="detail-view trading">
        <header class="detail-view__head">
          ${icon("trading", { className: "detail-view__icon" })}
          <div>
            <h1 class="detail-view__title">Trading</h1>
            <p class="detail-view__subtitle" data-role="subtitle">Yahoo Finance · lädt …</p>
          </div>
        </header>

        <div class="search">
          <label class="search__field glass">
            ${icon("research", { className: "search__icon" })}
            <input class="search__input" type="search" data-role="search" autocomplete="off"
              spellcheck="false" placeholder="Aktie, Index, ETF, Devise oder Krypto suchen — z. B. Apple, DAX, BTC-USD"
              aria-label="Symbol suchen" />
          </label>
          <ul class="search__results glass" data-role="results" hidden></ul>
        </div>

        <div class="trading__body">
          <section class="detail-panel glass watchlist" aria-label="Beobachtungsliste">
            <header class="watchlist__head">
              <h2 class="watchlist__title">Beobachtungsliste</h2>
              <span class="watchlist__count" data-role="count"></span>
            </header>
            <ul class="watchlist__list" data-role="watchlist" role="listbox" aria-label="Symbole"></ul>
          </section>

          <section class="detail-panel glass quote-panel" aria-live="polite">
            <div class="quote-panel__head">
              <div class="quote-panel__ident">
                <h2 class="quote-panel__name" data-role="q-name">—</h2>
                <p class="quote-panel__meta" data-role="q-meta"></p>
              </div>
              <div class="quote-panel__price-block">
                <p class="quote-panel__price" data-role="q-price"></p>
                <p class="quote-panel__change" data-role="q-change"></p>
              </div>
            </div>
            <div class="quote-panel__ranges" data-role="ranges" role="tablist" aria-label="Zeitraum">
              ${RANGES.map(
                (entry) =>
                  `<button type="button" role="tab" class="chart-panel__interval${entry.id === range ? " is-active" : ""}" data-range="${entry.id}" aria-selected="${entry.id === range ? "true" : "false"}">${entry.label}</button>`,
              ).join("")}
            </div>
            <div class="quote-panel__chart" data-role="chart"></div>
            <p class="chart-panel__hint" data-role="chart-hint"></p>
          </section>
        </div>
      </div>
    `;

    const role = <T extends HTMLElement>(name: string): T | null =>
      container.querySelector<T>(`[data-role="${name}"]`);
    const subtitleEl = role<HTMLElement>("subtitle");
    const searchEl = role<HTMLInputElement>("search");
    const resultsEl = role<HTMLElement>("results");
    const listEl = role<HTMLElement>("watchlist");
    const countEl = role<HTMLElement>("count");
    const nameEl = role<HTMLElement>("q-name");
    const metaEl = role<HTMLElement>("q-meta");
    const priceEl = role<HTMLElement>("q-price");
    const changeEl = role<HTMLElement>("q-change");
    const chartHostEl = role<HTMLElement>("chart");
    const chartHintEl = role<HTMLElement>("chart-hint");
    const rangeButtons = Array.from(container.querySelectorAll<HTMLButtonElement>("[data-range]"));

    let chart: ChartApi | null = null;
    let series: CandlestickSeriesApi | null = null;
    let disposed = false;
    let chartToken = 0;
    let searchToken = 0;
    let searchTimer: ReturnType<typeof setTimeout> | null = null;

    // --- Beobachtungsliste --------------------------------------------------

    function renderWatchlist(): void {
      if (!listEl) return;
      if (countEl) countEl.textContent = watchlist.length > 0 ? `${watchlist.length}` : "";
      if (watchlist.length === 0) {
        listEl.innerHTML =
          '<li class="watchlist__empty">Noch leer. Oben ein Symbol suchen und hinzufügen.</li>';
        return;
      }
      listEl.innerHTML = watchlist
        .map((symbol) => {
          const quote = quotesBySymbol.get(symbol);
          const isSelected = symbol === selected;
          return quote
            ? watchRow(quote, symbol, isSelected)
            : pendingRow(symbol, isSelected, failedSymbols.has(symbol));
        })
        .join("");
    }

    async function refreshQuotes(): Promise<void> {
      if (watchlist.length === 0) {
        quotesBySymbol = new Map();
        renderWatchlist();
        if (subtitleEl) subtitleEl.textContent = "Yahoo Finance";
        return;
      }
      try {
        const data = await ctx.api.get<MarketQuotesData>(
          `/integrations/markets/quotes?symbols=${encodeURIComponent(watchlist.join(","))}`,
        );
        if (disposed) return;
        const next = new Map<string, MarketQuote>();
        // Yahoo gibt Symbole gelegentlich in anderer Schreibung zurück — nach Liste zuordnen.
        for (const symbol of watchlist) {
          const match = data.quotes.find((q) => q.symbol.toUpperCase() === symbol.toUpperCase());
          if (match) next.set(symbol, match);
        }
        quotesBySymbol = next;
        failedSymbols = new Set(data.failed.map((s) => s.toUpperCase()));
        renderWatchlist();
        if (subtitleEl) subtitleEl.textContent = `Yahoo Finance · Stand ${clockNow()}`;
      } catch (error) {
        if (disposed) return;
        if (subtitleEl) subtitleEl.textContent = describeError(error);
      }
    }

    function select(symbol: string): void {
      if (symbol === selected) return;
      selected = symbol;
      renderWatchlist();
      void loadChart();
    }

    function setWatchlist(next: string[]): void {
      watchlist = saveWatchlist(next);
      if (selected !== null && !hasSymbol(watchlist, selected)) {
        selected = watchlist[0] ?? null;
        void loadChart();
      }
      renderWatchlist();
      void refreshQuotes();
    }

    listEl?.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      const removeButton = target.closest<HTMLElement>("[data-remove]");
      if (removeButton) {
        event.stopPropagation();
        setWatchlist(removeSymbol(watchlist, removeButton.dataset.remove ?? ""));
        return;
      }
      const row = target.closest<HTMLElement>("[data-symbol]");
      if (row?.dataset.symbol) select(row.dataset.symbol);
    });
    listEl?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const row = (event.target as HTMLElement).closest<HTMLElement>("[data-symbol]");
      if (!row?.dataset.symbol) return;
      event.preventDefault();
      select(row.dataset.symbol);
    });

    // --- Suche ---------------------------------------------------------------

    function hideResults(): void {
      if (resultsEl) {
        resultsEl.hidden = true;
        resultsEl.innerHTML = "";
      }
    }

    async function runSearch(query: string): Promise<void> {
      const token = ++searchToken;
      if (query.trim().length < 1) {
        hideResults();
        return;
      }
      try {
        const data = await ctx.api.get<{ hits: MarketSearchHit[] }>(
          `/integrations/markets/search?q=${encodeURIComponent(query.trim())}`,
        );
        if (disposed || token !== searchToken || !resultsEl) return;
        if (data.hits.length === 0) {
          resultsEl.innerHTML = `<li class="search__empty">Nichts gefunden für „${escapeHtml(query.trim())}".</li>`;
        } else {
          resultsEl.innerHTML = data.hits
            .map((hit) => searchHitRow(hit, hasSymbol(watchlist, hit.symbol)))
            .join("");
        }
        resultsEl.hidden = false;
      } catch (error) {
        if (disposed || token !== searchToken || !resultsEl) return;
        resultsEl.innerHTML = `<li class="search__empty">${escapeHtml(describeError(error))}</li>`;
        resultsEl.hidden = false;
      }
    }

    function pickSymbol(symbol: string): void {
      if (searchEl) searchEl.value = "";
      hideResults();
      const upper = symbol.toUpperCase();
      if (!hasSymbol(watchlist, upper)) {
        watchlist = saveWatchlist(addSymbol(watchlist, upper));
      }
      selected = upper;
      renderWatchlist();
      void refreshQuotes();
      void loadChart();
    }

    searchEl?.addEventListener("input", () => {
      if (searchTimer) clearTimeout(searchTimer);
      const value = searchEl.value;
      searchTimer = setTimeout(() => void runSearch(value), SEARCH_DEBOUNCE_MS);
    });
    searchEl?.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        searchEl.value = "";
        hideResults();
      }
      if (event.key === "Enter") {
        // Direkt ein Symbol eingetippt (z. B. „SAP.DE") — der erste Treffer, sonst der Text selbst.
        const first = resultsEl?.querySelector<HTMLElement>("[data-hit]");
        const symbol = first?.dataset.hit ?? searchEl.value.trim().toUpperCase();
        if (symbol.length > 0) pickSymbol(symbol);
      }
    });
    resultsEl?.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>("[data-hit]");
      if (button?.dataset.hit) pickSymbol(button.dataset.hit);
    });
    container.addEventListener("focusout", (event) => {
      const next = event.relatedTarget as Node | null;
      if (next && (searchEl?.contains(next) || resultsEl?.contains(next))) return;
      // Kurz warten, damit ein Klick auf einen Treffer noch ankommt.
      setTimeout(() => {
        const active = document.activeElement;
        if (active && (resultsEl?.contains(active) || active === searchEl)) return;
        hideResults();
      }, 120);
    });

    // --- Chart ---------------------------------------------------------------

    function ensureChart(): ChartApi {
      if (chart && series) return chart;
      if (!chartHostEl) throw new Error("Chart-Container fehlt.");
      const border = cssVar("--border", "rgba(237, 240, 245, 0.09)");
      chart = createChart(chartHostEl, {
        width: chartHostEl.clientWidth,
        height: CHART_HEIGHT,
        layout: {
          background: { color: "transparent" },
          textColor: cssVar("--fg-muted", "rgba(237, 240, 245, 0.62)"),
          fontFamily: cssVar("--font-ui", "system-ui, sans-serif"),
        },
        grid: { vertLines: { color: border }, horzLines: { color: border } },
        rightPriceScale: { borderColor: border },
        timeScale: { borderColor: border, timeVisible: true, secondsVisible: false },
      });
      series = chart.addCandlestickSeries({
        upColor: cssVar("--state-up", "#5fc98c"),
        downColor: cssVar("--state-down", "#e0787f"),
        wickUpColor: cssVar("--state-up", "#5fc98c"),
        wickDownColor: cssVar("--state-down", "#e0787f"),
        borderVisible: false,
      });
      return chart;
    }

    function renderQuoteHead(data: MarketChart): void {
      const up = data.changePct >= 0;
      if (nameEl) nameEl.textContent = data.name;
      if (metaEl) {
        metaEl.textContent = [data.symbol, data.exchange].filter((s) => s.length > 0).join(" · ");
      }
      if (priceEl) priceEl.textContent = formatPrice(data.price, data.currency);
      if (changeEl) {
        changeEl.textContent = formatChange(data.change, data.changePct, data.price);
        changeEl.classList.toggle("is-up", up);
        changeEl.classList.toggle("is-down", !up);
      }
    }

    function clearQuoteHead(text: string): void {
      if (nameEl) nameEl.textContent = text;
      if (metaEl) metaEl.textContent = "";
      if (priceEl) priceEl.textContent = "";
      if (changeEl) changeEl.textContent = "";
    }

    async function loadChart(): Promise<void> {
      const token = ++chartToken;
      if (selected === null) {
        clearQuoteHead("Kein Symbol gewählt");
        if (chartHintEl) chartHintEl.textContent = "";
        series?.setData([]);
        return;
      }
      const symbol = selected;
      if (chartHintEl) chartHintEl.textContent = "Lädt Kerzen …";
      try {
        const data = await ctx.api.get<MarketChart>(
          `/integrations/markets/chart?symbol=${encodeURIComponent(symbol)}&range=${range}`,
        );
        if (disposed || token !== chartToken) return;
        renderQuoteHead(data);
        ensureChart();
        series?.setData(data.candles);
        chart?.timeScale().fitContent();
        if (chartHintEl) {
          chartHintEl.textContent =
            data.candles.length === 0
              ? "Keine Kerzen in diesem Zeitraum — der Markt war geschlossen."
              : `${data.candles.length} Kerzen · Intervall ${data.interval} · Stand ${clockNow()}`;
        }
      } catch (error) {
        if (disposed || token !== chartToken) return;
        clearQuoteHead(symbol);
        if (chartHintEl) chartHintEl.textContent = describeError(error);
      }
    }

    for (const button of rangeButtons) {
      button.addEventListener("click", () => {
        const id = button.dataset.range as RangeId | undefined;
        if (!id || id === range) return;
        range = id;
        for (const other of rangeButtons) {
          const active = other === button;
          other.classList.toggle("is-active", active);
          other.setAttribute("aria-selected", active ? "true" : "false");
        }
        void loadChart();
      });
    }

    const onResize = () => {
      if (chart && chartHostEl) chart.resize(chartHostEl.clientWidth, CHART_HEIGHT);
    };
    window.addEventListener("resize", onResize);

    // --- Start und Takt ------------------------------------------------------

    renderWatchlist();
    void refreshQuotes();
    void loadChart();
    const quotesTimer = globalThis.setInterval(() => void refreshQuotes(), QUOTES_EVERY_MS);
    const chartTimer = globalThis.setInterval(() => void loadChart(), CHART_EVERY_MS);

    return () => {
      disposed = true;
      globalThis.clearInterval(quotesTimer);
      globalThis.clearInterval(chartTimer);
      if (searchTimer) clearTimeout(searchTimer);
      window.removeEventListener("resize", onResize);
      chart?.remove();
      chart = null;
      series = null;
    };
  },
};
