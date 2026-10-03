/**
 * Was der Graph des Brain über sich selbst weiß — ohne DOM, damit es sich prüfen lässt:
 * PageRank, Gemeinschaften (Louvain) mit Namen, Waisen und Sackgassen, die Abstände für den
 * Fokus und die Filtersprache. Vorbild sind Obsidians Graph-Plugins (Graph Insight, Graph Styler).
 */

export interface MassKnoten {
  pfad: string;
  titel: string;
  ordner: string;
  tags: string[];
  farbe: string | null;
  erstellt: number;
  geaendert: number;
}

/** PageRank über die gerichteten Links. Ohne Ausgang verteilt eine Notiz ihr Gewicht auf alle. */
export function pageRank(
  n: number,
  gerichtet: ReadonlyArray<readonly [number, number]>,
  daempfung = 0.85,
  runden = 50,
): number[] {
  if (n === 0) return [];
  const aus = Array.from({ length: n }, () => [] as number[]);
  for (const [a, b] of gerichtet) if (a !== b) aus[a].push(b);
  let rang = new Array<number>(n).fill(1 / n);
  for (let r = 0; r < runden; r++) {
    const neu = new Array<number>(n).fill((1 - daempfung) / n);
    let lose = 0;
    for (let i = 0; i < n; i++) {
      if (aus[i].length === 0) {
        lose += rang[i];
        continue;
      }
      const teil = (daempfung * rang[i]) / aus[i].length;
      for (const j of aus[i]) neu[j] += teil;
    }
    const jeder = (daempfung * lose) / n;
    for (let i = 0; i < n; i++) neu[i] += jeder;
    rang = neu;
  }
  return rang;
}

/**
 * Gemeinschaften nach Louvain: Notizen wandern in die Nachbargruppe, die die Modularität am
 * meisten hebt; dann werden die Gruppen zu Knoten zusammengefasst und es beginnt von vorn.
 * Feste Reihenfolge, also dieselben Gruppen bei jedem Öffnen. Gibt je Notiz eine Gruppennummer,
 * nach Größe geordnet (0 = die größte).
 */
export function louvain(n: number, kanten: ReadonlyArray<{ a: number; b: number }>): number[] {
  if (n === 0) return [];
  let zu = Array.from({ length: n }, (_, i) => i);
  let nachbar: Array<Map<number, number>> = Array.from({ length: n }, () => new Map());
  let selbst = new Array<number>(n).fill(0);
  for (const { a, b } of kanten) {
    if (a === b) continue;
    nachbar[a].set(b, (nachbar[a].get(b) ?? 0) + 1);
    nachbar[b].set(a, (nachbar[b].get(a) ?? 0) + 1);
  }
  for (let ebene = 0; ebene < 12; ebene++) {
    const m = nachbar.length;
    const grad = nachbar.map((nb, i) => {
      let s = 2 * selbst[i];
      for (const w of nb.values()) s += w;
      return s;
    });
    const m2 = grad.reduce((s, g) => s + g, 0);
    if (m2 === 0) break;
    const gruppe = Array.from({ length: m }, (_, i) => i);
    const summe = [...grad];
    let verbessert = false;
    for (let durchgang = 0; durchgang < 20; durchgang++) {
      let bewegt = false;
      for (let i = 0; i < m; i++) {
        const alt = gruppe[i];
        const zuGruppe = new Map<number, number>();
        for (const [j, w] of nachbar[i]) {
          const g = gruppe[j];
          zuGruppe.set(g, (zuGruppe.get(g) ?? 0) + w);
        }
        summe[alt] -= grad[i];
        let beste = alt;
        let gewinn = (zuGruppe.get(alt) ?? 0) - (summe[alt] * grad[i]) / m2;
        for (const [g, w] of zuGruppe) {
          const z = w - (summe[g] * grad[i]) / m2;
          if (z > gewinn + 1e-12) {
            gewinn = z;
            beste = g;
          }
        }
        summe[beste] += grad[i];
        if (beste !== alt) {
          gruppe[i] = beste;
          bewegt = true;
          verbessert = true;
        }
      }
      if (!bewegt) break;
    }
    if (!verbessert) break;
    const neuNummer = new Map<number, number>();
    for (const g of gruppe) if (!neuNummer.has(g)) neuNummer.set(g, neuNummer.size);
    const k = neuNummer.size;
    const neuNachbar: Array<Map<number, number>> = Array.from({ length: k }, () => new Map());
    const neuSelbst = new Array<number>(k).fill(0);
    for (let i = 0; i < m; i++) {
      const gi = neuNummer.get(gruppe[i]) as number;
      neuSelbst[gi] += selbst[i];
      for (const [j, w] of nachbar[i]) {
        if (j < i) continue;
        const gj = neuNummer.get(gruppe[j]) as number;
        if (gi === gj) neuSelbst[gi] += w;
        else {
          neuNachbar[gi].set(gj, (neuNachbar[gi].get(gj) ?? 0) + w);
          neuNachbar[gj].set(gi, (neuNachbar[gj].get(gi) ?? 0) + w);
        }
      }
    }
    zu = zu.map((g) => neuNummer.get(gruppe[g]) as number);
    nachbar = neuNachbar;
    selbst = neuSelbst;
    if (k === m) break;
  }
  // Nach Größe nummerieren: die größte Gruppe bekommt die erste Farbe.
  const groesse = new Map<number, number>();
  for (const g of zu) groesse.set(g, (groesse.get(g) ?? 0) + 1);
  const reihe = [...groesse.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0]).map(([g]) => g);
  const rang = new Map(reihe.map((g, i) => [g, i]));
  return zu.map((g) => rang.get(g) as number);
}

