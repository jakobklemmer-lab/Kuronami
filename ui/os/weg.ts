/**
 * Obsidian-Links für den Markdown-Leser des Brain: `[[Ziel|Text]]` wird zu einem Platzhalter,
 * dessen Ziel der Gateway schon aufgelöst hat. Was nicht aufgelöst ist, bleibt als leiser Text
 * stehen — ein Link ins Leere wäre eine Attrappe.
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
