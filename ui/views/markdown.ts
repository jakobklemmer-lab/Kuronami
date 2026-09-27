import { escapeHtml } from "./html.js";

/**
 * Markdown → HTML für Antworten des Assistenten (Nachtrag 2026-09-16).
 *
 * Bis hierher zeigte der Composer den Antworttext roh: Sternchen, Rauten, Bindestriche —
 * „nicht übersichtlich zu lesen", wie der Nutzer sagte. Der Assistent antwortet in Markdown
 * (Überschriften, fette Stichworte, nummerierte Listen), also wird genau das gerendert, und
 * nicht mehr: Überschriften, Absätze, Listen, fett/kursiv, Code, Links, Tabellen. Kein rohes
 * HTML — jeder Textknoten läuft durch `escapeHtml`, ein `<script>` in einer Modellantwort
 * bleibt sichtbarer Text.
 *
 * Bewusst eigene achtzig Zeilen statt einer Bibliothek: die Oberfläche hat keine Laufzeit-
 * Abhängigkeiten (`ui/`, S21), und die Untermenge hier ist die, die ein Assistent schreibt.
 *
 * Artefakt-Verweise (`artifact://<session>/<id>`) werden zu Links, die `linkArtifact`
 * auflöst — der Aufrufer entscheidet, wohin (Nachtrag: `GET /artifacts/…` am Gateway).
 */

export interface MarkdownOptions {
  /** Wohin ein `artifact://…`-Verweis führt. Ohne Angabe bleibt er Text. */
  linkArtifact?: (uri: string) => string;
}

const ARTIFACT_URI = /artifact:\/\/[A-Za-z0-9_\-.]+\/[A-Za-z0-9_\-.]+/g;

/** Zeilen-Auszeichnung: Code, fett, kursiv, Links, Artefakt-Verweise. Auf bereits escaptem Text. */
function inline(text: string, options: MarkdownOptions): string {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, (_m, code: string) => `<code>${code}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, label: string, href: string) =>
      `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`,
  );
  if (options.linkArtifact) {
    const link = options.linkArtifact;
    out = out.replace(
      ARTIFACT_URI,
      (uri) =>
        `<a class="artifact-link" href="${escapeHtml(link(uri))}" data-artifact="${uri}">${uri}</a>`,
    );
  }
  return out;
}

/** `| a | b |` → `["a", "b"]`; die äußeren Striche sind optional wie in GitHub-Markdown. */
function zellen(zeile: string): string[] {
  let z = zeile.trim();
  if (z.startsWith("|")) z = z.slice(1);
  if (z.endsWith("|")) z = z.slice(0, -1);
  return z.split("|").map((c) => c.trim());
}

/** Die Trennzeile unter dem Tabellenkopf: `|---|:--:|--:|`. */
const TRENNER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/**
 * Tabellen (Nachtrag 2026-09-28): die boerse schreibt ihre Vergleiche als Tabelle, und 13 von
 * 21 abgelegten Analysen enthielten eine — in der Oberfläche standen sie als Wand aus
 * senkrechten Strichen. Die Ausrichtung aus der Trennzeile bleibt erhalten, weil Zahlen
 * rechtsbündig untereinander stehen müssen, um vergleichbar zu sein.
 */
function tabelle(
  kopf: string[],
  trenner: string[],
  zeilen: string[][],
  options: MarkdownOptions,
): string {
  const ausrichtung = trenner.map((c) =>
    c.endsWith(":") ? (c.startsWith(":") ? "center" : "right") : null,
  );
  const zelle = (tag: "th" | "td", inhalt: string, spalte: number): string => {
    const a = ausrichtung[spalte];
    return `<${tag}${a ? ` style="text-align:${a}"` : ""}>${inline(inhalt, options)}</${tag}>`;
  };
  const kopfHtml = kopf.map((c, i) => zelle("th", c, i)).join("");
  const koerper = zeilen
    .map((z) => `<tr>${kopf.map((_, i) => zelle("td", z[i] ?? "", i)).join("")}</tr>`)
    .join("");
  return `<div class="md-tabelle"><table><thead><tr>${kopfHtml}</tr></thead><tbody>${koerper}</tbody></table></div>`;
}

export function renderMarkdown(source: string, options: MarkdownOptions = {}): string {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let paragraph: string[] = [];
  let list: { kind: "ul" | "ol"; items: string[] } | null = null;
  let code: string[] | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    html.push(`<p>${inline(paragraph.join(" "), options)}</p>`);
    paragraph = [];
  };
  const flushList = (): void => {
    if (!list) return;
    html.push(
      `<${list.kind}>${list.items.map((item) => `<li>${item}</li>`).join("")}</${list.kind}>`,
    );
    list = null;
  };

  for (let n = 0; n < lines.length; n += 1) {
    const raw = lines[n];
    if (code !== null) {
      if (raw.startsWith("```")) {
        html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        code = null;
      } else {
        code.push(raw);
      }
      continue;
    }
    const line = raw.trimEnd();

    if (line.startsWith("```")) {
      flushParagraph();
      flushList();
      code = [];
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }
    if (line.trimStart().startsWith("|") && TRENNER.test(lines[n + 1] ?? "")) {
      flushParagraph();
      flushList();
      const kopf = zellen(line);
      const trenner = zellen(lines[n + 1]);
      const zeilen: string[][] = [];
      n += 2;
      while (n < lines.length && lines[n].trimStart().startsWith("|")) {
        zeilen.push(zellen(lines[n]));
        n += 1;
      }
      n -= 1;
      html.push(tabelle(kopf, trenner, zeilen, options));
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(heading[1].length + 2, 6);
      html.push(`<h${level}>${inline(heading[2], options)}</h${level}>`);
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const kind = bullet ? "ul" : "ol";
      const item = inline((bullet ?? numbered)?.[1] ?? "", options);
      if (list && list.kind === kind) list.items.push(item);
      else {
        flushList();
        list = { kind, items: [item] };
      }
      continue;
    }
    if (list) {
      // Fortsetzungszeile eines Listenpunkts (eingerückt oder nicht): an den letzten anhängen.
      list.items[list.items.length - 1] += ` ${inline(line.trim(), options)}`;
      continue;
    }
    paragraph.push(line.trim());
  }
  if (code !== null) html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
  flushParagraph();
  flushList();
  return html.join("");
}
