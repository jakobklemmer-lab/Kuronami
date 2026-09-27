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

/**
 * Dateien und Notizen.
 *
 * Bis 2026-09-26 zwei Glasflächen ohne Überschrift untereinander: oben „zuletzt geändert", wo
 * Gedächtnisnotizen und Artefakte gemischt mit ihren vollen Pfaden standen
 * (`artifact://sess_19eee6da-…/artifact_00d45f17-…`), unten dieselben Notizen noch einmal mit
 * Auszug. Jetzt zwei benannte Abschnitte: die **Notizen** aus dem Gedächtnis mit ihrem Auszug,
 * und die **Ablage** — nur die Artefakte, mit Größe. Der Pfad steht im Tooltip, nicht im Bild.
 */
export const filesView: View = {
  mount(container, ctx: ViewContext) {
    container.innerHTML = `
      <div class="detail-view detail-view--schmal">
        <header class="detail-view__head">
          ${icon("files", { className: "detail-view__icon" })}
          <div>
            <h1 class="detail-view__title">Files</h1>
            <p class="detail-view__subtitle" data-role="subtitle">Lädt …</p>
          </div>
        </header>
        <section class="ablage">
          <h2 class="ablage__titel">Notizen <span data-role="notes-zahl"></span></h2>
          <p class="ablage__unter">Was Kuro sich gemerkt hat.</p>
          <div class="detail-panel glass"><ul class="detail-list" data-role="notes"></ul></div>
        </section>
        <section class="ablage">
          <h2 class="ablage__titel">Ablage <span data-role="files-zahl"></span></h2>
          <p class="ablage__unter">Was Kuro und das Personal bei der Arbeit abgelegt haben.</p>
          <div class="detail-panel glass"><ul class="detail-list" data-role="files"></ul></div>
        </section>
      </div>
    `;

    const filesEl = container.querySelector<HTMLElement>('[data-role="files"]');
    const notesEl = container.querySelector<HTMLElement>('[data-role="notes"]');
    const filesZahlEl = container.querySelector<HTMLElement>('[data-role="files-zahl"]');
    const notesZahlEl = container.querySelector<HTMLElement>('[data-role="notes-zahl"]');
    const subtitleEl = container.querySelector<HTMLElement>('[data-role="subtitle"]');
    let notizen: number | null = null;
    let artefakte: number | null = null;
    const untertitel = (): void => {
      if (!subtitleEl || notizen === null || artefakte === null) return;
      subtitleEl.textContent = `${notizen} Notiz${notizen === 1 ? "" : "en"} und ${artefakte} abgelegte Datei${artefakte === 1 ? "" : "en"}`;
    };

    void ctx.api
      .get<FilesData>("/integrations/files")
      .then((data) => {
        // Notizen stehen oben mit ihrem Auszug; hier nur, was keine Notiz ist.
        const liste = data.files.filter((entry) => entry.kind !== "note");
        artefakte = liste.length;
        untertitel();
        if (filesZahlEl) filesZahlEl.textContent = String(liste.length);
        if (!filesEl) return;
        if (liste.length === 0) {
          filesEl.innerHTML =
            '<li class="detail-list__leer">Noch nichts abgelegt. Ergebnisse, die Kuro oder das Personal speichern, erscheinen hier.</li>';
          return;
        }
        filesEl.innerHTML = liste
          .map(
            (entry) => `
              <li title="${escapeHtml(entry.path)}">
                <div class="detail-list__row">
                  ${icon("artifact")}
                  <div class="detail-list__text">
                    <p class="detail-list__title">${escapeHtml(entry.name)}</p>
                    ${entry.sizeBytes !== null ? `<p class="detail-list__body">${formatSize(entry.sizeBytes)}</p>` : ""}
                  </div>
                  <span class="detail-list__meta">${escapeHtml(formatRelativeTime(entry.modifiedAt))}</span>
                </div>
              </li>
            `,
          )
          .join("");
      })
      .catch((error) => {
        if (filesEl) {
          filesEl.innerHTML = `<li class="detail-list__leer">${escapeHtml(
            error instanceof Error ? error.message : String(error),
          )}</li>`;
        }
      });

    void ctx.api
      .get<NotesData>("/integrations/notes")
      .then((data) => {
        notizen = data.notes.length;
        untertitel();
        if (notesZahlEl) notesZahlEl.textContent = String(data.notes.length);
        if (!notesEl) return;
        if (data.notes.length === 0) {
          notesEl.innerHTML =
            '<li class="detail-list__leer">Noch keine Notizen im Gedächtnis.</li>';
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
                ${note.excerpt ? `<p class="detail-list__body detail-list__auszug">${escapeHtml(note.excerpt)}</p>` : ""}
              </li>
            `,
          )
          .join("");
      })
      .catch((error) => {
        if (notesEl) {
          notesEl.innerHTML = `<li class="detail-list__leer">${escapeHtml(
            error instanceof Error ? error.message : String(error),
          )}</li>`;
        }
      });

    return () => {};
  },
};
