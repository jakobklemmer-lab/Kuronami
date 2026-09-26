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
    <aside class="p-nav">
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

  return {
    setActive(route) {
      for (const link of root.querySelectorAll<HTMLElement>(".p-nav__link")) {
        link.classList.toggle("ist-aktiv", link.dataset.route === route);
      }
    },
    destroy() {
      document.removeEventListener(STATUS_EVENT, aufStatus);
      root.innerHTML = "";
    },
  };
}
