import { describe, expect, it } from "vitest";
import type { Abschnitt, Kennzahlen } from "./backtest.js";
import { konfidenz } from "./konfidenz.js";
import { type UniversumVermerk, bewerte } from "./strategien.js";

function kennzahlen(teil: Partial<Kennzahlen> = {}): Kennzahlen {
  return {
    anzahl: 60,
    trefferquote: 0.45,
    durchschnittR: 0.3,
    erwartungswertR: 0.3,
    profitFaktor: 1.5,
    gesamtrenditeProzent: 30,
    maxDrawdownProzent: 10,
    sharpe: 1.4,
    sortino: 1.8,
    durchschnittGewinnR: 1.6,
    durchschnittVerlustR: -0.8,
    groessterGewinnR: 3,
    groessterVerlustR: -1.2,
    laengsteVerlustserie: 4,
    durchschnittKerzen: 8,
    ...teil,
  };
}

function abschnitt(erwartungswertR: number, anzahl = 20): Abschnitt {
  return {
    von: "2020-01-01",
    bis: "2026-01-01",
    kennzahlen: kennzahlen({ erwartungswertR, anzahl }),
  };
}

/** R-Werte mit vorgegebenem Trefferanteil, gleichmäßig verteilt. */
function rWerte(anzahl: number, trefferAnteil: number, gewinn: number): number[] {
  return Array.from({ length: anzahl }, (_, i) =>
    Math.floor((i + 1) * trefferAnteil) > Math.floor(i * trefferAnteil) ? gewinn : -1,
  );
}

function vermerk(teil: Partial<UniversumVermerk> = {}): UniversumVermerk {
  return {
    einstufung: "uebertragbar",
    maerkte: 5,
    gesamtHandel: 150,
    gemeinsamErwartungswertR: 0.2,
    begruendung: "Testvermerk.",
    ...teil,
  };
}

describe("bewerte", () => {
  it("macht aus einer belegten Kante einen Kandidaten", () => {
    const belegt = konfidenz(rWerte(1200, 0.4, 2));
    expect(belegt).toBeDefined();
    expect(bewerte(kennzahlen({ konfidenz: belegt }), abschnitt(0.2), [])).toBe("kandidat");
  });

  it("lässt jede Einstufung zum Kandidaten werden — gekennzeichnet, nicht gesperrt", () => {
    // Jakobs Entscheidung vom 2026-09-21: „Es ist auch okay, wenn eine Strategie nur in einem
    // Produkt läuft, muss dann halt so gekennzeichnet sein." Die Übertragbarkeit beschreibt
    // die Regel, sie bewertet sie nicht — deshalb hängt der Status allein an den Kennzahlen.
    const belegt = konfidenz(rWerte(1200, 0.4, 2));
    for (const einstufung of ["uebertragbar", "gemischt", "einzelfall"] as const) {
      expect(
        bewerte(kennzahlen({ konfidenz: belegt }), abschnitt(0.2), [], vermerk({ einstufung })),
      ).toBe("kandidat");
    }
    // Ohne jeden Vermerk ändert sich ebenfalls nichts — dass er fehlt, zeigt die Ablage an,
    // sie bestraft es nicht.
    expect(bewerte(kennzahlen({ konfidenz: belegt }), abschnitt(0.2), [])).toBe("kandidat");
  });

  it("hält einen Einzelfall trotzdem zurück, wenn die Kennzahlen es verlangen", () => {
    const unbelegt = konfidenz(rWerte(30, 0.4, 2));
    expect(
      bewerte(
        kennzahlen({ anzahl: 35, konfidenz: unbelegt }),
        abschnitt(0.2),
        [],
        vermerk({ einstufung: "einzelfall" }),
      ),
    ).toBe("geprueft");
  });

  it("hält eine unbelegte Kante bei `geprueft` zurück, auch wenn sonst alles stimmt", () => {
    // **Der Kern der Änderung.** 35 Handel, +0,2 R Erwartungswert, Sharpe 1,4, keine
    // Vorbehalte — vorher wäre das ein `kandidat` gewesen und in den Papierhandel gegangen.
    // Das 95-%-Intervall schließt die Null ein: es ist keine Kante, sondern eine Stichprobe.
    const unbelegt = konfidenz(rWerte(35, 0.4, 2));
    expect(unbelegt).toBeDefined();
    expect(bewerte(kennzahlen({ anzahl: 35, konfidenz: unbelegt }), abschnitt(0.2), [])).toBe(
      "geprueft",
    );
  });

  it("bleibt bei den alten Regeln, wo sie schärfer sind", () => {
    const belegt = konfidenz(rWerte(1200, 0.4, 2));
    // Zu wenige Handel.
    expect(bewerte(kennzahlen({ anzahl: 12, konfidenz: belegt }), abschnitt(0.2), [])).toBe(
      "geprueft",
    );
    // Negativer Erwartungswert.
    expect(
      bewerte(kennzahlen({ erwartungswertR: -0.1, konfidenz: belegt }), abschnitt(0.2), []),
    ).toBe("verworfen");
    // Im ungesehenen Teil negativ.
    expect(bewerte(kennzahlen({ konfidenz: belegt }), abschnitt(-0.1), [])).toBe("verworfen");
    // Offener Vorbehalt.
    expect(bewerte(kennzahlen({ konfidenz: belegt }), abschnitt(0.2), ["irgendwas"])).toBe(
      "geprueft",
    );
    // Sharpe unter 1.
    expect(bewerte(kennzahlen({ sharpe: 0.8, konfidenz: belegt }), abschnitt(0.2), [])).toBe(
      "geprueft",
    );
  });

  it("wertet ohne Intervall wie bisher — es fehlt nur unter zehn Handeln", () => {
    expect(bewerte(kennzahlen(), abschnitt(0.2), [])).toBe("kandidat");
  });

  it("nennt eine Strategie ohne Handel einen Entwurf", () => {
    expect(bewerte(null, null, [])).toBe("entwurf");
    expect(bewerte(kennzahlen({ anzahl: 0 }), null, [])).toBe("entwurf");
  });
});
