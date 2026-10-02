/**
 * Die Regeln des Fenstermanagers von Kuro OS, ohne DOM: wohin ein Fenster andockt, wie es auf
 * dem Schirm bleibt, wo ein neues aufgeht und wie mehrere nebeneinander passen.
 */

export interface Rechteck {
  x: number;
  y: number;
  b: number;
  h: number;
}

export type Andock = "links" | "rechts" | "voll" | null;

export const MIN_B = 380;
export const MIN_H = 260;
const RAND = 8;

/** Zieht Jakob ein Fenster an den linken, rechten oder oberen Rand, dockt es dort an. */
export function andockZone(px: number, py: number, f: Rechteck): Andock {
  if (py <= f.y + 2) return "voll";
  if (px <= f.x + RAND) return "links";
  if (px >= f.x + f.b - RAND) return "rechts";
  return null;
}

export function andockRechteck(zone: Exclude<Andock, null>, f: Rechteck): Rechteck {
  const luft = 6;
  if (zone === "voll")
    return { x: f.x + luft, y: f.y + luft, b: f.b - 2 * luft, h: f.h - 2 * luft };
  const halb = Math.round((f.b - 3 * luft) / 2);
  return {
    x: zone === "links" ? f.x + luft : f.x + 2 * luft + halb,
    y: f.y + luft,
    b: halb,
    h: f.h - 2 * luft,
  };
}

/** Größe in die Fläche zwingen, und die Titelleiste bleibt immer greifbar. */
export function begrenze(r: Rechteck, f: Rechteck): Rechteck {
  const b = Math.min(Math.max(r.b, MIN_B), f.b);
  const h = Math.min(Math.max(r.h, MIN_H), f.h);
  const x = Math.min(Math.max(r.x, f.x - b + 140), f.x + f.b - 140);
  const y = Math.min(Math.max(r.y, f.y), f.y + f.h - 44);
  return { x: Math.round(x), y: Math.round(y), b: Math.round(b), h: Math.round(h) };
}

/** Wo das n-te neue Fenster aufgeht: mittig, jedes weitere etwas versetzt. */
export function staffel(n: number, groesse: { b: number; h: number }, f: Rechteck): Rechteck {
  const b = Math.min(groesse.b, f.b - 40);
  const h = Math.min(groesse.h, f.h - 40);
  const versatz = (n % 6) * 28;
  return begrenze(
    {
      x: f.x + (f.b - b) / 2 - 70 + versatz,
      y: f.y + (f.h - h) / 2 - 40 + versatz,
      b,
      h,
    },
    f,
  );
}

/** Mehrere Fenster nebeneinander: eins füllt, zwei teilen, drei: eins links, zwei rechts, sonst Raster. */
export function nebeneinander(anzahl: number, f: Rechteck): Rechteck[] {
  if (anzahl <= 0) return [];
  const luft = 6;
  const innen = { x: f.x + luft, y: f.y + luft, b: f.b - 2 * luft, h: f.h - 2 * luft };
  if (anzahl === 1) return [innen];
  if (anzahl === 3) {
    const halb = (innen.b - luft) / 2;
    const hoch = (innen.h - luft) / 2;
    return [
      { x: innen.x, y: innen.y, b: halb, h: innen.h },
      { x: innen.x + halb + luft, y: innen.y, b: halb, h: hoch },
      { x: innen.x + halb + luft, y: innen.y + hoch + luft, b: halb, h: hoch },
    ].map(runde);
  }
  const spalten = Math.ceil(Math.sqrt(anzahl));
  const zeilen = Math.ceil(anzahl / spalten);
  const b = (innen.b - (spalten - 1) * luft) / spalten;
  const h = (innen.h - (zeilen - 1) * luft) / zeilen;
  return Array.from({ length: anzahl }, (_, i) =>
    runde({
      x: innen.x + (i % spalten) * (b + luft),
      y: innen.y + Math.floor(i / spalten) * (h + luft),
      b,
      h,
    }),
  );
}

function runde(r: Rechteck): Rechteck {
  return { x: Math.round(r.x), y: Math.round(r.y), b: Math.round(r.b), h: Math.round(r.h) };
}

/** Eine Größenänderung an einem Rand oder einer Ecke (`n`, `se`, …). */
export function zieheRand(
  start: Rechteck,
  rand: string,
  dx: number,
  dy: number,
  f: Rechteck,
): Rechteck {
  let { x, y, b, h } = start;
  if (rand.includes("e")) b = Math.max(MIN_B, start.b + dx);
  if (rand.includes("s")) h = Math.max(MIN_H, start.h + dy);
  if (rand.includes("w")) {
    b = Math.max(MIN_B, start.b - dx);
    x = start.x + start.b - b;
  }
  if (rand.includes("n")) {
    h = Math.max(MIN_H, start.h - dy);
    y = Math.max(f.y, start.y + start.h - h);
    h = start.y + start.h - y;
  }
  return runde({ x, y, b, h });
}
