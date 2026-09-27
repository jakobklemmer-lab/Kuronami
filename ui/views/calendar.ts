import { ApiError } from "../api/client.js";
import { icon } from "../icons.js";
import type { CalendarData } from "../integrations/types.js";
import { formatClockTime } from "./format.js";
import { escapeHtml } from "./html.js";
import type { View, ViewContext } from "./types.js";

function describeCalendarError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === "no_token") return "Kein Token hinterlegt — siehe Einstellungen › System.";
    if (error.status === 401) return "Token abgelehnt — in den Einstellungen › System prüfen.";
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Die Termine des Tages aus allen verbundenen Kalendern (Nachtrag 2026-09-16: echt über
 * `GET /integrations/calendar`). Solange kein Kalender-Konto verbunden ist, sagt die Seite das —
 * `connected: false` mit Grund — statt Termine zu erfinden. */
export const calendarView: View = {
  mount(container, ctx: ViewContext) {
    container.innerHTML = `
      <div class="detail-view detail-view--schmal">
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

    void ctx.api
      .get<CalendarData>("/integrations/calendar")
      .then((data) => {
        if (!listEl) return;
        if (!data.connected) {
          if (subtitleEl) subtitleEl.textContent = "Noch kein Kalender verbunden";
          listEl.innerHTML = `
            <li class="leere">
              ${icon("calendar", { className: "leere__ikon" })}
              <p class="leere__satz">Hier stehen Ihre Termine, sobald ein Kalender verbunden ist.</p>
              ${data.reason ? `<p class="leere__grund">${escapeHtml(data.reason)}</p>` : ""}
            </li>`;
          return;
        }
        if (subtitleEl) {
          subtitleEl.textContent =
            data.events.length === 1 ? "1 Termin heute" : `${data.events.length} Termine heute`;
        }
        if (data.events.length === 0) {
          listEl.innerHTML = `
            <li class="leere">
              ${icon("calendar", { className: "leere__ikon" })}
              <p class="leere__satz">Heute steht nichts im Kalender.</p>
            </li>`;
          return;
        }
        listEl.innerHTML = data.events
          .map(
            (event) => `
              <li>
                <div class="detail-list__row termin">
                  <span class="termin__zeit">${
                    event.allDay ? "ganztägig" : escapeHtml(formatClockTime(event.startsAt))
                  }</span>
                  <div class="detail-list__text">
                    <p class="detail-list__title">${escapeHtml(event.title)}</p>
                    ${event.location ? `<p class="detail-list__body">${escapeHtml(event.location)}</p>` : ""}
                  </div>
                </div>
              </li>
            `,
          )
          .join("");
      })
      .catch((error) => {
        if (subtitleEl) subtitleEl.textContent = describeCalendarError(error);
        if (listEl) listEl.innerHTML = "";
      });

    return () => {};
  },
};
