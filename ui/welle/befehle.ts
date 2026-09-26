/**
 * Das Befehlsfeld der Welle (⌘K) — die Suche, ohne DOM.
 *
 * Ein Feld für alles: einen Bereich öffnen, einen Abschnitt der Einstellungen, das Mikrofon, den
 * Verlauf leeren — und wenn nichts davon gemeint ist, geht der Text an Kuro. Das Letzte ist der
 * Kern: Kuro ist der Orchestrator, und von überall aus soll ein Satz an ihn genau einen
 * Tastendruck entfernt sein.
 */

export type Art = "ort" | "einstellung" | "aktion" | "frage";

export interface Befehl {
  id: string;
  titel: string;
  art: Art;
  /** Weitere Wörter, unter denen der Befehl gefunden wird (etwa „mail" für die Post). */
  stichworte: readonly string[];
}

/** Umlaute und Groß-/Kleinschreibung zählen nicht: „markt" findet „Märkte". */
export function normalisiere(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/ß/g, "ss")
    .trim();
}

/**
 * Wie gut ein Wort zur Eingabe passt, 0 = gar nicht.
 *
 * Anfang schlägt Wortanfang schlägt irgendwo schlägt „die Buchstaben kommen der Reihe nach vor".
 * Das Letzte fängt Tippfehler durch Auslassen („strtgn" → Strategien) und bleibt dabei unten.
 */
export function treffer(wort: string, eingabe: string): number {
  const w = normalisiere(wort);
  const e = normalisiere(eingabe);
  if (!e) return 0;
  if (w === e) return 100;
  if (w.startsWith(e)) return 80 - Math.min(20, w.length - e.length);
  if (w.split(/[\s-]+/).some((teil) => teil.startsWith(e))) return 55;
  if (w.includes(e)) return 40;
  let j = 0;
  for (const zeichen of w) if (zeichen === e[j]) j++;
  return j === e.length && e.length >= 3 ? 20 : 0;
}

export function wertung(befehl: Befehl, eingabe: string): number {
  let bestes = treffer(befehl.titel, eingabe);
  for (const wort of befehl.stichworte) bestes = Math.max(bestes, treffer(wort, eingabe) - 5);
  return bestes;
}

export const FRAGE_ID = "frage";

/**
 * Was das Befehlsfeld zeigt.
 *
 * Ohne Eingabe alle Befehle in ihrer Reihenfolge. Mit Eingabe die passenden, beste zuerst, und
 * dazu immer die Frage an Kuro — an erster Stelle, wenn nichts gut passt (dann ist die Eingabe
 * wohl ein Satz), sonst an letzter.
 */
export function rangiere(befehle: readonly Befehl[], eingabe: string): Befehl[] {
  const text = eingabe.trim();
  if (!text) return befehle.slice();
  const bewertet = befehle
    .map((befehl, i) => ({ befehl, i, w: wertung(befehl, text) }))
    .filter((x) => x.w > 0)
    .sort((a, b) => b.w - a.w || a.i - b.i);
  const frage: Befehl = { id: FRAGE_ID, titel: text, art: "frage", stichworte: [] };
  const gut = bewertet.length > 0 && bewertet[0].w >= 40;
  const liste = bewertet.map((x) => x.befehl);
  return gut ? [...liste, frage] : [frage, ...liste];
}
