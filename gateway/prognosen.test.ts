import { describe, expect, it } from "vitest";
import type { MarketCandle } from "./integrations/markets.js";
import {
  BELASTBAR_AB,
  type Benotung,
  type Prognose,
  akte,
  benote,
  formatiereAkte,
  verfolge,
} from "./prognosen.js";

const TAG = 86_400;
/** 2026-09-01T00:00:00Z — der Tag, an dem in diesen Tests abgelegt wird. */
const START = Date.parse("2026-09-01T00:00:00Z") / 1000;

interface Roh {
  o: number;
  h: number;
  l: number;
  c: number;
}

/** Kerzen ab dem Ablagetag, eine je Tag. */
function reihe(rohe: readonly Roh[], abTag = 0): MarketCandle[] {
  return rohe.map((r, i) => ({
    time: START + (abTag + i) * TAG,
    open: r.o,
    high: r.h,
    low: r.l,
    close: r.c,
  }));
}

function idee(zusatz: Partial<Prognose> = {}): Prognose {
  return {
    id: "test-1",
    angelegt: "2026-09-01T00:00:00Z",
    von: "boerse",
    symbol: "BTC-USD",
    richtung: "long",
    ausloeser: 82_000,
    fristTage: 30,
    stop: 78_900,
    ziele: [90_000, 93_600],
    ...zusatz,
  };
}

describe("verfolge", () => {
  it("füllt am Auslöser und läuft ins Ziel", () => {
    const v = verfolge(
      idee(),
      reihe([
        { o: 85_000, h: 86_000, l: 84_000, c: 85_500 },
        { o: 84_000, h: 84_500, l: 81_500, c: 82_500 }, // berührt 82.000
        { o: 83_000, h: 91_000, l: 82_800, c: 90_500 }, // Ziel
      ]),
    );
    expect(v.stand).toBe("ziel");
    expect(v.einstieg).toBe(82_000);
    expect(v.ausstieg).toBe(90_000);
    expect(v.haltedauerTage).toBe(1);
    // (90.000 − 82.000) / (82.000 − 78.900) = 2,58 R — dasselbe wie das CRV verspricht.
    expect(v.r).toBeCloseTo(2.58, 2);
  });

  it("gibt der Grenzorder den besseren Kurs, wenn die Kerze darunter eröffnet", () => {
    // Eine ruhende Kauforder bei 82.000 bekommt bei Eröffnung 80.000 eben 80.000. Das ist kein
    // Schönrechnen, sondern was passiert wäre — und es verschiebt das Ergebnis in R spürbar.
    const v = verfolge(idee(), reihe([{ o: 80_000, h: 90_500, l: 79_500, c: 90_200 }]));
    expect(v.einstieg).toBe(80_000);
    expect(v.stand).toBe("ziel");
    expect(v.r).toBeCloseTo((90_000 - 80_000) / 3_100, 2);
  });

  it("lässt den Stop das Ziel schlagen, wenn beide in derselben Kerze liegen", () => {
    const v = verfolge(
      idee(),
      reihe([
        { o: 83_000, h: 83_500, l: 81_900, c: 82_100 },
        { o: 82_200, h: 91_000, l: 78_000, c: 80_000 }, // Ziel und Stop am selben Tag
      ]),
    );
    expect(v.stand).toBe("stop");
    expect(v.r).toBeCloseTo(-1, 2);
  });

  it("erkennt den übersprungenen Stop und rechnet den größeren Verlust", () => {
    const v = verfolge(
      idee(),
      reihe([
        { o: 83_000, h: 83_500, l: 81_900, c: 82_100 },
        { o: 74_000, h: 75_000, l: 73_000, c: 73_500 }, // Eröffnung schon unter dem Stop
      ]),
    );
    expect(v.stand).toBe("stop");
    expect(v.stopUebersprungen).toBe(true);
    expect(v.ausstieg).toBe(74_000);
    // (74.000 − 82.000) / 3.100 = −2,58 R statt der gerechneten −1 R.
    expect(v.r).toBeCloseTo(-2.58, 2);
  });

  it("lässt die Idee verfallen, wenn der Auslöser binnen Frist nicht kommt", () => {
    const v = verfolge(
      idee({ fristTage: 5 }),
      reihe(Array.from({ length: 8 }, () => ({ o: 86_000, h: 87_000, l: 85_000, c: 86_500 }))),
    );
    expect(v.stand).toBe("verfallen");
    expect(v.einstieg).toBeNull();
    expect(v.r).toBeNull();
  });

  it("ignoriert Kerzen von vor der Ablage", () => {
    // Ein Rücksetzer auf 82.000 letzte Woche ist kein Einstieg für eine Idee von heute.
    const v = verfolge(idee(), reihe([{ o: 82_000, h: 82_500, l: 80_000, c: 81_000 }], -5));
    expect(v.stand).toBe("wartet");
    expect(v.einstieg).toBeNull();
  });
});

