import { describe, expect, it } from "vitest";
import { type Befehl, FRAGE_ID, normalisiere, rangiere, treffer } from "./befehle.js";

const BEFEHLE: Befehl[] = [
  { id: "mail", titel: "Post", art: "ort", stichworte: ["mail", "e-mail", "postfach"] },
  { id: "trading", titel: "Märkte", art: "ort", stichworte: ["trading", "kurse", "börse"] },
  { id: "strategien", titel: "Strategien", art: "ort", stichworte: ["backtest"] },
  { id: "mikro", titel: "Mikrofon an", art: "aktion", stichworte: ["sprechen", "zuhören"] },
];

describe("normalisiere", () => {
  it("lässt Umlaute, ß und Großschreibung nicht zählen", () => {
    expect(normalisiere("Märkte")).toBe("markte");
    expect(normalisiere(" Straße ")).toBe("strasse");
  });
});

describe("treffer", () => {
  it("zieht Anfang vor Wortanfang vor Teilwort vor Buchstabenfolge", () => {
    const anfang = treffer("Strategien", "stra");
    const wortanfang = treffer("Mikrofon an", "an");
    const teil = treffer("Strategien", "tegi");
    const folge = treffer("Strategien", "strtgn");
    expect(anfang).toBeGreaterThan(wortanfang);
    expect(wortanfang).toBeGreaterThan(teil);
    expect(teil).toBeGreaterThan(folge);
    expect(folge).toBeGreaterThan(0);
    expect(treffer("Post", "xyz")).toBe(0);
  });
});

describe("rangiere", () => {
  it("zeigt ohne Eingabe alles in seiner Reihenfolge", () => {
    expect(rangiere(BEFEHLE, "  ").map((b) => b.id)).toEqual([
      "mail",
      "trading",
      "strategien",
      "mikro",
    ]);
  });

  it("findet über Stichworte und Umlaute", () => {
    expect(rangiere(BEFEHLE, "markt")[0].id).toBe("trading");
    expect(rangiere(BEFEHLE, "börse")[0].id).toBe("trading");
    expect(rangiere(BEFEHLE, "mail")[0].id).toBe("mail");
  });

  it("bietet die Frage an Kuro immer an — vorn, wenn nichts gut passt", () => {
    const passend = rangiere(BEFEHLE, "post");
    expect(passend[0].id).toBe("mail");
    expect(passend.at(-1)?.id).toBe(FRAGE_ID);

    const satz = rangiere(BEFEHLE, "Wie steht der DAX heute?");
    expect(satz[0]).toMatchObject({ id: FRAGE_ID, titel: "Wie steht der DAX heute?" });
  });
});
