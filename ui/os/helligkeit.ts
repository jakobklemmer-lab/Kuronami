import type { Helligkeit } from "../settings/store.js";

/**
 * Hell oder dunkel in Kuro OS (Einstellungen → Erscheinungsbild). Die Farben hängen an
 * `html[data-helligkeit]` (`os.css`); der Chart liest sie beim Aufbau, darum meldet ein Wechsel
 * sich über `beiWechsel`, und Kuro OS baut den offenen Teil neu auf.
 */

export type Wirksam = "dunkel" | "hell";

export function wirksam(h: Helligkeit, systemHell: boolean): Wirksam {
  if (h === "system") return systemHell ? "hell" : "dunkel";
  return h;
}

const GRUND: Record<Wirksam, string> = { dunkel: "#0d0c0a", hell: "#f3f0ea" };

export interface HelligkeitsSteuerung {
  setze(h: Helligkeit): void;
  readonly jetzt: Wirksam;
  loesen(): void;
}

export function steuereHelligkeit(
  start: Helligkeit,
  beiWechsel: (w: Wirksam) => void,
): HelligkeitsSteuerung {
  const anfrage = globalThis.matchMedia?.("(prefers-color-scheme: light)") ?? null;
  let wahl = start;
  let jetzt: Wirksam | null = null;
  const wende = () => {
    const w = wirksam(wahl, anfrage?.matches ?? false);
    if (w === jetzt) return;
    const erstes = jetzt === null;
    jetzt = w;
    const html = document.documentElement;
    html.dataset.helligkeit = w;
    document
      .querySelector('meta[name="color-scheme"]')
      ?.setAttribute("content", w === "hell" ? "light" : "dark");
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", GRUND[w]);
    if (!erstes) beiWechsel(w);
  };
  anfrage?.addEventListener("change", wende);
  wende();
  return {
    setze(h) {
      wahl = h;
      wende();
    },
    get jetzt() {
      return jetzt ?? "dunkel";
    },
    loesen() {
      anfrage?.removeEventListener("change", wende);
    },
  };
}
