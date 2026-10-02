import type { ApiClient } from "../api/client.js";
import type { EventBusClient } from "../events/bus.js";
import { icon } from "../icons.js";
import type { MicStateStore } from "../mic/state.js";
import { type Sphaere, mountSphaere } from "../praesenz/sphaere.js";
import { type RouteId, type SettingsSectionId, hashFor } from "../router/router.js";
import { settingsView } from "../settings/view.js";
import { analysenView } from "../views/analysen.js";
import { escapeHtml } from "../views/html.js";
import { strategienView } from "../views/strategien.js";
import { systemView } from "../views/system.js";
import { tradingView } from "../views/trading.js";
import type { View, ViewContext } from "../views/types.js";
import { verfolge } from "../welle/bereit.js";
import { mountFaden } from "../welle/faden.js";
import { datumZeile, gruss, uhrzeit, werName } from "../welle/form.js";
import type { Gespraech } from "../welle/gespraech.js";
import * as V from "../welle/verlauf.js";
import { ZUSTAND_FARBE, ZUSTAND_SATZ } from "../welle/zustand.js";
import { mountBrain } from "./brain.js";
import {
  BEREICHE,
  BEREICH_NAME,
  TRADING,
  TRADING_NAME,
  type TradingTeil,
  type Weg,
  bereichFuerTaste,
  liesWeg,
  schreibeWeg,
} from "./weg.js";

/**
 * Kuro OS — Jakobs Arbeitsplatz am Rechner (02.10.), im Browser unter `/os/` und als Desktop-App
 * (`desktop/`), die genau diese Seite lädt.
 *
 * Vier Bereiche in einer Leiste, und Kuro als Insel oben in der Mitte, wo am MacBook die Notch
 * sitzt: zu sehen ist nur sein Zustand; ein Klick, ⌘K oder die Sprechtaste klappt sie zum
 * Gespräch auf. Kommt eine Antwort, während Jakob in einem anderen Bereich ist, öffnet sie sich
 * von selbst und schließt wieder, wenn er nicht hinsieht. Sonst bewegt sich nichts.
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

const TRADING_VIEWS: Record<TradingTeil, View> = {
  maerkte: tradingView,
  strategien: strategienView,
  analysen: analysenView,
};

/** Wohin eine Fachansicht will, wenn sie `navigate` ruft. Post und Kalender wohnen im Web. */
function wegFuerRoute(route: RouteId, section?: SettingsSectionId): Weg | string {
  switch (route) {
    case "trading":
      return { bereich: "trading", teil: "maerkte" };
    case "strategien":
    case "analysen":
      return { bereich: "trading", teil: route };
    case "system":
      return { bereich: "system", teil: null };
    case "settings":
      return { bereich: "einstellungen", teil: section ?? null };
    case "praesenz":
      return { bereich: "kuro", teil: null };
    default:
      return `/welle/${hashFor(route, section)}`;
  }
}

