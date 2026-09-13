import { icon } from "../icons.js";
import { createMockMarketsProvider } from "../mock/data.js";
import type { View } from "./types.js";

export const tradingView: View = {
  mount(container) {
    container.innerHTML = `
      <div class="detail-view">
        <header class="detail-view__head">
          ${icon("trading", { className: "detail-view__icon" })}
          <div>
            <h1 class="detail-view__title">Trading</h1>
            <p class="detail-view__subtitle" data-role="subtitle">Lädt…</p>
          </div>
        </header>
        <table class="markets-full-table">
          <thead>
            <tr><th>Symbol</th><th>Name</th><th>Kurs</th><th>24h</th></tr>
          </thead>
          <tbody data-role="rows"></tbody>
        </table>
      </div>
    `;

    const rowsEl = container.querySelector<HTMLElement>('[data-role="rows"]');
    const subtitleEl = container.querySelector<HTMLElement>('[data-role="subtitle"]');

    void createMockMarketsProvider()
      .load()
      .then((data) => {
        if (subtitleEl) {
          subtitleEl.textContent = `Stand ${new Date(data.asOf).toLocaleTimeString("de-DE", { hour12: false })}`;
        }
        if (!rowsEl) return;
        rowsEl.innerHTML = data.quotes
          .map(
            (q) => `
              <tr>
                <td class="markets-full-table__symbol">${q.symbol}</td>
                <td>${q.label}</td>
                <td class="markets-full-table__price">${q.price.toLocaleString("de-DE")}</td>
                <td class="${q.changePct >= 0 ? "markets-full-table__up" : "markets-full-table__down"}">${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(1)}%</td>
              </tr>
            `,
          )
          .join("");
      });

    return () => {};
  },
};
