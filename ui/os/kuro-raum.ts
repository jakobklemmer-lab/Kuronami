import type { ApiClient } from "../api/client.js";
import type { CalendarData, MailData } from "../integrations/types.js";
import { type Sphaere, mountSphaere } from "../praesenz/sphaere.js";
import { escapeHtml } from "../views/html.js";
import type { NachtbauStand } from "../views/system.js";
import { mountFaden } from "../welle/faden.js";
import { datumZeile, gruss, werName } from "../welle/form.js";
import type { Gespraech } from "../welle/gespraech.js";
import { fehlerSatz } from "../welle/tafeln.js";
import { eingabeHtml, verdrahteEingabe } from "./eingabe.js";
import { LAGE, orbVor } from "./fensterbild.js";
import {
  type AboDaten,
  type HeuteQuelle,
  aboSatz,
  kalenderSatz,
  nachtbauSatz,
  postSatz,
} from "./heute.js";

/**
 * Der Raum Kuro, Kuros Empfang und der Desktop von Kuro OS: links Kuro vor dem Fenster seines
 * Zimmers, darunter Gruß, „Heute" und „Im Haus"; rechts das ganze Gespräch.
 */

export type RaumZiel = "kalender" | "post" | "system";

export interface KuroRaumOptionen {
  api: ApiClient;
  gespraech: Gespraech;
  voice: { toggle(): void };
  /** Der eine Orb des Desktops; geht ein Raum auf, gleitet er in Kuros Platz. */
  orb: HTMLElement;
  motto: string;
  toast(text: string): void;
  oeffne(ziel: RaumZiel): void;
}

export interface KuroRaum {
  sphaere: Sphaere;
  feld: HTMLTextAreaElement;
  /** Für „Im Haus"; solange er leer ist, bleibt er unsichtbar. */
  imHaus: HTMLElement;
  /** „Heute" neu laden — höchstens einmal je Minute, etwa bei der Rückkehr zu Kuro. */
  auffrischen(): void;
  loesen(): void;
}

const QUELLEN: ReadonlyArray<[HeuteQuelle, string]> = [
  ["kalender", "/integrations/calendar"],
  ["post", "/integrations/mail"],
  ["nachtbau", "/integrations/nachtbau"],
  ["abo", "/integrations/abo"],
];

const POST_FRAGE = "Was ist in der ungelesenen Post wichtig?";

type Stand = { ok: true; daten: unknown } | { ok: false; fehler: string };

interface Zeile {
  text: string;
  ziel: string;
  knapp?: boolean;
  tun: () => void;
}

