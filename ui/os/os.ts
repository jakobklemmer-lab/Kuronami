import { ABLAGE_HOECHSTENS, type ApiClient } from "../api/client.js";
import type { EventBusClient } from "../events/bus.js";
import { icon } from "../icons.js";
import type { MarketQuotesData } from "../integrations/types.js";
import { anzeigeName, formatPercent } from "../markets/format.js";
import { loadWatchlist } from "../markets/watchlist.js";
import type { MicStateStore } from "../mic/state.js";
import type { Zustand } from "../praesenz/sphaere.js";
import type { RouteId, SettingsSectionId } from "../router/router.js";
import { loadSettings, settingsBus } from "../settings/store.js";
import { settingsView } from "../settings/view.js";
import { analysenView } from "../views/analysen.js";
import { calendarView } from "../views/calendar.js";
import { escapeHtml } from "../views/html.js";
import { mailView } from "../views/mail.js";
import { researchView } from "../views/research.js";
import { strategienView } from "../views/strategien.js";
import { systemView } from "../views/system.js";
import { tradingView } from "../views/trading.js";
import type { Plaetze, View, ViewContext } from "../views/types.js";
import { verfolge } from "../welle/bereit.js";
import { mountFaden } from "../welle/faden.js";
import { werName } from "../welle/form.js";
import type { Gespraech } from "../welle/gespraech.js";
import * as V from "../welle/verlauf.js";
import { ZUSTAND_FARBE, ZUSTAND_SATZ } from "../welle/zustand.js";
import { type Lage, ausMatrix, dauer, fahrt, lage, spalt, transform, wischer } from "./band.js";
import { type BrainApp, mountBrainApp } from "./brain.js";
import { eingabeHtml, verdrahteEingabe } from "./eingabe.js";
import { mountFigur } from "./figur.js";
import { steuereHelligkeit } from "./helligkeit.js";
import { mountKuroRaum } from "./kuro-raum.js";
import { kuroZeile, uhrDauer } from "./kuro-zeile.js";
import {
  type Ort,
  RAEUME,
  RAUM_NAME,
  type Raum,
  TEILE,
  TEIL_NAME,
  type Teil,
  liesGemerkt,
  liesOrt,
  ortFuerRoute,
  raumFuerTaste,
  richtung,
  schreibeOrt,
} from "./raeume.js";

/**
 * Kuro OS, vierter Wurf — Entwurf 4c „Statuszeile" (Leinwand, 03.10.). Alles Bedienen steht in
 * einer dünnen Zeile unten, wie bei Obsidian: links die Räume, in der Mitte der kleine Kuro mit
 * seiner Zeile, rechts Suche, Woche, Uhr und Zahnrad. Oben ist nichts.
 *
 * Die Räume liegen auf einem Band (`band.ts`), jeder im Vollbild. Der Raum Kuro ist eine Spalte
 * mit dem Orb; die anderen sind gebaut wie Obsidian: links die Seite mit den Teilen, in der Mitte
 * der Inhalt, rechts eine Spalte, wenn eine Ansicht sie braucht (`ViewContext.plaetze`). Beim
 * Wechsel zieht die Kamera zurück, fährt hinüber und geht hinein — mit ⌘1–5 oder zwei Fingern.
 * System und Einstellungen kommen als Blatt von rechts.
 */

export interface OsOptionen {
  root: HTMLElement;
  api: ApiClient;
  bus: EventBusClient;
  mic: MicStateStore;
  gespraech: Gespraech;
  voice: { toggle(): void };
  toast(text: string): void;
}

const ANSICHT: Record<Exclude<Teil, "brain">, View> = {
  maerkte: tradingView,
  strategien: strategienView,
  analysen: analysenView,
  post: mailView,
  kalender: calendarView,
  recherche: researchView,
};

const STICHWORTE: Partial<Record<Raum | Teil, string>> = {
  kuro: "gespräch butler start",
  handel: "trading börse",
  maerkte: "chart kurse trading watchlist",
  strategien: "backtest regeln",
  analysen: "berichte einschätzungen",
  brain: "obsidian notizen graph",
  post: "mail e-mail",
  kalender: "termine planung",
  recherche: "suche studium",
};

type BlattTeil = "system" | "einstellungen";

const IST_MAC = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? "");
const BEFEHL = IST_MAC ? "⌘" : "Strg+";
const SPEICHER_TEILE = "kuronami.os.teile";
const MOTTO = "Always here. Always working.";
/** So lange gleitet ein Teil hinaus, bevor er abgebaut wird. */
const UEBERGANG_MS = 180;
/** So lange steht der Anfang einer Antwort in Kuros Zeile, wenn das Gespräch zu ist. */
const ANTWORT_STEHT_MS = 14_000;

const LUPE = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>`;
const RAD = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1"/></svg>`;