const SENDEN = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg>`;

const IST_MAC = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? "");
const BEFEHL = IST_MAC ? "⌘" : "Strg+";

export function mountOs(opt: OsOptionen): void {
  const { root, api, gespraech } = opt;
  let weg = liesWeg(globalThis.location.hash);

  root.innerHTML = `
    <div class="o-os">
      <div class="o-licht" aria-hidden="true"></div>
      <header class="o-leiste">
        <div class="o-links">
          <a class="o-marke" href="#/kuro" aria-label="Kuro OS, zu Kuro">黒波</a>
          <nav class="o-bereiche" aria-label="Bereiche">
            ${BEREICHE.map(
              (b, i) =>
                `<a class="o-bereich" href="#/${b}" data-bereich="${b}" title="${BEFEHL}${i + 1}">${BEREICH_NAME[b]}</a>`,
            ).join("")}
          </nav>
        </div>
        <div class="o-insel" data-role="insel">
          <button type="button" class="o-insel__griff" data-role="griff" aria-expanded="false"
                  aria-controls="o-insel-blatt" title="Mit Kuro sprechen (${BEFEHL}K)">
            <span class="o-insel__licht" aria-hidden="true"></span>
            <span class="o-insel__satz" data-role="satz">Kuro ist da</span>
          </button>
          <div class="o-insel__blatt" id="o-insel-blatt" data-role="blatt" hidden>
            <div class="o-insel__faden" data-role="inselfaden"></div>
            <form class="o-eingabe" data-role="inselform">
              <textarea rows="1" name="text" placeholder="Kuro fragen" aria-label="Nachricht an Kuro"></textarea>
              <button type="button" class="o-eingabe__mikro" data-role="mikro" aria-label="Mikrofon an- oder ausschalten">${icon("mic")}</button>
              <button type="submit" class="o-eingabe__senden" aria-label="Senden">${SENDEN}</button>
            </form>
          </div>
        </div>
        <div class="o-rechts">
          <time class="o-uhr" data-role="uhr"></time>
          <a class="o-zahnrad" href="#/einstellungen" aria-label="Einstellungen" data-bereich="einstellungen">${icon("settings")}</a>
        </div>
      </header>
      <main class="o-flaeche" data-role="flaeche" tabindex="-1"></main>
    </div>`;

  const q = <T extends Element>(rolle: string): T => {
    const el = root.querySelector<T>(`[data-role="${rolle}"]`);
    if (!el) throw new Error(`Kuro OS: Element ${rolle} fehlt.`);
    return el;
  };
  const os = root.querySelector<HTMLElement>(".o-os") as HTMLElement;
  const flaeche = q<HTMLElement>("flaeche");
  const insel = q<HTMLElement>("insel");
  const griff = q<HTMLButtonElement>("griff");
  const blatt = q<HTMLElement>("blatt");
  const satz = q<HTMLElement>("satz");
  const inselForm = q<HTMLFormElement>("inselform");
  const inselEingabe = inselForm.querySelector("textarea") as HTMLTextAreaElement;
  const uhrEl = q<HTMLElement>("uhr");

  // ------------------------------------------------------------------ Uhr
  const tick = () => {
    uhrEl.textContent = uhrzeit(new Date());
  };
  tick();
  globalThis.setInterval(tick, 15_000);

  // ---------------------------------------------------------------- Insel
  let offen = false;
  let schliessUhr: ReturnType<typeof setTimeout> | null = null;
  const inselFadenLoesen = mountFaden(q<HTMLElement>("inselfaden"), { api, gespraech });

  const oeffne = (fokus: boolean) => {
    if (schliessUhr) globalThis.clearTimeout(schliessUhr);
    schliessUhr = null;
    offen = true;
    blatt.hidden = false;
    insel.classList.add("ist-offen");
    griff.setAttribute("aria-expanded", "true");
    const faden = q<HTMLElement>("inselfaden");
    faden.scrollTop = faden.scrollHeight;
    if (fokus) inselEingabe.focus();
  };
  const schliesse = () => {
    offen = false;
    blatt.hidden = true;
    insel.classList.remove("ist-offen");
    griff.setAttribute("aria-expanded", "false");
  };
  /** Von selbst geöffnet: schließt wieder, wenn Jakob nicht hinsieht. */
  const zeigeKurz = () => {
    if (offen && schliessUhr === null) return;
    oeffne(false);
    schliessUhr = globalThis.setTimeout(() => {
      if (insel.matches(":hover") || insel.contains(document.activeElement)) return;
      schliesse();
    }, 12_000);
  };
  griff.addEventListener("click", () => (offen ? schliesse() : oeffne(true)));
  document.addEventListener("pointerdown", (e) => {
    if (offen && !insel.contains(e.target as Node)) schliesse();
  });

  // --------------------------------------------------------- Eingaben
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
  const verdrahte = (form: HTMLFormElement) => {
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
  verdrahte(inselForm);

  // ------------------------------------------------------------ Zustand
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
      if (weg.bereich !== "kuro") zeigeKurz();
      meldeNachDraussen(letzte.text);
    }
  });
  globalThis.addEventListener("kuro:sprechtaste", ((e: CustomEvent<{ an?: boolean }>) => {
    if (e.detail?.an && weg.bereich !== "kuro") zeigeKurz();
  }) as EventListener);

  globalThis.addEventListener("kuro:insel", () => {
    if (weg.bereich === "kuro") {
      flaeche.querySelector<HTMLTextAreaElement>(".o-eingabe--gross textarea")?.focus();
    } else oeffne(true);
  });

  /** Eine Antwort, während Kuro OS nicht vorn ist: als Mitteilung des Systems. */
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
      oeffne(false);
    };
  }

  // ------------------------------------------------------------ Bereiche
  let aufraeumen: (() => void) | null = null;

  const ctx = (section?: SettingsSectionId): ViewContext => ({
    api,
    bus: opt.bus,
    mic: opt.mic,
    navigate(route, sec) {
      const ziel = wegFuerRoute(route, sec);
      if (typeof ziel === "string") globalThis.location.href = ziel;
      else globalThis.location.hash = schreibeWeg(ziel);
    },
    toggleFocus() {},
    ...(section ? { section } : {}),
    voice: opt.voice,
  });

  const zeigeBereich = async (neu: Weg) => {
    const gleicherBereich = neu.bereich === weg.bereich && aufraeumen !== null;
    weg = neu;
    for (const a of root.querySelectorAll<HTMLElement>("[data-bereich]")) {
      const aktiv = a.dataset.bereich === neu.bereich;
      a.classList.toggle("ist-aktiv", aktiv);
      if (aktiv) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
    os.dataset.bereich = neu.bereich;

    // Im Brain wechselt nur die Notiz, der Bereich bleibt stehen.
    if (gleicherBereich && neu.bereich === "brain" && brainOeffne) {
      brainOeffne(neu.teil ?? "START.md");
      return;
    }

    aufraeumen?.();
    aufraeumen = null;
    brainOeffne = null;
    flaeche.classList.remove("ist-da");
    flaeche.innerHTML = "";
    const verfolgt = verfolge(api);

    switch (neu.bereich) {
      case "kuro":
        aufraeumen = mountKuro(flaeche, verfolgt.api);
        break;
      case "trading":
        aufraeumen = mountTrading(flaeche, (neu.teil as TradingTeil) ?? "maerkte", verfolgt.api);
        break;
      case "brain":
        aufraeumen = mountBrainBereich(flaeche, neu.teil ?? "START.md", verfolgt.api);
        break;
      case "system":
        aufraeumen = mountFach(flaeche, "System", systemView, verfolgt.api);
        break;
      case "einstellungen":
        aufraeumen = mountFach(
          flaeche,
          "Einstellungen",
          settingsView,
          verfolgt.api,
          (neu.teil as SettingsSectionId | null) ?? undefined,
        );
        break;
      default:
        break;
    }
    await verfolgt.bereit();
    flaeche.classList.add("ist-da");
  };

  // Fachansichten: ihr eigener Titel weicht dem des Bereichs.
  function mountFach(
    el: HTMLElement,
    titel: string,
    view: View,
    vapi: ApiClient,
    section?: SettingsSectionId,
  ): () => void {
    el.innerHTML = `<div class="o-bereich-seite w-raum"><h1 class="o-titel">${escapeHtml(titel)}</h1><div data-role="fach"></div></div>`;
    const ort = el.querySelector<HTMLElement>('[data-role="fach"]') as HTMLElement;
    return view.mount(ort, { ...ctx(section), api: vapi });
  }

  function mountTrading(el: HTMLElement, teil: TradingTeil, vapi: ApiClient): () => void {
    el.innerHTML = `
      <div class="o-bereich-seite o-bereich-seite--breit w-raum">
        <nav class="o-reiter" aria-label="Trading">
          ${TRADING.map(
            (t) =>
              `<a href="${schreibeWeg({ bereich: "trading", teil: t })}" class="o-reiter__wort${t === teil ? " ist-aktiv" : ""}"${t === teil ? ' aria-current="page"' : ""}>${TRADING_NAME[t]}</a>`,
          ).join("")}
        </nav>
        <div data-role="fach"></div>
      </div>`;
    const ort = el.querySelector<HTMLElement>('[data-role="fach"]') as HTMLElement;
    return TRADING_VIEWS[teil].mount(ort, { ...ctx(), api: vapi });
  }

  let brainOeffne: ((pfad: string) => void) | null = null;
  function mountBrainBereich(el: HTMLElement, pfad: string, vapi: ApiClient): () => void {
    el.innerHTML = `<div class="o-bereich-seite"><h1 class="o-titel">Brain</h1><div data-role="fach"></div></div>`;
    const ort = el.querySelector<HTMLElement>('[data-role="fach"]') as HTMLElement;
    const brain = mountBrain(ort, {
      api: vapi,
      pfad,
      oeffne: (p) => {
        globalThis.location.hash = schreibeWeg({ bereich: "brain", teil: p });
      },
    });
    brainOeffne = brain.lade;
    return brain.loesen;
  }

  // ---------------------------------------------------------------- Kuro
  function mountKuro(el: HTMLElement, vapi: ApiClient): () => void {
    el.innerHTML = `
      <section class="o-kuro">
        <div class="o-kuro__seite">
          <p class="o-kuro__datum" data-role="datum"></p>
          <h1 class="o-kuro__gruss" data-role="gruss"></h1>
          <div class="o-kuro__orb" data-role="orb" role="button" tabindex="0"
               aria-label="Mikrofon an- oder ausschalten"></div>
          <ul class="o-heute" data-role="heute" aria-label="Heute"></ul>
        </div>
        <div class="o-kuro__gespraech">
          <div class="o-kuro__faden" data-role="faden" aria-live="polite"></div>
          <p class="o-kuro__leer" data-role="leer">Fragen Sie Kuro etwas, oder halten Sie die Sprechtaste.</p>
          <form class="o-eingabe o-eingabe--gross" data-role="form">
            <textarea rows="1" name="text" placeholder="Kuro fragen" aria-label="Nachricht an Kuro"></textarea>
            <button type="button" class="o-eingabe__mikro" data-role="mikro" aria-label="Mikrofon an- oder ausschalten">${icon("mic")}</button>
            <button type="submit" class="o-eingabe__senden" aria-label="Senden">${SENDEN}</button>
          </form>
          <button type="button" class="o-kuro__leeren" data-role="leeren">Ansicht leeren</button>
        </div>
      </section>`;
    const r = <T extends Element>(rolle: string) =>
      el.querySelector<T>(`[data-role="${rolle}"]`) as T;
    const datum = r<HTMLElement>("datum");
    const grussEl = r<HTMLElement>("gruss");
    const zeit = () => {
      const d = new Date();
      datum.textContent = datumZeile(d);
      grussEl.textContent = gruss(d);
    };
    zeit();
    const uhr = globalThis.setInterval(zeit, 30_000);

    const form = r<HTMLFormElement>("form");
    verdrahte(form);
    const feld = form.querySelector("textarea") as HTMLTextAreaElement;

    const orbEl = r<HTMLElement>("orb");
    const sphaere: Sphaere = mountSphaere(orbEl, "");
    sphaere.setZustand(gespraech.zustand, gespraech.detail ?? undefined);
    for (const [wer, a] of gespraech.arbeit) {
      sphaere.bediensteterBeginnt(werName(wer), a.auftrag ?? undefined);
      sphaere.bediensteterStand(werName(wer), a.stand);
    }
    const eingabeLoesen = sphaere.bindeEingabe(feld);
    sphaere.beimAntippen(() => {
      opt.voice.toggle();
      orbEl.blur();
    });
    const orbAbo = gespraech.abonniere((s) => {
      if (s.art === "zustand") sphaere.setZustand(gespraech.zustand, gespraech.detail ?? undefined);
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
      api: vapi,
      gespraech,
      beiLeere: (istLeer) => {
        leer.hidden = !istLeer;
      },
    });
    const leeren = () => gespraech.leere();
    r<HTMLButtonElement>("leeren").addEventListener("click", leeren);

    void ladeHeute(r<HTMLElement>("heute"), vapi);
    if (!globalThis.matchMedia?.("(pointer: coarse)").matches) feld.focus({ preventScroll: true });

    return () => {
      globalThis.clearInterval(uhr);
      orbAbo();
      eingabeLoesen();
      fadenLoesen();
      sphaere.destroy();
    };
  }

  /** Drei Sätze über heute, jeder führt dorthin, wo er herkommt. Was nicht lädt, fehlt. */
  async function ladeHeute(ul: HTMLElement, vapi: ApiClient) {
    const zeilen: string[] = [];
    const [abo, nacht, post] = await Promise.allSettled([
      vapi.get<{ verfuegbar: boolean; fenster?: Array<{ id: string; prozent: number }> }>(
        "/integrations/abo",
      ),
      vapi.get<{ aufgaben: Array<{ id: string; titel: string; status: string }> }>(
        "/integrations/nachtbau",
      ),
      vapi.get<{ unreadCount: number }>("/integrations/mail"),
    ]);
    if (abo.status === "fulfilled" && abo.value.verfuegbar) {
      const w = abo.value.fenster?.find((f) => f.id === "woche");
      const s = abo.value.fenster?.find((f) => f.id === "sitzung");
      if (w && s)
        zeilen.push(
          `<li><a href="#/system">Abo: Sitzung ${Math.round(s.prozent)} %, Woche ${Math.round(w.prozent)} %</a></li>`,
        );
    }
    if (nacht.status === "fulfilled") {
      const naechste = nacht.value.aufgaben.find((a) => /^offen|^in Arbeit/.test(a.status));
      zeilen.push(
        `<li><a href="#/system">${naechste ? `Nachtbau: als Nächstes ${escapeHtml(naechste.id)}, ${escapeHtml(naechste.titel)}` : "Nachtbau: nichts offen"}</a></li>`,
      );
    }
    if (post.status === "fulfilled") {
      const n = post.value.unreadCount;
      zeilen.push(
        `<li><button type="button" data-frage="Was ist an Post gekommen?">${n === 0 ? "Keine ungelesene Post" : n === 1 ? "Eine ungelesene Mail" : `${n} ungelesene Mails`}</button></li>`,
      );
    }
    ul.innerHTML = zeilen.join("");
    ul.querySelector<HTMLButtonElement>("[data-frage]")?.addEventListener("click", (e) => {
      const frage = (e.currentTarget as HTMLElement).dataset.frage;
      if (frage) void gespraech.sende(frage);
    });
  }

  // ------------------------------------------------------------ Tasten
  globalThis.addEventListener("keydown", (e) => {
    const befehl = IST_MAC ? e.metaKey : e.ctrlKey;
    if (befehl && !e.altKey && !e.shiftKey) {
      if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (weg.bereich === "kuro") {
          flaeche.querySelector<HTMLTextAreaElement>(".o-eingabe--gross textarea")?.focus();
        } else oeffne(true);
        return;
      }
      const b = bereichFuerTaste(e.key);
      if (b) {
        e.preventDefault();
        globalThis.location.hash = schreibeWeg({ bereich: b, teil: null });
      }
      return;
    }
    if (e.key === "Escape" && offen) {
      schliesse();
      griff.focus();
    }
  });

  globalThis.addEventListener("hashchange", () => {
    void zeigeBereich(liesWeg(globalThis.location.hash));
  });
  void zeigeBereich(weg);

  globalThis.addEventListener("pagehide", () => {
    aufraeumen?.();
    inselFadenLoesen();
  });
}
