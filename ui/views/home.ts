import { icon } from "../icons.js";
import {
  type MarketQuote,
  type SystemGauge,
  createMockAgendaProvider,
  createMockMailProvider,
  createMockMarketsProvider,
  createMockQuickNoteProvider,
  createMockSystemGaugesProvider,
  createMockWeatherProvider,
} from "../mock/data.js";
import { gaugeDashArray, sparklinePoints } from "./chart.js";
import { formatClockTime, formatRelativeTime } from "./format.js";
import type { View, ViewContext } from "./types.js";

/**
 * Die Startseite, gebaut nach der Bildvorlage `dashboard_beispiel.png`: zentrierte Kopfzeile mit
 * Datum, grosser duenner Uhr und Leitsatz, das Wetter rechts aussen, darunter drei Spalten, deren
 * obere Mitte **leer** bleibt, damit das Foto durchschaut.
 *
 * Alle Inhalte kommen weiterhin aus typisierten Mock-Providern (`ui/mock/data.ts`) — kein Wert
 * steht fest im Markup, jeder Provider ist gegen eine echte Quelle austauschbar, ohne dass diese
 * Datei sich aendert.
 */

const SPARK_WIDTH = 48;
const SPARK_HEIGHT = 16;
const GAUGE_RADIUS = 25;

