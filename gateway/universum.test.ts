import { describe, expect, it } from "vitest";
import type { Strategie } from "./backtest.js";
import type { MarketCandle } from "./integrations/markets.js";
import { type MarktKerzen, formatiereUniversum, ueberMaerkte } from "./universum.js";

function kerzenAus(schluesse: readonly number[], spanne = 0.3): MarketCandle[] {
  return schluesse.map((close, i) => {
    const vorher = i === 0 ? close : schluesse[i - 1];
    return {
      time: 1_600_000_000 + i * 86_400,
      open: vorher,
      high: Math.max(close, vorher) + spanne,
      low: Math.min(close, vorher) - spanne,
      close,
      volume: 1000,
    };
  });
}

/**
 * Ein steigender Markt mit Schwingung — ein Trendfolger verdient darin. Die Schwingung ist
 * nötig, nicht Zierde: eine schnurgerade Linie kreuzt ihren gleitenden Durchschnitt nie, und
 * die Regel löste kein einziges Mal aus.
 */
function trend(n: number, start = 100, drift = 0.002, amp = 2.5): MarketCandle[] {
  return kerzenAus(
    Array.from(
      { length: n },
      (_, i) => start * (1 + drift) ** i + Math.sin(i / 2) * amp * (start / 100),
    ),
  );
}

/**
 * Abwechselnd Auf- und Abschwung.
 *
 * Nötig für alles, was sich am **Nullpunkt** messen lassen muss: in einem synthetischen Markt,
 * der nur steigt, gewinnt jeder beliebige Einstieg, der Nullpunkt ist maximal und keine Regel
 * kann ihn schlagen. Erst mit Abschwüngen entsteht überhaupt etwas, das eine Regel besser
 * machen kann als der Zufall.
 */
function zyklisch(n: number, start = 100, phase = 0): MarketCandle[] {
  const reihe: number[] = [];
  let kurs = start;
  for (let i = 0; i < n; i += 1) {
    const auf = Math.floor((i + phase) / 60) % 2 === 0;
    kurs *= 1 + (auf ? 0.004 : -0.0035);
    reihe.push(kurs + Math.sin(i / 2) * 0.02 * kurs);
  }
  return kerzenAus(reihe);
}

/** Ein Markt, der nur zappelt — dieselbe Regel wird darin von den Kosten zerrieben. */
function zappel(n: number, start = 100): MarketCandle[] {
  return kerzenAus(
    Array.from(
      { length: n },
      (_, i) => start * (1 + 0.02 * Math.sin(i / 2) + 0.01 * Math.sin(i / 7)),
    ),
  );
}

const TRENDFOLGER: Strategie = {
  name: "Test: Kurs kreuzt über SMA5",
  richtung: "long",
  einstieg: [
    { links: { art: "kurs" }, vergleich: "kreuzt_ueber", rechts: { art: "sma", periode: 5 } },
  ],
  stopProzent: 2,
  zielProzent: 4,
  gebuehrProzent: 0.1,
  schlupfProzent: 0.05,
};

