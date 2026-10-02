import { describe, expect, it } from "vitest";
import {
  euro,
  jeWoche,
  risikoEuro,
  wochenbeginn,
  wochenziel,
  wochenzielZeile,
} from "./wochenziel.js";

const BEISPIEL = { kapitalEuro: 1500, risikoProzent: 1, zielEuro: 100 };

describe("das Wochenziel", () => {
  it("hat neutrale Vorgaben, liest die Umgebung und lässt Unsinn dort liegen", () => {
    expect(wochenziel({})).toEqual({ kapitalEuro: 1000, risikoProzent: 1, zielEuro: 50 });
    expect(wochenziel({ KURO_KAPITAL_EURO: "2000", KURO_RISIKO_PROZENT: "0,5" })).toMatchObject({
      kapitalEuro: 2000,
      risikoProzent: 0.5,
    });
    expect(wochenziel({ KURO_WOCHENZIEL_EURO: "-3" }).zielEuro).toBe(50);
    expect(risikoEuro(BEISPIEL)).toBe(15);
  });

  it("rechnet Häufigkeit mal Erwartungswert mal ein R in Euro", () => {
    // 52 Handel in 52 Wochen, +0,2 R je Handel, 15 € je R → 3 € je Woche.
    const w = jeWoche(52, "2025-01-06", "2026-01-05", 0.2, BEISPIEL);
    expect(w?.handelJeWoche).toBeCloseTo(1, 5);
    expect(w?.euroJeWoche).toBeCloseTo(3, 5);
    expect(jeWoche(0, "2025-01-06", "2026-01-05", 0.2, BEISPIEL)).toBeNull();
    expect(jeWoche(3, "2026-01-05", "2026-01-07", 0.2, BEISPIEL)).toBeNull();
  });

  it("schreibt die Zeile für den Bericht — mit dem Ziel daneben, nicht als Vorgabe", () => {
    const zeile = wochenzielZeile(
      { anzahl: 52, erwartungswertR: 0.2, von: "2025-01-06", bis: "2026-01-05" },
      { anzahl: 10, erwartungswertR: -0.1, von: "2025-10-06", bis: "2026-01-05" },
      BEISPIEL,
    );
    expect(zeile).toContain("1,00 Handel je Woche × +0,20 R × 15,00 € Risiko (1 % von 1.500,00 €)");
    expect(zeile).toContain("= +3,00 € je Woche erwartet");
    expect(zeile).toContain("Jakobs Ziel 100,00 €; im ungesehenen Teil −");
    expect(wochenzielZeile({ anzahl: 0, erwartungswertR: 0, von: "a", bis: "b" }, null)).toBe("");
  });

  it("beginnt die Woche am Montag in Wien", () => {
    // Sonntag, 27.09.2026, 23:30 Wien = 21:30 UTC — noch dieselbe Woche.
    expect(wochenbeginn(new Date("2026-09-27T21:30:00Z"))).toBe("2026-09-21");
    // Montag, 28.09.2026, 00:30 Wien = Sonntag 22:30 UTC — schon die neue.
    expect(wochenbeginn(new Date("2026-09-27T22:30:00Z"))).toBe("2026-09-28");
  });

  it("schreibt Euro mit Komma und echtem Minus", () => {
    expect(euro(-6)).toBe("−6,00 €");
    expect(euro(6, true)).toBe("+6,00 €");
  });
});
