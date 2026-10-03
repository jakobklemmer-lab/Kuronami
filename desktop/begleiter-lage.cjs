/**
 * Wo der Begleiter steht — reine Rechnung ohne Electron, damit sie sich prüfen lässt.
 *
 * Gerechnet wird mit dem Kasten der Figur (`FIGUR`, Ecke oben links). Das Fenster ist größer
 * (`FENSTER`), damit die Sprechblase hineinpasst, ohne dass es beim Öffnen wächst; außerhalb von
 * Figur und Blase ist es durchklickbar. Je nach Platz steht die Blase über oder unter der Figur,
 * und nahe am Rand rückt die Figur im Fenster zur Seite (`versatz`), damit die Blase auf dem
 * Schirm bleibt.
 */

const FIGUR = { breite: 168, hoehe: 200 };
const FENSTER = { breite: 320, hoehe: 460 };
const VERSATZ_MAX = (FENSTER.breite - FIGUR.breite) / 2;
/** Liegt seine Mitte so nah an einer freien Bildschirmkante, nimmt er sich halb hinaus. */
const RAND_FANG = 56;
const ABSTAND = 24;

const klemme = (wert, min, max) => Math.min(Math.max(wert, min), Math.max(min, max));
const mitte = (figur) => ({ x: figur.x + FIGUR.breite / 2, y: figur.y + FIGUR.hoehe / 2 });
const enthaelt = (r, p) => p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;

/** Der Schirm unter dem Punkt, sonst der nächste. */
function schirmFuer(punkt, schirme) {
  const drauf = schirme.find((s) => enthaelt(s.bounds, punkt));
  if (drauf) return drauf;
  let naechster = schirme[0];
  let weite = Number.POSITIVE_INFINITY;
  for (const s of schirme) {
    const b = s.bounds;
    const dx = punkt.x - klemme(punkt.x, b.x, b.x + b.width);
    const dy = punkt.y - klemme(punkt.y, b.y, b.y + b.height);
    if (dx * dx + dy * dy < weite) {
      weite = dx * dx + dy * dy;
      naechster = s;
    }
  }
  return naechster;
}

/** Hinter einer Kante, an die ein zweiter Schirm anschließt, kann er sich nicht verstecken. */
const kanteFrei = (x, y, schirme) => !schirme.some((s) => enthaelt(s.bounds, { x, y }));

/** Wohin die Figur nach dem Loslassen kommt: ganz auf den Schirm oder halb über eine freie Kante. */
function setzeAb(figur, schirme) {
  const m = mitte(figur);
  const { bounds: b, workArea: a } = schirmFuer(m, schirme);
  const y = Math.round(klemme(figur.y, a.y, a.y + a.height - FIGUR.hoehe));
  const my = y + FIGUR.hoehe / 2;
  if (m.x < b.x + RAND_FANG && kanteFrei(b.x - 1, my, schirme)) {
    return { x: b.x - FIGUR.breite / 2, y, rand: "links" };
  }
  if (m.x > b.x + b.width - RAND_FANG && kanteFrei(b.x + b.width, my, schirme)) {
    return { x: b.x + b.width - FIGUR.breite / 2, y, rand: "rechts" };
  }
  return { x: Math.round(klemme(figur.x, a.x, a.x + a.width - FIGUR.breite)), y, rand: null };
}

/** Zurückgenommen und angeklickt: er kommt ganz herein, an dieselbe Kante. */
function ausDemRand(figur, schirme) {
  if (!figur.rand) return figur;
  const { workArea: a } = schirmFuer(mitte(figur), schirme);
  const x = figur.rand === "links" ? a.x : a.x + a.width - FIGUR.breite;
  return { x, y: figur.y, rand: null };
}

/** Das Fenster um die Figur, und wo darin Figur und Blase stehen. */
function aufbau(figur, schirme) {
  const { workArea: a } = schirmFuer(mitte(figur), schirme);
  const mx = figur.x + FIGUR.breite / 2;
  const links = klemme(mx - FENSTER.breite / 2, a.x, a.x + a.width - FENSTER.breite);
  const versatz = Math.round(klemme(mx - (links + FENSTER.breite / 2), -VERSATZ_MAX, VERSATZ_MAX));
  const ueber = FENSTER.hoehe - FIGUR.hoehe;
  const seite = figur.y - ueber >= a.y ? "oben" : "unten";
  return {
    fenster: {
      x: Math.round(mx - FENSTER.breite / 2 - versatz),
      y: Math.round(seite === "oben" ? figur.y - ueber : figur.y),
      width: FENSTER.breite,
      height: FENSTER.hoehe,
    },
    seite,
    versatz,
  };
}

/** Umkehrung von `aufbau`: wo die Figur steht, wenn das Fenster dort ist. */
function figurAus(fenster, { seite, versatz }) {
  return {
    x: fenster.x + FENSTER.breite / 2 + versatz - FIGUR.breite / 2,
    y: seite === "oben" ? fenster.y + FENSTER.hoehe - FIGUR.hoehe : fenster.y,
  };
}

/** Die gemerkte Lage, auf die heutigen Schirme geholt — ohne eine: unten rechts. */
function startLage(gemerkt, schirme, primaer) {
  if (gemerkt && Number.isFinite(gemerkt.x) && Number.isFinite(gemerkt.y)) {
    return setzeAb(gemerkt, schirme);
  }
  const a = primaer.workArea;
  return {
    x: a.x + a.width - FIGUR.breite - ABSTAND,
    y: a.y + a.height - FIGUR.hoehe - ABSTAND,
    rand: null,
  };
}

/** Liegt der Zeiger (im Fenster) auf Figur oder Blase? Dort nimmt das Fenster Klicks an. */
const trifft = (punkt, flaechen) =>
  flaechen.some((r) => enthaelt({ x: r.x, y: r.y, width: r.w, height: r.h }, punkt));

module.exports = {
  FIGUR,
  FENSTER,
  RAND_FANG,
  setzeAb,
  ausDemRand,
  aufbau,
  figurAus,
  startLage,
  trifft,
};