function note(b: Benotung, art: string) {
  const n = b.noten.find((x) => x.art === art);
  if (!n) throw new Error(`keine Note "${art}"`);
  return n;
}

describe("benote", () => {
  const kerzen = reihe([
    { o: 83_000, h: 83_500, l: 81_900, c: 82_100 },
    { o: 82_200, h: 91_000, l: 82_000, c: 90_500 },
  ]);

  it("rechnet das behauptete CRV nach und lässt einen falschen Wert durchfallen", () => {
    const gut = benote(idee({ crvBehauptet: [2.58, 3.74] }), kerzen);
    expect(note(gut, "crv").zutreffend).toBe(true);

    const schlecht = benote(idee({ crvBehauptet: [4.2] }), kerzen);
    expect(note(schlecht, "crv").zutreffend).toBe(false);
    expect(note(schlecht, "crv").eingetreten).toContain("2,58");
  });

  it("benotet nicht, was noch nicht entschieden ist", () => {
    // Nur eine Kerze, die den Auslöser nicht berührt: nichts ist eingetreten, also ist auch
    // nichts falsch. `null` heißt offen — niemals „gut genug".
    const b = benote(idee(), reihe([{ o: 86_000, h: 87_000, l: 85_000, c: 86_500 }]));
    expect(note(b, "ausloeser").zutreffend).toBeNull();
    expect(note(b, "ziel").zutreffend).toBeNull();
    expect(note(b, "stop").zutreffend).toBeNull();
  });

  it("hält fest, dass die Idee nie zustande kam", () => {
    const b = benote(
      idee({ fristTage: 3 }),
      reihe(Array.from({ length: 6 }, () => ({ o: 86_000, h: 87_000, l: 85_500, c: 86_500 }))),
    );
    expect(note(b, "ausloeser").zutreffend).toBe(false);
    expect(note(b, "ausloeser").eingetreten).toContain("nie zustande");
  });

  it("prüft die Haltedauer gegen die genannte Spanne", () => {
    const b = benote(idee({ haltedauerSpanneTage: [4, 23] }), kerzen);
    // Aufgelöst nach einem Tag — schneller als behauptet, also nicht zutreffend.
    expect(note(b, "haltedauer").zutreffend).toBe(false);
    expect(note(b, "haltedauer").eingetreten).toBe("1 Tage");
  });

  it("rechnet die Baseline über dasselbe Fenster, aus dem die Behauptung stammt", () => {
    // Der Fall, der das Werkzeug beim ersten Einsatz fast zum Lügner gemacht hätte: `crv`
    // misst die Baseline über 6 Monate. Wer sie über zwei Jahre nachrechnet, bekommt eine
    // andere Zahl und schreibt dem Analysten einen Fehler zu, den er nicht gemacht hat.
    //
    // Hier steigt der Kurs im ersten Jahr ruhig und fällt im letzten halben Jahr — beide
    // Fenster ergeben darum verschiedene Trefferquoten für dieselbe Geometrie.
    const alt: MarketCandle[] = [];
    for (let i = 400; i > 180; i--) {
      const c = 100 + (400 - i) * 0.3;
      alt.push({ time: START - i * TAG, open: c, high: c + 3, low: c - 3, close: c });
    }
    const neu: MarketCandle[] = [];
    for (let i = 180; i > 0; i--) {
      const c = 160 - (180 - i) * 0.3;
      neu.push({ time: START - i * TAG, open: c, high: c + 3, low: c - 3, close: c });
    }
    const p = idee({ ausloeser: 110, stop: 104, ziele: [122], baselineBehauptet: 50 });
    const kurz = benote(p, [...alt, ...neu]);
    const lang = benote({ ...p, baselineFensterTage: 400 }, [...alt, ...neu]);
    expect(note(kurz, "baseline").eingetreten).toContain("180 Tage");
    expect(note(lang, "baseline").eingetreten).toContain("400 Tage");
    expect(note(kurz, "baseline").eingetreten).not.toBe(note(lang, "baseline").eingetreten);
  });

  it("sagt bei der Baseline, wenn die Kursgeschichte für das Nachrechnen fehlt", () => {
    const b = benote(idee({ baselineBehauptet: 41 }), kerzen);
    expect(note(b, "baseline").zutreffend).toBeNull();
    expect(note(b, "baseline").eingetreten).toContain("nicht nachrechenbar");
  });

  it("nimmt das Widerlegungskriterium auf, ohne es zu benoten", () => {
    const b = benote(idee({ widerlegtWenn: "Schlusskurs unter 78.900" }), kerzen);
    expect(note(b, "widerlegt-wenn").zutreffend).toBeNull();
    expect(note(b, "widerlegt-wenn").behauptet).toContain("78.900");
  });
});

