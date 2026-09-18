import type { ApiClient } from "../api/client.js";
import type {
  CalendarData,
  MailData,
  MarketQuotesData,
  SystemData,
} from "../integrations/types.js";
import { loadWeather } from "../integrations/weather.js";
import { loadSettings } from "../settings/store.js";
import { formatRelativeTime } from "../views/format.js";
import { escapeHtml } from "../views/html.js";

/**
 * Die Tafeln — was Kuro hinstellt, wenn es gebraucht wird.
 *
 * Keine Karten. Das Dashboard hat Karten, und die Präsenz ist ausdrücklich keines: hier steht
 * eine Tafel nur dann, wenn Kuro sie zeigt oder Jakob danach fragt, und sie geht wieder weg.
 * Deshalb kein Rahmen, kein Schatten, kein Glas — Text auf dem Wasser, gruppiert durch eine
 * feine Linie links, damit man sieht, wo eine Tafel anfängt und wo sie aufhört.
 *
 * Die Daten kommen von denselben Routen wie im Dashboard. Eine zweite Datenquelle für dieselbe
 * Auskunft wäre eine zweite Wahrheit.
 */

export type TafelName = "wetter" | "kurse" | "post" | "kalender" | "system";

export const TAFEL_TITEL: Record<TafelName, string> = {
  wetter: "Wetter",
  kurse: "Kurse",
  post: "Post",
  kalender: "Termine",
  system: "Rechner",
};

const KONTO_FARBEN = ["#6BA8F5", "#E0A75F", "#7FC99B", "#C88BD6", "#E0857D"] as const;

function zahl(n: number, stellen = 2): string {
  return n.toLocaleString("de-AT", { minimumFractionDigits: stellen, maximumFractionDigits: stellen });
}

function fehlerText(error: unknown): string {
  const t = error instanceof Error ? error.message : String(error);
  return t.length > 90 ? `${t.slice(0, 88)}…` : t;
}

/** Baut den Inhalt einer Tafel. Wirft nie — ein Fehler wird zur Auskunft. */
export async function renderTafel(name: TafelName, api: ApiClient): Promise<string> {
  try {
    switch (name) {
      case "wetter": {
        const w = await loadWeather(loadSettings().weather);
        return `
          <div class="tafel__zeile tafel__zeile--gross">
            <span>${escapeHtml(w.place)}</span>
            <span class="tafel__zahl">${Math.round(w.temperature)}°</span>
          </div>
          <div class="tafel__leise">${escapeHtml(w.description)}</div>
          <div class="tafel__reihe">
            ${w.forecast
              .slice(0, 4)
              .map(
                (d) => `<div class="tafel__tag"><span>${escapeHtml(d.name)}</span>
                        <span class="tafel__zahl">${Math.round(d.high)}° <em>${Math.round(d.low)}°</em></span></div>`,
              )
              .join("")}
          </div>`;
      }
      case "kurse": {
        const liste = loadSettings().markets.watchlist;
        const d = await api.get<MarketQuotesData>(
          `/integrations/markets/quotes?symbols=${encodeURIComponent(liste.join(","))}`,
        );
        if (d.quotes.length === 0) return `<div class="tafel__leise">Keine Kurse abrufbar.</div>`;
        return d.quotes
          .map((q) => {
            const runter = q.changePct < 0;
            return `<div class="tafel__zeile">
              <span>${escapeHtml(q.name || q.symbol)}</span>
              <span class="tafel__zahl">${zahl(q.price)}
                <em class="${runter ? "ist-runter" : "ist-rauf"}">${runter ? "−" : "+"}${zahl(Math.abs(q.changePct))} %</em>
              </span></div>`;
          })
          .join("");
      }
      case "post": {
        const d = await api.get<MailData>("/integrations/mail");
        if (d.messages.length === 0) return `<div class="tafel__leise">Keine Nachrichten.</div>`;
        return `
          <div class="tafel__leise">${d.unreadCount} ungelesen</div>
          ${d.messages
            .slice(0, 5)
            .map((m) => {
              const farbe = KONTO_FARBEN[Math.max(0, d.konten.indexOf(m.konto)) % KONTO_FARBEN.length];
              return `<div class="tafel__post${m.unread ? " ist-ungelesen" : ""}" style="--konto-farbe:${farbe}">
                <span class="tafel__konto">${escapeHtml(m.konto)}</span>
                <span class="tafel__von">${escapeHtml(m.from)}</span>
                <span class="tafel__zeit">${escapeHtml(formatRelativeTime(m.receivedAt))}</span>
                <span class="tafel__betreff">${escapeHtml(m.subject)}</span>
              </div>`;
            })
            .join("")}`;
      }
      case "kalender": {
        const d = await api.get<CalendarData>("/integrations/calendar");
        if (!d.connected) return `<div class="tafel__leise">Kein Kalender verbunden.</div>`;
        if (d.events.length === 0) return `<div class="tafel__leise">Nichts eingetragen.</div>`;
        return d.events
          .slice(0, 5)
          .map((e) => {
            const wann = e.allDay
              ? "ganztags"
              : new Date(e.startsAt).toLocaleTimeString("de-AT", { hour: "2-digit", minute: "2-digit" });
            return `<div class="tafel__zeile"><span>${escapeHtml(e.title)}</span>
                    <span class="tafel__zahl">${wann}</span></div>`;
          })
          .join("");
      }
      case "system": {
        const d = await api.get<SystemData>("/integrations/system");
        return d.gauges
          .map(
            (g) => `<div class="tafel__mass">
              <span>${escapeHtml(g.label)}</span>
              <span class="tafel__balken"><i style="width:${Math.max(0, Math.min(100, g.percent))}%"></i></span>
              <span class="tafel__zahl">${escapeHtml(g.readout)}</span>
            </div>`,
          )
          .join("");
      }
    }
  } catch (error) {
    return `<div class="tafel__leise">Nicht abrufbar: ${escapeHtml(fehlerText(error))}</div>`;
  }
}
