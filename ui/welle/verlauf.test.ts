import { describe, expect, it } from "vitest";
import {
  HOECHSTENS,
  type Umgebung,
  type Verlauf,
  abgeschlossen,
  antwort,
  beantwortet,
  frage,
  gleicheFragenAb,
  lade,
  laeuft,
  leer,
  letzteAntwort,
  nachtrag,
  scheitert,
  speichere,
  stueck,
  tafel,
  tafelnWeg,
  wartetAufJakob,
  zugBeginnt,
  zugEndet,
} from "./verlauf.js";

function umgebung(): Umgebung {
  let n = 0;
  return { jetzt: 1000, id: () => `e${n++}` };
}

const texte = (v: Verlauf) => v.eintraege.map((e) => `${e.von}:${e.text}:${e.stand}`);

describe("ein eigener Zug", () => {
  it("führt Stücke aus dem Strom und die Rückgabe des Aufrufs in einem Eintrag zusammen", () => {
    const u = umgebung();
    let v = frage(leer(), "Wie steht der DAX?", u);
    expect(texte(v)).toEqual(["jakob:Wie steht der DAX?:fertig", "kuro::wartet"]);
    expect(laeuft(v)).toBe(true);

    v = zugBeginnt(v, "zug-1", u);
    v = stueck(v, "zug-1", "Der DAX ", u);
    v = stueck(v, "zug-1", "steht bei 25.408.", u);
    expect(texte(v)).toEqual([
      "jakob:Wie steht der DAX?:fertig",
      "kuro:Der DAX steht bei 25.408.:laeuft",
    ]);

    v = zugEndet(v, "zug-1", "Der DAX steht bei 25.408.\n\nPlus 0,6 %.", u);
    v = antwort(v, "Der DAX steht bei 25.408.\n\nPlus 0,6 %.", u);
    expect(v.eintraege).toHaveLength(2);
    expect(v.eintraege[1].stand).toBe("fertig");
    expect(laeuft(v)).toBe(false);
  });

  it("nimmt die Rückgabe, wenn aus dem Strom nichts kam", () => {
    const u = umgebung();
    let v = frage(leer(), "Hallo", u);
    v = antwort(v, "Guten Abend.", u);
    expect(texte(v)).toEqual(["jakob:Hallo:fertig", "kuro:Guten Abend.:fertig"]);
  });

  it("lässt einen wortlosen, leeren Eintrag nach dem Aufruf verschwinden", () => {
    const u = umgebung();
    const v = abgeschlossen(frage(leer(), "Hallo", u));
    expect(texte(v)).toEqual(["jakob:Hallo:fertig"]);
  });

  it("schreibt den Fehler wörtlich an die Stelle der Antwort", () => {
    const u = umgebung();
    let v = frage(leer(), "Hallo", u);
    v = scheitert(v, "http://localhost:3000/channels/web/messages nicht erreichbar", u);
    expect(v.eintraege[1]).toMatchObject({
      stand: "fehler",
      text: "http://localhost:3000/channels/web/messages nicht erreichbar",
    });
  });
});

describe("fremde Züge", () => {
  it("bekommen einen eigenen Eintrag, auch ohne Frage davor", () => {
    const u = umgebung();
    let v = stueck(leer(), "zug-9", "Gesprochen beantwortet.", u);
    v = zugEndet(v, "zug-9", "Gesprochen beantwortet.", u);
    expect(texte(v)).toEqual(["kuro:Gesprochen beantwortet.:fertig"]);
  });

  it("trennen zwei Züge sauber, statt sie aneinanderzuhängen", () => {
    const u = umgebung();
    let v = stueck(leer(), "a", "Erste.", u);
    v = stueck(v, "b", "Zweite.", u);
    expect(texte(v)).toEqual(["kuro:Erste.:laeuft", "kuro:Zweite.:laeuft"]);
  });

  it("zeigt einen Nachtrag nur, wenn er nicht schon dasteht", () => {
    const u = umgebung();
    let v = zugEndet(leer(), "a", "Fertig.", u);
    v = nachtrag(v, "Fertig.", u);
    v = nachtrag(v, "  ", u);
    expect(v.eintraege).toHaveLength(1);
    v = nachtrag(v, "Der Handelstisch ist fertig.", u);
    expect(v.eintraege).toHaveLength(2);
  });
});

