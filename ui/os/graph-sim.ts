/**
 * Die Kräfte hinter dem Graphen des Brain — wie Obsidians Graph-Ansicht: Notizen stoßen sich ab,
 * Links ziehen wie Federn, alles sinkt sanft zur Mitte. Ohne DOM, damit es sich prüfen lässt.
 * Bei ein paar hundert Notizen reicht die einfache Rechnung über alle Paare.
 */

export interface Knoten {
  id: string;
  titel: string;
  gruppe: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  grad: number;
  /** Abstand zu START in Links: 0 START, 1 Bereich, 2 Verzeichnis, 3 Notiz (auch unerreichbar). */
  stufe: number;
  /** Festgehalten, solange Jakob ihn zieht. */
  fest: boolean;
  /** Angeheftet: bleibt, wo Jakob ihn abgelegt hat, auch über Neustarts. */
  angeheftet: boolean;
  /** Nummer der Gemeinschaft (Louvain), für den Zusammenhalt der Cluster. */
  gemeinschaft: number;
}

/** Die Regler der Kräfte, wie in Obsidians Graph-Einstellungen. */
export interface Kraefte {
  abstossung: number;
  feder: number;
  laenge: number;
  mitte: number;
  /** Zug zur Mitte der eigenen Gemeinschaft — hält Cluster zusammen. 0 = aus. */
  cluster: number;
}

export interface Kante {
  a: number;
  b: number;
}

export interface Netz {
  knoten: Knoten[];
  kanten: Kante[];
  nachbarn: Set<number>[];
  waerme: number;
  kraefte: Kraefte;
}

export const KRAEFTE: Kraefte = {
  abstossung: 2600,
  feder: 0.035,
  laenge: 70,
  mitte: 0.012,
  cluster: 0,
};
const DAEMPFUNG = 0.82;

/** Ein fester Startort je Notiz — derselbe Graph sieht beim nächsten Öffnen gleich aus. */
function startOrt(id: string, i: number, n: number): { x: number; y: number } {
  let h = 2166136261;
  for (let k = 0; k < id.length; k++) h = Math.imul(h ^ id.charCodeAt(k), 16777619);
  const winkel = (((h >>> 0) % 3600) / 3600) * Math.PI * 2;
  const r = 40 + Math.sqrt((i + 1) / n) * 260;
  return { x: Math.cos(winkel) * r, y: Math.sin(winkel) * r };
}

export function baueNetz(
  knoten: ReadonlyArray<{ pfad: string; titel: string; ordner: string }>,
  kanten: ReadonlyArray<readonly [string, string]>,
): Netz {
  const index = new Map(knoten.map((k, i) => [k.pfad, i]));
  const nachbarn = knoten.map(() => new Set<number>());
  const liste: Kante[] = [];
  const gesehen = new Set<string>();
  for (const [von, nach] of kanten) {
    const a = index.get(von);
    const b = index.get(nach);
    if (a === undefined || b === undefined || a === b) continue;
    const schluessel = a < b ? `${a}-${b}` : `${b}-${a}`;
    nachbarn[a].add(b);
    nachbarn[b].add(a);
    if (gesehen.has(schluessel)) continue;
    gesehen.add(schluessel);
    liste.push({ a, b });
  }
  const stufe = knoten.map(() => 3);
  const wurzel = index.get("START.md");
  if (wurzel !== undefined) {
    stufe[wurzel] = 0;
    const schlange = [wurzel];
    while (schlange.length > 0) {
      const i = schlange.shift() as number;
      if (stufe[i] >= 2) continue;
      for (const j of nachbarn[i]) {
        if (j === wurzel || stufe[j] <= stufe[i] + 1) continue;
        stufe[j] = stufe[i] + 1;
        schlange.push(j);
      }
    }
  }
  return {
    knoten: knoten.map((k, i) => ({
      id: k.pfad,
      titel: k.titel,
      gruppe: k.ordner,
      ...startOrt(k.pfad, i, knoten.length),
      vx: 0,
      vy: 0,
      grad: nachbarn[i].size,
      stufe: stufe[i],
      fest: false,
      angeheftet: false,
      gemeinschaft: 0,
    })),
    kanten: liste,
    nachbarn,
    waerme: 1,
    kraefte: { ...KRAEFTE },
  };
}

