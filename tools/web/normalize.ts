/**
 * Zwei reine Funktionen für S09, beide ohne Datenbank und ohne Bibliothek testbar:
 *
 *   - `normalizeContent` macht aus rohem HTML (oder Text) eine knappe, tag-freie Fassung
 *     für den Modellkontext. Der **Rohinhalt bleibt davon unberührt** — er liegt byteweise
 *     im Artefakt, siehe `tools/web/tools.ts`. Normalisierte Fassung und Rohinhalt teilen
 *     sich kein Feld.
 *   - `scanForInjection` sucht bekannte Prompt-Injection-Muster und gibt sie als Liste von
 *     Fundstellen zurück. Es **entfernt nichts** und verändert den Text nicht — Abschnitt
 *     4.7 ("Eine Anweisung aus externem Inhalt hebt nie eine Freigabe auf") und der
 *     ausdrückliche Auftrag "Injection-Muster kennzeichnen, nicht still entfernen". Ein
 *     still gelöschtes Muster wäre ein verstecktes Signal; ein markiertes ist eins, das
 *     das Modell und der Betreiber sehen.
 *
 * Die HTML-Behandlung ist bewusst regex-basiert und unvollständig (keine echte
 * DOM-Analyse, keine Lesbarkeits-Heuristik). Das ist vertretbar, weil die tag-freie
 * Fassung nur eine *Zusammenfassung* ist: die Wahrheit ist der Rohinhalt im Artefakt, und
 * wer ihn genau braucht, löst das Handle auf.
 */

export type NormalizedKind = "html" | "text";

export interface NormalizedContent {
  kind: NormalizedKind;
  /** Tag-frei, Whitespace zusammengefasst. Die *vollständige* normalisierte Fassung; der
   *  Aufrufer kürzt sie für den Kontext. */
  text: string;
  /** `<title>` bei HTML, sonst `null`. Auf 200 Zeichen begrenzt. */
  title: string | null;
}

/**
 * `type`, kein `interface`: nur ein Typalias mit reinen Primitivfeldern bekommt in
 * TypeScript die implizite Indexsignatur, mit der `InjectionFlag[]` als `JsonValue` durch
 * die Rückgabehülle geht (dieselbe Überlegung wie bei `ToolResult` in `tools/types.ts`).
 */
export type InjectionFlag = {
  /** Kennung des Musters, das gegriffen hat (z. B. `instruction-override`). */
  pattern: string;
  /** Der Treffer selbst, gekürzt. Läuft später durch den Redaction-Filter. */
  snippet: string;
  /** Zeichenoffset im normalisierten Text. */
  index: number;
};

const TITLE_MAX = 200;
const SNIPPET_MAX = 120;
/**
 * Mehr als das ist für eine Markierung nicht nötig und bläht die Rückgabehülle nur auf. Eine
 * Seite, die aus nichts als Injection-Phrasen besteht, ist mit einem Dutzend Fundstellen
 * hinreichend als solche erkannt; der Rest steht ohnehin im Rohinhalt-Artefakt.
 */
export const INJECTION_FLAGS_MAX = 12;

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&#x27;": "'",
  "&nbsp;": " ",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeFromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeFromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&[a-z]+;/gi, (match) => HTML_ENTITIES[match.toLowerCase()] ?? match);
}

