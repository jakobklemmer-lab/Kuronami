import { describe, expect, it } from "vitest";
import {
  abstaende,
  baueFilter,
  benenne,
  huelle,
  leseFarbe,
  louvain,
  mische,
  pageRank,
  woerter,
} from "./graph-mass.js";

describe("pageRank", () => {
  it("hebt die Notiz, auf die alle zeigen", () => {
    const r = pageRank(4, [
      [1, 0],
      [2, 0],
      [3, 0],
      [0, 1],
    ]);
    expect(r[0]).toBeGreaterThan(r[1]);
    expect(r[1]).toBeGreaterThan(r[2]);
    expect(r.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 6);
  });
});

describe("louvain", () => {
  it("findet zwei Dreiecke, die nur eine Brücke verbindet", () => {
    const k = [
      [0, 1],
      [1, 2],
      [0, 2],
      [3, 4],
      [4, 5],
      [3, 5],
      [2, 3],
    ].map(([a, b]) => ({ a, b }));
    const g = louvain(6, k);
    expect(g[0]).toBe(g[1]);
    expect(g[1]).toBe(g[2]);
    expect(g[3]).toBe(g[4]);
    expect(g[4]).toBe(g[5]);
    expect(g[0]).not.toBe(g[3]);
  });
  it("lässt eine Notiz ohne Links allein", () => {
    const g = louvain(3, [{ a: 0, b: 1 }]);
    expect(g[0]).toBe(g[1]);
    expect(g[2]).not.toBe(g[0]);
  });
});

describe("benenne", () => {
  it("nimmt den Namen des Verzeichnisses oder die prägenden Wörter", () => {
    const titel = [
      "Strategien",
      "MACD Kreuzung long",
      "MACD Momentum long",
      "Gespräch Montag",
      "Gespräch Dienstag",
      "Gespräch Mittwoch",
    ];
    const g = [0, 0, 0, 1, 1, 1];
    const n = benenne(g, titel, [0.5, 0.1, 0.1, 0.1, 0.12, 0.1], [2, 3, 3, 3, 3, 3]);
    expect(n[0].name).toBe("Strategien");
    expect(n[1].name).toBe("Gespräch");
    expect(n[1].mitte).toBe(4);
  });
  it("lässt Füllwörter weg", () => {
    expect(woerter("How to Tell If a Stock Is Undervalued")).toEqual([
      "tell",
      "stock",
      "undervalued",
    ]);
  });
});

describe("abstaende", () => {
  it("zählt Links bis zur Tiefe", () => {
    const nb = [new Set([1]), new Set([0, 2]), new Set([1, 3]), new Set([2])];
    expect(abstaende(0, nb, 2)).toEqual([0, 1, 2, Number.POSITIVE_INFINITY]);
  });
});

describe("baueFilter", () => {
  const jetzt = Date.UTC(2026, 9, 3);
  const knoten = [
    {
      pfad: "START.md",
      titel: "Brain",
      ordner: "",
      tags: [],
      farbe: null,
      erstellt: jetzt - 30 * 864e5,
      geaendert: jetzt - 864e5,
    },
    {
      pfad: "Trading/Journal.md",
      titel: "Journal",
      ordner: "Trading",
      tags: ["trading", "trading/journal"],
      farbe: null,
      erstellt: Date.UTC(2026, 8, 20, 12),
      geaendert: jetzt - 40 * 864e5,
    },
    {
      pfad: "Wissen/Idee.md",
      titel: "Eine Idee",
      ordner: "Wissen",
      tags: [],
      farbe: "rot",
      erstellt: jetzt,
      geaendert: jetzt,
    },
  ];
  const ctx = {
    knoten,
    grad: [1, 1, 0],
    ein: [0, 1, 0],
    aus: [1, 0, 0],
    clusterName: (i: number) => (i < 2 ? "Trading" : "Wissen"),
    angeheftet: (i: number) => i === 2,
    jetzt,
  };
  const welche = (q: string) => [0, 1, 2].filter((i) => baueFilter(q, ctx).passt(i));
  it("versteht Wörter, Ordner, Tags und Verneinung", () => {
    expect(welche("")).toEqual([0, 1, 2]);
    expect(welche("journal")).toEqual([1]);
    expect(welche("ordner:trading")).toEqual([1]);
    expect(welche("tag:trading")).toEqual([1]);
    expect(welche("-ordner:trading")).toEqual([0, 2]);
    expect(welche('cluster:"wissen"')).toEqual([2]);
  });
  it("versteht Zahlen, Zeiten und Zustände", () => {
    expect(welche("links:>0")).toEqual([0, 1]);
    expect(welche("aus:0")).toEqual([1, 2]);
    expect(welche("ist:waise")).toEqual([2]);
    expect(welche("ist:angeheftet")).toEqual([2]);
    expect(welche("geaendert:<7d")).toEqual([0, 2]);
    expect(welche("geaendert:>30d")).toEqual([1]);
    expect(welche("erstellt:2026-09-20")).toEqual([1]);
    expect(welche("erstellt:>2026-09-20")).toEqual([2]);
  });
  it("meldet, was es nicht versteht", () => {
    expect(baueFilter("links:viele", ctx).fehler).toContain("Zahl");
  });
});

describe("Farben", () => {
  it("liest Namen und Hexwerte", () => {
    expect(leseFarbe("Rot")).toBe("#f07a7a");
    expect(leseFarbe("#abc")).toBe("#aabbcc");
    expect(leseFarbe("nix")).toBeNull();
    expect(mische("#000000", "#ffffff", 0.5)).toBe("#808080");
  });
});

describe("huelle", () => {
  it("lässt innere Punkte weg", () => {
    const h = huelle([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 5, y: 5 },
      { x: 3, y: 2 },
    ]);
    expect(h).toHaveLength(4);
    expect(h).not.toContainEqual({ x: 5, y: 5 });
  });
});
