import { describe, expect, it } from "vitest";
import { loeseLinks, sichererPfad } from "./brain-routen.js";

describe("sichererPfad", () => {
  it("lässt nur Notizen im Brain durch", () => {
    expect(sichererPfad("Trading/Journal.md")).toBe("Trading/Journal.md");
    expect(sichererPfad("/START.md")).toBe("START.md");
    expect(sichererPfad("../.env")).toBeNull();
    expect(sichererPfad("Trading/../../x.md")).toBeNull();
    expect(sichererPfad(".git/config.md")).toBeNull();
    expect(sichererPfad("Trading/Journal")).toBeNull();
    expect(sichererPfad(42)).toBeNull();
  });
});

describe("loeseLinks", () => {
  const pfade = ["START.md", "Bereiche/Trading.md", "Trading/Journal.md", "Gespräche/INDEX.md"];

  it("löst Wiki-Links wie Obsidian auf, auch über den Dateinamen", () => {
    const l = loeseLinks("START.md", "[[Bereiche/Trading|Trading]] [[Journal]] [[Fehlt]]", pfade);
    expect(l).toEqual({
      "Bereiche/Trading": "Bereiche/Trading.md",
      Journal: "Trading/Journal.md",
      Fehlt: null,
    });
  });

  it("löst relative Links vom Ort der Notiz aus auf", () => {
    expect(loeseLinks("Bereiche/Trading.md", "[x](../Trading/Journal.md)", pfade)).toEqual({
      "../Trading/Journal.md": "Trading/Journal.md",
    });
  });
});
