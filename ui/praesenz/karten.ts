import type { ApiClient } from "../api/client.js";
import { icon } from "../icons.js";
import type {
  CalendarData,
  MailData,
  MarketQuotesData,
  ResearchData,
  SystemData,
} from "../integrations/types.js";
import { loadWeather } from "../integrations/weather.js";
import { loadSettings } from "../settings/store.js";
import { formatRelativeTime } from "../views/format.js";
import { escapeHtml } from "../views/html.js";

/**
 * Die Karten der Präsenz — nach Jakobs Bild: rechts eine Spalte aus Glas mit Recent Activity,
 * System Overview und Markets, oben rechts das Wetter.
 *
 * Der Text-Prompt sagt, nichts solle dauerhaft herumliegen; das Bild zeigt genau diese drei
 * Karten. Beides gilt: die Karten **liegen** da, aber gedimmt wie Gegenstände im Halbdunkel,
 * und treten erst hervor, wenn Kuro eine zeigt oder Jakob danach fragt (`ist-aktiv` in
 * `view.ts`). Im Fokus verschwinden sie ganz.
 *
 * Alle Zahlen sind echt und kommen von denselben Routen wie das Dashboard. Was nicht
 * verbunden ist, sagt das — „Not connected" —, statt eine Zeile zu erfinden.
 */

export type Karte = "activity" | "system" | "markets";

function fehler(error: unknown): string {
  const t = error instanceof Error ? error.message : String(error);
  return t.length > 60 ? `${t.slice(0, 58)}…` : t;
}

function zahl(n: number, stellen = 0): string {
  return n.toLocaleString("en-GB", { minimumFractionDigits: stellen, maximumFractionDigits: stellen });
}

function prozent(p: number): string {
  return `${p >= 0 ? "+" : "−"}${Math.abs(p).toFixed(1)}%`;
}

function reihe(ikon: string, titel: string, unter: string, ziel?: string): string {
  const inner = `
    <span class="k-reihe__ikon">${icon(ikon as Parameters<typeof icon>[0])}</span>
    <span class="k-reihe__text">
      <span class="k-reihe__titel">${escapeHtml(titel)}</span>
      <span class="k-reihe__unter">${escapeHtml(unter)}</span>
    </span>`;
  return ziel
    ? `<a class="k-reihe" href="#/${ziel}">${inner}</a>`
    : `<div class="k-reihe">${inner}</div>`;
}

// ---------------------------------------------------------------------------
// Wetter, oben rechts
// ---------------------------------------------------------------------------

export async function renderWetter(): Promise<string> {
  try {
    const w = await loadWeather(loadSettings().weather);
    return `
      <span class="p-wetter__ikon">${icon(w.night ? "moon" : "sun")}</span>
      <span class="p-wetter__temp">${Math.round(w.temperature)}°C</span>
      <span class="p-wetter__ort">${escapeHtml(w.place)}</span>
      <span class="p-wetter__lage">${escapeHtml(w.description)}</span>`;
  } catch {
    return `<span class="p-wetter__lage">Weather unavailable</span>`;
  }
}

// ---------------------------------------------------------------------------
// Recent Activity
// ---------------------------------------------------------------------------

