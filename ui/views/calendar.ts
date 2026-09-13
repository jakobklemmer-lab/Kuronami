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
            <p class="detail-view__subtitle" data-role="subtitle">Lädt …</p>
          </div>
        </header>
        <section class="detail-panel glass">
          <ol class="detail-list" data-role="list"></ol>
        </section>
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
            (event) => `
              <li>
                <div class="detail-list__row">
                  ${icon(event.icon)}
                  <div>
                    <p class="detail-list__title">${event.title}</p>
                    ${event.location ? `<p class="detail-list__body">${event.location}</p>` : ""}
                  </div>
                  <span class="detail-list__meta" style="margin-left:auto">${formatClockTime(event.startsAt)}</span>
                </div>
              </li>
            `,
          )
          .join("");
      });

    return () => {};
  },
};
