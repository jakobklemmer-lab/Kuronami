import { describe, expect, it } from "vitest";
import type { Strategie } from "./backtest.js";
import type { MarketCandle } from "./integrations/markets.js";
import { rechneSchlussprobe } from "./schlussprobe.js";

/**
 * Eine Sägezahnreihe mit zehn Kerzen Periode: nach jedem Tiefpunkt steigt der Kurs. Kauft die
 * Regel beim Kreuzen der SMA 3, trifft sie verlässlich ihr Ziel — so steht vorher fest, was
 * herauskommt.
 */
const TAG = 86_400;
const START = Math.floor(Date.parse("2024-01-01T00:00:00Z") / 1000);

function saege(anzahl: number): MarketCandle[] {
  return Array.from({ length: anzahl }, (_, i) => {
    const phase = i % 10;
    const close = phase < 5 ? 100 - phase * 2 : 90 + (phase - 5) * 4;
    const open = i === 0 ? close : phase === 0 ? 106 : phase < 5 ? close + 2 : close - 4;
    return {
      time: START + i * TAG,
      open,
      high: Math.max(open, close) + 0.5,
      low: Math.min(open, close) - 0.5,
      close,
    };
  });
}

const REGEL: Strategie = {
  name: "Test",
  richtung: "long",
  einstieg: [
    { links: { art: "kurs" }, vergleich: "kreuzt_ueber", rechts: { art: "sma", periode: 3 } },
  ],
  stopProzent: 5,
  zielProzent: 3,
  gebuehrProzent: 0,
  schlupfProzent: 0,
};

describe("Schlussprobe", () => {
  const kerzen = saege(1000);
  const mitte = kerzen[500].time;

  it("zählt nur Handel ab dem Beginn der Sperre", () => {
    const ganz = rechneSchlussprobe(REGEL, [{ symbol: "x", kerzen }], START, 0.5, "1d");
    const halb = rechneSchlussprobe(REGEL, [{ symbol: "x", kerzen }], mitte, 0.5, "1d");
    expect(halb.anzahl).toBeGreaterThan(0);
    expect(halb.anzahl).toBeLessThan(ganz.anzahl);
    expect(halb.von).toBe(new Date(mitte * 1000).toISOString().slice(0, 10));
  });

  it("besteht, wenn genug übrig bleibt", () => {
    const v = rechneSchlussprobe(REGEL, [{ symbol: "x", kerzen }], mitte, 0.1, "1d");
    expect(v.anzahl).toBeGreaterThanOrEqual(30);
    expect(v.erwartungswertR).toBeGreaterThan(0.05);
    expect(v.urteil).toBe("bestanden");
  });

  it("fällt durch, wenn weniger als die Hälfte des Versprochenen übrig bleibt", () => {
    const v = rechneSchlussprobe(REGEL, [{ symbol: "x", kerzen }], mitte, 10, "1d");
    expect(v.urteil).toBe("nicht bestanden");
  });

  it("urteilt unter 30 Handeln nicht", () => {
    const spaet = kerzen[kerzen.length - 60].time;
    const v = rechneSchlussprobe(REGEL, [{ symbol: "x", kerzen }], spaet, 0.1, "1d");
    expect(v.anzahl).toBeLessThan(30);
    expect(v.urteil).toBe("zu wenig Handel");
  });
});
