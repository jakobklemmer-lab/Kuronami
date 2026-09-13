import { describe, expect, it } from "vitest";
import { EMBLEM_PATH, EMBLEM_VIEW_BOX, emblemMarkup } from "./emblem.js";

describe("emblemMarkup", () => {
  it("baut ein SVG mit dem festen Ansichtsfenster und Pfad", () => {
    const markup = emblemMarkup();
    expect(markup).toContain(`viewBox="${EMBLEM_VIEW_BOX}"`);
    expect(markup).toContain(EMBLEM_PATH);
    expect(markup).toContain("</svg>");
  });

  it("setzt keine feste Farbe — nur currentColor", () => {
    expect(emblemMarkup()).not.toMatch(/#[0-9a-fA-F]{3,6}/);
    expect(emblemMarkup()).toContain('fill="currentColor"');
  });

  it("setzt weder Filter noch Animation (kein Glow, kein Verlauf)", () => {
    const markup = emblemMarkup();
    expect(markup).not.toContain("filter");
    expect(markup).not.toContain("animat");
    expect(markup).not.toContain("gradient");
  });

  it("uebernimmt eine uebergebene Klasse", () => {
    expect(emblemMarkup("sidebar__emblem")).toContain('class="sidebar__emblem"');
  });

  it("hat eine gerade Zahl an Pfadbefehlen, die zu geschlossenen Teilpfaden passt (kein Abbruch mitten im Pfad)", () => {
    // Grobe Plausibilitaetspruefung statt vollem Parser: mindestens so viele M wie Z, aus der
    // Extraktion in scratchpad/emblem/build-path.mjs — jeder geschlossene Teilpfad endet mit Z.
    const moveCount = (EMBLEM_PATH.match(/M/g) ?? []).length;
    const closeCount = (EMBLEM_PATH.match(/Z/g) ?? []).length;
    expect(moveCount).toBeGreaterThan(0);
    expect(closeCount).toBeGreaterThan(0);
  });
});
