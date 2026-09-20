import { afterEach, describe, expect, it } from "vitest";
import type { MarketCandle, MarketChart } from "./integrations/markets.js";
import {
  ReplayFehler,
  bilanz,
  handeln,
  hole,
  sichtbar,
  stand,
  starte,
  stellGlatt,
  vergissAlles,
  weiter,
} from "./replay.js";
import { formatiereRueckblick, werteIdeeAus } from "./rueckblick.js";

/**
 * Die Wiedergabe und der Rückblick prüfen beide dasselbe: dass niemand mehr sieht, als er zum
 * Zeitpunkt der Entscheidung gesehen hätte. Deshalb steht hier vor allem, was **nicht**
 * sichtbar sein darf.
 */

const TAG = 86_400;
const START = Math.floor(new Date("2026-01-01T00:00:00Z").getTime() / 1000);

function kerzen(schluss: number[], spanne = 1): MarketCandle[] {
  return schluss.map((close, i) => ({
    time: START + i * TAG,
    open: i === 0 ? close : schluss[i - 1],
    high: Math.max(close, i === 0 ? close : schluss[i - 1]) + spanne,
    low: Math.min(close, i === 0 ? close : schluss[i - 1]) - spanne,
    close,
  }));
}

function chart(candles: MarketCandle[]): MarketChart {
  return {
    symbol: "TEST",
    name: "Testwert",
    currency: "EUR",
    exchange: "XETRA",
    price: candles[candles.length - 1].close,
    change: 0,
    changePct: 0,
    spark: [],
    range: "test",
    interval: "1d",
    candles,
  };
}

function datumVon(index: number): string {
  return new Date((START + index * TAG) * 1000).toISOString().slice(0, 10);
}

afterEach(() => vergissAlles());

describe("Wiedergabe", () => {
  const verlauf = chart(kerzen(Array.from({ length: 60 }, (_, i) => 100 + i)));

  it("zeigt nur die Kerzen bis zum Starttag", () => {
    const sitzung = starte(verlauf, datumVon(30));
    const gesehen = sichtbar(sitzung, 100);

    expect(gesehen.length).toBe(31);
    expect(gesehen[gesehen.length - 1].time).toBe(START + 30 * TAG);
    // Die Zukunft ist geladen, aber nicht sichtbar — sonst könnte sie niemand aufdecken.
    expect(stand(sitzung).verbleibend).toBe(29);
  });

  it("deckt beim Vorspulen genau so viele Kerzen auf, wie verlangt", () => {
    const sitzung = starte(verlauf, datumVon(30));
    const { neu } = weiter(sitzung, 3);

    expect(neu.length).toBe(3);
    expect(sichtbar(sitzung, 100).length).toBe(34);
  });

  it("verweigert den Start ohne Vorlauf", () => {
    expect(() => starte(verlauf, datumVon(0))).toThrow(ReplayFehler);
  });

  it("verweigert den Start, wenn nichts mehr abzuspielen wäre", () => {
    expect(() => starte(verlauf, datumVon(59))).toThrow(/nichts mehr/);
  });

  it("steigt zur Eröffnung der nächsten Kerze ein, nicht zum aktuellen Schluss", () => {
    const sitzung = starte(verlauf, datumVon(30));
    const handel = handeln(sitzung, {
      richtung: "long",
      stop: 120,
      ziele: [140],
      begruendung: "Aufwärtstrend, höhere Tiefs seit zwei Wochen.",
    });

    expect(handel.einstieg).toBe(verlauf.candles[31].open);
    expect(handel.einstiegZeit).toBe(verlauf.candles[31].time);
  });

  it("stoppt eine Position aus, wenn die neue Kerze den Stop berührt", () => {
    const fallend = chart(kerzen([...new Array(30).fill(100), 99, 90, 80, 70, 60]));
    const sitzung = starte(fallend, datumVon(29));
    handeln(sitzung, {
      richtung: "long",
      stop: 95,
      ziele: [120],
      begruendung: "Test: Stop muss greifen, sobald der Kurs ihn berührt.",
    });
    const { ereignisse } = weiter(sitzung, 3);

    expect(ereignisse.join(" ")).toMatch(/ausgestoppt/);
    expect(sitzung.handel[0].offen).toBe(false);
    expect(sitzung.handel[0].r).toBe(-1);
  });

  it("verbucht ein erreichtes Ziel mit seinem R", () => {
    const sitzung = starte(verlauf, datumVon(30));
    const handel = handeln(sitzung, {
      richtung: "long",
      stop: 121,
      ziele: [135],
      begruendung: "Test: Ziel wird erreicht, Stop bleibt unberührt.",
    });
    weiter(sitzung, 10);

    expect(handel.offen).toBe(false);
    expect(handel.grund).toBe("ziel");
    expect(handel.r ?? 0).toBeGreaterThan(0);
  });

  it("lässt keine zwei Positionen gleichzeitig zu", () => {
    const sitzung = starte(verlauf, datumVon(30));
    handeln(sitzung, {
      richtung: "long",
      stop: 120,
      ziele: [200],
      begruendung: "Erster Handel, bleibt offen.",
    });
    expect(() =>
      handeln(sitzung, {
        richtung: "long",
        stop: 120,
        ziele: [200],
        begruendung: "Zweiter Handel, darf nicht gehen.",
      }),
    ).toThrow(/läuft noch ein Handel/i);
  });

  it("weist einen Stop auf der falschen Seite ab", () => {
    const sitzung = starte(verlauf, datumVon(30));
    expect(() =>
      handeln(sitzung, {
        richtung: "long",
        stop: 999,
        ziele: [1200],
        begruendung: "Stop über dem Einstieg — ergibt keinen Handel.",
      }),
    ).toThrow(/falschen Seite/);
  });

  it("stellt von Hand glatt und rechnet das Ergebnis in R", () => {
    const sitzung = starte(verlauf, datumVon(30));
    handeln(sitzung, {
      richtung: "long",
      stop: 121,
      ziele: [999],
      begruendung: "Wird von Hand geschlossen.",
    });
    weiter(sitzung, 4);
    const handel = stellGlatt(sitzung);

    expect(handel.offen).toBe(false);
    expect(handel.grund).toBe("hand");
    expect(typeof handel.r).toBe("number");
  });

  it("findet eine Sitzung über ihre Kennung und meldet eine unbekannte", () => {
    const sitzung = starte(verlauf, datumVon(30));
    expect(hole(sitzung.id).id).toBe(sitzung.id);
    expect(() => hole("gibtsnicht")).toThrow(ReplayFehler);
  });

  it("bilanziert das Tagebuch", () => {
    const b = bilanz([
      { r: 2, offen: false } as never,
      { r: -1, offen: false } as never,
      { r: -1, offen: false } as never,
      { offen: true } as never,
    ]);
    expect(b.anzahl).toBe(3);
    expect(b.offen).toBe(1);
    expect(b.trefferquote).toBeCloseTo(1 / 3);
    expect(b.summeR).toBe(0);
    expect(b.profitFaktor).toBeCloseTo(1);
  });
});

