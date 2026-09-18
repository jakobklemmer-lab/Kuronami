import { icon } from "../icons.js";
import type {
  CalendarData,
  MailData,
  MarketQuote,
  MarketQuotesData,
  NotesData,
  SystemData,
  SystemGauge,
} from "../integrations/types.js";
import { loadWeather } from "../integrations/weather.js";
import { formatPercent, formatPrice } from "../markets/format.js";
import { loadWatchlist, rememberSelectedSymbol } from "../markets/watchlist.js";
import { loadSettings } from "../settings/store.js";
import { sparklinePoints } from "./chart.js";
import { formatClockTime, formatRelativeTime } from "./format.js";
import { escapeHtml } from "./html.js";
import type { View, ViewContext } from "./types.js";

/**
 * Die Startseite: zentrierte Kopfzeile mit Datum, grosser duenner Uhr und Leitsatz, das Wetter
 * rechts aussen, darunter zwei Karten (Markets, Inbox), deren Mitte **leer** bleibt, damit das
 * Foto durchschaut — das ist seit der Bildvorlage `dashboard_beispiel.png` die Identität der
 * Seite.
 *
 * Überarbeitung 2026-09-16: der untere Rand ist keine Reihe gleicher Karten mehr, sondern **eine
 * Leiste** — Neue Aufgabe, Heute, System, Notiz, Fokus als Abschnitte eines einzigen Glaskörpers,
 * durch Haarlinien getrennt. Grund: Heute und Notiz sind oft leer (kein Kalender verbunden, keine
 * Notiz); als eigene Karten waren das hohle Kästen, in einer Leiste ist Leere eine Zeile. Die
 * System-Ringe wurden zu vier schmalen Balken, weil Balken in einer Leiste lesbar sind und die
 * Zahl daneben Platz bekommt. Die Knöpfe „Läufe" und „Suche" sind weg — die Seitenleiste hat sie.
 *
 * Jede Karte kommt aus einer echten Quelle — Wetter von Open-Meteo, alles andere über die
 * `/integrations/*`-Routen des Gateways. Was nicht angeschlossen ist, sagt das, statt Platzhalter
 * zu zeigen.
 */

const SPARK_WIDTH = 56;
const SPARK_HEIGHT = 18;
const HOME_MARKET_ROWS = 6;
const HOME_TODAY_ROWS = 3;
const MARKETS_EVERY_MS = 60_000;
const SYSTEM_EVERY_MS = 15_000;
/** Ab hier wechselt ein Systembalken in die Warnfarbe. */
const METER_WARN_PERCENT = 85;

function marketRow(quote: MarketQuote, symbol: string): string {
  const up = quote.changePct >= 0;
  const tone = up ? "up" : "down";
  const points = sparklinePoints(quote.spark, SPARK_WIDTH, SPARK_HEIGHT);
  // Die Fläche unter der Linie: dieselben Punkte, unten geschlossen.
  const area = points ? `${points} ${SPARK_WIDTH},${SPARK_HEIGHT} 0,${SPARK_HEIGHT}` : "";
  return `
    <li class="markets-row" data-symbol="${escapeHtml(symbol)}" tabindex="0" role="button">
      <span class="markets-row__ident">
        <span class="markets-row__symbol">${escapeHtml(symbol)}</span>
        <span class="markets-row__name">${escapeHtml(quote.name)}</span>
      </span>
      <svg class="markets-row__spark" viewBox="0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}" aria-hidden="true">
        ${area ? `<polygon points="${area}" fill="var(--state-${tone})" fill-opacity="0.1" stroke="none" />` : ""}
        <polyline points="${points}" fill="none" stroke="var(--state-${tone})" stroke-width="1.3"
          stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span class="markets-row__figures">
        <span class="markets-row__price">${escapeHtml(formatPrice(quote.price))}</span>
        <span class="markets-row__change markets-row__change--${tone}">${escapeHtml(formatPercent(quote.changePct))}</span>
      </span>
    </li>
  `;
}

