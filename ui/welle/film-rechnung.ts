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

/** Das Bild, das einer Stelle am nächsten liegt. */
export function bildIndex(fortschritt: number, anzahl: number): number {
  return Math.round(begrenze(fortschritt) * Math.max(0, anzahl - 1));
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

/**
 * Wie die Kamera fährt: weich an, weich ab — aber schneller als der erste Wurf.
 *
 * Zwei Fehlschläge, bevor diese Kurve stand. Erst `sanft` als doppelte Kubik (ease-in-out dritten
 * Grades): bei einem Fünftel der Zeit drei Promille des Wegs — Jakob: „es ist sehr delayed".
 * Als Gegenzug ein reiner Ausklang (ease-out, vierte Potenz, sofortige Höchstgeschwindigkeit ab
 * dem ersten Bild): jetzt lag die ganze Bewegung im ersten Fünftel der Zeit — Jakob: „fühlt sich
 * jetzt etwas hektisch an". Diese Fassung ist wieder ein Ein- und Ausklang (stetige
 * Geschwindigkeit null an beiden Enden, kein Ruck), nur eine Potenz niedriger als der erste Wurf
 * (quadratisch statt kubisch): bei einem Fünftel der Zeit schon ein Zehntel des Wegs, keine
 * Standzeit, aber auch kein Sprung.
 */
export function sanft(t: number): number {
  const x = begrenze(t);
  return x * x * (3 - 2 * x);
}

/**
 * Wie lange eine Fahrt dauert: kurze Wege gut eine halbe Sekunde, der ganze Weg gut 1,3 Sekunden.
 * Vorher 0,7 bis 2,3 Sekunden (zu lang, „delayed"), dann kurz 0,45 bis 1,2 s mit der reinen
 * Ausklang-Kurve (zusammen mit ihr „hektisch"). Mit der weicheren Kurve oben trägt etwas mehr
 * Zeit wieder ruhiger.
 */
export function fahrdauer(von: number, nach: number): number {
  return Math.round(begrenze(550 + Math.abs(nach - von) * 700, 550, 1300));
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
