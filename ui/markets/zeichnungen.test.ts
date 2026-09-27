import { describe, expect, it } from "vitest";
import { STAND_WORT, type StrategieImChart, prognoseFormen, strategieFormen } from "./arbeit.js";
import { FARBE, formenFuer, triff, ziehe } from "./formen.js";
import { anfrageFuer, ausId, beschriftung, indikatorId } from "./indikatoren.js";
import {
  beschreibe,
  dauerText,
  einrasten,
  fibStufen,
  logischeStelle,
  messe,
  positionsZahlen,
  zeitAnStelle,
} from "./zeichnungen.js";

describe("Zeit und Kerzenstelle", () => {
  const zeiten = [100, 200, 300, 500];
  it("teilt zwischen Kerzen und zählt hinter der letzten weiter", () => {
    expect(logischeStelle(250, zeiten, 100)).toBe(1.5);
    expect(logischeStelle(400, zeiten, 100)).toBe(2.5);
    expect(logischeStelle(700, zeiten, 100)).toBe(5);
    expect(logischeStelle(0, zeiten, 100)).toBe(-1);
  });
  it("rechnet hin und zurück", () => {
    for (const t of [50, 100, 250, 420, 800])
      expect(zeitAnStelle(logischeStelle(t, zeiten, 100), zeiten, 100)).toBe(t);
  });
});

describe("Geometrie", () => {
  it("legt Fibonacci von 100 % (a) nach 0 % (b)", () => {
    const stufen = fibStufen({ zeit: 0, preis: 200 }, { zeit: 1, preis: 100 });
    expect(stufen.find((s) => s.anteil === 0.5)?.preis).toBe(150);
    expect(stufen.find((s) => s.anteil === 0.618)?.preis).toBeCloseTo(161.8);
  });

  it("rechnet eine Position und gibt bei falscher Seite kein CRV", () => {
    const gut = positionsZahlen({ richtung: "long", einstieg: 100, stop: 95, ziel: 110 });
    expect(gut).toMatchObject({ crv: 2, risikoProzent: 5, chanceProzent: 10, stimmig: true });
    expect(gut.breakeven).toBeCloseTo(1 / 3);
    expect(
      positionsZahlen({ richtung: "short", einstieg: 100, stop: 95, ziel: 90 }).crv,
    ).toBeNull();
  });

  it("misst und nennt die Dauer lesbar", () => {
    expect(
      messe({ zeit: 0, preis: 100 }, { zeit: 3 * 86_400 + 4 * 3600, preis: 105 }, 12),
    ).toMatchObject({ differenz: 5, prozent: 5, kerzen: 12 });
    expect(dauerText(3 * 86_400 + 4 * 3600)).toBe("3 T 4 Std");
    expect(dauerText(45 * 60)).toBe("45 Min");
    expect(dauerText(16 * 86_400)).toBe("2 W 2 T");
  });

  it("rastet am nächsten Kurs der Kerze ein, nur innerhalb der Toleranz", () => {
    const kerze = { open: 100, high: 110, low: 95, close: 105 };
    expect(einrasten(109, kerze, 2)).toBe(110);
    expect(einrasten(102.5, kerze, 1)).toBe(102.5);
  });
});

describe("Treffen und Ziehen", () => {
  const u = { x: (t: number) => t, y: (p: number) => 1000 - p };
  it("trifft Griffe vor der Linie und zieht sie einzeln", () => {
    const trend = {
      id: "t",
      art: "trend" as const,
      a: { zeit: 100, preis: 500 },
      b: { zeit: 300, preis: 700 },
    };
    expect(triff(trend, 102, 499, u)).toBe("a");
    expect(triff(trend, 200, 400, u)).toBe("ganz");
    expect(triff(trend, 200, 300, u)).toBeNull();
    const gezogen = ziehe(trend, "ganz", { zeit: 200, preis: 600 }, { zeit: 210, preis: 610 });
    expect(gezogen).toMatchObject({ a: { zeit: 110, preis: 510 }, b: { zeit: 310, preis: 710 } });
  });

  it("zieht Stop und Ziel einer Position getrennt", () => {
    const p = {
      id: "p",
      art: "position" as const,
      richtung: "long" as const,
      a: { zeit: 100, preis: 500 },
      bisZeit: 300,
      stop: 450,
      ziel: 600,
    };
    expect(triff(p, 100, 550, u)).toBe("stop");
    expect(triff(p, 100, 400, u)).toBe("ziel");
    expect(triff(p, 200, 480, u)).toBe("ganz");
    expect(ziehe(p, "stop", { zeit: 100, preis: 450 }, { zeit: 120, preis: 440 })).toMatchObject({
      stop: 440,
      ziel: 600,
    });
  });

  it("zeichnet Griffe nur an der gewählten Zeichnung", () => {
    const trend = {
      id: "t",
      art: "trend" as const,
      a: { zeit: 1, preis: 1 },
      b: { zeit: 2, preis: 2 },
    };
    expect(formenFuer(trend, false).some((f) => f.typ === "griff")).toBe(false);
    expect(formenFuer(trend, true).filter((f) => f.typ === "griff")).toHaveLength(2);
  });

  it("beschreibt eine Position mit gerechnetem CRV", () => {
    expect(
      beschreibe({
        id: "p",
        art: "position",
        richtung: "long",
        a: { zeit: 0, preis: 25450 },
        bisZeit: 1,
        stop: 25200,
        ziel: 25950,
      }),
    ).toBe("Long-Idee: Einstieg 25.450, Stop 25.200, Ziel 25.950 (CRV 2:1)");
  });
});