describe("Tafeln", () => {
  it("hängen an der Antwort, die gerade entsteht, und doppeln nicht", () => {
    const u = umgebung();
    let v = frage(leer(), "Märkte?", u);
    v = tafel(v, "kurse", u);
    v = tafel(v, "kurse", u);
    expect(v.eintraege[1].tafeln).toEqual(["kurse"]);
    v = tafelnWeg(v);
    expect(v.eintraege[1].tafeln).toEqual([]);
  });

  it("hängen nach einer neuen Frage nicht mehr an der alten Antwort", () => {
    const u = umgebung();
    let v = antwort(frage(leer(), "a", u), "A", u);
    v = frage(v, "b", u);
    v = abgeschlossen(v);
    v = tafel(v, "wetter", u);
    expect(v.eintraege[1].tafeln).toEqual([]);
    expect(v.eintraege.at(-1)?.tafeln).toEqual(["wetter"]);
  });
});

describe("Rückfragen", () => {
  const offen = {
    askId: "ask-1",
    question: "Soll ich die Order aufgeben?",
    options: [
      { id: "ja", label: "Ja" },
      { id: "nein", label: "Nein" },
    ],
    channel: "web",
  };

  it("stehen an der laufenden Antwort und warten auf Jakob", () => {
    const u = umgebung();
    let v = frage(leer(), "Kauf BTC", u);
    v = gleicheFragenAb(v, [offen], u);
    expect(v.eintraege[1].rueckfrage?.frage).toBe("Soll ich die Order aufgeben?");
    expect(wartetAufJakob(v)).toBe(true);
    v = gleicheFragenAb(v, [offen], u);
    expect(v.eintraege).toHaveLength(2);
    v = beantwortet(v, "ask-1", "Ja");
    expect(wartetAufJakob(v)).toBe(false);
  });

  it("werden als anderswo beantwortet vermerkt, wenn sie verschwinden", () => {
    const u = umgebung();
    let v = gleicheFragenAb(leer(), [offen], u);
    v = gleicheFragenAb(v, [], u);
    expect(v.eintraege[0].rueckfrage?.antwort).toBe("anderswo");
  });
});

describe("Aufbewahren", () => {
  it("übersteht ein Neuladen, laufende Einträge gelten danach als fertig", () => {
    const u = umgebung();
    let v = frage(leer(), "Hallo", u);
    v = stueck(v, "z", "Halb", u);
    const zurueck = lade(speichere(v));
    expect(texte(zurueck)).toEqual(["jakob:Hallo:fertig", "kuro:Halb:fertig"]);
    // Kommt für den Zug noch etwas, läuft er weiter.
    expect(stueck(zurueck, "z", " fertig", u).eintraege[1].text).toBe("Halb fertig");
  });

  it("öffnet auch mit kaputtem oder fremdem Speicherinhalt", () => {
    expect(lade("{kaputt")).toEqual(leer());
    expect(lade(JSON.stringify({ fassung: 7, eintraege: [] }))).toEqual(leer());
    expect(lade(null)).toEqual(leer());
  });

  it("behält höchstens die letzten Einträge", () => {
    const u = umgebung();
    let v = leer();
    for (let i = 0; i < HOECHSTENS; i++) v = antwort(frage(v, `f${i}`, u), `a${i}`, u);
    expect(v.eintraege).toHaveLength(HOECHSTENS);
    expect(letzteAntwort(v)?.text).toBe(`a${HOECHSTENS - 1}`);
  });
});
