import { icon } from "../icons.js";
import { createMockAgendaProvider } from "../mock/data.js";
import { formatClockTime } from "./format.js";
import type { View } from "./types.js";

export const calendarView: View = {
  mount(container) {
    container.innerHTML = `
      <div class="detail-view">
        <header class="detail-view__head">
          ${icon("calendar", { className: "detail-view__icon" })}
          <div>
            <h1 class="detail-view__title">Calendar</h1>
            <p class="detail-view__subtitle" data-role="subtitle">Lädt…</p>
          </div>
        </header>
        <ol class="agenda-full-list" data-role="list"></ol>
      </div>
    `;

    const listEl = container.querySelector<HTMLElement>('[data-role="list"]');
    const subtitleEl = container.querySelector<HTMLElement>('[data-role="subtitle"]');

    void createMockAgendaProvider()
      .load()
      .then((data) => {
        if (subtitleEl) subtitleEl.textContent = `${data.events.length} Termine heute`;
        if (!listEl) return;
        listEl.innerHTML = data.events
          .map(
            (e) => `
              <li class="agenda-full-list__row">
                <time class="agenda-full-list__time">${formatClockTime(e.startsAt)}</time>
                <div>
                  <p class="agenda-full-list__title">${e.title}</p>
                  ${e.location ? `<p class="agenda-full-list__location">${e.location}</p>` : ""}
                </div>
              </li>
            `,
          )
          .join("");
      });

    return () => {};
  },
};
