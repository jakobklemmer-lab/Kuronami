import { icon } from "../icons.js";
import { createMockMarketsProvider } from "../mock/data.js";
import { sparklinePoints } from "./chart.js";
import type { View } from "./types.js";

export const tradingView: View = {
  mount(container) {
    container.innerHTML = `
      <div class="detail-view">
        <header class="detail-view__head">
          ${icon("trading", { className: "detail-view__icon" })}
          <div>
            <h1 class="detail-view__title">Trading</h1>
            <p class="detail-view__subtitle" data-role="subtitle">Lädt …</p>
          </div>
        </header>
        <section class="detail-panel glass">
          <table class="markets-table">
            <thead>
              <tr><th>Symbol</th><th>Name</th><th>Kurs</th><th>Verlauf</th><th>24h</th></tr>
            </thead>
            <tbody data-role="rows"></tbody>
          </table>
        </section>
      </div>
    `;

    const rowsEl = container.querySelector<HTMLElement>('[data-role="rows"]');
    const subtitleEl = container.querySelector<HTMLElement>('[data-role="subtitle"]');

    void createMockMarketsProvider()
      .load()
      .then((data) => {
        if (subtitleEl) {
          subtitleEl.textContent = `Stand ${new Date(data.asOf).toLocaleTimeString("de-DE", {
            hour: "2-digit",
            minute: "2-digit",
          })}`;
        }
        if (!rowsEl) return;
        rowsEl.innerHTML = data.quotes
          .map((quote) => {
            const up = quote.changePct >= 0;
            return `
              <tr>
                <td class="markets-table__symbol">${quote.symbol}</td>
                <td>${quote.label}</td>
                <td class="markets-table__num">${quote.price.toLocaleString("de-DE", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}</td>
                <td>
                  <svg class="markets-row__spark" viewBox="0 0 48 16" fill="none"
                    stroke="${up ? "var(--state-up)" : "var(--state-down)"}" stroke-width="1.3"
                    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <polyline points="${sparklinePoints(quote.spark, 48, 16)}" />
                  </svg>
                </td>
                <td class="markets-table__num ${up ? "markets-table__up" : "markets-table__down"}">
                  ${up ? "+" : ""}${quote.changePct.toFixed(2)}%
                </td>
              </tr>
            `;
          })
          .join("");
      });

    return () => {};
  },
};
