import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown.js";

describe("renderMarkdown — Tabellen", () => {
  it("macht aus einer GitHub-Tabelle eine Tabelle, mit Ausrichtung aus der Trennzeile", () => {
    const html = renderMarkdown(
      [
        "Vorher ein Satz.",
        "",
        "| Markt | Handel | EW in R |",
        "|:---|---:|:-:|",
        "| ^GSPC | 126 | **+0,01** |",
        "| GC=F | 117 |",
        "",
        "Danach ein Satz.",
      ].join("\n"),
    );
    expect(html).toContain("<p>Vorher ein Satz.</p>");
    // Linksbündig ist die Vorgabe und braucht keine Angabe.
    expect(html).toContain("<th>Markt</th>");
    expect(html).toContain('<td style="text-align:right">126</td>');
    expect(html).toContain('<td style="text-align:center"><strong>+0,01</strong></td>');
    // Eine zu kurze Zeile bekommt leere Zellen, keine verrutschte Spalte.
    expect(html).toContain(
      '<td style="text-align:right">117</td><td style="text-align:center"></td>',
    );
    expect(html).toContain("<p>Danach ein Satz.</p>");
    expect(html.match(/<tr>/g)).toHaveLength(3);
  });

  it("lässt eine Zeile mit Strichen ohne Trennzeile ein Absatz bleiben", () => {
    expect(renderMarkdown("| nur | ein Strich |")).toBe("<p>| nur | ein Strich |</p>");
  });

  it("entschärft HTML auch in Zellen", () => {
    const html = renderMarkdown("| a |\n|---|\n| <script>x</script> |");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
