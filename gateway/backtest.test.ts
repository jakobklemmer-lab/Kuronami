import { describe, expect, it } from "vitest";
import {
  type Strategie,
  StrategieFehler,
  backtest,
  einstiegErlaubt,
  kerzenProJahr,
} from "./backtest.js";
import { atrReihe, ema, rollendesHoch, rollendesTief, rsi, sma, stdabw } from "./indikatoren.js";
import type { MarketCandle } from "./integrations/markets.js";

/**
 * Geprüft wird hier vor allem das, was einen Backtest zur Selbsttäuschung macht: der Blick in
 * die Zukunft, der günstige Zufall innerhalb einer Kerze und die vergessenen Kosten. Die
 * Kerzen sind deshalb von Hand gebaut, nicht aus dem Netz geholt — nur dann steht das
 * erwartete Ergebnis vorher fest.
 */

/** Kerzen aus Schlusskursen; Hoch/Tief eng anliegend, wenn nichts anderes gesagt ist. */
function kerzen(schluss: number[], spanne = 0.5): MarketCandle[] {
  return schluss.map((close, i) => ({
    time: 1_700_000_000 + i * 86_400,
    open: i === 0 ? close : schluss[i - 1],
    high: Math.max(close, i === 0 ? close : schluss[i - 1]) + spanne,
    low: Math.min(close, i === 0 ? close : schluss[i - 1]) - spanne,
    close,
    volume: 1000,
  }));
}

/** Eine ausreichend lange, schwingende Tagesreihe für die Abweisungs-Tests. */
function reiheAuf(n: number): number[] {
  return Array.from({ length: n }, (_, i) => 100 + Math.sin(i / 3) * 2);
}

describe("Indikatoren", () => {
  it("sma beginnt erst, wenn die Periode voll ist", () => {
    const werte = [1, 2, 3, 4, 5];
    expect(sma(werte, 3)).toEqual([undefined, undefined, 2, 3, 4]);
  });

  it("ema startet auf dem sma der ersten Periode", () => {
    const reihe = ema([1, 2, 3, 4, 5], 3);
    expect(reihe[0]).toBeUndefined();
    expect(reihe[1]).toBeUndefined();
    expect(reihe[2]).toBe(2);
    expect(reihe[3]).toBeCloseTo(3);
  });

  it("rsi ist 100, wenn es nur aufwärts ging", () => {
    const reihe = rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], 14);
    expect(reihe[14]).toBe(100);
  });

  it("rollendes Hoch lässt die aktuelle Kerze aus", () => {
    // Die letzte Kerze ist die höchste; das rollende Hoch darf sie nicht kennen.
    const k = kerzen([10, 10, 10, 20], 0);
    expect(rollendesHoch(k, 3)[3]).toBe(10);
    expect(rollendesTief(k, 3)[3]).toBe(10);
  });

  it("atr mittelt die wahren Spannen und schweigt bei zu wenigen Kerzen", () => {
    expect(atrReihe(kerzen(new Array(20).fill(100), 1))[19]).toBeCloseTo(2);
    expect(atrReihe(kerzen([100, 101, 102]), 14)[2]).toBeUndefined();
  });

  it("stdabw einer flachen Reihe ist null", () => {
    expect(stdabw([5, 5, 5, 5], 4)[3]).toBe(0);
  });
});

const KREUZT_UEBER_SMA: Strategie = {
  name: "Test: Kurs kreuzt über SMA3",
  richtung: "long",
  einstieg: [
    { links: { art: "kurs" }, vergleich: "kreuzt_ueber", rechts: { art: "sma", periode: 3 } },
  ],
  stopProzent: 5,
  zielProzent: 5,
  gebuehrProzent: 0,
  schlupfProzent: 0,
};

