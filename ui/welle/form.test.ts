import { describe, expect, it } from "vitest";
import { gruss, kurslinie, kurzSymbol, strategieStand, wann, werName } from "./form.js";

describe("gruss", () => {
  it("richtet sich nach der Tageszeit", () => {
    expect(gruss(new Date(2026, 8, 26, 3))).toBe("Gute Nacht, Jakob.");
    expect(gruss(new Date(2026, 8, 26, 8))).toBe("Guten Morgen, Jakob.");
    expect(gruss(new Date(2026, 8, 26, 14))).toBe("Guten Tag, Jakob.");
    expect(gruss(new Date(2026, 8, 26, 21))).toBe("Guten Abend, Jakob.");
  });
});

describe("kurzSymbol", () => {
  it("lässt Vorsilben und Anhängsel der Börsenkürzel weg", () => {
    expect(kurzSymbol("^GDAXI")).toBe("GDAXI");
    expect(kurzSymbol("BTC-USD")).toBe("BTC");
    expect(kurzSymbol("EURUSD=X")).toBe("EURUSD");
    expect(kurzSymbol("AAPL")).toBe("AAPL");
  });
});

describe("kurslinie", () => {
  it("läuft von links nach rechts, oben ist hoch", () => {
    expect(kurslinie([1, 3], 10, 10, 0)).toBe("M0.0 10.0 L10.0 0.0");
  });

  it("legt eine flache Reihe in die Mitte", () => {
    expect(kurslinie([5, 5, 5], 10, 10, 0)).toBe("M0.0 5.0 L5.0 5.0 L10.0 5.0");
  });

  it("zeichnet aus weniger als zwei Werten nichts", () => {
    expect(kurslinie([4], 10, 10)).toBe("");
    expect(kurslinie([Number.NaN, 2], 10, 10)).toBe("");
  });
});

describe("wann", () => {
  const jetzt = new Date(2026, 8, 26, 18, 0);

  it("sagt heute und gestern mit Uhrzeit, sonst das Datum", () => {
    expect(wann(new Date(2026, 8, 26, 14, 5).toISOString(), jetzt)).toBe("heute, 14:05");
    expect(wann(new Date(2026, 8, 25, 9, 30).toISOString(), jetzt)).toBe("gestern, 09:30");
    expect(wann(new Date(2026, 8, 20, 9, 30).toISOString(), jetzt)).toBe("20. September");
  });

  it("gibt bei einem kaputten Zeitpunkt nichts aus", () => {
    expect(wann("kein Datum", jetzt)).toBe("");
  });
});

describe("werName", () => {
  it("nennt die Bediensteten beim Namen, mit Umlaut", () => {
    expect(werName("boerse")).toBe("Börse");
    expect(werName("pruefer")).toBe("Prüfer");
    expect(werName("neuling")).toBe("Neuling");
    expect(werName("")).toBe("");
  });
});

describe("strategieStand", () => {
  it("übersetzt die Kennungen des Gateways", () => {
    expect(strategieStand("geprueft")).toBe("geprüft");
    expect(strategieStand("irgendwas")).toBe("irgendwas");
  });
});
