import { describe, expect, it } from "vitest";
import { CACHE_READ_FACTOR, CACHE_WRITE_FACTOR, MODEL_PRICES, costOf, priceOf } from "./pricing.js";

const USAGE = {
  inputTokens: 1_000_000,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

describe("priceOf", () => {
  it("kennt die aktuellen Modelle", () => {
    expect(priceOf("claude-opus-5")).toEqual({
      input: 5,
      output: 25,
      cacheRead: 5 * CACHE_READ_FACTOR,
      cacheWrite: 5 * CACHE_WRITE_FACTOR,
    });
    expect(priceOf("claude-sonnet-5")?.input).toBe(2);
    expect(priceOf("claude-haiku-4-5")?.input).toBe(1);
  });

  it("liefert null fuer ein unbekanntes Modell statt einer geratenen Zahl", () => {
    expect(priceOf("gpt-irgendwas")).toBeNull();
    expect(priceOf("")).toBeNull();
  });

  it("findet ein Modell auch mit Anbieter-Praefix (Bedrock)", () => {
    expect(priceOf("anthropic.claude-opus-5")).toEqual(priceOf("claude-opus-5"));
  });

  it("findet ein Modell auch in datierter Fassung", () => {
    expect(priceOf("claude-opus-5-20260401")).toEqual(priceOf("claude-opus-5"));
    expect(priceOf("claude-opus-4-5@20251101")).toBeNull();
  });

  it("leitet beide Cache-Preise aus dem Eingabepreis ab", () => {
    for (const rates of Object.values(MODEL_PRICES)) {
      expect(rates.cacheRead).toBeCloseTo(rates.input * CACHE_READ_FACTOR, 10);
      expect(rates.cacheWrite).toBeCloseTo(rates.input * CACHE_WRITE_FACTOR, 10);
    }
  });
});

describe("costOf", () => {
  it("rechnet eine Million Eingabe-Token zum Listenpreis ab", () => {
    expect(costOf("claude-opus-5", USAGE)).toBeCloseTo(5, 10);
    expect(costOf("claude-sonnet-5", USAGE)).toBeCloseTo(2, 10);
  });

  it("rechnet Ausgabe teurer ab als Eingabe", () => {
    const output = costOf("claude-opus-5", { ...USAGE, inputTokens: 0, outputTokens: 1_000_000 });
    expect(output).toBeCloseTo(25, 10);
  });

  it("rechnet Cache-Lesen billiger und Cache-Schreiben teurer als Eingabe", () => {
    const read = costOf("claude-opus-5", {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 0,
    }) as number;
    const write = costOf("claude-opus-5", {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 1_000_000,
    }) as number;
    expect(read).toBeCloseTo(0.5, 10);
    expect(write).toBeCloseTo(6.25, 10);
    expect(read).toBeLessThan(5);
    expect(write).toBeGreaterThan(5);
  });

  it("summiert alle vier Token-Arten", () => {
    const cost = costOf("claude-haiku-4-5", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
    }) as number;
    expect(cost).toBeCloseTo(1 + 5 + 0.1 + 1.25, 10);
  });

  it("liefert null fuer ein unbekanntes Modell statt 0", () => {
    expect(costOf("unbekannt", USAGE)).toBeNull();
  });

  it("kostet nichts bei null Token", () => {
    expect(
      costOf("claude-opus-5", {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }),
    ).toBe(0);
  });
});
