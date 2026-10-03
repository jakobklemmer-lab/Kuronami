/**
 * Das Band von Kuro OS (4c), ohne DOM: alle Räume liegen nebeneinander, jeder so groß wie die
 * Bühne über der Statuszeile. Im Stand füllt einer den Schirm. Beim Wechsel zieht die Kamera
 * zurück, bis die Nachbarn zu sehen sind, fährt hinüber und geht in den neuen Raum hinein.
 */

export interface Buehne {
  breite: number;
  hoehe: number;
}

export interface Lage {
  x: number;
  y: number;
  s: number;
}

/** So weit zieht die Kamera zurück — wie im Entwurf 4c (S2). */
export const ABSTAND_SKALA = 0.52;

/** Der Spalt zwischen zwei Räumen auf dem Band, vor dem Verkleinern gemessen. */
export function spalt(b: Buehne): number {
  return Math.max(96, Math.round(b.breite * 0.064));
}

/**
 * Wo das Band steht (Ursprung oben links), wenn Raum `i` mit Maßstab `s` mittig liegt. Bei
 * `s = 1` füllt er die Bühne; kleiner rückt er etwas nach oben, damit unter ihm die Namen stehen.
 */
export function lage(i: number, b: Buehne, s = 1): Lage {
  const schritt = b.breite + spalt(b);
  if (s >= 1) return { x: -i * schritt, y: 0, s: 1 };
  return {
    x: b.breite / 2 - s * (i * schritt + b.breite / 2),
    y: (b.hoehe - s * b.hoehe) / 2 - 0.055 * b.hoehe,
    s,
  };
}

export function transform(l: Lage): string {
  return `translate(${l.x.toFixed(2)}px, ${l.y.toFixed(2)}px) scale(${l.s})`;
}

/** Ein Nachbar ist schneller erreicht als der Raum am anderen Ende — aber nie träge. */
export function dauer(von: number, nach: number): number {
  return 500 + 140 * Math.min(3, Math.abs(nach - von));
}

/**
 * Die Fahrt als Bildfolge für `Element.animate`. Steht die Kamera schon zurückgezogen (ein
 * zweiter Wechsel während der Fahrt), beginnt sie dort und spart sich das Zurückziehen.
 * Die Kurve ist Smoothstep (`cubic-bezier(1/3, 0, 2/3, 1)`): kein Ruck am Anfang, kein Hängen.
 */
export function fahrt(
  von: Lage,
  nach: number,
  b: Buehne,
  vonRaum: number,
): Array<{ transform: string; offset: number; easing: string }> {
  const kurve = "cubic-bezier(0.333, 0, 0.667, 1)";
  const weit = lage(nach, b, ABSTAND_SKALA);
  const ziel = lage(nach, b);
  if (von.s < 0.999) {
    return [
      { transform: transform(von), offset: 0, easing: kurve },
      { transform: transform(weit), offset: 0.55, easing: kurve },
      { transform: transform(ziel), offset: 1, easing: kurve },
    ];
  }
  const zurueck = lage(vonRaum, b, ABSTAND_SKALA);
  return [
    { transform: transform(von), offset: 0, easing: kurve },
    { transform: transform(zurueck), offset: 0.3, easing: kurve },
    { transform: transform(weit), offset: 0.68, easing: kurve },
    { transform: transform(ziel), offset: 1, easing: kurve },
  ];
}

/** Liest Lage aus einer berechneten `transform`-Matrix (`matrix(a, b, c, d, e, f)`). */
export function ausMatrix(matrix: string): Lage | null {
  const m = /^matrix\(([^)]+)\)$/.exec(matrix.trim());
  if (!m) return matrix.trim() === "none" ? { x: 0, y: 0, s: 1 } : null;
  const [a, , , , e, f] = (m[1] ?? "").split(",").map((t) => Number(t.trim()));
  if (![a, e, f].every((n) => Number.isFinite(n))) return null;
  return { x: e as number, y: f as number, s: a as number };
}

/**
 * Wischen mit zwei Fingern: waagrechte Radbewegung sammeln, bis sie für einen Wechsel reicht.
 * Eine Geste löst höchstens einen Wechsel aus; sie endet, wenn eine Weile nichts mehr kommt.
 */
export interface Wischer {
  /** Gibt -1/1 zurück, wenn gewechselt werden soll, sonst 0. */
  rad(dx: number, dy: number, jetzt: number): -1 | 0 | 1;
}

export function wischer(schwelle = 140, ruhe = 260): Wischer {
  let summe = 0;
  let zuletzt = 0;
  let verbraucht = false;
  return {
    rad(dx, dy, jetzt) {
      if (jetzt - zuletzt > ruhe) {
        summe = 0;
        verbraucht = false;
      }
      zuletzt = jetzt;
      if (verbraucht || Math.abs(dx) < Math.abs(dy) * 1.5) return 0;
      summe += dx;
      if (Math.abs(summe) < schwelle) return 0;
      verbraucht = true;
      const r = summe > 0 ? 1 : -1;
      summe = 0;
      return r;
    },
  };
}
