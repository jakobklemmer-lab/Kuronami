import { describe, expect, it } from "vitest";
import { baueGraph, eingangsPlan, loeseLinks, sichererPfad } from "./brain-routen.js";

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

describe("eingangsPlan", () => {
  it("legt Text als Notiz und alles andere als Anhang mit Notiz ab", () => {
    expect(eingangsPlan("Ideen.md", "2026-10-02")).toEqual({
      notiz: "Eingang/2026-10-02 Ideen.md",
      anhang: null,
      text: true,
    });
    expect(eingangsPlan("Kontoauszug: Sept.PDF", "2026-10-02")).toEqual({
      notiz: "Eingang/2026-10-02 Kontoauszug Sept.md",
      anhang: "Anhänge/2026-10-02 Kontoauszug Sept.pdf",
      text: false,
    });
  });
});

describe("baueGraph", () => {
  it("sammelt Knoten mit Titel und Ordner und die aufgelösten Links als Kanten", () => {
    const g = baueGraph(
      new Map([
        ["START.md", "# Brain\n[[Bereiche/Trading|Trading]] [[Fehlt]]"],
        [
          "Bereiche/Trading.md",
          "---\nerzeugt: true\n---\n# Trading\n[[Trading/Journal|Journal]] [[START]]",
        ],
        ["Trading/Journal.md", "# Journal\n"],
      ]),
    );
    expect(g.knoten).toEqual([
      { pfad: "START.md", titel: "Brain", ordner: "" },
      { pfad: "Bereiche/Trading.md", titel: "Trading", ordner: "Bereiche" },
      { pfad: "Trading/Journal.md", titel: "Journal", ordner: "Trading" },
    ]);
    expect(g.kanten).toEqual([
      ["START.md", "Bereiche/Trading.md"],
      ["Bereiche/Trading.md", "Trading/Journal.md"],
      ["Bereiche/Trading.md", "START.md"],
    ]);
  });
});