const FUELLWOERTER = new Set(
  (
    "der die das den dem des ein eine einer eines einem und oder aber nicht mit von vom zum zur " +
    "für fuer auf aus bei bis nach über ueber unter vor im in am an als auch ist sind war wie was " +
    "wer noch nur sich ich sie wir ihr mein dein sein the a an of to for and or in on at by with " +
    "how why what is are was it its my your you this that from into vs der-die neue neuer neues"
  ).split(" "),
);

/** Die Wörter eines Titels, die etwas sagen. */
export function woerter(titel: string): string[] {
  return (titel.toLowerCase().match(/[\p{L}][\p{L}\p{N}+-]{2,}/gu) ?? []).filter(
    (w) => !FUELLWOERTER.has(w) && !/^\d/.test(w),
  );
}

export interface Gemeinschaft {
  nummer: number;
  name: string;
  /** Die Notiz mit dem höchsten Rang in der Gruppe. */
  mitte: number;
  glieder: number[];
}

/**
 * Namen für die Gruppen. `gewicht` sagt, welche Notiz die Mitte ist (bei Kuro OS: die meisten
 * Links innerhalb der Gruppe). Ist die Mitte ein Verzeichnis (Stufe ≤ 2),
 * heißt die Gruppe wie sie; sonst nach den Wörtern, die in ihren Titeln häufig und anderswo
 * selten sind (TF-IDF), wie bei Graph Insight.
 */
export function benenne(
  gruppe: readonly number[],
  titel: readonly string[],
  gewicht: readonly number[],
  stufe: readonly number[],
): Gemeinschaft[] {
  const nummern = [...new Set(gruppe)].sort((a, b) => a - b);
  const glieder = new Map<number, number[]>(nummern.map((g) => [g, []]));
  gruppe.forEach((g, i) => glieder.get(g)?.push(i));
  const inGruppen = new Map<string, number>();
  const zaehlung = new Map<number, Map<string, number>>();
  for (const g of nummern) {
    const z = new Map<string, number>();
    for (const i of glieder.get(g) ?? []) {
      for (const w of new Set(woerter(titel[i]))) z.set(w, (z.get(w) ?? 0) + 1);
    }
    for (const w of z.keys()) inGruppen.set(w, (inGruppen.get(w) ?? 0) + 1);
    zaehlung.set(g, z);
  }
  return nummern.map((g) => {
    const liste = glieder.get(g) ?? [];
    const mitte = liste.reduce((b, i) => (gewicht[i] > gewicht[b] ? i : b), liste[0] as number);
    let name: string;
    if ((stufe[mitte] ?? 3) <= 2 || liste.length < 3) {
      name = titel[mitte];
    } else {
      const z = zaehlung.get(g) ?? new Map<string, number>();
      const bewertet = [...z.entries()]
        .filter(([, f]) => f >= 2)
        .map(([w, f]) => [w, f * Math.log(1 + nummern.length / (inGruppen.get(w) ?? 1))] as const)
        .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
      name =
        bewertet.length > 0
          ? bewertet
              .slice(0, 2)
              .map(([w]) => w.charAt(0).toUpperCase() + w.slice(1))
              .join(" · ")
          : titel[mitte];
    }
    return {
      nummer: g,
      name: name.length > 28 ? `${name.slice(0, 27)}…` : name,
      mitte,
      glieder: liste,
    };
  });
}

/** Abstand in Links von `start` (ungerichtet), bis `tiefe`; nicht erreicht = Infinity. */
export function abstaende(
  start: number,
  nachbarn: ReadonlyArray<ReadonlySet<number>>,
  tiefe = Number.POSITIVE_INFINITY,
): number[] {
  const d = new Array<number>(nachbarn.length).fill(Number.POSITIVE_INFINITY);
  if (start < 0 || start >= nachbarn.length) return d;
  d[start] = 0;
  let rand = [start];
  for (let t = 1; t <= tiefe && rand.length > 0; t++) {
    const neu: number[] = [];
    for (const i of rand) {
      for (const j of nachbarn[i]) {
        if (d[j] !== Number.POSITIVE_INFINITY) continue;
        d[j] = t;
        neu.push(j);
      }
    }
    rand = neu;
  }
  return d;
}

