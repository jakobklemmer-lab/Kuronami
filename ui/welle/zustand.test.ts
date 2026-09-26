import { describe, expect, it } from "vitest";
import { type Lage, laufzeit, leiteZustandAb, werkzeugSatz } from "./zustand.js";

const ruhig: Lage = {
  unterwegs: false,
  zugLaeuft: false,
  letztesStueck: null,
  werkzeug: null,
  rueckfrage: false,
  fehlerBis: 0,
  offline: false,
  mikrofon: false,
};

describe("leiteZustandAb", () => {
  const jetzt = 100_000;

  it("ruht, wenn nichts läuft", () => {
    expect(leiteZustandAb(ruhig, jetzt)).toBe("ruhe");
  });

  it("denkt, solange ein Zug läuft, und arbeitet, sobald er ein Werkzeug hält", () => {
    expect(leiteZustandAb({ ...ruhig, unterwegs: true }, jetzt)).toBe("denken");
    expect(leiteZustandAb({ ...ruhig, zugLaeuft: true, werkzeug: "WebSearch" }, jetzt)).toBe(
      "arbeiten",
    );
  });

  it("spricht kurz nach jedem Wortstück und fällt danach zurück", () => {
    const lage = { ...ruhig, unterwegs: true, letztesStueck: jetzt - 300 };
    expect(leiteZustandAb(lage, jetzt)).toBe("sprechen");
    expect(leiteZustandAb(lage, jetzt + 2000)).toBe("denken");
  });

  it("lässt einen Fehler alles überstrahlen, bis seine Zeit um ist", () => {
    const lage = { ...ruhig, unterwegs: true, rueckfrage: true, fehlerBis: jetzt + 10 };
    expect(leiteZustandAb(lage, jetzt)).toBe("fehler");
    expect(leiteZustandAb(lage, jetzt + 20)).toBe("rueckfrage");
  });

  it("sagt offline nur, wenn nicht gerade ein eigener Zug unterwegs ist", () => {
    expect(leiteZustandAb({ ...ruhig, offline: true }, jetzt)).toBe("offline");
    expect(leiteZustandAb({ ...ruhig, offline: true, unterwegs: true }, jetzt)).toBe("denken");
  });

  it("hört zu, wenn das Mikrofon offen ist und sonst nichts läuft", () => {
    expect(leiteZustandAb({ ...ruhig, mikrofon: true }, jetzt)).toBe("zuhoeren");
  });
});

describe("werkzeugSatz", () => {
  it("kennt die eigenen Werkzeuge beim Namen", () => {
    expect(werkzeugSatz("WebSearch")).toBe("sucht im Netz");
  });

  it("macht aus einem unbekannten MCP-Werkzeug einen lesbaren Satz", () => {
    expect(werkzeugSatz("mcp__kurse__chart")).toBe("benutzt chart (kurse)");
    expect(werkzeugSatz("Bash")).toBe("benutzt Bash");
  });
});

describe("laufzeit", () => {
  it("sagt Sekunden, Minuten und Stunden", () => {
    expect(laufzeit(0, 42_000)).toBe("42 s");
    expect(laufzeit(0, 4 * 60_000)).toBe("4 min");
    expect(laufzeit(0, 125 * 60_000)).toBe("2 h 5 min");
  });
});
