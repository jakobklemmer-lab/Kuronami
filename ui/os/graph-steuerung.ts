import { escapeHtml } from "../views/html.js";
import {
  type Darstellung,
  type FarbeNach,
  type GraphApi,
  type GraphDaten,
  type GroesseNach,
  type KnotenInfo,
  type Modus,
  STILE,
  type Stil,
  VORGABE,
  mischeDarstellung,
  mountGraph,
} from "./graph.js";

/**
 * Die große Graph-Ansicht des Brain: der Graph (`graph.ts`) und seine Bedienung darüber —
 * Modi, Filter mit Live-Hervorhebung, Tafel für Darstellung und Einblicke, die Karte zur
 * gewählten Notiz, Zeitleiste, Erkunden-Pfad und Legende. Was Jakob einstellt, bleibt gemerkt.
 */

const SPEICHER = "kuronami.brain.graph.v2";
const PINS = "kuronami.brain.pins.v1";

interface Gemerkt {
  darstellung?: Partial<Darstellung>;
  tafel?: "zu" | "darstellung" | "einblicke";
  eigene?: Array<{ name: string; darstellung: Partial<Darstellung> }>;
}

function lies<T>(schluessel: string, vorgabe: T): T {
  try {
    const roh = globalThis.localStorage?.getItem(schluessel);
    return roh ? ({ ...vorgabe, ...JSON.parse(roh) } as T) : vorgabe;
  } catch {
    return vorgabe;
  }
}

function schreib(schluessel: string, wert: unknown) {
  try {
    globalThis.localStorage?.setItem(schluessel, JSON.stringify(wert));
  } catch {
    // Ohne Seitenspeicher gilt es bis zum Neuladen.
  }
}

const ANSICHTEN: Array<{ name: string; titel: string; d: Partial<Darstellung> }> = [
  { name: "Übersicht", titel: "Die Vorgabe", d: {} },
  {
    name: "Cluster",
    titel: "Farbe nach Gemeinschaft, Blasen mit Namen",
    d: { farbeNach: "cluster", groesseNach: "pagerank" },
  },
  {
    name: "Aufmerksamkeit",
    titel:
      "Groß = wichtig, kalt = lange nicht angefasst. Große kalte Punkte sind vergessene Knoten.",
    d: {
      farbeNach: "geaendert",
      groesseNach: "pagerank",
      ebenen: { ...VORGABE.ebenen, cluster: false },
    },
  },
  {
    name: "Waisen",
    titel: "Notizen ohne einen einzigen Link",
    d: { filter: "ist:waise", ebenen: { ...VORGABE.ebenen, waisen: true } },
  },
  {
    name: "Kaputte Links",
    titel: "Links auf Notizen, die es nicht gibt — gestrichelt",
    d: { ebenen: { ...VORGABE.ebenen, kaputt: true, cluster: false } },
  },
  {
    name: "Sackgassen",
    titel: "Notizen, die selbst auf nichts verweisen",
    d: { filter: "ist:sackgasse", ebenen: { ...VORGABE.ebenen, sackgassen: true } },
  },
  {
    name: "Neu",
    titel: "Was in den letzten 7 Tagen entstand",
    d: { filter: "erstellt:<7d", farbeNach: "erstellt" },
  },
];

const MODI: Array<[Modus, string, string]> = [
  ["uebersicht", "Übersicht", "Das ganze Brain"],
  ["fokus", "Fokus", "Nur die Nachbarschaft der gewählten Notiz (Doppelklick auf einen Punkt)"],
  ["erkunden", "Erkunden", "Von Notiz zu Notiz fliegen: Richtung zeigen, klicken"],
  ["zeitreise", "Zeitreise", "Zusehen, wie das Brain gewachsen ist"],
];

const GROESSE: Array<[GroesseNach, string]> = [
  ["pagerank", "PageRank"],
  ["links", "Links"],
  ["rang", "Ebene"],
  ["gleich", "Gleich"],
];
const FARBE: Array<[FarbeNach, string]> = [
  ["ordner", "Ordner"],
  ["cluster", "Cluster"],
  ["geaendert", "Geändert"],
  ["erstellt", "Entstanden"],
];

const relativ = new Intl.RelativeTimeFormat("de", { numeric: "auto" });
function vorWann(ms: number): string {
  if (!ms) return "—";
  const tage = Math.round((ms - Date.now()) / 86_400_000);
  if (tage === 0) return "heute";
  if (Math.abs(tage) < 14) return relativ.format(tage, "day");
  if (Math.abs(tage) < 60) return relativ.format(Math.round(tage / 7), "week");
  return relativ.format(Math.round(tage / 30), "month");
}
const datum = (ms: number) =>
  new Date(ms).toLocaleDateString("de-AT", { day: "numeric", month: "short", year: "numeric" });

