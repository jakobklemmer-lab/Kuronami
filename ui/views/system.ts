import { ApiError } from "../api/client.js";
import type { BusMessage } from "../events/bus.js";
import { icon } from "../icons.js";
import { werName } from "../welle/form.js";
import { escapeHtml } from "./html.js";
import type { View, ViewContext } from "./types.js";

/**
 * Die System-Ansicht — Kuro als Orchestrator (2026-09-26).
 *
 * Bis hierher stand hier, was der alte Motor ins Ereignisprotokoll schrieb: Läufe, Plan,
 * Kennzahlen und „Kosten je Agent und Tag". Seit dem Motorwechsel am 18.09. schreibt dort niemand
 * mehr; die Seite zeigte Sitzungen vom 17.09. als „läuft" und eine Woche lang „$0,00". Jakob:
 * „die Kosten entfernen und dafür die session limits, token usage usw abbilden, also quasi den
 * orchestrator."
 *
 * Jetzt vier Fragen, in dieser Reihenfolge:
 *
 *  1. **Reicht das Abo?** Die Fenster für Sitzung und Woche (`/integrations/abo`). Sie gelten für
 *     Jakobs ganzes Abo, nicht nur für Kuro — die Seite sagt das dazu.
 *  2. **Wie geht es Kuro?** Modell, wie alt und groß seine Unterhaltung ist, wie voll der Kontext.
 *  3. **Wer hat was verbraucht?** Kuro und das Personal in einer Tabelle, heute oder sieben Tage,
 *     in Token und nicht in Dollar — Kuro läuft über das Abo, ein Dollarbetrag wäre eine
 *     Schätzung, die wie eine Rechnung aussieht.
 *  4. **Was lief zuletzt?** Die jüngsten Läufe aus dem Verbrauchsbuch.
 *
 * Eine offene Rückfrage steht darüber, sobald es eine gibt — nur hier und im Gespräch lässt sie
 * sich beantworten, und ohne Antwort steht Kuro still.
 */

interface Summe {
  laeufe: number;
  neu: number;
  cacheGelesen: number;
  cacheGeschrieben: number;
  ausgabe: number;
  dauerMs: number;
  fehlgeschlagen: number;
}

interface Posten {
  zeit: string;
  wer: string;
  unter?: string;
  modell: string;
  neu: number;
  cacheGelesen: number;
  cacheGeschrieben: number;
  ausgabe: number;
  schritte: number;
  dauerMs: number;
  ok: boolean;
  kanal?: string;
}

interface Person {
  name: string;
  modell: string;
  beschreibung: string;
  arbeitet?: { seit: string; stand: string; zuarbeit: string[] } | null;
}

interface Orchestrator {
  kuro: {
    modell: string;
    abrechnung: "abo" | "api";
    sitzung: { id: string; seit: string | null; groesseBytes: number } | null;
    kontext: { tokens: number; fenster: number | null } | null;
    grenzmeldung: {
      status: "allowed" | "allowed_warning" | "rejected";
      rateLimitType?: string;
      resetsAt?: number;
      utilization?: number;
      um: string;
    } | null;
  };
  personal: Person[];
  handelstisch: Person[];
  verbrauch: {
    seit: string | null;
    heute: Record<string, Summe>;
    woche: Record<string, Summe>;
    letzte: Posten[];
  };
}

interface Fenster {
  id: string;
  name: string;
  prozent: number;
  zurueck: string | null;
  warnung: boolean;
}

type AboStand =
  | {
      verfuegbar: true;
      plan: string | null;
      fenster: Fenster[];
      aufteilung: Array<{ name: string; prozent: number }>;
      zusatz: boolean;
      stand: string;
    }
  | { verfuegbar: false; grund: string; stand: string };

interface AskOption {
  id: string;
  label: string;
}

interface PendingApproval {
  askId: string;
  question: string;
  options: AskOption[];
}

const AKTUALISIEREN_MS = 800;
const TAKT_MS = 30_000;

// ------------------------------------------------------------- Formen

function describeApiError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === "no_token") return "Nicht angemeldet.";
    if (error.status === 401) return "Die Anmeldung ist abgelaufen.";
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

