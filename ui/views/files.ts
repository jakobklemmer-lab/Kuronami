import { icon } from "../icons.js";
import type { FilesData, NotesData } from "../integrations/types.js";
import { formatRelativeTime } from "./format.js";
import { escapeHtml } from "./html.js";
import type { View, ViewContext } from "./types.js";

function formatSize(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${bytes} B`;
}

/** Dateien und Notizen — der Bereich, auf den der Pfeil der „Quick Notes"-Karte zeigt. Seit dem
 * 2026-09-16 echt: Artefakte aus `kuronami.artifacts` (`GET /integrations/files`) und die Notizen
 * des Langzeitgedächtnisses (`GET /integrations/notes`). */
export const filesView: View = {
  mount(container, ctx: ViewContext) {
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

    void ctx.api
      .get<FilesData>("/integrations/files")
      .then((data) => {
        if (subtitleEl) subtitleEl.textContent = `${data.files.length} zuletzt geändert`;
        if (!filesEl) return;
        if (data.files.length === 0) {
          filesEl.innerHTML =
            '<li class="field__hint">Noch keine Dateien. Artefakte des Assistenten und Notizen landen hier.</li>';
          return;
        }
        filesEl.innerHTML = data.files
          .map(
            (entry) => `
              <li>
                <div class="detail-list__row">
                  ${icon(entry.kind === "note" ? "book" : "artifact")}
                  <div>
                    <p class="detail-list__title">${escapeHtml(entry.name)}</p>
                    <p class="detail-list__body">${escapeHtml(entry.path)}${
                      entry.sizeBytes !== null ? ` · ${formatSize(entry.sizeBytes)}` : ""
                    }</p>
                  </div>
                  <span class="detail-list__meta" style="margin-left:auto">${escapeHtml(formatRelativeTime(entry.modifiedAt))}</span>
                </div>
              </li>
            `,
          )
          .join("");
      })
      .catch((error) => {
        if (subtitleEl) {
          subtitleEl.textContent = error instanceof Error ? error.message : String(error);
        }
      });

    void ctx.api
      .get<NotesData>("/integrations/notes")
      .then((data) => {
        if (!notesEl) return;
        if (data.notes.length === 0) {
          notesEl.innerHTML = '<li class="field__hint">Noch keine Notizen im Gedächtnis.</li>';
          return;
        }
        notesEl.innerHTML = data.notes
          .map(
            (note) => `
              <li>
                <div class="detail-list__head">
                  <p class="detail-list__title">${escapeHtml(note.title)}</p>
                  <span class="detail-list__meta">${escapeHtml(formatRelativeTime(note.updatedAt))}</span>
                </div>
                <p class="detail-list__body">${escapeHtml(note.excerpt)}</p>
              </li>
            `,
          )
          .join("");
      })
      .catch((error) => {
        if (notesEl) {
          notesEl.innerHTML = `<li class="field__hint">${escapeHtml(
            error instanceof Error ? error.message : String(error),
          )}</li>`;
        }
      });

    return () => {};
  },
};