export async function renderActivity(api: ApiClient): Promise<string> {
  const zeilen: string[] = [];

  const [mail, kurse, kalender, system, research] = await Promise.allSettled([
    api.get<MailData>("/integrations/mail"),
    api.get<MarketQuotesData>(
      `/integrations/markets/quotes?symbols=${encodeURIComponent(loadSettings().markets.watchlist.slice(0, 2).join(","))}`,
    ),
    api.get<CalendarData>("/integrations/calendar"),
    api.get<SystemData>("/integrations/system"),
    api.get<ResearchData>("/integrations/research"),
  ]);

  if (mail.status === "fulfilled") {
    const neueste = mail.value.messages[0];
    zeilen.push(
      reihe(
        "mail",
        mail.value.unreadCount > 0 ? "New emails" : "Inbox",
        `${mail.value.unreadCount} unread${neueste ? ` · ${formatRelativeTime(neueste.receivedAt)}` : ""}`,
        "mail",
      ),
    );
  } else {
    zeilen.push(reihe("mail", "Mail", "Not connected", "mail"));
  }

  if (kurse.status === "fulfilled" && kurse.value.quotes.length > 0) {
    zeilen.push(
      reihe(
        "trading",
        "Markets update",
        kurse.value.quotes.map((q) => `${q.symbol.replace(/^\^/, "")} ${prozent(q.changePct)}`).join(" · "),
        "trading",
      ),
    );
  }

  if (kalender.status === "fulfilled") {
    const k = kalender.value;
    zeilen.push(
      reihe(
        "calendar",
        "Calendar",
        !k.connected
          ? "Not connected"
          : k.events.length === 0
            ? "Nothing today"
            : `${k.events.length} ${k.events.length === 1 ? "meeting" : "meetings"} today`,
        "calendar",
      ),
    );
  }

  if (system.status === "fulfilled") {
    const heiss = system.value.gauges.find((g) => g.percent >= 85);
    zeilen.push(
      reihe(
        "system",
        "Server status",
        heiss ? `${heiss.label} at ${Math.round(heiss.percent)}%` : "All systems normal",
        "system",
      ),
    );
  }

  if (research.status === "fulfilled" && research.value.findings.length > 0) {
    const f = research.value.findings[0];
    zeilen.push(reihe("research", "Research", `${f.summary.slice(0, 40)} · ${formatRelativeTime(f.savedAt)}`, "research"));
  }

  return zeilen.join("") || `<div class="k-leer">Nothing yet.</div>`;
}

// ---------------------------------------------------------------------------
// System Overview
// ---------------------------------------------------------------------------

export async function renderSystem(api: ApiClient): Promise<string> {
  try {
    const d = await api.get<SystemData>("/integrations/system");
    const cpu = d.gauges.find((g) => g.id === "cpu");
    const p = Math.max(0, Math.min(100, cpu?.percent ?? 0));
    const umfang = 2 * Math.PI * 22;
    const zeilen = d.gauges
      .filter((g) => g.id !== "cpu")
      .map(
        (g) => `<div class="k-mass"><span>${escapeHtml(g.label)}</span><span class="k-zahl">${escapeHtml(g.readout)}</span></div>`,
      )
      .join("");
    return `
      <div class="k-system">
        <svg class="k-ring" viewBox="0 0 52 52" aria-hidden="true">
          <circle cx="26" cy="26" r="22" fill="none" stroke="rgba(255,255,255,0.09)" stroke-width="2.2"/>
          <circle cx="26" cy="26" r="22" fill="none" stroke="var(--p-akzent)" stroke-width="2.2"
                  stroke-linecap="round" stroke-dasharray="${(umfang * p) / 100} ${umfang}"
                  transform="rotate(-90 26 26)"/>
          <text x="26" y="30" text-anchor="middle" font-size="10" fill="currentColor">${Math.round(p)}%</text>
        </svg>
        <div class="k-masse">
          <div class="k-mass"><span>CPU</span><span class="k-zahl">${Math.round(p)}%</span></div>
          ${zeilen}
        </div>
      </div>`;
  } catch (error) {
    return `<div class="k-leer">${escapeHtml(fehler(error))}</div>`;
  }
}

// ---------------------------------------------------------------------------
// Markets
// ---------------------------------------------------------------------------

export async function renderMarkets(api: ApiClient): Promise<string> {
  try {
    const liste = loadSettings().markets.watchlist;
    const d = await api.get<MarketQuotesData>(
      `/integrations/markets/quotes?symbols=${encodeURIComponent(liste.join(","))}`,
    );
    if (d.quotes.length === 0) return `<div class="k-leer">No quotes.</div>`;
    return d.quotes
      .map((q) => {
        const kurz = q.symbol.replace(/^\^/, "").replace(/-USD$|=X$/, "");
        return `
          <a class="k-kurs" href="#/trading">
            <span class="k-kurs__zeichen">${escapeHtml(kurz.slice(0, 1))}</span>
            <span class="k-kurs__name">${escapeHtml(kurz)}</span>
            <span class="k-zahl">${zahl(q.price, q.price < 10 ? 3 : q.price < 1000 ? 2 : 0)}</span>
            <span class="k-zahl ${q.changePct < 0 ? "ist-runter" : "ist-rauf"}">${prozent(q.changePct)}</span>
          </a>`;
      })
      .join("");
  } catch (error) {
    return `<div class="k-leer">${escapeHtml(fehler(error))}</div>`;
  }
}