function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** Zeilen trimmen, Leerzeichenläufe eindampfen, höchstens eine Leerzeile am Stück. */
function collapseWhitespace(text: string): string {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim());
  const out: string[] = [];
  for (const line of lines) {
    if (line === "" && out[out.length - 1] === "") continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

function looksLikeHtml(raw: string, contentType: string | null): boolean {
  if (contentType && /html|xml/i.test(contentType)) return true;
  if (
    contentType &&
    /^\s*(text\/plain|application\/json|text\/csv|text\/markdown)/i.test(contentType)
  ) {
    return false;
  }
  return /^\s*<(!doctype html|html\b|head\b|body\b|\?xml|meta\b|div\b|p\b)/i.test(raw);
}

/**
 * Rohinhalt → knappe, tag-freie Fassung. Ändert den übergebenen String nicht (Strings sind
 * unveränderlich); der aufrufende Code behält den Rohinhalt getrennt.
 */
export function normalizeContent(raw: string, contentType: string | null): NormalizedContent {
  if (!looksLikeHtml(raw, contentType)) {
    return { kind: "text", text: collapseWhitespace(raw), title: null };
  }

  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw);
  const title = titleMatch
    ? decodeEntities(titleMatch[1].replace(/\s+/g, " ").trim()).slice(0, TITLE_MAX)
    : null;

  const stripped = raw
    // Ganze Elemente samt Inhalt entfernen — ihr Text gehört nicht in die Zusammenfassung.
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, " ")
    .replace(/<template\b[\s\S]*?<\/template\s*>/gi, " ")
    .replace(/<head\b[\s\S]*?<\/head\s*>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Blockgrenzen zu Zeilenumbrüchen, bevor die Tags fallen.
    .replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|pre)\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  return { kind: "html", text: collapseWhitespace(decodeEntities(stripped)), title };
}

/**
 * Reihenfolge egal, jedes Muster läuft für sich. `g`-Flag Pflicht (mehrere Fundstellen je
 * Seite). Bewusst breit bei den Formulierungen (Deutsch und Englisch), bewusst schmal bei
 * den Quantoren (`[^.\n]{0,N}`), damit kein katastrophales Backtracking entsteht.
 */
const HIDDEN_UNICODE_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

