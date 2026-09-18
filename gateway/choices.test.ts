import { describe, expect, it } from "vitest";
import { type Choice, matchChoice } from "./choices.js";

/**
 * Spiegel von `voice/pipeline/tests/test_choices.py` — Fall für Fall dieselben Eingaben und
 * dieselben Erwartungen. Weichen die beiden je auseinander, bedeutet „wichtiges" per Stimme
 * etwas anderes als per Tastatur; dieser Test ist der Riegel davor.
 */

const JA_NEIN: Choice[] = [
  { id: "genehmigen", label: "Genehmigen" },
  { id: "ablehnen", label: "Ablehnen" },
];

describe("matchChoice", () => {
  it("Kennung wörtlich", () => {
    expect(matchChoice("genehmigen", JA_NEIN)).toBe("genehmigen");
  });

  it("Beschriftung im Satz", () => {
    expect(matchChoice("Bitte ablehnen, das passt nicht.", JA_NEIN)).toBe("ablehnen");
  });

  it("Satzzeichen und Großschreibung stören nicht", () => {
    expect(matchChoice("Genehmigen!", JA_NEIN)).toBe("genehmigen");
  });

  it("„ja“ trifft die zustimmende Option", () => {
    expect(matchChoice("Ja, mach das.", JA_NEIN)).toBe("genehmigen");
  });

  it("„nein“ trifft die ablehnende Option", () => {
    expect(matchChoice("Nein, lieber nicht.", JA_NEIN)).toBe("ablehnen");
  });

  it("Ordnungszahl", () => {
    const options: Choice[] = [
      { id: "a", label: "Erste Möglichkeit" },
      { id: "b", label: "Zweite Möglichkeit" },
    ];
    expect(matchChoice("Nimm die zweite", options)).toBe("b");
  });

  it("Unverstandenes bleibt unverstanden", () => {
    expect(matchChoice("Hmm, schwierig", JA_NEIN)).toBeNull();
  });

  it("leere Eingabe trifft nichts", () => {
    expect(matchChoice("   ", JA_NEIN)).toBeNull();
  });

  it("ohne Optionen kein Treffer", () => {
    expect(matchChoice("ja", [])).toBeNull();
  });

  it("zwei zustimmende Optionen sind kein Treffer", () => {
    const options: Choice[] = [
      { id: "jetzt", label: "Jetzt genehmigen" },
      { id: "spaeter", label: "Später genehmigen" },
    ];
    expect(matchChoice("ja", options)).toBeNull();
  });

  it("Ablehnung gewinnt vor Zustimmung", () => {
    expect(matchChoice("Nein, nicht genehmigen", JA_NEIN)).toBe("ablehnen");
  });

  it("die Mail-Rückfrage vom 2026-09-16: Kennung getippt", () => {
    // Genau der Fall, an dem die Web-Unterhaltung stillstand.
    const options: Choice[] = [
      { id: "kandidaten", label: "Mails sichten und Löschkandidaten auflisten" },
      { id: "wichtiges", label: "Umgekehrt: nur zusammenfassen, was wirklich meine Aufmerksamkeit braucht" },
      { id: "beides", label: "Beides: Löschkandidaten plus Liste des Wichtigen" },
      { id: "abbrechen", label: "Nichts tun, abbrechen" },
    ];
    expect(matchChoice("wichtiges", options)).toBe("wichtiges");
    expect(matchChoice("Nimm bitte die zweite Option", options)).toBe("wichtiges");
    // „zusammenfassen" allein ist keine Kennung und keine ganze Beschriftung — kein Treffer,
    // also Nachfrage statt Raten. Die Strenge ist Absicht.
    expect(matchChoice("zusammenfassen", options)).toBeNull();
    // „abbrechen" ist Kennung **und** Verneinungswort: Weg 1 findet genau eine Option damit.
    expect(matchChoice("nein, abbrechen", options)).toBe("abbrechen");
  });
});
