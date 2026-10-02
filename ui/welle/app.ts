import type { ApiClient } from "../api/client.js";
import type { EventBusClient } from "../events/bus.js";
import { icon } from "../icons.js";
import type { MicStateStore } from "../mic/state.js";
import {
  type RouteId,
  SETTINGS_SECTION_IDS,
  type SettingsSectionId,
  hashFor,
  parseHash,
} from "../router/router.js";
import {
  type KuronamiSettings,
  loadSettings,
  settingsBus,
  updateSettingsSection,
} from "../settings/store.js";
import { settingsView } from "../settings/view.js";
import { analysenView } from "../views/analysen.js";
import { calendarView } from "../views/calendar.js";
import { filesView } from "../views/files.js";
import { escapeHtml } from "../views/html.js";
import { mailView } from "../views/mail.js";
import { researchView } from "../views/research.js";
import { strategienView } from "../views/strategien.js";
import { systemView } from "../views/system.js";
import { tradingView } from "../views/trading.js";
import type { View, ViewContext } from "../views/types.js";
import { type Befehl, FRAGE_ID, rangiere } from "./befehle.js";
import { verfolge } from "./bereit.js";
import { mountFaden } from "./faden.js";
import { scrollFortschritt } from "./film-rechnung.js";
import { type Film, mountFilm } from "./film.js";
import { werName } from "./form.js";
import type { Gespraech } from "./gespraech.js";
import { kuroAnsicht } from "./kuro.js";
import { FILM_BILDER, SCHARFE_BILDER, STATIONEN, WEG, stationFuer } from "./stationen.js";
import { ZUSTAND_FARBE, ZUSTAND_SATZ, ZUSTAND_TON, laufzeit } from "./zustand.js";

/**
 * Die Welle — die zweite Oberfläche von Kuronami, neben der Präsenz (2026-09-26).
 *
 * Die Präsenz bleibt unter `/` stehen, wie sie ist; die Welle wohnt unter `/welle/` und teilt mit
 * ihr nur, was keine Gestalt hat: den Gateway-Client, den Ereignisstrom, die Sprachschicht, die
 * Anmeldung und die Fachansichten (Post, Märkte, System …), die hier in einem neuen Rahmen und
 * einem neuen Stil stehen (`raeume.css`). Neu sind der Rahmen, Kuros Seite, das Gespräch, „Dein
 * Tag", das Befehlsfeld und der Film.
 *
 * Drei Gedanken tragen sie:
 *
 * * **Jeder Bereich ist ein Ort.** Der Film zeigt eine Fahrt aus Kuros Raum hinaus auf die
 *   Terrasse; jeder Bereich liegt irgendwo auf diesem Weg (`stationen.ts`), und ein Wechsel
 *   blendet dorthin über. Die Leiste oben ist derselbe Weg.
 * * **Nur Kuro lebt.** Seit dem 2026-09-26 steht der Raum still — keine Kamerafahrt, keine
 *   Maus, die das Bild verschiebt, kein flimmerndes Korn. Was sich bewegt, ist Kuro: der Orb,
 *   seine Worte, der Punkt oben. Jakob wollte „den Fokus mehr auf Kuro" — gemeint war die
 *   Aufmerksamkeit, nicht die Mitte der Seite; die Anordnung blieb.
 * * **Zwei Stimmen, zwei Lichter.** Jakob spricht mit dem warmen Licht der Laterne, Kuro mit dem
 *   kühlen seines Zustands: am Orb, am Punkt oben, am Rand der Eingabe (`zustand.ts`). Den Film
 *   färbt es nur noch leicht.
 * * **Kuro ist überall einen Satz entfernt.** Die Eingabe steht in jedem Bereich unten; eine
 *   Antwort, die kommt, während man in den Märkten ist, erscheint dort in einem Blatt darüber.
 *   ⌘K öffnet ein Feld für alles, und was darin kein Befehl ist, geht an Kuro.
 */

const RAEUME: Record<Exclude<RouteId, "praesenz">, View> = {
  mail: mailView,
  calendar: calendarView,
  trading: tradingView,
  analysen: analysenView,
  strategien: strategienView,
  research: researchView,
  files: filesView,
  system: systemView,
  settings: settingsView,
};

const EINSTELLUNG_NAME: Record<SettingsSectionId, string> = {
  appearance: "Erscheinung",
  haushalt: "Haushalt",
  integrations: "Verbindungen",
  apiKeys: "API-Schlüssel",
  mcpServers: "MCP-Server",
  speech: "Sprache",
  system: "System und Token",
};

