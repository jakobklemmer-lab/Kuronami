import { icon } from "../icons.js";
import { createMockFilesProvider, createMockNotesProvider } from "../mock/data.js";
import { formatRelativeTime } from "./format.js";
import type { View } from "./types.js";

/** Dateien und Notizen — der Bereich, auf den der Pfeil der „Quick Notes"-Karte zeigt. */
export const filesView: View = {
  mount(container) {
    container.innerHTML = `
      <div class="detail-view">
        <header class="detail-view__head">
          ${icon("files", { className: "detail-view__icon" })}
          <div>
            <h1 class="detail-view__title">Files</h1>
            <p class="detail-view__subtitle" data-role="subtitle">Lädt …</p>
          </div>
        </header>
        <section class="detail-panel glass">
          <ul class="detail-list" data-role="files"></ul>
        </section>
        <section class="detail-panel glass">
          <ul class="detail-list" data-role="notes"></ul>
        </section>
      </div>
    `;

    const filesEl = container.querySelector<HTMLElement>('[data-role="files"]');
    const notesEl = container.querySelector<HTMLElement>('[data-role="notes"]');
    const subtitleEl = container.querySelector<HTMLElement>('[data-role="subtitle"]');

    void createMockFilesProvider()
      .load()
      .then((data) => {
        if (subtitleEl) subtitleEl.textContent = `${data.entries.length} zuletzt geändert`;
        if (!filesEl) return;
        filesEl.innerHTML = data.entries
          .map(
            (entry) => `
              <li>
                <div class="detail-list__row">
                  ${icon("artifact")}
                  <div>
                    <p class="detail-list__title">${entry.name}</p>
                    <p class="detail-list__body">${entry.path}</p>
                  </div>
                  <span class="detail-list__meta" style="margin-left:auto">${formatRelativeTime(entry.modifiedAt)}</span>
                </div>
              </li>
            `,
          )
          .join("");
      });

    void createMockNotesProvider()
      .load()
      .then((data) => {
        if (!notesEl) return;
        notesEl.innerHTML = data.notes
          .map(
            (note) => `
              <li>
                <div class="detail-list__head">
                  <p class="detail-list__title">${note.title}</p>
                  <span class="detail-list__meta">${formatRelativeTime(note.updatedAt)}</span>
                </div>
                <p class="detail-list__body">${note.excerpt}</p>
              </li>
            `,
          )
          .join("");
      });

    return () => {};
  },
};
