import { describe, expect, it } from "vitest";
import { gruppiereNachStatus, kurz } from "./strategien.js";

describe("Strategien-Liste", () => {
  it("teilt nach Status, Kandidaten zuerst, Verworfenes zuletzt, leere Gruppen fallen weg", () => {
    const koepfe = [
      { id: "a", status: "verworfen" as const },
      { id: "b", status: "geprueft" as const },
      { id: "c", status: "kandidat" as const },
      { id: "d", status: "geprueft" as const },
    ];
    expect(gruppiereNachStatus(koepfe).map((g) => [g.titel, g.eintraege.map((e) => e.id)])).toEqual(
      [
        ["Kandidaten", ["c"]],
        ["Geprüft", ["b", "d"]],
        ["Verworfen", ["a"]],
      ],
    );
  });

  it("nennt den Erwartungswert mit Vorzeichen und die Zahl der Handel, nie die Trefferquote allein", () => {
    const k = {
      anzahl: 126,
      trefferquote: 0.397,
      erwartungswertR: 0.0123,
      profitFaktor: 1.03,
      gesamtrenditeProzent: 15.1,
      maxDrawdownProzent: 23.4,
      sharpe: 0.17,
      sortino: 0.32,
      durchschnittGewinnR: 1.04,
      durchschnittVerlustR: -0.66,
      laengsteVerlustserie: 9,
    };
    expect(kurz(k)).toBe("+0,01 R je Handel · 126 Handel");
    expect(kurz(null)).toBe("ohne Prüfung");
  });
});
