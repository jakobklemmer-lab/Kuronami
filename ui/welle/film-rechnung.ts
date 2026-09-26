/**
 * Die Rechnung hinter dem Film — ohne DOM, damit sie ohne Browser prüfbar ist.
 *
 * Der Film ist eine Folge von Einzelbildern (`ui/welle/film/`), keine Videodatei: ein Video
 * lässt sich in Safari nicht Bild für Bild flüssig vor- und zurückspulen, eine Bildfolge schon.
 * Gezeichnet wird immer eine Mischung aus zwei Nachbarbildern — dadurch reichen 121 Bilder für
 * zehn Sekunden Fahrt, ohne dass ein langsames Scrollen ruckelt.
 */

export interface Bildpaar {
  /** Das Bild vor der Stelle. */
  a: number;
  /** Das Bild danach (am Ende dasselbe wie `a`). */
  b: number;
  /** Wie weit zwischen `a` und `b`, 0 bis 1. */
  t: number;
}

export function begrenze(wert: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, wert));
}

/** Welche zwei Bilder an einer Stelle des Films liegen, und wie weit dazwischen. */
export function bildpaar(fortschritt: number, anzahl: number): Bildpaar {
  if (anzahl <= 1) return { a: 0, b: 0, t: 0 };
  const lage = begrenze(fortschritt) * (anzahl - 1);
  const a = Math.min(Math.floor(lage), anzahl - 1);
  const b = Math.min(a + 1, anzahl - 1);
  return { a, b, t: b === a ? 0 : lage - a };
}

/**
 * In welcher Reihenfolge die Bilder geladen werden: erst jedes achte, dann die dazwischen.
 *
 * So steht nach einem Achtel der Ladezeit schon der ganze Weg grob da, und jede Fahrt hat Bilder,
 * auch wenn noch nicht alle angekommen sind. Die Stelle, an der der Film gerade steht, kommt
 * zuerst — sie ist das, was man sieht.
 */
export function ladeReihenfolge(anzahl: number, start = 0, schritte = [8, 4, 2, 1]): number[] {
  const gesehen = new Set<number>();
  const reihe: number[] = [];
  const nimm = (i: number): void => {
    if (i < 0 || i >= anzahl || gesehen.has(i)) return;
    gesehen.add(i);
    reihe.push(i);
  };
  nimm(begrenze(Math.round(start), 0, Math.max(0, anzahl - 1)));
  for (const schritt of schritte) {
    for (let i = 0; i < anzahl; i += schritt) nimm(i);
    nimm(anzahl - 1);
  }
  return reihe;
}

/** Das nächste schon geladene Bild — gezeichnet wird, was da ist, nicht was fehlt. */
export function naechstesGeladenes(ziel: number, geladen: readonly boolean[]): number | null {
  if (geladen[ziel]) return ziel;
  for (let abstand = 1; abstand < geladen.length; abstand++) {
    if (geladen[ziel - abstand]) return ziel - abstand;
    if (geladen[ziel + abstand]) return ziel + abstand;
  }
  return null;
}

/** Weich an beiden Enden — eine Kamera fährt an und bremst, sie springt nicht. */
export function sanft(t: number): number {
  const x = begrenze(t);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

/** Wie lange eine Fahrt dauert: kurze Wege kurz, der ganze Weg gut zwei Sekunden. */
export function fahrdauer(von: number, nach: number): number {
  return Math.round(begrenze(700 + Math.abs(nach - von) * 1600, 700, 2300));
}

/**
 * Wie das Bild die Fläche füllt, ohne verzerrt zu werden (`object-fit: cover` im Shader).
 *
 * Zurück kommt der Anteil des Bildes, der je Achse sichtbar ist: `[1, 0.56]` heißt, die ganze
 * Breite und gut die Hälfte der Höhe. Auf dem hochkant gehaltenen Telefon ist es umgekehrt.
 */
export function deckung(
  flaecheB: number,
  flaecheH: number,
  bildB: number,
  bildH: number,
): [number, number] {
  if (flaecheB <= 0 || flaecheH <= 0 || bildB <= 0 || bildH <= 0) return [1, 1];
  const flaeche = flaecheB / flaecheH;
  const bild = bildB / bildH;
  return flaeche > bild ? [1, bild / flaeche] : [flaeche / bild, 1];
}

/**
 * Wie weit der Film beim Scrollen durch „Dein Tag" gefahren ist.
 *
 * Oben steht Kuro im Raum (0); am Ende des Tages steht man draußen bei den Laternen (1). Die
 * letzten Bilder des Films sind fast still — die Kamera ist angekommen —, deshalb reicht ein
 * Scrollweg, der am Ende der Seite genau dort ankommt.
 */
export function scrollFortschritt(scrollTop: number, scrollHoehe: number, sichtHoehe: number) {
  const weg = scrollHoehe - sichtHoehe;
  if (weg <= 0) return 0;
  return begrenze(scrollTop / weg);
}
