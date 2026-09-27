import { describe, expect, it } from "vitest";
import { BEDIENSTETE, HANDELSTISCH } from "./bedienstete.js";

// Am 27.09. hat der Handelstisch 22 selbst erfundene Regeln verworfen, aber nie die
// Strategien gerechnet, mit denen Jakob gelernt hat — die Agenten ersetzten fehlende
// Bausteine durch eigene Regeln und meldeten dann das Original als widerlegt. Diese Tests
// halten fest, dass boerse und stratege die Quelltreue-Regel im Prompt tragen.
describe("Quelltreue im Prompt von boerse und stratege", () => {
  const boerse = BEDIENSTETE.boerse.prompt;
  const stratege = HANDELSTISCH.stratege.prompt;

  it.each([
    ["boerse", () => boerse],
    ["stratege", () => stratege],
  ])("%s setzt eine Quellregel wörtlich um, nicht sinngemäß", (_name, prompt) => {
    expect(prompt()).toMatch(/wörtlich/);
  });

  it.each([
    ["boerse", () => boerse],
    ["stratege", () => stratege],
  ])("%s nennt einen fehlenden Baustein 'nicht prüfbar', nie 'verworfen'", (_name, prompt) => {
    expect(prompt()).toMatch(/nicht prüfbar — Baustein\s+fehlt: X/);
  });

  it.each([
    ["boerse", () => boerse],
    ["stratege", () => stratege],
  ])(
    "%s nennt eine Näherung 'Ersatzregel für ...' und trennt sie vom Original",
    (_name, prompt) => {
      expect(prompt()).toContain("Ersatzregel für");
      expect(prompt()).toMatch(/sagt nichts über das Original/);
    },
  );

  it.each([
    ["boerse", () => boerse],
    ["stratege", () => stratege],
  ])("%s nennt den fehlenden Baustein als Bauwunsch", (_name, prompt) => {
    expect(prompt()).toMatch(/Bauwunsch/);
  });

  it.each([
    ["boerse", () => boerse],
    ["stratege", () => stratege],
  ])("%s zeigt den Ton an einem richtig/falsch-Beispiel, nicht an Adjektiven", (_name, prompt) => {
    expect(prompt()).toMatch(/Falsch: „/);
    expect(prompt()).toMatch(/Richtig: „/);
  });
});
