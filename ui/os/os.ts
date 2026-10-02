import type { ApiClient } from "../api/client.js";
import type { EventBusClient } from "../events/bus.js";
import { type IconName, icon } from "../icons.js";
import type { MicStateStore } from "../mic/state.js";
import { type Sphaere, mountSphaere } from "../praesenz/sphaere.js";
import type { RouteId, SettingsSectionId } from "../router/router.js";
import { settingsView } from "../settings/view.js";
import { analysenView } from "../views/analysen.js";
import { calendarView } from "../views/calendar.js";
import { escapeHtml } from "../views/html.js";
import { mailView } from "../views/mail.js";
import { strategienView } from "../views/strategien.js";
import { systemView } from "../views/system.js";
import { tradingView } from "../views/trading.js";
import type { View, ViewContext } from "../views/types.js";
import { mountFaden } from "../welle/faden.js";
import { werName } from "../welle/form.js";
import type { Gespraech } from "../welle/gespraech.js";
import * as V from "../welle/verlauf.js";
import { ZUSTAND_FARBE, ZUSTAND_SATZ } from "../welle/zustand.js";
import { type BrainApp, mountBrainApp } from "./brain.js";
import {
  type Andock,
  type Rechteck,
  andockRechteck,
  andockZone,
  begrenze,
  nebeneinander,
  staffel,
  zieheRand,
} from "./fenster-logik.js";

