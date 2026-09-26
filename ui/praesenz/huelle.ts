import { icon } from "../icons.js";
import type { RouteId } from "../router/router.js";

/**
 * Die Hülle der neuen Oberfläche: der Raum als Grund und die Leiste links.
 *
 * Sie umgibt **jede** Ansicht — Kuro in der Mitte („Home"), aber genauso Mail, Kalender,
 * Märkte, Recherche, Dateien, System und Einstellungen. Seit S47 ist sie die einzige Hülle; die
 * klassische mit Seitenleiste und Dashboard liegt im Archiv (`archiv/alte-oberflaeche`).
 *
 * Die Leiste kennt keine Ansicht; sie bekommt gesagt, welche Route aktiv ist, und zeigt unten
 * den Zustand des Hauses. Den setzt die Präsenz-Ansicht über ein `kuro:status`-Ereignis auf
 * `document` — ein Ereignis statt eines Imports, damit Hülle und Ansicht einander nicht kennen
 * müssen.
 *
 * **Auf dem Telefon** (S47) ist die Leiste eine Schublade hinter dem Knopf oben links. Bis dahin
 * war sie dort einfach ausgeblendet — ohne Ersatz, man kam aus der Präsenz nur über die Adresse
 * hinaus. Ein Tipp auf einen Eintrag, auf den Schleier daneben oder Escape schließt sie wieder.
 */

const NAV: Array<{ route: RouteId; label: string; ikon: Parameters<typeof icon>[0] }> = [
  { route: "praesenz", label: "Home", ikon: "home" },
  { route: "mail", label: "Mail", ikon: "mail" },
  { route: "calendar", label: "Calendar", ikon: "calendar" },
  { route: "trading", label: "Markets", ikon: "trading" },
  { route: "analysen", label: "Analysen", ikon: "analysen" },
  { route: "strategien", label: "Strategien", ikon: "strategien" },
  { route: "research", label: "Research", ikon: "research" },
  // Artefakte und Gedächtnisnotizen. Bis S47 nur aus der alten Seitenleiste zu erreichen.
  { route: "files", label: "Files", ikon: "files" },
  { route: "system", label: "System", ikon: "system" },
];

export const STATUS_EVENT = "kuro:status";

/** Die Ansicht meldet, was Kuro gerade tut — die Leiste zeigt es unten. */
export function meldeStatus(text: string): void {
  document.dispatchEvent(new CustomEvent(STATUS_EVENT, { detail: text }));
}

export interface Huelle {
  setActive(route: RouteId): void;
  destroy(): void;
}

export function mountHuelle(root: HTMLElement): Huelle {
  root.innerHTML = `
    <div class="p-raum" aria-hidden="true"></div>
    <button type="button" class="p-nav-knopf" aria-label="Menü öffnen" aria-controls="p-nav"
            aria-expanded="false">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
           stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
        <path d="M4.5 7.5h15M4.5 12h15M4.5 16.5h9" />
      </svg>
    </button>
    <div class="p-nav-schleier" hidden></div>
    <aside class="p-nav" id="p-nav">
      <a class="p-nav__marke" href="#/praesenz">
        <span class="p-nav__kanji">黒</span><span class="p-nav__wort">Kuronami</span>
      </a>
      <nav class="p-nav__liste" aria-label="Bereiche">
        ${NAV.map(
          (n) => `
          <a class="p-nav__link" data-route="${n.route}" href="#/${n.route}">
            <span class="p-nav__ikon">${icon(n.ikon)}</span><span class="p-nav__label">${n.label}</span>
          </a>`,
        ).join("")}
      </nav>
      <div class="p-nav__unten">
        <a class="p-nav__link" data-route="settings" href="#/settings">
          <span class="p-nav__ikon">${icon("settings")}</span><span class="p-nav__label">Settings</span>
        </a>
      </div>
      <div class="p-nav__status">
        <span class="p-nav__punkt"></span>
        <span><strong>Kuronami</strong><br><span data-role="status-text">Online</span></span>
      </div>
    </aside>
  `;

  const statusText = root.querySelector<HTMLElement>('[data-role="status-text"]');
  const aufStatus = (e: Event): void => {
    const text = (e as CustomEvent<string>).detail;
    if (statusText && typeof text === "string") statusText.textContent = text;
  };
  document.addEventListener(STATUS_EVENT, aufStatus);

  // Die Schublade. Auf breiten Fenstern ist der Knopf unsichtbar und `ist-offen` ohne Wirkung —
  // die Regeln dafür stehen nur in der schmalen Fassung von `praesenz.css`.
  const knopf = root.querySelector<HTMLButtonElement>(".p-nav-knopf");
  const nav = root.querySelector<HTMLElement>(".p-nav");
  const schleier = root.querySelector<HTMLElement>(".p-nav-schleier");
  let offen = false;
  const setzeOffen = (an: boolean): void => {
    if (!knopf || !nav || !schleier || an === offen) return;
    offen = an;
    nav.classList.toggle("ist-offen", an);
    schleier.hidden = !an;
    knopf.setAttribute("aria-expanded", String(an));
    knopf.setAttribute("aria-label", an ? "Menü schließen" : "Menü öffnen");
    if (an) {
      nav
        .querySelector<HTMLElement>(".p-nav__link.ist-aktiv, .p-nav__link")
        ?.focus({ preventScroll: true });
    } else if (nav.contains(document.activeElement)) {
      knopf.focus({ preventScroll: true });
    }
  };
  knopf?.addEventListener("click", () => setzeOffen(!offen));
  schleier?.addEventListener("click", () => setzeOffen(false));
  // Auch ein Tipp auf die schon offene Ansicht schließt — dann gibt es keinen Routenwechsel.
  nav?.addEventListener("click", (e) => {
    if (e.target instanceof Element && e.target.closest("a")) setzeOffen(false);
  });
  const aufTaste = (e: KeyboardEvent): void => {
    if (e.key === "Escape") setzeOffen(false);
  };
  document.addEventListener("keydown", aufTaste);

  return {
    setActive(route) {
      for (const link of root.querySelectorAll<HTMLElement>(".p-nav__link")) {
        const aktiv = link.dataset.route === route;
        link.classList.toggle("ist-aktiv", aktiv);
        if (aktiv) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
      }
      setzeOffen(false);
    },
    destroy() {
      document.removeEventListener(STATUS_EVENT, aufStatus);
      document.removeEventListener("keydown", aufTaste);
      root.innerHTML = "";
    },
  };
}
