import { ApiError } from "../api/client.js";
import { icon } from "../icons.js";
import type { MailData } from "../integrations/types.js";
import { formatRelativeTime } from "./format.js";
import { escapeHtml } from "./html.js";
import type { View, ViewContext } from "./types.js";

function describeMailError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === "no_token") return "Kein Token hinterlegt — siehe Einstellungen › System.";
    if (error.status === 401) return "Token abgelehnt — in den Einstellungen › System prüfen.";
    if (error.status === 404) return "Mail ist auf diesem Gateway nicht eingerichtet (kein n8n).";
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Vollwertige Mail-Detailansicht (Punkt 4) — die ganze Liste mit Vorschautext, nicht nur die
 * fünf Zeilen der Inbox-Karte auf der Startseite. Liest seit dem Mehrkonten-Nachtrag
 * (2026-09-16) echt über `GET /integrations/mail` (alle verbundenen Gmail-/Outlook-Konten),
 * nicht mehr `createMockMailProvider`. */
export const mailView: View = {
  mount(container, ctx: ViewContext) {
    container.innerHTML = `
      <div class="detail-view">
        <header class="detail-view__head">
          ${icon("mail", { className: "detail-view__icon" })}
          <div>
            <h1 class="detail-view__title">Mail</h1>
            <p class="detail-view__subtitle" data-role="subtitle">Lädt …</p>
          </div>
        </header>
        <section class="detail-panel glass">
          <ul class="detail-list detail-list--unread" data-role="list"></ul>
        </section>
      </div>
    `;

    const listEl = container.querySelector<HTMLElement>('[data-role="list"]');
    const subtitleEl = container.querySelector<HTMLElement>('[data-role="subtitle"]');

    void ctx.api
      .get<MailData>("/integrations/mail")
      .then((data) => {
        if (subtitleEl) {
          subtitleEl.textContent = `${data.messages.length} Nachrichten · ${data.unreadCount} ungelesen`;
        }
        if (!listEl) return;
        if (data.messages.length === 0) {
          listEl.innerHTML = '<li class="field__hint">Keine Nachrichten.</li>';
          return;
        }
        listEl.innerHTML = data.messages
          .map(
            (message) => `
              <li${message.unread ? ' class="is-unread"' : ""}>
                <div class="detail-list__head">
                  <p class="detail-list__title">${escapeHtml(message.from)}</p>
                  <span class="detail-list__meta">${formatRelativeTime(message.receivedAt)}</span>
                </div>
                <p class="detail-list__body">${escapeHtml(message.subject)}</p>
                <p class="detail-list__body">${escapeHtml(message.preview)}</p>
              </li>
            `,
          )
          .join("");
      })
      .catch((error) => {
        if (subtitleEl) subtitleEl.textContent = describeMailError(error);
        if (listEl) listEl.innerHTML = "";
      });

    return () => {};
  },
};
