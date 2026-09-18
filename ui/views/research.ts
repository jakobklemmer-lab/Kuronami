import { icon } from "../icons.js";
import type { ResearchData } from "../integrations/types.js";
import { formatRelativeTime } from "./format.js";
import { escapeHtml } from "./html.js";
import type { View, ViewContext } from "./types.js";

/** Was der Assistent im Netz gefunden und abgelegt hat — die `web.*`-Artefakte aus
 * `kuronami.artifacts` (Nachtrag 2026-09-16: echt über `GET /integrations/research`). */
export const researchView: View = {
  mount(container, ctx: ViewContext) {
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

    void ctx.api
      .get<ResearchData>("/integrations/research")
      .then((data) => {
        if (subtitleEl) {
          subtitleEl.textContent =
            data.findings.length === 1
              ? "1 gespeicherter Befund"
              : `${data.findings.length} gespeicherte Befunde`;
        }
        if (!listEl) return;
        if (data.findings.length === 0) {
          listEl.innerHTML =
            '<li class="field__hint">Noch keine Recherche abgelegt. Sobald der Assistent im Netz sucht oder eine Seite holt, erscheint das Ergebnis hier.</li>';
          return;
        }
        listEl.innerHTML = data.findings
          .map(
            (finding) => `
              <li>
                <div class="detail-list__head">
                  <p class="detail-list__title">${escapeHtml(finding.summary)}</p>
                  <span class="detail-list__meta">${escapeHtml(formatRelativeTime(finding.savedAt))}</span>
                </div>
                <p class="detail-list__body">${escapeHtml(finding.tool)} · ${escapeHtml(finding.artifactUri)}</p>
              </li>
            `,
          )
          .join("");
      })
      .catch((error) => {
        if (subtitleEl) {
          subtitleEl.textContent = error instanceof Error ? error.message : String(error);
        }
        if (listEl) listEl.innerHTML = "";
      });

    return () => {};
  },
};
