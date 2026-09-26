/**
 * Welche Oberfläche gilt — „Standard" (die Präsenz unter `/`) oder „Modern" (die Welle unter
 * `/welle/`). Gewählt in den Einstellungen unter Erscheinungsbild; jede Oberfläche prüft beim
 * Start, ob sie die gewählte ist, und leitet sonst weiter. Der Hash bleibt, damit `#/mail` in
 * beiden dasselbe öffnet.
 */

export type Oberflaeche = "standard" | "modern";

export const OBERFLAECHE_NAME: Record<Oberflaeche, string> = {
  standard: "Standard",
  modern: "Modern",
};

/** Wohin weiterzuleiten ist, oder `null`, wenn die Seite schon die gewählte Oberfläche ist. */
export function oberflaecheZiel(pfad: string, hash: string, wahl: Oberflaeche): string | null {
  const inWelle = /\/welle(\/|\/index\.html)?$/.test(pfad);
  if (wahl === "modern" && !inWelle)
    return `${pfad.replace(/index\.html$/, "").replace(/\/?$/, "/")}welle/${hash}`;
  if (wahl === "standard" && inWelle)
    return `${pfad.replace(/welle(\/|\/index\.html)?$/, "")}${hash}`;
  return null;
}
