import { type ApiClient, ApiError } from "../api/client.js";
import type {
  CalendarData,
  MailData,
  MarketQuotesData,
  SystemData,
  WeatherData,
} from "../integrations/types.js";
import { loadWeather } from "../integrations/weather.js";
import { formatPercent, formatPrice } from "../markets/format.js";
import { loadSettings } from "../settings/store.js";
import { formatRelativeTime } from "../views/format.js";
import { escapeHtml } from "../views/html.js";
import { kurslinie, kurzSymbol, uhrzeit } from "./form.js";
import type { Tafel } from "./verlauf.js";

/**
 * Die Tafeln der Welle — Wetter, Kurse, Post, Kalender, Rechner.
 *
 * Dieselben fünf Dinge stehen an zwei Stellen: als Tafel im Gespräch, wenn Kuro eine hinlegt
 * (`ui.zeige`, `gateway/buehne.ts`) — „wie steht der DAX", und unter Kuros Antwort liegt die
 * Kurstafel —, und in „Dein Tag" unter der Präsenz. Beide Male mit denselben Zahlen aus denselben
 * Routen; hier steht, wie sie aussehen.
 *
 * Was nicht verbunden ist oder nicht antwortet, sagt das mit dem Grund, den der Gateway nennt —
 * keine erfundene Zeile, kein ewiges „lädt".
 */

export const TAFEL_NAME: Record<Tafel, string> = {
  wetter: "Wetter",
  kurse: "Märkte",
  post: "Post",
  kalender: "Kalender",
  system: "Rechner",
};

/** Wohin eine Tafel führt, wenn man sie antippt. Das Wetter hat keinen eigenen Bereich. */
const TAFEL_ZIEL: Record<Tafel, string | null> = {
  wetter: null,
  kurse: "#/trading",
  post: "#/mail",
  kalender: "#/calendar",
  system: "#/system",
};

