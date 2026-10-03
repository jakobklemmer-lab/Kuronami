import type { ApiClient } from "../api/client.js";
import { escapeHtml } from "../views/html.js";
import { renderMarkdown } from "../views/markdown.js";
import type { Plaetze } from "../views/types.js";
import { umgebung } from "./graph-sim.js";
import { mountGraphAnsicht } from "./graph-steuerung.js";
import { type GraphDaten, mountGraph } from "./graph.js";
import { wikiLinks } from "./weg.js";

/**
 * Das Brain als App, gebaut wie Obsidian: links der Dateibaum, in der Mitte die Notiz (lesen,
 * ⌘E bearbeiten, ⌘S sichern, Zurück und Vor), rechts der lokale Graph, Rückverweise und Links.
 * Der große Graph liegt über der Mitte — Klick auf einen Knoten öffnet die Notiz.
 * In Kuro OS (4c) stehen Baum und rechte Spalte auf den Plätzen des Raums (`plaetze`).
 */

interface Notiz {
  pfad: string;
  titel: string;
  felder: Record<string, unknown>;
  inhalt: string;
  roh: string;
  links: Record<string, string | null>;
  rueckverweise: Array<{ pfad: string; titel: string }>;
}

type Ansicht = { art: "notiz"; pfad: string } | { art: "graph" } | { art: "suche"; q: string };

export interface BrainApp {
  oeffne(pfad: string): void;
  graph(): void;
  loesen(): void;
}

function ohneTitel(inhalt: string): string {
  return inhalt.replace(/^\s*#\s+[^\n]*\n?/, "");
}

function notizHtml(n: Notiz): string {
  const { text, platzhalter } = wikiLinks(ohneTitel(n.inhalt), n.links);
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
      ? `<a class="b-link" href="#" data-brain="${escapeHtml(link.pfad)}">${escapeHtml(link.text)}</a>`
      : `<span class="b-link b-link--offen" title="Diese Notiz gibt es noch nicht">${escapeHtml(link.text)}</span>`;
    html = html.split(schluessel).join(ersatz);
  }
  return html;
}

interface Ordner {
  name: string;
  pfad: string;
  ordner: Map<string, Ordner>;
  dateien: Array<{ pfad: string; name: string }>;
}

export function baum(pfade: readonly string[]): Ordner {
  const wurzel: Ordner = { name: "", pfad: "", ordner: new Map(), dateien: [] };
  for (const pfad of pfade) {
    const teile = pfad.split("/");
    let o = wurzel;
    for (const teil of teile.slice(0, -1)) {
      const weiter = o.ordner.get(teil) ?? {
        name: teil,
        pfad: o.pfad ? `${o.pfad}/${teil}` : teil,
        ordner: new Map(),
        dateien: [],
      };
      o.ordner.set(teil, weiter);
      o = weiter;
    }
    o.dateien.push({ pfad, name: (teile.at(-1) ?? pfad).replace(/\.md$/, "") });
  }
  return wurzel;
}

