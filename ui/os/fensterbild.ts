/**
 * Kuros Fenster im Raum Kuro: ein Ausschnitt aus `ui/assets/night.jpg`, der das Bild wie
 * `background-size: cover` füllt. Hier steht, wo darin die rechte Scheibe liegt und wo der Orb
 * davor steht — auf dem Horizont, links neben dem Mond. Rein, damit es ohne Browser prüfbar ist.
 */

export const BILD = { breite: 2560, hoehe: 1429 } as const;

/** Die rechte Scheibe als Anteil des Bildes, an den Kanten der Helligkeit gemessen. */
export const SCHEIBE = { links: 0.365, rechts: 0.826, oben: 0.109, unten: 0.706 } as const;

/** Wohin der Kern des Orbs kommt (Anteil des Bildes): über dem Ufer, der Mond bleibt frei. */
export const MITTE = { x: 0.575, y: 0.475 } as const;

/** `background-position` des Ausschnitts: etwas mehr vom Raum links (Laternen) als rechts. */
export const LAGE = { x: 0.55, y: 0.36 } as const;

/**
 * Der Kern ist 46 % der kürzeren Seite des Orbs und steht bei 44 % seiner Höhe; die Unterschrift
 * beginnt 1,2 Radien unter ihm plus 24 px und ist etwa 40 px hoch (`kuronami-orb.mjs`).
 */
const KERN = 0.46;
const KERN_HOEHE = 0.44;
const UNTERSCHRIFT = { radien: 1.2, px: 64 } as const;

export interface Rechteck {
  links: number;
  oben: number;
  breite: number;
  hoehe: number;
}

/** Wo das ganze Bild liegt, wenn es den Kasten deckt (auch über seine Ränder hinaus). */
export function bildIm(kasten: Rechteck, lage: { x: number; y: number } = LAGE): Rechteck {
  const massstab = Math.max(kasten.breite / BILD.breite, kasten.hoehe / BILD.hoehe);
  const breite = BILD.breite * massstab;
  const hoehe = BILD.hoehe * massstab;
  return {
    links: kasten.links + (kasten.breite - breite) * lage.x,
    oben: kasten.oben + (kasten.hoehe - hoehe) * lage.y,
    breite,
    hoehe,
  };
}

export function scheibeIm(kasten: Rechteck, lage: { x: number; y: number } = LAGE): Rechteck {
  const b = bildIm(kasten, lage);
  return {
    links: b.links + SCHEIBE.links * b.breite,
    oben: b.oben + SCHEIBE.oben * b.hoehe,
    breite: (SCHEIBE.rechts - SCHEIBE.links) * b.breite,
    hoehe: (SCHEIBE.unten - SCHEIBE.oben) * b.hoehe,
  };
}

/**
 * Der Kasten des Orbs. Der Kern füllt drei Viertel der Scheibe, höchstens zwei Drittel des
 * Ausschnitts; die Satelliten dürfen über den Rahmen hinaus kreisen. Rechts endet der Kasten vor
 * dem Gespräch, und die Unterschrift bleibt über `frei.unten` (Gruß und „Heute").
 */
export function orbVor(
  kasten: Rechteck,
  frei: { rechts: number; unten: number } = {
    rechts: kasten.links + kasten.breite,
    unten: kasten.oben + kasten.hoehe,
  },
  lage: { x: number; y: number } = LAGE,
): Rechteck & { x: number; y: number } {
  const b = bildIm(kasten, lage);
  const s = scheibeIm(kasten, lage);
  const x = b.links + MITTE.x * b.breite;
  const y = Math.min(
    Math.max(b.oben + MITTE.y * b.hoehe, kasten.oben + 0.3 * kasten.hoehe),
    kasten.oben + 0.7 * kasten.hoehe,
  );
  const kern = Math.min(0.75 * s.breite, 0.75 * s.hoehe, (2 / 3) * kasten.hoehe);
  const seite = Math.max(
    0,
    Math.min(
      kern / KERN,
      2 * (frei.rechts - x),
      (frei.unten - y - UNTERSCHRIFT.px) / ((UNTERSCHRIFT.radien * KERN) / 2),
    ),
  );
  return {
    x,
    y,
    links: x - seite / 2,
    oben: y - KERN_HOEHE * seite,
    breite: seite,
    hoehe: seite,
  };
}
