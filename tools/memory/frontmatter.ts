/**
 * Das Frontmatter einer Gedächtnisnotiz — lesen und schreiben, ohne YAML-Bibliothek.
 *
 * **Bewusst winzig**, nach dem Muster des Cron-Parsers aus S17 und `globToRegExp` aus S11:
 * unterstützt werden genau zwei Formen, `schlüssel: wert` und `schlüssel: [a, b, c]`. Was
 * fehlt — Verschachtelung, mehrzeilige Werte, Anker, Typen jenseits von Text —, fehlt
 * **sichtbar** und wird abgewiesen, statt still falsch gedeutet zu werden.
 *
 * Der Grund gegen ein YAML-Paket ist nicht die Abhängigkeit allein, sondern die Fehlerklasse
 * dahinter: YAML deutet `nein`, `2026-09-09` und `1.0` je nach Fassung als Bool, Datum oder
 * Zahl. Eine Notiz mit dem Tag `no` würde zu `false`, und die Suche fände sie nie wieder —
 * ein Fehler, den niemand für einen Parserfehler hielte. Hier ist jeder Wert Text, und die
 * Deutung passiert an einer Stelle, die man lesen kann.
 *
 * Die Feldnamen sind deutsch wie der Rest der Notiz: sie stehen in Dateien, die ein Mensch
 * in seinem Editor öffnet und von Hand ändert (siehe `store.ts` — das ist kein Nebenweg,
 * sondern der vorgesehene).
 */

/** Das Frontmatter fehlt, ist unabgeschlossen oder trägt eine Zeile, die keine Zuweisung ist. */
export class FrontmatterError extends Error {}

const FENCE = "---";
/** `schlüssel: rest` — der Schlüssel kleingeschrieben mit Unterstrichen, wie die Ereignistypen. */
const ASSIGNMENT = /^([a-z][a-z0-9_]*)\s*:\s*(.*)$/;

export type FrontmatterValue = string | string[];

export interface ParsedNote {
  fields: Record<string, FrontmatterValue>;
  /** Alles nach dem schließenden `---`, ohne führende Leerzeilen. */
  body: string;
}

/**
 * Eine Liste `[a, b, c]`. Leere Einträge fallen weg, damit `[]` und `[ ]` beide die leere
 * Liste ergeben und ein versehentliches `[a, , b]` nicht zu einem leeren Tag führt.
 */
function parseList(raw: string): string[] {
  const inner = raw.slice(1, -1).trim();
  if (inner === "") return [];
  return inner
    .split(",")
    .map((entry) => unquote(entry.trim()))
    .filter((entry) => entry !== "");
}

/** Umschließende Anführungszeichen weg. Kein Escaping — es gibt keins, siehe `renderScalar`. */
function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Zerlegt eine Notizdatei in Frontmatter und Rumpf.
 *
 * Eine Datei ohne Frontmatter wirft. Sie stillschweigend als "Notiz ohne Felder" zu nehmen
 * wäre der bequemere Weg und der falsche: die Notiz käme ohne Datum, ohne Tags und ohne
 * Kennung in den Index und wäre danach nicht mehr auffindbar — ein Verlust, der wie ein
 * Erfolg aussieht.
 */
export function parseNote(text: string): ParsedNote {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  if (lines[0]?.trim() !== FENCE) {
    throw new FrontmatterError(
      `Die Notiz beginnt nicht mit "${FENCE}". Jede Gedächtnisnotiz trägt ein Frontmatter mit mindestens id, datum, titel, art und tags.`,
    );
  }

  const closing = lines.indexOf(FENCE, 1);
  if (closing === -1) {
    throw new FrontmatterError(
      `Das Frontmatter ist nicht abgeschlossen: die zweite "${FENCE}"-Zeile fehlt.`,
    );
  }

  const fields: Record<string, FrontmatterValue> = {};
  for (let i = 1; i < closing; i += 1) {
    const line = lines[i];
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;

    const match = ASSIGNMENT.exec(line);
    if (!match) {
      throw new FrontmatterError(
        `Zeile ${i + 1} des Frontmatters ist keine Zuweisung: "${line}". Erlaubt sind "schlüssel: wert" und "schlüssel: [a, b, c]", kleingeschrieben.`,
      );
    }

    const [, key, rawValue] = match;
    if (key in fields) {
      throw new FrontmatterError(
        `Feld "${key}" steht zweimal im Frontmatter. Welcher Wert gälte, wäre eine Frage der Lesereihenfolge — deshalb wird abgewiesen.`,
      );
    }

    const value = rawValue.trim();
    fields[key] = value.startsWith("[") && value.endsWith("]") ? parseList(value) : unquote(value);
  }

  return {
    fields,
    body: lines
      .slice(closing + 1)
      .join("\n")
      .replace(/^\n+/, "")
      .trimEnd(),
  };
}

/**
 * Ein Skalar für die Ausgabe. Werte mit Zeilenumbruch werden abgewiesen statt gekürzt: ein
 * stillschweigend abgeschnittener Titel stünde danach falsch in der Datei und im Index.
 */
function renderScalar(key: string, value: string): string {
  if (value.includes("\n")) {
    throw new FrontmatterError(
      `Feld "${key}" enthält einen Zeilenumbruch. Frontmatter-Werte sind einzeilig; mehrzeiliger Text gehört in den Rumpf der Notiz.`,
    );
  }
  // Ein Wert, der wie eine Liste aussähe, bekommt Anführungszeichen — sonst läse ihn
  // `parseNote` beim nächsten Mal als Liste zurück, und aus einem Titel würden Tags.
  const needsQuotes = value.startsWith("[") && value.endsWith("]");
  return `${key}: ${needsQuotes ? `"${value}"` : value}`;
}

function renderValue(key: string, value: FrontmatterValue): string {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (entry.includes(",") || entry.includes("\n") || entry.includes("]")) {
        throw new FrontmatterError(
          `Listeneintrag "${entry}" in Feld "${key}" enthält ein Komma, eine eckige Klammer oder einen Zeilenumbruch. Die Liste ließe sich danach nicht mehr eindeutig zurücklesen.`,
        );
      }
    }
    return `${key}: [${value.join(", ")}]`;
  }
  return renderScalar(key, value);
}

/**
 * Setzt eine Notizdatei zusammen. Die Feldreihenfolge ist die des übergebenen Objekts und
 * damit die des Aufrufers (`store.ts` gibt sie fest vor) — nicht sortiert, weil eine Notiz
 * für Menschen lesbar sein soll und `id, datum, titel` in dieser Folge gehören.
 */
export function renderNote(fields: Record<string, FrontmatterValue>, body: string): string {
  const lines = Object.entries(fields).map(([key, value]) => renderValue(key, value));
  return `${FENCE}\n${lines.join("\n")}\n${FENCE}\n\n${body.trim()}\n`;
}

/** Pflichtfeld als Text. Fehlt es oder ist es eine Liste, wirft es — der Index braucht es. */
export function requireScalar(parsed: ParsedNote, key: string): string {
  const value = parsed.fields[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new FrontmatterError(
      `Pflichtfeld "${key}" fehlt im Frontmatter oder ist leer (gefunden: ${JSON.stringify(value ?? null)}).`,
    );
  }
  return value.trim();
}

/** Listenfeld. Ein einzelner Text gilt als einelementige Liste, ein fehlendes Feld als leere. */
export function readList(parsed: ParsedNote, key: string): string[] {
  const value = parsed.fields[key];
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  return value.trim() === "" ? [] : [value.trim()];
}