const PFEIL = `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export function mountBrainApp(
  el: HTMLElement,
  api: ApiClient,
  start: string | null,
  toast: (text: string) => void,
  plaetze?: Plaetze,
): BrainApp {
  el.innerHTML = `
    <div class="b-app">
      <aside class="b-links">
        <form class="b-suche" data-role="suche" role="search">
          <input type="search" name="q" placeholder="Suchen" autocomplete="off" aria-label="Im Brain suchen" />
        </form>
        <div class="b-leiste">
          <button type="button" data-role="neu" title="Neue Notiz im Eingang">Neue Notiz</button>
          <button type="button" data-role="graphknopf" title="Graph-Ansicht">Graph</button>
        </div>
        <nav class="b-baum" data-role="baum" aria-label="Dateien im Brain"></nav>
      </aside>
      <section class="b-mitte">
        <header class="b-kopf">
          <button type="button" class="b-rund" data-role="zurueck" aria-label="Zurück" title="Zurück (⌘[)"><svg viewBox="0 0 16 16" width="14" height="14"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
          <button type="button" class="b-rund" data-role="vor" aria-label="Vor" title="Vor (⌘])"><svg viewBox="0 0 16 16" width="14" height="14"><path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
          <p class="b-ort" data-role="ort"></p>
          <button type="button" class="b-modus" data-role="modus" hidden>Bearbeiten</button>
        </header>
        <div class="b-inhalt" data-role="inhalt"></div>
      </section>
      <aside class="b-rechts">
        <div class="b-rechts__kopf">
          <h3 class="b-rechts__titel">Verbindungen</h3>
          <div class="b-tiefe" data-role="tiefe" role="group" aria-label="Tiefe">
            <button type="button" data-tiefe="1" title="Direkte Nachbarn">1</button>
            <button type="button" data-tiefe="2" title="Nachbarn der Nachbarn">2</button>
            <button type="button" data-tiefe="3" title="Drei Links weit">3</button>
          </div>
        </div>
        <div class="b-lokal" data-role="lokal"></div>
        <h3 class="b-rechts__titel">Rückverweise</h3>
        <ul class="b-verweise" data-role="rueck"></ul>
        <h3 class="b-rechts__titel">Links</h3>
        <ul class="b-verweise" data-role="aus"></ul>
      </aside>
    </div>`;

  const q = <T extends Element>(rolle: string) =>
    el.querySelector<T>(`[data-role="${rolle}"]`) as T;
  const inhalt = q<HTMLElement>("inhalt");
  const ort = q<HTMLElement>("ort");
  const modus = q<HTMLButtonElement>("modus");
  const baumEl = q<HTMLElement>("baum");
  const lokalEl = q<HTMLElement>("lokal");
  const rueckEl = q<HTMLElement>("rueck");
  const ausEl = q<HTMLElement>("aus");
  const zurueck = q<HTMLButtonElement>("zurueck");
  const vor = q<HTMLButtonElement>("vor");
  const form = q<HTMLFormElement>("suche");
  const rechtsEl = el.querySelector(".b-rechts") as HTMLElement;

  let daten: GraphDaten = { knoten: [], kanten: [] };
  const titel = new Map<string, string>();
  const zu = new Set<string>([
    "Gespräche",
    "Trading/Analysen",
    "Trading/Strategien",
    "Wissen/TradingLab",
  ]);
  let verlauf: Ansicht[] = [];
  let stelle = -1;
  let notiz: Notiz | null = null;
  let bearbeiten = false;
  let geaendert = false;
  let grossGraph: ReturnType<typeof mountGraphAnsicht> | null = null;
  let kleinGraph: ReturnType<typeof mountGraph> | null = null;
  let lebt = true;
  let lokalTiefe = (() => {
    try {
      return Number(globalThis.localStorage?.getItem("kuronami.brain.lokal-tiefe")) || 1;
    } catch {
      return 1;
    }
  })();
  const tiefeEl = q<HTMLElement>("tiefe");
  const markiereTiefe = () => {
    for (const b of tiefeEl.querySelectorAll<HTMLElement>("[data-tiefe]")) {
      b.classList.toggle("ist-an", Number(b.dataset.tiefe) === lokalTiefe);
    }
  };
  markiereTiefe();
  tiefeEl.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-tiefe]");
    if (!b) return;
    lokalTiefe = Number(b.dataset.tiefe);
    try {
      globalThis.localStorage?.setItem("kuronami.brain.lokal-tiefe", String(lokalTiefe));
    } catch {
      // gilt bis zum Neuladen
    }
    markiereTiefe();
    zeichneSeite();
  });

  /** Der Weg durchs Brain für die Spur im Graphen: die geöffneten Notizen, älteste zuerst. */
  const spur = () =>
    verlauf
      .slice(0, stelle + 1)
      .filter((a): a is { art: "notiz"; pfad: string } => a.art === "notiz")
      .map((a) => a.pfad);

  const aktuell = () => verlauf[stelle] ?? null;

  function zeichneBaum() {
    const offen = aktuell();
    const aktivPfad = offen?.art === "notiz" ? offen.pfad : null;
    const ordnerHtml = (o: Ordner, tiefe: number): string => {
      const unter = [...o.ordner.values()].sort((a, b) => a.name.localeCompare(b.name, "de"));
      const dateien = [...o.dateien].sort((a, b) => a.name.localeCompare(b.name, "de"));
      return `${unter
        .map((u) => {
          const geschlossen = zu.has(u.pfad);
          return `<div class="b-ordner${geschlossen ? " ist-zu" : ""}">
            <button type="button" class="b-zeile b-zeile--ordner" data-ordner="${escapeHtml(u.pfad)}" style="--tiefe:${tiefe}" aria-expanded="${!geschlossen}">${PFEIL}<span>${escapeHtml(u.name)}</span></button>
            ${geschlossen ? "" : ordnerHtml(u, tiefe + 1)}
          </div>`;
        })
        .join("")}${dateien
        .map(
          (d) =>
            `<a href="#" class="b-zeile b-zeile--datei${d.pfad === aktivPfad ? " ist-aktiv" : ""}" data-brain="${escapeHtml(d.pfad)}" style="--tiefe:${tiefe}" title="${escapeHtml(titel.get(d.pfad) ?? d.name)}">${escapeHtml(d.name)}</a>`,
        )
        .join("")}`;
    };
    baumEl.innerHTML = ordnerHtml(baum(daten.knoten.map((k) => k.pfad)), 0);
  }

  function zeichneSeite() {
    const offen = aktuell();
    zurueck.disabled = stelle <= 0;
    vor.disabled = stelle >= verlauf.length - 1;
    el.querySelector(".b-app")?.classList.toggle("ist-graph", offen?.art === "graph");
    rechtsEl.classList.toggle("ist-graph", offen?.art === "graph");
    if (!offen || offen.art !== "notiz" || !notiz) {
      rueckEl.innerHTML = "";
      ausEl.innerHTML = "";
      kleinGraph?.loesen();
      kleinGraph = null;
      return;
    }
    const liste = (eintraege: Array<{ pfad: string; titel: string }>) =>
      eintraege.length === 0
        ? `<li class="b-verweise__leer">Keine</li>`
        : eintraege
            .map(
              (e) =>
                `<li><a href="#" data-brain="${escapeHtml(e.pfad)}">${escapeHtml(e.titel)}</a></li>`,
            )
            .join("");
    rueckEl.innerHTML = liste(notiz.rueckverweise);
    const aus = [...new Set(Object.values(notiz.links).filter((p): p is string => !!p))];
    ausEl.innerHTML = liste(aus.map((p) => ({ pfad: p, titel: titel.get(p) ?? p })));
    kleinGraph?.loesen();
    kleinGraph = mountGraph(lokalEl, umgebung(daten.knoten, daten.kanten, notiz.pfad, lokalTiefe), {
      aktiv: notiz.pfad,
      lokal: true,
      onOeffne: (p) => oeffne(p),
    });
  }

  async function ladeDaten() {
    try {
      daten = await api.get<GraphDaten>("/integrations/brain/graph");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
      return;
    }
    titel.clear();
    for (const k of daten.knoten) titel.set(k.pfad, k.titel);
    if (lebt) zeichneBaum();
  }

  async function zeige(a: Ansicht) {
    if (bearbeiten && geaendert) await sichere();
    bearbeiten = false;
    grossGraph?.loesen();
    grossGraph = null;
    modus.hidden = true;
    if (a.art === "graph") {
      notiz = null;
      ort.textContent = "Graph";
      inhalt.innerHTML = `<div class="b-graph" data-role="gross"></div>`;
      grossGraph = mountGraphAnsicht(q<HTMLElement>("gross"), daten, {
        onOeffne: (p) => oeffne(p),
        spur,
      });
      zeichneBaum();
      zeichneSeite();
      return;
    }
    if (a.art === "suche") {
      notiz = null;
      ort.textContent = `Suche nach „${a.q}“`;
      const { funde } = await api.get<{ funde: Array<{ pfad: string; zeilen: string[] }> }>(
        `/integrations/brain/suche?q=${encodeURIComponent(a.q)}`,
      );
      inhalt.innerHTML =
        funde.length === 0
          ? `<p class="b-leer">Nichts gefunden. Weniger Wörter helfen meist.</p>`
          : `<ol class="b-funde">${funde
              .map(
                (f) =>
                  `<li><a href="#" class="b-link" data-brain="${escapeHtml(f.pfad)}">${escapeHtml(titel.get(f.pfad) ?? f.pfad)}</a><small>${escapeHtml(f.pfad)}</small>${f.zeilen.map((z) => `<p>${escapeHtml(z)}</p>`).join("")}</li>`,
              )
              .join("")}</ol>`;
      zeichneBaum();
      zeichneSeite();
      return;
    }
    try {
      notiz = await api.get<Notiz>(`/integrations/brain/notiz?pfad=${encodeURIComponent(a.pfad)}`);
    } catch (error) {
      notiz = null;
      ort.textContent = a.pfad;
      inhalt.innerHTML = `<p class="b-fehler">${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`;
      zeichneBaum();
      zeichneSeite();
      return;
    }
    if (!lebt) return;
    ort.textContent = notiz.pfad.replace(/\.md$/, "").split("/").join(" / ");
    const erzeugt = notiz.felder.erzeugt === true;
    modus.hidden = false;
    modus.disabled = erzeugt;
    modus.textContent = "Bearbeiten";
    modus.title = erzeugt ? "Wird von Kuronami erzeugt und neu geschrieben" : "Bearbeiten (⌘E)";
    inhalt.innerHTML = `<article class="b-notiz">
        <h1 class="b-titel">${escapeHtml(notiz.titel)}</h1>
        ${erzeugt ? `<p class="b-hinweis">Wird von Kuronami erzeugt und regelmäßig neu geschrieben.</p>` : ""}
        <div class="b-text">${notizHtml(notiz)}</div>
      </article>`;
    inhalt.scrollTop = 0;
    zeichneBaum();
    zeichneSeite();
  }

  function gehe(a: Ansicht) {
    verlauf = [...verlauf.slice(0, stelle + 1), a].slice(-60);
    stelle = verlauf.length - 1;
    void zeige(a);
  }

  function oeffne(pfad: string) {
    const jetzt = aktuell();
    if (jetzt?.art === "notiz" && jetzt.pfad === pfad) return;
    gehe({ art: "notiz", pfad });
  }

  async function sichere(): Promise<boolean> {
    if (!notiz) return false;
    const feld = inhalt.querySelector<HTMLTextAreaElement>(".b-editor");
    if (!feld) return false;
    try {
      await api.put("/integrations/brain/notiz", { pfad: notiz.pfad, inhalt: feld.value });
      geaendert = false;
      modus.textContent = "Lesen";
      void ladeDaten();
      return true;
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  async function umschalten() {
    if (!notiz || modus.disabled) return;
    if (bearbeiten) {
      if (geaendert && !(await sichere())) return;
      bearbeiten = false;
      await zeige({ art: "notiz", pfad: notiz.pfad });
      return;
    }
    bearbeiten = true;
    geaendert = false;
    modus.textContent = "Lesen";
    inhalt.innerHTML = `<textarea class="b-editor" spellcheck="true" aria-label="Notiz bearbeiten"></textarea>`;
    const feld = inhalt.querySelector<HTMLTextAreaElement>(".b-editor") as HTMLTextAreaElement;
    feld.value = notiz.roh;
    feld.addEventListener("input", () => {
      geaendert = true;
      modus.textContent = "Sichern";
    });
    feld.focus();
  }

  async function neueNotiz() {
    const heute = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Vienna" });
    let pfad = `Eingang/${heute} Neue Notiz.md`;
    for (let n = 2; titel.has(pfad); n++) pfad = `Eingang/${heute} Neue Notiz ${n}.md`;
    try {
      await api.put("/integrations/brain/notiz", { pfad, inhalt: "# Neue Notiz\n\n", neu: true });
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
      return;
    }
    await ladeDaten();
    gehe({ art: "notiz", pfad });
    globalThis.setTimeout(() => void umschalten(), 150);
  }

  const beiKlick = (e: MouseEvent) => {
    const ziel = e.target as Element;
    const link = ziel.closest<HTMLElement>("[data-brain]");
    if (link) {
      e.preventDefault();
      oeffne(link.dataset.brain ?? "");
      return;
    }
    const ordner = ziel.closest<HTMLElement>("[data-ordner]");
    if (ordner) {
      const p = ordner.dataset.ordner ?? "";
      if (zu.has(p)) zu.delete(p);
      else zu.add(p);
      zeichneBaum();
    }
  };
  el.addEventListener("click", beiKlick);
  zurueck.addEventListener("click", () => {
    if (stelle > 0) void zeige(verlauf[--stelle] as Ansicht);
  });
  vor.addEventListener("click", () => {
    if (stelle < verlauf.length - 1) void zeige(verlauf[++stelle] as Ansicht);
  });
  modus.addEventListener("click", () => void umschalten());
  q<HTMLButtonElement>("graphknopf").addEventListener("click", () => gehe({ art: "graph" }));
  q<HTMLButtonElement>("neu").addEventListener("click", () => void neueNotiz());
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = String(new FormData(form).get("q") ?? "").trim();
    if (text.length >= 2) gehe({ art: "suche", q: text });
  });
  el.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const taste = e.key.toLowerCase();
    if (taste === "e") {
      e.preventDefault();
      void umschalten();
    } else if (taste === "s" && bearbeiten) {
      e.preventDefault();
      void sichere();
    } else if (e.key === "[") {
      e.preventDefault();
      zurueck.click();
    } else if (e.key === "]") {
      e.preventDefault();
      vor.click();
    }
  });

  // Erst wenn alles verdrahtet ist, wandern Baum und Spalte auf die Plätze des Raums.
  if (plaetze) {
    const links = el.querySelector(".b-links") as HTMLElement;
    plaetze.seite.append(links);
    plaetze.spalte.append(rechtsEl);
    links.addEventListener("click", beiKlick);
    rechtsEl.addEventListener("click", beiKlick);
    el.querySelector(".b-app")?.classList.add("ist-im-raum");
  }

  void ladeDaten().then(() => gehe(start ? { art: "notiz", pfad: start } : { art: "graph" }));

  return {
    oeffne,
    graph: () => gehe({ art: "graph" }),
    loesen() {
      lebt = false;
      if (bearbeiten && geaendert) void sichere();
      grossGraph?.loesen();
      kleinGraph?.loesen();
    },
  };
}
