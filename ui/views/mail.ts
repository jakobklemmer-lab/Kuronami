import { icon } from "../icons.js";
import { createMockMailProvider } from "../mock/data.js";
import { formatRelativeTime } from "./format.js";
import type { View } from "./types.js";

/** Vollwertige Mail-Detailansicht (Punkt 4) — die ganze Liste mit Vorschautext, nicht nur die
 * fünf Zeilen der Inbox-Karte auf der Startseite. */
export const mailView: View = {
  mount(container) {
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

    void createMockMailProvider()
      .load()
      .then((data) => {
        if (subtitleEl) {
          subtitleEl.textContent = `${data.messages.length} Nachrichten · ${data.unreadCount} ungelesen`;
        }
        if (!listEl) return;
        listEl.innerHTML = data.messages
          .map(
            (message) => `
              <li${message.unread ? ' class="is-unread"' : ""}>
                <div class="detail-list__head">
                  <p class="detail-list__title">${message.from}</p>
                  <span class="detail-list__meta">${formatRelativeTime(message.receivedAt)}</span>
                </div>
                <p class="detail-list__body">${message.subject}</p>
                <p class="detail-list__body">${message.preview}</p>
              </li>
            `,
          )
          .join("");
      });

    return () => {};
  },
};