// ------------------------------------------------------------------------- Filtersprache

export interface FilterKontext {
  knoten: readonly MassKnoten[];
  /** Links je Notiz, beide Richtungen. */
  grad: readonly number[];
  ein: readonly number[];
  aus: readonly number[];
  clusterName: (i: number) => string;
  angeheftet: (i: number) => boolean;
  jetzt: number;
}

export interface Filter {
  passt(i: number): boolean;
  /** Ob überhaupt etwas eingeschränkt wird. */
  leer: boolean;
  fehler: string | null;
}

function teile(text: string): string[] {
  return [...text.matchAll(/-?[\p{L}\p{N}_]+:"[^"]*"|-?"[^"]*"|\S+/gu)].map((m) => m[0]);
}

const TAG_MS = 86_400_000;

function vergleich(roh: string, wert: number): boolean | null {
  const m = /^(<=|>=|<|>|=)?\s*(-?\d+(?:[.,]\d+)?)$/.exec(roh);
  if (!m) return null;
  const zahl = Number(m[2].replace(",", "."));
  switch (m[1] ?? "=") {
    case "<":
      return wert < zahl;
    case "<=":
      return wert <= zahl;
    case ">":
      return wert > zahl;
    case ">=":
      return wert >= zahl;
    default:
      return wert === zahl;
  }
}

/** `<7d` = in den letzten 7 Tagen, `>30d` = älter als 30 Tage, `>2026-09-20` = nach dem Tag. */
function zeitVergleich(roh: string, zeit: number, jetzt: number): boolean | null {
  const spanne = /^(<|>)\s*(\d+)\s*(d|t|w|m)$/i.exec(roh);
  if (spanne) {
    const faktor = { d: 1, t: 1, w: 7, m: 30 }[spanne[3].toLowerCase() as "d"] ?? 1;
    const alter = (jetzt - zeit) / TAG_MS;
    const grenze = Number(spanne[2]) * faktor;
    return spanne[1] === "<" ? alter < grenze : alter > grenze;
  }
  const tag = /^(<|>|=)?\s*(\d{4})-(\d{2})-(\d{2})$/.exec(roh);
  if (tag) {
    const t = Date.UTC(Number(tag[2]), Number(tag[3]) - 1, Number(tag[4]));
    if (tag[1] === "<") return zeit < t;
    if (tag[1] === ">") return zeit >= t + TAG_MS;
    return zeit >= t && zeit < t + TAG_MS;
  }
  return null;
}

/**
 * Die Filtersprache der Graph-Ansicht, wie Obsidians Suche mit den Zusätzen von Graph Insight:
 * freie Wörter (Titel und Pfad), `ordner:`, `pfad:`, `tag:`, `links:>5`, `ein:`, `aus:`,
 * `geaendert:<7d`, `erstellt:>2026-09-20`, `cluster:"Name"`, `ist:waise|sackgasse|angeheftet`,
 * ein `-` davor kehrt um. Alle Teile müssen passen.
 */