const ZAHL = new Intl.NumberFormat("de-DE");
const KOMPAKT = new Intl.NumberFormat("de-DE", { notation: "compact", maximumFractionDigits: 1 });

/** Token bis knapp unter einer Million ausgeschrieben, darüber „1,2 Mio.". */
export function token(n: number): string {
  return n < 1_000_000 ? ZAHL.format(n) : KOMPAKT.format(n);
}

export function dauer(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toLocaleString("de-DE", { maximumFractionDigits: 1 })} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} Min. ${Math.round(s - min * 60)} s`;
  return `${Math.floor(min / 60)} Std. ${min % 60} Min.`;
}

/** Der Abstand zweier Zeitpunkte, für „in …" und „seit …": „4 Std. 48 Min.", „3 Tagen". */
export function abstand(von: Date, bis: Date): string {
  const min = Math.max(0, Math.round((bis.getTime() - von.getTime()) / 60_000));
  if (min < 60) return `${min} Min.`;
  const std = Math.floor(min / 60);
  if (std < 48) return `${std} Std. ${min % 60} Min.`;
  return `${Math.round(std / 24)} Tagen`;
}

function uhrzeit(d: Date): string {
  return d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

function wann(d: Date, jetzt: Date): string {
  const tag = (x: Date) => x.toDateString();
  if (tag(d) === tag(jetzt)) return `heute, ${uhrzeit(d)}`;
  const morgen = new Date(jetzt.getTime() + 86_400_000);
  if (tag(d) === tag(morgen)) return `morgen, ${uhrzeit(d)}`;
  return `${d.toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "short" })}, ${uhrzeit(d)}`;
}

function groesse(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toLocaleString("de-DE", { maximumFractionDigits: 1 })} MB`;
}

/**
 * `claude-sonnet-5` → `Sonnet 5`, `claude-haiku-4-5-2025…` → `Haiku 4.5`, der Kurzname `opus` →
 * `Opus`. Alles andere bleibt, wie es kommt.
 */