describe("backtest — die Regeln des Hauses", () => {
  it("kauft zur Eröffnung der Kerze NACH dem Signal, nie zum Signalkurs", () => {
    // Flach bei 100, dann ein Sprung auf 110: das Signal fällt auf die Sprungkerze, gekauft
    // wird zur Eröffnung der nächsten — und die ist hier 110, nicht 100.
    const reihe = [...new Array(40).fill(100), 110, ...new Array(20).fill(110)];
    const ergebnis = backtest(KREUZT_UEBER_SMA, kerzen(reihe, 0), { intervall: "1d" });

    expect(ergebnis.handel.length).toBeGreaterThan(0);
    expect(ergebnis.handel[0].einstieg).toBe(110);
  });

  it("zählt den Stop, wenn Stop und Ziel in derselben Kerze liegen", () => {
    const reihe = kerzen([...new Array(40).fill(100), 110, ...new Array(20).fill(110)], 0);
    // Die Kerze nach dem Einstieg reicht in beide Richtungen weit über Stop und Ziel hinaus.
    const nachEinstieg = 42;
    reihe[nachEinstieg] = { ...reihe[nachEinstieg], high: 200, low: 1 };
    const ergebnis = backtest(KREUZT_UEBER_SMA, reihe, { intervall: "1d" });

    expect(ergebnis.handel[0].grund).toBe("stop");
    expect(ergebnis.handel[0].r).toBeLessThan(0);
  });

  it("rechnet Gebühren und Schlupf mit — sie machen aus einem Gewinn einen Verlust", () => {
    const reihe = kerzen([...new Array(40).fill(100), 110, ...new Array(20).fill(110)], 0);
    const ohne = backtest(KREUZT_UEBER_SMA, reihe, { intervall: "1d" });
    const mit = backtest({ ...KREUZT_UEBER_SMA, gebuehrProzent: 1, schlupfProzent: 0.5 }, reihe, {
      intervall: "1d",
    });

    expect(mit.handel[0].renditeProzent).toBeLessThan(ohne.handel[0].renditeProzent);
  });

  it("stellt am Ende des Zeitraums glatt, statt den Handel verschwinden zu lassen", () => {
    const reihe = kerzen([...new Array(55).fill(100), 101, 102, 103], 0);
    const ergebnis = backtest({ ...KREUZT_UEBER_SMA, zielProzent: 50, stopProzent: 50 }, reihe, {
      intervall: "1d",
    });

    expect(ergebnis.handel[ergebnis.handel.length - 1].grund).toBe("ende");
  });

  it("hält höchstens eine Position gleichzeitig", () => {
    const reihe = kerzen(
      [...new Array(30).fill(100), ...Array.from({ length: 40 }, (_, i) => 100 + i)],
      0,
    );
    const ergebnis = backtest(KREUZT_UEBER_SMA, reihe, { intervall: "1d" });
    for (let i = 1; i < ergebnis.handel.length; i += 1) {
      expect(ergebnis.handel[i].einstiegZeit).toBeGreaterThanOrEqual(
        ergebnis.handel[i - 1].ausstiegZeit,
      );
    }
  });

  it("weist eine Strategie ohne Verlustbegrenzung ab", () => {
    expect(() =>
      backtest(
        { name: "x", richtung: "long", einstieg: KREUZT_UEBER_SMA.einstieg },
        kerzen(new Array(60).fill(100)),
      ),
    ).toThrow(/Verlustbegrenzung/);
  });

  it("weist eine Strategie ohne Einstiegsbedingung ab", () => {
    expect(() =>
      backtest(
        { name: "x", richtung: "long", einstieg: [], stopProzent: 2 },
        kerzen(new Array(60).fill(100)),
      ),
    ).toThrow(StrategieFehler);
  });

  it("weist zwei Stop-Angaben ab, statt sich eine auszusuchen", () => {
    expect(() =>
      backtest(
        { ...KREUZT_UEBER_SMA, stopAtr: 2, stopProzent: 3 },
        kerzen(new Array(60).fill(100)),
      ),
    ).toThrow(/nicht beides/);
  });

  it("weist einen zu kurzen Zeitraum ab", () => {
    expect(() => backtest(KREUZT_UEBER_SMA, kerzen(new Array(20).fill(100)))).toThrow(/Zufall/);
  });
});

