import { icon } from "../icons.js";
import { createMockMailProvider } from "../mock/data.js";
import { formatRelativeTime } from "./format.js";
import type { View } from "./types.js";

/** Vollwertige Mail-Detailansicht (S-Zwischenschub, Punkt 4) — nicht nur eine vergroesserte
 * Cockpit-Kachel: die ganze Liste, nicht nur die ersten drei Zeilen wie im Inbox-Panel. */
export const mailView: View = {
  mount(container) {
    container.innerHTML = `
      <div class="detail-view">
        <header class="detail-view__head">
          ${icon("mail", { className: "detail-view__icon" })}
          <div>
            <h1 class="detail-view__title">Mail</h1>
            <p class="detail-view__subtitle" data-role="subtitle">Lädt…</p>
          </div>
        </header>
        <ul class="mail-full-list" data-role="list"></ul>
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
            (m) => `
              <li class="mail-full-list__row${m.unread ? " mail-full-list__row--unread" : ""}">
                <div class="mail-full-list__head">
                  <span class="mail-full-list__from">${m.from}</span>
                  <span class="mail-full-list__time">${formatRelativeTime(m.receivedAt)}</span>
                </div>
                <p class="mail-full-list__subject">${m.subject}</p>
                <p class="mail-full-list__preview">${m.preview}</p>
              </li>
            `,
          )
          .join("");
      });

    return () => {};
  },
};
