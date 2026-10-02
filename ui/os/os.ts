import type { ApiClient } from "../api/client.js";
import type { EventBusClient } from "../events/bus.js";
import { icon } from "../icons.js";
import type { MicStateStore } from "../mic/state.js";
import { type Sphaere, mountSphaere } from "../praesenz/sphaere.js";
import type { RouteId, SettingsSectionId } from "../router/router.js";
import { settingsView } from "../settings/view.js";
import { analysenView } from "../views/analysen.js";
import { calendarView } from "../views/calendar.js";
import { escapeHtml } from "../views/html.js";
import { mailView } from "../views/mail.js";
import { researchView } from "../views/research.js";
import { strategienView } from "../views/strategien.js";
import { systemView } from "../views/system.js";
import { tradingView } from "../views/trading.js";
import type { View, ViewContext } from "../views/types.js";
import { mountFaden } from "../welle/faden.js";
import { datumZeile, gruss, werName } from "../welle/form.js";
import type { Gespraech } from "../welle/gespraech.js";
import * as V from "../welle/verlauf.js";
import { ZUSTAND_FARBE, ZUSTAND_SATZ } from "../welle/zustand.js";
import { type BrainApp, mountBrainApp } from "./brain.js";
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
 * Kuro OS, dritter Wurf (`bau/kuro-os-konzept.md`): Kuros Zimmer ist der Desktop — Gruß, Orb,
 * Gespräch. ⌘2–5 legen einen Raum als Tafel darüber, Kuros Platz bleibt rechts daneben; Esc oder
 * ⌘1 führt zurück zu Kuro. System und Einstellungen kommen als Blatt von rechts.
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
  kuro: "gespräch butler desktop",
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
const SPEICHER_PLATZ = "kuronami.os.platz";
const MOTTO = "Always here. Always working.";
const KURO: Ort = { raum: "kuro", teil: null, notiz: null };
/** So lange gleitet ein Teil hinaus, bevor er abgebaut wird (Konzept „Bewegung"). */
const UEBERGANG_MS = 180;

