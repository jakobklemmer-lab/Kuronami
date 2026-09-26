/**
 * Kleine Formen der Welle — Gruß, Datum, Kurslinien. Rein, damit sie ohne Browser prüfbar sind.
 */

export const NAME = "Jakob";

export function gruss(d: Date, name = NAME): string {
  const h = d.getHours();
  const tageszeit =
    h < 5 ? "Gute Nacht" : h < 11 ? "Guten Morgen" : h < 18 ? "Guten Tag" : "Guten Abend";
  return `${tageszeit}, ${name}.`;
}

export function datumZeile(d: Date): string {
  return d.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" });
}

export function uhrzeit(d: Date): string {
  return d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

/** `^GDAXI` → `GDAXI`, `BTC-USD` → `BTC`, `EURUSD=X` → `EURUSD`. */
export function kurzSymbol(symbol: string): string {
  return symbol.replace(/^\^/, "").replace(/-USD$|=X$/, "");
}

/**
 * Der Pfad einer Kurslinie für ein SVG der Größe `b` × `h`.
 *
 * Oben ist hoch. Eine flache Reihe liegt in der Mitte statt an der Unterkante, und weniger als
 * zwei Werte ergeben keinen Pfad — eine Linie aus einem Punkt wäre eine Behauptung.
 */
export function kurslinie(werte: readonly number[], b: number, h: number, rand = 1): string {
  const reihe = werte.filter((w) => Number.isFinite(w));
  if (reihe.length < 2) return "";
  const min = Math.min(...reihe);
  const max = Math.max(...reihe);
  const spanne = max - min;
  const schritt = (b - 2 * rand) / (reihe.length - 1);
  return reihe
    .map((w, i) => {
      const x = rand + i * schritt;
      const y = spanne === 0 ? h / 2 : rand + (1 - (w - min) / spanne) * (h - 2 * rand);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}

/** Wie ein Auftrag ausgeht, dem man die Zeit ansieht: „um 14:05" heute, sonst mit Datum. */
export function wann(iso: string, jetzt: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const heute = d.toDateString() === jetzt.toDateString();
  if (heute) return `heute, ${uhrzeit(d)}`;
  const gestern = new Date(jetzt);
  gestern.setDate(jetzt.getDate() - 1);
  if (d.toDateString() === gestern.toDateString()) return `gestern, ${uhrzeit(d)}`;
  return d.toLocaleDateString("de-DE", { day: "numeric", month: "long" });
}

/**
 * Wie ein Bediensteter heißt, wenn man ihn anspricht. Im Gateway tragen sie Kennungen
 * (`context/bedienstete.ts`: `boerse`, `pruefer` …); gelesen werden sie als Namen. Eine
 * unbekannte Kennung bekommt nur einen Großbuchstaben — lieber „Neuling" als nichts.
 */
const BEDIENSTETE: Readonly<Record<string, string>> = {
  korrespondenz: "Korrespondenz",
  werkstatt: "Werkstatt",
  journal: "Journal",
  boerse: "Börse",
  recherche: "Recherche",
  technik: "Technik",
  nachrichten: "Nachrichten",
  stratege: "Stratege",
  pruefer: "Prüfer",
  risiko: "Risiko",
};

export function werName(kennung: string): string {
  const k = kennung.trim();
  return BEDIENSTETE[k] ?? (k ? k[0].toUpperCase() + k.slice(1) : k);
}

/** Die Zustände einer Strategie, wie die Strategien-Ansicht sie nennt. */
const STRATEGIE_STAND: Readonly<Record<string, string>> = {
  entwurf: "Entwurf",
  geprueft: "geprüft",
  kandidat: "Kandidat",
  verworfen: "verworfen",
};

export function strategieStand(status: string): string {
  return STRATEGIE_STAND[status] ?? status;
}
