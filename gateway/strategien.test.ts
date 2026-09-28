import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type Abschnitt,
  type Handel,
  type Kennzahlen,
  type Strategie,
  warnungenAus,
} from "./backtest.js";
import { konfidenz } from "./konfidenz.js";
import {
  type StrategienArchiv,
  type UniversumVermerk,
  bewerte,
  createStrategien,
} from "./strategien.js";

function kennzahlen(teil: Partial<Kennzahlen> = {}): Kennzahlen {
  return {
    anzahl: 60,
    trefferquote: 0.45,
    durchschnittR: 0.3,
    erwartungswertR: 0.3,
    profitFaktor: 1.5,
    gesamtrenditeProzent: 30,
    maxDrawdownProzent: 10,
    sharpe: 1.4,
    sortino: 1.8,
    durchschnittGewinnR: 1.6,
    durchschnittVerlustR: -0.8,
    groessterGewinnR: 3,
    groessterVerlustR: -1.2,
    laengsteVerlustserie: 4,
    durchschnittKerzen: 8,
    ...teil,
  };
}

function abschnitt(erwartungswertR: number, anzahl = 20): Abschnitt {
  return {
    von: "2020-01-01",
    bis: "2026-01-01",
    kennzahlen: kennzahlen({ erwartungswertR, anzahl }),
  };
}

/** R-Werte mit vorgegebenem Trefferanteil, gleichmäßig verteilt. */
function rWerte(anzahl: number, trefferAnteil: number, gewinn: number): number[] {
  return Array.from({ length: anzahl }, (_, i) =>
    Math.floor((i + 1) * trefferAnteil) > Math.floor(i * trefferAnteil) ? gewinn : -1,
  );
}

function vermerk(teil: Partial<UniversumVermerk> = {}): UniversumVermerk {
  return {
    einstufung: "uebertragbar",
    maerkte: 5,
    gesamtHandel: 150,
    gemeinsamErwartungswertR: 0.2,
    begruendung: "Testvermerk.",
    ...teil,
  };
}