/** Ein Schritt der Simulation. Gibt zurück, ob sich noch etwas bewegt. */
export function schritt(netz: Netz): boolean {
  const { knoten, kanten, kraefte: kr } = netz;
  const n = knoten.length;
  const w = netz.waerme;
  for (let i = 0; i < n; i++) {
    const a = knoten[i];
    for (let j = i + 1; j < n; j++) {
      const b = knoten[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 0.01) {
        dx = (i - j) * 0.1;
        dy = 0.1;
        d2 = dx * dx + dy * dy;
      }
      if (d2 > 250_000) continue;
      const f = (kr.abstossung * w) / d2;
      const d = Math.sqrt(d2);
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }
  }
  for (const { a: ia, b: ib } of kanten) {
    const a = knoten[ia];
    const b = knoten[ib];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const f = (d - kr.laenge) * kr.feder * w;
    const fx = (dx / d) * f;
    const fy = (dy / d) * f;
    a.vx += fx;
    a.vy += fy;
    b.vx -= fx;
    b.vy -= fy;
  }
  if (kr.cluster > 0) {
    const mitten = new Map<number, { x: number; y: number; n: number }>();
    for (const k of knoten) {
      const m = mitten.get(k.gemeinschaft) ?? { x: 0, y: 0, n: 0 };
      m.x += k.x;
      m.y += k.y;
      m.n += 1;
      mitten.set(k.gemeinschaft, m);
    }
    for (const k of knoten) {
      const m = mitten.get(k.gemeinschaft);
      if (!m || m.n < 2) continue;
      k.vx += (m.x / m.n - k.x) * kr.cluster * w;
      k.vy += (m.y / m.n - k.y) * kr.cluster * w;
    }
  }
  let bewegung = 0;
  for (const k of knoten) {
    k.vx -= k.x * kr.mitte * w;
    k.vy -= k.y * kr.mitte * w;
    k.vx *= DAEMPFUNG;
    k.vy *= DAEMPFUNG;
    if (k.fest || k.angeheftet) {
      k.vx = 0;
      k.vy = 0;
      continue;
    }
    k.x += k.vx;
    k.y += k.vy;
    bewegung += Math.abs(k.vx) + Math.abs(k.vy);
  }
  netz.waerme = Math.max(0.02, w * 0.985);
  return bewegung / Math.max(1, n) > 0.02;
}

/** Nur die Notiz und ihre Nachbarn bis `tiefe` — Obsidians „lokaler Graph". */
export function umgebung(
  knoten: ReadonlyArray<{ pfad: string; titel: string; ordner: string }>,
  kanten: ReadonlyArray<readonly [string, string]>,
  mitte: string,
  tiefe = 1,
): {
  knoten: Array<{ pfad: string; titel: string; ordner: string }>;
  kanten: Array<[string, string]>;
} {
  const drin = new Set([mitte]);
  let rand = new Set([mitte]);
  for (let t = 0; t < tiefe; t++) {
    const neu = new Set<string>();
    for (const [a, b] of kanten) {
      if (rand.has(a) && !drin.has(b)) neu.add(b);
      if (rand.has(b) && !drin.has(a)) neu.add(a);
    }
    for (const x of neu) drin.add(x);
    rand = neu;
  }
  return {
    knoten: knoten.filter((k) => drin.has(k.pfad)),
    kanten: kanten.filter(([a, b]) => drin.has(a) && drin.has(b)).map(([a, b]) => [a, b]),
  };
}