const STICHWORTE: Partial<Record<RouteId, string[]>> = {
  praesenz: ["kuro", "gespräch", "home", "start"],
  mail: ["mail", "e-mail", "postfach", "briefe"],
  calendar: ["termine", "calendar", "agenda"],
  trading: ["trading", "kurse", "börse", "chart", "markets"],
  analysen: ["berichte", "einschätzungen"],
  strategien: ["backtest", "regeln"],
  research: ["research", "suche", "funde"],
  files: ["artefakte", "notizen", "gedächtnis"],
  system: ["orchestrator", "limits", "abo", "token", "verbrauch", "personal", "läufe", "freigaben"],
  settings: ["settings", "optionen"],
};

const VORSCHLAEGE: Array<{ text: string; offen?: boolean }> = [
  { text: "Was ist an Post gekommen?" },
  { text: "Wie stehen die Märkte?" },
  { text: "Was steht heute an?" },
  { text: "Wie geht es dem Rechner?" },
  { text: "Recherchiere für mich: ", offen: true },
];

/** Wie weit der Film in den Bereichen zurücktritt, damit Tabellen und Zahlen lesbar bleiben. */
const DUNKEL_RAUM = 0.58;
const DUNKEL_KURO = 0.06;

const SENDEN_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg>`;

export interface WelleOptionen {
  root: HTMLElement;
  api: ApiClient;
  bus: EventBusClient;
  mic: MicStateStore;
  gespraech: Gespraech;
  voice: { toggle(): void };
  toast(text: string): void;
}

export function mountWelle(opt: WelleOptionen): void {
  const { root, api, bus, mic, gespraech } = opt;
  const start = parseHash(globalThis.location.hash);
  // Früh gesetzt: das Blatt und die Vorschläge fragen schon beim Aufbau danach.
  let aktuelleRoute: RouteId = start.view;

  root.innerHTML = `
    <canvas class="w-film" aria-hidden="true"></canvas>
    <div class="w-schleier" aria-hidden="true"></div>

    <header class="w-kopf">
      <a class="w-marke" href="#/praesenz" aria-label="Kuronami, zu Kuro">
        <span class="w-marke__kanji" aria-hidden="true">黒波</span><span class="w-marke__wort">Kuronami</span>
      </a>
      <nav class="w-weg" aria-label="Bereiche">
        <ol class="w-weg__liste">
          ${WEG.map(
            (s) =>
              `<li><a class="w-weg__ort" data-route="${s.route}" href="#/${s.route}">${escapeHtml(s.name)}</a></li>`,
          ).join("")}
          <li><a class="w-weg__ort w-weg__ort--os" href="/os/" title="Trading, Brain und System in Kuro OS">Kuro OS</a></li>
        </ol>
        <span class="w-weg__licht" aria-hidden="true"></span>
      </nav>
      <div class="w-kopf__rechts">
        <button type="button" class="w-lage" data-role="lage" aria-expanded="false" aria-controls="w-haus">
          <span class="w-lage__punkt" aria-hidden="true"></span>
          <span class="w-lage__text" data-role="lage-text">Kuro ist da</span>
          <span class="w-lage__zahl" data-role="lage-zahl" hidden></span>
        </button>
        <button type="button" class="w-rund" data-role="suche" aria-label="Befehlsfeld öffnen (⌘K)" title="Befehlsfeld (⌘K)">
          <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="9" cy="9" r="5.5"/><path d="M13.2 13.2 17 17"/></svg>
        </button>
        <a class="w-rund" data-route="settings" href="#/settings" aria-label="Einstellungen" title="Einstellungen">${icon("settings")}</a>
        <button type="button" class="w-rund w-menue-knopf" data-role="menue" aria-label="Bereiche öffnen" aria-expanded="false" aria-controls="w-menue">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M5 9h14M5 15h9"/></svg>
        </button>
      </div>
    </header>

    <section class="w-haus" id="w-haus" data-role="haus" hidden aria-label="Wer gerade arbeitet"></section>

    <nav class="w-menue" id="w-menue" data-role="menue-blatt" hidden aria-label="Bereiche">
      <ol>
        ${WEG.map(
          (s) =>
            `<li><a data-route="${s.route}" href="#/${s.route}">${escapeHtml(s.name)}</a></li>`,
        ).join("")}
        <li><a href="/os/">Kuro OS</a></li>
      </ol>
    </nav>

    <main class="w-buehne" data-role="buehne"></main>

    <div class="w-leiste" data-role="leiste">
      <section class="w-blatt" data-role="blatt" hidden aria-label="Kuros letzte Antwort">
        <header class="w-blatt__kopf">
          <span class="w-blatt__wer">Kuro</span>
          <a class="w-blatt__link" href="#/praesenz">Zum Gespräch</a>
          <button type="button" class="w-blatt__zu" data-role="blatt-zu" aria-label="Blatt schließen">${icon("close")}</button>
        </header>
        <div class="w-blatt__faden" data-role="blatt-faden"></div>
      </section>
      <div class="w-vorschlaege" data-role="vorschlaege">
        ${VORSCHLAEGE.map((v, i) => `<button type="button" class="w-vorschlag" data-vorschlag="${i}">${escapeHtml(v.text.replace(/: $/, " …"))}</button>`).join("")}
      </div>
      <form class="w-eingabe" data-role="eingabe-form">
        <button type="button" class="w-eingabe__mikro" data-role="mikro" aria-label="Mit Kuro sprechen" aria-pressed="false">${icon("mic")}</button>
        <textarea class="w-eingabe__feld" data-role="eingabe" rows="1"
                  placeholder="Sag Kuro, was du brauchst" aria-label="Nachricht an Kuro"
                  autocomplete="off" enterkeyhint="send"></textarea>
        <button type="submit" class="w-eingabe__senden" data-role="senden" aria-label="An Kuro senden">${SENDEN_SVG}</button>
      </form>
    </div>

    <div class="w-befehle" data-role="befehle" hidden>
      <div class="w-befehle__feld" role="dialog" aria-modal="true" aria-label="Befehlsfeld">
        <input class="w-befehle__eingabe" data-role="befehle-eingabe" type="text" autocomplete="off"
               spellcheck="false" placeholder="Wohin, oder was soll Kuro tun?"
               role="combobox" aria-expanded="true" aria-controls="w-befehle-liste" aria-autocomplete="list">
        <ul class="w-befehle__liste" id="w-befehle-liste" data-role="befehle-liste" role="listbox"></ul>
        <p class="w-befehle__fuss">↑ ↓ wählen, Enter ausführen, Esc schließen</p>
      </div>
    </div>
  `;

  const q = <T extends Element>(rolle: string): T => {
    const el = root.querySelector<T>(`[data-role="${rolle}"]`);
    if (!el) throw new Error(`Die Welle hat kein Element „${rolle}".`);
    return el;
  };
  const canvas = root.querySelector<HTMLCanvasElement>(".w-film");
  if (!canvas) throw new Error("Die Welle hat keine Leinwand für den Film.");
  const buehne = q<HTMLElement>("buehne");
  const eingabe = q<HTMLTextAreaElement>("eingabe");
  const form = q<HTMLFormElement>("eingabe-form");
  const mikro = q<HTMLButtonElement>("mikro");
  const blatt = q<HTMLElement>("blatt");
  const vorschlaege = q<HTMLElement>("vorschlaege");
  const lage = q<HTMLButtonElement>("lage");
  const lageText = q<HTMLElement>("lage-text");
  const lageZahl = q<HTMLElement>("lage-zahl");
  const haus = q<HTMLElement>("haus");
  const befehle = q<HTMLElement>("befehle");
  const befehleEingabe = q<HTMLInputElement>("befehle-eingabe");
  const befehleListe = q<HTMLElement>("befehle-liste");
  const menueKnopf = q<HTMLButtonElement>("menue");
  const menue = q<HTMLElement>("menue-blatt");
  const weg = root.querySelector<HTMLElement>(".w-weg");
  const wegLicht = root.querySelector<HTMLElement>(".w-weg__licht");

  // -------------------------------------------------------------- Film
  // Große Bilder nur dort, wo man sie sieht: ein breites Fenster an einem Rechner. Auf dem
  // Telefon schneidet das Hochformat ohnehin drei Viertel der Breite weg.
  const grob = globalThis.matchMedia?.("(pointer: coarse)").matches ?? false;
  const dpr = globalThis.devicePixelRatio || 1;
  const breit = globalThis.innerWidth * dpr >= 1700;
  // Wie breit das Bild auf dem Schirm wirklich wird: im Querformat so breit wie das Fenster, auf
  // einem Hochformat so breit, wie die Höhe es verlangt (das Bild füllt die Fläche, 16:9).
  const bildBreite = Math.max(globalThis.innerWidth, (globalThis.innerHeight * 16) / 9) * dpr;
  const film: Film = mountFilm(canvas, {
    ordner: grob || !breit ? "./film/sd/" : "./film/hd/",
    anzahl: FILM_BILDER,
    bildB: 16,
    bildH: 9,
    start: stationFuer(start.view).ort,
    // Im Stand ein scharfes Bild: 4K ab gut 2400 Pixeln Breite (UWQHD, 4K, Retina), sonst 1920.
    // Das Telefon bekommt nie 4K — Safari hielte die entpackten Bilder nicht.
    scharf: {
      ordner: !grob && bildBreite > 2400 ? "./film/scharf/4k/" : "./film/scharf/2k/",
      bilder: SCHARFE_BILDER,
    },
  });
  film.setzeDunkel(start.view === "praesenz" ? DUNKEL_KURO : DUNKEL_RAUM);

  // ------------------------------------------------------ Kuros Licht
  const zeigeLage = (): void => {
    const z = gespraech.zustand;
    const farbe = ZUSTAND_FARBE[z];
    document.documentElement.style.setProperty("--kuro", farbe);
    document.documentElement.dataset.kuro = z;
    film.setzeTon(farbe, ZUSTAND_TON[z]);
    lageText.textContent = ZUSTAND_SATZ[z];
    lage.title = gespraech.detail ? `${ZUSTAND_SATZ[z]}: ${gespraech.detail}` : ZUSTAND_SATZ[z];
    const n = gespraech.arbeit.size;
    lageZahl.hidden = n === 0;
    lageZahl.textContent = n === 1 ? "1 im Auftrag" : `${n} im Auftrag`;
    mikro.classList.toggle("ist-an", z === "zuhoeren");
    mikro.setAttribute("aria-pressed", String(z === "zuhoeren"));
  };

  const zeichneHaus = (): void => {
    if (haus.hidden) return;
    const jetzt = Date.now();
    const zeilen = [...gespraech.arbeit.entries()]
      .map(
        ([wer, a]) => `
          <li><span class="w-haus__wer">${escapeHtml(werName(wer))}</span>
            <span class="w-haus__zeit">seit ${laufzeit(a.seit, jetzt)}</span>
            <span class="w-haus__stand">${escapeHtml(a.stand)}</span></li>`,
      )
      .join("");
    haus.innerHTML = `
      <p class="w-haus__satz">${escapeHtml(ZUSTAND_SATZ[gespraech.zustand])}${gespraech.detail ? `: ${escapeHtml(gespraech.detail)}` : "."}</p>
      ${zeilen ? `<ul class="w-haus__liste">${zeilen}</ul>` : `<p class="w-haus__leer">Kein Bediensteter hat gerade einen Auftrag.</p>`}
      <a class="w-haus__link" href="#/system">Abo, Verbrauch und Personal</a>`;
  };
  const oeffneHaus = (an: boolean): void => {
    haus.hidden = !an;
    lage.setAttribute("aria-expanded", String(an));
    zeichneHaus();
  };
  lage.addEventListener("click", () => oeffneHaus(haus.hidden));
  globalThis.setInterval(() => {
    if (!haus.hidden && gespraech.arbeit.size > 0) zeichneHaus();
  }, 1000);

  gespraech.abonniere((s) => {
    if (s.art === "zustand" || s.art === "arbeit") {
      zeigeLage();
      zeichneHaus();
    }
    if (s.art === "verlauf") zeigeVorschlaege();
  });
  zeigeLage();

  // ------------------------------------------------------- Eingabe
  const wachse = (): void => {
    eingabe.style.height = "auto";
    eingabe.style.height = `${Math.min(eingabe.scrollHeight, 160)}px`;
    form.classList.toggle("ist-mehrzeilig", eingabe.scrollHeight > 48);
    zeigeVorschlaege();
  };
  const sende = (text?: string): void => {
    const inhalt = (text ?? eingabe.value).trim();
    if (!inhalt) return;
    if (gespraech.unterwegs) {
      opt.toast("Kuro antwortet noch auf die letzte Frage.");
      return;
    }
    eingabe.value = "";
    wachse();
    // Im Bereich unterwegs: das Blatt zeigt, was Kuro antwortet, ohne dass man den Bereich
    // verlassen muss.
    blattGeschlossen = false;
    void gespraech.sende(inhalt);
  };
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    sende();
  });
  eingabe.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sende();
    }
  });
  eingabe.addEventListener("input", wachse);
  eingabe.addEventListener("focus", zeigeVorschlaege);
  eingabe.addEventListener("blur", () => globalThis.setTimeout(zeigeVorschlaege, 150));

  const zuhoeren = (): void => opt.voice.toggle();
  mikro.addEventListener("click", zuhoeren);

  function zeigeVorschlaege(): void {
    const aufKuro = aktuelleRoute === "praesenz";
    const leer = eingabe.value.length === 0;
    const gespraechLeer = gespraech.verlauf.eintraege.length === 0;
    // Auf Kuros Seite stehen sie, solange das Gespräch leer ist; sonst nur, wenn man ins leere
    // Feld tippt. Mitten im Lesen einer Tabelle wären sie Lärm.
    vorschlaege.hidden = !leer || !(aufKuro ? gespraechLeer : document.activeElement === eingabe);
  }
  vorschlaege.addEventListener("click", (e) => {
    const knopf = (e.target as Element | null)?.closest<HTMLButtonElement>("[data-vorschlag]");
    const v = knopf ? VORSCHLAEGE[Number(knopf.dataset.vorschlag)] : undefined;
    if (!v) return;
    if (v.offen) {
      eingabe.value = v.text;
      eingabe.focus();
      eingabe.setSelectionRange(v.text.length, v.text.length);
      wachse();
    } else {
      sende(v.text);
    }
  });

  // -------------------------------------------------- Blatt in Räumen
  let blattGeschlossen = true;
  let blattLeer = true;
  const zeigeBlatt = (): void => {
    blatt.hidden = aktuelleRoute === "praesenz" || blattGeschlossen || blattLeer;
  };
  mountFaden(q<HTMLElement>("blatt-faden"), {
    api,
    gespraech,
    nurLetzte: true,
    beiLeere: (leer) => {
      blattLeer = leer;
      zeigeBlatt();
    },
  });
  q<HTMLButtonElement>("blatt-zu").addEventListener("click", () => {
    blattGeschlossen = true;
    zeigeBlatt();
  });
  // Eine neue Antwort, eine Rückfrage oder eine Tafel öffnen das Blatt wieder — wer es
  // geschlossen hat, wollte die letzte nicht mehr sehen, nicht die nächste.
  // Was beim Laden schon im Verlauf steht (er kommt aus dem Seitenspeicher), gilt als gesehen.
  // Bis 2026-09-26 begann der Vergleich bei „nichts": der erste Abgleich mit dem Gateway meldete
  // denselben Verlauf noch einmal, und Kuros letzte Antwort — auch eine Stunden alte — legte sich
  // nach jedem Neuladen über den Bereich. Aufgehen soll das Blatt für das, was neu ist: eine
  // Antwort, eine Rückfrage, eine Tafel.
  const abdruckVon = (): string => {
    const letzte = gespraech.verlauf.eintraege.at(-1);
    return letzte ? `${letzte.id}:${letzte.rueckfrage?.askId ?? ""}:${letzte.tafeln.length}` : "";
  };
  let zuletztGesehen = abdruckVon();
  gespraech.abonniere((s) => {
    if (s.art !== "verlauf") return;
    const letzte = gespraech.verlauf.eintraege.at(-1);
    const abdruck = abdruckVon();
    if (abdruck !== zuletztGesehen && letzte?.von === "kuro") {
      zuletztGesehen = abdruck;
      blattGeschlossen = false;
    }
    zeigeBlatt();
  });

  // ---------------------------------------------------------- Menü
  const oeffneMenue = (an: boolean): void => {
    menue.hidden = !an;
    menueKnopf.setAttribute("aria-expanded", String(an));
    document.body.classList.toggle("ist-menue-offen", an);
    if (an) menue.querySelector<HTMLElement>("a.ist-aktiv, a")?.focus({ preventScroll: true });
  };
  menueKnopf.addEventListener("click", () => oeffneMenue(menue.hidden));
  menue.addEventListener("click", (e) => {
    if ((e.target as Element | null)?.closest("a")) oeffneMenue(false);
  });

  // ------------------------------------------------------- Befehle
  const alleBefehle = (): Array<Befehl & { tu(): void }> => [
    ...STATIONEN.filter((s) => s.route !== "settings").map((s) => ({
      id: `ort:${s.route}`,
      titel: s.name,
      art: "ort" as const,
      stichworte: STICHWORTE[s.route] ?? [],
      tu: () => navigate(s.route),
    })),
    ...SETTINGS_SECTION_IDS.map((sec) => ({
      id: `einstellung:${sec}`,
      titel: `Einstellungen: ${EINSTELLUNG_NAME[sec]}`,
      art: "einstellung" as const,
      stichworte: ["einstellungen", "settings", ...(STICHWORTE.settings ?? [])],
      tu: () => navigate("settings", sec),
    })),
    {
      id: "aktion:mikro",
      titel: mic.state === "listening" ? "Mikrofon aus" : "Mit Kuro sprechen",
      art: "aktion" as const,
      stichworte: ["mikrofon", "stimme", "sprechen", "zuhören"],
      tu: zuhoeren,
    },
    {
      id: "aktion:ruhe",
      titel: document.body.dataset.fokus === "an" ? "Alles wieder zeigen" : "Nur den Film zeigen",
      art: "aktion" as const,
      stichworte: ["fokus", "ruhe", "ausblenden"],
      tu: toggleFocus,
    },
    {
      id: "aktion:leeren",
      titel: "Gesprächsverlauf hier leeren",
      art: "aktion" as const,
      stichworte: ["verlauf", "neu", "löschen"],
      tu: () => {
        gespraech.leere();
        opt.toast("Der Verlauf ist hier geleert. Kuros Gedächtnis beim Gateway bleibt.");
      },
    },
    {
      id: "aktion:praesenz",
      titel: "Oberfläche: Standard",
      art: "aktion" as const,
      stichworte: ["alte", "oberfläche", "präsenz", "zurück"],
      tu: () => {
        updateSettingsSection("appearance", { oberflaeche: "standard" });
        globalThis.location.href = `../${globalThis.location.hash}`;
      },
    },
  ];
  let treffer: Array<Befehl & { tu?(): void }> = [];
  let gewaehlt = 0;
  const ART_NAME = {
    ort: "Bereich",
    einstellung: "Einstellung",
    aktion: "Aktion",
    frage: "Kuro fragen",
  };
  const zeichneBefehle = (): void => {
    const alle = alleBefehle();
    treffer = rangiere(alle, befehleEingabe.value).map((b) =>
      b.id === FRAGE_ID ? b : (alle.find((x) => x.id === b.id) ?? b),
    );
    gewaehlt = Math.min(gewaehlt, Math.max(0, treffer.length - 1));
    befehleListe.innerHTML = treffer
      .map(
        (b, i) => `
          <li id="w-befehl-${i}" role="option" aria-selected="${i === gewaehlt}" class="w-befehl w-befehl--${b.art}${i === gewaehlt ? " ist-gewaehlt" : ""}" data-index="${i}">
            <span class="w-befehl__titel">${escapeHtml(b.titel)}</span>
            <span class="w-befehl__art">${ART_NAME[b.art]}</span>
          </li>`,
      )
      .join("");
    befehleEingabe.setAttribute("aria-activedescendant", `w-befehl-${gewaehlt}`);
    befehleListe.querySelector(".ist-gewaehlt")?.scrollIntoView({ block: "nearest" });
  };
  const fuehreAus = (b: (typeof treffer)[number] | undefined): void => {
    if (!b) return;
    oeffneBefehle(false);
    if (b.id === FRAGE_ID) sende(b.titel);
    else b.tu?.();
  };
  let vorherFokus: HTMLElement | null = null;
  function oeffneBefehle(an: boolean): void {
    if (an === !befehle.hidden) return;
    befehle.hidden = !an;
    if (an) {
      vorherFokus = document.activeElement as HTMLElement | null;
      befehleEingabe.value = "";
      gewaehlt = 0;
      zeichneBefehle();
      befehleEingabe.focus();
    } else {
      vorherFokus?.focus?.({ preventScroll: true });
    }
  }
  q<HTMLButtonElement>("suche").addEventListener("click", () => oeffneBefehle(true));
  befehleEingabe.addEventListener("input", () => {
    gewaehlt = 0;
    zeichneBefehle();
  });
  befehleEingabe.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = treffer.length;
      if (n === 0) return;
      gewaehlt = (gewaehlt + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      zeichneBefehle();
    } else if (e.key === "Enter") {
      e.preventDefault();
      fuehreAus(treffer[gewaehlt]);
    }
  });
  befehleListe.addEventListener("click", (e) => {
    const li = (e.target as Element | null)?.closest<HTMLElement>("[data-index]");
    if (li) fuehreAus(treffer[Number(li.dataset.index)]);
  });
  befehle.addEventListener("click", (e) => {
    if (e.target === befehle) oeffneBefehle(false);
  });

  // ----------------------------------------------------------- Tasten
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      oeffneBefehle(befehle.hidden);
      return;
    }
    if (e.key === "Escape") {
      if (!befehle.hidden) oeffneBefehle(false);
      else if (!menue.hidden) oeffneMenue(false);
      else if (!haus.hidden) oeffneHaus(false);
      else if (document.body.dataset.fokus === "an") toggleFocus();
      return;
    }
    const tippt =
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement ||
      e.target instanceof HTMLSelectElement ||
      (e.target instanceof HTMLElement && e.target.isContentEditable);
    if (e.key === "/" && !tippt) {
      e.preventDefault();
      eingabe.focus();
    }
  });
  document.addEventListener("click", (e) => {
    const ziel = e.target as Element | null;
    if (!haus.hidden && !ziel?.closest(".w-haus, .w-lage")) oeffneHaus(false);
  });

  // ------------------------------------------------------ Erscheinung
  // Aus den Einstellungen gilt hier, was eine Bedeutung hat: die Dichte und eine eigene
  // Akzentfarbe. Die Farbableitung aus dem Raumbild der Präsenz nicht — die Welle hat ihre
  // Farben aus dem Film und aus Kuros Zustand.
  const wendeAn = (s: KuronamiSettings): void => {
    document.body.dataset.density = s.appearance.density;
    if (s.appearance.accentOverride) {
      document.documentElement.style.setProperty("--accent", s.appearance.accentOverride);
    } else {
      document.documentElement.style.removeProperty("--accent");
    }
  };
  wendeAn(loadSettings());
  settingsBus.subscribe(wendeAn);

  // ---------------------------------------------------------- Router
  function navigate(route: RouteId, section?: SettingsSectionId): void {
    globalThis.location.hash = hashFor(route, section);
  }
  function toggleFocus(): void {
    document.body.dataset.fokus = document.body.dataset.fokus === "an" ? "aus" : "an";
  }

  const kuro = kuroAnsicht({ api, gespraech, eingabe, zuhoeren });
  let aufraeumen: (() => void) | null = null;
  /** Bereiche, die gerade ausblenden oder übersprungen wurden — aufgeräumt, wenn sie verschwinden. */
  const gehend: Array<() => void> = [];
  let kuroScroll = 0;
  let wechsel = 0;

  const setzeWeg = (route: RouteId): void => {
    for (const a of root.querySelectorAll<HTMLElement>("[data-route]")) {
      const aktiv = a.dataset.route === route;
      a.classList.toggle("ist-aktiv", aktiv);
      if (aktiv) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
    // Das Licht fährt unter die aktive Station — dieselbe Fahrt wie die Kamera, im Kleinen.
    const ort = weg?.querySelector<HTMLElement>(`.w-weg__ort[data-route="${route}"]`);
    if (wegLicht && weg) {
      if (ort) {
        const w = weg.getBoundingClientRect();
        const o = ort.getBoundingClientRect();
        wegLicht.style.setProperty("--x", `${o.left - w.left + o.width / 2}px`);
        wegLicht.style.opacity = "1";
      } else {
        wegLicht.style.opacity = "0";
      }
    }
  };

  const ctx = (section?: SettingsSectionId): ViewContext => ({
    api,
    bus,
    mic,
    navigate,
    toggleFocus,
    section,
    voice: opt.voice,
  });

  const zeigeRoute = (): void => {
    const ziel = parseHash(globalThis.location.hash);
    const vorher = aktuelleRoute;
    if (vorher === "praesenz" && aufraeumen) kuroScroll = globalThis.scrollY;
    aktuelleRoute = ziel.view;
    document.body.dataset.route = ziel.view;
    setzeWeg(ziel.view);
    oeffneMenue(false);
    zeigeBlatt();
    zeigeVorschlaege();

    const station = stationFuer(ziel.view);
    film.setzeDunkel(ziel.view === "praesenz" ? DUNKEL_KURO : DUNKEL_RAUM);
    // Die Kamera fährt mit dem Klick los, nicht erst, wenn der alte Bereich ausgeblendet ist —
    // sonst hinkt sie dem Inhalt hinterher.
    film.fahre(station.ort);

    const nr = ++wechsel;
    // Der alte Bereich blendet aus, während der neue schon unsichtbar entsteht und lädt. Gezeigt
    // wird er erst, wenn beides fertig ist: die Ausblende und seine ersten Antworten (`bereit.ts`).
    // Vorher blendete er leer ein und füllte sich sichtbar — Karten und Tabellen sprangen mitten in
    // der Blende auf ihre Größe. Innerhalb der Einstellungen (anderer Abschnitt) gibt es keinen
    // Abschied, nur der Inhalt wechselt.
    const alt = buehne.firstElementChild;
    const abschied = alt !== null && vorher !== ziel.view;
    // Aufgeräumt wird ein Bereich erst, wenn er wirklich verschwindet: mehrere Ansichten leeren
    // dabei ihre Listen, und das sähe man sonst mitten in der Ausblende.
    if (aufraeumen) gehend.push(aufraeumen);
    aufraeumen = null;
    if (abschied) {
      alt.classList.add("ist-gehend");
    } else {
      buehne.replaceChildren();
      for (const weg of gehend.splice(0)) weg();
    }

    const huelle = document.createElement("div");
    huelle.className =
      ziel.view === "praesenz" ? "w-seite w-seite--kuro" : `w-seite w-raum w-raum--${ziel.view}`;
    huelle.classList.add("ist-kommend");
    if (abschied) huelle.classList.add("ist-wartend");
    buehne.append(huelle);

    let bereit: Promise<void> = Promise.resolve();
    if (ziel.view === "praesenz") {
      aufraeumen = kuro.mount(huelle, ctx());
    } else {
      const inhalt = document.createElement("div");
      inhalt.className = "w-raum__inhalt";
      huelle.append(inhalt);
      const verfolgt = verfolge(api);
      aufraeumen = RAEUME[ziel.view].mount(inhalt, { ...ctx(ziel.section), api: verfolgt.api });
      bereit = verfolgt.bereit();
      // Die Ansichten tragen ihre Namen aus der Präsenz („Mail", „Trading"). In der Welle heißt
      // jeder Bereich so, wie der Weg oben ihn nennt — ein Ort, ein Name.
      const titel = inhalt.querySelector<HTMLElement>(".detail-view__title");
      if (titel) {
        titel.textContent = station.name;
      } else {
        // Die Einstellungen haben keinen eigenen Kopf; in der Welle bekommen sie denselben.
        const kopf = document.createElement("header");
        kopf.className = "detail-view__head w-raum__kopf";
        kopf.innerHTML = `<div><h1 class="detail-view__title">${escapeHtml(station.name)}</h1></div>`;
        inhalt.prepend(kopf);
      }
    }

    const ausgeblendet = abschied
      ? new Promise<void>((los) => globalThis.setTimeout(los, 120))
      : Promise.resolve();
    void Promise.all([bereit, ausgeblendet]).then(() => {
      // Inzwischen woanders hingeklickt: dieser Bereich kommt nicht mehr dran. Seine Hülle räumt
      // der nächste Wechsel mit ab.
      if (nr !== wechsel) return;
      for (const kind of [...buehne.children]) if (kind !== huelle) kind.remove();
      for (const weg of gehend.splice(0)) weg();
      huelle.classList.remove("ist-wartend");
      globalThis.scrollTo({
        top: ziel.view === "praesenz" ? kuroScroll : 0,
        behavior: "instant",
      });
      beimScrollen();
      requestAnimationFrame(() =>
        requestAnimationFrame(() => huelle.classList.remove("ist-kommend")),
      );
    });
  };

  // Scrollen bewegt den Film nicht — er steht an seinem Ort. Auf Kuros Seite tritt er nur
  // zurück, je weiter man zu „Dein Tag" hinunterkommt, damit die Zeilen tragen.
  let scrollPlan = 0;
  const beimScrollen = (): void => {
    scrollPlan = 0;
    // Sobald etwas unter die Leiste oben rutscht, bekommt sie einen Grund.
    document.body.classList.toggle("ist-gescrollt", globalThis.scrollY > 8);
    const unten = aktuelleRoute === "praesenz" && globalThis.scrollY > globalThis.innerHeight * 0.5;
    document.body.classList.toggle("ist-unten", unten);
    if (aktuelleRoute !== "praesenz") return;
    const p = scrollFortschritt(
      globalThis.scrollY,
      document.documentElement.scrollHeight,
      globalThis.innerHeight,
    );
    film.setzeDunkel(DUNKEL_KURO + p * 0.45);
  };
  globalThis.addEventListener(
    "scroll",
    () => {
      if (!scrollPlan) scrollPlan = requestAnimationFrame(beimScrollen);
    },
    { passive: true },
  );
  globalThis.addEventListener("resize", () => setzeWeg(aktuelleRoute));
  globalThis.addEventListener("hashchange", zeigeRoute);
  if (!globalThis.location.hash) globalThis.location.hash = hashFor("praesenz");
  else zeigeRoute();
  // Die Schrift der Leiste lädt nach; erst dann stimmt die Lage des Lichts.
  void document.fonts?.ready.then(() => setzeWeg(aktuelleRoute));
}
