import { ApiError } from "../api/client.js";
import { icon } from "../icons.js";
import type { MarketQuote, MarketQuotesData, MarketSearchHit } from "../integrations/types.js";
import {
  type ArbeitUebersicht,
  type PrognoseMitStand,
  STAND_WORT,
  type StrategieImChart,
  prognoseFormen,
  strategieFormen,
  strategieZeile,
  wer,
} from "../markets/arbeit.js";
import { anzeigeName, describeQuoteType, formatPercent, formatPrice } from "../markets/format.js";
import { FARBE, type Form } from "../markets/formen.js";
import {
  type AktiverIndikator,
  FARBEN,
  INDIKATOREN,
  anfrageFuer,
  ausId,
  beschriftung,
  farbeFuer,
  indikatorDef,
  indikatorId,
  reihenStile,
} from "../markets/indikatoren.js";
import {
  HANDY_ZEITRAEUME,
  type HandyZeitraum,
  INTERVALLE,
  type IntervallId,
  ZEITRAEUME,
  anzeigeZeit,
  handelsanteilAus,
  handyIntervall,
  handyZeitraum,
  intervall,
  istIntervallId,
  passendesIntervall,
  zeitraum,
  zeitraumTage,
  zeitraumVon,
  zonenKuerzel,
} from "../markets/intervalle.js";
import {
  type IndikatorAntwort,
  type KennzahlenAntwort,
  type Kerze,
  type KerzenAntwort,
  type Kurskopf,
  ausDraht,
  formatKurs,
  formatVolumen,
  heikinAshi,
  marktLage,
  stellenFuer,
  vereine,
  voranstellen,
} from "../markets/kerzen.js";
import {
  SPEICHER_OFFENE,
  liesOffene,
  oeffneChart,
  schliesseChart,
} from "../markets/offene-charts.js";
import {
  addSymbol,
  chartSymbolFuer,
  hasSymbol,
  holeChartAbsicht,
  loadWatchlist,
  recallSelectedSymbol,
  rememberSelectedSymbol,
  removeSymbol,
  saveWatchlist,
} from "../markets/watchlist.js";
import { type AchsenMarke, Ebene, Zeichenstift } from "../markets/zeichenebene.js";
import {
  type Werkzeug,
  type Zeichnung,
  beschreibe,
  positionsZahlen,
} from "../markets/zeichnungen.js";
import {
  type ChartSettings,
  loadSettings,
  settingsBus,
  updateSettingsSection,
} from "../settings/store.js";
import {
  AreaSeries,
  BarSeries,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  TrackingModeExitMode,
  createChart,
  createSeriesMarkers,
} from "../vendor/lightweight-charts-5.standalone.production.mjs";
import type {
  IChartApi,
  IPriceLine,
  ISeriesApi,
  ISeriesMarkersPluginApi,
  MouseEventParams,
  SeriesType,
  Time,
  UTCTimestamp,
} from "../vendor/lightweight-charts-5.standalone.production.mjs";
import { escapeHtml } from "./html.js";
import { renderMarkdown } from "./markdown.js";
import type { View, ViewContext } from "./types.js";

/**
 * Die Märkte (Umbau 2026-09-27, nach TradingView).
 *
 * Jakob: „Schau dir hier wirklich die Seite von TradingView an, je mehr ich direkt auf Kuro
 * selber in den Märkten machen kann, desto besser" — und: „bei 1 Tag steht dann 5m Kerzen? Ist
 * für mich absolut nicht übersichtlich." Daraus die Ordnung dieser Seite:
 *
 *  * **Oben die Kerzengröße**, ausgeschrieben („1 Std", „Tag"). **Unten der Zeitraum**, der nur
 *    noch bestimmt, wohin der Chart schaut. Passt beides nicht zusammen, wechselt die Größe mit
 *    einem Satz dazu (`intervalle.ts`).
 *  * **Links die Zeichenstifte**: Linie, Trendlinie, Zone, Fibonacci, Long/Short, Messen, Notiz.
 *    Gespeichert im Gateway, damit sie auf dem iPhone dieselben sind und der Handelstisch sie
 *    lesen kann.
 *  * **Rechts die Liste und der gewählte Wert**: Überblick mit Kennzahlen, Kuro (fragen, seine
 *    Ideen und Strategien auf dem Chart), Alarme.
 *
 * Was hier gerechnet wird, rechnet das Gateway mit denselben Funktionen wie der Handelstisch —
 * Indikatoren, CRV, die Handel einer Strategie. Die Ansicht zeichnet nur.
 *
 * **Auf dem Telefon ist die Seite schlicht** (Jakob, am selben Tag: „am Handy ist das zu viel
 * Information … damit man auch am Handy eine geile Übersicht hat"): oben Name und Kurs groß,
 * ein ruhiger Chart, darunter nur der Zeitraum — die Kerzengröße folgt ihm —, dann die Liste.
 * Stifte, Indikatoren, Wiedergabe und die übrigen Kennzahlen liegen hinter „⋯"; weg ist nichts.
 */

type Typ = ChartSettings["typ"];

const TYPEN: { id: Typ; name: string }[] = [
  { id: "kerzen", name: "Kerzen" },
  { id: "heikin", name: "Heikin-Ashi" },
  { id: "balken", name: "Balken" },
  { id: "linie", name: "Linie" },
  { id: "flaeche", name: "Fläche" },
];

const SVG = (inhalt: string) =>
  `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inhalt}</svg>`;

const WERKZEUGE: { id: Werkzeug; name: string; taste?: string; bild: string }[] = [
  {
    id: "zeiger",
    name: "Zeiger — auswählen und verschieben",
    bild: SVG('<path d="M5 3.5 15 10l-4.4 1.1L8.4 16Z"/>'),
  },
  {
    id: "trend",
    name: "Trendlinie",
    taste: "Alt+T",
    bild: SVG(
      '<path d="M4 15.5 16 4.5"/><circle cx="4" cy="15.5" r="1.3"/><circle cx="16" cy="4.5" r="1.3"/>',
    ),
  },
  {
    id: "horizontal",
    name: "Horizontale Linie",
    taste: "Alt+H",
    bild: SVG('<path d="M2.5 10h15"/><circle cx="10" cy="10" r="1.3"/>'),
  },
  {
    id: "rechteck",
    name: "Zone",
    taste: "Alt+R",
    bild: SVG('<rect x="3.5" y="5.5" width="13" height="9" rx="1"/>'),
  },
  {
    id: "fib",
    name: "Fibonacci-Retracement",
    taste: "Alt+F",
    bild: SVG(
      '<path d="M3 4.5h14M3 8h14M3 11h14M3 15.5h14" stroke-dasharray="0"/><path d="M4 15.5 16 4.5" stroke-dasharray="2 2"/>',
    ),
  },
  {
    id: "long",
    name: "Long-Idee",
    taste: "Alt+L",
    bild: SVG(
      '<rect x="3.5" y="3.5" width="13" height="6" rx="1" stroke="#5fc98c"/><rect x="3.5" y="9.5" width="13" height="4" rx="1" stroke="#e0787f"/><path d="M3.5 9.5h13"/>',
    ),
  },
  {
    id: "short",
    name: "Short-Idee",
    taste: "Alt+S",
    bild: SVG(
      '<rect x="3.5" y="6.5" width="13" height="4" rx="1" stroke="#e0787f"/><rect x="3.5" y="10.5" width="13" height="6" rx="1" stroke="#5fc98c"/><path d="M3.5 10.5h13"/>',
    ),
  },
  {
    id: "messen",
    name: "Messen",
    taste: "Alt+M",
    bild: SVG(
      '<path d="m3.5 13.5 10-10 3 3-10 10Z"/><path d="m6.5 10.5 1.5 1.5M9 8l1.5 1.5M11.5 5.5 13 7"/>',
    ),
  },
  { id: "text", name: "Notiz im Chart", bild: SVG('<path d="M5 5h10M10 5v10"/>') },
];

const TASTEN: Record<string, Werkzeug> = {
  t: "trend",
  h: "horizontal",
  r: "rechteck",
  f: "fib",
  l: "long",
  s: "short",
  m: "messen",
};

const GRUPPEN: { typen: string[]; name: string }[] = [
  { typen: ["INDEX"], name: "Indizes" },
  { typen: ["EQUITY"], name: "Aktien" },
  { typen: ["ETF", "MUTUALFUND"], name: "ETFs und Fonds" },
  { typen: ["CRYPTOCURRENCY"], name: "Krypto" },
  { typen: ["CURRENCY"], name: "Devisen" },
  { typen: ["FUTURE"], name: "Rohstoffe und Futures" },
];

