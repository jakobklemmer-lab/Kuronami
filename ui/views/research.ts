import { icon } from "../icons.js";
import type { ResearchData } from "../integrations/types.js";
import { formatRelativeTime } from "./format.js";
import { escapeHtml } from "./html.js";
import type { View, ViewContext } from "./types.js";

/** Das Werkzeug in Worten statt als Kennung („web.search"). */
function werkzeugName(tool: string): string {
  if (tool === "web.search" || tool === "WebSearch") return "Websuche";
  if (tool === "web.fetch" || tool === "WebFetch") return "Seite gelesen";
  return tool;
}

/** Was der Assistent im Netz gefunden und abgelegt hat — die `web.*`-Artefakte aus
 * `kuronami.artifacts` (Nachtrag 2026-09-16: echt über `GET /integrations/research`). */
export const researchView: View = {
  mount(container, ctx: ViewContext) {
    container.innerHTML = `
      <div class="detail-view detail-view--schmal">
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
          listEl.innerHTML = `
            <li class="leere">
              ${icon("research", { className: "leere__ikon" })}
              <p class="leere__satz">Noch keine Recherche abgelegt.</p>
              <p class="leere__grund">Sobald Kuro im Netz sucht oder eine Seite liest, steht das Ergebnis hier.
              Sagen Sie ihm einfach, was Sie wissen wollen.</p>
            </li>`;
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
                <p class="detail-list__body" title="${escapeHtml(finding.artifactUri)}">${escapeHtml(werkzeugName(finding.tool))}</p>
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