/**
 * Kuro OS (02.10., zweiter Wurf) — ein Desktop statt einer Seite. Jakob: „ich will, dass es sich
 * wirklich wie ein OS anfühlt und nicht wie eine billige Website."
 *
 * Oben die Menüleiste mit Kuros Insel in der Mitte (wo am MacBook die Notch sitzt), darunter
 * Kuros Raum als Hintergrund, Fenster, die man schiebt, an die Hälften andockt, minimiert und
 * nebeneinander legt, unten das Dock. ⌘K öffnet den Starter: Apps, Notizen, Fragen an Kuro.
 * Die Fachansichten sind dieselben wie in der Welle; jede läuft in ihrem eigenen Fenster.
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

type AppId =
  | "kuro"
  | "brain"
  | "maerkte"
  | "strategien"
  | "analysen"
  | "post"
  | "kalender"
  | "system"
  | "einstellungen";

interface AppDef {
  id: AppId;
  name: string;
  ikon: IconName | "kuro" | "brain" | "kalender";
  groesse: { b: number; h: number };
  view?: View;
  stichworte?: string;
}

const APPS: AppDef[] = [
  {
    id: "kuro",
    name: "Kuro",
    ikon: "kuro",
    groesse: { b: 520, h: 720 },
    stichworte: "gespräch butler",
  },
  {
    id: "brain",
    name: "Brain",
    ikon: "brain",
    groesse: { b: 1240, h: 780 },
    stichworte: "obsidian notizen graph",
  },
  {
    id: "maerkte",
    name: "Märkte",
    ikon: "trading",
    groesse: { b: 1320, h: 820 },
    view: tradingView,
    stichworte: "chart kurse trading",
  },
  {
    id: "strategien",
    name: "Strategien",
    ikon: "strategien",
    groesse: { b: 1180, h: 780 },
    view: strategienView,
    stichworte: "backtest",
  },
  {
    id: "analysen",
    name: "Analysen",
    ikon: "analysen",
    groesse: { b: 1060, h: 760 },
    view: analysenView,
    stichworte: "berichte",
  },
  {
    id: "post",
    name: "Post",
    ikon: "mail",
    groesse: { b: 980, h: 720 },
    view: mailView,
    stichworte: "mail e-mail",
  },
  {
    id: "kalender",
    name: "Kalender",
    ikon: "kalender",
    groesse: { b: 760, h: 640 },
    view: calendarView,
    stichworte: "termine planung",
  },
  {
    id: "system",
    name: "System",
    ikon: "system",
    groesse: { b: 1120, h: 800 },
    view: systemView,
    stichworte: "abo token nachtbau",
  },
  {
    id: "einstellungen",
    name: "Einstellungen",
    ikon: "settings",
    groesse: { b: 1000, h: 720 },
    view: settingsView,
  },
];

const APP = new Map(APPS.map((a) => [a.id, a]));

const IST_MAC = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? "");
const BEFEHL = IST_MAC ? "⌘" : "Strg+";
const SPEICHER = "kuronami.os.fenster.v2";
const MENUE_H = 32;
const DOCK_H = 86;

const BRAIN_GLYPHE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="7" r="2.2"/><circle cx="17.5" cy="5.5" r="1.8"/><circle cx="12.5" cy="13" r="2.6"/><circle cx="5.5" cy="18" r="1.7"/><circle cx="18.5" cy="17.5" r="2"/><path d="M8 8.2l2.6 3M16.4 7l-2.6 3.8M10.3 14.6l-3.4 2.4M14.9 14.5l2.2 1.8"/></svg>`;

function glyphe(a: AppDef): string {
  if (a.ikon === "kuro") return `<span class="d-kugel" aria-hidden="true"></span>`;
  if (a.ikon === "brain") return BRAIN_GLYPHE;
  if (a.ikon === "kalender") {
    const d = new Date();
    return `<span class="d-datum" aria-hidden="true"><small>${d.toLocaleDateString("de-DE", { weekday: "short" }).replace(".", "")}</small><b>${d.getDate()}</b></span>`;
  }
  return icon(a.ikon);
}

const SENDEN = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg>`;

interface Fenster {
  app: AppDef;
  el: HTMLElement;
  r: Rechteck;
  vorher: Rechteck | null;
  andock: Andock;
  min: boolean;
  aufraeumen: () => void;
  brain?: BrainApp;
}

interface Gespeichert {
  app: AppId;
  r: Rechteck;
  andock: Andock;
  min: boolean;
}

export function mountOs(opt: OsOptionen): void {
  const { root, api, gespraech } = opt;

  root.innerHTML = `
    <div class="o-os" data-kuro="ruhe">
      <div class="o-hintergrund" aria-hidden="true"></div>
      <header class="o-menue">
        <div class="o-menue__links">
          <button type="button" class="o-marke" data-role="marke" title="Starter (${BEFEHL}K)">黒波</button>
          <span class="o-menue__app" data-role="appname">Kuro OS</span>
        </div>
        <div class="o-insel" data-role="insel">
          <button type="button" class="o-insel__griff" data-role="griff" aria-expanded="false" aria-controls="o-insel-blatt" title="Mit Kuro sprechen">
            <span class="o-insel__licht" aria-hidden="true"></span>
            <span class="o-insel__satz" data-role="satz">Kuro ist da</span>
          </button>
          <div class="o-insel__blatt" id="o-insel-blatt" data-role="blatt" hidden>
            <div class="o-insel__faden" data-role="inselfaden"></div>
            <form class="o-eingabe" data-role="inselform">
              <textarea rows="1" name="text" placeholder="Kuro fragen" aria-label="Nachricht an Kuro"></textarea>
              <button type="button" class="o-eingabe__mikro" data-role="mikro" aria-label="Mikrofon an oder aus">${icon("mic")}</button>
              <button type="submit" class="o-eingabe__senden" aria-label="Senden">${SENDEN}</button>
            </form>
          </div>
        </div>
        <div class="o-menue__rechts">
          <button type="button" class="o-abo" data-role="abo" title="Abo — öffnet System"></button>
          <time class="o-uhr" data-role="uhr"></time>
        </div>
      </header>
      <div class="o-schreibtisch" data-role="tisch"></div>
      <div class="o-andock" data-role="andock" hidden></div>
      <nav class="o-dock" data-role="dock" aria-label="Dock">
        ${APPS.map(
          (a, i) => `
          <button type="button" class="d-app" data-app="${a.id}" aria-label="${escapeHtml(a.name)}" title="${escapeHtml(a.name)}${i < 9 ? ` (${BEFEHL}${i + 1})` : ""}">
            <span class="d-kachel d-kachel--${a.id}">${glyphe(a)}</span>
            <span class="d-name">${escapeHtml(a.name)}</span>
            <span class="d-punkt" aria-hidden="true"></span>
          </button>`,
        ).join("")}
      </nav>
      <div class="o-starter" data-role="starter" hidden>
        <div class="o-starter__feld" role="dialog" aria-label="Starter">
          <input type="text" data-role="starterfeld" placeholder="App, Notiz oder Frage an Kuro" autocomplete="off" spellcheck="false" />
          <ol class="o-starter__liste" data-role="starterliste" role="listbox"></ol>
        </div>
      </div>
      <div class="o-kontext" data-role="kontext" hidden role="menu"></div>
    </div>`;

  const q = <T extends Element>(rolle: string): T => {
    const el = root.querySelector<T>(`[data-role="${rolle}"]`);
    if (!el) throw new Error(`Kuro OS: ${rolle} fehlt.`);
    return el;
  };
  const os = root.querySelector<HTMLElement>(".o-os") as HTMLElement;
  const tisch = q<HTMLElement>("tisch");
  const dock = q<HTMLElement>("dock");
  const andockEl = q<HTMLElement>("andock");
  const appname = q<HTMLElement>("appname");
  const insel = q<HTMLElement>("insel");
  const griff = q<HTMLButtonElement>("griff");
  const blatt = q<HTMLElement>("blatt");
  const satz = q<HTMLElement>("satz");
  const starter = q<HTMLElement>("starter");
  const starterFeld = q<HTMLInputElement>("starterfeld");
  const starterListe = q<HTMLElement>("starterliste");
  const kontext = q<HTMLElement>("kontext");

  // ---------------------------------------------------------------- Uhr und Abo
  const uhrEl = q<HTMLElement>("uhr");
  const tick = () => {
    const d = new Date();
    uhrEl.textContent = `${d.toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "short" })}  ${d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}`;
  };
  tick();
  globalThis.setInterval(tick, 10_000);
  const aboEl = q<HTMLButtonElement>("abo");
  const ladeAbo = async () => {
    try {
      const a = await api.get<{
        verfuegbar: boolean;
        fenster?: Array<{ id: string; prozent: number }>;
      }>("/integrations/abo");
      const s = a.fenster?.find((f) => f.id === "sitzung");
      const w = a.fenster?.find((f) => f.id === "woche");
      if (!a.verfuegbar || !s || !w) {
        aboEl.hidden = true;
        return;
      }
      aboEl.hidden = false;
      aboEl.innerHTML = `<span class="o-abo__balken"><i style="width:${Math.min(100, s.prozent)}%"></i></span>${Math.round(s.prozent)} %`;
      aboEl.title = `Abo: Sitzung ${Math.round(s.prozent)} %, Woche ${Math.round(w.prozent)} % — öffnet System`;
      aboEl.classList.toggle("ist-knapp", s.prozent >= 80);
    } catch {
      aboEl.hidden = true;
    }
  };
  void ladeAbo();
  globalThis.setInterval(() => void ladeAbo(), 120_000);
  aboEl.addEventListener("click", () => oeffneApp("system"));

  // ------------------------------------------------------------------ Fläche
  const flaeche = (): Rechteck => ({
    x: 0,
    y: MENUE_H,
    b: globalThis.innerWidth,
    h: globalThis.innerHeight - MENUE_H - DOCK_H,
  });
  const schmal = () => globalThis.innerWidth < 760;

  // ----------------------------------------------------------------- Fenster
  const fenster = new Map<AppId, Fenster>();
  let reihe: AppId[] = [];
  let vorn: AppId | null = null;

  const speichere = () => {
    try {
      const daten: Gespeichert[] = reihe
        .map((id) => fenster.get(id))
        .filter((f): f is Fenster => !!f)
        .map((f) => ({ app: f.app.id, r: f.r, andock: f.andock, min: f.min }));
      globalThis.localStorage?.setItem(SPEICHER, JSON.stringify(daten));
    } catch {
      // Ohne Seitenspeicher gilt die Anordnung nur bis zum Neuladen.
    }
  };

  const setzeLage = (f: Fenster) => {
    const r = schmal() ? flaeche() : f.r;
    f.el.style.left = `${r.x}px`;
    f.el.style.top = `${r.y}px`;
    f.el.style.width = `${r.b}px`;
    f.el.style.height = `${r.h}px`;
    f.el.style.setProperty("--f-hoehe", `${r.h - 38}px`);
    f.el.classList.toggle("ist-angedockt", f.andock !== null || schmal());
  };

  const ordne = () => {
    reihe.forEach((id, i) => {
      const f = fenster.get(id);
      if (f) f.el.style.zIndex = String(10 + i);
    });
    const oben = [...reihe].reverse().find((id) => !fenster.get(id)?.min) ?? null;
    vorn = oben;
    for (const [id, f] of fenster) f.el.classList.toggle("ist-vorn", id === oben);
    appname.textContent = oben ? (APP.get(oben)?.name ?? "Kuro OS") : "Kuro OS";
    for (const knopf of dock.querySelectorAll<HTMLElement>("[data-app]")) {
      const id = knopf.dataset.app as AppId;
      knopf.classList.toggle("ist-offen", fenster.has(id));
      knopf.classList.toggle("ist-vorn", id === oben);
    }
    speichere();
  };

  const nachVorn = (id: AppId) => {
    reihe = [...reihe.filter((x) => x !== id), id];
    ordne();
  };

  function ctxFuer(section?: SettingsSectionId): ViewContext {
    return {
      api,
      bus: opt.bus,
      mic: opt.mic,
      navigate(route: RouteId, sec?: SettingsSectionId) {
        const ziel: Partial<Record<RouteId, AppId>> = {
          trading: "maerkte",
          strategien: "strategien",
          analysen: "analysen",
          mail: "post",
          calendar: "kalender",
          system: "system",
          settings: "einstellungen",
          praesenz: "kuro",
        };
        const app = ziel[route];
        if (app) oeffneApp(app, sec);
        else globalThis.location.href = `/welle/#/${route}`;
      },
      toggleFocus() {},
      ...(section ? { section } : {}),
      voice: opt.voice,
    };
  }

  function erzeuge(app: AppDef, r: Rechteck, arg?: string): Fenster {
    const el = document.createElement("section");
    el.className = "f-fenster ist-neu";
    el.dataset.app = app.id;
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", app.name);
    el.innerHTML = `
      <header class="f-titel">
        <div class="f-knoepfe">
          <button type="button" class="f-knopf f-knopf--zu" data-tat="zu" aria-label="Schließen"></button>
          <button type="button" class="f-knopf f-knopf--min" data-tat="min" aria-label="Minimieren"></button>
          <button type="button" class="f-knopf f-knopf--max" data-tat="max" aria-label="Maximieren"></button>
        </div>
        <span class="f-name">${escapeHtml(app.name)}</span>
      </header>
      <div class="f-inhalt w-raum" data-role="inhalt"></div>
      ${["n", "s", "e", "w", "ne", "nw", "se", "sw"].map((rand) => `<div class="f-griff f-griff--${rand}" data-rand="${rand}"></div>`).join("")}`;
    tisch.append(el);
    const inhalt = el.querySelector<HTMLElement>('[data-role="inhalt"]') as HTMLElement;
    const f: Fenster = { app, el, r, vorher: null, andock: null, min: false, aufraeumen: () => {} };

    if (app.id === "kuro") f.aufraeumen = mountKuro(inhalt);
    else if (app.id === "brain") {
      const b = mountBrainApp(inhalt, api, arg ?? null, opt.toast);
      f.brain = b;
      f.aufraeumen = b.loesen;
    } else if (app.view) {
      const ort = document.createElement("div");
      inhalt.append(ort);
      f.aufraeumen = app.view.mount(
        ort,
        ctxFuer(app.id === "einstellungen" ? (arg as SettingsSectionId | undefined) : undefined),
      );
    }
    verdrahteFenster(f);
    setzeLage(f);
    globalThis.setTimeout(() => el.classList.remove("ist-neu"), 220);
    return f;
  }

  function oeffneApp(id: AppId, arg?: string) {
    schliesseStarter();
    const da = fenster.get(id);
    if (da) {
      if (da.min) zeigeWieder(da);
      if (id === "brain" && arg) da.brain?.oeffne(arg);
      nachVorn(id);
      return;
    }
    const app = APP.get(id);
    if (!app) return;
    const f = erzeuge(app, staffel(fenster.size, app.groesse, flaeche()), arg);
    fenster.set(id, f);
    nachVorn(id);
  }

  function schliesse(f: Fenster) {
    f.aufraeumen();
    f.el.classList.add("ist-weg");
    globalThis.setTimeout(() => f.el.remove(), 140);
    fenster.delete(f.app.id);
    reihe = reihe.filter((x) => x !== f.app.id);
    ordne();
  }

  function minimiere(f: Fenster) {
    const kachel = dock.querySelector<HTMLElement>(`[data-app="${f.app.id}"]`);
    const ziel = kachel?.getBoundingClientRect();
    const von = f.el.getBoundingClientRect();
    f.min = true;
    if (ziel && !globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      const dx = ziel.left + ziel.width / 2 - (von.left + von.width / 2);
      const dy = ziel.top + ziel.height / 2 - (von.top + von.height / 2);
      f.el
        .animate(
          [
            { transform: "none", opacity: 1 },
            { transform: `translate(${dx}px, ${dy}px) scale(0.08)`, opacity: 0.2 },
          ],
          { duration: 230, easing: "cubic-bezier(0.45, 0, 0.55, 1)" },
        )
        .finished.then(() => {
          if (f.min) f.el.hidden = true;
        });
    } else {
      f.el.hidden = true;
    }
    ordne();
  }

  function zeigeWieder(f: Fenster) {
    f.min = false;
    f.el.hidden = false;
    f.el.classList.add("ist-neu");
    globalThis.setTimeout(() => f.el.classList.remove("ist-neu"), 220);
  }

  function maximiere(f: Fenster) {
    if (f.andock === "voll") {
      f.r = f.vorher ?? staffel(0, f.app.groesse, flaeche());
      f.andock = null;
    } else {
      if (f.andock === null) f.vorher = f.r;
      f.r = andockRechteck("voll", flaeche());
      f.andock = "voll";
    }
    setzeLage(f);
    speichere();
  }

  function docke(f: Fenster, zone: Exclude<Andock, null>) {
    if (f.andock === null) f.vorher = f.r;
    f.r = andockRechteck(zone, flaeche());
    f.andock = zone;
    setzeLage(f);
    speichere();
  }

  function verdrahteFenster(f: Fenster) {
    const { el } = f;
    el.addEventListener("pointerdown", () => {
      if (vorn !== f.app.id) nachVorn(f.app.id);
    });
    el.querySelector(".f-knoepfe")?.addEventListener("click", (e) => {
      const tat = (e.target as HTMLElement).dataset.tat;
      if (tat === "zu") schliesse(f);
      else if (tat === "min") minimiere(f);
      else if (tat === "max") maximiere(f);
    });
    const titel = el.querySelector<HTMLElement>(".f-titel") as HTMLElement;
    titel.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).closest(".f-knoepfe")) return;
      maximiere(f);
    });

    // Verschieben an der Titelleiste, mit Andocken an den Rändern.
    titel.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).closest(".f-knoepfe") || e.button !== 0 || schmal()) return;
      e.preventDefault();
      const start = { x: e.clientX, y: e.clientY };
      let r0 = f.r;
      let losgeloest = f.andock === null;
      let zone: Andock = null;
      titel.setPointerCapture(e.pointerId);
      el.classList.add("ist-gezogen");
      const bewege = (ev: PointerEvent) => {
        const dx = ev.clientX - start.x;
        const dy = ev.clientY - start.y;
        if (!losgeloest) {
          if (Math.abs(dx) + Math.abs(dy) < 6) return;
          // Ein angedocktes Fenster nimmt beim Wegziehen seine alte Größe mit, unter dem Zeiger.
          const alt = f.vorher ?? f.app.groesse;
          const anteil = (start.x - f.r.x) / f.r.b;
          r0 = { x: start.x - alt.b * anteil, y: f.r.y, b: alt.b, h: alt.h };
          f.andock = null;
          losgeloest = true;
        }
        f.r = begrenze({ ...r0, x: r0.x + dx, y: r0.y + dy }, flaeche());
        setzeLage(f);
        zone = andockZone(ev.clientX, ev.clientY, flaeche());
        if (zone) {
          const z = andockRechteck(zone, flaeche());
          Object.assign(andockEl.style, {
            left: `${z.x}px`,
            top: `${z.y}px`,
            width: `${z.b}px`,
            height: `${z.h}px`,
          });
          andockEl.hidden = false;
        } else andockEl.hidden = true;
      };
      const ende = () => {
        titel.removeEventListener("pointermove", bewege);
        titel.removeEventListener("pointerup", ende);
        titel.removeEventListener("pointercancel", ende);
        el.classList.remove("ist-gezogen");
        andockEl.hidden = true;
        if (zone && losgeloest) docke(f, zone);
        else speichere();
      };
      titel.addEventListener("pointermove", bewege);
      titel.addEventListener("pointerup", ende);
      titel.addEventListener("pointercancel", ende);
    });

    // Größe an Rändern und Ecken.
    for (const g of el.querySelectorAll<HTMLElement>(".f-griff")) {
      g.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || schmal()) return;
        e.preventDefault();
        e.stopPropagation();
        const rand = g.dataset.rand ?? "se";
        const start = { x: e.clientX, y: e.clientY };
        const r0 = f.r;
        f.andock = null;
        g.setPointerCapture(e.pointerId);
        el.classList.add("ist-gezogen");
        const bewege = (ev: PointerEvent) => {
          f.r = zieheRand(r0, rand, ev.clientX - start.x, ev.clientY - start.y, flaeche());
          setzeLage(f);
        };
        const ende = () => {
          g.removeEventListener("pointermove", bewege);
          g.removeEventListener("pointerup", ende);
          el.classList.remove("ist-gezogen");
          speichere();
        };
        g.addEventListener("pointermove", bewege);
        g.addEventListener("pointerup", ende);
      });
    }
  }

  function minimiereAlle() {
    for (const f of fenster.values()) {
      if (!f.min) minimiere(f);
    }
  }

  function legeNebeneinander() {
    const offen = reihe.map((id) => fenster.get(id)).filter((f): f is Fenster => !!f && !f.min);
    nebeneinander(offen.length, flaeche()).forEach((r, i) => {
      const f = offen[i] as Fenster;
      f.vorher = f.r;
      f.r = r;
      f.andock = null;
      setzeLage(f);
    });
    speichere();
  }

  // ------------------------------------------------------------------- Dock
  dock.addEventListener("click", (e) => {
    const knopf = (e.target as HTMLElement).closest<HTMLElement>("[data-app]");
    if (!knopf) return;
    const id = knopf.dataset.app as AppId;
    const f = fenster.get(id);
    if (f && !f.min && vorn === id) minimiere(f);
    else oeffneApp(id);
  });

  // ------------------------------------------------------------------- Insel
  let inselOffen = false;
  let schliessUhr: ReturnType<typeof setTimeout> | null = null;
  const inselFaden = q<HTMLElement>("inselfaden");
  const inselLoesen = mountFaden(inselFaden, { api, gespraech });
  const inselForm = q<HTMLFormElement>("inselform");
  const inselFeld = inselForm.querySelector("textarea") as HTMLTextAreaElement;

  const oeffneInsel = (fokus: boolean) => {
    if (schliessUhr) globalThis.clearTimeout(schliessUhr);
    schliessUhr = null;
    inselOffen = true;
    blatt.hidden = false;
    insel.classList.add("ist-offen");
    griff.setAttribute("aria-expanded", "true");
    inselFaden.scrollTop = inselFaden.scrollHeight;
    if (fokus) inselFeld.focus();
  };
  const schliesseInsel = () => {
    inselOffen = false;
    blatt.hidden = true;
    insel.classList.remove("ist-offen");
    griff.setAttribute("aria-expanded", "false");
  };
  const zeigeKurz = () => {
    if (inselOffen && schliessUhr === null) return;
    oeffneInsel(false);
    schliessUhr = globalThis.setTimeout(() => {
      if (insel.matches(":hover") || insel.contains(document.activeElement)) return;
      schliesseInsel();
    }, 12_000);
  };
  griff.addEventListener("click", () => (inselOffen ? schliesseInsel() : oeffneInsel(true)));

  const sende = async (feld: HTMLTextAreaElement) => {
    const text = feld.value.trim();
    if (!text) return;
    feld.value = "";
    feld.style.height = "";
    try {
      await gespraech.sende(text);
    } catch (error) {
      opt.toast(error instanceof Error ? error.message : String(error));
    }
  };
  const verdrahteEingabe = (form: HTMLFormElement) => {
    const feld = form.querySelector("textarea") as HTMLTextAreaElement;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void sende(feld);
    });
    feld.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void sende(feld);
      }
    });
    feld.addEventListener("input", () => {
      feld.style.height = "";
      feld.style.height = `${Math.min(feld.scrollHeight, 160)}px`;
    });
    form.querySelector<HTMLButtonElement>('[data-role="mikro"]')?.addEventListener("click", (e) => {
      opt.voice.toggle();
      (e.currentTarget as HTMLElement).blur();
    });
  };
  verdrahteEingabe(inselForm);

  const zeigeZustand = () => {
    const z = gespraech.zustand;
    os.dataset.kuro = z;
    os.style.setProperty("--kuro-licht", ZUSTAND_FARBE[z]);
    satz.textContent = gespraech.detail ?? ZUSTAND_SATZ[z];
  };
  zeigeZustand();
  let letzteGezeigt = V.letzteAntwort(gespraech.verlauf)?.id ?? null;
  gespraech.abonniere((s) => {
    if (s.art === "zustand" || s.art === "arbeit") zeigeZustand();
    if (s.art === "fertig") {
      const letzte = V.letzteAntwort(gespraech.verlauf);
      if (!letzte || letzte.id === letzteGezeigt) return;
      letzteGezeigt = letzte.id;
      if (vorn !== "kuro") zeigeKurz();
      meldeNachDraussen(letzte.text);
    }
  });
  globalThis.addEventListener("kuro:sprechtaste", ((e: CustomEvent<{ an?: boolean }>) => {
    if (e.detail?.an && vorn !== "kuro") zeigeKurz();
  }) as EventListener);
  globalThis.addEventListener("kuro:insel", () => oeffneInsel(true));

  function meldeNachDraussen(text: string) {
    if (document.hasFocus() || typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    const zeile = text
      .replace(/[#*_`>]/g, "")
      .split("\n")
      .find((z) => z.trim())
      ?.trim();
    if (!zeile) return;
    const n = new Notification("Kuro", { body: zeile.slice(0, 180), silent: true });
    n.onclick = () => {
      globalThis.focus();
      oeffneInsel(false);
    };
  }

  // -------------------------------------------------------------- Kuro-App
  function mountKuro(el: HTMLElement): () => void {
    el.innerHTML = `
      <div class="k-app">
        <div class="k-app__kopf">
          <div class="k-app__orb" data-role="orb" role="button" tabindex="0" aria-label="Mikrofon an oder aus"></div>
          <p class="k-app__satz" data-role="ksatz"></p>
        </div>
        <div class="k-app__faden" data-role="faden" aria-live="polite"></div>
        <p class="k-app__leer" data-role="leer">Fragen Sie Kuro etwas, oder halten Sie die Sprechtaste.</p>
        <form class="o-eingabe" data-role="form">
          <textarea rows="1" name="text" placeholder="Kuro fragen" aria-label="Nachricht an Kuro"></textarea>
          <button type="button" class="o-eingabe__mikro" data-role="mikro" aria-label="Mikrofon an oder aus">${icon("mic")}</button>
          <button type="submit" class="o-eingabe__senden" aria-label="Senden">${SENDEN}</button>
        </form>
        <button type="button" class="k-app__leeren" data-role="leeren">Ansicht leeren</button>
      </div>`;
    const r = <T extends Element>(rolle: string) =>
      el.querySelector<T>(`[data-role="${rolle}"]`) as T;
    const form = r<HTMLFormElement>("form");
    verdrahteEingabe(form);
    const feld = form.querySelector("textarea") as HTMLTextAreaElement;
    const orbEl = r<HTMLElement>("orb");
    const ksatz = r<HTMLElement>("ksatz");
    const sphaere: Sphaere = mountSphaere(orbEl, "");
    const stand = () => {
      sphaere.setZustand(gespraech.zustand, gespraech.detail ?? undefined);
      ksatz.textContent = gespraech.detail ?? ZUSTAND_SATZ[gespraech.zustand];
    };
    stand();
    for (const [wer, a] of gespraech.arbeit) {
      sphaere.bediensteterBeginnt(werName(wer), a.auftrag ?? undefined);
      sphaere.bediensteterStand(werName(wer), a.stand);
    }
    const eingabeLoesen = sphaere.bindeEingabe(feld);
    sphaere.beimAntippen(() => {
      opt.voice.toggle();
      orbEl.blur();
    });
    const abo = gespraech.abonniere((s) => {
      if (s.art === "zustand") stand();
      else if (s.art === "impuls") sphaere.impuls(s.staerke);
      else if (s.art === "fertig" && gespraech.zustand === "ruhe") sphaere.fertig();
      else if (s.art === "bediensteter") {
        if (s.was === "beginnt") sphaere.bediensteterBeginnt(werName(s.wer), s.text || undefined);
        else if (s.was === "stand") sphaere.bediensteterStand(werName(s.wer), s.text);
        else sphaere.bediensteterFertig(werName(s.wer));
      }
    });
    const leer = r<HTMLElement>("leer");
    const fadenLoesen = mountFaden(r<HTMLElement>("faden"), {
      api,
      gespraech,
      beiLeere: (istLeer) => {
        leer.hidden = !istLeer;
      },
    });
    r<HTMLButtonElement>("leeren").addEventListener("click", () => gespraech.leere());
    globalThis.setTimeout(() => feld.focus({ preventScroll: true }), 60);
    return () => {
      abo();
      eingabeLoesen();
      fadenLoesen();
      sphaere.destroy();
    };
  }

  // ---------------------------------------------------------------- Starter
  type Treffer = {
    art: "app" | "notiz" | "kuro" | "tat";
    text: string;
    neben: string;
    tun: () => void;
  };
  let notizen: Array<{ pfad: string; titel: string }> = [];
  let treffer: Treffer[] = [];
  let auswahl = 0;

  const TATEN: Array<{ text: string; tun: () => void }> = [
    { text: "Fenster nebeneinander", tun: () => legeNebeneinander() },
    { text: "Alle Fenster minimieren", tun: () => minimiereAlle() },
    {
      text: "Graph des Brain",
      tun: () => {
        oeffneApp("brain");
        fenster.get("brain")?.brain?.graph();
      },
    },
  ];

  const zeichneStarter = () => {
    const text = starterFeld.value.trim();
    const klein = text.toLowerCase();
    const apps = APPS.filter(
      (a) => !klein || a.name.toLowerCase().includes(klein) || (a.stichworte ?? "").includes(klein),
    ).map<Treffer>((a) => ({ art: "app", text: a.name, neben: "App", tun: () => oeffneApp(a.id) }));
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
              tun: () => oeffneApp("brain", n.pfad),
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
                oeffneInsel(false);
              },
            },
          ]
        : [];
    treffer = klein ? [...apps, ...notizTreffer, ...taten, ...frage] : [...apps, ...taten];
    auswahl = Math.min(auswahl, Math.max(0, treffer.length - 1));
    starterListe.innerHTML = treffer
      .map(
        (t, i) =>
          `<li role="option" class="o-starter__treffer o-starter__treffer--${t.art}${i === auswahl ? " ist-gewaehlt" : ""}" data-i="${i}" aria-selected="${i === auswahl}"><span>${escapeHtml(t.text)}</span><small>${escapeHtml(t.neben)}</small></li>`,
      )
      .join("");
  };

  function oeffneStarter() {
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
    } else if (e.key === "Escape") schliesseStarter();
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
  q<HTMLButtonElement>("marke").addEventListener("click", oeffneStarter);

  // ------------------------------------------------------------ Kontextmenü
  tisch.addEventListener("contextmenu", (e) => {
    if (e.target !== tisch) return;
    e.preventDefault();
    kontext.innerHTML = [
      ["nebeneinander", "Fenster nebeneinander"],
      ["minimieren", "Alle minimieren"],
      ["notiz", "Neue Notiz im Brain"],
      ["starter", `Starter (${BEFEHL}K)`],
      ["einstellungen", "Einstellungen"],
    ]
      .map(
        ([tat, text]) =>
          `<button type="button" role="menuitem" data-tat="${tat}">${escapeHtml(text as string)}</button>`,
      )
      .join("");
    Object.assign(kontext.style, { left: `${e.clientX}px`, top: `${e.clientY}px` });
    kontext.hidden = false;
  });
  kontext.addEventListener("click", (e) => {
    const tat = (e.target as HTMLElement).dataset.tat;
    kontext.hidden = true;
    if (tat === "nebeneinander") legeNebeneinander();
    else if (tat === "minimieren") minimiereAlle();
    else if (tat === "notiz") oeffneApp("brain");
    else if (tat === "starter") oeffneStarter();
    else if (tat === "einstellungen") oeffneApp("einstellungen");
  });
  document.addEventListener("pointerdown", (e) => {
    if (!kontext.hidden && !kontext.contains(e.target as Node)) kontext.hidden = true;
    if (inselOffen && !insel.contains(e.target as Node)) schliesseInsel();
  });

  // ---------------------------------------------------------- Drag-and-drop
  const ablage = document.createElement("div");
  ablage.className = "o-ablage";
  ablage.hidden = true;
  ablage.innerHTML = "<p>Loslassen legt die Datei in den Eingang des Brain.</p>";
  os.append(ablage);
  let ueber = 0;
  const hatDateien = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");
  document.addEventListener("dragenter", (e) => {
    if (!hatDateien(e)) return;
    ueber += 1;
    ablage.hidden = false;
  });
  document.addEventListener("dragleave", (e) => {
    if (!hatDateien(e)) return;
    ueber = Math.max(0, ueber - 1);
    if (ueber === 0) ablage.hidden = true;
  });
  document.addEventListener("dragover", (e) => {
    if (hatDateien(e)) e.preventDefault();
  });
  document.addEventListener("drop", (e) => {
    if (!hatDateien(e)) return;
    e.preventDefault();
    ueber = 0;
    ablage.hidden = true;
    for (const datei of e.dataTransfer?.files ?? []) void lege(datei);
  });
  async function lege(datei: File) {
    if (datei.size > 20 * 1024 * 1024) {
      opt.toast(`${datei.name} ist größer als 20 MB und bleibt draußen.`);
      return;
    }
    const inhalt = await new Promise<string>((fertig, fehler) => {
      const leser = new FileReader();
      leser.onload = () => fertig(String(leser.result).replace(/^data:[^,]*,/, ""));
      leser.onerror = () => fehler(leser.error);
      leser.readAsDataURL(datei);
    });
    try {
      const r = await api.post<{ pfad: string }>("/integrations/brain/eingang", {
        name: datei.name,
        inhalt,
      });
      opt.toast(`Im Brain abgelegt: ${r.pfad.replace(/\.md$/, "")}`);
      oeffneApp("brain", r.pfad);
    } catch (error) {
      opt.toast(error instanceof Error ? error.message : String(error));
    }
  }

  // ----------------------------------------------------------------- Tasten
  globalThis.addEventListener("keydown", (e) => {
    const befehl = IST_MAC ? e.metaKey : e.ctrlKey;
    if (befehl && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (starter.hidden) oeffneStarter();
      else schliesseStarter();
      return;
    }
    if (befehl && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
      const app = APPS[Number(e.key) - 1];
      if (app) {
        e.preventDefault();
        oeffneApp(app.id);
      }
      return;
    }
    // Andocken wie mit Rectangle: ⌃⌥← → ↑, ⌃⌥↓ stellt wieder her.
    if (e.ctrlKey && e.altKey && vorn) {
      const f = fenster.get(vorn);
      if (!f) return;
      if (e.key === "ArrowLeft") docke(f, "links");
      else if (e.key === "ArrowRight") docke(f, "rechts");
      else if (e.key === "ArrowUp") docke(f, "voll");
      else if (e.key === "ArrowDown" && f.andock) {
        f.r = f.vorher ?? staffel(0, f.app.groesse, flaeche());
        f.andock = null;
        setzeLage(f);
        speichere();
      } else return;
      e.preventDefault();
      return;
    }
    if (e.key === "Escape") {
      if (!starter.hidden) schliesseStarter();
      else if (inselOffen) schliesseInsel();
      else kontext.hidden = true;
    }
  });

  globalThis.addEventListener("resize", () => {
    for (const f of fenster.values()) {
      if (f.andock) f.r = andockRechteck(f.andock, flaeche());
      else f.r = begrenze(f.r, flaeche());
      setzeLage(f);
    }
  });

  // ------------------------------------------------------------------ Start
  let gespeichert: Gespeichert[] = [];
  try {
    gespeichert = JSON.parse(globalThis.localStorage?.getItem(SPEICHER) ?? "[]") as Gespeichert[];
  } catch {
    gespeichert = [];
  }
  const ziel = /^#\/(\w+)(?:\/(.+))?$/.exec(globalThis.location.hash);
  if (gespeichert.length > 0) {
    for (const g of gespeichert) {
      const app = APP.get(g.app);
      if (!app) continue;
      const f = erzeuge(app, begrenze(g.r, flaeche()), undefined);
      f.andock = g.andock;
      if (g.andock) f.r = andockRechteck(g.andock, flaeche());
      setzeLage(f);
      fenster.set(app.id, f);
      reihe.push(app.id);
      if (g.min) {
        f.min = true;
        f.el.hidden = true;
      }
    }
    ordne();
  } else {
    oeffneApp("kuro");
  }
  if (ziel && APP.has(ziel[1] as AppId)) {
    oeffneApp(ziel[1] as AppId, ziel[2] ? decodeURIComponent(ziel[2]) : undefined);
  }

  globalThis.addEventListener("pagehide", () => {
    for (const f of fenster.values()) f.aufraeumen();
    inselLoesen();
  });
}
