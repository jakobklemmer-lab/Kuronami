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
            <p class="detail-view__subtitle" data-role="subtitle">Lädt …</p>
          </div>
        </header>
        <section class="detail-panel glass">
          <ul class="detail-list" data-role="list"></ul>
        </section>
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
            (finding) => `
              <li>
                <div class="detail-list__head">
                  <p class="detail-list__title">${finding.query}</p>
                  <span class="detail-list__meta">${formatRelativeTime(finding.savedAt)}</span>
                </div>
                <p class="detail-list__body">${finding.summary}</p>
              </li>
            `,
          )
          .join("");
      });

    return () => {};
  },
};