describe("Indikatoren", () => {
  it("baut dieselben Kennungen wie das Gateway", () => {
    expect(indikatorId({ art: "bb", parameter: [20, 2] })).toBe("bb:20:2");
    expect(ausId("sma:200")).toEqual({ art: "sma", parameter: [200] });
    expect(ausId("macd")).toEqual({ art: "macd", parameter: [12, 26, 9] });
    expect(ausId("zauber:3")).toBeNull();
    expect(
      anfrageFuer([
        { art: "sma", parameter: [20] },
        { art: "sma", parameter: [20] },
        { art: "obv", parameter: [] },
      ]),
    ).toBe("sma:20,obv");
    expect(beschriftung({ art: "bb", parameter: [20, 2.5] })).toBe("BB 20 2,5");
  });
});

describe("Kuros Arbeit", () => {
  it("zeigt eine Idee von der Ablage bis zum Ausgang, mit Stand und R", () => {
    const formen = prognoseFormen(
      {
        prognose: {
          id: "p",
          angelegt: "2026-09-22T06:39:38Z",
          von: "boerse",
          symbol: "BTC-USD",
          richtung: "long",
          ausloeser: 82000,
          fristTage: 30,
          stop: 78900,
          ziele: [90000, 93600],
        },
        verlauf: {
          stand: "stop",
          ausloeserAm: 1_790_000_000,
          einstieg: 82000,
          ausstiegAm: 1_790_100_000,
          ausstieg: 78900,
          r: -1,
          haltedauerTage: 1.2,
        },
      },
      1_790_500_000,
    );
    const titel = formen.find((f) => f.typ === "text" && f.text.startsWith("Börse"));
    expect(titel && "text" in titel ? titel.text : "").toBe(`Börse · ${STAND_WORT.stop} · −1,0 R`);
    const kaesten = formen.filter((f) => f.typ === "kasten");
    expect(kaesten.every((f) => f.typ === "kasten" && f.b.zeit === 1_790_100_000)).toBe(true);
  });

  it("macht aus Handeln Pfeile, Punkte mit R und die zwei Grenzen", () => {
    const s = {
      richtung: "long",
      teilung: 500,
      bis: 800,
      handel: [
        {
          einstiegZeit: 300,
          ausstiegZeit: 400,
          einstieg: 10,
          ausstieg: 12,
          stop: 9,
          ziel: 13,
          grund: "regel",
          r: 2,
          nachAblage: false,
        },
        {
          einstiegZeit: 100,
          ausstiegZeit: 200,
          einstieg: 10,
          ausstieg: 9,
          stop: 9,
          ziel: 13,
          grund: "stop",
          r: -1,
          nachAblage: false,
        },
        {
          einstiegZeit: 900,
          ausstiegZeit: 950,
          einstieg: 10,
          ausstieg: 10,
          stop: 9,
          ziel: null,
          grund: "ende",
          r: 0,
          nachAblage: true,
        },
      ],
      papier: null,
    } as unknown as StrategieImChart;
    const { formen, marken } = strategieFormen(s);
    expect(marken.map((m) => m.time)).toEqual([100, 200, 300, 400, 900, 950]);
    expect(marken.map((m) => m.text)).toEqual(["", "−1,0 R", "", "+2,0 R", "ungesehen", "offen"]);
    expect(formen.filter((f) => f.typ === "vlinie")).toHaveLength(2);
    expect(formen.some((f) => f.typ === "strecke" && f.farbe === FARBE.kuro)).toBe(true);
  });
});