export function fehlerSatz(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === "no_token") return "Nicht angemeldet.";
    if (error.status === "network") return `Der Gateway antwortet nicht. ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

const fehlerHtml = (error: unknown): string =>
  `<p class="t-fehler">${escapeHtml(fehlerSatz(error))}</p>`;

// ---------------------------------------------------------------------------
// Laden
// ---------------------------------------------------------------------------

export const hole = {
  wetter: (): Promise<WeatherData> => loadWeather(loadSettings().weather),
  kurse: (api: ApiClient): Promise<MarketQuotesData> =>
    api.get<MarketQuotesData>(
      `/integrations/markets/quotes?symbols=${encodeURIComponent(loadSettings().markets.watchlist.join(","))}`,
    ),
  post: (api: ApiClient): Promise<MailData> => api.get<MailData>("/integrations/mail"),
  kalender: (api: ApiClient): Promise<CalendarData> =>
    api.get<CalendarData>("/integrations/calendar"),
  system: (api: ApiClient): Promise<SystemData> => api.get<SystemData>("/integrations/system"),
};

// ---------------------------------------------------------------------------
// Zeichnen
// ---------------------------------------------------------------------------

export function wetterHtml(w: WeatherData): string {
  const tage = w.forecast
    .slice(0, 4)
    .map(
      (t) =>
        `<li><span>${escapeHtml(t.name)}</span><span class="t-zahl">${Math.round(t.high)}° / ${Math.round(t.low)}°</span></li>`,
    )
    .join("");
  return `
    <div class="t-wetter">
      <p class="t-wetter__jetzt"><span class="t-wetter__grad t-zahl">${Math.round(w.temperature)}°</span>
        <span class="t-wetter__lage">${escapeHtml(w.description)} in ${escapeHtml(w.place)}</span></p>
      ${tage ? `<ol class="t-wetter__tage">${tage}</ol>` : ""}
    </div>`;
}

export function kurseHtml(d: MarketQuotesData): string {
  if (d.quotes.length === 0) {
    return `<p class="t-leer">Die Beobachtungsliste ist leer. In den Märkten lässt sich ein Wert hinzufügen.</p>`;
  }
  const zeilen = d.quotes
    .map((q) => {
      const richtung = q.changePct < 0 ? "ist-runter" : "ist-rauf";
      const linie = kurslinie(q.spark, 96, 28, 2);
      return `
        <a class="t-kurs" href="#/trading">
          <span class="t-kurs__name">${escapeHtml(q.name || kurzSymbol(q.symbol))}<small>${escapeHtml(kurzSymbol(q.symbol))}</small></span>
          <svg class="t-kurs__linie ${richtung}" viewBox="0 0 96 28" preserveAspectRatio="none" aria-hidden="true">${linie ? `<path d="${linie}"/>` : ""}</svg>
          <span class="t-kurs__preis t-zahl">${escapeHtml(formatPrice(q.price))}</span>
          <span class="t-kurs__wandel t-zahl ${richtung}">${escapeHtml(formatPercent(q.changePct))}</span>
        </a>`;
    })
    .join("");
  const fehlend = d.failed.length
    ? `<p class="t-hinweis">Ohne Kurs: ${escapeHtml(d.failed.join(", "))}</p>`
    : "";
  return `<div class="t-kurse">${zeilen}</div>${fehlend}`;
}

export function postHtml(m: MailData, anzahl = 4, mitSatz = true): string {
  const ungelesen = m.messages.filter((b) => b.unread);
  const zeigen = (ungelesen.length > 0 ? ungelesen : m.messages).slice(0, anzahl);
  const kopf =
    m.unreadCount === 0
      ? "Alles gelesen."
      : m.unreadCount === 1
        ? "Ein ungelesener Brief."
        : `${m.unreadCount} ungelesene Briefe.`;
  const briefe = zeigen
    .map(
      (b) => `
        <a class="t-brief${b.unread ? " ist-ungelesen" : ""}" href="#/mail">
          <span class="t-brief__von">${escapeHtml(b.from)}</span>
          <span class="t-brief__betreff">${escapeHtml(b.subject || "(ohne Betreff)")}</span>
          <span class="t-brief__zeit">${escapeHtml(formatRelativeTime(b.receivedAt))}</span>
        </a>`,
    )
    .join("");
  return `${mitSatz ? `<p class="t-satz">${kopf}</p>` : ""}<div class="t-briefe">${briefe}</div>`;
}

export function kalenderHtml(k: CalendarData): string {
  if (!k.connected) {
    return `<p class="t-leer">${escapeHtml(k.reason ?? "Kein Kalender verbunden.")}
      <a href="#/settings/integrations">Kalender verbinden</a></p>`;
  }
  if (k.events.length === 0) return `<p class="t-leer">Heute steht nichts an.</p>`;
  return `<ol class="t-termine">${k.events
    .slice(0, 6)
    .map(
      (e) => `
        <li class="t-termin">
          <span class="t-termin__zeit t-zahl">${e.allDay ? "ganztägig" : escapeHtml(uhrzeit(new Date(e.startsAt)))}</span>
          <span class="t-termin__titel">${escapeHtml(e.title)}${e.location ? `<small>${escapeHtml(e.location)}</small>` : ""}</span>
        </li>`,
    )
    .join("")}</ol>`;
}

export function systemHtml(s: SystemData): string {
  return `<div class="t-rechner">${s.gauges
    .map((g) => {
      const p = Math.max(0, Math.min(100, g.percent));
      const heiss = p >= 85 ? " ist-heiss" : "";
      return `
        <div class="t-mass${heiss}">
          <span class="t-mass__name">${escapeHtml(g.label)}</span>
          <span class="t-mass__balken" aria-hidden="true"><span style="width:${p.toFixed(1)}%"></span></span>
          <span class="t-mass__wert t-zahl">${escapeHtml(g.readout)}</span>
        </div>`;
    })
    .join("")}</div>`;
}

/** Eine Tafel samt Daten, fertig für das Gespräch. */
export async function tafelHtml(t: Tafel, api: ApiClient): Promise<string> {
  let inhalt: string;
  try {
    switch (t) {
      case "wetter":
        inhalt = wetterHtml(await hole.wetter());
        break;
      case "kurse":
        inhalt = kurseHtml(await hole.kurse(api));
        break;
      case "post":
        inhalt = postHtml(await hole.post(api), 3);
        break;
      case "kalender":
        inhalt = kalenderHtml(await hole.kalender(api));
        break;
      case "system":
        inhalt = systemHtml(await hole.system(api));
        break;
    }
  } catch (error) {
    inhalt = fehlerHtml(error);
  }
  const ziel = TAFEL_ZIEL[t];
  const titel = ziel
    ? `<a class="t-tafel__titel" href="${ziel}">${TAFEL_NAME[t]}</a>`
    : `<span class="t-tafel__titel">${TAFEL_NAME[t]}</span>`;
  return `<section class="t-tafel t-tafel--${t}"><header>${titel}</header>${inhalt}</section>`;
}

export { fehlerHtml };
