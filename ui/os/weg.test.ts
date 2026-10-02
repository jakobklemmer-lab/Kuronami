import { describe, expect, it } from "vitest";
import { baum } from "./brain.js";
import { umgebung } from "./graph-sim.js";
import { wikiLinks } from "./weg.js";

describe("wikiLinks", () => {
  it("ersetzt aufgelöste und offene Links durch Platzhalter", () => {
    const { text, platzhalter } = wikiLinks("- [[Trading/Journal|Journal]] und [[Fehlt]]", {
      "Trading/Journal": "Trading/Journal.md",
      Fehlt: null,
    });
    expect(text).toBe("- BRAINLINK0X und BRAINLINK1X");
    expect(platzhalter.get("BRAINLINK0X")).toEqual({ pfad: "Trading/Journal.md", text: "Journal" });
    expect(platzhalter.get("BRAINLINK1X")).toEqual({ pfad: null, text: "Fehlt" });
  });
});

describe("baum", () => {
  it("ordnet Pfade in Ordner und Dateien", () => {
    const w = baum(["START.md", "Trading/Journal.md", "Trading/Strategien/A.md"]);
    expect(w.dateien.map((d) => d.name)).toEqual(["START"]);
    const trading = w.ordner.get("Trading");
    expect(trading?.dateien.map((d) => d.name)).toEqual(["Journal"]);
    expect(trading?.ordner.get("Strategien")?.pfad).toBe("Trading/Strategien");
  });
});

describe("umgebung", () => {
  it("nimmt nur die Notiz und ihre direkten Nachbarn", () => {
    const knoten = ["a", "b", "c", "d"].map((p) => ({ pfad: p, titel: p, ordner: "" }));
    const u = umgebung(
      knoten,
      [
        ["a", "b"],
        ["c", "a"],
        ["c", "d"],
      ],
      "a",
    );
    expect(u.knoten.map((k) => k.pfad)).toEqual(["a", "b", "c"]);
    expect(u.kanten).toEqual([
      ["a", "b"],
      ["c", "a"],
    ]);
  });
});
