import { describe, expect, it } from "vitest";
import { lesbarerText, textMitLinks } from "./mail.js";

describe("lesbarerText", () => {
  it("fasst Stapel von Leerzeilen zu einer zusammen und lässt den Wortlaut stehen", () => {
    expect(lesbarerText("Hallo,\r\n\r\n\r\n\r\ngib diesen Code ein:   \n\n \n\n597384\n")).toBe(
      "Hallo,\n\ngib diesen Code ein:\n\n597384",
    );
  });

  it("behält einfache Zeilenumbrüche und eine Leerzeile", () => {
    expect(lesbarerText("Zeile eins\nZeile zwei\n\nAbsatz")).toBe(
      "Zeile eins\nZeile zwei\n\nAbsatz",
    );
  });

  it("löst HTML-Kürzel auf und wirft unsichtbare Füllzeichen weg", () => {
    expect(
      lesbarerText("Save on styles&zwnj; &#8199;&zwnj; &#8199;&zwnj; &#8199;\nA &amp; B &lt;3"),
    ).toBe("Save on styles\nA & B <3");
    expect(lesbarerText("unbekannt &foo; bleibt")).toBe("unbekannt &foo; bleibt");
  });
});

describe("textMitLinks", () => {
  it("macht aus langen Adressen Links mit dem Host als Text und maskiert den Rest", () => {
    const html = textMitLinks("Siehe https://click.example.com/?qs=abc&x=1. <b>fett</b>");
    expect(html).toBe(
      'Siehe <a class="leser__link" href="https://click.example.com/?qs=abc&amp;x=1" target="_blank" rel="noopener noreferrer" title="https://click.example.com/?qs=abc&amp;x=1">click.example.com</a>. &lt;b&gt;fett&lt;/b&gt;',
    );
  });

  it("lässt alles ohne http(s) als Text stehen", () => {
    expect(textMitLinks('javascript:alert(1) "x"')).toBe("javascript:alert(1) &quot;x&quot;");
  });
});
