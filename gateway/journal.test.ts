import { describe, expect, it } from "vitest";
import { BEDIENSTETE } from "../context/bedienstete.js";
import { istNotionId } from "./integrations/notion.js";
import {
  JOURNAL_IDS,
  JOURNAL_LESEN,
  JOURNAL_TOOLS,
  KAPITALREGELN,
  type TradeEintrag,
  eintragEigenschaften,
  passendeOption,
  regelverstoesse,
  watchlistKurz,
  zahlenFehler,
  zeileKurz,
} from "./journal.js";

/**
 * Was hier geprüft wird, ist nicht, ob ein Trade gut ist — das entscheidet der Handelstisch —,
 * sondern ob die Zeile stimmt, die im Journal landet. Eine verrutschte Spalte, ein Risiko um
 * den Faktor hundert daneben oder ein stillschweigend verschwiegener Regelverstoß fällt erst
 * in der Auswertung auf, und dann ist der Monat gelaufen.
 */

/** Eine offene Zeile, wie Notion sie zurückgibt: in „Risiko %“ stehen **Prozent**, nicht der
 *  Dezimalanteil — 1 heißt ein Prozent (Jakobs Vorgabe, 2026-09-21). */
function offeneZeile(risikoProzent: number): Record<string, unknown> {
  return { "Risiko %": { type: "number", number: risikoProzent } };
}

const TRADE: TradeEintrag = {
  instrument: "AAPL",
  richtung: "Long",
  entry: 227.5,
  stop: 220,
  ziel: 240,
  risikoProzent: 1,
};

describe("regelverstoesse", () => {
  it("lässt den regelkonformen Trade durch", () => {
    expect(regelverstoesse({ risikoProzent: 1 }, [])).toEqual([]);
    expect(regelverstoesse({ risikoProzent: 1 }, [offeneZeile(1), offeneZeile(1)])).toEqual([]);
  });

  it("erkennt zu viel Risiko im einzelnen Trade (Kapitalregel 1)", () => {
    const verstoesse = regelverstoesse({ risikoProzent: 1.5 }, []);
    expect(verstoesse).toHaveLength(1);
    expect(verstoesse[0]).toContain("Kapitalregel 1");
  });

  it("erkennt die vierte offene Position (Kapitalregel 2)", () => {
    const verstoesse = regelverstoesse({ risikoProzent: 0.5 }, [
      offeneZeile(0.5),
      offeneZeile(0.5),
      offeneZeile(0.5),
    ]);
    expect(verstoesse.some((v) => v.includes("Kapitalregel 2"))).toBe(true);
    expect(verstoesse.some((v) => v.includes("wären 4 Positionen"))).toBe(true);
  });

  it("rechnet das kumulierte Risiko aus den offenen Zeilen, nicht aus dem Gedächtnis (Kapitalregel 3)", () => {
    const verstoesse = regelverstoesse({ risikoProzent: 1 }, [offeneZeile(1), offeneZeile(1.5)]);
    expect(verstoesse.some((v) => v.includes("Kapitalregel 3"))).toBe(true);
    expect(verstoesse.some((v) => v.includes("3.50 %"))).toBe(true);
  });

  it("hält die Grenzen selbst für erlaubt — genau 1 % und genau 3 % sind kein Verstoß", () => {
    expect(regelverstoesse({ risikoProzent: 1 }, [offeneZeile(1), offeneZeile(1)])).toEqual([]);
    expect(KAPITALREGELN).toEqual({
      maxRisikoProzent: 1,
      maxOffenePositionen: 3,
      maxKumuliertesRisikoProzent: 3,
    });
  });

  it("behandelt einen Trade ohne Risikoangabe als 0 — die Lage der offenen Zeilen zählt trotzdem", () => {
    // Drei offene Positionen mit zusammen 3,6 %: die vierte ist eine zu viel, und das
    // kumulierte Risiko liegt schon ohne sie über der Grenze.
    const verstoesse = regelverstoesse({}, [offeneZeile(1.2), offeneZeile(1.2), offeneZeile(1.2)]);
    expect(verstoesse.map((v) => v.slice(-16))).toEqual(["Kapitalregel 2).", "Kapitalregel 3)."]);
  });
});

describe("zahlenFehler", () => {
  it("nimmt Long und Short, wenn Stop und Ziel auf der richtigen Seite liegen", () => {
    expect(zahlenFehler(TRADE)).toBeNull();
    expect(zahlenFehler({ richtung: "Short", entry: 100, stop: 105, ziel: 90 })).toBeNull();
  });

  it("weist den vertauschten Stop ab, statt die Zeile zu verderben", () => {
    expect(zahlenFehler({ ...TRADE, stop: 230 })).toMatch(/falschen Seite des Einstiegs/);
    expect(zahlenFehler({ richtung: "Short", entry: 100, stop: 95, ziel: 90 })).toMatch(
      /falschen Seite/,
    );
  });

  it("weist das Ziel auf der falschen Seite ab", () => {
    expect(zahlenFehler({ ...TRADE, ziel: 200 })).toMatch(/Ziel 200/);
    expect(zahlenFehler({ richtung: "Short", entry: 100, stop: 105, ziel: 110 })).toMatch(/Ziel/);
  });

  it("lässt Stop auf dem Einstieg nicht durch — das ist kein Trade, das ist ein Tippfehler", () => {
    expect(zahlenFehler({ ...TRADE, stop: 227.5 })).not.toBeNull();
  });
});