export function baueFilter(text: string, ctx: FilterKontext): Filter {
  const stuecke = teile(text.trim());
  if (stuecke.length === 0) return { passt: () => true, leer: true, fehler: null };
  const pruefer: Array<(i: number) => boolean> = [];
  let fehler: string | null = null;
  const klein = (s: string) => s.toLowerCase().replace(/^"|"$/g, "");
  for (const roh of stuecke) {
    const nicht = roh.startsWith("-") && roh.length > 1;
    const stueck = nicht ? roh.slice(1) : roh;
    const m = /^([\p{L}]+):(.*)$/u.exec(stueck);
    let p: ((i: number) => boolean) | null = null;
    let bekannt = false;
    if (m) {
      bekannt = true;
      const schluessel = m[1].toLowerCase();
      const wert = klein(m[2]);
      switch (schluessel) {
        case "ordner":
        case "pfad":
        case "path":
        case "folder":
          p = (i) => ctx.knoten[i].pfad.toLowerCase().includes(wert);
          break;
        case "tag":
          p = (i) => ctx.knoten[i].tags.some((t) => t === wert || t.startsWith(`${wert}/`));
          break;
        case "links":
        case "ein":
        case "in":
        case "aus":
        case "out": {
          const quelle =
            schluessel === "links"
              ? ctx.grad
              : schluessel === "ein" || schluessel === "in"
                ? ctx.ein
                : ctx.aus;
          if (vergleich(wert, 0) === null) fehler = `„${roh}“ braucht eine Zahl, z. B. links:>3`;
          else p = (i) => vergleich(wert, quelle[i]) === true;
          break;
        }
        case "geaendert":
        case "geändert":
        case "edited":
        case "erstellt":
        case "created": {
          const feld =
            schluessel.startsWith("e") && schluessel !== "edited" ? "erstellt" : "geaendert";
          if (zeitVergleich(wert, 0, ctx.jetzt) === null)
            fehler = `„${roh}“ versteht <7d, >30d oder >2026-09-20`;
          else p = (i) => zeitVergleich(wert, ctx.knoten[i][feld], ctx.jetzt) === true;
          break;
        }
        case "cluster":
        case "gruppe":
          p = (i) => ctx.clusterName(i).toLowerCase().includes(wert);
          break;
        case "ist":
        case "is":
          if (wert === "waise" || wert === "orphan") p = (i) => ctx.grad[i] === 0;
          else if (wert === "sackgasse" || wert === "deadend") p = (i) => ctx.aus[i] === 0;
          else if (wert === "angeheftet" || wert === "pinned") p = (i) => ctx.angeheftet(i);
          else fehler = `„${roh}“: ist:waise, ist:sackgasse oder ist:angeheftet`;
          break;
        default:
          bekannt = false;
      }
    }
    if (!bekannt) {
      const wort = klein(stueck);
      p = (i) =>
        ctx.knoten[i].titel.toLowerCase().includes(wort) ||
        ctx.knoten[i].pfad.toLowerCase().includes(wort);
    }
    if (p) pruefer.push(nicht ? (i) => !(p as (i: number) => boolean)(i) : p);
  }
  return { passt: (i) => pruefer.every((p) => p(i)), leer: pruefer.length === 0, fehler };
}

// ------------------------------------------------------------------------------- Farben

/** Eine Farbe aus Notiz oder Regel: Name (rot, grün …), #rgb, #rrggbb. */
const FARBNAMEN: Record<string, string> = {
  rot: "#f07a7a",
  red: "#f07a7a",
  orange: "#ffb35c",
  gelb: "#f2d36b",
  yellow: "#f2d36b",
  gruen: "#7fd3a8",
  grün: "#7fd3a8",
  green: "#7fd3a8",
  tuerkis: "#56d2c2",
  türkis: "#56d2c2",
  teal: "#56d2c2",
  blau: "#6d90ff",
  blue: "#6d90ff",
  lila: "#a88bff",
  violett: "#a88bff",
  purple: "#a88bff",
  rosa: "#f59ac8",
  pink: "#f59ac8",
  grau: "#9a948a",
  gray: "#9a948a",
  grey: "#9a948a",
  weiss: "#ece7de",
  weiß: "#ece7de",
  white: "#ece7de",
};

export function leseFarbe(roh: string | null | undefined): string | null {
  if (!roh) return null;
  const t = roh.trim().toLowerCase();
  if (FARBNAMEN[t]) return FARBNAMEN[t];
  if (/^#[0-9a-f]{3}$/.test(t)) return `#${t[1]}${t[1]}${t[2]}${t[2]}${t[3]}${t[3]}`;
  if (/^#[0-9a-f]{6}$/.test(t)) return t;
  return null;
}

/** Zwei Farben mischen, `t` von 0 (a) bis 1 (b). */
export function mische(a: string, b: string, t: number): string {
  const x = Number.parseInt(a.slice(1), 16);
  const y = Number.parseInt(b.slice(1), 16);
  const k = Math.max(0, Math.min(1, t));
  const kanal = (s: number) =>
    Math.round(((x >> s) & 255) + (((y >> s) & 255) - ((x >> s) & 255)) * k);
  return `#${((1 << 24) | (kanal(16) << 16) | (kanal(8) << 8) | kanal(0)).toString(16).slice(1)}`;
}

/** Die konvexe Hülle einer Punktmenge (Andrew), gegen den Uhrzeigersinn, ohne Doppelte. */
export function huelle(
  punkte: ReadonlyArray<{ x: number; y: number }>,
): Array<{ x: number; y: number }> {
  const p = [...punkte].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const kreuz = (
    o: { x: number; y: number },
    a: { x: number; y: number },
    b: { x: number; y: number },
  ) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const unten: Array<{ x: number; y: number }> = [];
  for (const q of p) {
    while (unten.length >= 2 && kreuz(unten[unten.length - 2], unten[unten.length - 1], q) <= 0)
      unten.pop();
    unten.push(q);
  }
  const oben: Array<{ x: number; y: number }> = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (oben.length >= 2 && kreuz(oben[oben.length - 2], oben[oben.length - 1], q) <= 0)
      oben.pop();
    oben.push(q);
  }
  return [...unten.slice(0, -1), ...oben.slice(0, -1)];
}