function meter(entry: SystemGauge): string {
  const warn = entry.percent >= METER_WARN_PERCENT;
  return `
    <li class="meter${warn ? " meter--warn" : ""}">
      <span class="meter__label">${escapeHtml(entry.label)}</span>
      <span class="meter__track" aria-hidden="true"><span class="meter__fill" style="width:${entry.percent}%"></span></span>
      <span class="meter__value">${escapeHtml(entry.readout)}${
        entry.readoutSub ? `<small>${escapeHtml(entry.readoutSub)}</small>` : ""
      }</span>
    </li>
  `;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
        </div>

        <section class="band glass" aria-label="Status">
          <button class="band__compose" type="button" data-action="new-task">
            ${icon("plusSquare")}
            <span>Neue Aufgabe</span>
          </button>

          <section class="band__seg" aria-labelledby="band-today">
            <header class="card__head band__head">
              ${icon("calendar", { className: "card__icon" })}
              <h2 class="card__title" id="band-today">Heute</h2>
              <button class="card__more" type="button" data-action="open-calendar" aria-label="Kalender öffnen">
                ${icon("chevron")}
              </button>
            </header>
            <ol class="today-list" data-role="today"></ol>
          </section>

          <section class="band__seg" aria-labelledby="band-system">
            <header class="card__head band__head">
              ${icon("monitor", { className: "card__icon" })}
              <h2 class="card__title" id="band-system">System</h2>
              <button class="card__more" type="button" data-action="open-system" aria-label="System öffnen">
                ${icon("chevron")}
              </button>
            </header>
            <ul class="meters" data-role="gauges"></ul>
          </section>

          <section class="band__seg" aria-labelledby="band-note">
            <header class="card__head band__head">
              ${icon("artifact", { className: "card__icon" })}
              <h2 class="card__title" id="band-note">Notiz</h2>
              <button class="card__more" type="button" data-action="open-files" aria-label="Dateien öffnen">
                ${icon("chevron")}
              </button>
            </header>
            <p class="note-quote" data-role="note-quote"></p>
            <p class="note-author" data-role="note-author"></p>
          </section>

          <button class="band__focus" type="button" data-action="toggle-focus" aria-label="Fokus-Modus umschalten" title="Fokus">
            ${icon("focus")}
          </button>
        </section>
      </div>
    `;

    const role = <T extends HTMLElement>(name: string): T | null =>
      container.querySelector<T>(`[data-role="${name}"]`);
    let disposed = false;

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

    // --- Wetter (Open-Meteo, Ort aus den Einstellungen) ----------------------
    void loadWeather(loadSettings().weather)
      .then((data) => {
        const el = role<HTMLElement>("weather");
        if (!el || disposed) return;
        el.innerHTML = `
          <div class="weather__now">
            ${icon(data.night ? "moon" : "sun", { className: "weather__icon" })}
            <div>
              <div class="weather__place">${escapeHtml(data.place)}</div>
              <div class="weather__temp">${data.temperature}°C</div>
              <div class="weather__desc">${escapeHtml(data.description)}</div>
            </div>
          </div>
          <div class="weather__days">
            ${data.forecast
              .map(
                (day) => `
                  <div class="weather__day">
                    ${icon(day.clear ? "sun" : "moon", { className: "weather__day-icon" })}
                    <span class="weather__day-name">${escapeHtml(day.name)}</span>
                    <span class="weather__day-temp">${day.high}° / ${day.low}°</span>
                  </div>
                `,
              )
              .join("")}
          </div>
        `;
        el.hidden = false;
      })
      .catch((error) => {
        const el = role<HTMLElement>("weather");
        if (!el || disposed) return;
        el.innerHTML = `<div class="weather__now"><div><div class="weather__place">Wetter</div><div class="weather__desc">${escapeHtml(errorText(error))}</div></div></div>`;
        el.hidden = false;
      });

    // --- Markets (Beobachtungsliste, Kurse über das Gateway) ----------------
    const marketsEl = role<HTMLElement>("markets");
    async function refreshMarkets(): Promise<void> {
      if (!marketsEl) return;
      const watchlist = loadWatchlist().slice(0, HOME_MARKET_ROWS);
      if (watchlist.length === 0) {
        marketsEl.innerHTML =
          '<li class="card__empty">Beobachtungsliste leer — unter Trading Symbole suchen.</li>';
        return;
      }
      try {
        const data = await ctx.api.get<MarketQuotesData>(
          `/integrations/markets/quotes?symbols=${encodeURIComponent(watchlist.join(","))}`,
        );
        if (disposed) return;
        const rows = watchlist
          .map((symbol) => {
            const quote = data.quotes.find((q) => q.symbol.toUpperCase() === symbol.toUpperCase());
            return quote ? marketRow(quote, symbol) : "";
          })
          .join("");
        marketsEl.innerHTML =
          rows.length > 0 ? rows : '<li class="card__empty">Keine Kurse von Yahoo Finance.</li>';
      } catch (error) {
        if (disposed) return;
        marketsEl.innerHTML = `<li class="card__empty">${escapeHtml(errorText(error))}</li>`;
      }
    }
    void refreshMarkets();
    const marketsTimer = globalThis.setInterval(() => void refreshMarkets(), MARKETS_EVERY_MS);
    const openSymbol = (target: EventTarget | null): boolean => {
      const row = (target as HTMLElement | null)?.closest<HTMLElement>("[data-symbol]");
      if (!row?.dataset.symbol) return false;
      rememberSelectedSymbol(row.dataset.symbol);
      ctx.navigate("trading");
      return true;
    };
    marketsEl?.addEventListener("click", (event) => void openSymbol(event.target));
    marketsEl?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      if (openSymbol(event.target)) event.preventDefault();
    });

    // --- Inbox (GET /integrations/mail, alle verbundenen Konten) -------------
    void ctx.api
      .get<MailData>("/integrations/mail")
      .then((data) => {
        const el = role<HTMLElement>("inbox");
        if (!el || disposed) return;
        if (data.messages.length === 0) {
          el.innerHTML = '<li class="card__empty">Keine Nachrichten.</li>';
          return;
        }
        el.innerHTML = data.messages
          .slice(0, 5)
          .map(
            (message) => `
              <li class="inbox-row${message.unread ? "" : " inbox-row--read"}">
                <span class="inbox-row__dot"></span>
                <span class="inbox-row__from">${escapeHtml(message.from)}</span>
                <span class="inbox-row__time">${escapeHtml(formatRelativeTime(message.receivedAt))}</span>
                <span class="inbox-row__subject">${escapeHtml(message.subject)}</span>
              </li>
            `,
          )
          .join("");
      })
      .catch((error) => {
        const el = role<HTMLElement>("inbox");
        if (el && !disposed)
          el.innerHTML = `<li class="card__empty">${escapeHtml(errorText(error))}</li>`;
      });

    // --- Heute (GET /integrations/calendar) -----------------------------------
    void ctx.api
      .get<CalendarData>("/integrations/calendar")
      .then((data) => {
        const el = role<HTMLElement>("today");
        if (!el || disposed) return;
        if (!data.connected) {
          el.innerHTML =
            '<li class="card__empty">Kein Kalender verbunden. Zugangsdaten in n8n hinterlegen, dann stehen die Termine hier.</li>';
          return;
        }
        if (data.events.length === 0) {
          el.innerHTML = '<li class="card__empty">Heute keine Termine.</li>';
          return;
        }
        const rest = data.events.length - HOME_TODAY_ROWS;
        el.innerHTML = `${data.events
          .slice(0, HOME_TODAY_ROWS)
          .map(
            (event) => `
              <li class="today-row">
                <time class="today-row__time">${
                  event.allDay ? "ganztags" : escapeHtml(formatClockTime(event.startsAt))
                }</time>
                <span class="today-row__label">${escapeHtml(event.title)}</span>
              </li>
            `,
          )
          .join(
            "",
          )}${rest > 0 ? `<li class="today-row today-row--more">+${rest} weitere</li>` : ""}`;
      })
      .catch((error) => {
        const el = role<HTMLElement>("today");
        if (el && !disposed)
          el.innerHTML = `<li class="card__empty">${escapeHtml(errorText(error))}</li>`;
      });

    // --- System (GET /integrations/system) -------------------------------------
    const metersEl = role<HTMLElement>("gauges");
    async function refreshSystem(): Promise<void> {
      if (!metersEl) return;
      try {
        const data = await ctx.api.get<SystemData>("/integrations/system");
        if (disposed) return;
        metersEl.innerHTML = data.gauges.map(meter).join("");
      } catch (error) {
        if (disposed) return;
        metersEl.innerHTML = `<li class="card__empty">${escapeHtml(errorText(error))}</li>`;
      }
    }
    void refreshSystem();
    // CPU und Netz sind Raten aus zwei Messpunkten: der erste Wert ist eine Näherung, ein früher
    // zweiter Abruf liefert die echte Zahl, danach der normale Takt.
    const systemWarmup = globalThis.setTimeout(() => void refreshSystem(), 2500);
    const systemTimer = globalThis.setInterval(() => void refreshSystem(), SYSTEM_EVERY_MS);

    // --- Notiz (die jüngste des Gedächtnisses) --------------------------------
    void ctx.api
      .get<NotesData>("/integrations/notes")
      .then((data) => {
        const quote = role<HTMLElement>("note-quote");
        const author = role<HTMLElement>("note-author");
        if (disposed) return;
        const latest = data.notes[0];
        if (!latest) {
          if (quote) {
            quote.textContent = "Noch keine Notiz. Was Kuronami sich merkt, steht hier.";
            quote.classList.add("note-quote--empty");
          }
          if (author) author.textContent = "";
          return;
        }
        if (quote) quote.textContent = latest.excerpt || latest.title;
        if (author) {
          author.textContent = `${latest.title}, ${formatRelativeTime(latest.updatedAt)}`;
        }
      })
      .catch((error) => {
        const quote = role<HTMLElement>("note-quote");
        if (quote && !disposed) quote.textContent = errorText(error);
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
      disposed = true;
      globalThis.clearInterval(clockTimer);
      globalThis.clearInterval(marketsTimer);
      globalThis.clearInterval(systemTimer);
      globalThis.clearTimeout(systemWarmup);
    };
  },
};
