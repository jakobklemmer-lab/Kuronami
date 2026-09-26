import { describe, expect, it } from "vitest";
import { abstand, dauer, lage, modellName, token } from "./system.js";

/**
 * Die Formen der System-Seite. Sie entscheiden, ob eine Zahl als Warnung gelesen wird — „knapp"
 * darf nicht nur in der Farbe stehen, und ein Modell soll so heißen, wie Jakob es kennt.
 */

describe("System-Seite", () => {
  it("nennt Modelle beim Namen, egal ob Kennung oder Kurzname", () => {
    expect(modellName("claude-sonnet-5")).toBe("Sonnet 5");
    expect(modellName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(modellName("opus")).toBe("Opus");
    expect(modellName("(geerbt)")).toBe("(geerbt)");
  });

  it("schreibt Token aus und kürzt erst ab einer Million", () => {
    expect(token(18_400)).toBe("18.400");
    // Intl setzt ein geschütztes Leerzeichen zwischen Zahl und Einheit.
    expect(token(2_350_000).replace(/\s/g, " ")).toBe("2,4 Mio.");
  });

  it("sagt die Lage in Worten, nicht nur in Farbe", () => {
    expect(lage(30)).toEqual({ klasse: "", wort: "" });
    expect(lage(30, true).wort).toBe("wird knapp");
    expect(lage(82).klasse).toBe("meter--knapp");
    expect(lage(97)).toEqual({ klasse: "meter--kritisch", wort: "fast erschöpft" });
  });

  it("rechnet Abstände und Dauern lesbar", () => {
    const jetzt = new Date("2026-09-26T20:39:00Z");
    expect(abstand(jetzt, new Date("2026-09-27T01:20:00Z"))).toBe("4 Std. 41 Min.");
    expect(abstand(jetzt, new Date("2026-10-02T10:00:00Z"))).toBe("6 Tagen");
    expect(dauer(4_200)).toBe("4,2 s");
    expect(dauer(72_000)).toBe("1 Min. 12 s");
  });
});
