import type { ApiClient } from "../api/client.js";
import { escapeHtml } from "../views/html.js";
import { renderMarkdown } from "../views/markdown.js";
import { kruemel, wikiLinks } from "./weg.js";

/**
 * Das Brain in Kuro OS: Jakobs Obsidian-Vault vom Server, zum Lesen und Durchklicken.
 *
 * Links die feste Spur — Start und die Bereiche, also genau die ersten zwei der höchstens drei
 * Schritte zu jeder Notiz —, rechts die Notiz. Geschrieben wird in Obsidian am Mac oder von Kuro.
 */

interface Notiz {
  pfad: string;
  titel: string;
  felder: Record<string, unknown>;
  inhalt: string;
  links: Record<string, string | null>;
}

interface Fund {
  pfad: string;
  zeilen: string[];
}

export interface BrainOptionen {
  api: ApiClient;
  pfad: string;
  oeffne(pfad: string): void;
}

const SPUR: Array<{ pfad: string; name: string }> = [
  { pfad: "START.md", name: "Start" },
  { pfad: "Bereiche/Trading.md", name: "Trading" },
  { pfad: "Bereiche/Finanzen.md", name: "Finanzen" },
  { pfad: "Bereiche/Planung.md", name: "Planung" },
  { pfad: "Bereiche/Studium und Arbeit.md", name: "Studium und Arbeit" },
  { pfad: "Bereiche/Wissen.md", name: "Wissen" },
  { pfad: "Gespräche/INDEX.md", name: "Gespräche" },
  { pfad: "Eingang.md", name: "Eingang" },
];

/** Die erste `# Überschrift` steht groß über der Notiz, nicht im Fließtext. */
function ohneTitel(inhalt: string): string {
  return inhalt.replace(/^\s*#\s+[^\n]*\n?/, "");
}

function notizHtml(n: Notiz): string {
  const { text, platzhalter } = wikiLinks(ohneTitel(n.inhalt), n.links);
  // Relative Markdown-Links (`[Text](2026/2026-09-22.md)`) zeigen ebenfalls ins Brain.
  const mitRelativen = text.replace(
    /\[([^\]]+)\]\(([^)\s]+\.md)\)/g,
    (_m, anzeige: string, ziel: string) => {
      const schluessel = `BRAINLINK${platzhalter.size}X`;
      platzhalter.set(schluessel, { pfad: n.links[decodeURI(ziel)] ?? null, text: anzeige });
      return schluessel;
    },
  );
  let html = renderMarkdown(mitRelativen);
  for (const [schluessel, link] of platzhalter) {
    const ersatz = link.pfad
      ? `<a class="o-brain__link" href="#" data-brain="${escapeHtml(link.pfad)}">${escapeHtml(link.text)}</a>`
      : `<span class="o-brain__offen" title="Diese Notiz gibt es noch nicht">${escapeHtml(link.text)}</span>`;
    html = html.split(schluessel).join(ersatz);
  }
  return html;
}

function kopfHtml(n: Notiz): string {
  const teile = kruemel(n.pfad);
  const ordner = teile.slice(0, -1);
  const erzeugt = n.felder.erzeugt === true;
  return `
    <p class="o-brain__ort">${ordner.length > 0 ? ordner.map(escapeHtml).join(" / ") : "Brain"}</p>
    ${n.pfad === "START.md" ? "" : `<h2 class="o-brain__titel">${escapeHtml(n.titel)}</h2>`}
    ${erzeugt ? `<p class="o-brain__hinweis">Wird von Kuronami erzeugt und regelmäßig neu geschrieben.</p>` : ""}`;
}

export function mountBrain(
  container: HTMLElement,
  opt: BrainOptionen,
): { lade(pfad: string): void; loesen(): void } {
  container.innerHTML = `
    <div class="o-brain">
      <nav class="o-brain__spur" aria-label="Bereiche im Brain">
        <form class="o-brain__suche" role="search" data-role="suche">
          <input type="search" name="q" placeholder="Im Brain suchen" autocomplete="off"
                 aria-label="Im Brain suchen" />
        </form>
        <ul class="o-brain__liste">
          ${SPUR.map(
            (s) =>
              `<li><a href="#" data-brain="${escapeHtml(s.pfad)}" class="o-brain__spurlink">${escapeHtml(s.name)}</a></li>`,
          ).join("")}
        </ul>
        <p class="o-brain__fuss">Bearbeiten in Obsidian auf dem Mac. Der Abgleich läuft über Git.</p>
      </nav>
      <article class="o-brain__blatt" data-role="blatt" aria-live="polite"></article>
    </div>`;

  const blatt = container.querySelector<HTMLElement>('[data-role="blatt"]');
  const form = container.querySelector<HTMLFormElement>('[data-role="suche"]');
  if (!blatt || !form) return { lade() {}, loesen() {} };
  let lebt = true;

  const markiere = (pfad: string) => {
    for (const a of container.querySelectorAll<HTMLElement>(".o-brain__spurlink")) {
      a.classList.toggle("ist-aktiv", a.dataset.brain === pfad);
    }
  };

  const lade = async (pfad: string) => {
    markiere(pfad);
    try {
      const n = await opt.api.get<Notiz>(
        `/integrations/brain/notiz?pfad=${encodeURIComponent(pfad)}`,
      );
      if (!lebt) return;
      blatt.innerHTML = `${kopfHtml(n)}<div class="o-brain__text">${notizHtml(n)}</div>`;
      blatt.scrollTop = 0;
    } catch (error) {
      if (!lebt) return;
      blatt.innerHTML = `<p class="o-brain__fehler">${escapeHtml(
        error instanceof Error ? error.message : String(error),
      )}</p><p><a href="#" data-brain="START.md" class="o-brain__link">Zurück zum Start</a></p>`;
    }
  };

  const suche = async (q: string) => {
    if (q.trim().length < 2) return;
    markiere("");
    const { funde } = await opt.api.get<{ funde: Fund[] }>(
      `/integrations/brain/suche?q=${encodeURIComponent(q)}`,
    );
    if (!lebt) return;
    blatt.innerHTML =
      funde.length === 0
        ? `<p class="o-brain__ort">Suche</p><p class="o-brain__leer">Nichts gefunden für „${escapeHtml(q)}“. Weniger Wörter helfen meist.</p>`
        : `<p class="o-brain__ort">Suche nach „${escapeHtml(q)}“</p>
           <ol class="o-brain__funde">${funde
             .map(
               (f) => `<li>
                 <a href="#" data-brain="${escapeHtml(f.pfad)}" class="o-brain__fundtitel">${escapeHtml(f.pfad.replace(/\.md$/, ""))}</a>
                 ${f.zeilen.map((z) => `<p>${escapeHtml(z)}</p>`).join("")}
               </li>`,
             )
             .join("")}</ol>`;
  };

  const klick = (e: MouseEvent) => {
    const a = (e.target as Element | null)?.closest<HTMLElement>("[data-brain]");
    if (!a) return;
    e.preventDefault();
    const pfad = a.dataset.brain ?? "";
    if (pfad) opt.oeffne(pfad);
  };
  container.addEventListener("click", klick);
  const absenden = (e: SubmitEvent) => {
    e.preventDefault();
    void suche(String(new FormData(form).get("q") ?? ""));
  };
  form.addEventListener("submit", absenden);

  void lade(opt.pfad);
  return {
    lade(pfad) {
      void lade(pfad);
    },
    loesen() {
      lebt = false;
      container.removeEventListener("click", klick);
      form.removeEventListener("submit", absenden);
    },
  };
}
