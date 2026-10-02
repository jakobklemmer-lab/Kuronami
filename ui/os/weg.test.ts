import { describe, expect, it } from "vitest";
import { bereichFuerTaste, kruemel, liesWeg, schreibeWeg, wikiLinks } from "./weg.js";

describe("liesWeg", () => {
  it("kennt die vier Bereiche und fällt sonst auf Kuro zurück", () => {
    expect(liesWeg("")).toEqual({ bereich: "kuro", teil: null });
    expect(liesWeg("#/system")).toEqual({ bereich: "system", teil: null });
    expect(liesWeg("#/gibtsnicht")).toEqual({ bereich: "kuro", teil: null });
  });

  it("öffnet Trading auf den Märkten, wenn kein Reiter genannt ist", () => {
    expect(liesWeg("#/trading")).toEqual({ bereich: "trading", teil: "maerkte" });
    expect(liesWeg("#/trading/analysen")).toEqual({ bereich: "trading", teil: "analysen" });
    expect(liesWeg("#/trading/quatsch")).toEqual({ bereich: "trading", teil: "maerkte" });
  });

  it("liest Notizpfade mit Umlauten und Leerzeichen hin und zurück", () => {
    const w = { bereich: "brain" as const, teil: "Gespräche/2026/2026-10-02.md" };
    expect(liesWeg(schreibeWeg(w))).toEqual(w);
    const z = { bereich: "brain" as const, teil: "Bereiche/Studium und Arbeit.md" };
    expect(liesWeg(schreibeWeg(z))).toEqual(z);
    expect(liesWeg("#/brain")).toEqual({ bereich: "brain", teil: "START.md" });
  });
});

describe("bereichFuerTaste", () => {
  it("ordnet 1 bis 4 den Bereichen zu", () => {
    expect(bereichFuerTaste("1")).toBe("kuro");
    expect(bereichFuerTaste("3")).toBe("brain");
    expect(bereichFuerTaste("5")).toBeNull();
    expect(bereichFuerTaste("k")).toBeNull();
  });
});

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

describe("kruemel", () => {
  it("zerlegt den Pfad ohne Endung", () => {
    expect(kruemel("Trading/Journal/2026-10-01 DAX.md")).toEqual([
      "Trading",
      "Journal",
      "2026-10-01 DAX",
    ]);
  });
});