describe("bewerte", () => {
  // +0,2 R mit einem Intervall über null, −0,4 R mit einem darunter, und fast null dazwischen.
  const belegt = konfidenz(rWerte(1200, 0.4, 2));
  const widerlegt = konfidenz(rWerte(1200, 0.2, 2));
  const offen = konfidenz(rWerte(250, 0.34, 2));

  it("macht aus einer belegten Kante einen Kandidaten", () => {
    expect(belegt).toBeDefined();
    expect(bewerte(kennzahlen({ anzahl: 1200, konfidenz: belegt }), abschnitt(0.2), [])).toBe(
      "kandidat",
    );
  });

  it("urteilt unter 200 Handeln gar nicht — weder so noch so", () => {
    // Jakob am 28.09.: „Backtesting muss über hunderte von Backtests stattfinden, nicht über ein
    // paar dutzend." Auch ein Intervall, das bei 199 Handeln klar aussieht, bleibt vorläufig.
    expect(bewerte(kennzahlen({ anzahl: 199, konfidenz: belegt }), abschnitt(0.2), [])).toBe(
      "geprueft",
    );
    expect(
      bewerte(
        kennzahlen({ anzahl: 199, erwartungswertR: -0.4, konfidenz: widerlegt }),
        abschnitt(-0.4),
        [],
      ),
    ).toBe("geprueft");
  });

  it("verwirft nur, wenn das Intervall ganz unter null liegt", () => {
    expect(
      bewerte(
        kennzahlen({ anzahl: 1200, erwartungswertR: -0.4, konfidenz: widerlegt }),
        abschnitt(-0.4),
        [],
      ),
    ).toBe("verworfen");
    // Nahe null bei 250 Handeln: nicht belegt, aber auch nicht widerlegt.
    expect(offen && offen.unten < 0 && offen.oben > 0).toBe(true);
    expect(
      bewerte(
        kennzahlen({ anzahl: 250, erwartungswertR: 0.02, konfidenz: offen }),
        abschnitt(-0.1),
        [],
      ),
    ).toBe("geprueft");
  });

  it("verwirft nicht mehr, weil der ungesehene Teil kurz ins Minus läuft", () => {
    // Der Fall vom 21.09.: Momentum-Fortsetzung BTC, 85 Handel, +0,11 R, im ungesehenen Teil
    // −0,18 R über 24 Handel — nach der alten Regel `verworfen`.
    const momentum = konfidenz(rWerte(85, 0.39, 1.85));
    expect(
      bewerte(
        kennzahlen({ anzahl: 85, erwartungswertR: 0.11, konfidenz: momentum }),
        abschnitt(-0.18, 24),
        [],
      ),
    ).toBe("geprueft");
    // Auch bei einer belegten Kante hält ein negativer ungesehener Teil nur vom Kandidaten ab.
    expect(bewerte(kennzahlen({ anzahl: 1200, konfidenz: belegt }), abschnitt(-0.1, 24), [])).toBe(
      "geprueft",
    );
  });

  it("zählt den gemeinsamen Topf aller Märkte fürs Urteil", () => {
    const heimat = konfidenz(rWerte(40, 0.4, 2));
    const k = kennzahlen({ anzahl: 40, konfidenz: heimat });
    expect(bewerte(k, abschnitt(0.2), [], vermerk({ gesamtHandel: 1200, gemeinsam: belegt }))).toBe(
      "kandidat",
    );
    expect(
      bewerte(k, abschnitt(0.2), [], vermerk({ gesamtHandel: 1200, gemeinsam: widerlegt })),
    ).toBe("verworfen");
    // Ein Topf ohne Intervall (so lagen Vermerke vor dem 28.09. ab) zählt nicht.
    expect(bewerte(k, abschnitt(0.2), [], vermerk({ gesamtHandel: 1200 }))).toBe("geprueft");
  });

  it("lässt jede Einstufung zum Kandidaten werden — gekennzeichnet, nicht gesperrt", () => {
    // Jakobs Entscheidung vom 2026-09-21: „Es ist auch okay, wenn eine Strategie nur in einem
    // Produkt läuft, muss dann halt so gekennzeichnet sein." Die Übertragbarkeit beschreibt
    // die Regel, sie bewertet sie nicht.
    const k = kennzahlen({ anzahl: 1200, konfidenz: belegt });
    for (const einstufung of ["uebertragbar", "gemischt", "einzelfall"] as const) {
      expect(bewerte(k, abschnitt(0.2), [], vermerk({ einstufung }))).toBe("kandidat");
    }
    // Belegt im eigenen Markt, widerlegt im Topf: ein Einzelfall, und als solcher Kandidat.
    expect(
      bewerte(
        k,
        abschnitt(0.2),
        [],
        vermerk({ einstufung: "einzelfall", gesamtHandel: 1200, gemeinsam: widerlegt }),
      ),
    ).toBe("kandidat");
    expect(bewerte(k, abschnitt(0.2), [])).toBe("kandidat");
  });

  it("hält eine unbelegte Kante bei `geprueft` zurück, auch wenn sonst alles stimmt", () => {
    const unbelegt = konfidenz(rWerte(35, 0.4, 2));
    expect(unbelegt).toBeDefined();
    expect(bewerte(kennzahlen({ anzahl: 35, konfidenz: unbelegt }), abschnitt(0.2), [])).toBe(
      "geprueft",
    );
  });

  it("verlangt vom Kandidaten weiter, dass der Markt selbst trägt", () => {
    const k = (teil: Partial<Kennzahlen> = {}) =>
      kennzahlen({ anzahl: 1200, konfidenz: belegt, ...teil });
    expect(bewerte(k(), abschnitt(0.2), ["irgendwas"])).toBe("geprueft");
    expect(bewerte(k({ erwartungswertR: -0.1 }), abschnitt(0.2), [])).toBe("geprueft");
    expect(bewerte(k(), abschnitt(0.2, 4), [])).toBe("geprueft");
    expect(bewerte(k(), null, [])).toBe("geprueft");
  });

  it("lässt Sharpe, Kaufen-und-liegen-lassen und Rückschlag nur Hinweis sein", () => {
    // Jakob am 28.09.: „eine Strategie ist ein Gewinner, solange sie oft genug greifen kann und
    // insgesamt mehr Plus als Minus erwirtschaftet." Keine abgelegte Strategie kam über Sharpe
    // 0,55, und der Vergleich mit dem Index stand an 17 von 18.
    const k = kennzahlen({ anzahl: 1200, konfidenz: belegt, sharpe: 0.4, maxDrawdownProzent: 40 });
    const handel = [1, -1, 1.2, -1, 0.9, -1].map(
      (r): Handel => ({
        einstiegZeit: 0,
        ausstiegZeit: 1,
        einstieg: 100,
        ausstieg: 100 + r,
        stop: 99,
        ziel: 101,
        grund: r > 0 ? "ziel" : "stop",
        renditeProzent: r,
        r,
        kerzen: 3,
      }),
    );
    const hinweise = warnungenAus(k, abschnitt(0.3), abschnitt(0.3), handel, 500);
    expect(hinweise.some((w) => w.startsWith("Kaufen und liegen lassen"))).toBe(true);
    expect(hinweise.some((w) => w.startsWith("Zwischendurch standen"))).toBe(true);
    expect(bewerte(k, abschnitt(0.3), hinweise)).toBe("kandidat");
    // Die kleine Stichprobe und ihr Intervall prüft `bewerte` selbst — über den Topf, den die
    // Warnungen des einen Marktes nicht kennen.
    const klein = kennzahlen({ anzahl: 25, konfidenz: konfidenz(rWerte(25, 0.4, 2)) });
    const vorbehalte = warnungenAus(klein, abschnitt(0.3), abschnitt(0.3), handel);
    expect(vorbehalte.some((w) => w.startsWith("Nur 25 Handel"))).toBe(true);
    expect(
      bewerte(
        klein,
        abschnitt(0.3),
        vorbehalte,
        vermerk({ gesamtHandel: 1200, gemeinsam: belegt }),
      ),
    ).toBe("kandidat");
    // Der Nullpunkt sperrt weiter: schlägt die Regel den zufälligen Einstieg nicht, ist es die
    // Geometrie, die verdient, nicht die Regel.
    const nullpunkt = warnungenAus(k, abschnitt(0.3), abschnitt(0.3), handel, undefined, {
      trefferquote: 0.5,
      erwartungswertR: 0.5,
    });
    expect(bewerte(k, abschnitt(0.3), nullpunkt)).toBe("geprueft");
  });

  it("urteilt ohne Intervall nicht", () => {
    expect(bewerte(kennzahlen({ anzahl: 1200 }), abschnitt(0.2), [])).toBe("geprueft");
  });

  it("nennt eine Strategie ohne Handel einen Entwurf", () => {
    expect(bewerte(null, null, [])).toBe("entwurf");
    expect(bewerte(kennzahlen({ anzahl: 0 }), null, [])).toBe("entwurf");
  });
});

