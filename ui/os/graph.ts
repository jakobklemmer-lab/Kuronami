import {
  type Gemeinschaft,
  abstaende,
  baueFilter,
  benenne,
  huelle,
  leseFarbe,
  louvain,
  mische,
  pageRank,
} from "./graph-mass.js";
import { KRAEFTE, type Kraefte, type Netz, baueNetz, schritt } from "./graph-sim.js";

/**
 * Der Graph des Brain auf einer Leinwand, gebaut nach Obsidians Graph-Plugins (Graph Insight,
 * Graph Styler): leuchtende Punkte in Stilvorlagen, Größe und Farbe nach Kennzahlen, Cluster als
 * Blasen mit Namen, Waisen/Sackgassen/kaputte Links, Fokus auf die Nachbarschaft, ein Erkunden-
 * Modus, der von Notiz zu Notiz fliegt, und eine Zeitreise durch das Wachsen des Brain.
 *
 * Gezeichnet wird nur, solange sich etwas bewegt oder Jakob etwas tut. Das Leuchten kommt aus
 * vorgerenderten Bildern statt `shadowBlur` — auf einem Retina-Schirm sonst zu teuer.
 */

export interface GraphKnotenDaten {
  pfad: string;
  titel: string;
  ordner: string;
  tags?: string[];
  farbe?: string | null;
  erstellt?: number;
  geaendert?: number;
  worte?: number;
}

export interface GraphDaten {
  knoten: GraphKnotenDaten[];
  kanten: Array<[string, string]>;
  offen?: Array<[string, string]>;
}

export type Stil = "ruhig" | "glut" | "galaxie" | "tusche";
export type GroesseNach = "rang" | "links" | "pagerank" | "gleich";
export type FarbeNach = "ordner" | "cluster" | "geaendert" | "erstellt";
export type Modus = "uebersicht" | "fokus" | "erkunden" | "zeitreise";
export type Namen = "auto" | "immer" | "aus";

export interface Ebenen {
  cluster: boolean;
  waisen: boolean;
  sackgassen: boolean;
  kaputt: boolean;
  pfeile: boolean;
  spur: boolean;
  namen: Namen;
}

export interface Gruppe {
  abfrage: string;
  farbe: string;
}

export interface Darstellung {
  stil: Stil;
  groesseNach: GroesseNach;
  farbeNach: FarbeNach;
  ebenen: Ebenen;
  kraefte: Kraefte;
  gruppen: Gruppe[];
  filter: string;
  /** Was nicht passt, verschwindet (sonst nur blass). */
  nurTreffer: boolean;
}

/** Die Vorgaben — abgestimmt am Bild, damit es ohne Einstellen gut aussieht (Jakob, 03.10.). */
export const VORGABE: Darstellung = {
  stil: "ruhig",
  groesseNach: "links",
  farbeNach: "cluster",
  ebenen: {
    cluster: true,
    waisen: true,
    sackgassen: false,
    kaputt: false,
    pfeile: false,
    spur: true,
    namen: "auto",
  },
  kraefte: { ...KRAEFTE, abstossung: 3200, laenge: 60, cluster: 0.018 },
  gruppen: [],
  filter: "",
  nurTreffer: false,
};

interface StilDef {
  name: string;
  palette: string[];
  /** Stärke des Scheins um die Punkte, 0 = keiner. */
  schein: number;
  /** Kanten in der Farbe ihrer Quelle statt neutral. */
  getoent: boolean;
  kantenAlpha: number;
  kugel: boolean;
}

export const STILE: Record<Stil, StilDef> = {
  // Die Vorgabe (Jakob, 03.10.: die leuchtenden Kugeln wirkten „zu viel, überladen"): flache
  // Punkte wie in Obsidian, gedämpfte Farben, kein Schein.
  ruhig: {
    name: "Ruhig",
    palette: [
      "#9d92e6",
      "#7fb6d9",
      "#d79ac0",
      "#8fcfb8",
      "#d6bd86",
      "#8b9be0",
      "#b7a0dc",
      "#86c9d1",
    ],
    schein: 0,
    getoent: false,
    kantenAlpha: 0.13,
    kugel: false,
  },
  glut: {
    name: "Glut",
    palette: [
      "#f4b860",
      "#7fd3a8",
      "#6d90ff",
      "#e98a6b",
      "#b4a6ff",
      "#56d2c2",
      "#f2d36b",
      "#f59ac8",
    ],
    schein: 0,
    getoent: false,
    kantenAlpha: 0.13,
    kugel: false,
  },
  galaxie: {
    name: "Galaxie",
    palette: [
      "#8f7dff",
      "#4fc3ff",
      "#ff6fd8",
      "#7affd4",
      "#ffd36e",
      "#5d7bff",
      "#c58bff",
      "#6ef0ff",
    ],
    schein: 1,
    getoent: true,
    kantenAlpha: 0.2,
    kugel: true,
  },
  tusche: {
    name: "Tusche",
    palette: [
      "#e3ddd1",
      "#b9b2a5",
      "#cdb48d",
      "#93a0aa",
      "#b9a9cc",
      "#9fb8a6",
      "#c9a79b",
      "#a9a9a9",
    ],
    schein: 0,
    getoent: false,
    kantenAlpha: 0.16,
    kugel: false,
  },
};

/** Farbe je Ordner in der Glut — dieselben Lichter wie überall in Kuronami. */
export const GRUPPEN_FARBE: Record<string, string> = {
  "": "#e8eff1",
  Bereiche: "#f4b860",
  Trading: "#7fd3a8",
  Wissen: "#6d90ff",
  Gespräche: "#93a7b0",
  Planung: "#8878ff",
  Finanzen: "#ffb35c",
  Eingang: "#56d2c2",
};

export interface KnotenInfo {
  pfad: string;
  titel: string;
  ordner: string;
  tags: string[];
  ein: number;
  aus: number;
  platz: number;
  cluster: string;
  clusterFarbe: string;
  farbe: string;
  erstellt: number;
  geaendert: number;
  angeheftet: boolean;
  geist: boolean;
}

export interface Kennzahlen {
  notizen: number;
  links: number;
  waisen: string[];
  sackgassen: string[];
  kaputt: Array<[string, string]>;
  gemeinschaften: Array<{ name: string; farbe: string; anzahl: number; mitte: string }>;
  top: string[];
  kalt: string[];
  treffer: number;
  titel: Map<string, string>;
  tage: Array<{ tag: number; neu: number }>;
  legende: Array<{ name: string; farbe: string }>;
}

export interface GraphOptionen {
  aktiv?: string | null;
  /** Der kleine Graph neben einer Notiz: Namen immer, kein Rad-Zoom, blasser nach Abstand. */
  lokal?: boolean;
  darstellung?: Partial<Darstellung>;
  /** Angeheftete Notizen mit ihrem Ort. */
  pins?: Record<string, { x: number; y: number }>;
  onOeffne(pfad: string): void;
  onAuswahl?(info: KnotenInfo | null): void;
  onModus?(modus: Modus): void;
  onZeit?(zeit: number, spanne: [number, number], laeuft: boolean): void;
  onErkunden?(weg: string[]): void;
  onPins?(pins: Record<string, { x: number; y: number }>): void;
  onKontext?(pfad: string, x: number, y: number): void;
  /** Der Weg, den Jakob durchs Brain genommen hat, neueste zuletzt. */
  spur?(): string[];
}

export interface GraphApi {
  setzeAktiv(pfad: string | null): void;
  zentriere(): void;
  setze(d: Partial<Darstellung>): void;
  darstellung(): Darstellung;
  kennzahlen(): Kennzahlen;
  waehle(pfad: string | null, fliegen?: boolean): void;
  fokus(pfad: string | null, tiefe?: number): void;
  erkunde(pfad: string | null): void;
  zurueck(): void;
  zeitreise(an: boolean): void;
  zeitpunkt(zeit: number): void;
  spiele(an?: boolean): void;
  spurAbspielen(): void;
  anheften(pfad: string, an?: boolean): void;
  modus(): Modus;
  bild(): Promise<Blob | null>;
  loesen(): void;
}

const GEIST = "\u0000";
const TAG_MS = 86_400_000;

export function mischeDarstellung(basis: Darstellung, d: Partial<Darstellung> = {}): Darstellung {
  return {
    ...basis,
    ...d,
    ebenen: { ...basis.ebenen, ...(d.ebenen ?? {}) },
    kraefte: { ...basis.kraefte, ...(d.kraefte ?? {}) },
    gruppen: (d.gruppen ?? basis.gruppen).map((g) => ({ ...g })),
  };
}