function seitenspeicher(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function raumHtml(r: Raum): string {
  const name = `<p class="o-raum__name" aria-hidden="true"><span>${RAUM_NAME[r]}</span><small data-role="unter-${r}"></small></p>`;
  if (r === "kuro") {
    return `<section class="o-raum o-raum--kuro" data-raum="kuro" aria-label="Kuro"><div class="o-raum__flaeche" data-role="raum-kuro"></div>${name}</section>`;
  }
  const teile = TEILE[r] as readonly Teil[];
  const mitTeilen = teile.length > 1;
  return `
    <section class="o-raum o-raum--arbeit" data-raum="${r}" aria-label="${RAUM_NAME[r]}">
      <div class="o-raum__flaeche">
        <aside class="o-seite">
          <h1 class="o-seite__titel">${RAUM_NAME[r]}</h1>
          ${
            mitTeilen
              ? `<nav class="o-teile" aria-label="Teile">${teile
                  .map(
                    (t) =>
                      `<a class="o-teil" href="${schreibeOrt({ raum: r, teil: t, notiz: null })}" data-teil="${t}">${escapeHtml(TEIL_NAME[t])}</a>`,
                  )
                  .join("")}</nav>`
              : ""
          }
          <div class="o-seite__platz" data-platz="seite"></div>
        </aside>
        <main class="o-mitte">
          <div class="o-reiter" data-platz="reiter"></div>
          <div class="o-mitte__buehne" data-platz="buehne"></div>
        </main>
        <aside class="o-spalte" data-platz="spalte"></aside>
      </div>
      ${name}
    </section>`;
}

export function mountOs(opt: OsOptionen): void {
  const { root, api, gespraech } = opt;
  const speicher = seitenspeicher();
  const merke = (schluessel: string, wert: string) => {
    try {
      speicher?.setItem(schluessel, wert);
    } catch {
      // Ohne Seitenspeicher gilt die Wahl bis zum Neuladen.
    }
  };
  let gemerkt = liesGemerkt(speicher?.getItem(SPEICHER_TEILE) ?? null);

  root.innerHTML = `
    <div class="o-os" data-raum="kuro" data-kuro="ruhe">
      <div class="o-zug" aria-hidden="true"></div>
      <div class="o-buehne" data-role="buehne">
        <div class="o-band" data-role="band">${RAEUME.map(raumHtml).join("")}</div>
      </div>

      <footer class="o-zeile">
        <div class="o-zeile__links">
          <button type="button" class="o-marke" data-role="marke" title="Zu Kuro (${BEFEHL}1)" aria-label="Zu Kuro">黒波</button>
          <nav class="o-raeume" data-role="raeume" aria-label="Räume">
            ${RAEUME.map(
              (r, i) =>
                `<a class="o-raum-knopf" href="#/${r}" data-raum="${r}" title="${RAUM_NAME[r]} (${BEFEHL}${i + 1})">${RAUM_NAME[r]}</a>`,
            ).join("")}
            <span class="o-raeume__strich" data-role="strich" aria-hidden="true"></span>
          </nav>
        </div>
        <div class="o-kuro" data-role="kuro">
          <span class="o-kuro__licht" aria-hidden="true"></span>
          <button type="button" class="o-kuro__figur" data-role="figur" aria-label="Gespräch mit Kuro öffnen" title="Gespräch mit Kuro (${BEFEHL}J)"></button>
          <button type="button" class="o-kuro__zeile" data-role="zeile" hidden>
            <span class="o-kuro__text" data-role="zeiletext"></span><time class="o-kuro__zeit" data-role="zeilezeit"></time>
          </button>
        </div>
        <div class="o-zeile__rechts">
          <button type="button" class="o-knopf" data-role="suche" aria-label="Suchen" title="Räume, Notizen, Kuro fragen (${BEFEHL}K)">${LUPE}</button>
          <button type="button" class="o-woche" data-role="woche" hidden></button>
          <time class="o-uhr" data-role="uhr"></time>
          <button type="button" class="o-knopf" data-role="haus" aria-label="System und Einstellungen" title="System und Einstellungen (${BEFEHL},)">${RAD}</button>
        </div>
      </footer>

      <section class="o-gespraech" data-role="gespraech" aria-label="Gespräch mit Kuro" hidden>
        <header class="o-gespraech__kopf">
          <p class="o-gespraech__satz" data-role="satz"></p>
          <a class="o-gespraech__raum" href="#/kuro">Zum Raum Kuro</a>
        </header>
        <div class="o-gespraech__faden" data-role="faden" aria-live="polite"></div>
        <p class="o-gespraech__leer" data-role="leer" hidden>Frag Kuro etwas oder halte die Sprechtaste.</p>
        ${eingabeHtml("form")}
      </section>

      <div class="o-blatt" data-role="blatt" hidden>
        <div class="o-blatt__grund" data-role="blattgrund"></div>
        <section class="o-blatt__tafel" role="dialog" aria-label="System und Einstellungen">
          <header class="o-blatt__kopf">
            <nav class="o-blatt__teile" data-role="blattteile" aria-label="System und Einstellungen">
              <a class="o-blatt__teil" href="#" data-blatt="system">System</a>
              <a class="o-blatt__teil" href="#" data-blatt="einstellungen">Einstellungen</a>
            </nav>
            <button type="button" class="o-knopf" data-role="blattzu" aria-label="Schließen" title="Schließen (Esc)">${icon("close")}</button>
          </header>
          <div class="o-blatt__inhalt w-raum" data-role="blattinhalt"></div>
        </section>
      </div>

      <div class="o-starter" data-role="starter" hidden>
        <div class="o-starter__feld" role="dialog" aria-label="Suchen">
          <input type="text" data-role="starterfeld" placeholder="Raum, Notiz oder Frage an Kuro" autocomplete="off" spellcheck="false" />
          <ol class="o-starter__liste" data-role="starterliste" role="listbox"></ol>
        </div>
      </div>

      <div class="o-ablage" data-role="ablage" hidden>
        <p>Loslassen legt die Datei in den Eingang des Brain.</p>
      </div>
    </div>`;

  const q = <T extends Element>(rolle: string): T => {
    const el = root.querySelector<T>(`[data-role="${rolle}"]`);
    if (!el) throw new Error(`Kuro OS: ${rolle} fehlt.`);
    return el;
  };
  const os = root.querySelector<HTMLElement>(".o-os") as HTMLElement;
  const buehne = q<HTMLElement>("buehne");
  const band = q<HTMLElement>("band");
  const raeumeEl = q<HTMLElement>("raeume");
  const strich = q<HTMLElement>("strich");
  const blatt = q<HTMLElement>("blatt");
  const blattInhalt = q<HTMLElement>("blattinhalt");
  const blattTeile = q<HTMLElement>("blattteile");
  const starter = q<HTMLElement>("starter");
  const starterFeld = q<HTMLInputElement>("starterfeld");
  const starterListe = q<HTMLElement>("starterliste");
  const gespraechEl = q<HTMLElement>("gespraech");
  const raumEl = (r: Raum) => band.querySelector(`.o-raum[data-raum="${r}"]`) as HTMLElement;
  const platz = (r: Raum, p: keyof Plaetze | "buehne") =>
    raumEl(r).querySelector(`[data-platz="${p}"]`) as HTMLElement;

  // ------------------------------------------------------------- Uhr, Woche
  const uhrEl = q<HTMLElement>("uhr");
  const tick = () => {
    const d = new Date();
    uhrEl.textContent = d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
    uhrEl.title = d.toLocaleDateString("de-DE", { dateStyle: "full" });
  };
  tick();
  globalThis.setInterval(tick, 10_000);

  const wocheEl = q<HTMLButtonElement>("woche");
  const ladeAbo = async () => {
    try {
      const a = await api.get<{
        verfuegbar: boolean;
        fenster?: Array<{ id: string; prozent: number }>;
      }>("/integrations/abo");
      const s = a.fenster?.find((f) => f.id === "sitzung");
      const w = a.fenster?.find((f) => f.id === "woche");
      if (!a.verfuegbar || !w) {
        wocheEl.hidden = true;
        return;
      }
      const p = Math.round(w.prozent);
      wocheEl.hidden = false;
      wocheEl.innerHTML = `<span class="o-woche__balken" aria-hidden="true"><i style="width:${Math.min(100, p)}%"></i></span>Woche ${p} %`;
      wocheEl.title = `Abo: Woche ${p} %${s ? `, Sitzung ${Math.round(s.prozent)} %` : ""} — öffnet System`;
      wocheEl.classList.toggle("ist-knapp", w.prozent >= 80 || (s?.prozent ?? 0) >= 80);
    } catch {
      wocheEl.hidden = true;
    }
  };
  void ladeAbo();
  globalThis.setInterval(() => void ladeAbo(), 120_000);
  wocheEl.addEventListener("click", () => oeffneBlatt("system"));

  // ------------------------------------------------------------- Helligkeit
  const helligkeit = steuereHelligkeit(loadSettings().appearance.helligkeit, () => {
    // Der Chart liest seine Farben beim Aufbau; der offene Teil kommt frisch.
    if (aktiv && aktiv.teil !== "brain") {
      const t = aktiv.teil;
      baueAb(aktiv);
      aktiv = null;
      zeigeTeil({ raum: ort.raum, teil: t, notiz: null }, ort, false);
    }
  });
  const settingsAbo = settingsBus.subscribe((s) => helligkeit.setze(s.appearance.helligkeit));

  // ------------------------------------------------------------ Ansichten
  function ctxFuer(section?: SettingsSectionId, plaetze?: Plaetze): ViewContext {
    return {
      api,
      bus: opt.bus,
      mic: opt.mic,
      navigate(route: RouteId, sec?: SettingsSectionId) {
        const ziel = ortFuerRoute(route);
        if (ziel === "blatt-system") oeffneBlatt("system");
        else if (ziel === "blatt-einstellungen") oeffneBlatt("einstellungen", sec);
        else if (ziel) geheZu(ziel);
        else globalThis.location.href = `/welle/#/${route}`;
      },
      toggleFocus() {},
      ...(section ? { section } : {}),
      ...(plaetze ? { plaetze } : {}),
      voice: opt.voice,
    };
  }

  // ------------------------------------------------------------ Band, Räume
  interface Gemountet {
    raum: Raum;
    teil: Teil;
    el: HTMLElement;
    loesen: () => void;
  }
  let ort: Ort = { raum: "kuro", teil: null, notiz: null };
  let aktiv: Gemountet | null = null;
  /** Teile, die nach einer Fahrt abgebaut werden, sobald die Kamera steht. */
  const gehend = new Set<Gemountet>();
  // Das Brain bleibt nach dem ersten Öffnen stehen: offene Notiz, Verlauf und Graph überdauern
  // den Raumwechsel. Die übrigen Ansichten laden beim Öffnen frisch, wie in der Welle.
  let brain: { el: HTMLElement; app: BrainApp } | null = null;
  let fahrtAnim: Animation | null = null;
  /** Der erste Ort kommt ohne Fahrt — die Seite öffnet dort, wo sie war. */
  let gestartet = false;

  const plaetzeVon = (r: Raum): Plaetze => ({
    seite: platz(r, "seite"),
    spalte: platz(r, "spalte"),
    reiter: platz(r, "reiter"),
  });

  /** Ob die Ansicht Seite, Reiter oder Spalte belegt — sonst nehmen die Plätze keinen Raum ein. */
  const belegt = (r: Raum) => {
    if (r === "kuro") return;
    const el = raumEl(r);
    el.classList.toggle("hat-spalte", platz(r, "spalte").childElementCount > 0);
    el.classList.toggle("hat-reiter", platz(r, "reiter").childElementCount > 0);
  };

  const baueAb = (g: Gemountet) => {
    if (g.teil === "brain") {
      g.el.hidden = true;
      return;
    }
    g.loesen();
    g.el.remove();
    // Was die Ansicht in Seite, Reiter und Spalte gehängt hat, geht mit ihr.
    if (aktiv?.raum !== g.raum) {
      for (const p of Object.values(plaetzeVon(g.raum))) p.replaceChildren();
    }
    belegt(g.raum);
  };

  const masse = () => ({ breite: buehne.clientWidth, hoehe: buehne.clientHeight });
  const index = (r: Raum) => RAEUME.indexOf(r);

  /** Legt die Räume aufs Band; nach jeder Größenänderung neu, ohne Bewegung. */
  const legeBand = () => {
    const b = masse();
    band.style.setProperty("--b-breite", `${b.breite}px`);
    band.style.setProperty("--b-hoehe", `${b.hoehe}px`);
    band.style.setProperty("--b-spalt", `${spalt(b)}px`);
    if (!fahrtAnim) band.style.transform = transform(lage(index(ort.raum), b));
  };
  new ResizeObserver(legeBand).observe(buehne);

  const setzeStrich = () => {
    const a = raeumeEl.querySelector<HTMLElement>(`[data-raum="${ort.raum}"]`);
    if (!a) return;
    strich.style.transform = `translateX(${a.offsetLeft + 12}px)`;
    strich.style.width = `${Math.max(0, a.offsetWidth - 24)}px`;
  };

  const zeichneLeiste = () => {
    os.dataset.raum = ort.raum;
    for (const a of raeumeEl.querySelectorAll<HTMLElement>("[data-raum]")) {
      const hier = a.dataset.raum === ort.raum;
      a.classList.toggle("ist-hier", hier);
      if (hier) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
    for (const r of RAEUME) raumEl(r).classList.toggle("ist-hier", r === ort.raum);
    if (ort.raum !== "kuro") {
      for (const a of raumEl(ort.raum).querySelectorAll<HTMLElement>("[data-teil]")) {
        const hier = a.dataset.teil === ort.teil;
        a.classList.toggle("ist-hier", hier);
        if (hier) a.setAttribute("aria-current", "page");
        else a.removeAttribute("aria-current");
      }
    }
    setzeStrich();
  };

  function zeigeTeil(ziel: Ort, vorher: Ort, gleiten = true) {
    const teil = ziel.teil as Teil;
    const raum = ziel.raum;
    if (aktiv?.teil === teil) {
      if (teil === "brain" && ziel.notiz) brain?.app.oeffne(ziel.notiz);
      return;
    }
    const flaeche = platz(raum, "buehne");
    const r = richtung(vorher, ziel);
    // Im selben Raum gleitet der neue Teil aus der Richtung herein; nach einer Fahrt nicht.
    const imRaum = gleiten && vorher.raum === raum && aktiv !== null;
    const kommend = (el: HTMLElement) => {
      el.style.setProperty("--versatz", `${12 * r}px`);
      el.classList.add("ist-kommend");
    };
    // Die Plätze gehören dem neuen Teil; der alte räumt sie, bevor der neue hineinhängt.
    const alt = aktiv;
    if (alt && alt.raum === raum && alt.teil !== "brain") {
      for (const p of Object.values(plaetzeVon(raum))) p.replaceChildren();
    }
    let neu: Gemountet;
    let bereit: Promise<void> = Promise.resolve();
    if (teil === "brain") {
      if (brain) {
        kommend(brain.el);
        if (ziel.notiz) brain.app.oeffne(ziel.notiz);
      } else {
        const el = document.createElement("div");
        el.className = "o-teil-flaeche o-teil-flaeche--brain";
        kommend(el);
        flaeche.append(el);
        const verfolgt = verfolge(api);
        brain = {
          el,
          app: mountBrainApp(el, verfolgt.api, ziel.notiz, opt.toast, plaetzeVon("brain")),
        };
        bereit = verfolgt.bereit();
      }
      brain.el.hidden = false;
      neu = { raum, teil, el: brain.el, loesen: () => {} };
    } else {
      const el = document.createElement("div");
      el.className = `o-teil-flaeche w-raum o-teil-flaeche--${teil}`;
      kommend(el);
      const innen = document.createElement("div");
      el.append(innen);
      flaeche.append(el);
      const verfolgt = verfolge(api);
      neu = {
        raum,
        teil,
        el,
        loesen: ANSICHT[teil].mount(innen, {
          ...ctxFuer(undefined, plaetzeVon(raum)),
          api: verfolgt.api,
        }),
      };
      bereit = verfolgt.bereit();
    }
    aktiv = neu;
    belegt(raum);
    let ausgeblendet: Promise<void> = Promise.resolve();
    if (alt && imRaum) {
      alt.el.style.setProperty("--versatz", `${-12 * r}px`);
      alt.el.classList.add("ist-gehend");
      globalThis.setTimeout(() => {
        alt.el.classList.remove("ist-gehend");
        if (aktiv?.el !== alt.el) baueAb(alt);
      }, UEBERGANG_MS);
      ausgeblendet = new Promise((los) => globalThis.setTimeout(los, 120));
    } else if (alt) {
      // Ein anderer Raum: der alte Teil bleibt sichtbar, bis die Kamera ihn verlassen hat.
      if (fahrtAnim) gehend.add(alt);
      else baueAb(alt);
    }
    void Promise.all([bereit, ausgeblendet]).then(() => {
      if (aktiv?.el !== neu.el) return;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => neu.el.classList.remove("ist-kommend")),
      );
    });
  }

  const raeumeAuf = () => {
    for (const g of gehend) if (g !== aktiv) baueAb(g);
    gehend.clear();
  };

  function fahre(von: Raum, nach: Raum) {
    const b = masse();
    const ziel = lage(index(nach), b);
    let start: Lage = lage(index(von), b);
    if (fahrtAnim) {
      start = ausMatrix(getComputedStyle(band).transform) ?? start;
      fahrtAnim.cancel();
      fahrtAnim = null;
    }
    band.style.transform = transform(ziel);
    if (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches || b.breite === 0) {
      os.classList.remove("ist-unterwegs");
      raeumeAuf();
      return;
    }
    beschrifteBand(nach);
    os.classList.add("ist-unterwegs");
    const anim = band.animate(fahrt(start, index(nach), b, index(von)), {
      duration: dauer(index(von), index(nach)),
    });
    fahrtAnim = anim;
    anim.onfinish = () => {
      if (fahrtAnim !== anim) return;
      fahrtAnim = null;
      os.classList.remove("ist-unterwegs");
      raeumeAuf();
    };
  }

  function geheZu(ziel: Ort, verlauf: "push" | "replace" = "push") {
    schliesseStarter();
    schliesseBlatt();
    const vorher = ort;
    ort = ziel;
    if (ziel.teil) {
      gemerkt = { ...gemerkt, [ziel.raum]: ziel.teil };
      merke(SPEICHER_TEILE, JSON.stringify(gemerkt));
    }
    const adresse = schreibeOrt(ziel);
    if (globalThis.location.hash !== adresse) {
      if (verlauf === "push") globalThis.history.pushState(null, "", adresse);
      else globalThis.history.replaceState(null, "", adresse);
    }
    zeichneLeiste();
    if (ziel.raum !== vorher.raum) {
      if (gestartet) fahre(vorher.raum, ziel.raum);
      else legeBand();
    }
    if (ziel.raum === "kuro") {
      schliesseGespraech();
      if (aktiv) {
        if (fahrtAnim) gehend.add(aktiv);
        else baueAb(aktiv);
        aktiv = null;
      }
      kuroRaum.auffrischen();
      return;
    }
    zeigeTeil(ziel, vorher);
  }

  const zuRaum = (r: Raum) => geheZu(liesOrt(`#/${r}`, gemerkt));

  // Räume und Teile sind Verweise; gegangen wird hier, damit der Verlauf nur einen Schritt kennt.
  const beiVerweis = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a[href^='#/']");
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    geheZu(liesOrt(a.getAttribute("href") ?? "", gemerkt));
  };
  raeumeEl.addEventListener("click", beiVerweis);
  band.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".o-teile")) beiVerweis(e);
  });
  gespraechEl.addEventListener("click", beiVerweis);
  q<HTMLButtonElement>("marke").addEventListener("click", () => zuRaum("kuro"));
  globalThis.addEventListener("hashchange", () =>
    geheZu(liesOrt(globalThis.location.hash, gemerkt), "replace"),
  );

  // Zwei Finger waagrecht: ein Raum weiter. Nicht dort, wo die Fläche selbst waagrecht rollt.
  const wisch = wischer();
  const rolltSelbst = (start: EventTarget | null): boolean => {
    for (let el = start as HTMLElement | null; el && el !== buehne; el = el.parentElement) {
      if (el.matches("canvas, .markt__leinwand, [data-wischen='nein']")) return true;
      if (el.scrollWidth > el.clientWidth + 1) {
        const x = getComputedStyle(el).overflowX;
        if (x === "auto" || x === "scroll") return true;
      }
    }
    return false;
  };
  buehne.addEventListener(
    "wheel",
    (e) => {
      if (e.ctrlKey || rolltSelbst(e.target)) return;
      const r = wisch.rad(e.deltaX, e.deltaY, e.timeStamp);
      if (r === 0) return;
      const neu = RAEUME[index(ort.raum) + r];
      if (neu) zuRaum(neu);
    },
    { passive: true },
  );

  // Die Namen unter den Räumen, solange die Kamera zurückgezogen ist.
  let unterGeladen = 0;
  const unter: Partial<Record<Raum, string>> = {};
  const beschrifteBand = (nach: Raum) => {
    for (const r of RAEUME) {
      raumEl(r).classList.toggle("ist-ziel", r === nach);
      const el = q<HTMLElement>(`unter-${r}`);
      el.textContent = r === nach ? (unter[r] ?? "") : "";
    }
    if (Date.now() - unterGeladen > 120_000) {
      void ladeUnter().then(() => {
        if (fahrtAnim) q<HTMLElement>(`unter-${nach}`).textContent = unter[nach] ?? "";
      });
    }
  };
  async function ladeUnter() {
    unterGeladen = Date.now();
    unter.kuro = ZUSTAND_SATZ[gespraech.zustand];
    const n = kuroRaum.ungelesen;
    if (n !== null) unter.post = n === 0 ? "Nichts Ungelesenes" : `${n} ungelesen`;
    const erstes = loadWatchlist()[0];
    const aufgaben: Promise<void>[] = [];
    if (erstes) {
      aufgaben.push(
        api
          .get<MarketQuotesData>(
            `/integrations/markets/quotes?symbols=${encodeURIComponent(erstes)}`,
          )
          .then((d) => {
            const k = d.quotes[0];
            if (k) unter.handel = `${anzeigeName(k.symbol, k.name)} ${formatPercent(k.changePct)}`;
          })
          .catch(() => {}),
      );
    }
    aufgaben.push(
      api
        .get<{ knoten: unknown[] }>("/integrations/brain/graph")
        .then((g) => {
          unter.brain = `${g.knoten.length.toLocaleString("de-DE")} Notizen`;
        })
        .catch(() => {}),
    );
    await Promise.all(aufgaben);
  }

  // --------------------------------------------------------------- Blatt
  let blattTeil: BlattTeil | null = null;
  let blattLoesen: (() => void) | null = null;
  let blattUhr: ReturnType<typeof setTimeout> | null = null;

  function oeffneBlatt(teil: BlattTeil, section?: SettingsSectionId) {
    schliesseStarter();
    schliesseGespraech();
    if (blattUhr) globalThis.clearTimeout(blattUhr);
    blattUhr = null;
    blattLoesen?.();
    const innen = document.createElement("div");
    blattInhalt.replaceChildren(innen);
    blattInhalt.scrollTop = 0;
    blattLoesen = (teil === "system" ? systemView : settingsView).mount(
      innen,
      ctxFuer(teil === "einstellungen" ? section : undefined),
    );
    blattTeil = teil;
    for (const a of blattTeile.querySelectorAll<HTMLElement>("[data-blatt]")) {
      a.classList.toggle("ist-hier", a.dataset.blatt === teil);
    }
    if (blatt.hidden) {
      blatt.hidden = false;
      requestAnimationFrame(() => requestAnimationFrame(() => blatt.classList.add("ist-offen")));
    }
  }

  function schliesseBlatt() {
    if (blattTeil === null) return;
    blattTeil = null;
    blatt.classList.remove("ist-offen");
    blattUhr = globalThis.setTimeout(() => {
      blattUhr = null;
      blatt.hidden = true;
      blattLoesen?.();
      blattLoesen = null;
      blattInhalt.replaceChildren();
    }, 240);
  }

  blattTeile.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>("[data-blatt]");
    if (!a) return;
    e.preventDefault();
    oeffneBlatt(a.dataset.blatt as BlattTeil);
  });
  q<HTMLButtonElement>("blattzu").addEventListener("click", schliesseBlatt);
  q<HTMLElement>("blattgrund").addEventListener("click", schliesseBlatt);
  q<HTMLButtonElement>("haus").addEventListener("click", () =>
    blattTeil ? schliesseBlatt() : oeffneBlatt("system"),
  );

  // ------------------------------------------------------------- Raum Kuro
  const kuroRaum = mountKuroRaum(q<HTMLElement>("raum-kuro"), {
    api,
    gespraech,
    voice: opt.voice,
    motto: MOTTO,
    toast: opt.toast,
    oeffne: (ziel) => {
      if (ziel === "system") oeffneBlatt("system");
      else geheZu({ raum: "post", teil: ziel, notiz: null });
    },
  });

  // ------------------------------------------- Der kleine Kuro und seine Zeile
  const figurKnopf = q<HTMLButtonElement>("figur");
  const figur = mountFigur(figurKnopf);
  for (const [wer] of gespraech.arbeit) figur.bediensteterBeginnt(werName(wer));
  const zeileKnopf = q<HTMLButtonElement>("zeile");
  const zeileText = q<HTMLElement>("zeiletext");
  const zeileZeit = q<HTMLElement>("zeilezeit");
  const satzEl = q<HTMLElement>("satz");
  let zustandSeit = Date.now();
  let letzterZustand: Zustand = gespraech.zustand;
  let antwort: { text: string; bis: number } | null = null;

  const zeichneZeile = () => {
    const jetzt = Date.now();
    const z = kuroZeile(gespraech.zustand, gespraech.detail, gespraech.arbeit, zustandSeit);
    if (antwort && antwort.bis < jetzt) antwort = null;
    if (z) {
      zeileText.textContent = z.text;
      zeileZeit.textContent = uhrDauer(jetzt - z.seit);
      zeileZeit.hidden = false;
    } else if (antwort) {
      zeileText.textContent = antwort.text;
      zeileZeit.hidden = true;
    }
    const zeigen = z !== null || antwort !== null;
    zeileKnopf.hidden = !zeigen;
    os.classList.toggle("kuro-arbeitet", z !== null);
  };
  const zeigeZustand = () => {
    const z = gespraech.zustand;
    if (z !== letzterZustand) {
      letzterZustand = z;
      zustandSeit = Date.now();
    }
    os.dataset.kuro = z;
    os.style.setProperty("--kuro-licht", ZUSTAND_FARBE[z]);
    figur.setzeZustand(z);
    satzEl.textContent =
      kuroZeile(z, gespraech.detail, gespraech.arbeit, zustandSeit)?.text ?? ZUSTAND_SATZ[z];
    zeichneZeile();
  };
  zeigeZustand();
  globalThis.setInterval(zeichneZeile, 1000);

  let letzteGezeigt = V.letzteAntwort(gespraech.verlauf)?.id ?? null;
  const abo = gespraech.abonniere((s) => {
    if (s.art === "zustand" || s.art === "arbeit") zeigeZustand();
    else if (s.art === "bediensteter") {
      if (s.was === "beginnt") figur.bediensteterBeginnt(werName(s.wer));
      else if (s.was === "fertig") figur.bediensteterFertig(werName(s.wer));
      zeigeZustand();
    } else if (s.art === "fertig") {
      const letzte = V.letzteAntwort(gespraech.verlauf);
      if (!letzte || letzte.id === letzteGezeigt) return;
      letzteGezeigt = letzte.id;
      if (ort.raum !== "kuro" && gespraechEl.hidden) {
        os.classList.add("hat-neues");
        antwort = {
          text: ersteZeile(letzte.text) || "Kuro hat geantwortet",
          bis: Date.now() + ANTWORT_STEHT_MS,
        };
        zeichneZeile();
      }
      meldeNachDraussen(letzte.text);
    }
  });

  function ersteZeile(text: string): string {
    const z = text
      .replace(/[#*_`>]/g, "")
      .split("\n")
      .find((t) => t.trim())
      ?.trim();
    return z ? (z.length > 90 ? `${z.slice(0, 88)} …` : z) : "";
  }

  // ------------------------------------------------- Das Gespräch auf Abruf
  const form = gespraechEl.querySelector('[data-role="form"]') as HTMLFormElement;
  const feld = verdrahteEingabe(form, opt);
  const eingabeLoesen = kuroRaum.sphaere.bindeEingabe(feld);
  const fadenEl = q<HTMLElement>("faden");
  const leerEl = q<HTMLElement>("leer");
  const fadenLoesen = mountFaden(fadenEl, {
    api,
    gespraech,
    beiLeere: (leer) => {
      leerEl.hidden = !leer;
    },
  });

  function oeffneGespraech(fokus = true) {
    if (ort.raum === "kuro") {
      kuroRaum.feld.focus({ preventScroll: true });
      return;
    }
    schliesseStarter();
    antwort = null;
    os.classList.remove("hat-neues");
    zeichneZeile();
    if (gespraechEl.hidden) {
      gespraechEl.hidden = false;
      gespraechEl.classList.add("ist-kommend");
      requestAnimationFrame(() =>
        requestAnimationFrame(() => gespraechEl.classList.remove("ist-kommend")),
      );
      fadenEl.scrollTop = fadenEl.scrollHeight;
    }
    if (fokus) feld.focus({ preventScroll: true });
  }
  function schliesseGespraech() {
    gespraechEl.hidden = true;
  }
  const umschalten = () => (gespraechEl.hidden ? oeffneGespraech() : schliesseGespraech());
  figurKnopf.addEventListener("click", umschalten);
  zeileKnopf.addEventListener("click", () => oeffneGespraech());
  document.addEventListener("pointerdown", (e) => {
    if (gespraechEl.hidden) return;
    const t = e.target as HTMLElement;
    if (t.closest(".o-gespraech, .o-kuro")) return;
    schliesseGespraech();
  });

  globalThis.addEventListener("kuro:sprechtaste", ((e: CustomEvent<{ an?: boolean }>) => {
    if (e.detail?.an && ort.raum !== "kuro") oeffneGespraech(false);
  }) as EventListener);
  globalThis.addEventListener("kuro:insel", () => oeffneGespraech(true));

  function meldeNachDraussen(text: string) {
    if (document.hasFocus() || typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    const zeile = ersteZeile(text);
    if (!zeile) return;
    const n = new Notification("Kuro", { body: zeile.slice(0, 180), silent: true });
    n.onclick = () => {
      globalThis.focus();
      oeffneGespraech(false);
    };
  }

  // -------------------------------------------------------------- Suchen
  type Treffer = {
    art: "raum" | "notiz" | "kuro" | "tat";
    text: string;
    neben: string;
    tun: () => void;
  };
  let notizen: Array<{ pfad: string; titel: string }> = [];
  let treffer: Treffer[] = [];
  let auswahl = 0;

  const ORTE: Array<{ text: string; neben: string; such: string; tun: () => void }> = [
    ...RAEUME.map((r, i) => ({
      text: RAUM_NAME[r],
      neben: `${BEFEHL}${i + 1}`,
      such: `${RAUM_NAME[r]} ${STICHWORTE[r] ?? ""}`,
      tun: () => zuRaum(r),
    })),
    ...RAEUME.flatMap((r) =>
      (TEILE[r] as readonly Teil[])
        .filter((t) => TEIL_NAME[t] !== RAUM_NAME[r])
        .map((t) => ({
          text: TEIL_NAME[t],
          neben: RAUM_NAME[r],
          such: `${TEIL_NAME[t]} ${STICHWORTE[t] ?? ""}`,
          tun: () => geheZu({ raum: r, teil: t, notiz: null }),
        })),
    ),
    {
      text: "System",
      neben: "Blatt",
      such: "system abo token nachtbau",
      tun: () => oeffneBlatt("system"),
    },
    {
      text: "Einstellungen",
      neben: `${BEFEHL},`,
      such: "einstellungen schlüssel sprache hell dunkel helligkeit",
      tun: () => oeffneBlatt("einstellungen"),
    },
  ];
  const TATEN: Array<{ text: string; tun: () => void }> = [
    {
      text: "Graph des Brain",
      tun: () => {
        geheZu({ raum: "brain", teil: "brain", notiz: null });
        brain?.app.graph();
      },
    },
    { text: "Gespräch mit Kuro öffnen", tun: () => oeffneGespraech() },
    { text: "Gesprächsansicht leeren (Kuro erinnert sich weiter)", tun: () => gespraech.leere() },
  ];

  const zeichneStarter = () => {
    const text = starterFeld.value.trim();
    const klein = text.toLowerCase();
    const orte = ORTE.filter((o) => !klein || o.such.toLowerCase().includes(klein)).map<Treffer>(
      (o) => ({ art: "raum", text: o.text, neben: o.neben, tun: o.tun }),
    );
    const taten = TATEN.filter((t) => !klein || t.text.toLowerCase().includes(klein)).map<Treffer>(
      (t) => ({ art: "tat", text: t.text, neben: "Befehl", tun: t.tun }),
    );
    const notizTreffer =
      klein.length >= 2
        ? notizen
            .filter(
              (n) => n.titel.toLowerCase().includes(klein) || n.pfad.toLowerCase().includes(klein),
            )
            .slice(0, 7)
            .map<Treffer>((n) => ({
              art: "notiz",
              text: n.titel,
              neben: n.pfad.split("/").slice(0, -1).join(" / ") || "Brain",
              tun: () => geheZu({ raum: "brain", teil: "brain", notiz: n.pfad }),
            }))
        : [];
    const frage: Treffer[] =
      text.length > 0
        ? [
            {
              art: "kuro",
              text: `Kuro fragen: ${text}`,
              neben: "Enter",
              tun: () => {
                void gespraech.sende(text);
                oeffneGespraech(false);
              },
            },
          ]
        : [];
    treffer = klein ? [...orte, ...notizTreffer, ...taten, ...frage] : [...orte, ...taten];
    auswahl = Math.min(auswahl, Math.max(0, treffer.length - 1));
    starterListe.innerHTML = treffer
      .map(
        (t, i) =>
          `<li role="option" class="o-starter__treffer o-starter__treffer--${t.art}${i === auswahl ? " ist-gewaehlt" : ""}" data-i="${i}" aria-selected="${i === auswahl}"><span>${escapeHtml(t.text)}</span><small>${escapeHtml(t.neben)}</small></li>`,
      )
      .join("");
    starterListe
      .querySelector(".ist-gewaehlt")
      ?.scrollIntoView({ block: "nearest", behavior: "instant" });
  };

  function oeffneStarter() {
    schliesseGespraech();
    starter.hidden = false;
    starterFeld.value = "";
    auswahl = 0;
    zeichneStarter();
    starterFeld.focus();
    void api
      .get<{ knoten: Array<{ pfad: string; titel: string }> }>("/integrations/brain/graph")
      .then((g) => {
        notizen = g.knoten;
        if (!starter.hidden) zeichneStarter();
      })
      .catch(() => {});
  }
  function schliesseStarter() {
    starter.hidden = true;
  }
  starterFeld.addEventListener("input", () => {
    auswahl = 0;
    zeichneStarter();
  });
  starterFeld.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      auswahl =
        (auswahl + (e.key === "ArrowDown" ? 1 : -1) + treffer.length) % Math.max(1, treffer.length);
      zeichneStarter();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const t = treffer[auswahl];
      schliesseStarter();
      t?.tun();
    }
  });
  starterListe.addEventListener("click", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
    if (!li) return;
    const t = treffer[Number(li.dataset.i)];
    schliesseStarter();
    t?.tun();
  });
  starter.addEventListener("pointerdown", (e) => {
    if (e.target === starter) schliesseStarter();
  });
  q<HTMLButtonElement>("suche").addEventListener("click", oeffneStarter);

  // ------------------------------------------------------- Drag-and-drop
  const ablage = q<HTMLElement>("ablage");
  let ueber = 0;
  const hatDateien = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");
  document.addEventListener("dragenter", (e) => {
    if (!hatDateien(e)) return;
    ueber += 1;
    ablage.hidden = false;
    figur.hunger(true);
  });
  document.addEventListener("dragleave", (e) => {
    if (!hatDateien(e)) return;
    ueber = Math.max(0, ueber - 1);
    if (ueber === 0) {
      ablage.hidden = true;
      figur.hunger(false);
    }
  });
  document.addEventListener("dragover", (e) => {
    if (hatDateien(e)) e.preventDefault();
  });
  document.addEventListener("drop", (e) => {
    if (!hatDateien(e)) return;
    e.preventDefault();
    ueber = 0;
    ablage.hidden = true;
    void figur.schlucke();
    for (const datei of e.dataTransfer?.files ?? []) void lege(datei);
  });
  async function lege(datei: File) {
    if (datei.size > ABLAGE_HOECHSTENS) {
      opt.toast(`${datei.name} ist größer als 300 MB und bleibt draußen.`);
      return;
    }
    try {
      const r = await api.datei<{ pfad: string }>(
        `/integrations/brain/eingang/datei?name=${encodeURIComponent(datei.name)}`,
        datei,
      );
      opt.toast(`Im Brain abgelegt: ${r.pfad.replace(/\.md$/, "")}`);
      geheZu({ raum: "brain", teil: "brain", notiz: r.pfad });
    } catch (error) {
      opt.toast(error instanceof Error ? error.message : String(error));
    }
  }

  // -------------------------------------------------------------- Tasten
  const IST_FELD = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";
  globalThis.addEventListener("keydown", (e) => {
    const befehl = IST_MAC ? e.metaKey : e.ctrlKey;
    if (befehl && !e.altKey && !e.shiftKey) {
      const taste = e.key.toLowerCase();
      if (taste === "k") {
        e.preventDefault();
        if (starter.hidden) oeffneStarter();
        else schliesseStarter();
        return;
      }
      if (taste === "j") {
        e.preventDefault();
        if (ort.raum === "kuro") kuroRaum.feld.focus({ preventScroll: true });
        else umschalten();
        return;
      }
      if (e.key === ",") {
        e.preventDefault();
        if (blattTeil === "einstellungen") schliesseBlatt();
        else oeffneBlatt("einstellungen");
        return;
      }
      const raum = raumFuerTaste(e.key);
      if (raum) {
        e.preventDefault();
        if (raum !== ort.raum || blattTeil) zuRaum(raum);
        return;
      }
    }
    if (e.key !== "Escape" || e.defaultPrevented) return;
    // Esc geht eine Ebene zurück: Suche, Feld, Gespräch, Blatt.
    if (!starter.hidden) {
      schliesseStarter();
      return;
    }
    const fokus = document.activeElement;
    if (fokus instanceof HTMLElement && fokus !== document.body && fokus.matches(IST_FELD)) {
      fokus.blur();
      return;
    }
    if (!gespraechEl.hidden) {
      schliesseGespraech();
      return;
    }
    if (blattTeil) schliesseBlatt();
  });

  // --------------------------------------------------------------- Start
  geheZu(liesOrt(globalThis.location.hash, gemerkt), "replace");
  gestartet = true;
  // Die Zeilen unter den Räumen liegen bereit, bevor der erste Wechsel sie zeigt.
  globalThis.setTimeout(() => void ladeUnter(), 4000);
  // Die Schrift lädt nach; erst dann stimmt die Breite der Raumnamen für den Strich.
  void document.fonts?.ready.then(setzeStrich);

  globalThis.addEventListener("pagehide", () => {
    abo();
    settingsAbo();
    helligkeit.loesen();
    eingabeLoesen();
    fadenLoesen();
    figur.destroy();
    kuroRaum.loesen();
    if (aktiv) baueAb(aktiv);
    brain?.app.loesen();
    blattLoesen?.();
  });
}
