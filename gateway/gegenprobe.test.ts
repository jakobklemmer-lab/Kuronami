import { describe, expect, it } from "vitest";
import {
  MINDEST_BEHALTEN,
  type VarianteErgebnis,
  formatiereGegenprobe,
  urteile,
} from "./gegenprobe.js";

/**
 * Der Anlass für diese Tests ist ein Befund aus dem Betrieb, 2026-09-21: der prüfer des
 * Handelstischs rechnete die Swing-Strategie „Bollinger-Dip SMA200 long" an drei blind
 * gewählten Märkten nach, sah +0,03 / +0,04 / +0,01 R gegen +0,19 R am Heimatmarkt — und
 * bekam vom Werkzeug **„robust"** zurück, weil drei von drei Vorzeichen stimmten. Er hat es
 * im Text selbst geradegerückt („schau auf die Größe"). Genau das soll die Rechnung tun,
 * nicht der Agent.
 */

function ergebnis(teil: Partial<VarianteErgebnis> = {}): VarianteErgebnis {
  return {
    name: "Original",
    symbol: "^GSPC",
    anzahl: 50,
    erwartungswertR: 0.19,
    trefferquote: 0.49,
    sharpe: 0.33,
    gesamtProzent: 20.9,
    warnungen: 0,
    ...teil,
  };
}

describe("urteile", () => {
  it("nennt eine zusammengeschrumpfte Kante nicht mehr robust", () => {
    const reihe = [
      ergebnis(),
      ergebnis({ name: "Original", symbol: "^DJI", anzahl: 46, erwartungswertR: 0.03 }),
      ergebnis({ name: "Original", symbol: "^FTSE", anzahl: 39, erwartungswertR: 0.04 }),
      ergebnis({ name: "Original", symbol: "EURUSD=X", anzahl: 17, erwartungswertR: 0.01 }),
    ];
    // Nach der alten Regel wäre das 4 von 4 und damit „robust".
    expect(reihe.every((e) => e.erwartungswertR > 0)).toBe(true);

    const urteil = urteile(reihe, reihe[0].erwartungswertR);
    expect(urteil.tragfaehig).toBe(1);
    expect(urteil.gepruefte).toBe(4);
    expect(urteil.einstufung).toBe("fragil");
    expect(urteil.behaltenMedian).toBeLessThan(0.3);
  });

  it("lässt echte Schwankung durch — geprüft wird Verschwinden, nicht Streuung", () => {
    const reihe = [
      ergebnis(),
      ergebnis({ name: "Perioden −20 %", erwartungswertR: 0.2 }),
      ergebnis({ name: "Perioden +20 %", erwartungswertR: 0.26 }),
      ergebnis({ name: "Kosten verdoppelt", erwartungswertR: 0.12 }),
    ];
    const urteil = urteile(reihe, reihe[0].erwartungswertR);
    expect(urteil.tragfaehig).toBe(4);
    expect(urteil.einstufung).toBe("robust");
  });

  it("zählt eine Variante genau an der Schwelle noch mit", () => {
    const reihe = [ergebnis({ erwartungswertR: 0.2 }), ergebnis({ erwartungswertR: 0.1 })];
    expect(MINDEST_BEHALTEN).toBe(0.5);
    expect(urteile(reihe, 0.2).tragfaehig).toBe(2);
    expect(urteile([reihe[0], ergebnis({ erwartungswertR: 0.099 })], 0.2).tragfaehig).toBe(1);
  });

  it("prüft nur das Vorzeichen, wenn das Original selbst nichts abwirft", () => {
    // Ein Anteil von einem Erwartungswert ≤ 0 wäre eine Zahl ohne Bedeutung — dann bleibt es
    // bei der alten, schwächeren Aussage, und das Feld fehlt, statt etwas zu behaupten.
    const reihe = [ergebnis({ erwartungswertR: -0.1 }), ergebnis({ erwartungswertR: 0.05 })];
    const urteil = urteile(reihe, reihe[0].erwartungswertR);
    expect(urteil.referenzR).toBeUndefined();
    expect(urteil.behaltenMedian).toBeUndefined();
    expect(urteil.tragfaehig).toBe(1);
  });

  it("misst nicht gegen ein Original, das selbst fast nichts abwirft", () => {
    // **Im ersten Lauf mit dieser Spalte sofort aufgefallen:** bei einem Original von 0,01 R
    // standen dort 1864 % und −1048 %. Richtig gerechnet, inhaltlich nichts — ein Anteil von
    // fast null misst die Rundung des Kostenmodells. Dann lieber die schwächere Aussage.
    const reihe = [
      ergebnis({ erwartungswertR: 0.01 }),
      ergebnis({ symbol: "ETH-USD", erwartungswertR: 0.24 }),
      ergebnis({ symbol: "CL=F", erwartungswertR: -0.11 }),
    ];
    const urteil = urteile(reihe, reihe[0].erwartungswertR);
    expect(urteil.referenzR).toBeUndefined();
    expect(urteil.behaltenMedian).toBeUndefined();
    expect(urteil.tragfaehig).toBe(2);
    const text = formatiereGegenprobe("Test", reihe, urteil);
    expect(text).not.toContain("%%");
    expect(text).toContain("nur das Vorzeichen");
  });

  it("lässt Varianten unter zehn Handeln ganz aus der Rechnung", () => {
    const reihe = [ergebnis(), ergebnis({ anzahl: 9, erwartungswertR: 5 })];
    expect(urteile(reihe, reihe[0].erwartungswertR).gepruefte).toBe(1);
  });
});

describe("formatiereGegenprobe", () => {
  it("schreibt hin, wie viel von der Kante übrig bleibt", () => {
    const reihe = [ergebnis(), ergebnis({ symbol: "^DJI", anzahl: 46, erwartungswertR: 0.03 })];
    const text = formatiereGegenprobe("Test", reihe, urteile(reihe, reihe[0].erwartungswertR));
    expect(text).toContain("behält");
    expect(text).toContain("16 %");
    // Eine von zwei zählbaren Varianten trägt — das ist „wackelig", nicht „robust".
    expect(text).toContain("wackelig");
  });

  it("verschweigt die Spalte nicht, wenn es keine Referenz gibt", () => {
    const reihe = [ergebnis({ erwartungswertR: -0.1 })];
    const text = formatiereGegenprobe("Test", reihe, urteile(reihe, -0.1));
    expect(text).toContain("behält");
    expect(text).toContain("—");
  });
});
