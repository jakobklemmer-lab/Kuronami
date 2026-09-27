import { describe, expect, it } from "vitest";
import { leseAufgaben } from "./nachtbau.js";

describe("leseAufgaben", () => {
  it("liest Nummer, Titel und Status je Aufgabe aus dem Plan", () => {
    const plan = [
      "# Plan",
      "## N1 · Quelltreue: Ersatzregeln widerlegen kein Original",
      "- Status: erledigt (2026-09-27)",
      "Text mit N9 · keine Überschrift",
      "## N2 · Archiv für Strategien",
      "- Status: offen",
      "## Anhang",
      "## N3 · Ohne Statuszeile",
    ].join("\n");
    expect(leseAufgaben(plan)).toEqual([
      {
        id: "N1",
        titel: "Quelltreue: Ersatzregeln widerlegen kein Original",
        status: "erledigt (2026-09-27)",
      },
      { id: "N2", titel: "Archiv für Strategien", status: "offen" },
      { id: "N3", titel: "Ohne Statuszeile", status: "offen" },
    ]);
  });
});