const ICON = {
  regler: `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M2 4h7M12 4h2M2 12h2M7 12h7M9.5 2.5v3M5.5 10.5v3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  einblick: `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M3 13V8M8 13V3M13 13V6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  rahmen: `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  spiel: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M5 3.2v9.6L12.6 8z" fill="currentColor"/></svg>`,
  pause: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4.5 3h2.4v10H4.5zM9.1 3h2.4v10H9.1z" fill="currentColor"/></svg>`,
  zu: `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
};

export interface GraphAnsicht {
  api: GraphApi;
  loesen(): void;
}

export function mountGraphAnsicht(
  host: HTMLElement,
  daten: GraphDaten,
  opt: { onOeffne(pfad: string): void; spur(): string[] },
): GraphAnsicht {
  const gemerkt = lies<Gemerkt>(SPEICHER, {});
  const pins = lies<Record<string, { x: number; y: number }>>(PINS, {});
  host.classList.add("g-buehne");
  host.innerHTML = `
    <div class="g-flaeche" data-g="flaeche"></div>
    <div class="g-kopf">
      <div class="g-modi" role="tablist" aria-label="Modus">${MODI.map(
        ([m, name, titel]) =>
          `<button type="button" role="tab" data-modus="${m}" title="${escapeHtml(titel)}">${name}</button>`,
      ).join("")}</div>
      <label class="g-filter">
        <input type="search" data-g="filter" placeholder="Filtern: Wort, tag:…, ordner:…, links:>3" autocomplete="off" spellcheck="false" aria-label="Graph filtern" />
        <span class="g-filter__zahl" data-g="treffer"></span>
      </label>
      <div class="g-knoepfe">
        <button type="button" class="g-rund" data-g="rahmen" title="Alles zeigen (Doppelklick auf die Fläche)">${ICON.rahmen}</button>
        <button type="button" class="g-rund" data-tafel="einblicke" title="Einblicke">${ICON.einblick}</button>
        <button type="button" class="g-rund" data-tafel="darstellung" title="Darstellung">${ICON.regler}</button>
      </div>
    </div>
    <p class="g-fehler" data-g="fehler" hidden></p>
    <aside class="g-tafel" data-g="tafel" hidden></aside>
    <section class="g-karte" data-g="karte" hidden></section>
    <div class="g-leiste" data-g="leiste" hidden></div>
    <div class="g-legende" data-g="legende"></div>
    <p class="g-hilfe" data-g="hilfe">Klick wählt · Doppelklick zeigt die Nachbarschaft · ⌘-Klick öffnet</p>
    <div class="g-menue" data-g="menue" hidden></div>`;
  const q = <T extends HTMLElement>(rolle: string) =>
    host.querySelector<T>(`[data-g="${rolle}"]`) as T;
  const filterFeld = q<HTMLInputElement>("filter");
  const trefferEl = q<HTMLElement>("treffer");
  const fehlerEl = q<HTMLElement>("fehler");
  const tafel = q<HTMLElement>("tafel");
  const karte = q<HTMLElement>("karte");
  const leiste = q<HTMLElement>("leiste");
  const legendeEl = q<HTMLElement>("legende");
  const hilfe = q<HTMLElement>("hilfe");
  const menue = q<HTMLElement>("menue");

  let tafelArt: Gemerkt["tafel"] = gemerkt.tafel ?? "zu";
  let eigene = gemerkt.eigene ?? [];
  let auswahl: KnotenInfo | null = null;
  let weg: string[] = [];
  let zeitStand: { zeit: number; spanne: [number, number]; laeuft: boolean } | null = null;

  const merke = () => {
    const d = api.darstellung();
    schreib(SPEICHER, {
      darstellung: { ...d, filter: "" },
      tafel: tafelArt,
      eigene,
    } satisfies Gemerkt);
  };

  const api = mountGraph(q("flaeche"), daten, {
    darstellung: { ...(gemerkt.darstellung ?? {}), filter: "" },
    pins,
    onOeffne: opt.onOeffne,
    spur: opt.spur,
    onAuswahl(info) {
      auswahl = info;
      zeichneKarte();
    },
    onModus(m) {
      for (const b of host.querySelectorAll<HTMLElement>("[data-modus]")) {
        b.classList.toggle("ist-an", b.dataset.modus === m);
        b.setAttribute("aria-selected", String(b.dataset.modus === m));
      }
      zeichneLeiste();
    },
    onZeit(zeit, spanne, laeuft) {
      zeitStand = { zeit, spanne, laeuft };
      zeichneZeit();
    },
    onErkunden(neu) {
      weg = neu;
      zeichneLeiste();
    },
    onPins(neu) {
      schreib(PINS, neu);
    },
    onKontext(pfad, x, y) {
      zeigeMenue(pfad, x, y);
    },
  });

  // ------------------------------------------------------------------------- Kopf
  const modusKnopf = (m: Modus) => host.querySelector<HTMLElement>(`[data-modus="${m}"]`);
  modusKnopf("uebersicht")?.classList.add("ist-an");
  host.dataset.modus = "uebersicht";
  host.querySelector(".g-modi")?.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-modus]");
    if (!b) return;
    const m = b.dataset.modus as Modus;
    const ziel = auswahl?.pfad ?? api.kennzahlen().top[0] ?? null;
    if (m === "uebersicht") {
      if (api.modus() === "fokus") api.fokus(null);
      else if (api.modus() === "erkunden") api.erkunde(null);
      else if (api.modus() === "zeitreise") api.zeitreise(false);
    } else if (m === "fokus") api.fokus(ziel);
    else if (m === "erkunden") api.erkunde(ziel);
    else api.zeitreise(true);
  });
  q<HTMLButtonElement>("rahmen").addEventListener("click", () => api.zentriere());

  let filterUhr: ReturnType<typeof setTimeout> | null = null;
  const filterAnwenden = () => {
    api.setze({ filter: filterFeld.value });
    zeichneZaehler();
  };
  filterFeld.addEventListener("input", () => {
    if (filterUhr) clearTimeout(filterUhr);
    filterUhr = setTimeout(filterAnwenden, 90);
  });
  filterFeld.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (filterFeld.value) {
        filterFeld.value = "";
        filterAnwenden();
        e.stopPropagation();
      }
      filterFeld.blur();
    } else if (e.key === "Enter") {
      e.preventDefault();
      filterAnwenden();
      // Springen: zur wichtigsten passenden Notiz fliegen.
      const k = api.kennzahlen();
      const passend = treffer();
      const ziel = k.top.find((p) => passend.has(p)) ?? [...passend][0];
      if (ziel) {
        api.waehle(ziel, true);
        if (api.modus() === "erkunden") {
          filterFeld.value = "";
          filterAnwenden();
        }
      }
    }
  });

  /** Die passenden Pfade, wie der Graph sie sieht (für Springen). */
  function treffer(): Set<string> {
    const text = filterFeld.value.trim().toLowerCase();
    const k = api.kennzahlen();
    const alle = [...k.titel.keys()].filter((p) => !p.startsWith("\u0000"));
    if (!text) return new Set(alle);
    // Für das Springen reicht die einfache Wortsuche; der Graph selbst kennt die volle Sprache.
    const woerter = text.split(/\s+/).filter((w) => !w.includes(":"));
    return new Set(
      alle.filter((p) =>
        woerter.every((w) => `${k.titel.get(p) ?? ""} ${p}`.toLowerCase().includes(w)),
      ),
    );
  }

  function zeichneZaehler() {
    const k = api.kennzahlen();
    const d = api.darstellung();
    trefferEl.textContent = d.filter.trim() ? `${k.treffer} von ${k.notizen}` : "";
    const fehler = filterFehler(d.filter);
    fehlerEl.hidden = !fehler;
    fehlerEl.textContent = fehler ?? "";
  }

  function filterFehler(text: string): string | null {
    const m = /(links|ein|aus|in|out):([^\s]*)/i.exec(text);
    if (m?.[2] && !/^(<=|>=|<|>|=)?\d+$/.test(m[2]))
      return `„${m[0]}“ braucht eine Zahl, z. B. links:>3`;
    return null;
  }

  // ------------------------------------------------------------------------ Tafel
  for (const b of host.querySelectorAll<HTMLElement>("[data-tafel]")) {
    b.addEventListener("click", () => {
      const art = b.dataset.tafel as "darstellung" | "einblicke";
      tafelArt = tafelArt === art ? "zu" : art;
      zeichneTafel();
      merke();
    });
  }

  const knopfReihe = <T extends string>(name: string, werte: Array<[T, string]>, jetzt: T) =>
    `<div class="g-wahl" data-wahl="${name}">${werte
      .map(
        ([w, t]) =>
          `<button type="button" data-wert="${w}" class="${w === jetzt ? "ist-an" : ""}">${t}</button>`,
      )
      .join("")}</div>`;

  const schalter = (name: string, titel: string, an: boolean, zahl?: number) =>
    `<label class="g-schalter"><input type="checkbox" data-ebene="${name}" ${an ? "checked" : ""}/><span class="g-schalter__knopf"></span><span>${titel}</span>${
      zahl === undefined ? "" : `<em>${zahl}</em>`
    }</label>`;

  const regler = (
    name: keyof Darstellung["kraefte"],
    titel: string,
    min: number,
    max: number,
    schritt: number,
    wert: number,
  ) =>
    `<label class="g-regler"><span>${titel}</span><input type="range" data-kraft="${name}" min="${min}" max="${max}" step="${schritt}" value="${wert}"/></label>`;

  function zeichneTafel() {
    for (const b of host.querySelectorAll<HTMLElement>("[data-tafel]")) {
      b.classList.toggle("ist-an", b.dataset.tafel === tafelArt);
    }
    host.classList.toggle("hat-tafel", tafelArt !== "zu");
    if (tafelArt === "zu") {
      tafel.hidden = true;
      return;
    }
    tafel.hidden = false;
    if (tafelArt === "einblicke") zeichneEinblicke();
    else zeichneDarstellung();
  }

  function zeichneDarstellung() {
    const d = api.darstellung();
    const k = api.kennzahlen();
    const e = d.ebenen;
    tafel.innerHTML = `
      <h3>Ansichten</h3>
      <div class="g-chips">${ANSICHTEN.map(
        (a, i) =>
          `<button type="button" data-ansicht="${i}" title="${escapeHtml(a.titel)}">${a.name}</button>`,
      ).join("")}${eigene
        .map(
          (a, i) =>
            `<span class="g-chip-eigen"><button type="button" data-eigen="${i}">${escapeHtml(a.name)}</button><button type="button" class="g-chip-weg" data-eigen-weg="${i}" aria-label="${escapeHtml(a.name)} entfernen">${ICON.zu}</button></span>`,
        )
        .join(
          "",
        )}<button type="button" class="g-chip-neu" data-g="sichern" title="Die jetzige Darstellung als eigene Ansicht merken">+ Sichern</button></div>
      <h3>Stil</h3>
      <div class="g-stile">${(Object.keys(STILE) as Stil[])
        .map(
          (s) =>
            `<button type="button" data-stil="${s}" class="${s === d.stil ? "ist-an" : ""}"><span class="g-stil__farben">${STILE[
              s
            ].palette
              .slice(0, 4)
              .map((c) => `<i style="background:${c}"></i>`)
              .join("")}</span>${STILE[s].name}</button>`,
        )
        .join("")}</div>
      <h3>Größe nach</h3>
      ${knopfReihe("groesse", GROESSE, d.groesseNach)}
      <h3>Farbe nach</h3>
      ${knopfReihe("farbe", FARBE, d.farbeNach)}
      <h3>Ebenen</h3>
      <div class="g-ebenen">
        ${schalter("cluster", "Cluster-Blasen", e.cluster, k.gemeinschaften.filter((g) => g.anzahl >= 4).length)}
        ${schalter("waisen", "Waisen", e.waisen, k.waisen.length)}
        ${schalter("sackgassen", "Sackgassen", e.sackgassen, k.sackgassen.length)}
        ${schalter("kaputt", "Kaputte Links", e.kaputt, k.kaputt.length)}
        ${schalter("pfeile", "Pfeile", e.pfeile)}
        <div class="g-ebene-zeile">${schalter("spur", "Spur", e.spur)}<button type="button" class="g-klein" data-g="spur">abspielen</button></div>
      </div>
      <h3>Namen</h3>
      ${knopfReihe(
        "namen",
        [
          ["auto", "Automatisch"],
          ["immer", "Immer"],
          ["aus", "Aus"],
        ],
        e.namen,
      )}
      <h3>Gruppen</h3>
      <p class="g-tipp">Färbt, was passt — wie Obsidians Gruppen. Eine Notiz kann auch selbst <code>farbe: rot</code> in den Eigenschaften tragen.</p>
      <div class="g-gruppen">${d.gruppen
        .map(
          (g, i) =>
            `<div class="g-gruppe"><input type="color" data-gruppe-farbe="${i}" value="${escapeHtml(g.farbe.startsWith("#") ? g.farbe : "#f4b860")}" aria-label="Farbe"/><input type="text" data-gruppe-abfrage="${i}" value="${escapeHtml(g.abfrage)}" placeholder="tag:idee oder ordner:Trading" spellcheck="false"/><button type="button" class="g-rund g-rund--klein" data-gruppe-weg="${i}" aria-label="Gruppe entfernen">${ICON.zu}</button></div>`,
        )
        .join("")}<button type="button" class="g-klein" data-g="gruppe-neu">+ Gruppe</button></div>
      <h3>Kräfte</h3>
      <div class="g-kraefte">
        ${regler("abstossung", "Abstoßung", 600, 9000, 100, d.kraefte.abstossung)}
        ${regler("feder", "Linkkraft", 0.005, 0.12, 0.005, d.kraefte.feder)}
        ${regler("laenge", "Linkabstand", 20, 200, 2, d.kraefte.laenge)}
        ${regler("mitte", "Zug zur Mitte", 0, 0.05, 0.001, d.kraefte.mitte)}
        ${regler("cluster", "Cluster zusammenhalten", 0, 0.04, 0.001, d.kraefte.cluster)}
      </div>
      <div class="g-fuss">
        <button type="button" class="g-klein" data-g="bild">Als Bild sichern</button>
        <button type="button" class="g-klein" data-g="vorgabe">Alles auf Vorgabe</button>
      </div>`;
  }

  function zeichneEinblicke() {
    const k = api.kennzahlen();
    const name = (p: string) => escapeHtml(k.titel.get(p) ?? p.replace(/\.md$/, ""));
    const liste = (pfade: string[], leer: string) =>
      pfade.length === 0
        ? `<p class="g-tipp">${leer}</p>`
        : `<ol class="g-liste">${pfade
            .map(
              (p) =>
                `<li><button type="button" data-hin="${escapeHtml(p)}">${name(p)}</button></li>`,
            )
            .join("")}</ol>`;
    const maxTag = Math.max(1, ...k.tage.map((t) => t.neu));
    tafel.innerHTML = `
      <div class="g-zahlen">
        <div><b>${k.notizen}</b><span>Notizen</span></div>
        <div><b>${k.links}</b><span>Links</span></div>
        <div><b>${k.gemeinschaften.filter((g) => g.anzahl >= 3).length}</b><span>Cluster</span></div>
        <div><b>${k.waisen.length}</b><span>Waisen</span></div>
      </div>
      ${
        k.tage.length > 1
          ? `<h3>Wachstum</h3><div class="g-wachstum" title="Neue Notizen je Tag">${k.tage
              .map(
                (t) =>
                  `<i style="height:${Math.max(8, Math.sqrt(t.neu / maxTag) * 100)}%" title="${datum(t.tag)}: ${t.neu} neu"></i>`,
              )
              .join(
                "",
              )}</div><p class="g-tipp">${datum(k.tage[0].tag)} bis ${datum(k.tage.at(-1)?.tag ?? 0)}</p>`
          : ""
      }
      <h3>Knotenpunkte</h3>
      <p class="g-tipp">Die Notizen mit den meisten Links.</p>
      ${liste(k.top, "")}
      <h3>Cluster</h3>
      <ol class="g-liste">${k.gemeinschaften
        .filter((g) => g.anzahl >= 3)
        .map(
          (g) =>
            `<li><button type="button" data-cluster="${escapeHtml(g.name)}"><i class="g-punkt" style="background:${g.farbe}"></i>${escapeHtml(g.name)}<em>${g.anzahl}</em></button></li>`,
        )
        .join("")}</ol>
      <h3>Kalte Knoten</h3>
      <p class="g-tipp">Wichtig, aber seit zwei Wochen nicht angefasst.</p>
      ${liste(k.kalt, "Keine — alles Wichtige ist frisch.")}
      <h3>Waisen</h3>
      ${liste(k.waisen, "Keine. Jede Notiz hängt irgendwo dran.")}
      <h3>Kaputte Links</h3>
      ${
        k.kaputt.length === 0
          ? `<p class="g-tipp">Keine.</p>`
          : `<ol class="g-liste">${k.kaputt
              .slice(0, 30)
              .map(
                ([von, wie]) =>
                  `<li><button type="button" data-hin="${escapeHtml(von)}">${name(von)}<em>→ ${escapeHtml(wie)}</em></button></li>`,
              )
              .join("")}</ol>`
      }`;
  }

  tafel.addEventListener("click", (e) => {
    const ziel = e.target as HTMLElement;
    const b = ziel.closest<HTMLElement>("button");
    if (!b) return;
    const ds = b.dataset;
    if (ds.ansicht !== undefined) {
      const a = ANSICHTEN[Number(ds.ansicht)];
      const jetzt = api.darstellung();
      const neu = mischeDarstellung(
        { ...VORGABE, gruppen: jetzt.gruppen, kraefte: jetzt.kraefte, stil: jetzt.stil },
        a.d,
      );
      api.setze(neu);
      filterFeld.value = neu.filter;
      zeichneZaehler();
    } else if (ds.eigen !== undefined) {
      const a = eigene[Number(ds.eigen)];
      if (a) {
        api.setze(mischeDarstellung(VORGABE, a.darstellung));
        filterFeld.value = a.darstellung.filter ?? "";
        zeichneZaehler();
      }
    } else if (ds.eigenWeg !== undefined) {
      eigene = eigene.filter((_, i) => i !== Number(ds.eigenWeg));
    } else if (ds.g === "sichern") {
      const name = globalThis.prompt?.("Name der Ansicht", `Ansicht ${eigene.length + 1}`)?.trim();
      if (name) eigene = [...eigene, { name: name.slice(0, 24), darstellung: api.darstellung() }];
    } else if (ds.stil) api.setze({ stil: ds.stil as Stil });
    else if (ds.wert) {
      const wahl = b.closest<HTMLElement>("[data-wahl]")?.dataset.wahl;
      if (wahl === "groesse") api.setze({ groesseNach: ds.wert as GroesseNach });
      else if (wahl === "farbe") api.setze({ farbeNach: ds.wert as FarbeNach });
      else if (wahl === "namen")
        api.setze({ ebenen: { ...api.darstellung().ebenen, namen: ds.wert as "auto" } });
    } else if (ds.g === "spur") api.spurAbspielen();
    else if (ds.g === "gruppe-neu") {
      const farben = ["#f59ac8", "#56d2c2", "#f2d36b", "#a88bff", "#f07a7a"];
      const g = api.darstellung().gruppen;
      api.setze({ gruppen: [...g, { abfrage: "", farbe: farben[g.length % farben.length] }] });
    } else if (ds.gruppeWeg !== undefined) {
      api.setze({
        gruppen: api.darstellung().gruppen.filter((_, i) => i !== Number(ds.gruppeWeg)),
      });
    } else if (ds.g === "bild") {
      void api.bild().then((blob) => {
        if (!blob) return;
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `Brain-Graph ${new Date().toLocaleDateString("sv-SE")}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      });
      return;
    } else if (ds.g === "vorgabe") {
      api.setze(mischeDarstellung(VORGABE));
      filterFeld.value = "";
      zeichneZaehler();
    } else if (ds.hin) {
      api.waehle(ds.hin, true);
      return;
    } else if (ds.cluster) {
      filterFeld.value = `cluster:"${ds.cluster}"`;
      filterAnwenden();
      return;
    } else return;
    merke();
    zeichneTafel();
    zeichneLegende();
  });
  tafel.addEventListener("change", (e) => {
    const ziel = e.target as HTMLInputElement;
    const ds = ziel.dataset;
    if (ds.ebene) {
      api.setze({ ebenen: { ...api.darstellung().ebenen, [ds.ebene]: ziel.checked } });
    } else if (ds.gruppeFarbe !== undefined || ds.gruppeAbfrage !== undefined) {
      const g = api.darstellung().gruppen;
      const i = Number(ds.gruppeFarbe ?? ds.gruppeAbfrage);
      if (!g[i]) return;
      g[i] =
        ds.gruppeFarbe !== undefined
          ? { ...g[i], farbe: ziel.value }
          : { ...g[i], abfrage: ziel.value };
      api.setze({ gruppen: g });
    } else return;
    merke();
    zeichneLegende();
  });
  tafel.addEventListener("input", (e) => {
    const ziel = e.target as HTMLInputElement;
    if (ziel.dataset.kraft) {
      api.setze({
        kraefte: { ...api.darstellung().kraefte, [ziel.dataset.kraft]: Number(ziel.value) },
      });
      merke();
    } else if (ziel.dataset.gruppeAbfrage !== undefined) {
      const g = api.darstellung().gruppen;
      const i = Number(ziel.dataset.gruppeAbfrage);
      if (!g[i]) return;
      g[i] = { ...g[i], abfrage: ziel.value };
      api.setze({ gruppen: g });
      merke();
      zeichneLegende();
    }
  });

  // ------------------------------------------------------------------------ Karte
  function zeichneKarte() {
    menue.hidden = true;
    hilfe.hidden = auswahl !== null || api.modus() !== "uebersicht";
    if (!auswahl || api.modus() === "erkunden" || api.modus() === "zeitreise") {
      karte.hidden = true;
      return;
    }
    const a = auswahl;
    karte.hidden = false;
    if (a.geist) {
      karte.innerHTML = `<header><i class="g-punkt g-punkt--geist"></i><h4>${escapeHtml(a.titel)}</h4><button type="button" class="g-rund g-rund--klein" data-karte="zu" aria-label="Schließen">${ICON.zu}</button></header>
        <p class="g-tipp">Diese Notiz gibt es nicht — nur einen Link darauf.</p>`;
      return;
    }
    karte.innerHTML = `
      <header><i class="g-punkt" style="background:${a.farbe}"></i><h4>${escapeHtml(a.titel)}</h4><button type="button" class="g-rund g-rund--klein" data-karte="zu" aria-label="Schließen">${ICON.zu}</button></header>
      <p class="g-karte__pfad">${escapeHtml(a.pfad.replace(/\.md$/, "").split("/").join(" / "))}</p>
      <dl>
        <div><dt>Rang</dt><dd>#${a.platz}</dd></div>
        <div><dt>Links</dt><dd>${a.ein} ein · ${a.aus} aus</dd></div>
        <div><dt>Cluster</dt><dd><i class="g-punkt" style="background:${a.clusterFarbe}"></i>${escapeHtml(a.cluster)}</dd></div>
        <div><dt>Geändert</dt><dd title="${a.geaendert ? datum(a.geaendert) : ""}">${vorWann(a.geaendert)}</dd></div>
        <div><dt>Entstanden</dt><dd>${a.erstellt ? datum(a.erstellt) : "—"}</dd></div>
      </dl>
      ${a.tags.length ? `<p class="g-tags">${a.tags.map((t) => `<span>#${escapeHtml(t)}</span>`).join("")}</p>` : ""}
      <div class="g-karte__knoepfe">
        <button type="button" class="g-haupt" data-karte="oeffnen" title="Enter">Öffnen</button>
        <button type="button" data-karte="fokus" title="Nur die Nachbarschaft">Fokus</button>
        <button type="button" data-karte="erkunden" title="Von hier aus durchs Brain fliegen">Erkunden</button>
        <button type="button" data-karte="pin" title="Bleibt, wo du ihn hinziehst">${a.angeheftet ? "Lösen" : "Anheften"}</button>
      </div>`;
  }
  karte.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-karte]");
    if (!b || !auswahl) return;
    const was = b.dataset.karte;
    if (was === "zu") api.waehle(null, false);
    else if (was === "oeffnen") opt.onOeffne(auswahl.pfad);
    else if (was === "fokus") api.fokus(auswahl.pfad);
    else if (was === "erkunden") api.erkunde(auswahl.pfad);
    else if (was === "pin") api.anheften(auswahl.pfad);
  });

  function zeigeMenue(pfad: string, x: number, y: number) {
    const r = host.getBoundingClientRect();
    const k = api.kennzahlen();
    menue.innerHTML = `<button type="button" data-menue="oeffnen">Öffnen</button><button type="button" data-menue="fokus">Fokus</button><button type="button" data-menue="erkunden">Von hier erkunden</button><button type="button" data-menue="pin">${auswahl?.angeheftet ? "Lösen" : "Anheften"}</button><button type="button" data-menue="filter">Nur „${escapeHtml((k.titel.get(pfad) ?? pfad).slice(0, 22))}“ und Nachbarn</button>`;
    menue.dataset.pfad = pfad;
    menue.style.left = `${Math.min(x - r.left, r.width - 220)}px`;
    menue.style.top = `${Math.min(y - r.top, r.height - 200)}px`;
    menue.hidden = false;
  }
  menue.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-menue]");
    const pfad = menue.dataset.pfad;
    menue.hidden = true;
    if (!b || !pfad) return;
    const was = b.dataset.menue;
    if (was === "oeffnen") opt.onOeffne(pfad);
    else if (was === "fokus") api.fokus(pfad);
    else if (was === "erkunden") api.erkunde(pfad);
    else if (was === "pin") api.anheften(pfad);
    else if (was === "filter") api.fokus(pfad, 1);
  });
  const menueZu = (e: PointerEvent) => {
    if (!menue.hidden && !menue.contains(e.target as Node)) menue.hidden = true;
  };
  document.addEventListener("pointerdown", menueZu, true);

  // ------------------------------------------------------------------- Untere Leiste
  function zeichneLeiste() {
    const m = api.modus();
    hilfe.hidden = auswahl !== null || m !== "uebersicht";
    host.dataset.modus = m;
    if (m === "erkunden") {
      leiste.hidden = false;
      const stationen = weg.slice(-6);
      leiste.innerHTML = `<div class="g-weg">${weg.length > 6 ? "<span>…</span>" : ""}${stationen
        .map(
          (t, i) =>
            `<span class="${i === stationen.length - 1 ? "ist-hier" : ""}">${escapeHtml(t.length > 26 ? `${t.slice(0, 25)}…` : t)}</span>`,
        )
        .join(
          "<b>→</b>",
        )}</div><p class="g-leiste__hilfe">Richtung zeigen · Klick fliegt · ⌫ zurück · Enter öffnet · Esc beendet</p>`;
      karte.hidden = true;
      return;
    }
    if (m === "fokus") {
      leiste.hidden = false;
      leiste.innerHTML = `<span class="g-leiste__titel">Tiefe</span><div class="g-wahl g-wahl--klein">${[
        1, 2, 3, 4,
      ]
        .map((t) => `<button type="button" data-tiefe="${t}">${t}</button>`)
        .join("")}</div><p class="g-leiste__hilfe">Links weit · Esc zurück zur Übersicht</p>`;
      markiereTiefe();
      zeichneKarte();
      return;
    }
    if (m === "zeitreise") {
      leiste.hidden = false;
      leiste.innerHTML = `<button type="button" class="g-rund" data-g="spiel" aria-label="Abspielen">${ICON.spiel}</button><div class="g-zeitbahn" data-g="bahn"><div class="g-zeitbahn__balken" data-g="balken"></div><div class="g-zeitbahn__griff" data-g="griff"></div></div><span class="g-zeit__stand" data-g="stand"></span>`;
      zeichneBalken();
      zeichneZeit();
      zeichneKarte();
      return;
    }
    leiste.hidden = true;
    zeichneKarte();
  }

  let tiefe = 2;
  function markiereTiefe() {
    for (const b of leiste.querySelectorAll<HTMLElement>("[data-tiefe]")) {
      b.classList.toggle("ist-an", Number(b.dataset.tiefe) === tiefe);
    }
  }

  /** Die Zeitleiste geht Tag für Tag: jeder Tag mit neuen Notizen ein gleich breiter Schritt. */
  function zeichneBalken() {
    const balken = leiste.querySelector<HTMLElement>('[data-g="balken"]');
    if (!balken) return;
    const tage = api.kennzahlen().tage;
    const max = Math.max(1, ...tage.map((t) => t.neu));
    balken.innerHTML = tage
      .map(
        (t, i) =>
          `<i style="left:${((i + 0.5) / tage.length) * 100}%;height:${Math.max(12, Math.sqrt(t.neu / max) * 100)}%" title="${datum(t.tag)}: ${t.neu} neu"></i>`,
      )
      .join("");
  }

  function zeichneZeit() {
    if (!zeitStand || api.modus() !== "zeitreise") return;
    const { zeit, laeuft } = zeitStand;
    const tage = api.kennzahlen().tage;
    const bis = tage.filter((t) => t.tag <= zeit);
    const griff = leiste.querySelector<HTMLElement>('[data-g="griff"]');
    if (griff) griff.style.left = `${(bis.length / Math.max(1, tage.length)) * 100}%`;
    const stand = leiste.querySelector<HTMLElement>('[data-g="stand"]');
    const zahl = bis.reduce((s, t) => s + t.neu, 0);
    const heute = bis.at(-1);
    if (stand)
      stand.innerHTML = heute
        ? `<b>${datum(heute.tag)}</b> · ${zahl} Notizen${heute.neu ? ` <em>+${heute.neu}</em>` : ""}`
        : "Vor der ersten Notiz";
    const spiel = leiste.querySelector<HTMLElement>('[data-g="spiel"]');
    if (spiel) {
      spiel.innerHTML = laeuft ? ICON.pause : ICON.spiel;
      spiel.setAttribute("aria-label", laeuft ? "Anhalten" : "Abspielen");
    }
    if (!balkenGezeichnet) {
      balkenGezeichnet = true;
      zeichneBalken();
    }
  }
  let balkenGezeichnet = false;

  let schieben = false;
  const aufBahn = (e: PointerEvent) => {
    const bahn = leiste.querySelector<HTMLElement>('[data-g="bahn"]');
    if (!bahn) return;
    const r = bahn.getBoundingClientRect();
    const tage = api.kennzahlen().tage;
    const i = Math.floor(
      Math.max(0, Math.min(0.9999, (e.clientX - r.left) / r.width)) * tage.length,
    );
    const t = tage[i];
    if (t) api.zeitpunkt(t.tag + 86_400_000 - 1);
  };
  leiste.addEventListener("pointerdown", (e) => {
    const ziel = e.target as HTMLElement;
    if (ziel.closest('[data-g="bahn"]')) {
      schieben = true;
      leiste.setPointerCapture(e.pointerId);
      aufBahn(e);
    }
  });
  leiste.addEventListener("pointermove", (e) => {
    if (schieben) aufBahn(e);
  });
  leiste.addEventListener("pointerup", (e) => {
    schieben = false;
    if (leiste.hasPointerCapture(e.pointerId)) leiste.releasePointerCapture(e.pointerId);
  });
  leiste.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("button");
    if (!b) return;
    if (b.dataset.g === "spiel") api.spiele();
    else if (b.dataset.tiefe) {
      tiefe = Number(b.dataset.tiefe);
      api.fokus(auswahl?.pfad ?? null, tiefe);
      markiereTiefe();
    }
  });

  // ------------------------------------------------------------------------ Legende
  function zeichneLegende() {
    const k = api.kennzahlen();
    legendeEl.innerHTML = k.legende
      .slice(0, 12)
      .map(
        (l) =>
          `<span><i class="g-punkt" style="background:${l.farbe}"></i>${escapeHtml(l.name)}</span>`,
      )
      .join("");
  }

  // Leertaste im Erkunden: springen — das Filterfeld nimmt den Namen.
  const tasten = (e: KeyboardEvent) => {
    if (
      e.key === " " &&
      api.modus() === "erkunden" &&
      document.activeElement?.tagName !== "INPUT"
    ) {
      e.preventDefault();
      filterFeld.focus();
    }
  };
  host.addEventListener("keydown", tasten);

  zeichneTafel();
  zeichneLegende();
  zeichneZaehler();
  zeichneKarte();

  return {
    api,
    loesen() {
      document.removeEventListener("pointerdown", menueZu, true);
      api.loesen();
      host.classList.remove("g-buehne", "hat-tafel");
      host.replaceChildren();
    },
  };
}
