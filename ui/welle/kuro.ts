import type { ApiClient } from "../api/client.js";
import { type Sphaere, mountSphaere } from "../praesenz/sphaere.js";
import type { View } from "../views/types.js";
import { mountFaden } from "./faden.js";
import { datumZeile, gruss, werName } from "./form.js";
import type { Gespraech } from "./gespraech.js";
import { mountTag } from "./tag.js";

/**
 * „Kuro" — die erste Seite der Welle.
 *
 * Oben der Raum, in dem Kuro wohnt: links der Gruß, rechts über dem Fenster der Orb, darunter das
 * Gespräch. Die Eingabe gehört nicht zu dieser Seite, sondern zur Welle selbst (`app.ts`) — von
 * jedem Bereich aus spricht man mit Kuro, hier sieht man ihm dabei zu.
 *
 * Darunter „Dein Tag" (`tag.ts`). Wer dorthin scrollt, nimmt die Kamera mit: der Film fährt aus
 * dem Raum hinaus, und oben bleibt Kuro zurück.
 */

const MOTTO = "Always here. Always working.";

export interface KuroOptionen {
  api: ApiClient;
  gespraech: Gespraech;
  /** Die Eingabe der Welle — der Orb hört sichtbar zu, während Jakob tippt. */
  eingabe: HTMLTextAreaElement;
  zuhoeren(): void;
}

export function kuroAnsicht(opt: KuroOptionen): View {
  return {
    mount(container) {
      container.innerHTML = `
        <div class="k-seite">
          <section class="k-auftakt" data-role="auftakt">
            <div class="k-kopf">
              <p class="k-datum" data-role="datum"></p>
              <h1 class="k-gruss" data-role="gruss"></h1>
            </div>
            <div class="k-orb" data-role="orb" role="button" tabindex="0"
                 aria-label="Mikrofon an- oder ausschalten" aria-pressed="false"></div>
            <div class="k-faden" data-role="faden" aria-live="polite"></div>
            <a class="k-weiter" href="#k-tag" data-role="weiter"><span>Dein Tag</span></a>
          </section>
          <div class="k-tag" id="k-tag" data-role="tag"></div>
        </div>`;

      const q = <T extends Element>(rolle: string): T | null =>
        container.querySelector<T>(`[data-role="${rolle}"]`);
      const auftakt = q<HTMLElement>("auftakt");
      const orbEl = q<HTMLElement>("orb");
      const fadenEl = q<HTMLElement>("faden");
      const tagEl = q<HTMLElement>("tag");
      const datumEl = q<HTMLElement>("datum");
      const grussEl = q<HTMLElement>("gruss");
      if (!auftakt || !orbEl || !fadenEl || !tagEl) return () => {};

      const zeit = (): void => {
        const d = new Date();
        if (datumEl) datumEl.textContent = datumZeile(d);
        if (grussEl) {
          // Zwei Zeilen: der Gruß, dann der Name — so steht er als Bild, nicht als Satz.
          const [vorn, name] = gruss(d).split(", ");
          grussEl.innerHTML = `<span>${vorn},</span> <span>${name}</span>`;
        }
      };
      zeit();
      const uhr = globalThis.setInterval(zeit, 30_000);

      // ----------------------------------------------------------- Orb
      const sphaere: Sphaere = mountSphaere(orbEl, MOTTO);
      sphaere.setZustand(opt.gespraech.zustand, opt.gespraech.detail ?? undefined);
      // Am Orb tragen die Satelliten Namen, keine Kennungen — dieselben wie überall in der Welle.
      for (const [wer, a] of opt.gespraech.arbeit) {
        sphaere.bediensteterBeginnt(werName(wer), a.auftrag ?? undefined);
        sphaere.bediensteterStand(werName(wer), a.stand);
      }
      const eingabeLoesen = sphaere.bindeEingabe(opt.eingabe);
      sphaere.beimAntippen(opt.zuhoeren);
      const beiTaste = (e: KeyboardEvent): void => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        opt.zuhoeren();
      };
      orbEl.addEventListener("keydown", beiTaste);

      const orbAbo = opt.gespraech.abonniere((s) => {
        switch (s.art) {
          case "zustand":
            sphaere.setZustand(opt.gespraech.zustand, opt.gespraech.detail ?? undefined);
            orbEl.setAttribute("aria-pressed", String(opt.gespraech.zustand === "zuhoeren"));
            return;
          case "impuls":
            sphaere.impuls(s.staerke);
            return;
          case "fertig":
            if (opt.gespraech.zustand === "ruhe") sphaere.fertig();
            return;
          case "bediensteter":
            if (s.was === "beginnt")
              sphaere.bediensteterBeginnt(werName(s.wer), s.text || undefined);
            else if (s.was === "stand") sphaere.bediensteterStand(werName(s.wer), s.text);
            else sphaere.bediensteterFertig(werName(s.wer));
            return;
        }
      });

      // -------------------------------------------------------- Gespräch
      const fadenLoesen = mountFaden(fadenEl, {
        api: opt.api,
        gespraech: opt.gespraech,
        beiLeere: (leer) => auftakt.classList.toggle("ist-im-gespraech", !leer),
      });

      // ---------------------------------------------------------- Dein Tag
      const tagLoesen = mountTag(tagEl, { api: opt.api, gespraech: opt.gespraech });
      const weiter = q<HTMLAnchorElement>("weiter");
      weiter?.addEventListener("click", (e) => {
        e.preventDefault();
        tagEl.scrollIntoView({ behavior: "smooth", block: "start" });
      });

      return () => {
        globalThis.clearInterval(uhr);
        orbEl.removeEventListener("keydown", beiTaste);
        orbAbo();
        eingabeLoesen();
        fadenLoesen();
        tagLoesen();
        sphaere.destroy();
      };
    },
  };
}
