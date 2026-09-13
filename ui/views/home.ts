import { icon } from "../icons.js";
import {
  createMockAgendaProvider,
  createMockMailProvider,
  createMockMarketsProvider,
  createMockNotesProvider,
} from "../mock/data.js";
import { formatClockTime, formatRelativeTime } from "./format.js";
import type { View, ViewContext } from "./types.js";

/**
 * Das persoenliche Cockpit (S-Zwischenschub, Punkt 3) — ersetzt den bisherigen
 * Projekt-/Buildstatus vollstaendig. Vier Panels gegen Mock-Provider (`ui/mock/data.ts`),
 * unterschiedlich behandelt statt uniform (Punkt 7): Markets als dichte Kurstabelle, Inbox als
 * Nachrichtenliste mit ungelesen-Betonung, Agenda als Zeitleiste, Notes als Auszugs-Karten.
 *
 * Die drei Buttons sind echte Navigation zu Bereichen, die sonst keine eigene Cockpit-Kachel
 * haben (System, Einstellungen, Dateien) — kein Knopf ohne Wirkung (siehe `progress.md`, S25:
 * genau diese Zurueckhaltung stand schon einmal am Anfang der Vorlagen-Uebernahme).
 */
export const homeView: View = {
  mount(container, ctx) {
    container.innerHTML = `
      <div class="cockpit">
        <header class="cockpit__greeting">
          <span class="cockpit__time" data-role="time">--:--</span>
          <span class="cockpit__date" data-role="date">—</span>
        </header>

        <div class="cockpit__panels">
          <section class="panel panel--markets" aria-labelledby="panel-markets-title">
            <header class="panel__head">
              ${icon("trading", { className: "panel__icon" })}
              <h2 class="panel__title" id="panel-markets-title">Markets</h2>
            </header>
            <div class="panel__body" data-role="markets">Lädt…</div>
          </section>

          <section class="panel panel--inbox" aria-labelledby="panel-inbox-title">
            <header class="panel__head">
              ${icon("mail", { className: "panel__icon" })}
              <h2 class="panel__title" id="panel-inbox-title">Inbox</h2>
              <button class="panel__link" type="button" data-action="open-mail">
                Alle ${icon("chevron", { className: "panel__chevron" })}
              </button>
            </header>
            <div class="panel__body" data-role="inbox">Lädt…</div>
          </section>

          <section class="panel panel--agenda" aria-labelledby="panel-agenda-title">
            <header class="panel__head">
              ${icon("calendar", { className: "panel__icon" })}
              <h2 class="panel__title" id="panel-agenda-title">Agenda</h2>
              <button class="panel__link" type="button" data-action="open-calendar">
                Alle ${icon("chevron", { className: "panel__chevron" })}
              </button>
            </header>
            <div class="panel__body" data-role="agenda">Lädt…</div>
          </section>

          <section class="panel panel--notes" aria-labelledby="panel-notes-title">
            <header class="panel__head">
              ${icon("files", { className: "panel__icon" })}
              <h2 class="panel__title" id="panel-notes-title">Notes</h2>
            </header>
            <div class="panel__body" data-role="notes">Lädt…</div>
          </section>
        </div>

        <div class="cockpit__actions">
          <button class="cockpit__action" type="button" data-action="open-system">
            ${icon("system", { className: "cockpit__action-icon" })}
            <span>System</span>
          </button>
          <button class="cockpit__action" type="button" data-action="open-settings">
            ${icon("settings", { className: "cockpit__action-icon" })}
            <span>Einstellungen</span>
          </button>
          <button class="cockpit__action" type="button" data-action="open-files">
            ${icon("files", { className: "cockpit__action-icon" })}
            <span>Dateien</span>
          </button>
        </div>

        <footer class="cockpit__system" data-role="system-strip">
          <span class="cockpit__system-dot" data-role="system-dot"></span>
          <span data-role="system-text">System · —</span>
          ${icon("chevron", { className: "cockpit__system-chevron" })}
        </footer>
      </div>
    `;

    const timeEl = container.querySelector<HTMLElement>('[data-role="time"]');
    const dateEl = container.querySelector<HTMLElement>('[data-role="date"]');
    const tick = (): void => {
      const now = new Date();
      if (timeEl) timeEl.textContent = now.toLocaleTimeString("de-DE", { hour12: false });
      if (dateEl) {
        dateEl.textContent = now.toLocaleDateString("de-DE", {
          weekday: "long",
          day: "numeric",
          month: "long",
        });
      }
    };
    tick();
    const clockTimer = globalThis.setInterval(tick, 1000);

    const marketsEl = container.querySelector<HTMLElement>('[data-role="markets"]');
    void createMockMarketsProvider()
      .load()
      .then((data) => {
        if (!marketsEl) return;
        marketsEl.innerHTML = `<ul class="markets-list">${data.quotes
          .map(
            (q) =>
              `<li class="markets-list__row"><span class="markets-list__symbol">${q.symbol}</span><span class="markets-list__price">${q.price.toLocaleString("de-DE")}</span><span class="markets-list__change ${q.changePct >= 0 ? "markets-list__change--up" : "markets-list__change--down"}">${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(1)}%</span></li>`,
          )
          .join("")}</ul>`;
      });

    const inboxEl = container.querySelector<HTMLElement>('[data-role="inbox"]');
    void createMockMailProvider()
      .load()
      .then((data) => {
        if (!inboxEl) return;
        inboxEl.innerHTML = `<ul class="inbox-list">${data.messages
          .slice(0, 3)
          .map(
            (m) =>
              `<li class="inbox-list__row${m.unread ? " inbox-list__row--unread" : ""}"><span class="inbox-list__from">${m.from}</span><span class="inbox-list__subject">${m.subject}</span><span class="inbox-list__time">${formatRelativeTime(m.receivedAt)}</span></li>`,
          )
          .join("")}</ul>`;
      });

    const agendaEl = container.querySelector<HTMLElement>('[data-role="agenda"]');
    void createMockAgendaProvider()
      .load()
      .then((data) => {
        if (!agendaEl) return;
        agendaEl.innerHTML = `<ol class="agenda-list">${data.events
          .map(
            (e) =>
              `<li class="agenda-list__row"><time class="agenda-list__time">${formatClockTime(e.startsAt)}</time><span class="agenda-list__title">${e.title}</span></li>`,
          )
          .join("")}</ol>`;
      });

    const notesEl = container.querySelector<HTMLElement>('[data-role="notes"]');
    void createMockNotesProvider()
      .load()
      .then((data) => {
        if (!notesEl) return;
        notesEl.innerHTML = data.notes
          .map(
            (n) =>
              `<article class="note-card"><h3 class="note-card__title">${n.title}</h3><p class="note-card__excerpt">${n.excerpt}</p><span class="note-card__time">${formatRelativeTime(n.updatedAt)}</span></article>`,
          )
          .join("");
      });

    const systemDot = container.querySelector<HTMLElement>('[data-role="system-dot"]');
    const systemText = container.querySelector<HTMLElement>('[data-role="system-text"]');
    const STATUS_LABEL: Record<string, string> = {
      connecting: "verbindet",
      open: "verbunden",
      closed: "getrennt",
    };
    const applyStatus = (status: string): void => {
      if (systemDot) systemDot.dataset.status = status;
      if (systemText) systemText.textContent = `System · ${STATUS_LABEL[status] ?? status}`;
    };
    applyStatus(ctx.bus.status);
    const unsubscribeStatus = ctx.bus.onStatus((status) => applyStatus(status));

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
        case "open-system":
          ctx.navigate("system");
          break;
        case "open-settings":
          ctx.navigate("settings");
          break;
        case "open-files":
          ctx.navigate("files");
          break;
        default:
          break;
      }
    });
    const systemStrip = container.querySelector<HTMLElement>('[data-role="system-strip"]');
    systemStrip?.addEventListener("click", () => ctx.navigate("system"));

    return () => {
      globalThis.clearInterval(clockTimer);
      unsubscribeStatus();
    };
  },
};