export const INJECTION_PATTERNS: readonly { id: string; re: RegExp }[] = [
  {
    id: "instruction-override",
    re: /\b(ignore|disregard|forget|override|skip)\b[^.\n]{0,40}\b(all|any|the|previous|prior|earlier|preceding|above)\b[^.\n]{0,24}\b(instruction|instructions|prompt|prompts|context|rule|rules|message|messages)\b/gi,
  },
  {
    id: "instruction-override",
    re: /\bignore (all |any |the )?(previous|prior|preceding|above|earlier)\b/gi,
  },
  {
    id: "instruction-override-de",
    re: /\b(ignoriere|missachte|vergiss|überschreibe|überschreib)\b[^.\n]{0,40}\b(alle|jede|die|vorher|vorige|vorherigen|bisherige|bisherigen|obige|obigen)\b[^.\n]{0,28}\b(anweisung|anweisungen|vorgabe|vorgaben|regel|regeln|prompt|nachricht|nachrichten)\b/gi,
  },
  {
    id: "role-reassignment",
    re: /\b(you are now|from now on,? you (are|will|must|shall)|act as (?:a |an )?(?:different|new)|new (instructions?|persona|role))\b/gi,
  },
  {
    id: "role-reassignment-de",
    re: /\b(ab (jetzt|sofort) (bist|handelst|agierst) du|du bist (ab )?(jetzt|nun) (ein|eine)|neue (anweisung|anweisungen|rolle|persona))\b/gi,
  },
  {
    id: "system-prompt-probe",
    re: /\b(system prompt|systemprompt|reveal your (instructions|prompt|system|rules)|print your (instructions|prompt|system prompt)|repeat the (words? above|system prompt)|zeig(e)? (deinen |dein )?(system[- ]?prompt|anweisungen))\b/gi,
  },
  {
    id: "secrecy",
    re: /\b(do not|don'?t|never)\b[^.\n]{0,28}\b(tell|inform|mention|reveal|show|warn)\b[^.\n]{0,18}\b(the user|user|anyone|them)\b/gi,
  },
  {
    id: "secrecy-de",
    re: /\b(sag|verrate|erwähne|zeig(e)?|informiere)\b[^.\n]{0,24}\b(dem (nutzer|benutzer|user)|niemandem|keinem)\b[^.\n]{0,18}\bnicht\b/gi,
  },
  {
    id: "exfiltration",
    re: /\b(send|post|upload|exfiltrate|leak|forward|email)\b[^.\n]{0,40}\b(api[_-]?key|api[_-]?token|access[_-]?token|password|passwort|credentials?|secret|\.env|env var|private key)\b/gi,
  },
  {
    id: "exfiltration",
    re: /\b(curl|wget|fetch|Invoke-WebRequest)\b[^\n]{0,12}https?:\/\/\S+/gi,
  },
  {
    id: "tool-injection",
    re: /\b(call|invoke|use|run|execute)\b[^.\n]{0,20}\b(tool|function|command)\b[^.\n]{0,30}(fs\.|web\.|exec\.|mail\.send|task\.|rm\s+-rf|del\s+\/)/gi,
  },
  {
    id: "role-marker",
    re: /^[ \t>]{0,4}(system|assistant|developer)\s*:/gim,
  },
  {
    id: "fenced-instructions",
    re: /(<\|[a-z_]+\|>|\[\/?(INST|SYS|SYSTEM)\]|###\s*(system|instruction)s?\b)/gi,
  },
  {
    id: "hidden-unicode",
    // Zero-Width- und Bidi-Steuerzeichen: U+200B..200F, U+202A..202E, U+2060..2064, U+FEFF.
    // Ein klassischer Vektor, um einem Menschen im Rendering etwas anderes zu zeigen als
    // dem Modell im Text. Als \u-Escapes geschrieben, damit im Quelltext nichts Unsichtbares
    // steht.
    re: HIDDEN_UNICODE_RE,
  },
  {
    id: "jailbreak-literal",
    re: /\b(prompt injection|jailbreak|DAN mode|do anything now)\b/gi,
  },
];

/**
 * Sucht alle bekannten Muster im (bereits normalisierten) Text. Gibt Fundstellen zurück,
 * verändert nichts. Die Liste ist nach Offset sortiert und auf `INJECTION_FLAGS_MAX`
 * begrenzt — eine Seite, die nur aus Injection-Phrasen besteht, soll die Rückgabehülle
 * nicht sprengen.
 */
export function scanForInjection(text: string): InjectionFlag[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const flags: InjectionFlag[] = [];
  const seen = new Set<string>();

  for (const { id, re } of INJECTION_PATTERNS) {
    re.lastIndex = 0;
    for (const match of text.matchAll(re)) {
      const index = match.index ?? 0;
      const key = `${id}@${index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const raw = match[0] ?? "";
      const snippet =
        id === "hidden-unicode"
          ? `${describeHidden(raw)} bei Offset ${index}`
          : raw.replace(/\s+/g, " ").trim().slice(0, SNIPPET_MAX);
      flags.push({ pattern: id, snippet, index });
    }
  }

  flags.sort((a, b) => a.index - b.index || a.pattern.localeCompare(b.pattern));
  return flags.slice(0, INJECTION_FLAGS_MAX);
}

function describeHidden(ch: string): string {
  const code = ch.codePointAt(0) ?? 0;
  return `verstecktes Steuerzeichen U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * Prüft beim Laden des Moduls, dass jedes Muster global ist. Ohne `g` liefert `matchAll`
 * einen Fehler, und ein ohne `g` durchgerutschtes Muster fände nur den ersten Treffer je
 * Seite — dieselbe Zusage-in-einer-Prüfung wie in `runtime/redaction/patterns.ts`.
 */
export function assertInjectionPatternsUsable(
  patterns: readonly { id: string; re: RegExp }[] = INJECTION_PATTERNS,
): void {
  for (const { id, re } of patterns) {
    if (!re.global) {
      throw new Error(`Injection-Muster "${id}" hat kein g-Flag; matchAll bräche daran ab`);
    }
  }
}

assertInjectionPatternsUsable();
