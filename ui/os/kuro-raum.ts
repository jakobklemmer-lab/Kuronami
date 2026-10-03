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
import {
  type AboDaten,
  type HeuteQuelle,
  aboSatz,
  kalenderSatz,
  nachtbauSatz,
  postSatz,
} from "./heute.js";

/**
 * Der Raum Kuro (4c, Entwurf S1): eine Spalte in der Mitte — oben der Orb, darunter Datum, Gruß
 * und der Tag als ein paar Sätze, dann das Gespräch und die Eingabe. Kein Fensterbild, keine
 * Karten; die Sätze führen dorthin, wovon sie sprechen.
 */

export type RaumZiel = "kalender" | "post" | "system";

export interface KuroRaumOptionen {
  api: ApiClient;
  gespraech: Gespraech;
  voice: { toggle(): void };
  motto: string;
  toast(text: string): void;
  oeffne(ziel: RaumZiel): void;
}

export interface KuroRaum {
  sphaere: Sphaere;
  feld: HTMLTextAreaElement;
  /** Ungelesene Briefe, sobald die Post geladen ist — für den Namen des Raums beim Wechsel. */
  readonly ungelesen: number | null;
  /** Den Tag neu laden — höchstens einmal je Minute, etwa bei der Rückkehr zu Kuro. */
  auffrischen(): void;
  loesen(): void;
}

const QUELLEN: ReadonlyArray<[HeuteQuelle, string]> = [
  ["post", "/integrations/mail"],
  ["kalender", "/integrations/calendar"],
  ["nachtbau", "/integrations/nachtbau"],
  ["abo", "/integrations/abo"],
];

const POST_FRAGE = "Was ist in der ungelesenen Post wichtig?";

type Stand = { ok: true; daten: unknown } | { ok: false; fehler: string };

interface Satz {
  text: string;
  ziel: string;
  knapp?: boolean;
  tun: () => void;
}

export function mountKuroRaum(el: HTMLElement, opt: KuroRaumOptionen): KuroRaum {
  const { api, gespraech } = opt;
  el.classList.add("kr-raum");
  el.innerHTML = `
    <div class="kr-spalte">
      <div class="kr-orb" data-role="kr-orb" role="button" tabindex="0" aria-label="Mikrofon an oder aus"></div>
      <header class="kr-tag">
        <p class="kr-tag__datum" data-role="kr-datum"></p>
        <h1 class="kr-tag__gruss" data-role="kr-gruss"></h1>
        <p class="kr-tag__saetze" data-role="kr-heute">${QUELLEN.map(([q]) => `<span data-quelle="${q}" hidden></span>`).join("")}</p>
      </header>
      <section class="kr-gespraech" aria-label="Gespräch">
        <button type="button" class="kr-leeren" data-role="kr-leeren"
                title="Leert nur diese Ansicht — Kuro erinnert sich weiter.">Gespräch leeren</button>
        <div class="kr-faden" data-role="kr-faden" aria-live="polite"></div>
      </section>
      ${eingabeHtml("kr-form", "o-eingabe--gross")}
    </div>`;

  const q = <T extends Element>(rolle: string): T => {
    const e = el.querySelector<T>(`[data-role="${rolle}"]`);
    if (!e) throw new Error(`Raum Kuro: ${rolle} fehlt.`);
    return e;
  };
  const orb = q<HTMLElement>("kr-orb");
  const heuteEl = q<HTMLElement>("kr-heute");
  const fadenEl = q<HTMLElement>("kr-faden");
  const feld = verdrahteEingabe(q<HTMLFormElement>("kr-form"), opt);
  feld.placeholder = "Kuro fragen oder die Sprechtaste halten";

  // ------------------------------------------------------------------- Orb
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
    beiLeere: (leer) => el.classList.toggle("ist-still", leer),
  });
  fadenEl.scrollTop = fadenEl.scrollHeight;
  const leerenEl = q<HTMLButtonElement>("kr-leeren");
  const leeren = () => gespraech.leere();
  leerenEl.addEventListener("click", leeren);

  // ------------------------------------------------------------------ Gruß
  const datumEl = q<HTMLElement>("kr-datum");
  const grussEl = q<HTMLElement>("kr-gruss");
  const zeigeGruss = () => {
    const d = new Date();
    datumEl.textContent = datumZeile(d);
    grussEl.textContent = gruss(d);
  };

  // ---------------------------------------------------------------- Der Tag
  let weg = false;
  let ungelesen: number | null = null;
  const stand = new Map<HeuteQuelle, Stand>();

  const satz = (quelle: HeuteQuelle, s: Stand, jetzt: Date): Satz => {
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
            ziel: "Kuro fragen, was davon wichtig ist",
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
      const span = heuteEl.querySelector<HTMLElement>(`[data-quelle="${quelle}"]`);
      const s = stand.get(quelle);
      if (!span || !s) continue;
      const z = satz(quelle, s, jetzt);
      taten.set(quelle, z.tun);
      const html = z.text
        ? `<button type="button" class="kr-satz${z.knapp ? " ist-knapp" : ""}${s.ok ? "" : " ist-fehler"}" title="${escapeHtml(z.ziel)}">${escapeHtml(z.text)}</button> `
        : "";
      if (span.innerHTML !== html) span.innerHTML = html;
      span.hidden = html === "";
    }
  };
  heuteEl.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest(".kr-satz")) return;
    const span = (e.target as HTMLElement).closest<HTMLElement>("[data-quelle]");
    taten.get(span?.dataset.quelle as HeuteQuelle)?.();
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
          if (quelle === "post" && s.ok) {
            ungelesen = (s.daten as MailData).messages.filter((b) => b.unread).length;
          }
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
    get ungelesen() {
      return ungelesen;
    },
    auffrischen() {
      if (Date.now() - geladen > 60_000) ladeHeute();
    },
    loesen() {
      weg = true;
      for (const u of uhren) globalThis.clearInterval(u);
      abo();
      eingabeLoesen();
      fadenLoesen();
      leerenEl.removeEventListener("click", leeren);
      sphaere.destroy();
    },
  };
}
