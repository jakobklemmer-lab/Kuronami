/**
 * Wege in Kuro OS — die Adresse hinter dem `#`, ohne DOM.
 *
 * Vier Bereiche, mehr nicht (Jakob, 02.10.: „besser schnell erkennbar zum Durchklicken als alles
 * auf einmal"). Finanzen und Planung kommen dazu, wenn ihre Anbindungen stehen.
 */

export const BEREICHE = ["kuro", "trading", "brain", "system"] as const;
export type Bereich = (typeof BEREICHE)[number] | "einstellungen";

export const BEREICH_NAME: Record<(typeof BEREICHE)[number], string> = {
  kuro: "Kuro",
  trading: "Trading",
  brain: "Brain",
  system: "System",
};

export const TRADING = ["maerkte", "strategien", "analysen"] as const;
export type TradingTeil = (typeof TRADING)[number];

export const TRADING_NAME: Record<TradingTeil, string> = {
  maerkte: "Märkte",
  strategien: "Strategien",
  analysen: "Analysen",
};

export interface Weg {
  bereich: Bereich;
  /** Trading: der Reiter. Brain: der Pfad der Notiz. */
  teil: string | null;
}

export function liesWeg(hash: string): Weg {
  const roh = hash.replace(/^#\/?/, "");
  const [kopf = "", ...rest] = roh.split("/");
  const teil = rest.length > 0 ? decodeURIComponent(rest.join("/")) : null;
  switch (kopf) {
    case "trading":
      return {
        bereich: "trading",
        teil: TRADING.includes(teil as TradingTeil) ? teil : "maerkte",
      };
    case "brain":
      return { bereich: "brain", teil: teil?.endsWith(".md") ? teil : "START.md" };
    case "einstellungen":
      return { bereich: "einstellungen", teil };
    case "system":
      return { bereich: "system", teil: null };
    default:
      return { bereich: "kuro", teil: null };
  }
}

export function schreibeWeg(w: Weg): string {
  if (w.bereich === "kuro") return "#/kuro";
  if (w.teil === null) return `#/${w.bereich}`;
  const teil = w.teil
    .split("/")
    .map((t) => encodeURIComponent(t))
    .join("/");
  return `#/${w.bereich}/${teil}`;
}

/** ⌘1 … ⌘4 (Ctrl unter Windows): die Bereiche in der Reihenfolge der Leiste. */
export function bereichFuerTaste(taste: string): (typeof BEREICHE)[number] | null {
  const n = Number(taste);
  return Number.isInteger(n) && n >= 1 && n <= BEREICHE.length ? BEREICHE[n - 1] : null;
}

/**
 * Obsidian-Links für den Markdown-Leser: `[[Ziel|Text]]` wird zu einem Link mit
 * `data-brain`, dessen Ziel der Gateway schon aufgelöst hat. Was nicht aufgelöst ist, bleibt
 * als leiser Text stehen — ein Link ins Leere wäre eine Attrappe.
 */
export function wikiLinks(
  markdown: string,
  ziele: Readonly<Record<string, string | null>>,
): { text: string; platzhalter: Map<string, { pfad: string | null; text: string }> } {
  const platzhalter = new Map<string, { pfad: string | null; text: string }>();
  let n = 0;
  const text = markdown.replace(
    /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g,
    (_m, ziel: string, anzeige?: string) => {
      const schluessel = `BRAINLINK${n++}X`;
      const sauber = ziel.trim();
      platzhalter.set(schluessel, {
        pfad: ziele[sauber] ?? null,
        text: (anzeige ?? sauber.split("/").pop() ?? sauber).trim(),
      });
      return schluessel;
    },
  );
  return { text, platzhalter };
}

/** Die Krümel über einer Notiz: Ordner für Ordner bis zum Namen. */
export function kruemel(pfad: string): string[] {
  return pfad.replace(/\.md$/, "").split("/");
}
