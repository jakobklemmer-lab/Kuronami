/**
 * Die offenen Charts der Märkte in Kuro OS (4c): Reiter wie bei Obsidian oder im Browser. Wer einen
 * Wert wählt, öffnet ihn als Reiter; geschlossen wird mit ×. Ohne DOM, damit es prüfbar ist.
 */

export const OFFENE_HOECHSTENS = 8;
export const SPEICHER_OFFENE = "kuronami.markt.offen";

/** Öffnet `s` als Reiter. Sind es zu viele, fällt der älteste, der nicht gerade gezeigt wird. */
export function oeffneChart(offen: readonly string[], s: string): string[] {
  const neu = offen.includes(s) ? [...offen] : [...offen, s];
  while (neu.length > OFFENE_HOECHSTENS) {
    const weg = neu.findIndex((x) => x !== s);
    if (weg < 0) break;
    neu.splice(weg, 1);
  }
  return neu;
}

/**
 * Schließt `s`. War er der gezeigte, rückt der rechte Nachbar nach, am Ende der linke.
 * Der letzte Reiter bleibt — ein Chart ohne Wert gibt es nicht.
 */
export function schliesseChart(
  offen: readonly string[],
  s: string,
  gezeigt: string,
): { offen: string[]; naechster: string | null } {
  const i = offen.indexOf(s);
  if (i < 0 || offen.length <= 1) return { offen: [...offen], naechster: null };
  const neu = offen.filter((x) => x !== s);
  if (s !== gezeigt) return { offen: neu, naechster: null };
  return { offen: neu, naechster: neu[Math.min(i, neu.length - 1)] ?? null };
}

export function liesOffene(json: string | null): string[] {
  try {
    const roh: unknown = JSON.parse(json ?? "[]");
    if (!Array.isArray(roh)) return [];
    const werte = roh.filter((x): x is string => typeof x === "string" && x.trim() !== "");
    return [...new Set(werte.map((x) => x.toUpperCase()))].slice(-OFFENE_HOECHSTENS);
  } catch {
    return [];
  }
}
