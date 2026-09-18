import { describe, expect, it } from "vitest";
import { escapeHtml } from "./html.js";

describe("escapeHtml", () => {
  it("entschärft alle fünf Sonderzeichen", () => {
    expect(escapeHtml(`<b onclick="x('y')">&</b>`)).toBe(
      "&lt;b onclick=&quot;x(&#39;y&#39;)&quot;&gt;&amp;&lt;/b&gt;",
    );
  });

  it("lässt gewöhnlichen Text unverändert", () => {
    expect(escapeHtml("Apple Inc. · NASDAQ")).toBe("Apple Inc. · NASDAQ");
  });
});