describe("eintragEigenschaften", () => {
  it("trifft die Spaltennamen der Trades-Datenbank auf das Zeichen", () => {
    const e = eintragEigenschaften(TRADE, [], "2026-09-21");
    expect(Object.keys(e).sort()).toEqual(
      [
        "Datum",
        "Entry-Preis",
        "Initialer Stop",
        "Instrument",
        "Plan befolgt?",
        "Richtung",
        "Risiko %",
        "Status",
        "Trade-Nr",
        "Ziel",
      ].sort(),
    );
    expect(e.Status).toEqual({ select: { name: "Offen" } });
    expect(e["Plan befolgt?"]).toEqual({ select: { name: "Ja" } });
    expect(e.Datum).toEqual({ date: { start: "2026-09-21" } });
  });

  it("schreibt Prozent als Prozent, nicht als Dezimalanteil", () => {
    // Jakobs Vorgabe vom 2026-09-21. Ein Anteil (0,01) sah in der Spalte als „0,01 %“ aus —
    // um den Faktor hundert daneben, und quer zu seinen vorhandenen Zeilen.
    expect(
      eintragEigenschaften({ ...TRADE, risikoProzent: 1 }, [], "2026-09-21")["Risiko %"],
    ).toEqual({ number: 1 });
    expect(
      eintragEigenschaften({ ...TRADE, risikoProzent: 0.75 }, [], "2026-09-21")["Risiko %"],
    ).toEqual({ number: 0.75 });
  });

  it("markiert den Regelverstoß, statt den Eintrag zu verhindern", () => {
    const e = eintragEigenschaften(TRADE, ["Risiko 1.50 % über der Grenze"], "2026-09-21");
    expect(e["Plan befolgt?"]).toEqual({ select: { name: "Nein" } });
    expect(JSON.stringify(e.Notizen)).toContain("Regelverstoß: Risiko 1.50 % über der Grenze");
  });

  it("hängt den Verstoß an die vorhandenen Notizen, statt sie zu überschreiben", () => {
    const e = eintragEigenschaften(
      { ...TRADE, notizen: "These: Ausbruch hält." },
      ["Vierte Position"],
      "2026-09-21",
    );
    const notiz = JSON.stringify(e.Notizen);
    expect(notiz).toContain("These: Ausbruch hält.");
    expect(notiz).toContain("Vierte Position");
  });

  it("nimmt Instrument und Datum als Nummer, wenn keine genannt ist", () => {
    expect(eintragEigenschaften(TRADE, [], "2026-09-21")["Trade-Nr"]).toEqual({
      title: [{ text: { content: "AAPL 2026-09-21" } }],
    });
    expect(
      eintragEigenschaften({ ...TRADE, tradeNr: "T-014" }, [], "2026-09-21")["Trade-Nr"],
    ).toEqual({ title: [{ text: { content: "T-014" } }] });
  });

  it("lässt weg, was nicht gesagt wurde — eine leere Spalte ist ehrlicher als eine geratene", () => {
    const e = eintragEigenschaften({ ...TRADE, risikoProzent: undefined }, [], "2026-09-21");
    expect(e).not.toHaveProperty("Risiko %");
    expect(e).not.toHaveProperty("Setup");
    expect(e).not.toHaveProperty("Timeframe");
    expect(e).not.toHaveProperty("Positionsgröße");
    expect(e).not.toHaveProperty("Tags");
    expect(e).not.toHaveProperty("Notizen");
  });

  it("schreibt die Wahlspalten, wenn sie genannt sind", () => {
    const e = eintragEigenschaften(
      {
        ...TRADE,
        setup: "Setup 1 Pullback EMA 20",
        timeframe: "Daily",
        positionsgroesse: 40,
        tags: ["Pullback"],
        emotionVorher: "ruhig",
      },
      [],
      "2026-09-21",
    );
    expect(e.Setup).toEqual({ select: { name: "Setup 1 Pullback EMA 20" } });
    expect(e.Timeframe).toEqual({ select: { name: "Daily" } });
    expect(e.Positionsgröße).toEqual({ number: 40 });
    expect(e.Tags).toEqual({ multi_select: [{ name: "Pullback" }] });
    expect(JSON.stringify(e["Emotion vorher"])).toContain("ruhig");
  });
});

