/**
 * Wie sicher ist der Erwartungswert? — das Konfidenzintervall über die Handel.
 *
 * **Warum das die wichtigste fehlende Zahl war.** Ein Backtest meldet „+0,20 R je Handel" über
 * 35 Handel, und das sieht aus wie ein Befund. Es ist aber, je nach Streuung der Einzelhandel,
 * oft nicht von null zu unterscheiden: dieselben 35 Handel hätten mit reinem Zufall genauso
 * ausfallen können. Bisher stand im Bericht nur die Punktschätzung, und `bewerte` machte daraus
 * einen `kandidat`, der in den Papierhandel ging. Die Zahl war nicht falsch — sie war ohne
 * Fehlerbalken, und das ist bei Geld dasselbe.
 *
 * **Warum Bootstrap und nicht die Lehrbuchformel.** Die R-Verteilung einer Handelsstrategie ist
 * nicht glockenförmig: sie hat eine Mauer bei −1 (der Stop) und einen langen Schwanz nach oben
 * (Läufer). Ein t-Intervall unterstellt Symmetrie und schätzt genau dort falsch, wo es darauf
 * ankommt. Der Bootstrap unterstellt nichts über die Form — er zieht aus den tatsächlichen
 * Handeln.
 *
 * **Deterministisch, mit festem Startwert.** Zwei Läufe über dieselben Handel müssen dieselbe
 * Zahl ergeben. Ein Konfidenzintervall, das bei jedem Aufruf wackelt, wäre genau die Sorte
 * Zahl, gegen die dieses Haus gebaut ist.
 *
 * **Was es nicht kann:** Der Bootstrap zieht die Handel unabhängig voneinander. Sind sie es
 * nicht — überlappende Positionen, eine Regel, die in Serien handelt —, ist das Intervall zu
 * eng. Es ist die **freundlichste** ehrliche Schätzung, nicht die vorsichtigste.
 */

/**
 * Ein kleiner, schneller Zufallszahlengenerator mit Startwert (mulberry32). Kein `Math.random`:
 * das wäre bei jedem Lauf ein anderes Ergebnis.
 */
function wuerfel(startwert: number): () => number {
  let zustand = startwert >>> 0;
  return () => {
    zustand = (zustand + 0x6d2b79f5) >>> 0;
    let t = zustand;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Konfidenz {
  /** Grenzen des 95-%-Intervalls für den Erwartungswert je Handel, in R. */
  unten: number;
  oben: number;
  /**
   * Anteil der Ziehungen mit negativem Erwartungswert — grob: die Wahrscheinlichkeit, dass
   * hinter diesen Zahlen gar keine Kante steckt.
   */
  anteilNegativ: number;
  /**
   * Wie viele Handel es bei dieser Streuung bräuchte, damit das Intervall die Null verlässt.
   * `undefined`, wenn der Erwartungswert nicht positiv ist — dann ist die Frage sinnlos.
   */
  noetigeHandel?: number;
  ziehungen: number;
}

/** Schließt das Intervall die Null ein? Dann ist der Erwartungswert nicht belegt. */
export function nullEingeschlossen(k: Konfidenz): boolean {
  return k.unten <= 0 && k.oben >= 0;
}

function quantil(sortiert: readonly number[], anteil: number): number {
  const stelle = (sortiert.length - 1) * anteil;
  const unten = Math.floor(stelle);
  const oben = Math.ceil(stelle);
  if (unten === oben) return sortiert[unten];
  return sortiert[unten] + (sortiert[oben] - sortiert[unten]) * (stelle - unten);
}

/**
 * Das Konfidenzintervall des Erwartungswerts über die R-Werte der Handel.
 *
 * Unter zehn Handeln gibt es **kein** Intervall zurück: aus acht Zahlen ein Intervall zu ziehen
 * gaukelt eine Genauigkeit vor, die die Stichprobe nicht hergibt.
 */
export function konfidenz(
  rWerte: readonly number[],
  optionen: { ziehungen?: number; startwert?: number } = {},
): Konfidenz | undefined {
  const n = rWerte.length;
  if (n < 10) return undefined;
  const ziehungen = optionen.ziehungen ?? 2000;
  const naechste = wuerfel(optionen.startwert ?? 20260921);

  const mittelwerte: number[] = new Array(ziehungen);
  let negativ = 0;
  for (let z = 0; z < ziehungen; z += 1) {
    let summe = 0;
    for (let i = 0; i < n; i += 1) {
      summe += rWerte[Math.floor(naechste() * n)];
    }
    const mittel = summe / n;
    mittelwerte[z] = mittel;
    if (mittel < 0) negativ += 1;
  }
  mittelwerte.sort((a, b) => a - b);

  const mittel = rWerte.reduce((a, b) => a + b, 0) / n;
  // Standardabweichung der Einzelhandel (n−1), für die Hochrechnung „wie viele bräuchte es".
  const varianz = rWerte.reduce((summe, r) => summe + (r - mittel) ** 2, 0) / Math.max(1, n - 1);
  const streuung = Math.sqrt(varianz);

  let noetigeHandel: number | undefined;
  if (mittel > 0 && streuung > 0) {
    // n, ab dem 1,96 · s/√n kleiner als der Mittelwert wird. Eine Hochrechnung unter der
    // Annahme, dass Mittelwert und Streuung so bleiben — also eine Größenordnung, keine Zusage.
    noetigeHandel = Math.ceil(((1.96 * streuung) / mittel) ** 2);
  }

  return {
    unten: quantil(mittelwerte, 0.025),
    oben: quantil(mittelwerte, 0.975),
    anteilNegativ: negativ / ziehungen,
    ...(noetigeHandel !== undefined ? { noetigeHandel } : {}),
    ziehungen,
  };
}

/** Die Zeile für den Bericht. */
export function formatiereKonfidenz(k: Konfidenz, erwartungswertR: number): string {
  const kern = `  Erwartungswert ${erwartungswertR >= 0 ? "+" : ""}${erwartungswertR.toFixed(2)} R, 95-%-Intervall ${k.unten >= 0 ? "+" : ""}${k.unten.toFixed(2)} bis ${k.oben >= 0 ? "+" : ""}${k.oben.toFixed(2)} R`;
  if (nullEingeschlossen(k)) {
    const rest =
      k.noetigeHandel !== undefined
        ? ` — nicht von null zu unterscheiden. Bei dieser Streuung bräuchte es rund ${k.noetigeHandel} Handel.`
        : " — nicht von null zu unterscheiden.";
    return kern + rest;
  }
  return `${kern} — die Null liegt außerhalb (${(k.anteilNegativ * 100).toFixed(1)} % der Ziehungen negativ).`;
}
