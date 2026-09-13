import { icon } from "../icons.js";
import { createMockFilesProvider } from "../mock/data.js";
import { formatRelativeTime } from "./format.js";
import type { View } from "./types.js";

export const filesView: View = {
  mount(container) {
    container.innerHTML = `
      <div class="detail-view">
        <header class="detail-view__head">
          ${icon("files", { className: "detail-view__icon" })}
          <div>
            <h1 class="detail-view__title">Files</h1>
            <p class="detail-view__subtitle" data-role="subtitle">Lädt…</p>
          </div>
        </header>
        <ul class="files-list" data-role="list"></ul>
      </div>
    `;

    const listEl = container.querySelector<HTMLElement>('[data-role="list"]');
    const subtitleEl = container.querySelector<HTMLElement>('[data-role="subtitle"]');

    void createMockFilesProvider()
      .load()
      .then((data) => {
        if (subtitleEl) subtitleEl.textContent = `${data.entries.length} zuletzt geändert`;
        if (!listEl) return;
        listEl.innerHTML = data.entries
          .map(
            (f) => `
              <li class="files-list__row">
                ${icon("artifact", { className: "files-list__icon" })}
                <div>
                  <p class="files-list__name">${f.name}</p>
                  <p class="files-list__path">${f.path}</p>
                </div>
                <span class="files-list__time">${formatRelativeTime(f.modifiedAt)}</span>
              </li>
            `,
          )
          .join("");
      });

    return () => {};
  },
};