export function modellName(id: string): string {
  if (/^[a-z]+$/.test(id)) return `${id[0].toUpperCase()}${id.slice(1)}`;
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(id);
  if (!m) return id;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

/**
 * Wie ernst ein Füllstand ist. Die Farbe trägt es, der Text sagt es noch einmal — damit es auch
 * lesen kann, wer die Farben nicht unterscheidet.
 */
export function lage(prozent: number, warnung = false): { klasse: string; wort: string } {
  if (prozent >= 95) return { klasse: "meter--kritisch", wort: "fast erschöpft" };
  if (prozent >= 80 || warnung) return { klasse: "meter--knapp", wort: "wird knapp" };
  return { klasse: "", wort: "" };
}

function meter(opt: {
  name: string;
  prozent: number;
  wert: string;
  unter: string;
  warnung?: boolean;
}): string {
  const p = Math.max(0, Math.min(100, opt.prozent));
  const { klasse, wort } = lage(p, opt.warnung);
  return `
    <div class="meter ${klasse}">
      <div class="meter__kopf">
        <span class="meter__name">${escapeHtml(opt.name)}</span>
        <span class="meter__wert">${escapeHtml(opt.wert)}${wort ? ` <span class="meter__wort">· ${wort}</span>` : ""}</span>
      </div>
      <div class="meter__spur" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(p)}" aria-label="${escapeHtml(opt.name)}">
        <span class="meter__fuellung" style="width:${p}%"></span>
      </div>
      <p class="meter__unter">${escapeHtml(opt.unter)}</p>
    </div>`;
}

// ------------------------------------------------------------- Teile

function aboHtml(abo: AboStand, jetzt: Date): string {
  if (!abo.verfuegbar) {
    return `<p class="card__hint">Die Abo-Grenzen sind gerade nicht abrufbar: ${escapeHtml(abo.grund)}</p>`;
  }
  const fenster = abo.fenster
    .map((f) => {
      const zurueck = f.zurueck ? new Date(f.zurueck) : null;
      const name = f.id === "sitzung" ? "Sitzung · 5 Stunden" : f.name;
      const unter = zurueck
        ? `Wieder frei in ${abstand(jetzt, zurueck)} · ${wann(zurueck, jetzt)}`
        : "Kein Zeitpunkt gemeldet";
      return meter({
        name,
        prozent: f.prozent,
        wert: `${Math.round(f.prozent)} %`,
        unter,
        warnung: f.warnung,
      });
    })
    .join("");
  const plan = abo.plan ? `${abo.plan[0].toUpperCase()}${abo.plan.slice(1)}-Abo` : "Abo";
  const aufteilung = abo.aufteilung.length
    ? ` Die Woche ging bisher an ${abo.aufteilung.map((a) => `${escapeHtml(a.name)} ${a.prozent} %`).join(", ")}.`
    : "";
  return `
    <div class="system-abo__fenster">${fenster || `<p class="card__hint">Der Anbieter hat keine Fenster gemeldet.</p>`}</div>
    <p class="card__hint system-abo__fuss">${plan} — die Fenster gelten für alles darauf, nicht nur für Kuro: auch Claude Code und Chats zählen mit.${aufteilung}${abo.zusatz ? " Zusatzverbrauch ist eingeschaltet." : " Ist ein Fenster voll, antwortet Kuro bis zum Zurücksetzen nicht."}</p>`;
}

/**
 * Die Abo-Karte, bevor der Anbieter geantwortet hat — in der Form der fertigen Karte. Beim ersten
 * Aufruf nach einem Neustart dauert die Abfrage bis zu zwei Sekunden; stünde bis dahin nur eine
 * Zeile da, spränge die ganze Seite, wenn die Fenster kommen.
 */
function aboPlatzhalter(): string {
  const leer = (name: string) =>
    meter({ name, prozent: 0, wert: "…", unter: "Frage beim Anbieter nach …" });
  return `
    <div class="system-abo__fenster">${leer("Sitzung · 5 Stunden")}${leer("Woche")}</div>
    <p class="card__hint system-abo__fuss">Die Fenster gelten für alles auf dem Abo, nicht nur für Kuro: auch Claude Code und Chats zählen mit.</p>`;
}

function kuroHtml(o: Orchestrator, jetzt: Date): string {
  const k = o.kuro;
  const zeilen: string[] = [];
  zeilen.push(
    `<div class="system-fakt"><dt>Modell</dt><dd>${escapeHtml(modellName(k.modell))}</dd></div>`,
  );
  if (k.sitzung) {
    const seit = k.sitzung.seit ? new Date(k.sitzung.seit) : null;
    const tage = seit ? Math.floor((jetzt.getTime() - seit.getTime()) / 86_400_000) : null;
    const alter =
      tage === null
        ? ""
        : tage === 0
          ? " · seit heute"
          : tage === 1
            ? " · seit gestern"
            : ` · seit ${tage} Tagen`;
    const datum = seit
      ? escapeHtml(seit.toLocaleDateString("de-DE", { day: "numeric", month: "short" }))
      : "?";
    zeilen.push(
      `<div class="system-fakt"><dt>Unterhaltung</dt><dd>${datum}${alter} · ${groesse(k.sitzung.groesseBytes)}</dd></div>`,
    );
  } else {
    zeilen.push(`<div class="system-fakt"><dt>Unterhaltung</dt><dd>noch keine</dd></div>`);
  }
  zeilen.push(
    `<div class="system-fakt"><dt>Abrechnung</dt><dd>${k.abrechnung === "abo" ? "über das Abo" : "über den API-Schlüssel"}</dd></div>`,
  );

  let kontext = "";
  if (k.kontext?.fenster) {
    const p = (k.kontext.tokens / k.kontext.fenster) * 100;
    kontext = meter({
      name: "Kontext",
      prozent: p,
      wert: `${token(k.kontext.tokens)} von ${token(k.kontext.fenster)}`,
      unter:
        p >= 80
          ? "Bald fasst Claude Code die Unterhaltung zusammen."
          : "So viel liest Kuro bei jeder Nachricht mit — Persona, Werkzeuge, Verlauf.",
    });
  } else if (k.kontext) {
    kontext = `<p class="card__hint">Kontext beim letzten Zug: ${token(k.kontext.tokens)} Token.</p>`;
  } else {
    kontext = `<p class="card__hint">Der Kontext steht nach Kuros nächstem Zug hier.</p>`;
  }

  let meldung = "";
  const g = k.grenzmeldung;
  if (g && g.status !== "allowed") {
    const zurueck = g.resetsAt ? ` bis ${wann(new Date(g.resetsAt * 1000), jetzt)}` : "";
    const fenster = g.rateLimitType === "five_hour" ? "Sitzungsfenster" : "Wochenfenster";
    const text =
      g.status === "rejected"
        ? `Der Anbieter hat Kuro gebremst${zurueck}.`
        : `Der Anbieter meldet: das ${fenster} wird knapp.`;
    meldung = `<p class="system-meldung${g.status === "rejected" ? " system-meldung--kritisch" : ""}">${icon("warning")}<span>${text}</span></p>`;
  }

  return `<dl class="system-fakten">${zeilen.join("")}</dl>${kontext}${meldung}`;
}

/** Was `/integrations/gespraeche` liefert — nur, was die Karte braucht. */
export interface ArchivStand {
  lage: { seit: string | null; groesseBytes: number } | null;
  tage: { tag: string; nachrichten: number; themen?: string }[];
  fenster: [number, number];
  aus: boolean;
}

/**
 * Das Gesprächsarchiv unter Kuros Karte (2026-09-27): wann das Gespräch abgelegt wird, was schon
 * liegt, und ein Knopf, es jetzt zu tun. Kuro liest den Wortlaut selbst (`im_archiv_suchen`); hier
 * steht, dass es ihn gibt.
 */
export function archivHtml(a: ArchivStand, arbeitet: boolean): string {
  const wann = a.aus
    ? "abgeschaltet (KURO_ARCHIV=aus)"
    : `nachts zwischen ${a.fenster[0]} und ${a.fenster[1]} Uhr, mit Übergabe an das nächste`;
  const letzter = a.tage[0];
  const abgelegt =
    a.tage.length === 0
      ? "noch nichts"
      : `${a.tage.length} ${a.tage.length === 1 ? "Tag" : "Tage"}, zuletzt ${new Date(`${letzter?.tag}T12:00:00`).toLocaleDateString("de-DE", { day: "numeric", month: "short" })}`;
  return `
    <dl class="system-fakten">
      <div class="system-fakt"><dt>Archiviert wird</dt><dd>${escapeHtml(wann)}</dd></div>
      <div class="system-fakt"><dt>Im Archiv</dt><dd>${escapeHtml(abgelegt)}</dd></div>
    </dl>
    ${
      a.lage?.seit
        ? `<button type="button" class="system-archiv__knopf" data-role="archivieren" ${arbeitet ? "disabled" : ""}>${arbeitet ? "Kuro schreibt die Übergabe …" : "Gespräch jetzt archivieren"}</button>`
        : ""
    }`;
}

function zeile(opt: {
  name: string;
  rolle: string;
  modell: string;
  jetzt: string;
  summe?: Summe;
  eingerueckt?: boolean;
}): string {
  const s = opt.summe;
  const zahl = (n: number) => (s && s.laeufe > 0 ? token(n) : "–");
  const fehl = s?.fehlgeschlagen
    ? ` <span class="personal__fehl" title="davon gescheitert">(${s.fehlgeschlagen} gescheitert)</span>`
    : "";
  return `
    <tr class="${opt.eingerueckt ? "personal__neben" : ""}">
      <th scope="row"><span class="personal__name">${escapeHtml(opt.name)}</span>${opt.rolle ? `<span class="personal__rolle">${escapeHtml(opt.rolle)}</span>` : ""}</th>
      <td class="personal__modell">${escapeHtml(opt.modell)}</td>
      <td class="personal__jetzt">${opt.jetzt}</td>
      <td class="spend-table__num">${s?.laeufe ? `${s.laeufe}${fehl}` : "–"}</td>
      <td class="spend-table__num">${zahl(s ? s.neu + s.cacheGeschrieben : 0)}</td>
      <td class="spend-table__num">${zahl(s?.cacheGelesen ?? 0)}</td>
      <td class="spend-table__num">${zahl(s?.ausgabe ?? 0)}</td>
      <td class="spend-table__num">${s?.laeufe ? dauer(s.dauerMs / s.laeufe) : "–"}</td>
    </tr>`;
}

function personalHtml(o: Orchestrator, zeitraum: "heute" | "woche", jetzt: Date): string {
  const tabelle = o.verbrauch[zeitraum];
  const bekannt = new Set<string>(["kuro"]);
  const zeilen: string[] = [];

  zeilen.push(
    zeile({
      name: "Kuro",
      rolle: "Butler",
      modell: modellName(o.kuro.modell),
      jetzt: "",
      summe: tabelle.kuro,
    }),
  );
  for (const p of o.personal) {
    bekannt.add(p.name);
    const a = p.arbeitet;
    const jetztText = a
      ? `<span class="personal__arbeitet" title="${escapeHtml(a.stand)}">arbeitet seit ${abstand(new Date(a.seit), jetzt)}</span>`
      : `<span class="personal__frei">frei</span>`;
    zeilen.push(
      zeile({
        name: werName(p.name),
        rolle: "",
        modell: modellName(p.modell),
        jetzt: jetztText,
        summe: tabelle[p.name],
      }),
    );
    // Der Handelstisch arbeitet nur der Börse zu — seine Spezialisten stehen darunter. Wer im
    // Zeitraum nichts getan hat, bekommt keine eigene Zeile voller Striche: die Namen stehen
    // gesammelt in einer.
    if (p.name === "boerse") {
      const ruhig = o.handelstisch.filter((t) => !tabelle[t.name]);
      for (const t of o.handelstisch) bekannt.add(t.name);
      if (ruhig.length > 0) {
        zeilen.push(`
          <tr class="personal__neben personal__tisch">
            <th scope="row" colspan="8"><span class="personal__name">Handelstisch</span><span class="personal__rolle">${escapeHtml(ruhig.map((t) => werName(t.name)).join(", "))} — ${zeitraum === "heute" ? "heute" : "in sieben Tagen"} nicht im Einsatz</span></th>
          </tr>`);
      }
      for (const t of o.handelstisch.filter((x) => tabelle[x.name])) {
        zeilen.push(
          zeile({
            name: werName(t.name),
            rolle: "Handelstisch",
            modell: modellName(t.modell),
            jetzt: "",
            summe: tabelle[t.name],
            eingerueckt: true,
          }),
        );
      }
    }
  }
  // Wer im Buch steht, aber nicht mehr zum Personal gehört, fällt nicht stillschweigend weg.
  for (const [name, summe] of Object.entries(tabelle)) {
    if (bekannt.has(name)) continue;
    zeilen.push(zeile({ name: werName(name), rolle: "ehemals", modell: "", jetzt: "", summe }));
  }

  const gesamt: Summe = {
    laeufe: 0,
    neu: 0,
    cacheGelesen: 0,
    cacheGeschrieben: 0,
    ausgabe: 0,
    dauerMs: 0,
    fehlgeschlagen: 0,
  };
  for (const s of Object.values(tabelle)) {
    gesamt.laeufe += s.laeufe;
    gesamt.neu += s.neu;
    gesamt.cacheGelesen += s.cacheGelesen;
    gesamt.cacheGeschrieben += s.cacheGeschrieben;
    gesamt.ausgabe += s.ausgabe;
    gesamt.dauerMs += s.dauerMs;
    gesamt.fehlgeschlagen += s.fehlgeschlagen;
  }

  return `
    <div class="personal__rahmen">
      <table class="spend-table personal">
        <thead>
          <tr>
            <th scope="col">Wer</th>
            <th scope="col">Modell</th>
            <th scope="col">Jetzt</th>
            <th scope="col" class="spend-table__num">Läufe</th>
            <th scope="col" class="spend-table__num" title="Eingabe, die neu gelesen wurde — frisch oder zum ersten Mal in den Cache gelegt">Eingabe</th>
            <th scope="col" class="spend-table__num" title="Eingabe aus dem Zwischenspeicher — zählt deutlich weniger">aus Cache</th>
            <th scope="col" class="spend-table__num">Ausgabe</th>
            <th scope="col" class="spend-table__num">Ø Dauer</th>
          </tr>
        </thead>
        <tbody>${zeilen.join("")}</tbody>
        <tfoot>${zeile({ name: "Zusammen", rolle: "", modell: "", jetzt: "", summe: gesamt })}</tfoot>
      </table>
    </div>`;
}

function laeufeHtml(o: Orchestrator, jetzt: Date): string {
  if (o.verbrauch.letzte.length === 0) {
    return `<p class="card__hint">Noch kein Lauf im Buch. Jeder Zug von Kuro und jeder Auftrag an das Personal landet hier, sobald er fertig ist.</p>`;
  }
  return `<ol class="laeufe">${o.verbrauch.letzte
    .map((p) => {
      const d = new Date(p.zeit);
      const wer =
        p.wer === "kuro"
          ? `Kuro${p.kanal ? ` <span class="laeufe__fuer">${escapeHtml(p.kanal)}</span>` : ""}`
          : `${escapeHtml(werName(p.wer))}${p.unter ? ` <span class="laeufe__fuer">für ${escapeHtml(werName(p.unter))}</span>` : ""}`;
      const zeit =
        d.toDateString() === jetzt.toDateString()
          ? uhrzeit(d)
          : d.toLocaleDateString("de-DE", { day: "numeric", month: "numeric" });
      const aufrufe = `${p.schritte} ${p.schritte === 1 ? "Aufruf" : "Aufrufe"}`;
      return `
        <li class="laeufe__zeile${p.ok ? "" : " laeufe__zeile--fehl"}">
          <time datetime="${escapeHtml(p.zeit)}" title="${escapeHtml(d.toLocaleString("de-DE"))}">${zeit}</time>
          <span class="laeufe__wer">${wer}</span>
          <span class="laeufe__zahlen">${token(p.neu + p.cacheGeschrieben)} ein · ${token(p.cacheGelesen)} Cache · ${token(p.ausgabe)} aus</span>
          <span class="laeufe__dauer">${p.ok ? "" : "gescheitert · "}${aufrufe} · ${dauer(p.dauerMs)}</span>
        </li>`;
    })
    .join("")}</ol>`;
}

// ------------------------------------------------------------- Ansicht

export const systemView: View = {
  mount(container: HTMLElement, ctx: ViewContext) {
    container.innerHTML = `
      <div class="detail-view">
        <header class="detail-view__head">
          ${icon("system", { className: "detail-view__icon" })}
          <div>
            <h1 class="detail-view__title">System</h1>
            <p class="detail-view__subtitle">Kuro und sein Haus: wie weit das Abo reicht, wer wie viel verbraucht, wer gerade arbeitet.</p>
          </div>
        </header>

        <section class="card glass system-rueckfrage" data-role="rueckfrage" hidden aria-labelledby="system-rueckfrage-titel">
          <header class="card__head">
            ${icon("bell", { className: "card__icon" })}
            <h2 class="card__title" id="system-rueckfrage-titel">Kuro wartet auf dich</h2>
          </header>
          <ul class="card__approvals-list" data-role="rueckfrage-liste"></ul>
          <p class="card__hint" data-role="rueckfrage-hinweis" hidden></p>
        </section>

        <div class="system-grid">
          <section class="card glass card--abo" aria-labelledby="system-abo-titel">
            <header class="card__head">
              ${icon("check", { className: "card__icon" })}
              <h2 class="card__title" id="system-abo-titel">Abo-Grenzen</h2>
              <span class="card__meta" data-role="abo-stand"></span>
            </header>
            <div data-role="abo">${aboPlatzhalter()}</div>
          </section>

          <section class="card glass card--kuro" aria-labelledby="system-kuro-titel">
            <header class="card__head">
              ${icon("praesenz", { className: "card__icon" })}
              <h2 class="card__title" id="system-kuro-titel">Kuro</h2>
            </header>
            <div data-role="kuro"><p class="card__hint">Lädt …</p></div>
            <div class="system-archiv" data-role="archiv"></div>
          </section>

          <section class="card glass card--personal" aria-labelledby="system-personal-titel">
            <header class="card__head">
              ${icon("system", { className: "card__icon" })}
              <h2 class="card__title" id="system-personal-titel">Personal und Verbrauch</h2>
              <div class="system-zeitraum" role="group" aria-label="Zeitraum">
                <button type="button" class="chart-panel__interval is-active" data-zeitraum="heute" aria-pressed="true">Heute</button>
                <button type="button" class="chart-panel__interval" data-zeitraum="woche" aria-pressed="false">7 Tage</button>
              </div>
            </header>
            <div data-role="personal"><p class="card__hint">Lädt …</p></div>
            <p class="card__hint" data-role="seit"></p>
          </section>

          <section class="card glass card--laeufe" aria-labelledby="system-laeufe-titel">
            <header class="card__head">
              ${icon("research", { className: "card__icon" })}
              <h2 class="card__title" id="system-laeufe-titel">Letzte Läufe</h2>
            </header>
            <div data-role="laeufe"></div>
          </section>
        </div>
      </div>
    `;

    const q = <T extends HTMLElement>(role: string) =>
      container.querySelector<T>(`[data-role="${role}"]`) as T;
    const aboEl = q<HTMLElement>("abo");
    const aboStand = q<HTMLElement>("abo-stand");
    const kuroEl = q<HTMLElement>("kuro");
    const archivEl = q<HTMLElement>("archiv");
    const personalEl = q<HTMLElement>("personal");
    const seitEl = q<HTMLElement>("seit");
    const laeufeEl = q<HTMLElement>("laeufe");
    const rueckfrage = q<HTMLElement>("rueckfrage");
    const rueckfrageListe = q<HTMLElement>("rueckfrage-liste");
    const rueckfrageHinweis = q<HTMLElement>("rueckfrage-hinweis");

    let zeitraum: "heute" | "woche" = "heute";
    let stand: Orchestrator | null = null;
    let weg = false;

    const zeichne = (): void => {
      if (!stand || weg) return;
      const jetzt = new Date();
      kuroEl.innerHTML = kuroHtml(stand, jetzt);
      personalEl.innerHTML = personalHtml(stand, zeitraum, jetzt);
      laeufeEl.innerHTML = laeufeHtml(stand, jetzt);
      const seit = stand.verbrauch.seit;
      seitEl.textContent = seit
        ? `Gezählt seit ${new Date(`${seit}T12:00:00`).toLocaleDateString("de-DE", { day: "numeric", month: "long" })}. „Eingabe" ist, was neu gelesen wurde; „aus Cache" kam aus dem Zwischenspeicher und zählt deutlich weniger.`
        : "";
    };

    for (const knopf of container.querySelectorAll<HTMLButtonElement>("[data-zeitraum]")) {
      knopf.addEventListener("click", () => {
        zeitraum = knopf.dataset.zeitraum === "woche" ? "woche" : "heute";
        for (const k of container.querySelectorAll<HTMLButtonElement>("[data-zeitraum]")) {
          const an = k === knopf;
          k.classList.toggle("is-active", an);
          k.setAttribute("aria-pressed", String(an));
        }
        zeichne();
      });
    }

    async function ladeOrchestrator(): Promise<void> {
      try {
        stand = await ctx.api.get<Orchestrator>("/integrations/orchestrator");
        zeichne();
      } catch (error) {
        if (weg) return;
        const text = `<p class="card__hint">${escapeHtml(describeApiError(error))}</p>`;
        kuroEl.innerHTML = text;
        personalEl.innerHTML = text;
      }
    }

    let archiv: ArchivStand | null = null;
    let archiviert = false;
    let archivMeldung = "";
    const zeichneArchiv = (): void => {
      if (!archiv || weg) return;
      archivEl.innerHTML = `${archivHtml(archiv, archiviert)}${archivMeldung ? `<p class="card__hint">${escapeHtml(archivMeldung)}</p>` : ""}`;
    };
    async function ladeArchiv(): Promise<void> {
      try {
        archiv = await ctx.api.get<ArchivStand>("/integrations/gespraeche");
        zeichneArchiv();
      } catch {
        // Ohne Archivstand fehlt nur diese Zeile.
      }
    }
    archivEl.addEventListener("click", (e) => {
      if (!(e.target as HTMLElement).closest('[data-role="archivieren"]') || archiviert) return;
      archiviert = true;
      archivMeldung = "";
      zeichneArchiv();
      void ctx.api
        .post<{
          status: string;
          grund?: string;
          ergebnis?: { tage: string[]; nachrichten: number };
        }>("/integrations/gespraeche/archivieren", {})
        .then(
          (r) => {
            archivMeldung =
              r.status === "archiviert"
                ? `Abgelegt: ${r.ergebnis?.tage.length ?? 0} Tage, ${r.ergebnis?.nachrichten ?? 0} Nachrichten. Kuro beginnt mit der Übergabe neu.`
                : (r.grund ?? "Nichts zu archivieren.");
          },
          (err) => {
            archivMeldung = `Nicht archiviert: ${describeApiError(err)} — Kuro bleibt im Gespräch.`;
          },
        )
        .finally(() => {
          archiviert = false;
          void ladeArchiv();
          void ladeOrchestrator();
        });
    });

    async function ladeAbo(): Promise<void> {
      try {
        const abo = await ctx.api.get<AboStand>("/integrations/abo");
        if (weg) return;
        aboEl.innerHTML = aboHtml(abo, new Date());
        aboStand.textContent = `Stand ${uhrzeit(new Date(abo.stand))}`;
      } catch (error) {
        if (weg) return;
        aboEl.innerHTML = `<p class="card__hint">${escapeHtml(describeApiError(error))}</p>`;
      }
    }

    function zeigeRueckfragen(offen: PendingApproval[]): void {
      rueckfrage.hidden = offen.length === 0;
      rueckfrageListe.replaceChildren(
        ...offen.map((ask) => {
          const item = document.createElement("li");
          item.className = "approval-row";
          const frage = document.createElement("p");
          frage.textContent = ask.question;
          const optionen = document.createElement("div");
          optionen.className = "approval-row__options";
          for (const option of ask.options) {
            const knopf = document.createElement("button");
            knopf.type = "button";
            knopf.textContent = option.label;
            knopf.addEventListener("click", () => void beantworte(ask.askId, option.id));
            optionen.append(knopf);
          }
          item.append(frage, optionen);
          return item;
        }),
      );
    }

    async function beantworte(askId: string, choiceId: string): Promise<void> {
      try {
        await ctx.api.post("/channels/web/answers", { askId, choiceId });
        await ladeRueckfragen();
      } catch (error) {
        rueckfrageHinweis.hidden = false;
        rueckfrageHinweis.textContent = describeApiError(error);
      }
    }

    async function ladeRueckfragen(): Promise<void> {
      try {
        const data = await ctx.api.get<{ pending: PendingApproval[] }>("/channels/web/pending");
        rueckfrageHinweis.hidden = true;
        zeigeRueckfragen(data.pending);
      } catch {
        // Ohne Liste keine Rückfrage — die Karte bleibt zu, der Rest der Seite zeigt den Fehler.
        zeigeRueckfragen([]);
      }
    }

    // Nach jedem Zug, Auftrag und jeder Buchung neu — gebündelt, weil ein Zug viele Ereignisse
    // auf einmal schickt. Die Textstücke (`model.delta`) ändern hier nichts.
    let plan: ReturnType<typeof setTimeout> | null = null;
    const baldNeu = (): void => {
      if (plan !== null) return;
      plan = globalThis.setTimeout(() => {
        plan = null;
        void ladeOrchestrator();
        void ladeRueckfragen();
      }, AKTUALISIEREN_MS);
    };
    const abmelden = ctx.bus.onMessage((message: BusMessage) => {
      if (message.type === "bus.connected" || message.type === "model.delta") return;
      if (message.type === "turn.completed") void ladeAbo();
      if (message.type === "gespraech.archiviert") void ladeArchiv();
      baldNeu();
    });
    // Die Laufzeiten („arbeitet seit 3 Min.") und die Abo-Fenster altern auch ohne Ereignis.
    const takt = globalThis.setInterval(() => {
      void ladeOrchestrator();
      void ladeAbo();
    }, TAKT_MS);

    void ladeOrchestrator();
    void ladeAbo();
    void ladeRueckfragen();
    void ladeArchiv();

    return () => {
      weg = true;
      if (plan !== null) globalThis.clearTimeout(plan);
      globalThis.clearInterval(takt);
      abmelden();
    };
  },
};