export function mountKuroRaum(el: HTMLElement, opt: KuroRaumOptionen): KuroRaum {
  const { api, gespraech, orb } = opt;
  el.classList.add("e-raum");
  el.innerHTML = `
    <div class="e-links">
      <div class="e-bild" data-role="e-bild" aria-hidden="true"></div>
      <div class="e-unten">
        <header class="e-gruss">
          <p class="e-gruss__datum" data-role="e-datum"></p>
          <h1 class="e-gruss__text" data-role="e-gruss"></h1>
        </header>
        <div class="e-tafeln">
          <section class="e-heute" aria-labelledby="e-heute-titel">
            <h2 class="e-titel" id="e-heute-titel">Heute</h2>
            <ul class="e-heute__liste" data-role="e-heute">
              ${QUELLEN.map(([q]) => `<li data-quelle="${q}" hidden></li>`).join("")}
            </ul>
          </section>
          <section class="e-imhaus" data-role="e-imhaus" aria-label="Im Haus"></section>
        </div>
      </div>
    </div>
    <section class="e-gespraech" aria-label="Gespräch">
      <h2 class="e-titel">Gespräch</h2>
      <div class="e-faden" data-role="e-faden" aria-live="polite"></div>
      <p class="e-leer" data-role="e-leer" hidden>Fragen Sie Kuro etwas, oder halten Sie die Sprechtaste.</p>
      ${eingabeHtml("e-form", "o-eingabe--gross")}
      <footer class="e-gespraech__fuss">
        <button type="button" class="o-leise" data-role="e-leeren" title="Leert nur diese Ansicht — Kuro erinnert sich weiter.">Ansicht leeren</button>
      </footer>
    </section>`;

  const q = <T extends Element>(rolle: string): T => {
    const e = el.querySelector<T>(`[data-role="${rolle}"]`);
    if (!e) throw new Error(`Raum Kuro: ${rolle} fehlt.`);
    return e;
  };
  const bild = q<HTMLElement>("e-bild");
  const heuteEl = q<HTMLElement>("e-heute");
  const fadenEl = q<HTMLElement>("e-faden");
  const leerEl = q<HTMLElement>("e-leer");
  const feld = verdrahteEingabe(q<HTMLFormElement>("e-form"), opt);
  q<HTMLButtonElement>("e-leeren").addEventListener("click", () => gespraech.leere());

  // ---------------------------------------------------------- Fenster und Orb
  bild.style.backgroundPosition = `${LAGE.x * 100}% ${LAGE.y * 100}%`;
  const untenEl = el.querySelector(".e-unten") as HTMLElement;
  const setzeOrb = () => {
    const r = bild.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    // Auf schmalen Schirmen fehlen Gruß und „Heute"; dann endet der Orb mit dem Bild.
    const u = untenEl.getBoundingClientRect();
    const o = orbVor(
      { links: r.left, oben: r.top, breite: r.width, hoehe: r.height },
      { rechts: r.right, unten: u.height > 0 ? u.top : r.bottom },
    );
    orb.style.setProperty("--orb-l", `${o.links.toFixed(1)}px`);
    orb.style.setProperty("--orb-t", `${o.oben.toFixed(1)}px`);
    orb.style.setProperty("--orb-s", `${o.breite.toFixed(1)}px`);
  };
  const beobachter = new ResizeObserver(setzeOrb);
  beobachter.observe(bild);
  setzeOrb();

  const sphaere = mountSphaere(orb, opt.motto);
  for (const [wer, a] of gespraech.arbeit) {
    sphaere.bediensteterBeginnt(werName(wer), a.auftrag ?? undefined);
    sphaere.bediensteterStand(werName(wer), a.stand);
  }
  const eingabeLoesen = sphaere.bindeEingabe(feld);
  sphaere.beimAntippen(() => {
    opt.voice.toggle();
    orb.blur();
  });
  orb.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    opt.voice.toggle();
  });
  const zeigeZustand = () => {
    sphaere.setZustand(gespraech.zustand, gespraech.detail ?? undefined);
    orb.setAttribute("aria-pressed", String(gespraech.zustand === "zuhoeren"));
  };
  zeigeZustand();
  const abo = gespraech.abonniere((s) => {
    if (s.art === "zustand") zeigeZustand();
    else if (s.art === "impuls") sphaere.impuls(s.staerke);
    else if (s.art === "bediensteter") {
      if (s.was === "beginnt") sphaere.bediensteterBeginnt(werName(s.wer), s.text || undefined);
      else if (s.was === "stand") sphaere.bediensteterStand(werName(s.wer), s.text);
      else sphaere.bediensteterFertig(werName(s.wer));
    } else if (s.art === "fertig" && gespraech.zustand === "ruhe") sphaere.fertig();
  });

  // -------------------------------------------------------------- Gespräch
  const fadenLoesen = mountFaden(fadenEl, {
    api,
    gespraech,
    beiLeere: (leer) => {
      leerEl.hidden = !leer;
    },
  });
  fadenEl.scrollTop = fadenEl.scrollHeight;

  // ------------------------------------------------------------------ Gruß
  const datumEl = q<HTMLElement>("e-datum");
  const grussEl = q<HTMLElement>("e-gruss");
  const zeigeGruss = () => {
    const d = new Date();
    datumEl.textContent = datumZeile(d);
    grussEl.textContent = gruss(d);
  };

  // ----------------------------------------------------------------- Heute
  let weg = false;
  const stand = new Map<HeuteQuelle, Stand>();

  const zeile = (quelle: HeuteQuelle, s: Stand, jetzt: Date): Zeile => {
    const system = () => opt.oeffne("system");
    switch (quelle) {
      case "kalender":
        return {
          text: s.ok ? kalenderSatz(s.daten as CalendarData, jetzt) : s.fehler,
          ziel: "Kalender öffnen",
          tun: () => opt.oeffne("kalender"),
        };
      case "post": {
        const m = s.ok ? (s.daten as MailData) : null;
        if (m?.messages.some((b) => b.unread)) {
          return {
            text: postSatz(m, jetzt),
            ziel: "Kuro fragen",
            tun: () =>
              void gespraech
                .sende(POST_FRAGE)
                .catch((e: unknown) => opt.toast(e instanceof Error ? e.message : String(e))),
          };
        }
        return {
          text: m ? postSatz(m, jetzt) : s.ok ? "" : s.fehler,
          ziel: "Post öffnen",
          tun: () => opt.oeffne("post"),
        };
      }
      case "nachtbau":
        return {
          text: s.ok
            ? nachtbauSatz(s.daten as NachtbauStand, jetzt)
            : `Der Stand des Nachtbaus ist nicht abrufbar: ${s.fehler}`,
          ziel: "System öffnen",
          tun: system,
        };
      case "abo": {
        const a = s.ok
          ? aboSatz(s.daten as AboDaten, jetzt)
          : { text: `Der Stand des Abos ist nicht abrufbar: ${s.fehler}`, knapp: false };
        return { ...a, ziel: "System öffnen", tun: system };
      }
    }
  };

  const taten = new Map<HeuteQuelle, () => void>();
  const zeichneHeute = () => {
    const jetzt = new Date();
    for (const [quelle] of QUELLEN) {
      const li = heuteEl.querySelector<HTMLElement>(`[data-quelle="${quelle}"]`);
      const s = stand.get(quelle);
      if (!li || !s) continue;
      const z = zeile(quelle, s, jetzt);
      taten.set(quelle, z.tun);
      const html = `<button type="button" class="e-satz${z.knapp ? " ist-knapp" : ""}${s.ok ? "" : " ist-fehler"}" data-quelle="${quelle}"><span class="e-satz__text">${escapeHtml(z.text)}</span><span class="e-satz__ziel">${escapeHtml(z.ziel)}</span></button>`;
      if (li.innerHTML !== html) li.innerHTML = html;
      li.hidden = false;
    }
  };
  heuteEl.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-quelle]");
    const tun = b ? taten.get(b.dataset.quelle as HeuteQuelle) : undefined;
    tun?.();
  });

  let geladen = 0;
  const ladeHeute = () => {
    geladen = Date.now();
    for (const [quelle, pfad] of QUELLEN) {
      api
        .get<unknown>(pfad)
        .then(
          (daten): Stand => ({ ok: true, daten }),
          (error: unknown): Stand => ({ ok: false, fehler: fehlerSatz(error) }),
        )
        .then((s) => {
          if (weg) return;
          stand.set(quelle, s);
          zeichneHeute();
        });
    }
  };

  zeigeGruss();
  ladeHeute();
  const uhren = [
    globalThis.setInterval(zeigeGruss, 10_000),
    globalThis.setInterval(zeichneHeute, 60_000),
    globalThis.setInterval(ladeHeute, 5 * 60_000),
  ];

  return {
    sphaere,
    feld,
    imHaus: q<HTMLElement>("e-imhaus"),
    auffrischen() {
      if (Date.now() - geladen > 60_000) ladeHeute();
    },
    loesen() {
      weg = true;
      for (const u of uhren) globalThis.clearInterval(u);
      beobachter.disconnect();
      abo();
      eingabeLoesen();
      fadenLoesen();
      sphaere.destroy();
    },
  };
}
