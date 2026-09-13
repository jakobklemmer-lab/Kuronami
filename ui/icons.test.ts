import { describe, expect, it } from "vitest";
import { ICON_NAMES, icon } from "./icons.js";

describe("icon", () => {
  it("baut fuer jeden bekannten Namen ein wohlgeformtes SVG mit Ansichtsfenster", () => {
    for (const name of ICON_NAMES) {
      const markup = icon(name);
      expect(markup.startsWith("<svg")).toBe(true);
      expect(markup).toContain('viewBox="0 0 20 20"');
      expect(markup).toContain("</svg>");
    }
  });

  it("ist ohne Text-Bedeutung standardmaessig aria-hidden", () => {
    expect(icon("home")).toContain('aria-hidden="true"');
  });

  it("laesst aria-hidden weg, wenn das Icon selbst die Bedeutung traegt", () => {
    expect(icon("home", { decorative: false })).not.toContain("aria-hidden");
  });

  it("uebernimmt eine uebergebene Klasse auf dem Wurzelelement", () => {
    expect(icon("mic", { className: "mic-button__icon" })).toContain('class="mic-button__icon"');
  });

  it("verwendet ausschliesslich currentColor, nie eine feste Farbe", () => {
    for (const name of ICON_NAMES) {
      expect(icon(name)).not.toMatch(/#[0-9a-fA-F]{3,6}/);
    }
  });
});