describe("Rückblick auf eine einzelne Idee", () => {
  it("erkennt, dass nie eingestiegen wurde", () => {
    const ergebnis = werteIdeeAus(
      { richtung: "long", einstieg: 50, stop: 45, ziele: [60] },
      kerzen([100, 101, 102, 103]),
    );
    expect(ergebnis.ausgang).toBe("nie_eingestiegen");
    expect(ergebnis.r).toBeNull();
  });

  it("verbucht den Stop und zählt −1 R", () => {
    const ergebnis = werteIdeeAus(
      { richtung: "long", einstieg: 100, stop: 95, ziele: [120] },
      kerzen([100, 99, 96, 90, 88]),
    );
    expect(ergebnis.ausgang).toBe("stop");
    expect(ergebnis.r).toBe(-1);
  });

  it("verbucht das Ziel mit seinem R und nennt den schlechtesten Stand", () => {
    const ergebnis = werteIdeeAus(
      { richtung: "long", einstieg: 100, stop: 90, ziele: [120] },
      kerzen([100, 97, 105, 118, 125]),
    );
    expect(ergebnis.ausgang).toBe("ziel");
    expect(ergebnis.r).toBeCloseTo(2);
    expect(ergebnis.maeR ?? 0).toBeLessThan(0);
  });

  it("zählt den Stop, wenn Stop und Ziel in derselben Kerze liegen", () => {
    const reihe = kerzen([100, 100]);
    reihe[1] = { ...reihe[1], high: 200, low: 50 };
    const ergebnis = werteIdeeAus(
      { richtung: "long", einstieg: 100, stop: 90, ziele: [120] },
      reihe,
    );
    expect(ergebnis.ausgang).toBe("stop");
  });

  it("meldet eine noch offene Idee mit ihrem Zwischenstand", () => {
    const ergebnis = werteIdeeAus(
      { richtung: "long", einstieg: 100, stop: 90, ziele: [200] },
      kerzen([100, 104, 108, 112]),
    );
    expect(ergebnis.ausgang).toBe("offen");
    expect(ergebnis.r ?? 0).toBeGreaterThan(0);
  });

  it("rechnet Short spiegelbildlich", () => {
    const ergebnis = werteIdeeAus(
      { richtung: "short", einstieg: 100, stop: 110, ziele: [80] },
      kerzen([100, 95, 88, 79]),
    );
    expect(ergebnis.ausgang).toBe("ziel");
    expect(ergebnis.r).toBeCloseTo(2);
  });

  it("sagt im Text, wenn eine Idee zwischendurch weit vorn lag und trotzdem ausgestoppt wurde", () => {
    const idee = { richtung: "long", einstieg: 100, stop: 95, ziele: [200] } as const;
    const ergebnis = werteIdeeAus(idee, kerzen([100, 110, 120, 99, 94, 90]));
    const text = formatiereRueckblick(idee, ergebnis, { symbol: "TEST" });

    expect(ergebnis.ausgang).toBe("stop");
    expect(text).toMatch(/Ausstiegsmanagement|vorn/);
  });
});
