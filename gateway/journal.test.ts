import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BEDIENSTETE } from "../context/bedienstete.js";
import { brainPfad, leseNotiz, schreibeNotiz, schreibeVerzeichnis } from "./brain.js";
import {
  type Felder,
  JOURNAL,
  JOURNAL_LESEN,
  JOURNAL_TOOLS,
  JOURNAL_VERZEICHNISSE,
  KAPITALREGELN,
  type TradeEintrag,
  dokumentierteSetups,
  ergebnisR,
  liesOrdner,
  passendeOption,
  regelverstoesse,
  tradeFelder,
  tradeInhalt,
  watchlistKurz,
  zahlenFehler,
  zeileKurz,
} from "./journal.js";

/** Eine offene Trade-Notiz, wie sie im Brain steht: `risiko_prozent` in Prozent (1 heißt ein Prozent). */
function offen(risikoProzent: number): Felder {
  return { status: "Offen", risiko_prozent: risikoProzent };
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
    expect(regelverstoesse({ risikoProzent: 1 }, [offen(1), offen(1)])).toEqual([]);
  });

  it("erkennt zu viel Risiko im einzelnen Trade (Kapitalregel 1)", () => {
    const verstoesse = regelverstoesse({ risikoProzent: 1.5 }, []);
    expect(verstoesse).toHaveLength(1);
    expect(verstoesse[0]).toContain("Kapitalregel 1");
  });

  it("erkennt die vierte offene Position (Kapitalregel 2)", () => {
    const verstoesse = regelverstoesse({ risikoProzent: 0.5 }, [
      offen(0.5),
      offen(0.5),
      offen(0.5),
    ]);
    expect(verstoesse.some((v) => v.includes("wären 4 Positionen"))).toBe(true);
  });

  it("rechnet das kumulierte Risiko aus den offenen Trades (Kapitalregel 3)", () => {
    const verstoesse = regelverstoesse({ risikoProzent: 1 }, [offen(1), offen(1.5)]);
    expect(verstoesse.some((v) => v.includes("3.50 %"))).toBe(true);
  });

  it("hält die Grenzen selbst für erlaubt", () => {
    expect(regelverstoesse({ risikoProzent: 1 }, [offen(1), offen(1)])).toEqual([]);
    expect(KAPITALREGELN).toEqual({
      maxRisikoProzent: 1,
      maxOffenePositionen: 3,
      maxKumuliertesRisikoProzent: 3,
    });
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

describe("passendeOption", () => {
  const optionen = ["Setup 1 Pullback EMA 20", "Setup 2 Ausbruch"];

  it("nimmt den genauen Namen, auch anders geschrieben", () => {
    expect(passendeOption("Setup 1 Pullback EMA 20", optionen)).toBe("Setup 1 Pullback EMA 20");
    expect(passendeOption("setup 1 pullback ema 20", optionen)).toBe("Setup 1 Pullback EMA 20");
    expect(passendeOption("  Setup 2 Ausbruch ", optionen)).toBe("Setup 2 Ausbruch");
  });

  it("löst eine eindeutige Kurzform auf", () => {
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

describe("Trade-Notiz", () => {
  it("schreibt die Eigenschaften, Prozent als Prozent, und den Verstoß in die Notiz", () => {
    const f = tradeFelder(
      { ...TRADE, setup: "Setup 1 Pullback EMA 20" },
      [],
      "2026-10-02",
      "a1b2c3d4",
    );
    expect(f).toMatchObject({
      art: "trade",
      id: "a1b2c3d4",
      nr: "AAPL 2026-10-02",
      richtung: "Long",
      status: "Offen",
      plan_befolgt: "Ja",
      risiko_prozent: 1,
    });
    expect(tradeFelder(TRADE, ["Kapitalregel 1"], "2026-10-02", "x").plan_befolgt).toBe("Nein");
    expect(tradeInhalt(TRADE, ["Risiko zu hoch"])).toContain("## Regelverstöße\n- Risiko zu hoch");
    // Zurückgelesen bleibt alles, wie es war.
    const { felder } = leseNotiz(schreibeNotiz(f, tradeInhalt(TRADE, [])));
    expect(felder.entry).toBe(227.5);
    expect(felder.setup).toBe("Setup 1 Pullback EMA 20");
  });

  it("rechnet das Ergebnis in R für Long und Short", () => {
    expect(ergebnisR({ entry: 100, stop: 95 }, 110)).toBe(2);
    expect(ergebnisR({ entry: 100, stop: 95 }, 97.5)).toBe(-0.5);
    expect(ergebnisR({ entry: 100, stop: 105 }, 90)).toBe(2);
    expect(ergebnisR({ entry: 100 }, 90)).toBeNull();
  });

  it("fasst Trade und Watchlist-Eintrag zusammen", () => {
    expect(zeileKurz({ ...tradeFelder(TRADE, [], "2026-10-02", "a1b2c3d4") })).toBe(
      "AAPL 2026-10-02  AAPL Long  Entry 227.5, Stop 220, Ziel 240, Risiko 1.00 %  (Kennung a1b2c3d4)",
    );
    expect(zeileKurz({})).toBe("(ohne Nummer)  ?   Entry ?, Stop ?, Ziel ?, Risiko —  (Kennung ?)");
    expect(
      watchlistKurz({
        instrument: "NVDA",
        status: "Aktiv",
        unterstuetzung: 150,
        widerstand: 190,
        ausloeser: "Setup 1 Pullback EMA 20",
        grund: "Pullback erwartet",
      }),
    ).toBe(
      "NVDA [Aktiv]  Unterstützung 150 / Widerstand 190  Auslöser: Setup 1 Pullback EMA 20  — Pullback erwartet",
    );
  });
});

describe("Ablage im Brain", () => {
  it("liest Ordner, Setups und schreibt das Verzeichnis", async () => {
    const w = await mkdtemp(path.join(tmpdir(), "journal-"));
    const lege = async (datei: string, text: string) => {
      await mkdir(path.dirname(brainPfad(w, datei)), { recursive: true });
      await writeFile(brainPfad(w, datei), text, "utf8");
    };
    await lege(
      `${JOURNAL.trades}/2026-10-02 AAPL Long.md`,
      schreibeNotiz(tradeFelder(TRADE, [], "2026-10-02", "a1b2c3d4"), tradeInhalt(TRADE, [])),
    );
    await lege(JOURNAL.setups, schreibeNotiz({ setups: ["Setup 1 Pullback EMA 20"] }, "# Setups"));
    const trades = await liesOrdner(w, JOURNAL.trades);
    expect(trades.map((t) => t.felder.id)).toEqual(["a1b2c3d4"]);
    expect(await dokumentierteSetups(w)).toEqual(["Setup 1 Pullback EMA 20"]);
    expect(await liesOrdner(w, "gibt-es-nicht")).toEqual([]);
    await schreibeVerzeichnis(w, JOURNAL_VERZEICHNISSE[0]);
    expect(await readFile(brainPfad(w, "Trading/Journal.md"), "utf8")).toContain(
      "[[Trading/Journal/2026-10-02 AAPL Long|2026-10-02 AAPL Long — Offen]]",
    );
  });
});

describe("Verdrahtung", () => {
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