describe("passendeOption", () => {
  const optionen = ["Setup 1 Pullback EMA 20", "Setup 2 Ausbruch"];

  it("nimmt den genauen Namen, auch anders geschrieben", () => {
    expect(passendeOption("Setup 1 Pullback EMA 20", optionen)).toBe("Setup 1 Pullback EMA 20");
    expect(passendeOption("setup 1 pullback ema 20", optionen)).toBe("Setup 1 Pullback EMA 20");
    expect(passendeOption("  Setup 2 Ausbruch ", optionen)).toBe("Setup 2 Ausbruch");
  });

  it("löst eine eindeutige Kurzform auf", () => {
    // Genau dieser Fall trat am 2026-09-21 auf: der Journalführer schrieb „Setup 1“, und
    // Notion legte daraufhin eine zweite Option an.
    expect(passendeOption("Setup 1", optionen)).toBe("Setup 1 Pullback EMA 20");
  });

  it("gibt bei mehreren Treffern nichts zurück, statt sich eins auszusuchen", () => {
    expect(passendeOption("Setup", optionen)).toBeNull();
  });

  it("erfindet nichts", () => {
    expect(passendeOption("Setup 3 Momentum", optionen)).toBeNull();
    expect(passendeOption("", optionen)).toBeNull();
    expect(passendeOption("Setup 1", [])).toBeNull();
  });
});

describe("Zeilen für den Bericht", () => {
  it("liest die offene Position zurück, Prozent unverändert als Prozent", () => {
    const zeile = zeileKurz({
      "Trade-Nr": { type: "title", title: [{ plain_text: "AAPL 2026-09-21" }] },
      Instrument: { type: "rich_text", rich_text: [{ plain_text: "AAPL" }] },
      Richtung: { type: "select", select: { name: "Long" } },
      "Entry-Preis": { type: "number", number: 227.5 },
      "Initialer Stop": { type: "number", number: 220 },
      Ziel: { type: "number", number: 240 },
      "Risiko %": { type: "number", number: 1 },
    });
    expect(zeile).toBe(
      "AAPL 2026-09-21  AAPL Long  Entry 227.5, Stop 220, Ziel 240, Risiko 1.00 %",
    );
  });

  it("verschweigt nicht, was in der Zeile fehlt", () => {
    expect(zeileKurz({})).toBe("(ohne Nummer)  ?   Entry ?, Stop ?, Ziel ?, Risiko —");
  });

  it("fasst eine Watchlist-Zeile zusammen", () => {
    const zeile = watchlistKurz({
      Instrument: { type: "title", title: [{ plain_text: "NVDA" }] },
      Grund: { type: "rich_text", rich_text: [{ plain_text: "Pullback erwartet" }] },
      "Support-Level": { type: "number", number: 150 },
      "Resistance-Level": { type: "number", number: 190 },
      "Setup-Trigger": { type: "select", select: { name: "Setup 1 Pullback EMA 20" } },
      Status: { type: "select", select: { name: "Aktiv" } },
    });
    expect(zeile).toBe(
      "NVDA [Aktiv]  Unterstützung 150 / Widerstand 190  Auslöser: Setup 1 Pullback EMA 20  — Pullback erwartet",
    );
  });
});

describe("Verdrahtung", () => {
  // Die echten Kennungen stehen nur in der .env (das Repo ist öffentlich); ohne sie bleibt eine
  // Kennung leer. Gesetzt muss sie die Form einer Notion-Kennung haben.
  it("hat für jede gesetzte Kennung die Form einer Notion-Kennung", () => {
    for (const [name, id] of Object.entries(JOURNAL_IDS)) {
      if (id) expect(istNotionId(id), `${name}: ${id}`).toBe(true);
    }
  });

  /**
   * Die Werkzeugnamen stehen zweimal: in `journal.ts` am Server und in `bedienstete.ts` als
   * Freigabeliste des Journalführers. Sie müssen zweimal stehen, weil `context/` nicht aus
   * `gateway/` importieren darf (siehe `layering.test.ts`) — aber sie müssen übereinstimmen,
   * sonst ist ein Werkzeug still nicht freigegeben, und der Lauf endet in einer Rückfrage,
   * die niemand beantwortet.
   */
  it("gibt dem Journalführer genau die Werkzeuge frei, die sein Server anbietet", () => {
    expect([...(BEDIENSTETE.journal.tools ?? [])].sort()).toEqual([...JOURNAL_TOOLS].sort());
  });

  it("lässt den Handelstisch nachsehen, aber nicht schreiben", () => {
    const boerse = BEDIENSTETE.boerse.tools ?? [];
    for (const werkzeug of JOURNAL_LESEN) expect(boerse).toContain(werkzeug);
    for (const werkzeug of JOURNAL_TOOLS.filter((t) => !JOURNAL_LESEN.includes(t))) {
      expect(boerse).not.toContain(werkzeug);
    }
  });

  it("hält das Journal aus den Läufen heraus, die es nichts angeht", () => {
    for (const name of ["korrespondenz", "werkstatt", "recherche"]) {
      const tools = BEDIENSTETE[name].tools ?? [];
      expect(tools.filter((t) => t.startsWith("mcp__journal__"))).toEqual([]);
    }
  });
});
