import { describe, expect, it } from "vitest";
import {
  describeQuoteType,
  formatChange,
  formatPercent,
  formatPrice,
  priceDigits,
} from "./format.js";

describe("priceDigits", () => {
  it("staffelt nach Größenordnung", () => {
    expect(priceDigits(18234.12)).toBe(2);
    expect(priceDigits(227.48)).toBe(2);
    expect(priceDigits(1.0842)).toBe(3);
    expect(priceDigits(0.0842)).toBe(4);
    expect(priceDigits(0.00042)).toBe(6);
  });
});

describe("formatPrice/formatChange/formatPercent", () => {
  it("formatiert deutsch mit Währung", () => {
    expect(formatPrice(18234.125, "EUR")).toBe("18.234,13 EUR");
    expect(formatPrice(227.48)).toBe("227,48");
  });

  it("zeigt Vorzeichen mit echtem Minus", () => {
    expect(formatChange(1.23, 0.54, 227.48)).toBe("+1,23 (+0,54 %)");
    expect(formatChange(-1.23, -0.54, 227.48)).toBe("−1,23 (−0,54 %)");
    expect(formatChange(0.0012, 0.11, 1.0842)).toBe("+0,001 (+0,11 %)");
    expect(formatPercent(0)).toBe("+0,00 %");
  });
});

describe("describeQuoteType", () => {
  it("übersetzt bekannte Typen und glättet unbekannte", () => {
    expect(describeQuoteType("EQUITY")).toBe("Aktie");
    expect(describeQuoteType("CRYPTOCURRENCY")).toBe("Krypto");
    expect(describeQuoteType("WARRANT")).toBe("Warrant");
    expect(describeQuoteType("")).toBe("");
  });
});
