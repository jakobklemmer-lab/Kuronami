import { icon } from "../icons.js";
import { createMockResearchProvider } from "../mock/data.js";
import { formatRelativeTime } from "./format.js";
import type { View } from "./types.js";

export const researchView: View = {
  mount(container) {
    container.innerHTML = `
      <div class="detail-view">
        <header class="detail-view__head">
          ${icon("research", { className: "detail-view__icon" })}
          <div>
            <h1 class="detail-view__title">Research</h1>
            <p class="detail-view__subtitle" data-role="subtitle">Lädt…</p>
          </div>
        </header>
        <ul class="research-list" data-role="list"></ul>
      </div>
    `;

    const listEl = container.querySelector<HTMLElement>('[data-role="list"]');
    const subtitleEl = container.querySelector<HTMLElement>('[data-role="subtitle"]');

    void createMockResearchProvider()
      .load()
      .then((data) => {
        if (subtitleEl) subtitleEl.textContent = `${data.findings.length} gespeicherte Befunde`;
        if (!listEl) return;
        listEl.innerHTML = data.findings
          .map(
            (f) => `
              <li class="research-list__row">
                <p class="research-list__query">${f.query}</p>
                <p class="research-list__summary">${f.summary}</p>
                <span class="research-list__time">${formatRelativeTime(f.savedAt)}</span>
              </li>
            `,
          )
          .join("");
      });

    return () => {};
  },
};