describe("backtest — die Vorbehalte", () => {
  const steigend = kerzen(
    Array.from({ length: 300 }, (_, i) => 100 + i * 0.3 + Math.sin(i / 4) * 2),
    0.4,
  );

  it("meldet zu wenige Handel", () => {
    const ergebnis = backtest(KREUZT_UEBER_SMA, kerzen(new Array(80).fill(100), 0));
    expect(ergebnis.warnungen.join(" ")).toMatch(/Zufall|Kein einziger Handel/);
  });

  it("teilt in geschraubt und ungesehen und meldet beide getrennt", () => {
    const ergebnis = backtest(KREUZT_UEBER_SMA, steigend, { intervall: "1d" });
    expect(ergebnis.inSample.kennzahlen.anzahl + ergebnis.outOfSample.kennzahlen.anzahl).toBe(
      ergebnis.gesamt.anzahl,
    );
    expect(new Date(ergebnis.inSample.bis).getTime()).toBeLessThanOrEqual(
      new Date(ergebnis.outOfSample.bis).getTime(),
    );
  });

  it("warnt bei hoher Trefferquote mit winzigem Erwartungswert", () => {
    // Enges Ziel, weiter Stop: die Trefferquote wird schön, der Erwartungswert nicht.
    const ergebnis = backtest(
      { ...KREUZT_UEBER_SMA, zielProzent: 0.3, stopProzent: 15 },
      steigend,
      { intervall: "1d" },
    );
    if (ergebnis.gesamt.trefferquote >= 0.7) {
      expect(ergebnis.warnungen.join(" ")).toMatch(/kippt|Ausreißer/);
    }
    expect(ergebnis.gesamt.anzahl).toBeGreaterThan(0);
  });

  it("nennt Sharpe, Rückschlag und Profitfaktor", () => {
    const ergebnis = backtest(KREUZT_UEBER_SMA, steigend, { intervall: "1d" });
    expect(Number.isFinite(ergebnis.gesamt.sharpe)).toBe(true);
    expect(ergebnis.gesamt.maxDrawdownProzent).toBeGreaterThanOrEqual(0);
    expect(ergebnis.gesamt.profitFaktor).toBeGreaterThanOrEqual(0);
  });
});

describe("kerzenProJahr", () => {
  it("nimmt Handelstage, nicht Kalendertage", () => {
    expect(kerzenProJahr("1d")).toBe(252);
    expect(kerzenProJahr("1wk")).toBe(52);
    expect(kerzenProJahr("1h")).toBeGreaterThan(252);
  });
});

/**
 * Fünfminutenkerzen über mehrere Tage — Grundlage für alles, was eine Sitzung kennt. Der Preis
 * schwingt mit fester Periode, damit über den ganzen Tag verteilt Signale entstehen: nur dann
 * belegt der Test überhaupt etwas, wenn hinterher **keins** davon außerhalb des Fensters steht.
 */
function fuenfMinuten(anzahlTage: number): MarketCandle[] {
  const beginn = Math.floor(Date.parse("2024-03-04T00:00:00Z") / 1000);
  const raus: MarketCandle[] = [];
  const proTag = 288;
  for (let i = 0; i < anzahlTage * proTag; i += 1) {
    const close = 100 + Math.sin(i / 7) * 2;
    const vorher = i === 0 ? close : 100 + Math.sin((i - 1) / 7) * 2;
    raus.push({
      time: beginn + i * 300,
      open: vorher,
      high: Math.max(close, vorher) + 0.2,
      low: Math.min(close, vorher) - 0.2,
      close,
      volume: 1000,
    });
  }
  return raus;
}