function marketRow(quote: MarketQuote): string {
  const up = quote.changePct >= 0;
  const points = sparklinePoints(quote.spark, SPARK_WIDTH, SPARK_HEIGHT);
  const price = quote.price.toLocaleString("de-DE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `
    <li class="markets-row">
      <span class="markets-row__badge">${quote.symbol.slice(0, 1)}</span>
      <span class="markets-row__symbol">${quote.symbol}</span>
      <span class="markets-row__price">${price}</span>
      <svg class="markets-row__spark" viewBox="0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}" fill="none"
        stroke="${up ? "var(--state-up)" : "var(--state-down)"}" stroke-width="1.3"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="${points}" />
      </svg>
      <span class="markets-row__change markets-row__change--${up ? "up" : "down"}">
        ${up ? "+" : ""}${quote.changePct.toFixed(2)}%
      </span>
    </li>
  `;
}

function gauge(entry: SystemGauge): string {
  const size = GAUGE_RADIUS * 2 + 6;
  return `
    <div class="gauge">
      <div class="gauge__center">
        <svg class="gauge__ring" viewBox="0 0 ${size} ${size}" aria-hidden="true">
          <circle class="gauge__track" cx="${size / 2}" cy="${size / 2}" r="${GAUGE_RADIUS}" />
          <circle class="gauge__value" cx="${size / 2}" cy="${size / 2}" r="${GAUGE_RADIUS}"
            stroke-dasharray="${gaugeDashArray(entry.percent, GAUGE_RADIUS)}" />
        </svg>
        <span class="gauge__readout">
          ${entry.readout}${entry.readoutSub ? `<small>${entry.readoutSub}</small>` : ""}
        </span>
      </div>
      <span class="gauge__label">${entry.label}</span>
    </div>
  `;
}

export const homeView: View = {
  mount(container: HTMLElement, ctx: ViewContext) {
    container.innerHTML = `
      <div class="cockpit">
        <header class="cockpit__header">
          <div class="cockpit__clock on-photo">
            <div class="cockpit__date" data-role="date">—</div>
            <div class="cockpit__time" data-role="time">--:--</div>
            <div class="cockpit__tagline">Discipline builds freedom</div>
          </div>
          <div class="weather glass" data-role="weather" hidden></div>
        </header>

        <div class="cockpit__grid">
          <section class="card glass area-markets" aria-labelledby="card-markets">
            <header class="card__head">
              ${icon("trading", { className: "card__icon" })}
              <h2 class="card__title" id="card-markets">Markets</h2>
              <button class="card__more" type="button" data-action="open-trading" aria-label="Trading öffnen">
                ${icon("chevron")}
              </button>
            </header>
            <ul class="markets-list" data-role="markets"></ul>
          </section>

          <section class="card glass area-inbox" aria-labelledby="card-inbox">
            <header class="card__head">
              ${icon("mail", { className: "card__icon" })}
              <h2 class="card__title" id="card-inbox">Inbox</h2>
              <button class="card__more" type="button" data-action="open-mail" aria-label="Mail öffnen">
                ${icon("chevron")}
              </button>
            </header>
            <ul class="inbox-list" data-role="inbox"></ul>
          </section>

          <section class="card glass area-today" aria-labelledby="card-today">
            <header class="card__head">
              ${icon("calendar", { className: "card__icon" })}
              <h2 class="card__title" id="card-today">Today</h2>
              <button class="card__more" type="button" data-action="open-calendar" aria-label="Kalender öffnen">
                ${icon("chevron")}
              </button>
            </header>
            <ol class="today-list" data-role="today"></ol>
          </section>

          <div class="area-actions">
            <div class="actions-row">
              <button class="action-button glass" type="button" data-action="new-task">
                ${icon("plusSquare")}
                <span class="action-button__label">Neue Aufgabe</span>
              </button>
              <button class="action-button glass" type="button" data-action="open-system">
                ${icon("terminal")}
                <span class="action-button__label">Läufe</span>
              </button>
              <button class="action-button glass" type="button" data-action="open-research">
                ${icon("research")}
                <span class="action-button__label">Suche</span>
              </button>
              <button class="action-button glass" type="button" data-action="toggle-focus">
                ${icon("focus")}
                <span class="action-button__label">Fokus</span>
              </button>
            </div>

            <section class="card glass" aria-labelledby="card-system">
              <header class="card__head">
                ${icon("monitor", { className: "card__icon" })}
                <h2 class="card__title" id="card-system">System</h2>
                <button class="card__more" type="button" data-action="open-system" aria-label="System öffnen">
                  ${icon("chevron")}
                </button>
              </header>
              <div class="gauges" data-role="gauges"></div>
            </section>
          </div>

          <section class="card glass area-notes" aria-labelledby="card-notes">
            <header class="card__head">
              ${icon("artifact", { className: "card__icon" })}
              <h2 class="card__title" id="card-notes">Quick Notes</h2>
              <button class="card__more" type="button" data-action="open-files" aria-label="Dateien öffnen">
                ${icon("chevron")}
              </button>
            </header>
            <p class="note-quote" data-role="note-quote"></p>
            <p class="note-author" data-role="note-author"></p>
          </section>
        </div>

        <footer class="cockpit__footer on-photo">
          <span class="cockpit__footer-rule"></span>
          <span>Focus</span><span>/</span><span>Build</span><span>/</span><span>Grow</span>
        </footer>
      </div>
    `;

    const role = <T extends HTMLElement>(name: string): T | null =>
      container.querySelector<T>(`[data-role="${name}"]`);

    // --- Uhr ---------------------------------------------------------------
    const timeEl = role<HTMLElement>("time");
    const dateEl = role<HTMLElement>("date");
    const tick = (): void => {
      const now = new Date();
      if (timeEl) {
        timeEl.textContent = now.toLocaleTimeString("de-DE", {
          hour: "2-digit",
          minute: "2-digit",
        });
      }
      if (dateEl) {
        dateEl.textContent = now.toLocaleDateString("de-DE", {
          weekday: "long",
          day: "numeric",
          month: "long",
          year: "numeric",
        });
      }
    };
    tick();
    const clockTimer = globalThis.setInterval(tick, 1000);

    // --- Wetter ------------------------------------------------------------
    void createMockWeatherProvider()
      .load()
      .then((data) => {
        const el = role<HTMLElement>("weather");
        if (!el) return;
        el.innerHTML = `
          <div class="weather__now">
            ${icon(data.night ? "moon" : "sun", { className: "weather__icon" })}
            <div>
              <div class="weather__place">${data.place}</div>
              <div class="weather__temp">${data.temperature}°C</div>
              <div class="weather__desc">${data.description}</div>
            </div>
          </div>
          <div class="weather__days">
            ${data.forecast
              .map(
                (day) => `
                  <div class="weather__day">
                    ${icon(day.clear ? "sun" : "moon", { className: "weather__day-icon" })}
                    <span class="weather__day-name">${day.name}</span>
                    <span class="weather__day-temp">${day.high}° / ${day.low}°</span>
                  </div>
                `,
              )
              .join("")}
          </div>
        `;
        el.hidden = false;
      });

    // --- Markets -----------------------------------------------------------
    void createMockMarketsProvider()
      .load()
      .then((data) => {
        const el = role<HTMLElement>("markets");
        if (el) el.innerHTML = data.quotes.map(marketRow).join("");
      });

    // --- Inbox -------------------------------------------------------------
    void createMockMailProvider()
      .load()
      .then((data) => {
        const el = role<HTMLElement>("inbox");
        if (!el) return;
        el.innerHTML = data.messages
          .slice(0, 5)
          .map(
            (message) => `
              <li class="inbox-row${message.unread ? "" : " inbox-row--read"}">
                <span class="inbox-row__dot"></span>
                <span class="inbox-row__from">${message.from}</span>
                <span class="inbox-row__time">${formatRelativeTime(message.receivedAt)}</span>
                <span class="inbox-row__subject">${message.subject}</span>
              </li>
            `,
          )
          .join("");
      });

    // --- Today -------------------------------------------------------------
    void createMockAgendaProvider()
      .load()
      .then((data) => {
        const el = role<HTMLElement>("today");
        if (!el) return;
        el.innerHTML = data.events
          .map(
            (event) => `
              <li class="today-row">
                <span class="today-row__dot"></span>
                <time class="today-row__time">${formatClockTime(event.startsAt)}</time>
                <span class="today-row__icon">${icon(event.icon)}</span>
                <span class="today-row__label">${event.title}</span>
              </li>
            `,
          )
          .join("");
      });

    // --- System-Messuhren --------------------------------------------------
    void createMockSystemGaugesProvider()
      .load()
      .then((data) => {
        const el = role<HTMLElement>("gauges");
        if (el) el.innerHTML = data.gauges.map(gauge).join("");
      });

    // --- Quick Notes -------------------------------------------------------
    void createMockQuickNoteProvider()
      .load()
      .then((note) => {
        const quote = role<HTMLElement>("note-quote");
        const author = role<HTMLElement>("note-author");
        if (quote) quote.textContent = note.text;
        if (author) author.textContent = `— ${note.author}`;
      });

    // --- Knöpfe ------------------------------------------------------------
    container.addEventListener("click", (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
      if (!target) return;
      switch (target.dataset.action) {
        case "open-mail":
          ctx.navigate("mail");
          break;
        case "open-calendar":
          ctx.navigate("calendar");
          break;
        case "open-trading":
          ctx.navigate("trading");
          break;
        case "open-research":
          ctx.navigate("research");
          break;
        case "open-files":
          ctx.navigate("files");
          break;
        case "open-system":
          ctx.navigate("system");
          break;
        case "new-task":
          ctx.compose();
          break;
        case "toggle-focus":
          ctx.toggleFocus();
          break;
        default:
          break;
      }
    });

    return () => {
      globalThis.clearInterval(clockTimer);
    };
  },
};
