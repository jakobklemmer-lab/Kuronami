/**
 * Die Geometrie der beiden kleinen Diagramme aus der Bildvorlage — die Mini-Kurslinie in der
 * Markets-Karte und der Ringfuellstand der System-Messuhren. Reine Funktionen ohne `document`,
 * damit die Rechnung geprueft werden kann; das SVG-Markup selbst baut `ui/views/home.ts`.
 */

/**
 * Rechnet eine Zahlenreihe auf `width`x`height` um und liefert die `points`-Zeichenkette einer
 * SVG-Polylinie. Der Verlauf wird auf seinen eigenen Wertebereich normalisiert (nicht auf Null),
 * damit auch eine Reihe mit kleinen Ausschlaegen sichtbar bleibt — eine Kurslinie zeigt die
 * Bewegung, nicht den Absolutwert.
 *
 * Eine konstante Reihe (kein Ausschlag) wird zur waagerechten Linie auf halber Hoehe statt durch
 * eine Division durch Null zu `NaN` zu werden.
 */
export function sparklinePoints(values: readonly number[], width: number, height: number): string {
  if (values.length === 0) return "";
  if (values.length === 1) {
    const y = height / 2;
    return `0,${round(y)} ${round(width)},${round(y)}`;
  }

  let min = values[0] as number;
  let max = values[0] as number;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const span = max - min;
  const stepX = width / (values.length - 1);

  return values
    .map((value, index) => {
      const x = index * stepX;
      // SVG zaehlt y von oben — ein hoher Wert muss deshalb ein kleines y ergeben.
      const y = span === 0 ? height / 2 : height - ((value - min) / span) * height;
      return `${round(x)},${round(y)}`;
    })
    .join(" ");
}

/**
 * Der Umfang eines Kreises mit `radius` — die Laenge, auf die sich `stroke-dasharray` bezieht.
 */
export function circleCircumference(radius: number): number {
  return 2 * Math.PI * radius;
}

/**
 * `stroke-dasharray` fuer einen Ring, der `percent` seines Umfangs fuellt. Werte ausserhalb
 * 0–100 werden begrenzt, damit ein fehlerhafter Messwert keinen Ring mit negativer Laenge
 * erzeugt.
 */
export function gaugeDashArray(percent: number, radius: number): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const circumference = circleCircumference(radius);
  const filled = (clamped / 100) * circumference;
  return `${round(filled)} ${round(circumference - filled)}`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