const SENDEN = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg>`;

function seitenspeicher(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function eingabeHtml(rolle: string): string {
  return `
    <form class="o-eingabe" data-role="${rolle}">
      <textarea rows="1" name="text" placeholder="Kuro fragen" aria-label="Nachricht an Kuro"></textarea>
      <button type="button" class="o-eingabe__mikro" data-role="mikro" aria-label="Mikrofon an oder aus">${icon("mic")}</button>
      <button type="submit" class="o-eingabe__senden" aria-label="Senden">${SENDEN}</button>
    </form>`;
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
  let platzZu = speicher?.getItem(SPEICHER_PLATZ) === "zu";

  root.innerHTML = `
    <div class="o-os" data-kuro="ruhe">
      <div class="o-zimmer" aria-hidden="true"></div>
      <header class="o-kopf">
        <button type="button" class="o-marke" data-role="marke" title="Starter (${BEFEHL}K)" aria-label="Starter">黒波</button>
        <nav class="o-raeume" data-role="raeume" aria-label="Räume">
          ${RAEUME.map(
            (r, i) =>
              `<a class="o-raum" href="${schreibeOrt({ raum: r, teil: null, notiz: null })}" data-raum="${r}" title="${RAUM_NAME[r]} (${BEFEHL}${i + 1})"><span>${RAUM_NAME[r]}</span><small aria-hidden="true">${i + 1}</small></a>`,
          ).join("")}
        </nav>
        <div class="o-kopf__rechts">
          <button type="button" class="o-suche" data-role="suche" title="Räume, Notizen, Kuro fragen">Suchen <kbd>${BEFEHL}K</kbd></button>
          <button type="button" class="o-abo" data-role="abo" hidden></button>
          <time class="o-uhr" data-role="uhr"></time>
          <button type="button" class="o-haus" data-role="haus" title="System und Einstellungen (${BEFEHL},)" aria-label="System und Einstellungen">${icon("settings")}</button>
        </div>
      </header>

      <section class="o-empfang" data-role="empfang" aria-label="Kuro">
        <p class="o-empfang__datum" data-role="datum"></p>
        <h1 class="o-empfang__gruss" data-role="gruss"></h1>
      </section>

      <section class="o-fenster" data-role="fenster" hidden>
        <header class="o-fenster__kopf">
          <nav class="o-teile" data-role="teile" aria-label="Teile des Raums"></nav>
          <button type="button" class="o-zu" data-role="zu" aria-label="Zurück zu Kuro" title="Zurück zu Kuro (Esc)">${icon("close")}</button>
        </header>
        <div class="o-fenster__buehne" data-role="buehne"></div>
      </section>

      <aside class="o-platz" data-role="platz" aria-label="Kuro">
        <header class="o-platz__kopf">
          <h2>Gespräch</h2>
        </header>
        <div class="o-platz__orbraum" aria-hidden="true"></div>
        <p class="o-platz__satz" data-role="satz"></p>
        <section class="o-imhaus" data-role="imhaus" aria-label="Im Haus"></section>
        <div class="o-platz__faden" data-role="faden" aria-live="polite"></div>
        <p class="o-platz__leer" data-role="leer" hidden>Fragen Sie Kuro etwas, oder halten Sie die Sprechtaste.</p>
        ${eingabeHtml("form")}
        <footer class="o-platz__fuss">
          <button type="button" class="o-leise" data-role="leeren" title="Leert nur diese Ansicht — Kuro erinnert sich weiter.">Ansicht leeren</button>
          <button type="button" class="o-leise o-platz__klappe" data-role="klappe" title="Kuros Platz einklappen (${BEFEHL}J)">Einklappen</button>
        </footer>
        <button type="button" class="o-streifen" data-role="streifen" aria-label="Kuros Platz aufklappen" title="Kuros Platz aufklappen (${BEFEHL}J)">
          <span class="o-streifen__zahl" data-role="zahl"></span>
        </button>
      </aside>

      <div class="o-orb" data-role="orb" role="button" tabindex="0" aria-label="Mikrofon an oder aus"></div>

      <div class="o-blatt" data-role="blatt" hidden>
        <div class="o-blatt__grund" data-role="blattgrund"></div>
        <section class="o-blatt__tafel" role="dialog" aria-label="System und Einstellungen">
          <header class="o-fenster__kopf">
            <nav class="o-teile" data-role="blattteile" aria-label="System und Einstellungen">
              <a class="o-teil" href="#" data-blatt="system">System</a>
              <a class="o-teil" href="#" data-blatt="einstellungen">Einstellungen</a>
            </nav>
            <button type="button" class="o-zu" data-role="blattzu" aria-label="Schließen" title="Schließen (Esc)">${icon("close")}</button>
          </header>
          <div class="o-blatt__inhalt" data-role="blattinhalt"></div>
        </section>
      </div>

      <div class="o-starter" data-role="starter" hidden>
        <div class="o-starter__feld" role="dialog" aria-label="Starter">
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
  const raeumeEl = q<HTMLElement>("raeume");
  const fenster = q<HTMLElement>("fenster");
  const teileEl = q<HTMLElement>("teile");
  const buehne = q<HTMLElement>("buehne");
  const platz = q<HTMLElement>("platz");
  const satz = q<HTMLElement>("satz");
  const fadenEl = q<HTMLElement>("faden");
  const leerEl = q<HTMLElement>("leer");
  const form = q<HTMLFormElement>("form");
  const feld = form.querySelector("textarea") as HTMLTextAreaElement;
  const zahlEl = q<HTMLElement>("zahl");
  const orbEl = q<HTMLElement>("orb");
  const blatt = q<HTMLElement>("blatt");
  const blattInhalt = q<HTMLElement>("blattinhalt");
  const blattTeile = q<HTMLElement>("blattteile");
  const starter = q<HTMLElement>("starter");
  const starterFeld = q<HTMLInputElement>("starterfeld");
  const starterListe = q<HTMLElement>("starterliste");

  // ------------------------------------------------------------ Gruß, Uhr, Abo
  const datumEl = q<HTMLElement>("datum");
  const grussEl = q<HTMLElement>("gruss");
  const uhrEl = q<HTMLElement>("uhr");
  const tick = () => {
    const d = new Date();
    uhrEl.textContent = d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
    uhrEl.title = d.toLocaleDateString("de-DE", { dateStyle: "full" });
    datumEl.textContent = datumZeile(d);
    // Zwei Zeilen wie in der Welle: der Gruß, dann der Name.
    const [vorn, name] = gruss(d).split(", ");
    grussEl.innerHTML = `<span>${escapeHtml(vorn ?? "")},</span> <span>${escapeHtml(name ?? "")}</span>`;
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
  aboEl.addEventListener("click", () => oeffneBlatt("system"));

  // ------------------------------------------------------------ Ansichten
  function ctxFuer(section?: SettingsSectionId): ViewContext {
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
      voice: opt.voice,
    };
  }

  // ------------------------------------------------------- Räume und Fenster
  interface Gemountet {
    teil: Teil;
    el: HTMLElement;
    loesen: () => void;
  }
  let ort: Ort = KURO;
  let aktiv: Gemountet | null = null;
  // Das Brain bleibt nach dem ersten Öffnen stehen: offene Notiz, Verlauf und Graph überdauern
  // den Raumwechsel. Die übrigen Ansichten laden beim Öffnen frisch, wie in der Welle.
  let brain: { el: HTMLElement; app: BrainApp } | null = null;
  let fensterUhr: ReturnType<typeof setTimeout> | null = null;
  /** Jakob hat zuletzt im Fenster gearbeitet: das nächste Esc gehört der Ansicht. */
  let imFenster = false;

  const baueAb = (g: Gemountet) => {
    if (g.teil === "brain") g.el.hidden = true;
    else {
      g.loesen();
      g.el.remove();
    }
  };

  const zeichneKopf = () => {
    os.dataset.raum = ort.raum;
    for (const a of raeumeEl.querySelectorAll<HTMLElement>("[data-raum]")) {
      const hier = a.dataset.raum === ort.raum;
      a.classList.toggle("ist-hier", hier);
      if (hier) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
    const teile = TEILE[ort.raum] as readonly Teil[];
    // Ein Raum mit einem einzigen Teil, der wie der Raum heißt, braucht keinen Reiter.
    const zeigen = teile.filter((t) => teile.length > 1 || TEIL_NAME[t] !== RAUM_NAME[ort.raum]);
    teileEl.innerHTML = zeigen
      .map(
        (t) =>
          `<a class="o-teil${t === ort.teil ? " ist-hier" : ""}" href="${schreibeOrt({ raum: ort.raum, teil: t, notiz: null })}"${t === ort.teil ? ' aria-current="page"' : ""}>${escapeHtml(TEIL_NAME[t])}</a>`,
      )
      .join("");
    fenster.setAttribute("aria-label", RAUM_NAME[ort.raum]);
  };

  function zeigeTeil(ziel: Ort, vorher: Ort) {
    const teil = ziel.teil as Teil;
    if (aktiv?.teil === teil) {
      if (teil === "brain" && ziel.notiz) brain?.app.oeffne(ziel.notiz);
      return;
    }
    let neu: Gemountet;
    if (teil === "brain") {
      if (brain) {
        if (ziel.notiz) brain.app.oeffne(ziel.notiz);
      } else {
        const el = document.createElement("div");
        el.className = "o-teil-flaeche o-teil-flaeche--brain";
        buehne.append(el);
        brain = { el, app: mountBrainApp(el, api, ziel.notiz, opt.toast) };
      }
      brain.el.hidden = false;
      neu = { teil, el: brain.el, loesen: () => {} };
    } else {
      const el = document.createElement("div");
      el.className = `o-teil-flaeche w-raum o-teil-flaeche--${teil}`;
      const innen = document.createElement("div");
      el.append(innen);
      buehne.append(el);
      neu = { teil, el, loesen: ANSICHT[teil].mount(innen, ctxFuer()) };
    }
    const alt = aktiv;
    aktiv = neu;
    const r = richtung(vorher, ziel);
    if (alt && !fenster.hidden) {
      // Der alte Teil gleitet in die Gegenrichtung hinaus, der neue kommt aus der Richtung herein.
      alt.el.style.setProperty("--versatz", `${-12 * r}px`);
      alt.el.classList.add("ist-gehend");
      globalThis.setTimeout(() => {
        alt.el.classList.remove("ist-gehend");
        if (aktiv !== alt) baueAb(alt);
      }, UEBERGANG_MS);
      neu.el.style.setProperty("--versatz", `${12 * r}px`);
      neu.el.classList.add("ist-kommend");
      requestAnimationFrame(() =>
        requestAnimationFrame(() => neu.el.classList.remove("ist-kommend")),
      );
    } else if (alt) {
      baueAb(alt);
    }
  }

  const oeffneFenster = () => {
    if (fensterUhr) globalThis.clearTimeout(fensterUhr);
    fensterUhr = null;
    if (!fenster.hidden && !fenster.classList.contains("ist-gehend")) return;
    fenster.hidden = false;
    fenster.classList.remove("ist-gehend");
    fenster.classList.add("ist-kommend");
    os.classList.add("ist-fenster");
    requestAnimationFrame(() =>
      requestAnimationFrame(() => fenster.classList.remove("ist-kommend")),
    );
    setzeFaden();
  };

  const schliesseFenster = () => {
    if (fenster.hidden) return;
    os.classList.remove("ist-fenster");
    fenster.classList.add("ist-gehend");
    setzeFaden();
    if (fensterUhr) globalThis.clearTimeout(fensterUhr);
    fensterUhr = globalThis.setTimeout(() => {
      fensterUhr = null;
      fenster.hidden = true;
      fenster.classList.remove("ist-gehend");
      if (aktiv) baueAb(aktiv);
      aktiv = null;
    }, 220);
  };

  function geheZu(ziel: Ort, verlauf: "push" | "replace" = "push") {
    schliesseStarter();
    schliesseBlatt();
    imFenster = false;
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
    zeichneKopf();
    if (ziel.raum === "kuro") {
      schliesseFenster();
      return;
    }
    oeffneFenster();
    zeigeTeil(ziel, vorher);
  }

  const zuKuro = () => geheZu(KURO);

  // Räume und Teile sind Verweise; gegangen wird hier, damit der Verlauf nur einen Schritt kennt.
  const beiVerweis = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a[href^='#/']");
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    geheZu(liesOrt(a.getAttribute("href") ?? "", gemerkt));
  };
  raeumeEl.addEventListener("click", beiVerweis);
  teileEl.addEventListener("click", beiVerweis);
  q<HTMLButtonElement>("zu").addEventListener("click", zuKuro);
  globalThis.addEventListener("hashchange", () =>
    geheZu(liesOrt(globalThis.location.hash, gemerkt), "replace"),
  );
  fenster.addEventListener("pointerdown", () => {
    imFenster = true;
  });
  platz.addEventListener("pointerdown", () => {
    imFenster = false;
  });

  // --------------------------------------------------------------- Blatt
  let blattTeil: BlattTeil | null = null;
  let blattLoesen: (() => void) | null = null;
  let blattUhr: ReturnType<typeof setTimeout> | null = null;

  function oeffneBlatt(teil: BlattTeil, section?: SettingsSectionId) {
    schliesseStarter();
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

  // ---------------------------------------------------------- Kuros Platz
  const sende = async (f: HTMLTextAreaElement) => {
    const text = f.value.trim();
    if (!text) return;
    f.value = "";
    f.style.height = "";
    try {
      await gespraech.sende(text);
    } catch (error) {
      opt.toast(error instanceof Error ? error.message : String(error));
    }
  };
  const verdrahteEingabe = (f: HTMLFormElement) => {
    const t = f.querySelector("textarea") as HTMLTextAreaElement;
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      void sende(t);
    });
    t.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void sende(t);
      }
    });
    t.addEventListener("input", () => {
      t.style.height = "";
      t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
    });
    f.querySelector<HTMLButtonElement>('[data-role="mikro"]')?.addEventListener("click", (e) => {
      opt.voice.toggle();
      (e.currentTarget as HTMLElement).blur();
    });
  };
  verdrahteEingabe(form);

  // Auf dem Desktop steht das ganze Gespräch, neben einem Fenster nur Kuros letzte Antwort.
  let fadenLoesen: (() => void) | null = null;
  let fadenKurz: boolean | null = null;
  function setzeFaden() {
    const kurz = os.classList.contains("ist-fenster");
    if (kurz === fadenKurz) return;
    fadenKurz = kurz;
    fadenLoesen?.();
    fadenEl.replaceChildren();
    fadenLoesen = mountFaden(fadenEl, {
      api,
      gespraech,
      nurLetzte: kurz,
      beiLeere: (leer) => {
        leerEl.hidden = !leer;
      },
    });
    fadenEl.scrollTop = fadenEl.scrollHeight;
  }

  const klappePlatz = (zu: boolean) => {
    platzZu = zu;
    os.classList.toggle("ist-platz-zu", zu);
    if (!zu) os.classList.remove("hat-neues");
    merke(SPEICHER_PLATZ, zu ? "zu" : "auf");
  };
  os.classList.toggle("ist-platz-zu", platzZu);
  q<HTMLButtonElement>("klappe").addEventListener("click", () => klappePlatz(true));
  q<HTMLButtonElement>("streifen").addEventListener("click", () => {
    klappePlatz(false);
    feld.focus({ preventScroll: true });
  });
  q<HTMLButtonElement>("leeren").addEventListener("click", () => gespraech.leere());

  /** Kuro nach vorn: der Platz geht auf (auch eingeklappt), die Eingabe bekommt den Fokus. */
  const oeffnePlatz = (fokus: boolean) => {
    if (platzZu) klappePlatz(false);
    if (fokus) feld.focus({ preventScroll: true });
  };

  // ----------------------------------------------------------------- Orb
  const sphaere: Sphaere = mountSphaere(orbEl, MOTTO);
  for (const [wer, a] of gespraech.arbeit) {
    sphaere.bediensteterBeginnt(werName(wer), a.auftrag ?? undefined);
    sphaere.bediensteterStand(werName(wer), a.stand);
  }
  const eingabeLoesen = sphaere.bindeEingabe(feld);
  sphaere.beimAntippen(() => {
    opt.voice.toggle();
    orbEl.blur();
  });
  orbEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    opt.voice.toggle();
  });

  const zeigeZustand = () => {
    const z = gespraech.zustand;
    os.dataset.kuro = z;
    os.style.setProperty("--kuro-licht", ZUSTAND_FARBE[z]);
    satz.textContent = gespraech.detail ?? ZUSTAND_SATZ[z];
    sphaere.setZustand(z, gespraech.detail ?? undefined);
    orbEl.setAttribute("aria-pressed", String(z === "zuhoeren"));
  };
  const zeigeArbeit = () => {
    const n = gespraech.arbeit.size;
    zahlEl.textContent = n > 0 ? String(n) : "";
    zahlEl.title = n === 1 ? "Ein Auftrag läuft" : n > 1 ? `${n} Aufträge laufen` : "";
  };
  zeigeZustand();
  zeigeArbeit();

  let letzteGezeigt = V.letzteAntwort(gespraech.verlauf)?.id ?? null;
  const abo = gespraech.abonniere((s) => {
    if (s.art === "zustand") zeigeZustand();
    else if (s.art === "arbeit") zeigeArbeit();
    else if (s.art === "impuls") sphaere.impuls(s.staerke);
    else if (s.art === "bediensteter") {
      if (s.was === "beginnt") sphaere.bediensteterBeginnt(werName(s.wer), s.text || undefined);
      else if (s.was === "stand") sphaere.bediensteterStand(werName(s.wer), s.text);
      else sphaere.bediensteterFertig(werName(s.wer));
    } else if (s.art === "fertig") {
      if (gespraech.zustand === "ruhe") sphaere.fertig();
      const letzte = V.letzteAntwort(gespraech.verlauf);
      if (!letzte || letzte.id === letzteGezeigt) return;
      letzteGezeigt = letzte.id;
      if (platzZu && ort.raum !== "kuro") os.classList.add("hat-neues");
      meldeNachDraussen(letzte.text);
    }
  });

  globalThis.addEventListener("kuro:sprechtaste", ((e: CustomEvent<{ an?: boolean }>) => {
    if (e.detail?.an) oeffnePlatz(false);
  }) as EventListener);
  globalThis.addEventListener("kuro:insel", () => oeffnePlatz(true));

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
      oeffnePlatz(false);
    };
  }

  // ------------------------------------------------------------- Starter
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
      tun: () => geheZu(liesOrt(`#/${r}`, gemerkt)),
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
      such: "einstellungen schlüssel sprache",
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
    { text: "Kuros Platz ein- oder ausklappen", tun: () => klappePlatz(!platzZu) },
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
                oeffnePlatz(false);
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
  q<HTMLButtonElement>("marke").addEventListener("click", oeffneStarter);
  q<HTMLButtonElement>("suche").addEventListener("click", oeffneStarter);

  // ------------------------------------------------------- Drag-and-drop
  const ablage = q<HTMLElement>("ablage");
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
        // Auf dem Desktop ist das Gespräch der Raum selbst; dort holt ⌘J nur die Eingabe.
        if (ort.raum === "kuro") feld.focus({ preventScroll: true });
        else klappePlatz(!platzZu);
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
        if (raum !== ort.raum || blattTeil) geheZu(liesOrt(`#/${raum}`, gemerkt));
        return;
      }
    }
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if (!starter.hidden) {
      schliesseStarter();
      return;
    }
    // Esc geht eine Ebene zurück: erst aus dem Feld, dann aus der Ansicht, dann aus dem Raum.
    const fokus = document.activeElement;
    if (fokus instanceof HTMLElement && fokus !== document.body && fokus.matches(IST_FELD)) {
      fokus.blur();
      imFenster = false;
      return;
    }
    if (blattTeil) {
      schliesseBlatt();
      return;
    }
    if (ort.raum === "kuro") return;
    if (imFenster) {
      imFenster = false;
      return;
    }
    zuKuro();
  });

  // --------------------------------------------------------------- Start
  geheZu(liesOrt(globalThis.location.hash, gemerkt), "replace");
  setzeFaden();

  globalThis.addEventListener("pagehide", () => {
    abo();
    eingabeLoesen();
    fadenLoesen?.();
    sphaere.destroy();
    if (aktiv) baueAb(aktiv);
    brain?.app.loesen();
    blattLoesen?.();
  });
}