const STRATEGIE: Strategie = {
  name: "Test: Kurs kreuzt über SMA5",
  richtung: "long",
  einstieg: [
    { links: { art: "kurs" }, vergleich: "kreuzt_ueber", rechts: { art: "sma", periode: 5 } },
  ],
  stopProzent: 2,
  zielProzent: 4,
};

function eintrag(teil: { status?: "entwurf" | "geprueft" | "kandidat" | "verworfen" } = {}) {
  return {
    name: "Test",
    wer: "boerse",
    symbol: "BTC-USD",
    intervall: "1d",
    von: "2020-01-01",
    bis: "2026-01-01",
    strategie: STRATEGIE,
    kennzahlen: null,
    inSample: null,
    outOfSample: null,
    warnungstexte: [],
    bericht: "Test-Bericht.",
    ...teil,
  };
}

/**
 * Das Archiv (2026-09-28, N2): Jakob wollte Strategien und Analysen aus der Liste räumen
 * können, „sonst müllt mir das die Website zu" — archiviert wird nicht gelöscht, `liste()`
 * blendet es nur standardmäßig aus, und Verworfenes räumt sich nach drei Tagen von selbst weg.
 */
describe("Archiv", () => {
  let archiv: StrategienArchiv;
  let ordner: string;

  beforeEach(async () => {
    ordner = await mkdtemp(path.join(tmpdir(), "kuro-strategien-"));
    archiv = createStrategien({ workdir: ordner });
  });

  it("blendet Archiviertes standardmäßig aus, zeigt es aber auf Wunsch", async () => {
    const kopf = await archiv.lege(eintrag());
    const archiviert = await archiv.archiviere(kopf.id);
    expect(archiviert?.archiviert).toBeDefined();
    expect(await archiv.liste(50, false)).toHaveLength(0);
    expect(await archiv.liste(50, true)).toHaveLength(1);
    // Alte Aufrufer (Lernschleife, Chart) lassen `mitArchiv` weg und wollen die volle
    // Geschichte — die Vorgabe darf das Verhalten also nicht ändern.
    expect(await archiv.liste()).toHaveLength(1);
  });

  it("holt aus dem Archiv zurück", async () => {
    const kopf = await archiv.lege(eintrag());
    await archiv.archiviere(kopf.id);
    const zurueck = await archiv.zurueckhole(kopf.id);
    expect(zurueck?.archiviert).toBeUndefined();
    expect(await archiv.liste(50, false)).toHaveLength(1);
  });

  it("gibt null zurück, wenn es die Strategie nicht gibt", async () => {
    expect(await archiv.archiviere("0123456789ab")).toBeNull();
    expect(await archiv.zurueckhole("0123456789ab")).toBeNull();
  });

  it("legt verworfene Strategien erst nach drei Tagen automatisch ins Archiv", async () => {
    const frisch = await archiv.lege(eintrag({ status: "verworfen" }));
    const alt = await archiv.lege(eintrag({ status: "verworfen" }));
    const geprueft = await archiv.lege(eintrag({ status: "geprueft" }));

    // `alt` künstlich auf vier Tage zurückdatieren — nur `lege()` selbst setzt `zeit`.
    const pfad = path.join(ordner, "strategien");
    const dateiname = (await readdir(pfad)).find((d) => d.endsWith(`-${alt.id}.json`));
    if (!dateiname) throw new Error("Datei nicht gefunden.");
    const roh = JSON.parse(await readFile(path.join(pfad, dateiname), "utf8"));
    roh.zeit = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
    await writeFile(path.join(pfad, dateiname), `${JSON.stringify(roh, null, 2)}\n`, "utf8");

    const anzahl = await archiv.archiviereAlte();
    expect(anzahl).toBe(1);
    expect((await archiv.lies(alt.id))?.archiviert).toBeDefined();
    expect((await archiv.lies(frisch.id))?.archiviert).toBeUndefined();
    expect((await archiv.lies(geprueft.id))?.archiviert).toBeUndefined();
  });
});