describe("ueberMaerkte", () => {
  it("nennt weniger als drei Märkte einen Einzelfall, egal wie gut die Zahlen sind", () => {
    const e = ueberMaerkte(TRENDFOLGER, [
      { symbol: "A", kerzen: trend(600) },
      { symbol: "B", kerzen: trend(600, 50) },
    ]);
    expect(e.einstufung).toBe("einzelfall");
    expect(e.begruendung).toContain("mindestens drei");
  });

  it("erkennt eine Regel, die überall trägt", () => {
    // Trendfilter plus Rücksetzer, auf Märkten mit echten Auf- und Abschwüngen: die Regel
    // hält sich aus den Abschwüngen heraus und schlägt damit den Zufall.
    const mitFilter: Strategie = {
      ...TRENDFOLGER,
      einstieg: [
        {
          links: { art: "sma", periode: 10 },
          vergleich: "ueber",
          rechts: { art: "sma", periode: 30 },
        },
        { links: { art: "kurs" }, vergleich: "kreuzt_ueber", rechts: { art: "sma", periode: 5 } },
      ],
    };
    const maerkte: MarktKerzen[] = [
      { symbol: "A", kerzen: zyklisch(1500) },
      { symbol: "B", kerzen: zyklisch(1500, 40, 60) },
      { symbol: "C", kerzen: zyklisch(1500, 900, 120) },
      { symbol: "D", kerzen: zyklisch(1500, 12, 30) },
    ];
    const e = ueberMaerkte(mitFilter, maerkte, { intervall: "1d" });
    expect(e.gerechnet).toBe(4);
    expect(e.gemeinsamErwartungswertR).toBeGreaterThan(0);
    // Sie schlägt ihren eigenen Nullpunkt an der Mehrheit der Märkte — sonst wäre es die
    // Geometrie und nicht die Regel.
    expect(e.schlaegtNullpunkt?.davon).toBeGreaterThan(2);
    expect(e.einstufung).toBe("uebertragbar");
    // Der gemeinsame Topf ist größer als jeder einzelne Markt — das ist der Zweck.
    expect(e.gesamtHandel).toBeGreaterThan(e.maerkte[0].anzahl);
  });

  it("entlarvt eine Regel, die nur an einem Markt lebt", () => {
    const maerkte: MarktKerzen[] = [
      { symbol: "GUT", kerzen: trend(600, 100, 0.004, 3) },
      { symbol: "ZAPPEL1", kerzen: zappel(600) },
      { symbol: "ZAPPEL2", kerzen: zappel(600, 70) },
      { symbol: "ZAPPEL3", kerzen: zappel(600, 220) },
    ];
    const e = ueberMaerkte(TRENDFOLGER, maerkte, { intervall: "1d" });
    expect(e.gerechnet).toBe(4);
    // **Die Falle:** alle vier Märkte sind einzeln positiv, und der gemeinsame Topf hat ein
    // Intervall, das die Null nicht einschließt. Trotzdem ist es ein Einzelfall — drei Viertel
    // des Gewinns kommen aus einem Markt. Ohne die Konzentrationsprüfung hieße das hier
    // „übertragbar", und das wäre die teuerste Art, richtig zu rechnen.
    expect(e.positiv).toBe(4);
    expect(e.gemeinsam?.unten).toBeGreaterThan(0);
    expect(e.anteilBesterMarkt).toBeGreaterThan(0.6);
    expect(e.einstufung).toBe("einzelfall");
  });

  it("stuft herunter, wenn die Regel ihren eigenen Nullpunkt nicht schlägt", () => {
    // Eine Regel, die in steigenden Märkten in Rücksetzer hinein kauft, verdient dort — aber
    // **weniger** als ein beliebiger Einstieg mit derselben Stop-Ziel-Geometrie. Ohne diese
    // Prüfung hieße das „übertragbar": positiver Erwartungswert, alle Märkte tragen. In
    // Wahrheit überträgt sich die Geometrie, nicht die Regel, und Geometrie wählt man frei.
    const gegenTrend: Strategie = {
      ...TRENDFOLGER,
      einstieg: [
        { links: { art: "kurs" }, vergleich: "kreuzt_unter", rechts: { art: "sma", periode: 5 } },
      ],
      stopProzent: 3,
      zielProzent: 6,
    };
    const e = ueberMaerkte(
      gegenTrend,
      [
        { symbol: "A", kerzen: trend(600) },
        { symbol: "B", kerzen: trend(600, 40) },
        { symbol: "C", kerzen: trend(600, 900) },
        { symbol: "D", kerzen: trend(600, 12) },
      ],
      { intervall: "1d" },
    );
    expect(e.gemeinsamErwartungswertR).toBeGreaterThan(0);
    expect(e.positiv).toBe(4);
    expect(e.schlaegtNullpunkt).toEqual({ davon: 0, von: 4 });
    expect(e.einstufung).toBe("gemischt");
    expect(e.begruendung).toContain("Geometrie, nicht die Regel");
  });

  it("meldet einen Markt, der nicht gerechnet werden konnte, statt ihn zu verschweigen", () => {
    const e = ueberMaerkte(TRENDFOLGER, [
      { symbol: "A", kerzen: trend(600) },
      { symbol: "B", kerzen: trend(600, 40) },
      { symbol: "ZUKURZ", kerzen: trend(20) },
    ]);
    const kaputt = e.maerkte.find((m) => m.symbol === "ZUKURZ");
    expect(kaputt?.fehler).toContain("Kerzen");
    // Er zählt nicht als gerechnetes Ergebnis.
    expect(e.gerechnet).toBe(2);
  });

  it("schreibt eine Tabelle, die man in einen Bericht übernehmen kann", () => {
    const e = ueberMaerkte(
      TRENDFOLGER,
      [
        { symbol: "A", kerzen: trend(600) },
        { symbol: "B", kerzen: trend(600, 40) },
        { symbol: "C", kerzen: zappel(600) },
      ],
      { intervall: "1d" },
    );
    const text = formatiereUniversum(e);
    expect(text).toContain("dieselbe Regel über 3 Märkte, unverändert");
    expect(text).toContain("Baseline");
    expect(text).toMatch(/ÜBERTRAGBAR|GEMISCHT|EINZELFALL/);
    expect(text).toContain("der beste Markt einer Liste ist immer gut");
  });
});