const sanft = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export function mountGraph(host: HTMLElement, daten: GraphDaten, opt: GraphOptionen): GraphApi {
  const leinwand = document.createElement("canvas");
  leinwand.className = "g-leinwand";
  host.append(leinwand);
  const ctx = leinwand.getContext("2d") as CanvasRenderingContext2D;
  const lokal = opt.lokal === true;
  let d = mischeDarstellung(VORGABE, opt.darstellung);
  if (!STILE[d.stil]) d.stil = VORGABE.stil;
  // Im kleinen Graphen gibt es meist nur einen Cluster — dort trägt der Ordner die Farbe.
  if (lokal)
    d = mischeDarstellung(d, {
      farbeNach: "ordner",
      ebenen: { ...d.ebenen, cluster: false, spur: false },
    });

  // ------------------------------------------------------------------ Netz und Kennzahlen
  let netz: Netz = baueNetz([], []);
  let quelle: GraphKnotenDaten[] = [];
  let gerichtet: Array<[number, number]> = [];
  let ein: number[] = [];
  let aus: number[] = [];
  let rang: number[] = [];
  let platz: number[] = [];
  let gruppe: number[] = [];
  let gemeinschaften: Gemeinschaft[] = [];
  let geist: boolean[] = [];
  /** Kennzahl für die Größe, 0 … 1 (Links und PageRank normiert, sonst bliebe alles gleich groß). */
  let normLinks: number[] = [];
  let normRang: number[] = [];
  const index = new Map<string, number>();
  const pins: Record<string, { x: number; y: number }> = { ...(opt.pins ?? {}) };

  /** Alle Notizen, die wichtigsten zuerst: nach Links, bei Gleichstand nach PageRank. */
  function wichtig(n = netz.knoten.length): number[] {
    return Array.from({ length: n }, (_, i) => i).sort(
      (a, b) => netz.knoten[b].grad - netz.knoten[a].grad || rang[b] - rang[a],
    );
  }

  function baue() {
    const alt = new Map(netz.knoten.map((k) => [k.id, k]));
    quelle = daten.knoten.map((k) => ({ ...k }));
    const echte = new Set(quelle.map((k) => k.pfad));
    const kanten: Array<[string, string]> = daten.kanten.filter(
      ([a, b]) => echte.has(a) && echte.has(b),
    );
    if (d.ebenen.kaputt && !lokal) {
      const geister = new Set<string>();
      for (const [von, wie] of daten.offen ?? []) {
        if (!echte.has(von)) continue;
        const id = `${GEIST}${wie}`;
        if (!geister.has(id)) {
          geister.add(id);
          quelle.push({ pfad: id, titel: wie, ordner: GEIST });
        }
        kanten.push([von, id]);
      }
    }
    netz = baueNetz(quelle, kanten);
    netz.kraefte = { ...d.kraefte };
    index.clear();
    netz.knoten.forEach((k, i) => index.set(k.id, i));
    geist = netz.knoten.map((k) => k.id.startsWith(GEIST));
    gerichtet = [];
    const gesehen = new Set<string>();
    for (const [a, b] of kanten) {
      const ia = index.get(a);
      const ib = index.get(b);
      if (ia === undefined || ib === undefined || ia === ib) continue;
      const s = `${ia}>${ib}`;
      if (gesehen.has(s)) continue;
      gesehen.add(s);
      gerichtet.push([ia, ib]);
    }
    const n = netz.knoten.length;
    ein = new Array(n).fill(0);
    aus = new Array(n).fill(0);
    for (const [a, b] of gerichtet) {
      aus[a] += 1;
      ein[b] += 1;
    }
    rang = pageRank(n, gerichtet);
    // Der Platz zählt nach Links: in einem Brain aus Verzeichnissen sammelt PageRank sein Gewicht
    // in den Blättern (gemessen 03.10.: Murphy und AAPL Long vorn) — als Rangfolge taugt das nicht.
    platz = new Array(n).fill(0);
    wichtig(n).forEach((i, p) => {
      platz[i] = p + 1;
    });
    const normiere = (werte: number[]) => {
      const lo = Math.min(...werte);
      const hi = Math.max(...werte);
      return werte.map((w) => (hi > lo ? (w - lo) / (hi - lo) : 0));
    };
    normLinks = normiere(netz.knoten.map((k) => Math.sqrt(k.grad)));
    normRang = normiere(rang.map((r) => Math.sqrt(r)));
    gruppe = louvain(n, netz.kanten);
    // Eine Gruppe heißt wie ihr Knotenpunkt — die Notiz mit den meisten Links in der Gruppe.
    const innen = netz.knoten.map(
      (k, i) =>
        [...netz.nachbarn[i]].filter((j) => gruppe[j] === gruppe[i]).length +
        (k.stufe === 0 ? 0.5 : 0),
    );
    gemeinschaften = benenne(
      gruppe,
      netz.knoten.map((k) => k.titel),
      innen,
      netz.knoten.map((k) => k.stufe),
    );
    netz.knoten.forEach((k, i) => {
      k.gemeinschaft = gruppe[i];
      const vorher = alt.get(k.id);
      if (vorher) {
        k.x = vorher.x;
        k.y = vorher.y;
      }
      const pin = pins[k.id];
      if (pin) {
        k.x = pin.x;
        k.y = pin.y;
        k.angeheftet = true;
      }
    });
    if (alt.size === 0) {
      // Vorlauf ohne Zeichnen: der Graph steht schon beim ersten Bild fast still.
      for (let i = 0; i < (lokal ? 160 : 180); i++) schritt(netz);
    } else netz.waerme = 0.4;
    baueFarben();
    baueFilterNeu();
  }

  // ----------------------------------------------------------------------------- Farben
  let hell = false;
  let f = { kante: "", betont: "", schrift: "", schriftHell: "", wurzel: "", grund: "" };
  function liesHuelle() {
    hell = document.documentElement.dataset.helligkeit === "hell";
    const st = getComputedStyle(leinwand);
    const lies = (name: string, vorgabe: string) => st.getPropertyValue(name).trim() || vorgabe;
    f = {
      kante: lies("--g-kante", "rgba(232, 239, 241, 0.13)"),
      betont: lies("--g-betont", "rgba(244, 184, 96, 0.7)"),
      schrift: lies("--g-schrift", "#c9d4d8"),
      schriftHell: lies("--g-schrift-hell", "#ffffff"),
      wurzel: lies("--g-wurzel", GRUPPEN_FARBE[""] ?? "#e8eff1"),
      grund: lies("--o-inhalt", "#141310"),
    };
  }
  const sprites = new Map<string, HTMLCanvasElement>();
  let blasenEbene: HTMLCanvasElement | null = null;
  // Im Dunkeln: Clusterfarbe zu 11 % in Schwarz, zu 70 % über dem Grund — dunkle Becken mit
  // einem Hauch Farbe, gerade noch vom Grund zu unterscheiden.
  const dunkelTon = 0.11;
  const dunkelDeckung = 0.7;
  let farbe: string[] = [];
  let clusterFarbe: string[] = [];
  let legende: Array<{ name: string; farbe: string }> = [];

  /** Im Hellen werden leuchtende Farben dunkler, sonst verschwinden sie auf dem Papier. */
  const fuerHuelle = (c: string) => (hell ? mische(c, "#2a2118", 0.28) : c);

  function baueFarben() {
    const stil = STILE[d.stil];
    const n = netz.knoten.length;
    clusterFarbe = gemeinschaften.map((g) =>
      fuerHuelle(stil.palette[g.nummer % stil.palette.length]),
    );
    const proOrdner = new Map<string, number>();
    for (const k of netz.knoten) {
      if (k.gruppe && k.gruppe !== GEIST)
        proOrdner.set(k.gruppe, (proOrdner.get(k.gruppe) ?? 0) + 1);
    }
    const ordnerReihe = [...proOrdner.entries()].sort((a, b) => b[1] - a[1]).map(([o]) => o);
    const ordnerFarbe = (o: string) => {
      if (o === "") return d.stil === "glut" ? f.wurzel : fuerHuelle(stil.palette[0]);
      if (d.stil === "glut" && GRUPPEN_FARBE[o]) return fuerHuelle(GRUPPEN_FARBE[o]);
      const p = ordnerReihe.indexOf(o);
      return fuerHuelle(
        stil.palette[(p < 0 ? 7 : p + (d.stil === "glut" ? 4 : 1)) % stil.palette.length],
      );
    };
    const spanne = (feld: "erstellt" | "geaendert"): [number, number] => {
      const z = quelle.map((q) => q[feld] ?? 0).filter((t) => t > 0);
      return z.length > 0 ? [Math.min(...z), Math.max(...z)] : [0, 1];
    };
    const kalt = hell ? "#8e9aa6" : "#3d4c66";
    const warm = hell ? "#b46e15" : "#ffd08a";
    const nachZeit = (feld: "erstellt" | "geaendert") => {
      const [lo, hi] = spanne(feld);
      return (i: number) => {
        const t = quelle[i][feld] ?? 0;
        return mische(kalt, warm, hi > lo ? (t - lo) / (hi - lo) : 1);
      };
    };
    const regeln = d.gruppen
      .map((g) => ({ farbe: leseFarbe(g.farbe), filter: baueFilter(g.abfrage, filterKontext()) }))
      .filter((r) => r.farbe && !r.filter.leer && !r.filter.fehler);
    const grund =
      d.farbeNach === "cluster"
        ? (i: number) => clusterFarbe[gruppe[i]] ?? stil.palette[0]
        : d.farbeNach === "geaendert" || d.farbeNach === "erstellt"
          ? nachZeit(d.farbeNach)
          : (i: number) => ordnerFarbe(netz.knoten[i].gruppe);
    farbe = Array.from({ length: n }, (_, i) => {
      if (geist[i]) return hell ? "#a39d92" : "#5d5850";
      const eigen = leseFarbe(quelle[i].farbe);
      if (eigen) return fuerHuelle(eigen);
      const regel = regeln.find((r) => r.filter.passt(i));
      if (regel?.farbe) return fuerHuelle(regel.farbe);
      return grund(i);
    });
    if (d.farbeNach === "cluster") {
      legende = gemeinschaften
        .filter((g) => g.glieder.length >= 2)
        .slice(0, 10)
        .map((g) => ({ name: g.name, farbe: clusterFarbe[g.nummer] }));
    } else if (d.farbeNach === "ordner") {
      legende = ["", ...ordnerReihe].map((o) => ({ name: o || "Wurzel", farbe: ordnerFarbe(o) }));
    } else {
      legende = [
        { name: d.farbeNach === "erstellt" ? "früh entstanden" : "lange unberührt", farbe: kalt },
        { name: d.farbeNach === "erstellt" ? "neu" : "frisch bearbeitet", farbe: warm },
      ];
    }
    for (const g of d.gruppen) {
      const c = leseFarbe(g.farbe);
      if (c && g.abfrage.trim()) legende.push({ name: g.abfrage.trim(), farbe: fuerHuelle(c) });
    }
  }

  // ------------------------------------------------------------------------------ Filter
  let filter: { passt(i: number): boolean; leer: boolean; fehler: string | null } = {
    passt: () => true,
    leer: true,
    fehler: null,
  };
  function filterKontext() {
    return {
      knoten: quelle.map((q) => ({
        pfad: q.pfad,
        titel: q.titel,
        ordner: q.ordner,
        tags: q.tags ?? [],
        farbe: q.farbe ?? null,
        erstellt: q.erstellt ?? 0,
        geaendert: q.geaendert ?? 0,
      })),
      grad: netz.knoten.map((k) => k.grad),
      ein,
      aus,
      clusterName: (i: number) => gemeinschaften[gruppe[i]]?.name ?? "",
      angeheftet: (i: number) => netz.knoten[i]?.angeheftet ?? false,
      jetzt: Date.now(),
    };
  }
  function baueFilterNeu() {
    filter = baueFilter(d.filter, filterKontext());
  }

  // ------------------------------------------------------------------------- Zustand
  let aktiv = opt.aktiv ?? null;
  let gewaehlt: number | null = null;
  let schwebe: number | null = null;
  let modus: Modus = "uebersicht";
  let fokusWurzel: number | null = null;
  let fokusTiefe = 2;
  let fokusAbstand: number[] = [];
  let erkundenBei: number | null = null;
  let erkundenWeg: number[] = [];
  let zielStrahl: number | null = null;
  let zeiger = { x: 0, y: 0 };
  let fanStart = 0;
  let zeit = Number.POSITIVE_INFINITY;
  let zeitSpanne: [number, number] = [0, 1];
  let spielt = false;
  let spielStart = 0;
  let spielVonIdx = 0;
  /** Die Tage, an denen etwas entstand — die Zeitreise geht von Tag zu Tag, Lücken überspringt sie. */
  let zeitTage: number[] = [];
  const TAG_SCHRITT_MS = 700;
  const erschienen = new Map<number, number>();
  const spurStart = performance.now();
  let spurReplay = 0;

  let breite = 0;
  let hoehe = 0;
  let dpr = 1;
  const kamera = { s: 1, x: 0, y: 0 };
  let flug: { von: typeof kamera; nach: typeof kamera; start: number; dauer: number } | null = null;
  let handBewegt = false;
  let erstesRuhen = true;
  let laeuft = false;
  let ziehen:
    | { art: "knoten"; i: number; sx: number; sy: number }
    | { art: "flaeche"; x: number; y: number }
    | null = null;
  let bewegt = false;
  let lebt = true;

  liesHuelle();
  baue();

  // -------------------------------------------------------------------------- Geometrie
  const zuBild = (x: number, y: number) => ({
    x: breite / 2 + kamera.x + x * kamera.s,
    y: hoehe / 2 + kamera.y + y * kamera.s,
  });
  const zuWelt = (x: number, y: number) => ({
    x: (x - breite / 2 - kamera.x) / kamera.s,
    y: (y - hoehe / 2 - kamera.y) / kamera.s,
  });

  /** Radius in Weltmaß nach der gewählten Kennzahl. */
  function weltRadius(i: number): number {
    const k = netz.knoten[i];
    if (geist[i]) return 3;
    if (lokal && k.id === aktiv) return 9;
    switch (d.groesseNach) {
      case "links":
        return 2.6 + normLinks[i] * 9.5;
      case "pagerank":
        return 2.6 + normRang[i] * 9.5;
      case "gleich":
        return 4.5;
      default: {
        const GROESSE = [15, 10.5, 7, 3.6];
        return (
          (GROESSE[k.stufe] ?? 3.6) + (k.stufe === 3 ? Math.min(2, Math.sqrt(k.grad) * 0.5) : 0)
        );
      }
    }
  }
  const zoomFaktor = () => Math.max(0.7, Math.min(1.6, Math.sqrt(kamera.s)));
  const bildRadius = (i: number) => Math.max(2.5, weltRadius(i) * zoomFaktor());

  function sichtbar(i: number): boolean {
    if (geist[i] && !d.ebenen.kaputt) return false;
    if (modus === "zeitreise" && !geist[i] && (quelle[i].erstellt ?? 0) > zeit) return false;
    if (modus === "fokus" && (fokusAbstand[i] ?? Number.POSITIVE_INFINITY) > fokusTiefe)
      return false;
    if (d.nurTreffer && !filter.leer && !filter.passt(i)) return false;
    return true;
  }

  // --------------------------------------------------------------------------- Sprites
  function schein(c: string): HTMLCanvasElement {
    const schluessel = `s${c}${hell}`;
    let s = sprites.get(schluessel);
    if (s) return s;
    s = document.createElement("canvas");
    s.width = s.height = 128;
    const g = s.getContext("2d") as CanvasRenderingContext2D;
    const v = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    v.addColorStop(0, `${c}${hell ? "55" : "88"}`);
    v.addColorStop(0.25, `${c}${hell ? "22" : "3a"}`);
    v.addColorStop(0.6, `${c}${hell ? "08" : "10"}`);
    v.addColorStop(1, `${c}00`);
    g.fillStyle = v;
    g.fillRect(0, 0, 128, 128);
    sprites.set(schluessel, s);
    return s;
  }
  function kugel(c: string, glanz: boolean): HTMLCanvasElement {
    const schluessel = `k${c}${glanz}${hell}`;
    let s = sprites.get(schluessel);
    if (s) return s;
    s = document.createElement("canvas");
    s.width = s.height = 64;
    const g = s.getContext("2d") as CanvasRenderingContext2D;
    g.beginPath();
    g.arc(32, 32, 31, 0, Math.PI * 2);
    if (glanz) {
      const v = g.createRadialGradient(21, 19, 2, 32, 32, 32);
      v.addColorStop(0, hell ? mische(c, "#ffffff", 0.55) : "#ffffff");
      v.addColorStop(0.32, c);
      v.addColorStop(1, mische(c, "#000000", hell ? 0.25 : 0.5));
      g.fillStyle = v;
    } else g.fillStyle = c;
    g.fill();
    sprites.set(schluessel, s);
    return s;
  }

  const huellenBeobachter = new MutationObserver(() => {
    liesHuelle();
    sprites.clear();
    baueFarben();
    zeichne();
  });
  huellenBeobachter.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-helligkeit"],
  });

  // ---------------------------------------------------------------------------- Zeichnen
  const SCHRIFT = lokal ? [12, 11.5, 11, 11] : [15, 13.5, 12.5, 11.5];
  /** Name eines Punkts: Größe und Gewicht folgen dem Punkt — ein großer Knoten spricht lauter. */
  const namensGroesse = (i: number) => (lokal ? 11.5 : weltRadius(i) >= 8 ? 13 : 12);
  const namensSchrift = (i: number, gross = false) =>
    `${weltRadius(i) >= 8 || gross ? 500 : 400} ${namensGroesse(i) + (gross ? 0.5 : 0)}px Figtree, system-ui, sans-serif`;
  const schrift = (st: number, gross = false) =>
    `${st <= 1 || gross ? 600 : 400} ${(SCHRIFT[st] ?? 11.5) + (gross ? 1 : 0)}px Figtree, system-ui, sans-serif`;

  function alphaVon(i: number, jetzt: number): number {
    let a = 1;
    if (modus === "fokus") a = [1, 0.95, 0.62, 0.42, 0.3][fokusAbstand[i] ?? 9] ?? 0.25;
    if (lokal && aktiv) a = [1, 0.9, 0.5, 0.32][fokusAbstand[i] ?? 9] ?? 0.25;
    if (!filter.leer && !filter.passt(i)) a *= 0.1;
    if (schwebe !== null && modus !== "erkunden") {
      const nah = schwebe === i || netz.nachbarn[schwebe].has(i);
      if (!nah) a *= 0.16;
    }
    if (modus === "erkunden") a *= 0.13;
    const da = erschienen.get(i);
    if (da !== undefined) a *= Math.min(1, (jetzt - da) / 380);
    return a;
  }

  function zeichne() {
    const jetzt = performance.now();
    const stil = STILE[d.stil];
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, breite, hoehe);
    const n = netz.knoten.length;
    const sicht = new Array<boolean>(n);
    const alpha = new Array<number>(n);
    const p = new Array<{ x: number; y: number }>(n);
    for (let i = 0; i < n; i++) {
      sicht[i] = sichtbar(i);
      alpha[i] = sicht[i] ? alphaVon(i, jetzt) : 0;
      p[i] = zuBild(netz.knoten[i].x, netz.knoten[i].y);
    }

    // Cluster als Blasen hinter allem; ihre Namen kommen zuletzt, und Notiznamen weichen ihnen.
    const blasenNamen =
      d.ebenen.cluster && !lokal && modus !== "erkunden" ? zeichneBlasen(sicht, p) : [];

    // Kanten, gebündelt nach Farbe und Helligkeit — ein Strich je Bündel statt je Kante.
    const buendel = new Map<string, Array<[number, number]>>();
    const hervor = schwebe;
    for (const { a, b } of netz.kanten) {
      if (!sicht[a] || !sicht[b]) continue;
      const betont = hervor !== null && (a === hervor || b === hervor);
      const al = Math.min(alpha[a], alpha[b]);
      if (al < 0.02 && !betont) continue;
      const stufe = betont ? 10 : Math.max(1, Math.round(al * 6));
      const ton = betont ? "B" : stil.getoent ? farbe[a] : "N";
      const s = `${ton}|${stufe}`;
      const liste = buendel.get(s) ?? [];
      liste.push([a, b]);
      buendel.set(s, liste);
    }
    for (const [s, liste] of buendel) {
      const [ton, stufe] = s.split("|");
      const st = Number(stufe);
      ctx.beginPath();
      for (const [a, b] of liste) {
        ctx.moveTo(p[a].x, p[a].y);
        ctx.lineTo(p[b].x, p[b].y);
      }
      if (ton === "B") {
        ctx.strokeStyle = f.betont;
        ctx.globalAlpha = 1;
        ctx.lineWidth = 1.5;
      } else {
        ctx.strokeStyle = ton === "N" ? f.kante : ton;
        ctx.globalAlpha = ton === "N" ? st / 6 : (stil.kantenAlpha * st) / 6;
        ctx.lineWidth = ton === "N" ? 1 : 0.9;
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Pfeile: im Fokus, im kleinen Graphen beim Heranzoomen oder wenn eingeschaltet.
    if (d.ebenen.pfeile || modus === "fokus") {
      ctx.fillStyle = f.betont;
      for (const [a, b] of gerichtet) {
        if (!sicht[a] || !sicht[b]) continue;
        const al = Math.min(alpha[a], alpha[b]);
        if (al < 0.25) continue;
        const dx = p[b].x - p[a].x;
        const dy = p[b].y - p[a].y;
        const l = Math.hypot(dx, dy);
        if (l < 24) continue;
        const ux = dx / l;
        const uy = dy / l;
        const r = bildRadius(b) + 2;
        const tx = p[b].x - ux * r;
        const ty = p[b].y - uy * r;
        ctx.globalAlpha = al * 0.8;
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(tx - ux * 6 - uy * 3, ty - uy * 6 + ux * 3);
        ctx.lineTo(tx - ux * 6 + uy * 3, ty - uy * 6 - ux * 3);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // Die Spur: der Weg durchs Brain als wandernde Linie.
    if (d.ebenen.spur && !lokal && modus !== "erkunden") zeichneSpur(sicht, p, jetzt);

    // Schein — vorgerendert, additiv im Dunkeln.
    if (stil.schein > 0) {
      ctx.globalCompositeOperation = hell ? "source-over" : "lighter";
      for (let i = 0; i < n; i++) {
        if (!sicht[i] || alpha[i] < 0.05 || geist[i]) continue;
        const r = bildRadius(i);
        const gross = i === gewaehlt || i === schwebe;
        const R = r * (gross ? 4.4 : 3.2) * (0.6 + stil.schein * 0.6);
        ctx.globalAlpha = alpha[i] * stil.schein * (hell ? 0.5 : 1);
        ctx.drawImage(schein(farbe[i]), p[i].x - R, p[i].y - R, R * 2, R * 2);
      }
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
    }

    // Punkte
    for (let i = 0; i < n; i++) {
      if (!sicht[i] || alpha[i] < 0.01) continue;
      const k = netz.knoten[i];
      let r = bildRadius(i);
      const da = erschienen.get(i);
      if (da !== undefined) {
        const t = Math.min(1, (jetzt - da) / 420);
        r *= t < 1 ? 0.3 + 1.1 * sanft(t) - 0.4 * sanft(Math.max(0, t - 0.6) / 0.4) : 1;
      }
      ctx.globalAlpha = alpha[i];
      if (geist[i]) {
        ctx.setLineDash([2, 2]);
        ctx.strokeStyle = farbe[i];
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(p[i].x, p[i].y, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        continue;
      }
      ctx.drawImage(kugel(farbe[i], stil.kugel && r > 3), p[i].x - r, p[i].y - r, r * 2, r * 2);
      if (k.stufe <= 1 && d.groesseNach === "rang") {
        ctx.strokeStyle = farbe[i];
        ctx.globalAlpha = alpha[i] * 0.4;
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.arc(p[i].x, p[i].y, r + (k.stufe === 0 ? 6 : 4), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = alpha[i];
      if (d.ebenen.waisen && k.grad === 0) {
        ctx.strokeStyle = hell ? "#bf433a" : "#f08a8a";
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.arc(p[i].x, p[i].y, r + 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (d.ebenen.sackgassen && aus[i] === 0 && k.grad > 0) {
        ctx.strokeStyle = f.schrift;
        ctx.setLineDash([1, 3]);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(p[i].x, p[i].y, r + 3.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (k.angeheftet) {
        ctx.fillStyle = f.betont;
        ctx.beginPath();
        ctx.arc(p[i].x + r * 0.75, p[i].y - r * 0.75, 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
      if (k.id === aktiv || i === gewaehlt) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = f.betont;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p[i].x, p[i].y, r + 4, 0, Math.PI * 2);
        ctx.stroke();
        if (i === gewaehlt) {
          ctx.globalAlpha = 0.35;
          ctx.beginPath();
          ctx.arc(p[i].x, p[i].y, r + 9, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }
    ctx.globalAlpha = 1;

    zeichneNamen(sicht, alpha, p, blasenNamen);
    for (const b of blasenNamen) {
      ctx.font = "600 10.5px Figtree, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = b.farbe;
      ctx.globalAlpha = schwebe === null ? 0.6 : 0.25;
      ctx.letterSpacing = "1.8px";
      ctx.fillText(b.text, b.x, b.y);
      ctx.letterSpacing = "0px";
    }
    ctx.globalAlpha = 1;
    if (modus === "erkunden") zeichneFaecher(p, jetzt);
  }

  type BlasenName = {
    text: string;
    x: number;
    y: number;
    farbe: string;
    box: [number, number, number, number];
  };

  /**
   * Cluster als Flächen, die sich um ihre Notizen legen: die konvexe Hülle, mit runden Ecken
   * aufgeweitet, gleichmäßig leicht getönt. Erst auf eine eigene Ebene in voller Farbe, dann
   * einmal blass darüber — so bleibt die Tönung gleichmäßig, auch wo Rand und Fläche sich decken.
   * Im Dunkeln liegen sie nur ganz leise hinter dem Grund, im Hellen deutlicher (Jakob, 03.10.:
   * der runde Lichtschatten verlief unnatürlich; die Flächen gefallen im Hellen, im Dunkeln
   * „sehr abdunkeln, nur sehr leicht am Hintergrund").
   */
  function zeichneBlasen(sicht: boolean[], p: Array<{ x: number; y: number }>): BlasenName[] {
    const namen: BlasenName[] = [];
    if (!blasenEbene) blasenEbene = document.createElement("canvas");
    if (blasenEbene.width !== leinwand.width || blasenEbene.height !== leinwand.height) {
      blasenEbene.width = leinwand.width;
      blasenEbene.height = leinwand.height;
    }
    const g2 = blasenEbene.getContext("2d") as CanvasRenderingContext2D;
    g2.setTransform(dpr, 0, 0, dpr, 0, 0);
    g2.clearRect(0, 0, breite, hoehe);
    g2.lineJoin = "round";
    g2.lineCap = "round";
    const rand = Math.max(14, Math.min(34, 24 * Math.sqrt(kamera.s)));
    let gezeichnet = false;
    for (const g of gemeinschaften) {
      const glieder = g.glieder.filter((i) => sicht[i] && !geist[i]);
      if (glieder.length < 4) continue;
      const h = huelle(glieder.map((i) => p[i]));
      if (h.length === 0) continue;
      const c = clusterFarbe[g.nummer];
      // Im Dunkeln ein Schatten: dunkler als der Grund, mit einem Hauch der Clusterfarbe.
      const ton = hell ? c : mische("#000000", c, dunkelTon);
      g2.fillStyle = ton;
      g2.strokeStyle = ton;
      g2.lineWidth = rand * 2;
      // Weich statt eckig: die Kurve läuft durch die Kantenmitten, die Ecken ziehen nur.
      g2.beginPath();
      if (h.length < 3) {
        g2.moveTo(h[0].x, h[0].y);
        for (const q of h.slice(1)) g2.lineTo(q.x, q.y);
      } else {
        const mitte = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
          x: (a.x + b.x) / 2,
          y: (a.y + b.y) / 2,
        });
        const start = mitte(h[h.length - 1], h[0]);
        g2.moveTo(start.x, start.y);
        for (let k = 0; k < h.length; k++) {
          const m = mitte(h[k], h[(k + 1) % h.length]);
          g2.quadraticCurveTo(h[k].x, h[k].y, m.x, m.y);
        }
      }
      g2.closePath();
      g2.fill();
      g2.stroke();
      gezeichnet = true;
      // Ein Name nur, wenn er nicht schon am Knotenpunkt steht.
      const mitteTitel = netz.knoten[g.mitte]?.titel ?? "";
      if (g.name.toLowerCase() === mitteTitel.toLowerCase()) continue;
      let minX = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      for (const q of h) {
        minX = Math.min(minX, q.x);
        maxX = Math.max(maxX, q.x);
        minY = Math.min(minY, q.y);
      }
      const text = g.name.toUpperCase();
      ctx.font = "500 10.5px Figtree, system-ui, sans-serif";
      ctx.letterSpacing = "1.6px";
      const w = ctx.measureText(text).width;
      ctx.letterSpacing = "0px";
      const cx = (minX + maxX) / 2;
      let y = Math.max(78, minY - rand - 9);
      const box = (yy: number): [number, number, number, number] => [
        cx - w / 2 - 6,
        yy - 9,
        w + 12,
        18,
      ];
      for (let versuch = 0; versuch < 6; versuch++) {
        const b = box(y);
        const stoesst = namen.some(
          (n) =>
            b[0] < n.box[0] + n.box[2] &&
            n.box[0] < b[0] + b[2] &&
            b[1] < n.box[1] + n.box[3] &&
            n.box[1] < b[1] + b[3],
        );
        if (!stoesst) break;
        y += 20;
      }
      namen.push({ text, x: cx, y, farbe: c, box: box(y) });
    }
    if (gezeichnet) {
      ctx.globalAlpha = hell ? 0.065 : dunkelDeckung;
      ctx.drawImage(blasenEbene, 0, 0, breite, hoehe);
      ctx.globalAlpha = 1;
    }
    return namen;
  }

  function spurStationen(sicht: boolean[]): number[] {
    const stationen: number[] = [];
    for (const pfad of opt.spur?.() ?? []) {
      const i = index.get(pfad);
      if (i !== undefined && sicht[i] && stationen.at(-1) !== i) stationen.push(i);
    }
    return stationen.slice(-12);
  }

  function zeichneSpur(sicht: boolean[], p: Array<{ x: number; y: number }>, jetzt: number) {
    const st = spurStationen(sicht);
    if (st.length < 2) return;
    const bis =
      spurReplay > 0 ? Math.min(st.length - 1, ((jetzt - spurReplay) / 650) | 0) : st.length - 1;
    ctx.save();
    ctx.strokeStyle = f.betont;
    ctx.lineWidth = 1.6;
    ctx.setLineDash([5, 7]);
    ctx.lineDashOffset = -((jetzt - spurStart) / 40);
    for (let s = 0; s < bis; s++) {
      const a = p[st[s]];
      const b = p[st[s + 1]];
      const mx = (a.x + b.x) / 2 - (b.y - a.y) * 0.18;
      const my = (a.y + b.y) / 2 + (b.x - a.x) * 0.18;
      ctx.globalAlpha = 0.25 + (0.6 * (s + 1)) / st.length;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(mx, my, b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  function zeichneNamen(
    sicht: boolean[],
    alpha: number[],
    p: Array<{ x: number; y: number }>,
    vorbelegt: BlasenName[] = [],
  ) {
    if (modus === "erkunden") return;
    const hervor = schwebe;
    const nah = hervor !== null ? netz.nachbarn[hervor] : null;
    const istHell = (i: number) => hervor === null || i === hervor || (nah?.has(i) ?? false);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const wert = (i: number) =>
      i === hervor
        ? 1e9
        : i === gewaehlt || netz.knoten[i].id === aktiv
          ? 1e8
          : (nah?.has(i) ? 1e7 : 0) +
            (filter.leer || !filter.passt(i) ? 0 : 1e6) +
            weltRadius(i) * 1e4;
    const zeigeAlle = d.ebenen.namen === "immer" || lokal;
    const kandidaten: number[] = [];
    for (let i = 0; i < netz.knoten.length; i++) {
      if (!sicht[i] || alpha[i] < 0.06) continue;
      const k = netz.knoten[i];
      const pflicht = i === hervor || i === gewaehlt || k.id === aktiv;
      if (d.ebenen.namen === "aus" && !pflicht) continue;
      if (
        pflicht ||
        zeigeAlle ||
        (hervor !== null && istHell(i)) ||
        (!filter.leer && filter.passt(i)) ||
        modus === "fokus" ||
        (hervor === null && (kamera.s > 1.6 || weltRadius(i) >= 7 || k.stufe <= 1))
      )
        kandidaten.push(i);
    }
    kandidaten.sort((a, b) => wert(b) - wert(a));
    const gesetzt: Array<[number, number, number, number]> = vorbelegt.map((b) => b.box);
    for (const i of kandidaten) {
      const k = netz.knoten[i];
      const q = p[i];
      if (q.x < -200 || q.x > breite + 200 || q.y < -40 || q.y > hoehe + 40) continue;
      const r = bildRadius(i);
      const text = k.titel.length > 34 ? `${k.titel.slice(0, 33)}…` : k.titel;
      const gross = i === hervor || i === gewaehlt;
      ctx.font = namensSchrift(i, gross);
      const w = ctx.measureText(text).width;
      const box: [number, number, number, number] = [
        q.x - w / 2 - 3,
        q.y + r + 2,
        w + 6,
        namensGroesse(i) + 5,
      ];
      const stoesst = gesetzt.some(
        ([x, y, bw, bh]) =>
          box[0] < x + bw && x < box[0] + box[2] && box[1] < y + bh && y < box[1] + box[3],
      );
      if (stoesst && i !== hervor && i !== gewaehlt && k.id !== aktiv) continue;
      gesetzt.push(box);
      ctx.globalAlpha = Math.min(1, alpha[i] * (istHell(i) ? (gross ? 1 : 0.85) : 0.6));
      const wichtig = gross || weltRadius(i) >= 8;
      ctx.fillStyle = geist[i] ? f.schrift : wichtig ? f.schriftHell : f.schrift;
      ctx.fillText(geist[i] ? `${text} (fehlt)` : text, q.x, q.y + r + 4);
    }
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------------------- Erkunden
  type Strahl = { i: number; winkel: number; richtung: "aus" | "ein" | "beide" };

  /** Die Strahlen um die Notiz, bei der die Kamera sitzt — Richtung aus dem Layout, gespreizt. */
  function faecher(): Strahl[] {
    if (erkundenBei === null) return [];
    const bei = erkundenBei;
    const mitte = netz.knoten[bei];
    const raus = new Set(gerichtet.filter(([a]) => a === bei).map(([, b]) => b));
    const rein = new Set(gerichtet.filter(([, b]) => b === bei).map(([a]) => a));
    const liste: Strahl[] = [...netz.nachbarn[bei]]
      .filter((i) => !geist[i] || d.ebenen.kaputt)
      .map((i) => ({
        i,
        winkel: Math.atan2(netz.knoten[i].y - mitte.y, netz.knoten[i].x - mitte.x),
        richtung: raus.has(i) && rein.has(i) ? "beide" : raus.has(i) ? "aus" : "ein",
      }));
    liste.sort((a, b) => a.winkel - b.winkel);
    // Spreizen: kein Strahl näher als der Mindestwinkel am Nachbarn.
    if (liste.length > 1) {
      const min = Math.min(0.42, ((Math.PI * 2) / liste.length) * 0.92);
      for (let runde = 0; runde < 40; runde++) {
        let ruhig = true;
        for (let k = 0; k < liste.length; k++) {
          const a = liste[k];
          const b = liste[(k + 1) % liste.length];
          let diff = b.winkel - a.winkel;
          if (k === liste.length - 1) diff += Math.PI * 2;
          if (diff < min) {
            const schub = (min - diff) / 2;
            a.winkel -= schub;
            b.winkel += schub;
            ruhig = false;
          }
        }
        if (ruhig) break;
      }
    }
    return liste;
  }

  const strahlLaenge = () => Math.max(140, Math.min(breite, hoehe) * 0.34);

  function waehleStrahl() {
    if (modus !== "erkunden" || erkundenBei === null) {
      zielStrahl = null;
      return;
    }
    const m = zuBild(netz.knoten[erkundenBei].x, netz.knoten[erkundenBei].y);
    const dx = zeiger.x - m.x;
    const dy = zeiger.y - m.y;
    if (Math.hypot(dx, dy) < 26) {
      zielStrahl = null;
      return;
    }
    // Gezielt wird nach Richtung, nicht nach Pixel — so trifft man auch an vollen Knoten.
    const w = Math.atan2(dy, dx);
    let bester: number | null = null;
    let abw = Number.POSITIVE_INFINITY;
    for (const s of faecher()) {
      let diff = Math.abs(s.winkel - w) % (Math.PI * 2);
      if (diff > Math.PI) diff = Math.PI * 2 - diff;
      if (diff < abw) {
        abw = diff;
        bester = s.i;
      }
    }
    zielStrahl = abw < 0.9 ? bester : null;
  }

  function zeichneFaecher(p: Array<{ x: number; y: number }>, jetzt: number) {
    if (erkundenBei === null) return;
    const stil = STILE[d.stil];
    const t = Math.max(0, Math.min(1, (jetzt - fanStart) / 320));
    const a0 = sanft(t);
    const m = p[erkundenBei];
    const L = strahlLaenge() * (0.55 + 0.45 * a0);
    // Die Notiz in der Mitte, groß.
    const rm = Math.max(12, Math.min(18, bildRadius(erkundenBei) * 1.4));
    if (stil.schein > 0) {
      ctx.globalCompositeOperation = hell ? "source-over" : "lighter";
      ctx.globalAlpha = 0.9;
      ctx.drawImage(schein(farbe[erkundenBei]), m.x - rm * 5, m.y - rm * 5, rm * 10, rm * 10);
      ctx.globalCompositeOperation = "source-over";
    }
    ctx.globalAlpha = 1;
    ctx.drawImage(kugel(farbe[erkundenBei], stil.kugel), m.x - rm, m.y - rm, rm * 2, rm * 2);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "600 17px Figtree, system-ui, sans-serif";
    ctx.fillStyle = f.schriftHell;
    ctx.fillText(netz.knoten[erkundenBei].titel, m.x, m.y + rm + 16);
    const etiketten: Array<[number, number, number, number]> = [];
    const liste = faecher();
    // Das Ziel zuletzt, damit sein Name nicht verdeckt wird.
    liste.sort((a, b) => Number(a.i === zielStrahl) - Number(b.i === zielStrahl));
    for (const s of liste) {
      const ziel = s.i === zielStrahl;
      const ex = m.x + Math.cos(s.winkel) * L;
      const ey = m.y + Math.sin(s.winkel) * L;
      const v = ctx.createLinearGradient(m.x, m.y, ex, ey);
      v.addColorStop(0, `${farbe[erkundenBei]}00`);
      v.addColorStop(1, farbe[s.i]);
      ctx.strokeStyle = v;
      ctx.globalAlpha = a0 * (zielStrahl === null ? 0.55 : ziel ? 1 : 0.22);
      ctx.lineWidth = ziel ? 2.4 : 1.2;
      ctx.beginPath();
      ctx.moveTo(m.x + Math.cos(s.winkel) * rm, m.y + Math.sin(s.winkel) * rm);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      const r = Math.max(4, Math.min(10, bildRadius(s.i))) * (ziel ? 1.35 : 1);
      ctx.globalAlpha = a0 * (zielStrahl === null || ziel ? 1 : 0.45);
      if (ziel && stil.schein > 0) {
        ctx.globalCompositeOperation = hell ? "source-over" : "lighter";
        ctx.drawImage(schein(farbe[s.i]), ex - r * 4.5, ey - r * 4.5, r * 9, r * 9);
        ctx.globalCompositeOperation = "source-over";
      }
      ctx.drawImage(kugel(farbe[s.i], stil.kugel), ex - r, ey - r, r * 2, r * 2);
      // Name außen am Strahl, mit Richtung: → ausgehend, ← eingehend, ↔ beides.
      const pfeil = s.richtung === "beide" ? "↔" : s.richtung === "aus" ? "→" : "←";
      const titel = netz.knoten[s.i].titel;
      const text = `${pfeil} ${titel.length > 30 ? `${titel.slice(0, 29)}…` : titel}`;
      const rechts = Math.cos(s.winkel) >= 0;
      ctx.textAlign = rechts ? "left" : "right";
      ctx.font = ziel
        ? "600 14px Figtree, system-ui, sans-serif"
        : "400 12px Figtree, system-ui, sans-serif";
      const tx = ex + (rechts ? r + 7 : -r - 7);
      const w = ctx.measureText(text).width;
      const box: [number, number, number, number] = [rechts ? tx : tx - w, ey - 8, w, 16];
      const stoesst = etiketten.some(
        ([x, y, bw, bh]) =>
          box[0] < x + bw && x < box[0] + box[2] && box[1] < y + bh && y < box[1] + box[3],
      );
      if (stoesst && !ziel) continue;
      etiketten.push(box);
      ctx.fillStyle = ziel ? f.schriftHell : f.schrift;
      ctx.fillText(text, tx, ey);
    }
    ctx.globalAlpha = 1;
  }

  // ---------------------------------------------------------------------------- Kamera
  function rahmenFuer(liste: number[]): typeof kamera | null {
    if (liste.length === 0 || breite === 0) return null;
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const i of liste) {
      const k = netz.knoten[i];
      minX = Math.min(minX, k.x);
      maxX = Math.max(maxX, k.x);
      minY = Math.min(minY, k.y);
      maxY = Math.max(maxY, k.y);
    }
    const s = Math.max(
      0.15,
      Math.min(
        2.2,
        (breite - (lokal ? 70 : 80)) / Math.max(1, maxX - minX),
        (hoehe - (lokal ? 56 : 150)) / Math.max(1, maxY - minY),
      ),
    );
    return { s, x: -((minX + maxX) / 2) * s, y: -((minY + maxY) / 2) * s };
  }

  function flieg(nach: typeof kamera | null, dauer = 520) {
    if (!nach) return;
    flug = { von: { ...kamera }, nach, start: performance.now(), dauer };
    wecke(0);
  }

  function zentriere(animiert = true) {
    const sichtbare = netz.knoten.map((_, i) => i).filter((i) => sichtbar(i));
    const ziel = rahmenFuer(sichtbare.length > 0 ? sichtbare : netz.knoten.map((_, i) => i));
    if (!ziel) return;
    if (animiert && breite > 0) flieg(ziel);
    else {
      Object.assign(kamera, ziel);
      zeichne();
    }
  }

  // ----------------------------------------------------------------------------- Takt
  function takt() {
    if (!lebt) return;
    const jetzt = performance.now();
    let weiter = false;
    if (modus !== "erkunden") {
      if (schritt(netz) || ziehen?.art === "knoten") weiter = true;
      else if (erstesRuhen) {
        erstesRuhen = false;
        if (!handBewegt && !lokal) zentriere();
      }
    }
    if (flug) {
      const t = Math.min(1, (jetzt - flug.start) / flug.dauer);
      const e = sanft(t);
      // Im Bogen: beim weiten Flug kurz herauszoomen.
      const weit = Math.hypot(flug.nach.x - flug.von.x, flug.nach.y - flug.von.y) > breite * 0.5;
      const bogen = weit ? 1 - 0.28 * Math.sin(Math.PI * t) : 1;
      kamera.s = (flug.von.s + (flug.nach.s - flug.von.s) * e) * bogen;
      kamera.x = (flug.von.x + (flug.nach.x - flug.von.x) * e) * bogen;
      kamera.y = (flug.von.y + (flug.nach.y - flug.von.y) * e) * bogen;
      if (t >= 1) flug = null;
      weiter = true;
    }
    if (spielt && zeitTage.length > 0) {
      let k = spielVonIdx + Math.floor((jetzt - spielStart) / TAG_SCHRITT_MS);
      const ende = k >= zeitTage.length - 1;
      k = Math.min(k, zeitTage.length - 1);
      const ziel = zeitTage[k] + TAG_MS - 1;
      if (ziel !== zeit) setzeZeit(ziel);
      if (ende && jetzt - spielStart > (k - spielVonIdx + 1) * TAG_SCHRITT_MS) {
        spielt = false;
        opt.onZeit?.(zeit, zeitSpanne, false);
      }
      weiter = true;
    }
    for (const [i, da] of erschienen) {
      if (jetzt - da > 460) erschienen.delete(i);
      else weiter = true;
    }
    if (modus === "erkunden" && jetzt - fanStart < 340) weiter = true;
    // Die Spur wandert — nur, solange man hinsieht und sie mehr als einen Halt hat.
    if (
      d.ebenen.spur &&
      !lokal &&
      modus !== "erkunden" &&
      document.visibilityState === "visible" &&
      (opt.spur?.().length ?? 0) > 1
    )
      weiter = true;
    if (spurReplay > 0 && jetzt - spurReplay > 12 * 650) spurReplay = 0;
    zeichne();
    if (weiter) requestAnimationFrame(takt);
    else laeuft = false;
  }
  function wecke(waerme = 0.25) {
    netz.waerme = Math.max(netz.waerme, waerme);
    if (laeuft) return;
    laeuft = true;
    requestAnimationFrame(takt);
  }

  // --------------------------------------------------------------------------- Zeitreise
  function setzeZeit(t: number) {
    const vorher = zeit;
    zeit = t;
    const jetzt = performance.now();
    for (let i = 0; i < quelle.length; i++) {
      const e = quelle[i].erstellt ?? 0;
      if (e <= zeit && e > vorher) erschienen.set(i, jetzt);
    }
    opt.onZeit?.(zeit, zeitSpanne, spielt);
  }

  // ------------------------------------------------------------------------------ Info
  function info(i: number): KnotenInfo {
    const q = quelle[i];
    const g = gemeinschaften[gruppe[i]];
    return {
      pfad: q.pfad,
      titel: q.titel,
      ordner: q.ordner,
      tags: q.tags ?? [],
      ein: ein[i],
      aus: aus[i],
      platz: platz[i],
      cluster: g?.name ?? "",
      clusterFarbe: clusterFarbe[gruppe[i]] ?? "",
      farbe: farbe[i],
      erstellt: q.erstellt ?? 0,
      geaendert: q.geaendert ?? 0,
      angeheftet: netz.knoten[i].angeheftet,
      geist: geist[i],
    };
  }

  function setzeAuswahl(i: number | null, fliegen = false) {
    gewaehlt = i;
    opt.onAuswahl?.(i === null ? null : info(i));
    if (i !== null && fliegen) {
      const k = netz.knoten[i];
      const s = Math.max(kamera.s, 1.4);
      flieg({ s, x: -k.x * s, y: -k.y * s });
    }
    zeichne();
  }

  function setzeModus(m: Modus) {
    if (modus === m) return;
    if (modus === "zeitreise") {
      spielt = false;
      zeit = Number.POSITIVE_INFINITY;
      erschienen.clear();
    }
    if (modus === "erkunden") {
      erkundenBei = null;
      erkundenWeg = [];
      zielStrahl = null;
      opt.onErkunden?.([]);
    }
    modus = m;
    opt.onModus?.(m);
  }

  function fokus(i: number | null, tiefe = fokusTiefe) {
    if (i === null) {
      setzeModus("uebersicht");
      fokusWurzel = null;
      zentriere();
      return;
    }
    fokusTiefe = Math.max(1, Math.min(4, tiefe));
    fokusWurzel = i;
    fokusAbstand = abstaende(i, netz.nachbarn, 4);
    setzeModus("fokus");
    setzeAuswahl(i);
    const liste = netz.knoten.map((_, j) => j).filter((j) => (fokusAbstand[j] ?? 9) <= fokusTiefe);
    flieg(rahmenFuer(liste));
  }

  function erkunde(i: number | null, merken = true) {
    if (i === null) {
      setzeModus("uebersicht");
      zentriere();
      return;
    }
    if (modus !== "erkunden") setzeModus("erkunden");
    if (merken && erkundenBei !== null && erkundenBei !== i) erkundenWeg.push(erkundenBei);
    erkundenBei = i;
    gewaehlt = i;
    schwebe = null;
    opt.onAuswahl?.(info(i));
    fanStart = performance.now() + 360;
    const k = netz.knoten[i];
    const s = 1.5;
    flieg({ s, x: -k.x * s, y: -k.y * s }, 480);
    opt.onErkunden?.([...erkundenWeg, i].map((j) => netz.knoten[j].titel));
    zielStrahl = null;
    leinwand.focus({ preventScroll: true });
  }

  // ----------------------------------------------------------------------- Eingaben
  function treffer(px: number, py: number): number | null {
    let bester: number | null = null;
    let abstand = Number.POSITIVE_INFINITY;
    netz.knoten.forEach((k, i) => {
      if (!sichtbar(i)) return;
      const q = zuBild(k.x, k.y);
      const dd = Math.hypot(q.x - px, q.y - py);
      const r = bildRadius(i) + 5;
      if (dd < r && dd < abstand) {
        bester = i;
        abstand = dd;
      }
    });
    return bester;
  }

  const lage = (e: MouseEvent) => {
    const r = leinwand.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  leinwand.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const q = lage(e);
    bewegt = false;
    leinwand.setPointerCapture(e.pointerId);
    const i = modus === "erkunden" ? null : treffer(q.x, q.y);
    if (i !== null) {
      ziehen = { art: "knoten", i, sx: q.x, sy: q.y };
      netz.knoten[i].fest = true;
    } else {
      ziehen = { art: "flaeche", x: q.x, y: q.y };
    }
  });
  leinwand.addEventListener("pointermove", (e) => {
    const q = lage(e);
    zeiger = q;
    if (ziehen?.art === "knoten") {
      if (!bewegt && Math.hypot(q.x - ziehen.sx, q.y - ziehen.sy) < 4) return;
      const w = zuWelt(q.x, q.y);
      const k = netz.knoten[ziehen.i];
      k.x = w.x;
      k.y = w.y;
      bewegt = true;
      wecke(0.3);
      return;
    }
    if (ziehen?.art === "flaeche") {
      if (Math.abs(q.x - ziehen.x) + Math.abs(q.y - ziehen.y) > 1) {
        bewegt = true;
        handBewegt = true;
        flug = null;
      }
      kamera.x += q.x - ziehen.x;
      kamera.y += q.y - ziehen.y;
      ziehen = { art: "flaeche", x: q.x, y: q.y };
      zeichne();
      return;
    }
    if (modus === "erkunden") {
      const vorher = zielStrahl;
      waehleStrahl();
      leinwand.style.cursor = zielStrahl === null ? "default" : "pointer";
      if (vorher !== zielStrahl) zeichne();
      return;
    }
    const i = treffer(q.x, q.y);
    if (i !== schwebe) {
      schwebe = i;
      leinwand.style.cursor = i === null ? "grab" : "pointer";
      zeichne();
    }
  });
  const loslassen = (e: PointerEvent) => {
    if (ziehen?.art === "knoten") {
      const k = netz.knoten[ziehen.i];
      k.fest = false;
      if (bewegt && k.angeheftet) {
        pins[k.id] = { x: k.x, y: k.y };
        opt.onPins?.({ ...pins });
      }
      if (!bewegt) {
        if (lokal) opt.onOeffne(k.id);
        else if (e.metaKey || e.ctrlKey) {
          if (!geist[ziehen.i]) opt.onOeffne(k.id);
        } else setzeAuswahl(ziehen.i === gewaehlt ? null : ziehen.i);
      }
    } else if (ziehen?.art === "flaeche" && !bewegt) {
      if (modus === "erkunden") {
        if (zielStrahl !== null) erkunde(zielStrahl);
      } else if (gewaehlt !== null) setzeAuswahl(null);
    }
    ziehen = null;
    if (leinwand.hasPointerCapture(e.pointerId)) leinwand.releasePointerCapture(e.pointerId);
  };
  leinwand.addEventListener("pointerup", loslassen);
  leinwand.addEventListener("pointercancel", loslassen);
  leinwand.addEventListener("pointerleave", () => {
    if (schwebe !== null && !ziehen) {
      schwebe = null;
      zeichne();
    }
  });
  leinwand.addEventListener(
    "wheel",
    (e) => {
      if (lokal && !e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      const q = lage(e);
      // Rad und zwei Finger senkrecht zoomen wie in Obsidian, Spreizen kommt als ctrl+Rad,
      // zwei Finger waagrecht verschieben.
      if (!e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        kamera.x -= e.deltaX;
      } else {
        const vorher = zuWelt(q.x, q.y);
        const faktor = e.ctrlKey ? 0.012 : 0.0015;
        kamera.s = Math.min(5, Math.max(0.12, kamera.s * Math.exp(-e.deltaY * faktor)));
        const nachher = zuBild(vorher.x, vorher.y);
        kamera.x += q.x - nachher.x;
        kamera.y += q.y - nachher.y;
      }
      handBewegt = true;
      flug = null;
      zeichne();
    },
    { passive: false },
  );
  leinwand.addEventListener("dblclick", (e) => {
    if (lokal) return;
    const q = lage(e);
    const i = modus === "erkunden" ? null : treffer(q.x, q.y);
    if (i === null) {
      if (modus === "erkunden") return;
      handBewegt = false;
      zentriere();
    } else if (!geist[i]) fokus(i);
  });
  leinwand.addEventListener("contextmenu", (e) => {
    const q = lage(e);
    const i = treffer(q.x, q.y);
    if (i === null || lokal || geist[i]) return;
    e.preventDefault();
    setzeAuswahl(i);
    opt.onKontext?.(netz.knoten[i].id, e.clientX, e.clientY);
  });
  leinwand.tabIndex = 0;
  leinwand.addEventListener("keydown", (e) => {
    if (lokal) return;
    if (e.key === "Escape") {
      if (modus === "erkunden") erkunde(null);
      else if (modus === "fokus") fokus(null);
      else if (modus === "zeitreise") api.zeitreise(false);
      else if (gewaehlt !== null) setzeAuswahl(null);
      else return;
      e.preventDefault();
      e.stopPropagation();
    } else if (modus === "erkunden" && e.key === "Backspace") {
      e.preventDefault();
      api.zurueck();
    } else if (modus === "erkunden" && e.key === "Enter" && erkundenBei !== null) {
      opt.onOeffne(netz.knoten[erkundenBei].id);
    } else if (modus === "fokus" && /^[1-4]$/.test(e.key) && fokusWurzel !== null) {
      fokus(fokusWurzel, Number(e.key));
    } else if (gewaehlt !== null && e.key === "Enter" && !geist[gewaehlt]) {
      opt.onOeffne(netz.knoten[gewaehlt].id);
    }
  });

  const groesse = new ResizeObserver(() => {
    const r = host.getBoundingClientRect();
    const erstes = breite === 0;
    breite = Math.max(1, r.width);
    hoehe = Math.max(1, r.height);
    dpr = globalThis.devicePixelRatio || 1;
    leinwand.width = Math.round(breite * dpr);
    leinwand.height = Math.round(hoehe * dpr);
    leinwand.style.width = `${breite}px`;
    leinwand.style.height = `${hoehe}px`;
    if (erstes) zentriere(false);
    else zeichne();
  });
  groesse.observe(host);
  if (lokal && aktiv) {
    const i = index.get(aktiv);
    fokusAbstand = i === undefined ? [] : abstaende(i, netz.nachbarn, 4);
  }
  wecke(netz.waerme);

  const api: GraphApi = {
    setzeAktiv(pfad) {
      aktiv = pfad;
      zeichne();
    },
    zentriere: () => {
      handBewegt = false;
      zentriere();
    },
    setze(neu) {
      const alt = d;
      d = mischeDarstellung(d, neu);
      if (neu.ebenen?.kaputt !== undefined && neu.ebenen.kaputt !== alt.ebenen.kaputt) baue();
      if (neu.kraefte) {
        netz.kraefte = { ...d.kraefte };
        wecke(0.5);
      }
      if (neu.filter !== undefined || neu.gruppen) baueFilterNeu();
      if (neu.stil || neu.farbeNach || neu.gruppen) baueFarben();
      if (neu.nurTreffer !== undefined || (neu.filter !== undefined && d.nurTreffer)) zentriere();
      wecke(0);
    },
    darstellung: () => mischeDarstellung(d),
    kennzahlen() {
      const echte = netz.knoten.map((_, i) => i).filter((i) => !geist[i]);
      const titel = new Map(quelle.map((q) => [q.pfad, q.titel]));
      const tage = new Map<number, number>();
      for (const i of echte) {
        const e = quelle[i].erstellt ?? 0;
        if (e <= 0) continue;
        const tag = Math.floor(e / TAG_MS) * TAG_MS;
        tage.set(tag, (tage.get(tag) ?? 0) + 1);
      }
      const nachRang = wichtig().filter((i) => !geist[i]);
      const jetzt = Date.now();
      const oberesViertel = nachRang.slice(0, Math.max(3, Math.ceil(echte.length / 4)));
      return {
        notizen: echte.length,
        links: gerichtet.filter(([a, b]) => !geist[a] && !geist[b]).length,
        waisen: echte.filter((i) => netz.knoten[i].grad === 0).map((i) => quelle[i].pfad),
        sackgassen: echte
          .filter((i) => aus[i] === 0 && netz.knoten[i].grad > 0)
          .map((i) => quelle[i].pfad),
        kaputt: [...(daten.offen ?? [])],
        gemeinschaften: gemeinschaften
          .filter((g) => g.glieder.length >= 2)
          .map((g) => ({
            name: g.name,
            farbe: clusterFarbe[g.nummer],
            anzahl: g.glieder.length,
            mitte: quelle[g.mitte]?.pfad ?? "",
          })),
        top: nachRang.slice(0, 8).map((i) => quelle[i].pfad),
        kalt: oberesViertel
          .filter((i) => (quelle[i].geaendert ?? jetzt) < jetzt - 14 * TAG_MS)
          .slice(0, 8)
          .map((i) => quelle[i].pfad),
        treffer: filter.leer ? echte.length : echte.filter((i) => filter.passt(i)).length,
        titel,
        tage: [...tage.entries()].sort((a, b) => a[0] - b[0]).map(([tag, neu]) => ({ tag, neu })),
        legende: legende.map((l) => ({ ...l })),
      };
    },
    waehle(pfad, fliegen = true) {
      const i = pfad === null ? null : (index.get(pfad) ?? null);
      if (modus === "erkunden" && i !== null) {
        erkunde(i);
        return;
      }
      setzeAuswahl(i, fliegen);
    },
    fokus(pfad, tiefe) {
      fokus(pfad === null ? null : (index.get(pfad) ?? null), tiefe);
    },
    erkunde(pfad) {
      if (pfad === null) {
        erkunde(null);
        return;
      }
      const i = index.get(pfad);
      if (i === undefined) return;
      erkundenWeg = [];
      erkunde(i, false);
    },
    zurueck() {
      const vorher = erkundenWeg.pop();
      if (vorher !== undefined) erkunde(vorher, false);
    },
    zeitreise(an) {
      if (!an) {
        setzeModus("uebersicht");
        opt.onZeit?.(Number.POSITIVE_INFINITY, zeitSpanne, false);
        wecke(0);
        return;
      }
      const tage = new Set<number>();
      quelle.forEach((q, i) => {
        if (!geist[i] && (q.erstellt ?? 0) > 0)
          tage.add(Math.floor((q.erstellt ?? 0) / TAG_MS) * TAG_MS);
      });
      if (tage.size === 0) return;
      zeitTage = [...tage].sort((a, b) => a - b);
      zeitSpanne = [zeitTage[0], zeitTage[zeitTage.length - 1] + TAG_MS - 1];
      setzeModus("zeitreise");
      zeit = zeitTage[0] - 1;
      handBewegt = false;
      // Gerahmt wird das ganze Brain: es wächst in einen festen Ausschnitt hinein.
      flieg(rahmenFuer(netz.knoten.map((_, i) => i).filter((i) => !geist[i])));
      api.spiele(true);
    },
    zeitpunkt(t) {
      if (modus !== "zeitreise") return;
      spielt = false;
      if (t < zeit) {
        zeit = t;
        opt.onZeit?.(zeit, zeitSpanne, false);
      } else setzeZeit(t);
      wecke(0);
    },
    spiele(an = !spielt) {
      if (modus !== "zeitreise") return;
      spielt = an;
      if (an) {
        let idx = zeitTage.filter((t) => t + TAG_MS - 1 <= zeit).length - 1;
        if (idx >= zeitTage.length - 1) {
          zeit = zeitTage[0] - 1;
          idx = -1;
        }
        spielVonIdx = idx + 1;
        spielStart = performance.now();
      }
      opt.onZeit?.(zeit, zeitSpanne, spielt);
      wecke(0);
    },
    spurAbspielen() {
      spurReplay = performance.now();
      wecke(0);
    },
    anheften(pfad, an) {
      const i = index.get(pfad);
      if (i === undefined || geist[i]) return;
      const k = netz.knoten[i];
      const neu = an ?? !k.angeheftet;
      k.angeheftet = neu;
      if (neu) pins[pfad] = { x: k.x, y: k.y };
      else delete pins[pfad];
      opt.onPins?.({ ...pins });
      if (gewaehlt === i) opt.onAuswahl?.(info(i));
      wecke(0.2);
    },
    modus: () => modus,
    bild() {
      return new Promise((fertig) => {
        // Mit Grund, sonst ist das Bild durchsichtig und auf weißem Hintergrund unlesbar.
        const c = document.createElement("canvas");
        c.width = leinwand.width;
        c.height = leinwand.height;
        const g = c.getContext("2d") as CanvasRenderingContext2D;
        g.fillStyle = f.grund;
        g.fillRect(0, 0, c.width, c.height);
        g.drawImage(leinwand, 0, 0);
        c.toBlob((b) => fertig(b), "image/png");
      });
    },
    loesen() {
      lebt = false;
      groesse.disconnect();
      huellenBeobachter.disconnect();
      leinwand.remove();
    },
  };
  return api;
}
