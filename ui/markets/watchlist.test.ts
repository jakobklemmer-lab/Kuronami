import { describe, expect, it } from "vitest";
import { MAX_WATCHLIST, addSymbol, hasSymbol, removeSymbol } from "./watchlist.js";

describe("addSymbol", () => {
  it("hängt groß geschrieben hinten an", () => {
    expect(addSymbol(["AAPL"], "btc-usd")).toEqual(["AAPL", "BTC-USD"]);
  });

  it("nimmt kein Symbol doppelt, auch nicht in anderer Schreibung", () => {
    expect(addSymbol(["AAPL"], "aapl")).toEqual(["AAPL"]);
  });

  it("ignoriert Leerzeichen und leere Eingaben", () => {
    expect(addSymbol([], "  ")).toEqual([]);
    expect(addSymbol([], " sap.de ")).toEqual(["SAP.DE"]);
  });

  it("hält die Obergrenze", () => {
    const full = Array.from({ length: MAX_WATCHLIST }, (_, i) => `S${i}`);
    expect(addSymbol(full, "NEU")).toHaveLength(MAX_WATCHLIST);
  });

  it("verändert die Eingabe nicht", () => {
    const list = ["AAPL"];
    addSymbol(list, "MSFT");
    expect(list).toEqual(["AAPL"]);
  });
});

describe("removeSymbol/hasSymbol", () => {
  it("entfernt unabhängig von der Schreibung", () => {
    expect(removeSymbol(["AAPL", "MSFT"], "msft")).toEqual(["AAPL"]);
    expect(hasSymbol(["AAPL"], "aapl")).toBe(true);
    expect(hasSymbol(["AAPL"], "MSFT")).toBe(false);
  });
});