describe("akte", () => {
  const kerzenZiel = reihe([
    { o: 83_000, h: 83_500, l: 81_900, c: 82_100 },
    { o: 82_200, h: 91_000, l: 82_000, c: 90_500 },
  ]);
  const kerzenNichts = reihe(
    Array.from({ length: 40 }, () => ({ o: 86_000, h: 87_000, l: 85_500, c: 86_500 })),
  );

  it("zählt je Behauptungsart getrennt", () => {
    const b = [
      benote(idee({ id: "a", crvBehauptet: [2.58] }), kerzenZiel),
      benote(idee({ id: "b", crvBehauptet: [9] }), kerzenZiel),
      benote(idee({ id: "c", crvBehauptet: [2.58] }), kerzenNichts),
    ];
    const a = akte("boerse", b);
    expect(a.prognosen).toBe(3);
    expect(a.aufgeloest).toBe(2);
    expect(a.verfallen).toBe(1);

    const crv = a.zeilen.find((z) => z.art === "crv");
    expect(crv).toEqual({ art: "crv", geprueft: 3, zutreffend: 2 });
    const ausloeser = a.zeilen.find((z) => z.art === "ausloeser");
    // Zweimal erreicht, einmal verfallen — alle drei entscheidbar.
    expect(ausloeser).toEqual({ art: "ausloeser", geprueft: 3, zutreffend: 2 });
  });

  it("nennt das Ergebnis in R, sagt aber dazu, dass es noch keine Aussage ist", () => {
    const a = akte("boerse", [benote(idee(), kerzenZiel)]);
    expect(a.belastbar).toBe(false);
    const text = formatiereAkte(a);
    expect(text).toContain("noch keine Aussage");
    expect(text).toContain(String(BELASTBAR_AB));
  });

  it("zählt nur die Prognosen dessen, um den es geht", () => {
    const b = [
      benote(idee({ id: "a", von: "boerse" }), kerzenZiel),
      benote(idee({ id: "b", von: "technik" }), kerzenZiel),
    ];
    expect(akte("boerse", b).prognosen).toBe(1);
    expect(akte("technik", b).prognosen).toBe(1);
  });
});