/** Minute des Tages in UTC — für die Prüfung, wo ein Handel wirklich lag. */
function minuteUtc(unix: number): number {
  const d = new Date(unix * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

const SCHWINGER: Strategie = {
  name: "Test: Kurs kreuzt über SMA3",
  richtung: "long",
  einstieg: [
    { links: { art: "kurs" }, vergleich: "kreuzt_ueber", rechts: { art: "sma", periode: 3 } },
  ],
  stopProzent: 1,
  zielProzent: 1,
  gebuehrProzent: 0,
  schlupfProzent: 0,
};

describe("Zeitfenster und VWAP", () => {
  it("weist ein Zeitfenster auf Tageskerzen ab, statt es immer oder nie treffen zu lassen", () => {
    expect(() =>
      backtest({ ...SCHWINGER, fenster: { von: "09:30", bis: "11:00" } }, kerzen(reiheAuf(80)), {
        intervall: "1d",
      }),
    ).toThrow(StrategieFehler);
  });

  it("weist einen VWAP auf Tageskerzen ab — dort ist er nur der typische Kurs des Tages", () => {
    const mitVwap: Strategie = {
      ...SCHWINGER,
      einstieg: [{ links: { art: "kurs" }, vergleich: "ueber", rechts: { art: "vwap" } }],
    };
    expect(() => backtest(mitVwap, kerzen(reiheAuf(80)), { intervall: "1d" })).toThrow(
      StrategieFehler,
    );
    // Auf Fünfminutenkerzen ist derselbe Indikator in Ordnung.
    expect(() => backtest(mitVwap, fuenfMinuten(2), { intervall: "5m" })).not.toThrow();
  });

  it("weist einen VWAP ohne Volumen ab, statt eine Regel stumm nie auslösen zu lassen", () => {
    const ohneVolumen = fuenfMinuten(2).map((k) => {
      const { volume: _weg, ...rest } = k;
      return rest;
    });
    const mitVwap: Strategie = {
      ...SCHWINGER,
      einstieg: [{ links: { art: "kurs" }, vergleich: "ueber", rechts: { art: "vwap" } }],
    };
    expect(() => backtest(mitVwap, ohneVolumen, { intervall: "5m" })).toThrow(StrategieFehler);
  });

  it("steigt nur im Fenster ein und stellt an seinem Ende glatt", () => {
    const kerzenreihe = fuenfMinuten(4);
    const ohne = backtest(SCHWINGER, kerzenreihe, { intervall: "5m" });
    const mit = backtest(
      { ...SCHWINGER, zone: "UTC", fenster: { von: "09:00", bis: "10:00" } },
      kerzenreihe,
      { intervall: "5m" },
    );

    // Ohne Fenster wird rund um die Uhr gehandelt — sonst belegt der Test nichts.
    expect(ohne.handel.some((h) => minuteUtc(h.einstiegZeit) >= 600)).toBe(true);
    expect(mit.handel.length).toBeGreaterThan(0);
    expect(mit.handel.length).toBeLessThan(ohne.handel.length);

    for (const h of mit.handel) {
      const rein = minuteUtc(h.einstiegZeit);
      expect(rein).toBeGreaterThanOrEqual(540);
      expect(rein).toBeLessThan(600);
      // Nichts läuft über das Fensterende hinaus.
      expect(minuteUtc(h.ausstiegZeit)).toBeLessThanOrEqual(600);
    }
    // Mindestens eine Position wurde vom Fensterende beendet, nicht von Stop oder Ziel.
    expect(mit.handel.some((h) => h.grund === "fenster")).toBe(true);
  });

  it("hält die Position, wenn das Glattstellen am Fensterende abbestellt ist", () => {
    const mit = backtest(
      {
        ...SCHWINGER,
        zone: "UTC",
        fenster: { von: "09:00", bis: "10:00", ausstiegAmEnde: false },
      },
      fuenfMinuten(4),
      { intervall: "5m" },
    );
    expect(mit.handel.length).toBeGreaterThan(0);
    expect(mit.handel.some((h) => h.grund === "fenster")).toBe(false);
  });

  it("prüft die Einstiegskerze, nicht die Signalkerze", () => {
    const kerzenreihe = fuenfMinuten(2);
    const strategie: Strategie = {
      ...SCHWINGER,
      zone: "UTC",
      fenster: { von: "09:00", bis: "10:00" },
    };
    // Die letzte Kerze im Fenster liegt um 09:55; ein Signal dort würde um 10:00 ausgeführt,
    // also außerhalb — und ist deshalb keins.
    const letzteImFenster = kerzenreihe.findIndex((k) => minuteUtc(k.time) === 595);
    expect(letzteImFenster).toBeGreaterThan(0);
    expect(einstiegErlaubt(strategie, kerzenreihe, letzteImFenster)).toBe(false);
    expect(einstiegErlaubt(strategie, kerzenreihe, letzteImFenster - 1)).toBe(true);
  });

  it("weist eine erfundene Zeitzone und eine unmögliche Uhrzeit ab", () => {
    expect(() =>
      backtest(
        { ...SCHWINGER, zone: "Europa/Berlin", fenster: { von: "09:00", bis: "10:00" } },
        fuenfMinuten(2),
        { intervall: "5m" },
      ),
    ).toThrow(StrategieFehler);
    expect(() =>
      backtest({ ...SCHWINGER, fenster: { von: "9:00", bis: "10:00" } }, fuenfMinuten(2), {
        intervall: "5m",
      }),
    ).toThrow(StrategieFehler);
    expect(() =>
      backtest({ ...SCHWINGER, fenster: { von: "09:00", bis: "09:00" } }, fuenfMinuten(2), {
        intervall: "5m",
      }),
    ).toThrow(StrategieFehler);
  });
});

describe("Kosten — der Schlupf zählt einmal je Seite", () => {
  const MIT_KOSTEN: Strategie = {
    name: "Test: Kosten",
    richtung: "long",
    einstieg: [
      { links: { art: "kurs" }, vergleich: "kreuzt_ueber", rechts: { art: "sma", periode: 3 } },
    ],
    stopProzent: 2,
    zielProzent: 2,
    gebuehrProzent: 0.1,
    schlupfProzent: 0.05,
  };

  /** Eine schwingende Reihe erzeugt Gewinner und Verlierer, also beide Seiten der Rechnung. */
  const reihe = kerzen(
    Array.from({ length: 300 }, (_, i) => 100 + Math.sin(i / 4) * 4),
    0.3,
  );

  it("steckt den Schlupf in den Einstiegskurs — und dort nur einmal", () => {
    const ohneSchlupf = backtest({ ...MIT_KOSTEN, schlupfProzent: 0 }, reihe, { intervall: "1d" });
    const mitSchlupf = backtest(MIT_KOSTEN, reihe, { intervall: "1d" });
    const roh = ohneSchlupf.handel[0];
    const geschlupft = mitSchlupf.handel[0];
    expect(roh).toBeDefined();
    // Derselbe Handel, nur der Einstieg ist um genau den Schlupf verschlechtert.
    expect(geschlupft.einstiegZeit).toBe(roh.einstiegZeit);
    expect(geschlupft.einstieg).toBeCloseTo(roh.einstieg * 1.0005, 8);
  });

  it("rechnet jeden ausgewiesenen Handel aus seinen eigenen Zahlen nach", () => {
    // **Der eigentliche Wächter.** Am 2026-09-21 wurde der Schlupf auf der Einstiegsseite
    // doppelt berechnet — einmal im Kurs, einmal in den Kosten. Kein Test hat es gemerkt, weil
    // keiner das Kostenmodell festhielt, sondern alle nur „mit Kosten ist es schlechter als
    // ohne" prüften. Hier steht die Formel selbst.
    const ergebnis = backtest(MIT_KOSTEN, reihe, { intervall: "1d" });
    expect(ergebnis.handel.length).toBeGreaterThan(5);
    const gebuehr = 0.001;
    const schlupf = 0.0005;
    for (const h of ergebnis.handel) {
      const risiko = Math.abs(h.einstieg - h.stop);
      const brutto = h.ausstieg - h.einstieg;
      const kosten = h.einstieg * gebuehr + h.ausstieg * (gebuehr + schlupf);
      expect(h.r).toBeCloseTo((brutto - kosten) / risiko, 8);
      expect(h.renditeProzent).toBeCloseTo(((brutto - kosten) / h.einstieg) * 100, 8);
    }
  });

  it("kostet ohne Gebühr und Schlupf nichts", () => {
    const umsonst = backtest({ ...MIT_KOSTEN, gebuehrProzent: 0, schlupfProzent: 0 }, reihe, {
      intervall: "1d",
    });
    for (const h of umsonst.handel) {
      const risiko = Math.abs(h.einstieg - h.stop);
      expect(h.r).toBeCloseTo((h.ausstieg - h.einstieg) / risiko, 8);
    }
  });
});

describe("Lücken über den Stop", () => {
  it("bedient einen übersprungenen Stop zur Eröffnung, nicht zum Stopkurs", () => {
    // Flach bei 100, ein Signal, dann eine Kerze, die weit unter dem Stop eröffnet.
    const flach = new Array(60).fill(100);
    const reihe: MarketCandle[] = kerzen([...flach, 101, 101], 0.2);
    // Die letzte Kerze reißt nach unten weg: Eröffnung 90, Tief 88.
    reihe.push({
      time: reihe[reihe.length - 1].time + 86_400,
      open: 90,
      high: 90,
      low: 88,
      close: 89,
      volume: 1000,
    });
    reihe.push({
      time: reihe[reihe.length - 1].time + 86_400,
      open: 89,
      high: 90,
      low: 88,
      close: 89,
      volume: 1000,
    });

    const ergebnis = backtest(
      {
        name: "Test: Lücke",
        richtung: "long",
        einstieg: [
          { links: { art: "kurs" }, vergleich: "kreuzt_ueber", rechts: { art: "sma", periode: 3 } },
        ],
        stopProzent: 5,
        gebuehrProzent: 0,
        schlupfProzent: 0,
      },
      reihe,
      { intervall: "1d" },
    );

    const gestoppt = ergebnis.handel.find((h) => h.grund === "stop");
    expect(gestoppt).toBeDefined();
    if (gestoppt === undefined) return;
    // Der Stop lag bei 101 × 0,95 ≈ 95,95 — bedient wurde zur Eröffnung 90.
    expect(gestoppt.stop).toBeCloseTo(95.95, 2);
    expect(gestoppt.ausstieg).toBe(90);
    // Und damit ist der Verlust größer als ein R, wie in Wirklichkeit auch.
    expect(gestoppt.r).toBeLessThan(-1);
  });
});

describe("Stop an einer Linie (stopAn) — gebaut für die Kalibrierung an TradingLab", () => {
  // Flach bei 100, dann ein Sprung auf 110: Signal auf Index 40, Einstieg zur Eröffnung von 41.
  const sprung = [...new Array(40).fill(100), 110, ...new Array(20).fill(110)];

  it("setzt den Stop auf den Wert der Linie an der Signalkerze, das Ziel in R davon", () => {
    const mitLinie = backtest(
      {
        ...KREUZT_UEBER_SMA,
        stopProzent: undefined,
        zielProzent: undefined,
        stopAn: { art: "wert", wert: 95 },
        zielR: 1.5,
      },
      kerzen(sprung, 0),
      { intervall: "1d" },
    );
    const h = mitLinie.handel[0];
    expect(h.einstieg).toBe(110);
    expect(h.stop).toBe(95);
    // Risiko 15, Ziel 1,5 R darüber.
    expect(h.ziel).toBe(132.5);
  });

  it("nimmt fürs Swing-Tief die Signalkerze mit — ihr Tief ist oft das tiefste", () => {
    const reihe = kerzen(sprung, 0);
    // Die Signalkerze (Index 40) taucht vor dem Schluss bei 110 bis 97 ab.
    reihe[40] = { ...reihe[40], low: 97 };
    const ergebnis = backtest(
      {
        ...KREUZT_UEBER_SMA,
        stopProzent: undefined,
        stopAn: { art: "swing_tief", periode: 3 },
      },
      reihe,
      { intervall: "1d" },
    );
    expect(ergebnis.handel[0].stop).toBe(97);
  });

  it("handelt nicht, wenn die Linie auf der falschen Seite liegt — und sagt, wie oft", () => {
    const ergebnis = backtest(
      { ...KREUZT_UEBER_SMA, stopProzent: undefined, stopAn: { art: "wert", wert: 120 } },
      kerzen(sprung, 0),
      { intervall: "1d" },
    );
    expect(ergebnis.handel).toHaveLength(0);
    expect(ergebnis.ohneStop).toBe(1);
    expect(ergebnis.warnungen.join(" ")).toMatch(/falschen Seite/);
  });

  it("weist einen Stop an einer Linie ab, die kein Kurs ist, und zwei Stop-Arten zugleich", () => {
    const reihe = kerzen(new Array(60).fill(100));
    expect(() =>
      backtest(
        { ...KREUZT_UEBER_SMA, stopProzent: undefined, stopAn: { art: "rsi", periode: 14 } },
        reihe,
      ),
    ).toThrow(/Kursachse/);
    expect(() =>
      backtest({ ...KREUZT_UEBER_SMA, stopAn: { art: "ema", periode: 3 } }, reihe),
    ).toThrow(/nicht beides/);
  });

  it("steigt auf ein Fraktal erst nach der zweiten Kerze danach ein, nie an der Tiefkerze", () => {
    // Abwärts bis Index 30 (Tief 70), danach wieder aufwärts.
    const schluss = [
      ...Array.from({ length: 31 }, (_, i) => 100 - i),
      ...Array.from({ length: 30 }, (_, i) => 71 + i),
    ];
    const reihe = kerzen(schluss, 0.5);
    // Die Kerze danach eröffnet am Tief — ihr Tief läge sonst gleichauf, und nach TradingViews
    // Regel für gleich tiefe Kerzen wäre dann sie das Fraktal.
    reihe[31] = { ...reihe[31], low: 70 };
    const ergebnis = backtest(
      {
        name: "Test: grüner Pfeil",
        richtung: "long",
        einstieg: [
          { links: { art: "fraktal_tief" }, vergleich: "ueber", rechts: { art: "wert", wert: 0 } },
        ],
        stopAn: { art: "swing_tief", periode: 5 },
        zielR: 1.5,
        gebuehrProzent: 0,
        schlupfProzent: 0,
      },
      reihe,
      { intervall: "1d" },
    );
    const erster = ergebnis.handel[0];
    // Fraktal an Index 30, fest bei 32, Einstieg zur Eröffnung von 33 — nicht bei 30 oder 31.
    expect(erster.einstiegZeit).toBe(reihe[33].time);
    expect(erster.einstieg).toBe(reihe[33].open);
    expect(erster.stop).toBe(reihe[30].low);
  });
});