const QUOTES_EVERY_MS = 30_000;
const SEARCH_DEBOUNCE_MS = 200;
const ANFANGS_KERZEN = 150;

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === "no_token") return "Kein Token hinterlegt — siehe Einstellungen › System.";
    if (error.status === 401) return "Token abgelehnt — in den Einstellungen › System prüfen.";
    if (error.status === 404) return "Das ist auf diesem Gateway nicht eingerichtet.";
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function uhr(unix?: number): string {
  const d = unix ? new Date(unix * 1000) : new Date();
  return d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

function datum(unix: number, mitZeit: boolean): string {
  const d = new Date(unix * 1000);
  const tag = d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
  return mitZeit ? `${tag} ${uhr(unix)}` : tag;
}

function pruefeZahl(text: string): number | null {
  const n = Number(text.trim().replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function rText(r: number): string {
  return `${r >= 0 ? "+" : "−"}${Math.abs(r).toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 2 })} R`;
}

interface Alarm {
  id: string;
  symbol: string;
  name: string;
  preis: number;
  richtung: "ueber" | "unter";
  angelegt: string;
  notiz?: string;
  status: "aktiv" | "ausgeloest";
  ausgeloestAm?: string;
  ausgeloestKurs?: number;
}

interface NachrichtAntwort {
  status?: string;
  reason?: string;
  delivered?: { kind: string; text?: string }[];
}

interface IndikatorReihen {
  def: AktiverIndikator;
  farbe: string;
  serien: { name: string; serie: ISeriesApi<SeriesType, Time> }[];
  fenster: number | null;
  hinweis?: string;
  linien: IPriceLine[];
}

export const tradingView: View = {
  mount(container: HTMLElement, ctx: ViewContext) {
    // ------------------------------------------------------------------ Zustand
    const absicht = holeChartAbsicht();
    let watchlist = loadWatchlist();
    const erinnert = recallSelectedSymbol();
    let symbol: string =
      (absicht ? chartSymbolFuer(absicht.symbol).symbol : null) ??
      erinnert ??
      watchlist[0] ??
      "^GDAXI";
    const gespeichert = loadSettings().markets.chart;
    let iv: IntervallId = istIntervallId(gespeichert.intervall) ? gespeichert.intervall : "1d";
    let typ: Typ = gespeichert.typ;
    let aktive: AktiverIndikator[] = gespeichert.indikatoren
      .map((i) => ausId([i.art, ...i.parameter].join(":")))
      .filter((i): i is AktiverIndikator => i !== null);
    let volumenAn = gespeichert.volumen;
    let logAn = gespeichert.log;

    // Das Telefon: schlicht, bis „⋯" alle Werkzeuge holt. Die Grenze ist dieselbe wie im Stil.
    const handyFrage = globalThis.matchMedia?.("(max-width: 700px)");
    let handy = handyFrage?.matches ?? false;
    let alleWerkzeuge = false;
    const schlicht = (): boolean => handy && !alleWerkzeuge;
    let handyZr: HandyZeitraum =
      handyZeitraum(gespeichert.handyZeitraum) ?? (handyZeitraum("3M") as HandyZeitraum);
    if (schlicht()) iv = handyIntervall(handyZr, new Date());

    let kerzen: Kerze[] = [];
    let indikatorDaten = new Map<string, IndikatorAntwort>();
    let kopf: Kurskopf | null = null;
    let mehr = false;
    let hatVolumen = false;
    let laedt = false;
    let laedtAeltere = false;
    let ladeNummer = 0;
    let verworfen = false;
    let quotes = new Map<string, MarketQuote>();
    let fehlgeschlagen = new Set<string>();
    let alarme: Alarm[] = [];
    let prognosen: PrognoseMitStand[] = [];
    let arbeit: ArbeitUebersicht | null = null;
    const gezeigteStrategien = new Map<string, StrategieImChart>();
    const verborgeneIdeen = new Set<string>();
    let arbeitSichtbar = true;
    let reiter: "ueberblick" | "kuro" | "alarme" =
      absicht?.strategie || absicht?.prognose ? "kuro" : "ueberblick";
    const wiedergabe = {
      aktiv: false,
      waehlen: false,
      index: 0,
      laeuft: false,
      tempo: 3,
      uhr: 0 as ReturnType<typeof setInterval> | 0,
    };
    let speicherUhr: ReturnType<typeof setTimeout> | null = null;
    let ideeGezeigt = false;

    const merke = (): void => {
      settingsBus.emit(
        updateSettingsSection("markets", {
          watchlist,
          chart: {
            intervall: iv,
            typ,
            indikatoren: aktive,
            volumen: volumenAn,
            log: logAn,
            magnet: stift?.magnet ?? false,
            handyZeitraum: handyZr.id,
          },
        }),
      );
    };

    // ------------------------------------------------------------------ Gerüst
    container.innerHTML = `
      <div class="detail-view detail-view--breit markt">
        <header class="detail-view__head markt__kopf">
          ${icon("trading", { className: "detail-view__icon" })}
          <div>
            <h1 class="detail-view__title">Markets</h1>
            <p class="detail-view__subtitle" data-role="subtitle">Yahoo Finance · lädt …</p>
          </div>
        </header>

        <div class="markt__body">
          <section class="markt__arbeitsplatz glass" aria-label="Chart">
            <div class="markt__handykopf" data-role="handykopf">
              <button type="button" class="markt__handyname" data-role="handy-name" title="Wert wechseln">
                <span data-role="handy-name-text">—</span>${SVG('<path d="m6 8 4 4 4-4"/>')}
              </button>
              <button type="button" class="markt__handymehr" data-role="handy-mehr" aria-pressed="false" title="Alle Werkzeuge: Kerzengröße, Zeichnen, Indikatoren, Wiedergabe">
                ${SVG('<circle cx="5" cy="10" r="1.3"/><circle cx="10" cy="10" r="1.3"/><circle cx="15" cy="10" r="1.3"/>')}
              </button>
              <p class="markt__handykurs" data-role="handy-kurs"></p>
              <p class="markt__handywandel" data-role="handy-wandel"></p>
              <p class="markt__handyzeile" data-role="handy-zeile"></p>
            </div>
            <div class="markt__leiste" role="toolbar" aria-label="Chart-Werkzeuge">
              <button type="button" class="markt__symbol" data-role="symbol-knopf" title="Wert wechseln — einfach lostippen">
                ${icon("research")}<span data-role="symbol-name">—</span>
              </button>
              <div class="markt__gruppe" role="radiogroup" aria-label="Kerzengröße" data-role="intervalle">
                ${INTERVALLE.map((i) => `<button type="button" role="radio" class="markt__knopf" data-iv="${i.id}" title="${i.wort}">${i.knopf}</button>`).join("")}
              </div>
              <span class="markt__trenner"></span>
              <button type="button" class="markt__knopf markt__knopf--menue" data-role="typ-knopf" aria-haspopup="true" title="Darstellung: Kerzen, Heikin-Ashi, Balken, Linie, Fläche"></button>
              <button type="button" class="markt__knopf markt__knopf--menue" data-role="ind-knopf" aria-haspopup="true" title="Indikatoren">
                <span class="markt__fx">ƒx</span><span class="markt__knopf-text">Indikatoren</span><span class="markt__zahl" data-role="ind-zahl"></span>
              </button>
              <button type="button" class="markt__knopf" data-role="arbeit-knopf" aria-pressed="true" title="Kuros Ideen und Strategien auf dem Chart zeigen">
                <span class="markt__kuro-punkt"></span><span class="markt__knopf-text">Kuros Arbeit</span><span class="markt__zahl" data-role="arbeit-zahl"></span>
              </button>
              <button type="button" class="markt__knopf" data-role="wiedergabe-knopf" title="Wiedergabe: den Markt ab einem vergangenen Tag Kerze für Kerze ablaufen lassen">
                ${SVG('<path d="M4 4.5v11M7.5 10l8-5.5v11Z"/>')}<span class="markt__knopf-text">Wiedergabe</span>
              </button>
              <span class="markt__fueller"></span>
              <button type="button" class="markt__knopf" data-role="alarm-knopf" title="Preisalarm auf den aktuellen Wert">${icon("bell")}<span class="markt__knopf-text">Alarm</span></button>
              <button type="button" class="markt__knopf markt__knopf--kuro" data-role="kuro-knopf">Kuro fragen</button>
            </div>

            <div class="markt__buehne">
              <nav class="markt__stifte" role="toolbar" aria-label="Zeichnen" data-role="stifte">
                ${WERKZEUGE.map((w) => `<button type="button" class="markt__stift" data-werkzeug="${w.id}" title="${w.name}${w.taste ? ` (${w.taste})` : ""}" aria-label="${w.name}">${w.bild}</button>`).join("")}
                <span class="markt__stift-trenner"></span>
                <button type="button" class="markt__stift" data-role="magnet" title="Magnet: an Eröffnung, Hoch, Tief und Schluss einrasten" aria-pressed="false">${SVG('<path d="M5.5 4v6a4.5 4.5 0 0 0 9 0V4"/><path d="M5.5 7h3M11.5 7h3"/>')}</button>
                <button type="button" class="markt__stift" data-role="alles-weg" title="Alle Zeichnungen dieses Werts löschen">${SVG('<path d="M4.5 6h11M8 6V4.5h4V6M6 6l.8 10h6.4L14 6"/>')}</button>
              </nav>
              <div class="markt__leinwand" data-role="leinwand" tabindex="0">
                <div class="markt__chart" data-role="chart"></div>
                <div class="markt__legende" data-role="legende"></div>
                <div class="markt__auswahl" data-role="auswahl" hidden></div>
                <div class="markt__wiedergabe" data-role="wiedergabe" hidden></div>
                <div class="markt__hinweis" data-role="hinweis" hidden></div>
                <div class="markt__suche" data-role="suche" hidden>
                  <label class="search__field">
                    ${icon("research", { className: "search__icon" })}
                    <input class="search__input" type="search" data-role="suche-feld" autocomplete="off" spellcheck="false"
                      placeholder="Name oder Kürzel, z. B. Rheinmetall, ^GDAXI, BTC-USD" aria-label="Wert suchen" />
                  </label>
                  <ul class="markt__treffer" data-role="suche-treffer"></ul>
                </div>
                <div class="markt__eingabe" data-role="eingabe" hidden></div>
              </div>
            </div>

            <div class="markt__fuss">
              <div class="markt__gruppe" role="group" aria-label="Zeitraum" data-role="zeitraeume">
                <span class="markt__fusslabel">Zeitraum</span>
                ${ZEITRAEUME.map((z) => `<button type="button" class="markt__knopf markt__knopf--klein${handyZeitraum(z.id) ? "" : " markt__nur-breit"}" data-zr="${z.id}" title="${z.titel}">${z.knopf}</button>`).join("")}
              </div>
              <button type="button" class="markt__knopf markt__knopf--klein" data-role="gehe-zu" title="Zu einem Datum springen">${icon("calendar")} Datum</button>
              <span class="markt__fueller"></span>
              <span class="markt__stand" data-role="stand"></span>
              <button type="button" class="markt__knopf markt__knopf--klein" data-role="volumen" aria-pressed="true" title="Volumen zeigen">Vol</button>
              <button type="button" class="markt__knopf markt__knopf--klein" data-role="log" aria-pressed="false" title="Logarithmische Preisachse">Log</button>
              <span class="markt__uhr" data-role="uhr"></span>
            </div>
          </section>

          <aside class="markt__seite">
            <section class="glass markt__liste" aria-label="Beobachtungsliste">
              <header class="watchlist__head">
                <h2 class="watchlist__title">Beobachtungsliste</h2>
                <span class="watchlist__count" data-role="count"></span>
                <button type="button" class="markt__hinzu" data-role="hinzu" aria-expanded="false" aria-label="Wert hinzufügen">${icon("plus")}</button>
              </header>
              <div class="search">
                <label class="search__field">
                  ${icon("plus", { className: "search__icon" })}
                  <input class="search__input" type="search" data-role="search" autocomplete="off"
                    spellcheck="false" placeholder="Wert hinzufügen …" aria-label="Wert suchen und hinzufügen" />
                </label>
                <ul class="search__results" data-role="results" hidden></ul>
              </div>
              <div class="markt__werte" data-role="watchlist" role="listbox" aria-label="Werte"></div>
            </section>

            <section class="glass markt__detail" aria-label="Der gewählte Wert">
              <div class="markt__reiter" role="tablist">
                <button type="button" role="tab" data-reiter="ueberblick">Überblick</button>
                <button type="button" role="tab" data-reiter="kuro">Kuro</button>
                <button type="button" role="tab" data-reiter="alarme">Alarme<span class="markt__zahl" data-role="alarm-zahl"></span></button>
              </div>
              <div class="markt__reiterinhalt" data-role="reiterinhalt"></div>
            </section>
          </aside>
        </div>
      </div>
    `;

    // Kuro OS (4c) legt Teile des Gerüsts auf die Plätze seines Raums (`ctx.plaetze`): die
    // Beobachtung links in die Seite, den gewählten Wert rechts in die Spalte, Stand und offene
    // Charts in die Reiterzeile. Gesucht wird darum im Container und in allem Ausgelagerten.
    const ausgelagert: HTMLElement[] = [];
    const findeAlle = <T extends Element>(sel: string): T[] =>
      [container, ...ausgelagert].flatMap((w) => [...w.querySelectorAll<T>(sel)]);
    const finde = <T extends Element>(sel: string): T | null => findeAlle<T>(sel)[0] ?? null;
    const rolle = <T extends HTMLElement>(name: string): T =>
      finde<T>(`[data-role="${name}"]`) as T;
    let reiterEl: HTMLElement | null = null;
    if (ctx.plaetze) {
      const liste = container.querySelector(".markt__liste") as HTMLElement;
      const detail = container.querySelector(".markt__detail") as HTMLElement;
      reiterEl = document.createElement("div");
      reiterEl.className = "markt__offen";
      reiterEl.innerHTML = `<nav class="markt__offen-reiter" data-role="offen" role="tablist" aria-label="Offene Charts"></nav>`;
      reiterEl.append(container.querySelector('[data-role="subtitle"]') as HTMLElement);
      ctx.plaetze.seite.append(liste);
      ctx.plaetze.spalte.append(detail);
      ctx.plaetze.reiter.append(reiterEl);
      ausgelagert.push(liste, detail, reiterEl);
      finde(".markt")?.classList.add("ist-im-raum");
    }
    const untertitelEl = rolle("subtitle");
    const symbolNameEl = rolle("symbol-name");
    const leinwandEl = rolle("leinwand");
    const chartEl = rolle("chart");
    const legendeEl = rolle("legende");
    const auswahlEl = rolle("auswahl");
    const wiedergabeEl = rolle("wiedergabe");
    const hinweisEl = rolle("hinweis");
    const sucheEl = rolle("suche");
    const sucheFeld = rolle<HTMLInputElement>("suche-feld");
    const sucheTreffer = rolle("suche-treffer");
    const eingabeEl = rolle("eingabe");
    const standEl = rolle("stand");
    const uhrEl = rolle("uhr");
    const listeEl = rolle("watchlist");
    const countEl = rolle("count");
    const searchEl = rolle<HTMLInputElement>("search");
    const resultsEl = rolle("results");
    const reiterInhalt = rolle("reiterinhalt");
    const wurzelEl = finde(".markt") as HTMLElement;
    const arbeitsplatzEl = finde(".markt__arbeitsplatz") as HTMLElement;
    const handyNameEl = rolle("handy-name-text");
    const handyKursEl = rolle("handy-kurs");
    const handyWandelEl = rolle("handy-wandel");
    const handyZeileEl = rolle("handy-zeile");
    const handyMehrEl = rolle<HTMLButtonElement>("handy-mehr");

    // ------------------------------------------------------------------ Hinweis
    let hinweisUhr: ReturnType<typeof setTimeout> | null = null;
    const hinweis = (text: string, dauerMs = 5000): void => {
      hinweisEl.textContent = text;
      hinweisEl.hidden = false;
      if (hinweisUhr) clearTimeout(hinweisUhr);
      hinweisUhr = setTimeout(() => {
        hinweisEl.hidden = true;
      }, dauerMs);
    };

    // ------------------------------------------------------------------ Chart
    // Am Chart gelesen, nicht an <html>: Kuro OS setzt seine Farben (hell, dunkel) auf die Hülle.
    const css = (name: string, vorgabe: string) =>
      getComputedStyle(chartEl).getPropertyValue(name).trim() || vorgabe;
    const hoch = css("--state-up", "#5fc98c");
    const tief = css("--state-down", "#e0787f");
    const stellen = () => stellenFuer(kopf?.price ?? kerzen.at(-1)?.close ?? 100, kopf?.stellen);

    const chart: IChartApi = createChart(chartEl, {
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        textColor: css("--fg-faint", "rgba(237, 240, 245, 0.45)"),
        fontFamily: css("--font-ui", "system-ui, sans-serif"),
        fontSize: 11.5,
        panes: {
          separatorColor: css("--chart-trenner", "rgba(237, 240, 245, 0.08)"),
          separatorHoverColor: css("--chart-trenner-stark", "rgba(237, 240, 245, 0.18)"),
          enableResize: true,
        },
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: css("--chart-gitter", "rgba(237, 240, 245, 0.045)") },
      },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.08 } },
      // `minBarSpacing`: ohne ihn hält der Chart mindestens einen halben Pixel je Kerze und
      // schneidet „5 Jahre" oder „Alles" vorn stillschweigend ab — 2.200 Tageskerzen passen
      // nicht auf 830 Pixel. TradingView staucht; das tun wir auch.
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 8,
        barSpacing: 7,
        minBarSpacing: 0.02,
      },
      localization: { locale: "de-DE", priceFormatter: (p: number) => formatKurs(p, stellen()) },
      crosshair: {
        mode: 0,
        vertLine: {
          color: css("--chart-kreuz", "rgba(237, 240, 245, 0.28)"),
          labelBackgroundColor: css("--chart-etikett", "#1b2530"),
        },
        horzLine: {
          color: css("--chart-kreuz", "rgba(237, 240, 245, 0.28)"),
          labelBackgroundColor: css("--chart-etikett", "#1b2530"),
        },
      },
    });

    const ebene = new Ebene();
    let haupt: ISeriesApi<SeriesType, Time> = neueHauptreihe();
    let marken: ISeriesMarkersPluginApi<Time> = createSeriesMarkers(haupt, []);
    const volumen = chart.addSeries(HistogramSeries, {
      priceScaleId: "vol",
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
    let reihen: IndikatorReihen[] = [];

    /**
     * Auf dem Telefon schiebt ein waagrechter Wisch den Chart, ein senkrechter blättert die
     * Seite — sonst hing der Finger auf dem halben Bildschirm fest, den der Chart einnimmt.
     */
    const bewegung = () =>
      handy
        ? {
            handleScroll: {
              mouseWheel: true,
              pressedMouseMove: true,
              horzTouchDrag: true,
              vertTouchDrag: false,
            },
            handleScale: {
              axisPressedMouseMove: true,
              axisDoubleClickReset: true,
              mouseWheel: true,
              pinch: true,
            },
          }
        : { handleScroll: true, handleScale: true };
    const zeigeVolumen = (): boolean => volumenAn && hatVolumen && !schlicht();

    function passeChartAn(): void {
      chart.applyOptions({
        ...bewegung(),
        layout: { fontSize: handy ? 10.5 : 11.5 },
        grid: { horzLines: { visible: !schlicht() } },
        timeScale: { rightOffset: schlicht() ? 3 : 8 },
        // Den Finger halten und ziehen zeigt den Kurs darunter; loslassen, und der Kopf steht
        // wieder beim aktuellen — wie in der Aktien-App. Sonst blieb das Fadenkreuz bis zum
        // nächsten Tippen stehen.
        trackingMode: {
          exitMode: handy ? TrackingModeExitMode.OnTouchEnd : TrackingModeExitMode.OnNextTap,
        },
      });
    }
    passeChartAn();

    function neueHauptreihe(): ISeriesApi<SeriesType, Time> {
      let s: ISeriesApi<SeriesType, Time>;
      if (typ === "linie") {
        s = chart.addSeries(LineSeries, { color: "#7fb2e5", lineWidth: 2 });
      } else if (typ === "flaeche") {
        s = chart.addSeries(AreaSeries, {
          lineColor: "#7fb2e5",
          topColor: "rgba(127, 178, 229, 0.28)",
          bottomColor: "rgba(127, 178, 229, 0.02)",
          lineWidth: 2,
        });
      } else if (typ === "balken") {
        s = chart.addSeries(BarSeries, { upColor: hoch, downColor: tief, thinBars: false });
      } else {
        s = chart.addSeries(CandlestickSeries, {
          upColor: hoch,
          downColor: tief,
          wickUpColor: hoch,
          wickDownColor: tief,
          borderVisible: false,
        });
      }
      s.attachPrimitive(ebene);
      return s;
    }

    function wechsleTyp(neu: Typ): void {
      if (neu === typ) return;
      haupt.detachPrimitive(ebene);
      marken.detach();
      chart.removeSeries(haupt);
      typ = neu;
      haupt = neueHauptreihe();
      marken = createSeriesMarkers(haupt, []);
      zeichneAlles(false);
      zeichneArbeit();
      merke();
      zeichneLeiste();
    }

    const zt = (t: number) => anzeigeZeit(t) as UTCTimestamp;
    const sichtbar = (): number =>
      wiedergabe.aktiv ? Math.min(wiedergabe.index + 1, kerzen.length) : kerzen.length;

    function hauptDaten(bis: number) {
      const quelle = typ === "heikin" ? heikinAshi(kerzen) : kerzen;
      const teil = quelle.slice(0, bis);
      if (typ === "linie" || typ === "flaeche")
        return teil.map((k) => ({ time: zt(k.time), value: k.close }));
      return teil.map((k) => ({
        time: zt(k.time),
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
      }));
    }

    function volumenDaten(bis: number) {
      return kerzen.slice(0, bis).map((k) => ({
        time: zt(k.time),
        value: k.volume ?? 0,
        color: k.close >= k.open ? "rgba(95, 201, 140, 0.28)" : "rgba(224, 120, 127, 0.28)",
      }));
    }

    function reihenDaten(r: IndikatorReihen, name: string, bis: number) {
      const antwort = indikatorDaten.get(indikatorId(r.def));
      const werte = antwort?.reihen[name] ?? [];
      const raus: { time: UTCTimestamp; value?: number; color?: string }[] = [];
      for (let i = 0; i < Math.min(bis, kerzen.length); i += 1) {
        const w = werte[i];
        const time = zt((kerzen[i] as Kerze).time);
        if (w === null || w === undefined) {
          raus.push({ time });
          continue;
        }
        if (name === "histogramm") {
          raus.push({
            time,
            value: w,
            color: w >= 0 ? "rgba(95, 201, 140, 0.55)" : "rgba(224, 120, 127, 0.55)",
          });
        } else {
          raus.push({ time, value: w });
        }
      }
      return raus;
    }

    /** Die Indikatorreihen neu anlegen — nach einer Änderung der Auswahl. */
    function baueIndikatoren(): void {
      for (const r of reihen) for (const s of r.serien) chart.removeSeries(s.serie);
      reihen = [];
      let fenster = 0;
      let farbStelle = 0;
      for (const def of aktive) {
        const d = indikatorDef(def.art);
        if (!d) continue;
        const farbe = d.ort === "kurs" ? farbeFuer(farbStelle++) : (FARBEN[1] as string);
        const pane = d.ort === "fenster" ? ++fenster : 0;
        const serien = reihenStile(def.art, farbe).map((stil) => ({
          name: stil.name,
          serie:
            stil.art === "saeulen"
              ? chart.addSeries(
                  HistogramSeries,
                  { priceLineVisible: false, lastValueVisible: false },
                  pane,
                )
              : chart.addSeries(
                  LineSeries,
                  {
                    color: stil.farbe,
                    lineWidth: stil.breite as 1,
                    lineStyle: stil.gestrichelt ? 2 : 0,
                    priceLineVisible: false,
                    lastValueVisible: pane > 0,
                    crosshairMarkerVisible: false,
                  },
                  pane,
                ),
        }));
        const linien: IPriceLine[] = [];
        const erste = serien[0]?.serie;
        if (erste && d.linien) {
          for (const preis of d.linien) {
            linien.push(
              erste.createPriceLine({
                price: preis,
                color: "rgba(237, 240, 245, 0.22)",
                lineWidth: 1,
                lineStyle: 2,
                axisLabelVisible: false,
                title: "",
              }),
            );
          }
        }
        reihen.push({ def, farbe, serien, fenster: pane > 0 ? pane : null, linien });
      }
      // Anteile statt fester Höhen: sie halten, wenn das Fenster wächst oder schrumpft.
      const panes = chart.panes();
      panes[0]?.setStretchFactor(1);
      for (let i = 1; i < panes.length; i += 1) panes[i]?.setStretchFactor(0.26);
    }

    function zeichneAlles(neuAusrichten: boolean): void {
      const n = sichtbar();
      haupt.applyOptions({
        priceFormat: { type: "price", precision: stellen(), minMove: 10 ** -stellen() },
      });
      haupt.setData(hauptDaten(n) as never);
      volumen.setData(zeigeVolumen() ? volumenDaten(n) : []);
      for (const r of reihen)
        for (const s of r.serien) s.serie.setData(reihenDaten(r, s.name, n) as never);
      ebene.setzeAchse(
        kerzen.slice(0, n).map((k) => anzeigeZeit(k.time)),
        intervall(iv).sekunden,
      );
      chart.applyOptions({ timeScale: { timeVisible: intervall(iv).sekunden < 86_400 } });
      if (neuAusrichten && n > 0) richteAus(n);
      stift?.male();
      zeichneLegende(null);
    }

    /** Die erste Kerze des Telefon-Zeitraums, oder `null` am Schreibtisch. */
    function handyStart(n: number): number | null {
      const zr = schlicht() ? zeitraum(handyZr.id) : undefined;
      const letzte = kerzen[n - 1];
      if (!zr || !letzte) return null;
      const von = zeitraumVon(zr, letzte.time, new Date(), handelsanteilAus(kopf?.sitzung));
      if (von === null) return 0;
      const i = kerzen.findIndex((k) => k.time >= von);
      return i < 0 ? n - 1 : i;
    }

    function richteAus(n: number): void {
      const start = handyStart(n);
      chart
        .timeScale()
        .setVisibleLogicalRange(
          start === null
            ? { from: Math.max(0, n - ANFANGS_KERZEN), to: n + 8 }
            : { from: start, to: n - 1 + 3 },
        );
    }

    // ------------------------------------------------------------------ Zeichnen
    let zeichnungen: Zeichnung[] = [];
    const stift = new Zeichenstift({
      chart,
      ebene,
      rahmen: leinwandEl,
      flaeche: chartEl,
      stellen,
      kerzeBei: (zeit) => {
        const i = naechsteKerze(zeit);
        return i >= 0 ? kerzen[i] : undefined;
      },
      spanne: () => {
        const r = chart.timeScale().getVisibleLogicalRange();
        const bis = Math.min(sichtbar(), Math.max(1, Math.floor(r?.to ?? sichtbar())));
        const teil = kerzen.slice(Math.max(0, bis - 14), bis);
        const schnitt = teil.reduce((s, k) => s + (k.high - k.low), 0) / Math.max(teil.length, 1);
        return schnitt * 1.5;
      },
      kerzenAbstand: () => intervall(iv).sekunden,
      geaendert: (neu) => {
        zeichnungen = neu;
        if (speicherUhr) clearTimeout(speicherUhr);
        const fuer = symbol;
        speicherUhr = setTimeout(() => void speichereZeichnungen(fuer, neu), 500);
      },
      gewaehlt: (z) => zeigeAuswahl(z),
      werkzeugFertig: () => markiereWerkzeug(),
      frageText: (x, y) => frageText(x, y, "Notiz im Chart"),
      bewegung,
    });
    stift.magnet = gespeichert.magnet;

    async function speichereZeichnungen(fuer: string, liste: Zeichnung[]): Promise<void> {
      try {
        await ctx.api.put(`/integrations/markets/zeichnungen?symbol=${encodeURIComponent(fuer)}`, {
          zeichnungen: liste,
        });
      } catch (error) {
        hinweis(`Zeichnungen nicht gespeichert: ${describeError(error)}`, 8000);
      }
    }

    async function ladeZeichnungen(): Promise<void> {
      const fuer = symbol;
      try {
        const blatt = await ctx.api.get<{ zeichnungen: Zeichnung[] }>(
          `/integrations/markets/zeichnungen?symbol=${encodeURIComponent(fuer)}`,
        );
        if (verworfen || fuer !== symbol) return;
        zeichnungen = blatt.zeichnungen;
        stift.setzeZeichnungen(zeichnungen);
      } catch {
        stift.setzeZeichnungen([]);
      }
    }

    function markiereWerkzeug(): void {
      for (const b of findeAlle<HTMLButtonElement>("[data-werkzeug]")) {
        const an = b.dataset.werkzeug === stift.aktuellesWerkzeug;
        b.classList.toggle("ist-aktiv", an);
        b.setAttribute("aria-pressed", String(an));
      }
      const magnet = rolle<HTMLButtonElement>("magnet");
      magnet.classList.toggle("ist-aktiv", stift.magnet);
      magnet.setAttribute("aria-pressed", String(stift.magnet));
      leinwandEl.classList.toggle("ist-zeichnend", stift.aktuellesWerkzeug !== "zeiger");
    }

    rolle("stifte").addEventListener("click", (e) => {
      const knopf = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
      if (!knopf) return;
      if (knopf.dataset.werkzeug) {
        const w = knopf.dataset.werkzeug as Werkzeug;
        stift.setzeWerkzeug(stift.aktuellesWerkzeug === w ? "zeiger" : w);
      } else if (knopf.dataset.role === "magnet") {
        stift.magnet = !stift.magnet;
        merke();
      } else if (knopf.dataset.role === "alles-weg") {
        if (zeichnungen.length === 0) return;
        if (
          globalThis.confirm(
            `Alle ${zeichnungen.length} Zeichnungen auf ${anzeigeName(symbol, kopf?.name ?? "")} löschen?`,
          )
        ) {
          stift.loescheAlle();
        }
      }
      markiereWerkzeug();
    });

    function frageText(x: number, y: number, titel: string, vorgabe = ""): Promise<string | null> {
      return new Promise((fertig) => {
        eingabeEl.innerHTML = `<label>${escapeHtml(titel)}<input type="text" maxlength="300" value="${escapeHtml(vorgabe)}" /></label>`;
        eingabeEl.style.left = `${Math.min(x, leinwandEl.clientWidth - 260)}px`;
        eingabeEl.style.top = `${Math.max(8, y - 30)}px`;
        eingabeEl.hidden = false;
        const feld = eingabeEl.querySelector("input") as HTMLInputElement;
        feld.focus();
        feld.select();
        const ende = (wert: string | null) => {
          eingabeEl.hidden = true;
          eingabeEl.innerHTML = "";
          fertig(wert);
        };
        feld.addEventListener("keydown", (e) => {
          if (e.key === "Enter") ende(feld.value);
          if (e.key === "Escape") ende(null);
          e.stopPropagation();
        });
        feld.addEventListener("blur", () => ende(feld.value.trim() ? feld.value : null));
      });
    }

    // Die Leiste über einer gewählten Zeichnung — was man damit tun kann.
    function zeigeAuswahl(z: Zeichnung | null): void {
      if (!z) {
        auswahlEl.hidden = true;
        auswahlEl.innerHTML = "";
        return;
      }
      const knoepfe: string[] = [];
      let zeile = beschreibe(z);
      if (z.art === "horizontal") {
        knoepfe.push(
          `<button type="button" data-tat="alarm">${icon("bell")} Alarm auf diese Linie</button>`,
        );
      }
      if (z.art === "position") {
        const zahlen = positionsZahlen({
          richtung: z.richtung,
          einstieg: z.a.preis,
          stop: z.stop,
          ziel: z.ziel,
        });
        zeile = zahlen.stimmig
          ? `${z.richtung === "long" ? "Long" : "Short"} ${formatKurs(z.a.preis, stellen())} · Stop ${formatKurs(z.stop, stellen())} (${formatPercent(-zahlen.risikoProzent).replace("−", "−")}) · Ziel ${formatKurs(z.ziel, stellen())} · CRV ${(zahlen.crv as number).toLocaleString("de-DE", { maximumFractionDigits: 2 })}:1 · trägt ab ${Math.round((zahlen.breakeven as number) * 100)} % Treffern`
          : "Stop oder Ziel liegen auf der falschen Seite — so ist es kein Handel.";
        knoepfe.push(
          `<button type="button" data-tat="rechnung">Rechnung</button>`,
          `<button type="button" data-tat="prognose" ${zahlen.stimmig ? "" : "disabled"}>Ins Prognosebuch</button>`,
          `<button type="button" data-tat="pruefen" ${zahlen.stimmig ? "" : "disabled"}>Kuro prüfen lassen</button>`,
        );
      }
      if (z.art === "horizontal" || z.art === "trend" || z.art === "rechteck") {
        knoepfe.push(`<button type="button" data-tat="notiz">Notiz</button>`);
      }
      knoepfe.push(`<button type="button" data-tat="weg" class="ist-gefaehrlich">Löschen</button>`);
      auswahlEl.innerHTML = `<span class="markt__auswahl-text">${escapeHtml(zeile)}</span>${knoepfe.join("")}`;
      auswahlEl.hidden = false;
    }

    auswahlEl.addEventListener("click", (e) => {
      const tat = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-tat]")?.dataset.tat;
      const z = stift.gewaehlteZeichnung;
      if (!tat || !z) return;
      if (tat === "weg") stift.loesche(z.id);
      if (tat === "alarm" && z.art === "horizontal") void legeAlarm(z.preis, z.notiz);
      if (
        tat === "notiz" &&
        (z.art === "horizontal" || z.art === "trend" || z.art === "rechteck")
      ) {
        void frageText(leinwandEl.clientWidth / 2 - 130, 60, "Notiz", z.notiz ?? "").then(
          (text) => {
            if (text === null) return;
            stift.ersetze({ ...z, notiz: text.trim() || undefined } as Zeichnung);
          },
        );
      }
      if (z.art === "position") {
        if (tat === "rechnung") void zeigeRechnung(z);
        if (tat === "prognose") void insPrognosebuch(z);
        if (tat === "pruefen") {
          reiter = "kuro";
          zeichneReiter();
          void frageKuro(
            `Prüf bitte meine Idee: ${beschreibe(z)}. Was spricht dafür, was dagegen?`,
          );
        }
      }
    });

    async function zeigeRechnung(z: Extract<Zeichnung, { art: "position" }>): Promise<void> {
      reiter = "kuro";
      zeichneReiter();
      const ziel = reiterInhalt.querySelector<HTMLElement>('[data-role="antwort"]');
      if (ziel) ziel.innerHTML = '<p class="markt__leise">Rechnet …</p>';
      try {
        const r = await ctx.api.post<{ text: string }>("/integrations/markets/crv", {
          symbol,
          richtung: z.richtung,
          einstieg: z.a.preis,
          stop: z.stop,
          ziele: [z.ziel],
        });
        if (ziel)
          ziel.innerHTML = `<h3 class="markt__abschnitt">Gerechnet, wie am Handelstisch</h3><pre class="markt__rechnung">${escapeHtml(r.text)}</pre>`;
      } catch (error) {
        if (ziel)
          ziel.innerHTML = `<p class="markt__fehler">${escapeHtml(describeError(error))}</p>`;
      }
    }

    async function insPrognosebuch(z: Extract<Zeichnung, { art: "position" }>): Promise<void> {
      if (wiedergabe.aktiv) {
        hinweis(
          "In der Wiedergabe wird nichts abgelegt — eine Idee von damals wäre heute keine Prognose.",
        );
        return;
      }
      try {
        await ctx.api.post("/integrations/prognosen", {
          symbol,
          richtung: z.richtung,
          ausloeser: z.a.preis,
          stop: z.stop,
          ziele: [z.ziel],
        });
        stift.loesche(z.id);
        hinweis(
          "Im Prognosebuch. Ab jetzt verfolgt der Code, was aus der Idee wird — sie steht als „deine Idee“ auf dem Chart.",
          7000,
        );
        await ladePrognosen();
        reiter = "kuro";
        zeichneReiter();
      } catch (error) {
        hinweis(`Nicht abgelegt: ${describeError(error)}`, 8000);
      }
    }

    // ------------------------------------------------------------------ Legende
    function naechsteKerze(zeit: number): number {
      let lo = 0;
      let hi = kerzen.length - 1;
      if (hi < 0) return -1;
      while (hi - lo > 1) {
        const m = (lo + hi) >> 1;
        if ((kerzen[m] as Kerze).time <= zeit) lo = m;
        else hi = m;
      }
      const a = kerzen[lo] as Kerze;
      const b = kerzen[hi] as Kerze;
      return Math.abs(a.time - zeit) <= Math.abs(b.time - zeit) ? lo : hi;
    }

    function zeichneLegende(index: number | null): void {
      zeichneHandykopf(index);
      const n = sichtbar();
      const i = index !== null && index >= 0 && index < n ? index : n - 1;
      const k = kerzen[i];
      const s = stellen();
      const name = anzeigeName(symbol, kopf?.name ?? "");
      const lage = kopf ? marktLage(kopf, Date.now() / 1000) : null;
      const kopfZeile = `
        <div class="markt__legende-kopf">
          <strong>${escapeHtml(name)}</strong>
          <span>${escapeHtml(intervall(iv).wort)}</span>
          ${kopf?.exchange ? `<span>${escapeHtml(kopf.exchange)}</span>` : ""}
          ${lage?.text ? `<span class="markt__lage${lage.offen ? " ist-offen" : ""}">${escapeHtml(lage.text)}</span>` : ""}
          ${wiedergabe.aktiv ? '<span class="markt__lage ist-wiedergabe">Wiedergabe</span>' : ""}
        </div>`;
      if (!k) {
        legendeEl.innerHTML = kopfZeile;
        return;
      }
      const vorher = kerzen[i - 1];
      const diff = vorher ? k.close - vorher.close : 0;
      const pct = vorher && vorher.close !== 0 ? (diff / vorher.close) * 100 : 0;
      const ton = diff >= 0 ? "ist-hoch" : "ist-tief";
      const zeiten = `${datum(k.time, intervall(iv).sekunden < 86_400)}`;
      const ha =
        typ === "heikin"
          ? '<span class="markt__leise"> · Heikin-Ashi: die Kerzen sind geglättet, die Zahlen hier echt</span>'
          : "";
      const indZeilen = reihen
        .map((r) => {
          const antwort = indikatorDaten.get(indikatorId(r.def));
          const werte = r.serien
            .map((sr) => antwort?.reihen[sr.name]?.[i])
            .filter((w): w is number => typeof w === "number")
            .map((w) =>
              Math.abs(w) >= 1000 ||
              r.def.art === "sma" ||
              r.def.art === "ema" ||
              r.def.art === "bb" ||
              r.def.art === "vwap"
                ? formatKurs(w, s)
                : w.toLocaleString("de-DE", { maximumFractionDigits: 2 }),
            )
            .join(" · ");
          const text = antwort?.hinweis ?? werte;
          return `<div class="markt__legende-ind" data-ind="${escapeHtml(indikatorId(r.def))}">
            <span class="markt__farbe" style="background:${r.farbe}"></span>
            <button type="button" class="markt__legende-name" data-tat="bearbeiten" title="Einstellungen">${escapeHtml(beschriftung(r.def))}</button>
            <span class="markt__legende-wert${antwort?.hinweis ? " markt__leise" : ""}">${escapeHtml(text)}</span>
            <button type="button" class="markt__legende-weg" data-tat="entfernen" aria-label="${escapeHtml(beschriftung(r.def))} entfernen">${icon("close")}</button>
          </div>`;
        })
        .join("");
      legendeEl.innerHTML = `
        ${kopfZeile}
        <div class="markt__legende-ohlc">
          <span class="markt__leise">${escapeHtml(zeiten)}</span>
          <span>E <b class="${ton}">${formatKurs(k.open, s)}</b></span>
          <span>H <b class="${ton}">${formatKurs(k.high, s)}</b></span>
          <span>T <b class="${ton}">${formatKurs(k.low, s)}</b></span>
          <span>S <b class="${ton}">${formatKurs(k.close, s)}</b></span>
          <b class="${ton}">${diff >= 0 ? "+" : "−"}${formatKurs(Math.abs(diff), s)} (${formatPercent(pct)})</b>
          ${volumenAn && hatVolumen && k.volume ? `<span>Vol <b>${formatVolumen(k.volume)}</b></span>` : ""}
          ${ha}
        </div>
        ${indZeilen}`;
    }

    /**
     * Der Kopf des Telefons: Name, Kurs, Änderung zum Vortag und über den Zeitraum. Liegt der
     * Finger auf dem Chart, steht dort die Kerze darunter — ihr Schluss, die Änderung seit
     * Beginn des Zeitraums und ihr Datum.
     */
    function zeichneHandykopf(index: number | null): void {
      if (!handy) return;
      const s = stellen();
      handyNameEl.textContent = anzeigeName(symbol, kopf?.name ?? quotes.get(symbol)?.name ?? "");
      const n = sichtbar();
      const waehrung = kopf?.currency ? `<small>${escapeHtml(kopf.currency)}</small>` : "";
      const aenderung = (von: number, bis: number): string => {
        const pct = von !== 0 ? ((bis - von) / von) * 100 : 0;
        return `<b class="${bis >= von ? "ist-hoch" : "ist-tief"}">${escapeHtml(formatPercent(pct))}</b>`;
      };
      const start = handyStart(n);
      const basis =
        start === null ? null : (kerzen[start - 1]?.close ?? kerzen[start]?.open ?? null);
      const k = index !== null && index >= 0 && index < n ? kerzen[index] : undefined;
      const lage = kopf ? marktLage(kopf, Date.now() / 1000) : null;
      const kerzenWort = intervall(iv).wort;

      if (k) {
        handyKursEl.innerHTML = `${formatKurs(k.close, s)}${waehrung}`;
        handyWandelEl.innerHTML =
          basis !== null && start !== null && index !== null && index >= start
            ? `${aenderung(basis, k.close)} seit ${escapeHtml(datum(kerzen[start]?.time ?? k.time, false))}`
            : "&nbsp;";
        handyZeileEl.textContent = `${datum(k.time, intervall(iv).sekunden < 86_400)} · ${kerzenWort}`;
        return;
      }
      if (!kopf) {
        handyKursEl.innerHTML = '<span class="markt__leise">Lädt …</span>';
        handyWandelEl.innerHTML = "&nbsp;";
        handyZeileEl.textContent = "";
        return;
      }
      const letzte = kerzen[n - 1];
      const kachel = handyZr.kachel
        ? kennzahlen?.kennzahlen.performance.find((p) => p.spanne === handyZr.kachel)
        : undefined;
      // Mit Kachel ihre Zahl — und solange sie lädt, keine andere an ihrer Stelle.
      const ueberZeitraum = handyZr.kachel
        ? kachel && kachel.prozent !== null
          ? `<b class="${kachel.prozent >= 0 ? "ist-hoch" : "ist-tief"}">${escapeHtml(formatPercent(kachel.prozent))}</b>`
          : ""
        : basis !== null && letzte
          ? aenderung(basis, letzte.close)
          : "";
      const vortag = `<b class="${kopf.change >= 0 ? "ist-hoch" : "ist-tief"}">${kopf.change >= 0 ? "+" : "−"}${formatKurs(Math.abs(kopf.change), s)} (${escapeHtml(formatPercent(kopf.changePct))})</b>`;
      const teile = [
        `${vortag} zum Vortag`,
        // Beim „1 Tag" ist der Zeitraum der Vortag — die Zahl stünde zweimal da.
        ueberZeitraum && handyZr.id !== "1T" && schlicht()
          ? `${ueberZeitraum} ${escapeHtml(handyZr.seit)}`
          : "",
      ];
      handyKursEl.innerHTML = `${formatKurs(kopf.price, s)}${waehrung}`;
      handyWandelEl.innerHTML = teile
        .filter(Boolean)
        .join('<span class="markt__handypunkt">·</span>');
      handyZeileEl.textContent = [lage?.text, wiedergabe.aktiv ? "Wiedergabe" : "", kerzenWort]
        .filter(Boolean)
        .join(" · ");
    }

    chart.subscribeCrosshairMove((p: MouseEventParams<Time>) => {
      if (p.logical === undefined || p.point === undefined) {
        zeichneLegende(null);
        return;
      }
      zeichneLegende(Math.round(p.logical));
    });

    legendeEl.addEventListener("click", (e) => {
      const knopf = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-tat]");
      const id = knopf?.closest<HTMLElement>("[data-ind]")?.dataset.ind;
      if (!knopf || !id) return;
      if (knopf.dataset.tat === "entfernen") {
        aktive = aktive.filter((a) => indikatorId(a) !== id);
        void indikatorenGeaendert();
      } else {
        oeffneIndikatoren(id);
      }
    });

    // ------------------------------------------------------------------ Laden
    let ladenUnterwegs: Promise<void> | null = null;
    function ladeKerzen(ausrichten = true): Promise<void> {
      const lauf = holeKerzen(ausrichten);
      ladenUnterwegs = lauf;
      void lauf.finally(() => {
        if (ladenUnterwegs === lauf) ladenUnterwegs = null;
      });
      return lauf;
    }

    /** So weit nach links nachladen, bis `zeit` im Chart liegt — oder es nichts Älteres gibt. */
    async function ladeBis(zeit: number): Promise<void> {
      for (let runde = 0; runde < 30; runde += 1) {
        if (ladenUnterwegs) await ladenUnterwegs;
        if (aeltereUnterwegs) await aeltereUnterwegs;
        if (verworfen || !mehr || kerzen.length === 0 || (kerzen[0] as Kerze).time <= zeit) return;
        const vorher = (kerzen[0] as Kerze).time;
        await ladeAeltere();
        // Kein Fortschritt und nichts mehr unterwegs: aufgeben statt kreisen.
        if (
          !ladenUnterwegs &&
          !aeltereUnterwegs &&
          kerzen.length > 0 &&
          (kerzen[0] as Kerze).time === vorher &&
          runde > 2
        )
          return;
      }
    }

    async function holeKerzen(ausrichten: boolean): Promise<void> {
      const nummer = ++ladeNummer;
      const fuer = symbol;
      laedt = true;
      standEl.textContent = "Lädt …";
      try {
        const anzahl = ausrichten ? 1500 : Math.min(Math.max(kerzen.length, 1500), 5000);
        const a = await ctx.api.get<KerzenAntwort>(
          `/integrations/markets/kerzen?symbol=${encodeURIComponent(fuer)}&intervall=${iv}&anzahl=${anzahl}&ind=${encodeURIComponent(anfrageFuer(aktive))}`,
        );
        if (verworfen || nummer !== ladeNummer) return;
        uebernehme(a);
        kerzen = ausDraht(a.kerzen);
        hatVolumen = a.hatVolumen;
        indikatorDaten = new Map(a.indikatoren.map((x) => [x.id, x]));
        mehr = a.mehr;
        if (wiedergabe.aktiv) beendeWiedergabe(false);
        zeichneAlles(ausrichten);
        zeichneArbeit();
        standEl.textContent =
          kerzen.length === 0
            ? "Keine Kerzen — der Markt hat in diesem Zeitraum nicht gehandelt."
            : `${a.quelle} · Stand ${uhr()}`;
      } catch (error) {
        if (verworfen || nummer !== ladeNummer) return;
        standEl.textContent = describeError(error);
      } finally {
        if (nummer === ladeNummer) laedt = false;
      }
    }

    function uebernehme(a: Kurskopf): void {
      const erster = kopf === null || kopf.symbol !== a.symbol;
      kopf = a;
      symbolNameEl.textContent = anzeigeName(symbol, a.name);
      if (erster) zeichneReiter();
    }

    /**
     * Läuft schon ein Nachladen, wartet ein zweiter Aufruf auf dasselbe, statt „nichts mehr"
     * zu melden — sonst brach der Sprung an den Anfang einer Strategie ab, sobald der Chart
     * beim Verschieben selbst nachlud.
     */
    let aeltereUnterwegs: Promise<boolean> | null = null;
    function ladeAeltere(): Promise<boolean> {
      if (aeltereUnterwegs) return aeltereUnterwegs;
      if (!mehr || laedt || kerzen.length === 0) return Promise.resolve(false);
      aeltereUnterwegs = holeAeltere().finally(() => {
        aeltereUnterwegs = null;
      });
      return aeltereUnterwegs;
    }

    async function holeAeltere(): Promise<boolean> {
      laedtAeltere = true;
      const nummer = ladeNummer;
      try {
        const a = await ctx.api.get<KerzenAntwort>(
          `/integrations/markets/kerzen?symbol=${encodeURIComponent(symbol)}&intervall=${iv}&anzahl=1500&bis=${(kerzen[0] as Kerze).time}&ind=${encodeURIComponent(anfrageFuer(aktive))}`,
        );
        // Eine Antwort auf einen alten Stand (inzwischen neu geladen) sagt nichts darüber, ob
        // es ältere Kerzen gibt — sie wird verworfen, ohne `mehr` anzufassen.
        if (verworfen || nummer !== ladeNummer) return false;
        if (a.kerzen.length === 0) {
          mehr = false;
          return false;
        }
        const aeltere = ausDraht(a.kerzen);
        const vorher = kerzen.length;
        kerzen = voranstellen(aeltere, kerzen);
        const dazu = kerzen.length - vorher;
        for (const x of a.indikatoren) {
          const alt = indikatorDaten.get(x.id);
          if (!alt) continue;
          const reihenNeu: Record<string, (number | null)[]> = {};
          for (const [name, werte] of Object.entries(alt.reihen)) {
            reihenNeu[name] = [...(x.reihen[name] ?? []).slice(0, dazu), ...werte];
          }
          indikatorDaten.set(x.id, { ...alt, reihen: reihenNeu });
        }
        mehr = a.mehr;
        const bereich = chart.timeScale().getVisibleLogicalRange();
        if (wiedergabe.aktiv) wiedergabe.index += dazu;
        zeichneAlles(false);
        if (bereich)
          chart
            .timeScale()
            .setVisibleLogicalRange({ from: bereich.from + dazu, to: bereich.to + dazu });
        zeichneArbeit();
        return true;
      } catch (error) {
        standEl.textContent = describeError(error);
        return false;
      } finally {
        laedtAeltere = false;
      }
    }

    chart.timeScale().subscribeVisibleLogicalRangeChange((bereich) => {
      if (bereich && bereich.from < 40) void ladeAeltere();
    });

    async function aktualisiere(): Promise<void> {
      if (laedt || wiedergabe.aktiv || kerzen.length === 0 || document.hidden) return;
      const fuer = symbol;
      const nummer = ladeNummer;
      try {
        const a = await ctx.api.get<KerzenAntwort>(
          `/integrations/markets/kerzen?symbol=${encodeURIComponent(fuer)}&intervall=${iv}&ab=${(kerzen.at(-1) as Kerze).time}&ind=${encodeURIComponent(anfrageFuer(aktive))}`,
        );
        if (verworfen || nummer !== ladeNummer || fuer !== symbol || wiedergabe.aktiv) return;
        uebernehme(a);
        const neu = ausDraht(a.kerzen);
        const { kerzen: vereint, ab } = vereine(kerzen, neu);
        const dazu = vereint.length - kerzen.length;
        kerzen = vereint;
        for (const x of a.indikatoren) {
          const alt = indikatorDaten.get(x.id);
          if (!alt) continue;
          const reihenNeu: Record<string, (number | null)[]> = {};
          for (const [name, werte] of Object.entries(alt.reihen)) {
            reihenNeu[name] = [...werte.slice(0, ab), ...(x.reihen[name] ?? [])];
          }
          indikatorDaten.set(x.id, { ...alt, reihen: reihenNeu });
        }
        // Nur das geänderte Ende an den Chart — ein ganzes `setData` verschöbe den Blick.
        const daten = hauptDaten(kerzen.length);
        const vol = volumenDaten(kerzen.length);
        for (let i = ab; i < kerzen.length; i += 1) {
          haupt.update(daten[i] as never);
          if (zeigeVolumen()) volumen.update(vol[i] as never);
          for (const r of reihen) {
            for (const s of r.serien) {
              const d = reihenDaten(r, s.name, kerzen.length)[i];
              if (d) s.serie.update(d as never);
            }
          }
        }
        if (dazu > 0)
          ebene.setzeAchse(
            kerzen.map((k) => anzeigeZeit(k.time)),
            intervall(iv).sekunden,
          );
        zeichneLegende(null);
        standEl.textContent = `${a.quelle} · Stand ${uhr()}`;
      } catch {
        // Beim nächsten Takt wieder — ein ausgefallener Abruf ist kein Grund für eine Meldung.
      }
    }

    function taktFuer(): number {
      const s = intervall(iv).sekunden;
      return s <= 300 ? 15_000 : s <= 3600 ? 30_000 : 60_000;
    }
    let kerzenUhr = setInterval(() => void aktualisiere(), taktFuer());
    const setzeTakt = () => {
      clearInterval(kerzenUhr);
      kerzenUhr = setInterval(() => void aktualisiere(), taktFuer());
    };

    // ------------------------------------------------------------------ Kerzengröße, Zeitraum
    function zeichneLeiste(): void {
      for (const b of findeAlle<HTMLButtonElement>("[data-iv]")) {
        const an = b.dataset.iv === iv;
        b.classList.toggle("ist-aktiv", an);
        b.setAttribute("aria-checked", String(an));
      }
      rolle("typ-knopf").innerHTML =
        `${SVG('<path d="M6 3.5v13M14 5v10"/><rect x="4.5" y="6" width="3" height="6" rx=".5"/><rect x="12.5" y="7.5" width="3" height="4.5" rx=".5"/>')}<span class="markt__knopf-text">${escapeHtml(TYPEN.find((t) => t.id === typ)?.name ?? "")}</span>`;
      rolle("ind-zahl").textContent = aktive.length > 0 ? String(aktive.length) : "";
      const vol = rolle<HTMLButtonElement>("volumen");
      vol.classList.toggle("ist-aktiv", volumenAn);
      vol.setAttribute("aria-pressed", String(volumenAn));
      vol.hidden = !hatVolumen;
      const log = rolle<HTMLButtonElement>("log");
      log.classList.toggle("ist-aktiv", logAn);
      log.setAttribute("aria-pressed", String(logAn));
      const arbeitKnopf = rolle<HTMLButtonElement>("arbeit-knopf");
      arbeitKnopf.classList.toggle("ist-aktiv", arbeitSichtbar);
      arbeitKnopf.setAttribute("aria-pressed", String(arbeitSichtbar));
      const zahl = prognosen.length + (arbeit?.strategien.length ?? 0);
      rolle("arbeit-zahl").textContent = zahl > 0 ? String(zahl) : "";
      rolle("wiedergabe-knopf").classList.toggle(
        "ist-aktiv",
        wiedergabe.aktiv || wiedergabe.waehlen,
      );
    }

    function setzeIntervall(neu: IntervallId, ausrichten = true): Promise<void> {
      if (neu === iv && kerzen.length > 0) return Promise.resolve();
      iv = neu;
      merke();
      zeichneLeiste();
      setzeTakt();
      return ladeKerzen(ausrichten);
    }

    rolle("intervalle").addEventListener("click", (e) => {
      const id = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-iv]")?.dataset.iv;
      if (id && istIntervallId(id)) void setzeIntervall(id);
    });

    function markiereZeitraum(id: string | null): void {
      for (const b of findeAlle<HTMLButtonElement>("[data-zr]"))
        b.classList.toggle("ist-aktiv", b.dataset.zr === id);
    }

    /** Auf dem Telefon wählt der Zeitraum die Kerzengröße gleich mit, ohne Hinweis. */
    async function zeigeHandyZeitraum(hz: HandyZeitraum): Promise<void> {
      handyZr = hz;
      merke();
      markiereZeitraum(hz.id);
      const neu = handyIntervall(hz, new Date(), handelsanteilAus(kopf?.sitzung));
      if (neu !== iv || kerzen.length === 0) await setzeIntervall(neu, true);
      else richteAus(sichtbar());
      zeichneHandykopf(null);
    }

    async function zeigeZeitraum(id: string): Promise<void> {
      const hz = schlicht() ? handyZeitraum(id) : undefined;
      if (hz) {
        await zeigeHandyZeitraum(hz);
        return;
      }
      const z = zeitraum(id);
      if (!z) return;
      const tage = zeitraumTage(z, new Date());
      const passend = passendesIntervall(tage, iv, handelsanteilAus(kopf?.sitzung));
      if (passend !== iv) {
        const alt = intervall(iv);
        const grund =
          tage !== null && alt.historieTage !== null && alt.historieTage < tage
            ? `${alt.wort} reichen bei Yahoo nur ${alt.historieTage} Tage zurück`
            : tage === null
              ? `${alt.wort} gibt es nicht über die ganze Historie`
              : `in ${alt.wort} wären das zu wenige Kerzen`;
        hinweis(`${z.knopf}: auf ${intervall(passend).wort} gewechselt — ${grund}.`, 6500);
        await setzeIntervall(passend, false);
      }
      if (kerzen.length === 0) return;
      const letzte = (kerzen.at(-1) as Kerze).time;
      const von = zeitraumVon(z, letzte, new Date(), handelsanteilAus(kopf?.sitzung)) ?? 0;
      await ladeBis(von);
      if (tage === null) {
        chart.timeScale().fitContent();
      } else {
        const start = kerzen.findIndex((k) => k.time >= von);
        chart
          .timeScale()
          .setVisibleLogicalRange({ from: Math.max(0, start), to: kerzen.length - 1 + 3 });
      }
      markiereZeitraum(id);
    }

    rolle("zeitraeume").addEventListener("click", (e) => {
      const id = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-zr]")?.dataset.zr;
      if (id) void zeigeZeitraum(id);
    });
    // Wer selbst schiebt oder zoomt, hat keinen der Zeiträume mehr gewählt.
    leinwandEl.addEventListener("wheel", () => markiereZeitraum(null));

    rolle("gehe-zu").addEventListener("click", () => {
      const knopf = rolle("gehe-zu");
      const kasten = knopf.getBoundingClientRect();
      const leinwand = leinwandEl.getBoundingClientRect();
      eingabeEl.innerHTML = `<label>Zu Datum springen<input type="date" /></label>`;
      eingabeEl.style.left = `${Math.max(8, kasten.left - leinwand.left)}px`;
      eingabeEl.style.top = `${leinwandEl.clientHeight - 70}px`;
      eingabeEl.hidden = false;
      const feld = eingabeEl.querySelector("input") as HTMLInputElement;
      feld.focus();
      const ende = () => {
        eingabeEl.hidden = true;
        eingabeEl.innerHTML = "";
      };
      feld.addEventListener("keydown", (e) => {
        if (e.key === "Escape") ende();
        e.stopPropagation();
      });
      feld.addEventListener("change", () => {
        const t = Date.parse(`${feld.value}T12:00:00`);
        ende();
        if (Number.isFinite(t)) void springeZu(Math.floor(t / 1000));
      });
      feld.addEventListener("blur", () => setTimeout(ende, 150));
    });

    async function springeZu(zeit: number): Promise<void> {
      const alt = intervall(iv);
      const tageZurueck = (Date.now() / 1000 - zeit) / 86_400;
      if (alt.historieTage !== null && tageZurueck > alt.historieTage) {
        hinweis(`So weit reichen ${alt.wort} bei Yahoo nicht — auf Tageskerzen gewechselt.`);
        await setzeIntervall("1d", false);
      }
      await ladeBis(zeit);
      const i = naechsteKerze(zeit);
      if (i < 0) return;
      chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, i - 60), to: i + 60 });
    }

    rolle("volumen").addEventListener("click", () => {
      volumenAn = !volumenAn;
      merke();
      zeichneLeiste();
      zeichneAlles(false);
    });
    rolle("log").addEventListener("click", () => {
      logAn = !logAn;
      chart.priceScale("right").applyOptions({ mode: logAn ? 1 : 0 });
      merke();
      zeichneLeiste();
    });
    chart.priceScale("right").applyOptions({ mode: logAn ? 1 : 0 });

    // ------------------------------------------------------------------ Menüs
    let offenesMenue: HTMLElement | null = null;
    const schliesseMenue = () => {
      offenesMenue?.remove();
      offenesMenue = null;
    };
    function menue(anker: HTMLElement, inhalt: string, breit = false): HTMLElement {
      schliesseMenue();
      const m = document.createElement("div");
      m.className = `markt__menue glass${breit ? " markt__menue--breit" : ""}`;
      m.innerHTML = inhalt;
      const kasten = anker.getBoundingClientRect();
      const bezug = finde(".markt__arbeitsplatz")?.getBoundingClientRect() ?? kasten;
      m.style.left = `${Math.max(8, Math.min(kasten.left - bezug.left, bezug.width - (breit ? 380 : 220)))}px`;
      m.style.top = `${kasten.bottom - bezug.top + 6}px`;
      finde(".markt__arbeitsplatz")?.append(m);
      offenesMenue = m;
      return m;
    }
    const draussen = (e: PointerEvent) => {
      if (
        offenesMenue &&
        !offenesMenue.contains(e.target as Node) &&
        !(e.target as HTMLElement).closest("[aria-haspopup]")
      ) {
        schliesseMenue();
      }
    };
    document.addEventListener("pointerdown", draussen);

    rolle("typ-knopf").addEventListener("click", (e) => {
      const m = menue(
        e.currentTarget as HTMLElement,
        TYPEN.map(
          (t) =>
            `<button type="button" class="markt__menue-eintrag${t.id === typ ? " ist-aktiv" : ""}" data-typ="${t.id}">${t.name}</button>`,
        ).join(""),
      );
      m.addEventListener("click", (ev) => {
        const t = (ev.target as HTMLElement).closest<HTMLElement>("[data-typ]")?.dataset.typ as
          | Typ
          | undefined;
        if (t) {
          wechsleTyp(t);
          schliesseMenue();
        }
      });
    });

    function indikatorenGeaendert(): Promise<void> {
      merke();
      baueIndikatoren();
      zeichneLeiste();
      return ladeKerzen(false);
    }

    function oeffneIndikatoren(bearbeiten?: string): void {
      const anker = rolle("ind-knopf");
      const aktivListe = aktive
        .map((a) => {
          const d = indikatorDef(a.art);
          if (!d) return "";
          const offen = indikatorId(a) === bearbeiten;
          return `<div class="markt__ind-aktiv${offen ? " ist-offen" : ""}" data-id="${escapeHtml(indikatorId(a))}">
            <span class="markt__ind-name">${escapeHtml(beschriftung(a))}</span>
            ${d.parameter
              .map(
                (p, i) =>
                  `<label class="markt__ind-param">${escapeHtml(p.name)}<input type="number" min="${p.schritt ? 0.1 : 1}" max="500" step="${p.schritt ?? 1}" value="${a.parameter[i] ?? p.vorgabe}" data-param="${i}" /></label>`,
              )
              .join("")}
            <button type="button" class="markt__legende-weg" data-weg aria-label="Entfernen">${icon("close")}</button>
          </div>`;
        })
        .join("");
      const m = menue(
        anker,
        `${aktivListe ? `<h3 class="markt__menue-titel">Im Chart</h3>${aktivListe}` : ""}
         <h3 class="markt__menue-titel">Hinzufügen</h3>
         ${INDIKATOREN.map((d) => `<button type="button" class="markt__menue-eintrag markt__menue-eintrag--lang" data-neu="${d.art}"><span>${escapeHtml(d.name)}</span><small>${escapeHtml(d.erklaerung)}</small></button>`).join("")}
         <p class="markt__menue-fuss">Gerechnet im Gateway, mit denselben Funktionen wie am Handelstisch.</p>`,
        true,
      );
      m.addEventListener("click", (ev) => {
        const el = ev.target as HTMLElement;
        const neu = el.closest<HTMLElement>("[data-neu]")?.dataset.neu;
        if (neu) {
          const d = indikatorDef(neu);
          if (!d) return;
          const def: AktiverIndikator = {
            art: d.art,
            parameter: d.parameter.map((p) => p.vorgabe),
          };
          // Einen zweiten gleichen Durchschnitt gibt es nur mit anderer Periode.
          if (
            aktive.some((a) => indikatorId(a) === indikatorId(def)) &&
            (d.art === "sma" || d.art === "ema")
          ) {
            def.parameter = [d.art === "sma" ? 200 : 20];
          }
          if (!aktive.some((a) => indikatorId(a) === indikatorId(def))) aktive = [...aktive, def];
          void indikatorenGeaendert();
          oeffneIndikatoren(indikatorId(def));
          return;
        }
        if (el.closest("[data-weg]")) {
          const id = el.closest<HTMLElement>("[data-id]")?.dataset.id;
          aktive = aktive.filter((a) => indikatorId(a) !== id);
          void indikatorenGeaendert();
          oeffneIndikatoren();
        }
      });
      m.addEventListener("change", (ev) => {
        const feld = ev.target as HTMLInputElement;
        const zeile = feld.closest<HTMLElement>("[data-id]");
        const i = Number(feld.dataset.param);
        const wert = Number(feld.value);
        if (!zeile || !Number.isFinite(wert) || wert <= 0) return;
        aktive = aktive.map((a) => {
          if (indikatorId(a) !== zeile.dataset.id) return a;
          const d = indikatorDef(a.art);
          const parameter = [...a.parameter];
          parameter[i] = d?.parameter[i]?.schritt ? Math.round(wert * 10) / 10 : Math.round(wert);
          return { ...a, parameter };
        });
        void indikatorenGeaendert();
        oeffneIndikatoren(zeile.dataset.id);
      });
    }
    rolle("ind-knopf").addEventListener("click", () => oeffneIndikatoren());

    // ------------------------------------------------------------------ Symbolsuche
    let sucheNummer = 0;
    let sucheUhr: ReturnType<typeof setTimeout> | null = null;
    function oeffneSuche(anfang = ""): void {
      sucheEl.hidden = false;
      sucheFeld.value = anfang;
      sucheFeld.focus();
      zeigeTreffer(anfang);
    }
    function schliesseSuche(): void {
      sucheEl.hidden = true;
      sucheFeld.value = "";
      leinwandEl.focus();
    }
    function zeigeTreffer(text: string): void {
      if (!text.trim()) {
        sucheTreffer.innerHTML = watchlist
          .map(
            (s) =>
              `<li><button type="button" class="search-hit" data-waehle="${escapeHtml(s)}"><span class="search-hit__name">${escapeHtml(anzeigeName(s, quotes.get(s)?.name ?? ""))}</span><span class="search-hit__symbol">${escapeHtml(s)}</span><span class="search-hit__meta">aus der Liste</span></button></li>`,
          )
          .join("");
        return;
      }
      if (sucheUhr) clearTimeout(sucheUhr);
      sucheUhr = setTimeout(async () => {
        const nummer = ++sucheNummer;
        try {
          const d = await ctx.api.get<{ hits: MarketSearchHit[] }>(
            `/integrations/markets/search?q=${encodeURIComponent(text.trim())}`,
          );
          if (verworfen || nummer !== sucheNummer) return;
          sucheTreffer.innerHTML =
            d.hits.length === 0
              ? `<li class="search__empty">Nichts gefunden für „${escapeHtml(text.trim())}".</li>`
              : d.hits
                  .map(
                    (
                      h,
                    ) => `<li><button type="button" class="search-hit" data-waehle="${escapeHtml(h.symbol)}">
                      <span class="search-hit__name">${escapeHtml(anzeigeName(h.symbol, h.name))}</span>
                      <span class="search-hit__symbol">${escapeHtml(h.symbol)}</span>
                      <span class="search-hit__meta">${escapeHtml([h.exchange, describeQuoteType(h.type)].filter(Boolean).join(" · "))}</span>
                      <span class="search-hit__action">${hasSymbol(watchlist, h.symbol) ? "in der Liste" : "ansehen"}</span>
                    </button></li>`,
                  )
                  .join("");
        } catch (error) {
          sucheTreffer.innerHTML = `<li class="search__empty">${escapeHtml(describeError(error))}</li>`;
        }
      }, SEARCH_DEBOUNCE_MS);
    }
    rolle("symbol-knopf").addEventListener("click", () => oeffneSuche());
    rolle("handy-name").addEventListener("click", () => oeffneSuche());
    sucheFeld.addEventListener("input", () => zeigeTreffer(sucheFeld.value));
    sucheFeld.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") schliesseSuche();
      if (e.key === "Enter") {
        const erster = sucheTreffer.querySelector<HTMLElement>("[data-waehle]")?.dataset.waehle;
        const s = erster ?? sucheFeld.value.trim().toUpperCase();
        if (s) {
          schliesseSuche();
          waehle(s);
        }
      }
    });
    sucheTreffer.addEventListener("click", (e) => {
      const s = (e.target as HTMLElement).closest<HTMLElement>("[data-waehle]")?.dataset.waehle;
      if (s) {
        schliesseSuche();
        waehle(s);
      }
    });

    // ------------------------------------------------------------------ Offene Charts (Kuro OS)
    const seitenspeicher = (): Storage | null => {
      try {
        return globalThis.localStorage ?? null;
      } catch {
        return null;
      }
    };
    let offen: string[] = reiterEl
      ? oeffneChart(liesOffene(seitenspeicher()?.getItem(SPEICHER_OFFENE) ?? null), symbol)
      : [];
    function zeichneOffene(): void {
      const nav = reiterEl?.querySelector<HTMLElement>('[data-role="offen"]');
      if (!nav) return;
      const zu = offen.length > 1;
      nav.innerHTML = `${offen
        .map((s) => {
          const name = escapeHtml(anzeigeName(s, quotes.get(s)?.name ?? ""));
          const hier = s === symbol;
          return `<button type="button" role="tab" class="markt__tab${hier ? " ist-hier" : ""}" data-tab="${escapeHtml(s)}" aria-selected="${hier}" title="${escapeHtml(s)}">${name}${zu ? `<span class="markt__tab-zu" data-tab-zu="${escapeHtml(s)}" role="button" aria-label="${name} schließen" title="Schließen">×</span>` : ""}</button>`;
        })
        .join(
          "",
        )}<button type="button" class="markt__tab-neu" data-role="tab-neu" aria-label="Chart öffnen" title="Chart öffnen — einfach lostippen">${SVG('<path d="M10 4.5v11M4.5 10h11"/>')}</button>`;
    }
    function merkeOffene(): void {
      try {
        seitenspeicher()?.setItem(SPEICHER_OFFENE, JSON.stringify(offen));
      } catch {
        // Ohne Seitenspeicher gelten die Reiter bis zum Neuladen.
      }
    }
    reiterEl?.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      const schliessen = t.closest<HTMLElement>("[data-tab-zu]")?.dataset.tabZu;
      if (schliessen) {
        e.stopPropagation();
        const r = schliesseChart(offen, schliessen, symbol);
        offen = r.offen;
        merkeOffene();
        if (r.naechster) waehle(r.naechster);
        else zeichneOffene();
        return;
      }
      const tab = t.closest<HTMLElement>("[data-tab]")?.dataset.tab;
      if (tab) {
        waehle(tab);
        return;
      }
      if (t.closest('[data-role="tab-neu"]')) oeffneSuche();
    });
    zeichneOffene();

    // ------------------------------------------------------------------ Wert wählen
    function waehle(neu: string): void {
      const s = neu.toUpperCase();
      if (s === symbol && kerzen.length > 0) return;
      symbol = s;
      rememberSelectedSymbol(s);
      if (reiterEl) {
        offen = oeffneChart(offen, s);
        merkeOffene();
        zeichneOffene();
      }
      kopf = null;
      kerzen = [];
      gezeigteStrategien.clear();
      verborgeneIdeen.clear();
      stift.setzeWerkzeug("zeiger");
      stift.setzeZeichnungen([]);
      if (wiedergabe.aktiv) beendeWiedergabe(false);
      symbolNameEl.textContent = anzeigeName(s, quotes.get(s)?.name ?? "");
      zeichneListe();
      void ladeKerzen(true);
      void ladeZeichnungen();
      void ladeKennzahlen();
      void ladeAlarme();
      void ladeArbeit();
    }

    // ------------------------------------------------------------------ Beobachtungsliste
    function zeile(s: string): string {
      const q = quotes.get(s);
      const gewaehlt = s === symbol;
      const name = anzeigeName(s, q?.name ?? "");
      if (!q) {
        return `<div class="markt__wert${gewaehlt ? " is-selected" : ""}" data-symbol="${escapeHtml(s)}" role="option" tabindex="0" aria-selected="${gewaehlt}">
          <span class="markt__wert-name">${escapeHtml(name)}<small>${escapeHtml(s)}${fehlgeschlagen.has(s.toUpperCase()) ? " · kein Kurs" : ""}</small></span>
          <span class="markt__wert-kurs">${fehlgeschlagen.has(s.toUpperCase()) ? "—" : "…"}</span><span></span>
          <button type="button" class="watch-row__remove" data-remove="${escapeHtml(s)}" aria-label="${escapeHtml(name)} entfernen">${icon("close")}</button>
        </div>`;
      }
      const ton = q.changePct >= 0 ? "ist-hoch" : "ist-tief";
      return `<div class="markt__wert${gewaehlt ? " is-selected" : ""}" data-symbol="${escapeHtml(s)}" role="option" tabindex="0" aria-selected="${gewaehlt}">
        <span class="markt__wert-name">${escapeHtml(name)}<small>${escapeHtml(s)}</small></span>
        <span class="markt__wert-kurs">${escapeHtml(formatPrice(q.price))}</span>
        <span class="markt__wert-pct ${ton}">${escapeHtml(formatPercent(q.changePct))}</span>
        <button type="button" class="watch-row__remove" data-remove="${escapeHtml(s)}" aria-label="${escapeHtml(name)} entfernen">${icon("close")}</button>
      </div>`;
    }

    function zeichneListe(): void {
      countEl.textContent = watchlist.length > 0 ? String(watchlist.length) : "";
      if (watchlist.length === 0) {
        listeEl.innerHTML =
          '<p class="watchlist__empty">Noch leer. Oben einen Wert suchen und hinzufügen.</p>';
        return;
      }
      const typVon = (s: string) =>
        (quotes.get(s) as (MarketQuote & { typ?: string }) | undefined)?.typ ?? "";
      const gruppen = GRUPPEN.map((g) => ({
        name: g.name,
        werte: watchlist.filter((s) => g.typen.includes(typVon(s))),
      }));
      const rest = watchlist.filter((s) => !GRUPPEN.some((g) => g.typen.includes(typVon(s))));
      if (rest.length > 0)
        gruppen.push({
          name: gruppen.some((g) => g.werte.length > 0) ? "Weitere" : "",
          werte: rest,
        });
      listeEl.innerHTML = gruppen
        .filter((g) => g.werte.length > 0)
        .map(
          (g) =>
            `${g.name ? `<h3 class="markt__gruppenname">${escapeHtml(g.name)}</h3>` : ""}${g.werte.map(zeile).join("")}`,
        )
        .join("");
    }

    async function ladeKurse(): Promise<void> {
      if (watchlist.length === 0) {
        zeichneListe();
        untertitelEl.textContent = "Yahoo Finance";
        return;
      }
      try {
        const d = await ctx.api.get<MarketQuotesData>(
          `/integrations/markets/quotes?symbols=${encodeURIComponent(watchlist.join(","))}`,
        );
        if (verworfen) return;
        const neu = new Map<string, MarketQuote>();
        for (const s of watchlist) {
          const q = d.quotes.find((x) => x.symbol.toUpperCase() === s.toUpperCase());
          if (q) neu.set(s, q);
        }
        quotes = neu;
        fehlgeschlagen = new Set(d.failed.map((s) => s.toUpperCase()));
        zeichneListe();
        zeichneOffene();
        untertitelEl.textContent = `Yahoo Finance · Stand ${uhr()}`;
      } catch (error) {
        if (!verworfen) untertitelEl.textContent = describeError(error);
      }
    }

    function setzeListe(neu: string[]): void {
      watchlist = saveWatchlist(neu);
      zeichneListe();
      void ladeKurse();
    }

    listeEl.addEventListener("click", (e) => {
      const el = e.target as HTMLElement;
      const weg = el.closest<HTMLElement>("[data-remove]")?.dataset.remove;
      if (weg) {
        e.stopPropagation();
        setzeListe(removeSymbol(watchlist, weg));
        return;
      }
      const s = el.closest<HTMLElement>("[data-symbol]")?.dataset.symbol;
      if (s) {
        waehle(s);
        // Auf dem Telefon liegt der Chart über der Liste, außer Sicht — ohne den Sprung
        // geschähe auf den Tipp hin scheinbar nichts.
        if (handy) arbeitsplatzEl.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
    listeEl.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const s = (e.target as HTMLElement).closest<HTMLElement>("[data-symbol]")?.dataset.symbol;
      if (s) {
        e.preventDefault();
        waehle(s);
      }
    });

    let hinzuNummer = 0;
    let hinzuUhr: ReturnType<typeof setTimeout> | null = null;
    const verbergeTreffer = () => {
      resultsEl.hidden = true;
      resultsEl.innerHTML = "";
    };
    searchEl.addEventListener("input", () => {
      if (hinzuUhr) clearTimeout(hinzuUhr);
      const text = searchEl.value;
      hinzuUhr = setTimeout(async () => {
        const nummer = ++hinzuNummer;
        if (!text.trim()) {
          verbergeTreffer();
          return;
        }
        try {
          const d = await ctx.api.get<{ hits: MarketSearchHit[] }>(
            `/integrations/markets/search?q=${encodeURIComponent(text.trim())}`,
          );
          if (verworfen || nummer !== hinzuNummer) return;
          resultsEl.innerHTML =
            d.hits.length === 0
              ? `<li class="search__empty">Nichts gefunden für „${escapeHtml(text.trim())}".</li>`
              : d.hits
                  .map(
                    (
                      h,
                    ) => `<li><button class="search-hit" type="button" data-hit="${escapeHtml(h.symbol)}">
                      <span class="search-hit__name">${escapeHtml(anzeigeName(h.symbol, h.name))}</span>
                      <span class="search-hit__symbol">${escapeHtml(h.symbol)}</span>
                      <span class="search-hit__meta">${escapeHtml([h.exchange, describeQuoteType(h.type)].filter(Boolean).join(" · "))}</span>
                      <span class="search-hit__action">${hasSymbol(watchlist, h.symbol) ? "Anzeigen" : "Hinzufügen"}</span>
                    </button></li>`,
                  )
                  .join("");
          resultsEl.hidden = false;
        } catch (error) {
          resultsEl.innerHTML = `<li class="search__empty">${escapeHtml(describeError(error))}</li>`;
          resultsEl.hidden = false;
        }
      }, SEARCH_DEBOUNCE_MS);
    });
    const hinzuEl = rolle<HTMLButtonElement>("hinzu");
    const zeigeHinzu = (an: boolean) => {
      finde(".markt__liste")?.classList.toggle("ist-suchend", an);
      hinzuEl.setAttribute("aria-expanded", String(an));
      if (an) searchEl.focus();
    };
    hinzuEl.addEventListener("click", () =>
      zeigeHinzu(hinzuEl.getAttribute("aria-expanded") !== "true"),
    );
    const nimm = (s: string) => {
      searchEl.value = "";
      verbergeTreffer();
      zeigeHinzu(false);
      if (!hasSymbol(watchlist, s)) setzeListe(addSymbol(watchlist, s));
      waehle(s);
    };
    searchEl.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        searchEl.value = "";
        verbergeTreffer();
      }
      if (e.key === "Enter") {
        const erster = resultsEl.querySelector<HTMLElement>("[data-hit]")?.dataset.hit;
        const s = erster ?? searchEl.value.trim().toUpperCase();
        if (s) nimm(s);
      }
    });
    resultsEl.addEventListener("click", (e) => {
      const s = (e.target as HTMLElement).closest<HTMLElement>("[data-hit]")?.dataset.hit;
      if (s) nimm(s);
    });

    // ------------------------------------------------------------------ Rechte Seite
    let kennzahlen: KennzahlenAntwort | null = null;
    let kuroAntwort = "";
    let kuroFrageLaeuft = false;

    async function ladeKennzahlen(): Promise<void> {
      const fuer = symbol;
      kennzahlen = null;
      if (reiter === "ueberblick") zeichneReiter();
      try {
        const k = await ctx.api.get<KennzahlenAntwort>(
          `/integrations/markets/kennzahlen?symbol=${encodeURIComponent(fuer)}`,
        );
        if (verworfen || fuer !== symbol) return;
        kennzahlen = k;
        if (reiter === "ueberblick") zeichneReiter();
        zeichneHandykopf(null);
      } catch {
        // Die Kennzahlen sind Beiwerk; der Überblick sagt dann nur, was der Kurs hergibt.
      }
    }

    function spannenBalken(
      titel: string,
      tiefW: number | undefined | null,
      hochW: number | undefined | null,
      kurs: number,
    ): string {
      if (
        tiefW === undefined ||
        hochW === undefined ||
        tiefW === null ||
        hochW === null ||
        hochW <= tiefW
      )
        return "";
      const anteil = Math.min(100, Math.max(0, ((kurs - tiefW) / (hochW - tiefW)) * 100));
      const s = stellen();
      return `<div class="markt__spanne">
        <span class="markt__spanne-titel">${escapeHtml(titel)}</span>
        <span class="markt__spanne-werte"><span>${formatKurs(tiefW, s)}</span><span>${formatKurs(hochW, s)}</span></span>
        <span class="markt__spanne-balken"><i style="left:${anteil.toFixed(1)}%"></i></span>
      </div>`;
    }

    function ueberblick(): string {
      const k = kopf;
      if (!k) return '<p class="markt__leise">Lädt …</p>';
      const s = stellen();
      const ton = k.changePct >= 0 ? "ist-hoch" : "ist-tief";
      const lage = marktLage(k, Date.now() / 1000);
      const z = kennzahlen?.kennzahlen;
      const perf = z
        ? `<div class="markt__perf">${z.performance
            .map(
              (p) =>
                `<div class="markt__perf-kachel ${p.prozent === null ? "" : p.prozent >= 0 ? "ist-hoch" : "ist-tief"}"><b>${p.prozent === null ? "—" : formatPercent(p.prozent)}</b><span>${escapeHtml(p.spanne)}</span></div>`,
            )
            .join("")}</div>`
        : "";
      const zeilen: [string, string][] = [];
      if (k.vortag) zeilen.push(["Vortag", formatKurs(k.vortag, s)]);
      if (k.tagVolumen) zeilen.push(["Volumen heute", formatVolumen(k.tagVolumen)]);
      if (z?.volumenSchnitt30)
        zeilen.push(["Ø Volumen 30 Tage", formatVolumen(z.volumenSchnitt30)]);
      if (z?.atrTag)
        zeilen.push([
          "ATR 14 (Tag)",
          `${formatKurs(z.atrTag, s)} · ${((z.atrTag / k.price) * 100).toLocaleString("de-DE", { maximumFractionDigits: 2 })} %`,
        ]);
      return `
        <div class="markt__preis">
          <span class="markt__preis-gross">${formatKurs(k.price, s)}<small>${escapeHtml(k.currency)}</small></span>
          <span class="markt__preis-aenderung ${ton}">${k.change >= 0 ? "+" : "−"}${formatKurs(Math.abs(k.change), s)} (${formatPercent(k.changePct)})</span>
          <span class="markt__leise">${escapeHtml([lage.text, k.kursZeit ? `Kurs von ${uhr(k.kursZeit)} Uhr` : ""].filter(Boolean).join(" · "))}</span>
        </div>
        ${spannenBalken("Tagesspanne", k.tagTief, k.tagHoch, k.price)}
        ${spannenBalken("52 Wochen", k.weekLow52, k.weekHigh52, k.price)}
        ${zeilen.length > 0 ? `<dl class="markt__zahlen">${zeilen.map(([a, b]) => `<dt>${escapeHtml(a)}</dt><dd>${escapeHtml(b)}</dd>`).join("")}</dl>` : ""}
        ${perf ? `<h3 class="markt__abschnitt">Wertentwicklung</h3>${perf}` : ""}
        <p class="markt__fussnote">${escapeHtml([k.exchange, describeQuoteType(k.typ ?? ""), k.symbol].filter(Boolean).join(" · "))} · Yahoo Finance, je nach Börse verzögert</p>`;
    }

    // ---- Kuro
    async function ladePrognosen(): Promise<void> {
      const fuer = symbol;
      try {
        const d = await ctx.api.get<{ prognosen: PrognoseMitStand[] }>(
          `/integrations/prognosen?symbol=${encodeURIComponent(fuer)}`,
        );
        if (verworfen || fuer !== symbol) return;
        prognosen = d.prognosen;
        // Aus einer Analyse hierher gekommen: zu ihrer Idee springen, einmal.
        const gesucht = absicht?.prognose
          ? prognosen.find((p) => p.prognose.id === absicht.prognose)
          : undefined;
        if (gesucht && !ideeGezeigt) {
          ideeGezeigt = true;
          arbeitSichtbar = true;
          void springeZu(Math.floor(Date.parse(gesucht.prognose.angelegt) / 1000));
        }
      } catch {
        prognosen = [];
      }
      zeichneArbeit();
      zeichneLeiste();
      if (reiter === "kuro") zeichneReiter();
    }

    async function ladeArbeit(): Promise<void> {
      const fuer = symbol;
      arbeit = null;
      prognosen = [];
      void ladePrognosen();
      try {
        const d = await ctx.api.get<ArbeitUebersicht>(
          `/integrations/markets/arbeit?symbol=${encodeURIComponent(fuer)}&name=${encodeURIComponent(anzeigeName(fuer, kopf?.name ?? quotes.get(fuer)?.name ?? ""))}`,
        );
        if (verworfen || fuer !== symbol) return;
        arbeit = d;
      } catch {
        arbeit = { strategien: [], analysen: [], papier: [] };
      }
      zeichneLeiste();
      if (reiter === "kuro") zeichneReiter();
    }

    async function zeigeStrategie(id: string, springen: boolean): Promise<void> {
      try {
        hinweis("Rechnet die Handel der Strategie nach …", 3000);
        const s = await ctx.api.get<StrategieImChart>(
          `/integrations/strategien/${encodeURIComponent(id)}/chart`,
        );
        if (verworfen) return;
        const ziel = chartSymbolFuer(s.symbol);
        if (ziel.symbol !== symbol) waehle(ziel.symbol);
        gezeigteStrategien.set(id, s);
        arbeitSichtbar = true;
        if (istIntervallId(s.intervall) && s.intervall !== iv) {
          hinweis(
            `Auf ${intervall(s.intervall).wort} gewechselt — darauf ist die Strategie gerechnet.`,
            5000,
          );
          await setzeIntervall(s.intervall, false);
        }
        // Die Indikatoren der Regel dazu, soweit sie noch fehlen.
        const fehlend = s.indikatoren
          .map((x) => ausId(x))
          .filter(
            (x): x is AktiverIndikator =>
              x !== null && !aktive.some((a) => indikatorId(a) === indikatorId(x)),
          );
        if (fehlend.length > 0) {
          aktive = [...aktive, ...fehlend];
          await indikatorenGeaendert();
        }
        if (ziel.anderePlattform)
          hinweis(
            "Gerechnet auf Binance-Kerzen, gezeigt auf Yahoo — die Kurse weichen leicht ab.",
            7000,
          );
        zeichneArbeit();
        zeichneLeiste();
        if (reiter === "kuro") zeichneReiter();
        if (springen && s.handel.length > 0) {
          // Den Prüfzeitraum samt der Zeit danach zeigen.
          await ladeBis(s.von);
          const von = naechsteKerze(s.von);
          if (von >= 0)
            chart.timeScale().setVisibleLogicalRange({ from: von, to: kerzen.length + 5 });
        }
      } catch (error) {
        hinweis(`Strategie nicht gezeigt: ${describeError(error)}`, 8000);
      }
    }

    function zeichneArbeit(): void {
      const formen: Form[] = [];
      const markenAchse: AchsenMarke[] = [];
      const alleMarken: {
        time: UTCTimestamp;
        position: "aboveBar" | "belowBar";
        shape: "arrowUp" | "arrowDown" | "circle";
        color: string;
        text: string;
      }[] = [];
      const s = stellen();
      if (arbeitSichtbar && !wiedergabe.aktiv) {
        const jetzt = Date.now() / 1000;
        for (const p of prognosen) {
          if (verborgeneIdeen.has(p.prognose.id)) continue;
          formen.push(...prognoseFormen(p, jetzt, s));
        }
        for (const st of gezeigteStrategien.values()) {
          const { formen: f, marken: m } = strategieFormen(st);
          formen.push(...f);
          const schritt = intervall(iv).sekunden;
          for (const x of m) {
            // Auf die Kerze des Charts einrasten — eine Marke, die neben jeder Kerze liegt, zeigt er nicht.
            const i = naechsteKerze(x.time);
            if (i < 0 || Math.abs((kerzen[i] as Kerze).time - x.time) > schritt / 2) continue;
            alleMarken.push({ ...x, time: zt((kerzen[i] as Kerze).time) });
          }
        }
      }
      // Alarme stehen immer da — sie sind keine Arbeit Kuros, sondern Jakobs Auftrag.
      for (const a of alarme) {
        if (a.status !== "aktiv") continue;
        formen.push({
          typ: "hlinie",
          preis: a.preis,
          farbe: FARBE.kuro,
          breite: 1,
          strich: [6, 4],
          text: `Alarm ${formatKurs(a.preis, s)}${a.notiz ? ` · ${a.notiz}` : ""}`,
        });
        markenAchse.push({ preis: a.preis, text: formatKurs(a.preis, s), farbe: FARBE.kuro });
      }
      alleMarken.sort((a, b) => a.time - b.time);
      marken.setMarkers(alleMarken);
      ebene.setzeFremd(formen, markenAchse);
    }

    rolle("arbeit-knopf").addEventListener("click", () => {
      arbeitSichtbar = !arbeitSichtbar;
      zeichneArbeit();
      zeichneLeiste();
      if (arbeitSichtbar) {
        reiter = "kuro";
        zeichneReiter();
      }
    });

    function kontext(): string {
      const k = kopf;
      const bereich = chart.timeScale().getVisibleLogicalRange();
      const n = sichtbar();
      const von = kerzen[Math.max(0, Math.floor(bereich?.from ?? 0))];
      const bis = kerzen[Math.min(n - 1, Math.floor(bereich?.to ?? n - 1))];
      const teile = [
        `Wert: ${anzeigeName(symbol, k?.name ?? "")} (${symbol}), ${intervall(iv).wort}`,
        k
          ? `Kurs ${formatKurs(k.price, stellen())} ${k.currency} (${formatPercent(k.changePct)} zum Vortag)`
          : "",
        von && bis ? `Im Blick: ${datum(von.time, false)} bis ${datum(bis.time, false)}` : "",
        aktive.length > 0 ? `Indikatoren: ${aktive.map(beschriftung).join(", ")}` : "",
        zeichnungen.length > 0
          ? `Meine Zeichnungen: ${zeichnungen.map(beschreibe).join("; ")}`
          : "",
        alarme.some((a) => a.status === "aktiv")
          ? `Alarme: ${alarme
              .filter((a) => a.status === "aktiv")
              .map((a) => formatKurs(a.preis, stellen()))
              .join(", ")}`
          : "",
      ];
      return teile.filter(Boolean).join("\n");
    }

    async function frageKuro(frage: string): Promise<void> {
      if (kuroFrageLaeuft || !frage.trim()) return;
      kuroFrageLaeuft = true;
      kuroAntwort = "";
      zeichneReiter();
      const inhalt = `[Aus den Märkten]\n${frage.trim()}\n\n${kontext()}`;
      try {
        const a = await ctx.api.post<NachrichtAntwort>("/channels/web/messages", {
          content: inhalt,
        });
        const text =
          a.delivered?.find((d) => d.kind === "reply")?.text ??
          (a.status === "failed" ? `Gescheitert: ${a.reason ?? ""}` : "");
        kuroAntwort = text || "Kuro hat den Auftrag angenommen; die Antwort steht im Gespräch.";
      } catch (error) {
        kuroAntwort = `Nicht angekommen: ${describeError(error)}`;
      } finally {
        kuroFrageLaeuft = false;
        if (!verworfen) {
          zeichneReiter();
          void ladeArbeit();
        }
      }
    }

    function kuroReiter(): string {
      const name = anzeigeName(symbol, kopf?.name ?? "");
      const ideen = prognosen
        .slice()
        .reverse()
        .map((p) => {
          const v = p.verlauf;
          const stand = v ? STAND_WORT[v.stand] : (p.fehler ?? "nicht gerechnet");
          const an = !verborgeneIdeen.has(p.prognose.id);
          return `<li class="markt__eintrag">
            <button type="button" class="markt__auge${an ? " ist-an" : ""}" data-idee="${escapeHtml(p.prognose.id)}" aria-pressed="${an}" title="Im Chart zeigen">${SVG('<path d="M2.5 10s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5Z"/><circle cx="10" cy="10" r="2.2"/>')}</button>
            <div>
              <p class="markt__eintrag-titel">${escapeHtml(wer(p.prognose.von))} · ${p.prognose.richtung === "long" ? "Long" : "Short"} ab ${formatKurs(p.prognose.ausloeser, stellen())}</p>
              <p class="markt__leise">Stop ${formatKurs(p.prognose.stop, stellen())} · Ziel ${p.prognose.ziele.map((z) => formatKurs(z, stellen())).join(" / ")} · ${escapeHtml(datum(Date.parse(p.prognose.angelegt) / 1000, false))}</p>
              <p class="markt__stand ist-${escapeHtml(v?.stand ?? "offen")}">${escapeHtml(stand)}${v?.r !== null && v?.r !== undefined ? ` · ${rText(v.r)}` : ""}</p>
              ${p.prognose.these ? `<details><summary>These</summary><p>${escapeHtml(p.prognose.these)}</p>${p.prognose.widerlegtWenn ? `<p class="markt__leise">Widerlegt, wenn: ${escapeHtml(p.prognose.widerlegtWenn)}</p>` : ""}</details>` : ""}
            </div>
          </li>`;
        })
        .join("");
      const strategien = (arbeit?.strategien ?? [])
        .map((s) => {
          const gezeigt = gezeigteStrategien.get(s.id);
          return `<li class="markt__eintrag">
            <button type="button" class="markt__auge${gezeigt ? " ist-an" : ""}" data-strategie="${escapeHtml(s.id)}" aria-pressed="${Boolean(gezeigt)}" title="Handel im Chart zeigen">${SVG('<path d="M2.5 10s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5Z"/><circle cx="10" cy="10" r="2.2"/>')}</button>
            <div>
              <p class="markt__eintrag-titel">${escapeHtml(s.name)} <span class="analysen__status-marke ist-${escapeHtml(s.status)}">${escapeHtml(s.status === "geprueft" ? "geprüft" : s.status)}</span></p>
              ${
                gezeigt
                  ? `<p class="markt__leise">${escapeHtml(strategieZeile(gezeigt))}</p>
                     <ul class="markt__regel">${gezeigt.regel.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>
                     <p class="markt__stand ${gezeigt.signalLetzteKerze ? "ist-offen" : ""}">${gezeigt.signalLetzteKerze ? "Die Regel meldet auf der letzten Kerze einen Einstieg." : "Auf der letzten Kerze kein Einstiegssignal."}</p>
                     ${gezeigt.abweichung ? `<p class="markt__fehler">${escapeHtml(gezeigt.abweichung)}</p>` : ""}`
                  : `<p class="markt__leise">${escapeHtml(intervall(s.intervall).wort)} · ${escapeHtml(s.von)} bis ${escapeHtml(s.bis)}${s.kennzahlen ? ` · ${s.kennzahlen.anzahl} Handel, ${rText(s.kennzahlen.erwartungswertR)} je Handel` : ""}</p>`
              }
            </div>
          </li>`;
        })
        .join("");
      const analysen = (arbeit?.analysen ?? [])
        .map(
          (a) =>
            `<li><button type="button" class="markt__verweis" data-analyse="${escapeHtml(a.id)}">${escapeHtml(a.titel)}</button> <span class="markt__leise">${escapeHtml(datum(Date.parse(a.zeit) / 1000, false))}</span></li>`,
        )
        .join("");
      return `
        <form class="markt__frage" data-role="frage">
          <textarea rows="2" data-role="frage-feld" placeholder="Frag Kuro zu ${escapeHtml(name)} — er sieht, was du siehst: Kerzen, Linien, Ideen." ${kuroFrageLaeuft ? "disabled" : ""}></textarea>
          <button type="submit" class="markt__knopf markt__knopf--kuro" ${kuroFrageLaeuft ? "disabled" : ""}>${kuroFrageLaeuft ? "Kuro arbeitet …" : "Fragen"}</button>
        </form>
        <div class="markt__antwort" data-role="antwort">${kuroFrageLaeuft ? '<p class="markt__leise">Kuro ist dran. Geht es an den Handelstisch, dauert es eine Weile — die Antwort steht dann hier und im Gespräch.</p>' : kuroAntwort ? `<div class="markdown">${renderMarkdown(kuroAntwort)}</div>` : ""}</div>

        <h3 class="markt__abschnitt">Einzelideen <span class="markt__leise">aus dem Prognosebuch</span></h3>
        ${ideen ? `<ul class="markt__eintraege">${ideen}</ul>` : `<p class="markt__leise">Keine Idee zu ${escapeHtml(name)}. Zeichne eine Long- oder Short-Idee und leg sie ins Prognosebuch — dann verfolgt der Code, was daraus wird.</p>`}

        <h3 class="markt__abschnitt">Strategien <span class="markt__leise">aus dem Archiv, neu gerechnet</span></h3>
        ${strategien ? `<ul class="markt__eintraege">${strategien}</ul>` : `<p class="markt__leise">Keine geprüfte Strategie auf ${escapeHtml(name)}.</p>`}

        ${analysen ? `<h3 class="markt__abschnitt">Analysen, die ${escapeHtml(name)} nennen</h3><ul class="markt__verweise">${analysen}</ul>` : ""}
        ${(arbeit?.papier ?? []).length > 0 ? `<p class="markt__leise">Papierhandel läuft: ${(arbeit?.papier ?? []).map((p) => escapeHtml(p.name)).join(", ")}</p>` : ""}`;
    }

    // ---- Alarme
    async function ladeAlarme(): Promise<void> {
      try {
        const d = await ctx.api.get<{ alarme: Alarm[] }>(
          `/integrations/markets/alarme?symbol=${encodeURIComponent(symbol)}`,
        );
        if (verworfen) return;
        alarme = d.alarme;
      } catch {
        alarme = [];
      }
      rolle("alarm-zahl").textContent = alarme.some((a) => a.status === "aktiv")
        ? String(alarme.filter((a) => a.status === "aktiv").length)
        : "";
      zeichneArbeit();
      if (reiter === "alarme") zeichneReiter();
    }

    async function legeAlarm(preis: number, notiz?: string): Promise<void> {
      try {
        // Die Erlaubnis für Mitteilungen wird dort erfragt, wo sie gebraucht wird: beim ersten Alarm.
        if (typeof Notification !== "undefined" && Notification.permission === "default") {
          void Notification.requestPermission();
        }
        const a = await ctx.api.post<Alarm>("/integrations/markets/alarme", {
          symbol,
          preis,
          name: anzeigeName(symbol, kopf?.name ?? ""),
          ...(notiz ? { notiz } : {}),
        });
        hinweis(
          `Alarm gesetzt: ${a.name} ${a.richtung === "ueber" ? "steigt auf" : "fällt auf"} ${formatKurs(a.preis, stellen())}. Geprüft wird jede Minute.`,
          6000,
        );
        await ladeAlarme();
      } catch (error) {
        hinweis(`Kein Alarm: ${describeError(error)}`, 8000);
      }
    }

    function alarmReiter(): string {
      const s = stellen();
      const liste = alarme
        .map(
          (a) => `<li class="markt__alarm${a.status === "ausgeloest" ? " ist-ausgeloest" : ""}">
            <span>${a.richtung === "ueber" ? "steigt auf" : "fällt auf"} <b>${formatKurs(a.preis, s)}</b>${a.notiz ? ` <span class="markt__leise">· ${escapeHtml(a.notiz)}</span>` : ""}</span>
            <span class="markt__leise">${a.status === "aktiv" ? "aktiv" : `ausgelöst ${a.ausgeloestAm ? datum(Date.parse(a.ausgeloestAm) / 1000, true) : ""}${a.ausgeloestKurs ? ` bei ${formatKurs(a.ausgeloestKurs, s)}` : ""}`}</span>
            ${a.status === "ausgeloest" ? `<button type="button" class="markt__knopf markt__knopf--klein" data-scharf="${escapeHtml(a.id)}">Neu scharf</button>` : ""}
            <button type="button" class="watch-row__remove" data-alarm-weg="${escapeHtml(a.id)}" aria-label="Alarm löschen">${icon("close")}</button>
          </li>`,
        )
        .join("");
      return `
        <form class="markt__alarmform" data-role="alarmform">
          <label>Preis<input type="text" inputmode="decimal" data-role="alarm-preis" value="${kopf ? formatKurs(kopf.price, s) : ""}" /></label>
          <label>Notiz<input type="text" maxlength="120" data-role="alarm-notiz" placeholder="optional" /></label>
          <button type="submit" class="markt__knopf markt__knopf--kuro">Setzen</button>
        </form>
        <p class="markt__leise">Löst aus, sobald der Kurs die Marke erreicht — ob von unten oder von oben, ergibt sich aus dem Kurs beim Setzen. Geprüft wird jede Minute gegen Yahoo; eine Spitze dazwischen sieht der Alarm nicht. Die Meldung kommt in jedes offene Kuronami-Fenster.</p>
        ${liste ? `<ul class="markt__alarme">${liste}</ul>` : `<p class="markt__leise">Noch kein Alarm auf ${escapeHtml(anzeigeName(symbol, kopf?.name ?? ""))}. Schneller: eine horizontale Linie ziehen und „Alarm auf diese Linie".</p>`}`;
    }

    // ---- Reiter
    function zeichneReiter(): void {
      for (const b of findeAlle<HTMLButtonElement>("[data-reiter]")) {
        const an = b.dataset.reiter === reiter;
        b.classList.toggle("ist-aktiv", an);
        b.setAttribute("aria-selected", String(an));
      }
      reiterInhalt.innerHTML =
        reiter === "ueberblick" ? ueberblick() : reiter === "kuro" ? kuroReiter() : alarmReiter();
    }

    finde(".markt__reiter")?.addEventListener("click", (e) => {
      const r = (e.target as HTMLElement).closest<HTMLElement>("[data-reiter]")?.dataset.reiter as
        | typeof reiter
        | undefined;
      if (r) {
        reiter = r;
        zeichneReiter();
      }
    });

    reiterInhalt.addEventListener("submit", (e) => {
      e.preventDefault();
      const form = e.target as HTMLElement;
      if (form.dataset.role === "frage") {
        const feld = form.querySelector<HTMLTextAreaElement>("textarea");
        if (feld?.value.trim()) void frageKuro(feld.value);
      }
      if (form.dataset.role === "alarmform") {
        const preis = pruefeZahl(
          form.querySelector<HTMLInputElement>('[data-role="alarm-preis"]')?.value ?? "",
        );
        const notiz = form
          .querySelector<HTMLInputElement>('[data-role="alarm-notiz"]')
          ?.value.trim();
        if (preis === null) {
          hinweis("Das ist kein Preis.");
          return;
        }
        void legeAlarm(preis, notiz || undefined);
      }
    });
    reiterInhalt.addEventListener("keydown", (e) => {
      const feld = e.target as HTMLElement;
      if (feld.dataset.role === "frage-feld" && e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const text = (feld as HTMLTextAreaElement).value;
        if (text.trim()) void frageKuro(text);
      }
    });
    reiterInhalt.addEventListener("click", (e) => {
      const el = e.target as HTMLElement;
      const idee = el.closest<HTMLElement>("[data-idee]")?.dataset.idee;
      if (idee) {
        if (verborgeneIdeen.has(idee)) verborgeneIdeen.delete(idee);
        else verborgeneIdeen.add(idee);
        arbeitSichtbar = true;
        zeichneArbeit();
        zeichneLeiste();
        zeichneReiter();
        return;
      }
      const st = el.closest<HTMLElement>("[data-strategie]")?.dataset.strategie;
      if (st) {
        if (gezeigteStrategien.has(st)) {
          gezeigteStrategien.delete(st);
          zeichneArbeit();
          zeichneReiter();
        } else {
          void zeigeStrategie(st, true);
        }
        return;
      }
      const analyse = el.closest<HTMLElement>("[data-analyse]")?.dataset.analyse;
      if (analyse) {
        try {
          globalThis.sessionStorage?.setItem("kuronami.analysen.oeffne", analyse);
        } catch {
          // Dann öffnen die Analysen eben mit der jüngsten.
        }
        ctx.navigate("analysen");
        return;
      }
      const scharf = el.closest<HTMLElement>("[data-scharf]")?.dataset.scharf;
      if (scharf) {
        void ctx.api
          .post(`/integrations/markets/alarme/${encodeURIComponent(scharf)}/scharf`, {})
          .then(ladeAlarme, (error) => hinweis(describeError(error)));
        return;
      }
      const weg = el.closest<HTMLElement>("[data-alarm-weg]")?.dataset.alarmWeg;
      if (weg) {
        void ctx.api
          .delete(`/integrations/markets/alarme/${encodeURIComponent(weg)}`)
          .then(ladeAlarme, (error) => hinweis(describeError(error)));
      }
    });

    rolle("alarm-knopf").addEventListener("click", () => {
      reiter = "alarme";
      zeichneReiter();
      reiterInhalt.querySelector<HTMLInputElement>('[data-role="alarm-preis"]')?.focus();
    });
    rolle("kuro-knopf").addEventListener("click", () => {
      reiter = "kuro";
      zeichneReiter();
      reiterInhalt.querySelector<HTMLTextAreaElement>('[data-role="frage-feld"]')?.focus();
    });

    // Ein Alarm, der auslöst, während die Märkte offen sind: gleich im Chart und in der Liste.
    const busAbo = ctx.bus.onMessage((m) => {
      if (m.type === "alarm.ausgeloest") void ladeAlarme();
      if (m.type === "analyse.neu") void ladeArbeit();
    });

    // ------------------------------------------------------------------ Wiedergabe
    function zeichneWiedergabe(): void {
      if (!wiedergabe.aktiv && !wiedergabe.waehlen) {
        wiedergabeEl.hidden = true;
        wiedergabeEl.innerHTML = "";
        return;
      }
      wiedergabeEl.hidden = false;
      if (wiedergabe.waehlen) {
        wiedergabeEl.innerHTML = `<span>Wähle im Chart die Kerze, ab der es losgeht.</span><button type="button" data-wg="ende">Abbrechen</button>`;
        return;
      }
      const k = kerzen[wiedergabe.index];
      wiedergabeEl.innerHTML = `
        <button type="button" data-wg="neu" title="Neuen Startpunkt wählen">${SVG('<path d="M4 4.5v11M15.5 4.5 8 10l7.5 5.5Z"/>')}</button>
        <button type="button" data-wg="spiel" title="${wiedergabe.laeuft ? "Anhalten" : "Abspielen"}">${wiedergabe.laeuft ? SVG('<path d="M6.5 4.5v11M13.5 4.5v11"/>') : SVG('<path d="M6 4.5 15.5 10 6 15.5Z"/>')}</button>
        <button type="button" data-wg="schritt" title="Eine Kerze weiter (Umschalt+→)">${SVG('<path d="M4.5 4.5 12 10l-7.5 5.5ZM15.5 4.5v11"/>')}</button>
        <label>Tempo <select data-wg="tempo">${[1, 3, 10]
          .map(
            (t) =>
              `<option value="${t}" ${t === wiedergabe.tempo ? "selected" : ""}>${t} Kerze${t === 1 ? "" : "n"}/s</option>`,
          )
          .join("")}</select></label>
        <span class="markt__leise">${k ? escapeHtml(datum(k.time, intervall(iv).sekunden < 86_400)) : ""} · die Zukunft ist ausgeblendet</span>
        <button type="button" data-wg="ende">Beenden</button>`;
    }

    function starteWahl(): void {
      if (kerzen.length < 50) {
        hinweis("Zu wenige Kerzen für eine Wiedergabe.");
        return;
      }
      stift.setzeWerkzeug("zeiger");
      stift.gesperrt = true;
      wiedergabe.waehlen = true;
      leinwandEl.classList.add("ist-waehlend");
      zeichneWiedergabe();
      zeichneLeiste();
    }

    function starteWiedergabe(index: number): void {
      wiedergabe.waehlen = false;
      wiedergabe.aktiv = true;
      wiedergabe.index = Math.max(20, Math.min(index, kerzen.length - 2));
      wiedergabe.laeuft = false;
      stift.gesperrt = false;
      leinwandEl.classList.remove("ist-waehlend");
      zeichneAlles(false);
      chart.timeScale().setVisibleLogicalRange({
        from: Math.max(0, wiedergabe.index - 120),
        to: wiedergabe.index + 30,
      });
      zeichneArbeit();
      zeichneWiedergabe();
      zeichneLeiste();
    }

    function schritt(): void {
      if (!wiedergabe.aktiv) return;
      if (wiedergabe.index >= kerzen.length - 1) {
        halte();
        hinweis("Das Ende der geladenen Kerzen ist erreicht.");
        return;
      }
      wiedergabe.index += 1;
      const i = wiedergabe.index;
      const daten = hauptDaten(i + 1);
      haupt.update(daten[i] as never);
      if (zeigeVolumen()) volumen.update(volumenDaten(i + 1)[i] as never);
      for (const r of reihen) {
        for (const s of r.serien) {
          const d = reihenDaten(r, s.name, i + 1)[i];
          if (d) s.serie.update(d as never);
        }
      }
      ebene.setzeAchse(
        kerzen.slice(0, i + 1).map((k) => anzeigeZeit(k.time)),
        intervall(iv).sekunden,
      );
      stift.male();
      zeichneLegende(null);
      zeichneWiedergabe();
    }

    function halte(): void {
      wiedergabe.laeuft = false;
      if (wiedergabe.uhr) clearInterval(wiedergabe.uhr);
      wiedergabe.uhr = 0;
      zeichneWiedergabe();
    }

    function spiele(): void {
      halte();
      wiedergabe.laeuft = true;
      wiedergabe.uhr = setInterval(schritt, 1000 / wiedergabe.tempo);
      zeichneWiedergabe();
    }

    function beendeWiedergabe(neuZeichnen = true): void {
      halte();
      wiedergabe.aktiv = false;
      wiedergabe.waehlen = false;
      stift.gesperrt = false;
      leinwandEl.classList.remove("ist-waehlend");
      zeichneWiedergabe();
      if (neuZeichnen) {
        zeichneAlles(false);
        zeichneArbeit();
      }
      zeichneLeiste();
    }

    rolle("wiedergabe-knopf").addEventListener("click", () => {
      if (wiedergabe.aktiv || wiedergabe.waehlen) beendeWiedergabe();
      else starteWahl();
    });
    wiedergabeEl.addEventListener("click", (e) => {
      const tat = (e.target as HTMLElement).closest<HTMLElement>("[data-wg]")?.dataset.wg;
      if (tat === "ende") beendeWiedergabe();
      if (tat === "schritt") {
        halte();
        schritt();
      }
      if (tat === "spiel") {
        if (wiedergabe.laeuft) halte();
        else spiele();
      }
      if (tat === "neu") {
        beendeWiedergabe();
        starteWahl();
      }
    });
    wiedergabeEl.addEventListener("change", (e) => {
      const feld = e.target as HTMLSelectElement;
      if (feld.dataset.wg === "tempo") {
        wiedergabe.tempo = Number(feld.value) || 3;
        if (wiedergabe.laeuft) spiele();
      }
    });
    chart.subscribeClick((p) => {
      if (!wiedergabe.waehlen || p.logical === undefined) return;
      starteWiedergabe(Math.round(p.logical));
    });

    // ------------------------------------------------------------------ Tastatur
    const tasten = (e: KeyboardEvent) => {
      const ziel = e.target as HTMLElement;
      if (ziel.closest("input, textarea, select, [contenteditable]")) return;
      if (!container.isConnected) return;
      if (e.key === "Escape") {
        if (!sucheEl.hidden) schliesseSuche();
        else if (offenesMenue) schliesseMenue();
        else if (wiedergabe.waehlen) beendeWiedergabe();
        else stift.abbrechen();
        markiereWerkzeug();
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && stift.gewaehlteZeichnung) {
        e.preventDefault();
        stift.loesche(stift.gewaehlteZeichnung.id);
        return;
      }
      if (e.shiftKey && e.key === "ArrowRight" && wiedergabe.aktiv) {
        e.preventDefault();
        halte();
        schritt();
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        const w = TASTEN[e.key.toLowerCase()] ?? TASTEN[e.code.replace("Key", "").toLowerCase()];
        if (w) {
          e.preventDefault();
          stift.setzeWerkzeug(w);
          markiereWerkzeug();
        }
        return;
      }
      // Wie bei TradingView: einfach lostippen, und die Suche geht auf.
      if (!e.ctrlKey && !e.metaKey && e.key.length === 1 && /[\p{L}\p{N}^]/u.test(e.key)) {
        e.preventDefault();
        oeffneSuche(e.key);
      }
    };
    document.addEventListener("keydown", tasten);

    // ------------------------------------------------------------------ Uhr
    const zeigeUhr = () => {
      const d = new Date();
      uhrEl.textContent = `${d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" })} ${zonenKuerzel(d)}`;
    };
    zeigeUhr();
    const sekundenUhr = setInterval(zeigeUhr, 1000);

    // ------------------------------------------------------------------ Telefon
    function wendeGeraetAn(): void {
      wurzelEl.classList.toggle("markt--handy", handy);
      wurzelEl.classList.toggle("markt--schlicht", schlicht());
      handyMehrEl.classList.toggle("ist-aktiv", alleWerkzeuge);
      handyMehrEl.setAttribute("aria-pressed", String(alleWerkzeuge));
      passeChartAn();
      volumen.setData(zeigeVolumen() ? volumenDaten(sichtbar()) : []);
      if (schlicht()) markiereZeitraum(handyZr.id);
      zeichneHandykopf(null);
    }
    handyMehrEl.addEventListener("click", () => {
      alleWerkzeuge = !alleWerkzeuge;
      wendeGeraetAn();
      if (schlicht()) void zeigeHandyZeitraum(handyZr);
    });
    const geraetGewechselt = (e: MediaQueryListEvent) => {
      handy = e.matches;
      if (!handy) alleWerkzeuge = false;
      wendeGeraetAn();
      if (schlicht()) void zeigeHandyZeitraum(handyZr);
    };
    handyFrage?.addEventListener("change", geraetGewechselt);

    // ------------------------------------------------------------------ Start
    wendeGeraetAn();
    zeichneLeiste();
    baueIndikatoren();
    markiereWerkzeug();
    zeichneListe();
    zeichneReiter();
    void ladeKurse();
    void ladeKerzen(true).then(() => {
      zeichneLeiste();
      if (absicht?.strategie) void zeigeStrategie(absicht.strategie, true);
    });
    void ladeZeichnungen();
    void ladeKennzahlen();
    void ladeAlarme();
    void ladeArbeit();
    const kursUhr = setInterval(() => void ladeKurse(), QUOTES_EVERY_MS);

    return () => {
      verworfen = true;
      clearInterval(kursUhr);
      clearInterval(kerzenUhr);
      clearInterval(sekundenUhr);
      if (wiedergabe.uhr) clearInterval(wiedergabe.uhr);
      if (hinweisUhr) clearTimeout(hinweisUhr);
      if (speicherUhr) {
        clearTimeout(speicherUhr);
        void speichereZeichnungen(symbol, zeichnungen);
      }
      document.removeEventListener("keydown", tasten);
      document.removeEventListener("pointerdown", draussen);
      handyFrage?.removeEventListener("change", geraetGewechselt);
      busAbo();
      stift.zerstoere();
      chart.remove();
    };
  },
};
