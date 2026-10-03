import { describe, expect, it } from "vitest";
import {
  baueGraph,
  eingangsPlan,
  erstelltAm,
  loeseLinks,
  sichererPfad,
  tagsIn,
} from "./brain-routen.js";

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
    expect(g.knoten.map(({ pfad, titel, ordner }) => ({ pfad, titel, ordner }))).toEqual([
      { pfad: "START.md", titel: "Brain", ordner: "" },
      { pfad: "Bereiche/Trading.md", titel: "Trading", ordner: "Bereiche" },
      { pfad: "Trading/Journal.md", titel: "Journal", ordner: "Trading" },
    ]);
    expect(g.offen).toEqual([["START.md", "Fehlt"]]);
    expect(g.kanten).toEqual([
      ["START.md", "Bereiche/Trading.md"],
      ["Bereiche/Trading.md", "Trading/Journal.md"],
      ["Bereiche/Trading.md", "START.md"],
    ]);
  });
});

describe("erstelltAm", () => {
  const zeiten = { geaendert: 5_000, geboren: 4_000 };
  it("nimmt das Datum im Namen, dann die Eigenschaft, dann die Datei", () => {
    expect(erstelltAm("Gespräche/2026/2026-09-18.md", {}, zeiten)).toBe(Date.UTC(2026, 8, 18, 12));
    expect(erstelltAm("Wissen/Idee.md", { datum: "2026-09-20" }, zeiten)).toBe(
      Date.UTC(2026, 8, 20, 12),
    );
    expect(erstelltAm("Wissen/Idee.md", {}, zeiten)).toBe(4_000);
    expect(erstelltAm("Wissen/Idee.md", {}, { geaendert: 5_000, geboren: 0 })).toBe(5_000);
  });
});

describe("tagsIn", () => {
  it("liest Tags aus den Eigenschaften und dem Text, nicht aus Titeln und Code", () => {
    expect(
      tagsIn(
        { tags: ["Trading", "#Krypto"] },
        "# Titel\nText mit #Idee und #idee/neu\n`#kein` ```\n#auch-nicht\n```",
      ),
    ).toEqual(["idee", "idee/neu", "krypto", "trading"]);
    expect(tagsIn({ tags: "a, b" }, "")).toEqual(["a", "b"]);
  });
});
