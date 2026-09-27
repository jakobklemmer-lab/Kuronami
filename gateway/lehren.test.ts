import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LehrFehler,
  type Lehre,
  MAX_AKTIV,
  ausBenotungen,
  ausGegenproben,
  createLehren,
  faellige,
  faelligeStrategien,
  lehrenAnhang,
  leseVorschlag,
  wilson,
  wirkung,
} from "./lehren.js";
import type { Benotung, Prognose, PrognoseStand, Prognosenbuch } from "./prognosen.js";
import type { StrategieEintrag, StrategieKopf, StrategienArchiv } from "./strategien.js";

function benotung(
  id: string,
  stand: PrognoseStand,
  noten: Array<[string, boolean | null]>,
  von = "boerse",
): Benotung {
  return {
    prognoseId: id,
    von,
    symbol: "BTC-USD",
    geprueftAm: "2026-09-27T10:00:00Z",
    verlauf: {
      stand,
      standKerze: null,
      ausloeserAm: null,
      ausloeserNachTagen: null,
      einstieg: null,
      ausstiegAm: null,
      ausstieg: null,
      haltedauerTage: null,
      stopUebersprungen: false,
      r: stand === "stop" ? -1 : stand === "ziel" ? 2 : null,
    },
    noten: noten.map(([art, zutreffend]) => ({
      art,
      frage: "",
      behauptet: "",
      eingetreten: "",
      zutreffend,
    })),
  };
}

function prognose(id: string, angelegt: string): Prognose {
  return {
    id,
    angelegt,
    von: "boerse",
    symbol: "BTC-USD",
    richtung: "long",
    ausloeser: 82_000,
    fristTage: 30,
    stop: 78_900,
    ziele: [90_000],
  };
}

describe("faellige", () => {
  it("nimmt nur Aufgelöstes, nichts von Jakob, nichts Erledigtes", () => {
    const alle = [
      benotung("a", "stop", []),
      benotung("b", "wartet", []),
      benotung("c", "ziel", [], "jakob"),
      benotung("d", "verfallen", []),
      benotung("e", "ziel", []),
    ];
    const erledigt = { e: { am: "", ergebnis: "keine" as const, versuche: 1 } };
    expect(faellige(alle, erledigt).map((b) => b.prognoseId)).toEqual(["a", "d"]);
  });

  it("versucht es nach einem Fehler wieder, aber nicht endlos", () => {
    const alle = [benotung("a", "stop", [])];
    expect(faellige(alle, { a: { am: "", ergebnis: "fehler", versuche: 2 } })).toHaveLength(1);
    expect(faellige(alle, { a: { am: "", ergebnis: "fehler", versuche: 3 } })).toHaveLength(0);
  });
});

describe("leseVorschlag", () => {
  it("liest eine Lehre, auch mit Satz oder Codeblock drumherum", () => {
    const v = leseVorschlag(
      'Hier:\n```json\n{"lehre": {"art": "ausloeser", "text": "Näher setzen.", "begruendung": "2 von 5."}}\n```',
    );
    expect(v).toEqual({
      lehre: { art: "ausloeser", text: "Näher setzen.", begruendung: "2 von 5." },
    });
  });

  it("nimmt „keine Lehre“ mit Grund", () => {
    expect(leseVorschlag('{"lehre": null, "grund": "Pech, alle Aussagen trafen zu."}')).toEqual({
      lehre: null,
      grund: "Pech, alle Aussagen trafen zu.",
    });
  });

  it("weist ab, was sich nie messen ließe", () => {
    expect(() => leseVorschlag('{"lehre": {"art": "gefuehl", "text": "x"}}')).toThrow(LehrFehler);
    expect(() => leseVorschlag('{"lehre": {"art": "stop", "text": "  "}}')).toThrow(LehrFehler);
    expect(() => leseVorschlag("Ich finde, man sollte …")).toThrow(LehrFehler);
  });
});

describe("wilson", () => {
  it("bleibt bei kleinen Zahlen zwischen 0 und 1 und ist ehrlich breit", () => {
    const [unten, oben] = wilson(5, 5);
    expect(oben).toBe(1);
    expect(unten).toBeCloseTo(0.566, 2);
    expect(wilson(0, 0)).toEqual([0, 1]);
  });
});

describe("wirkung", () => {
  const lehre = (art: Lehre["art"]): Lehre => ({
    id: "l",
    angelegt: "2026-09-01T00:00:00Z",
    an: "boerse",
    art,
    text: "x",
    begruendung: "",
    quelle: { prognoseId: "p0", symbol: "X", stand: "stop", r: -1, noten: [] },
    status: "aktiv",
    aktivSeit: "2026-10-01T00:00:00Z",
  });
  const vorher = ["v1", "v2", "v3", "v4", "v5", "v6"].map((id, i) =>
    benotung(id, "stop", [["ausloeser", i === 0]]),
  );
  const zeiten = new Map<string, string>(vorher.map((b) => [b.prognoseId, "2026-09-15T00:00:00Z"]));
  const danach = (treffer: boolean[]) =>
    treffer.map((t, i) => {
      zeiten.set(`n${i}`, "2026-10-10T00:00:00Z");
      return benotung(`n${i}`, "ziel", [["ausloeser", t]]);
    });

  it("sagt nichts, solange die Stückzahl nicht trägt", () => {
    const w = wirkung(
      lehre("ausloeser"),
      ausBenotungen([...vorher, ...danach([true, true])], zeiten),
    );
    expect(w?.urteil).toBe("noch-keine-aussage");
    expect(w?.seitdem).toEqual({ geprueft: 2, zutreffend: 2 });
  });

  it("nennt es Wirkung erst, wenn die alte Quote unter der neuen Spanne liegt", () => {
    // vorher 1 von 6 (17 %), danach 5 von 5 — die Spanne beginnt bei 57 %.
    const w = wirkung(
      lehre("ausloeser"),
      ausBenotungen([...vorher, ...danach([true, true, true, true, true])], zeiten),
    );
    expect(w?.urteil).toBe("wirkt");
    // danach 2 von 5 — 40 %, aber die Spanne reicht bis unter 17 %.
    const z = wirkung(
      lehre("ausloeser"),
      ausBenotungen([...vorher, ...danach([true, true, false, false, false])], zeiten),
    );
    expect(z?.urteil).toBe("nicht-unterscheidbar");
  });

  it("misst eine allgemeine Lehre nicht", () => {
    expect(wirkung(lehre("allgemein"), ausBenotungen(vorher, zeiten))?.urteil).toBe(
      "nicht-messbar",
    );
  });
});

describe("das Lehrbuch", () => {
  let ordner = "";
  afterEach(async () => {
    if (ordner) await rm(ordner, { recursive: true, force: true });
  });

  async function buch(antworten: string[]) {
    ordner = await mkdtemp(path.join(tmpdir(), "lehren-"));
    const prognosen = [
      prognose("p1", "2026-09-20T08:00:00Z"),
      prognose("p2", "2026-09-21T08:00:00Z"),
    ];
    const benotungen = [
      benotung("p1", "verfallen", [
        ["ausloeser", false],
        ["crv", true],
      ]),
      benotung("p2", "stop", [
        ["ausloeser", true],
        ["stop", true],
      ]),
    ];
    const gefragt: string[] = [];
    const fake = { liste: async () => prognosen, pruefeAlle: async () => benotungen };
    const lehren = createLehren({
      workdir: ordner,
      prognosen: fake as unknown as Prognosenbuch,
      schreibe: async (_system, prompt, _wer) => {
        gefragt.push(prompt);
        const a = antworten.shift();
        if (a === undefined) throw new Error("kein Modell");
        return a;
      },
      jetzt: () => new Date("2026-09-27T10:00:00Z"),
    });
    return { lehren, gefragt };
  }

  it("betrachtet jede aufgelöste Prognose einmal und legt Vorschläge ab", async () => {
    const { lehren, gefragt } = await buch([
      '{"lehre": {"art": "ausloeser", "text": "Auslöser höchstens 1 ATR vom Kurs.", "begruendung": "verfallen"}}',
      '{"lehre": null, "grund": "Stop hielt wie geplant — Pech."}',
    ]);
    const neue = await lehren.nachbetrachte();
    expect(neue).toHaveLength(1);
    expect(neue[0]).toMatchObject({ status: "vorgeschlagen", art: "ausloeser", an: "boerse" });
    expect(gefragt[0]).toContain("Deine Akte");
    const protokoll = await lehren.protokoll();
    expect(protokoll.p1?.ergebnis).toBe("lehre");
    expect(protokoll.p2?.ergebnis).toBe("keine");
    // Ein zweiter Takt fragt niemanden mehr.
    expect(await lehren.nachbetrachte()).toHaveLength(0);
    expect(gefragt).toHaveLength(2);
    // Vorgeschlagen ist nicht geltend.
    expect(await lehren.anhang("boerse")).toBe("");
  });

  it("gibt frei, auch mit geändertem Wortlaut, und nur bis zur Obergrenze", async () => {
    const { lehren } = await buch([
      '{"lehre": {"art": "ausloeser", "text": "Näher.", "begruendung": ""}}',
      '{"lehre": null, "grund": "-"}',
    ]);
    const [l] = await lehren.nachbetrachte();
    if (!l) throw new Error("keine Lehre");
    const frei = await lehren.entscheide(l.id, { status: "aktiv", text: "Auslöser näher setzen." });
    expect(frei).toMatchObject({
      status: "aktiv",
      text: "Auslöser näher setzen.",
      vorschlag: "Näher.",
    });
    expect(frei?.aktivSeit).toBe("2026-09-27T10:00:00.000Z");
    expect(await lehren.anhang("boerse")).toContain("Auslöser näher setzen.");
    await expect(lehren.entscheide(l.id, { status: "verworfen" })).rejects.toThrow(LehrFehler);
    await expect(lehren.entscheide(l.id, { status: "aktiv", text: "anders" })).rejects.toThrow(
      "nur beim Freigeben",
    );
    expect(await lehren.entscheide(l.id, { status: "abgelegt" })).toMatchObject({
      status: "abgelegt",
    });
    expect(await lehren.anhang("boerse")).toBe("");
    expect(MAX_AKTIV).toBeGreaterThan(0);
  });

  it("merkt sich einen Fehler und versucht es beim nächsten Takt wieder", async () => {
    const { lehren } = await buch([
      "kein JSON hier",
      '{"lehre": null, "grund": "-"}',
      '{"lehre": null, "grund": "Beim zweiten Mal ordentlich."}',
    ]);
    await lehren.nachbetrachte();
    const erst = await lehren.protokoll();
    expect(erst.p1).toMatchObject({ ergebnis: "fehler", versuche: 1 });
    await lehren.nachbetrachte();
    expect((await lehren.protokoll()).p1?.ergebnis).not.toBe("fehler");
  });
});

describe("lehrenAnhang", () => {
  it("steht nur da, wenn etwas gilt", () => {
    expect(lehrenAnhang([])).toBe("");
  });
});

describe("der Stratege lernt aus der Gegenprobe", () => {
  let ordner = "";
  afterEach(async () => {
    if (ordner) await rm(ordner, { recursive: true, force: true });
  });

  const kopf = (id: string, zeit: string, einstufung?: "robust" | "fragil"): StrategieKopf =>
    ({
      id,
      zeit,
      name: `Regel ${id}`,
      wer: "stratege",
      symbol: "^GDAXI",
      intervall: "1d",
      von: "2018-01-02",
      bis: "2026-09-01",
      status: "geprueft",
      kennzahlen: null,
      warnungen: 0,
      ...(einstufung
        ? {
            gegenprobe: {
              am: `${zeit.slice(0, 10)}T12:00:00Z`,
              einstufung,
              tragfaehig: einstufung === "robust" ? 4 : 1,
              gepruefte: 4,
              maerkte: [],
              tabelle: "Variante … behält",
            },
          }
        : {}),
    }) as StrategieKopf;

  it("nimmt nur gegengeprüfte Strategien, und jede Gegenprobe einmal", () => {
    const koepfe = [kopf("a", "2026-09-20T00:00:00Z", "fragil"), kopf("b", "2026-09-20T00:00:00Z")];
    expect(faelligeStrategien(koepfe, {}).map((k) => k.id)).toEqual(["a"]);
    expect(
      faelligeStrategien(koepfe, {
        "strategie:a@2026-09-20T12:00:00Z": { am: "", ergebnis: "keine", versuche: 1 },
      }),
    ).toEqual([]);
  });

  it("zählt robuste Gegenproben vor und nach der Freigabe", () => {
    const koepfe = [
      ...["1", "2", "3", "4"].map((i) =>
        kopf(i, "2026-09-10T00:00:00Z", i === "1" ? "robust" : "fragil"),
      ),
      ...["5", "6", "7", "8", "9"].map((i) => kopf(i, "2026-10-10T00:00:00Z", "robust")),
    ];
    const l = {
      id: "l",
      angelegt: "2026-09-30T00:00:00Z",
      an: "stratege",
      art: "gegenprobe",
      text: "x",
      begruendung: "",
      quelle: { strategieId: "a", symbol: "X", stand: "fragil", r: null, noten: [] },
      status: "aktiv",
      aktivSeit: "2026-10-01T00:00:00Z",
    } as const;
    const w = wirkung({ ...l, quelle: { ...l.quelle, noten: [] } }, ausGegenproben(koepfe));
    expect(w?.vorher).toEqual({ geprueft: 4, zutreffend: 1 });
    expect(w?.seitdem).toEqual({ geprueft: 5, zutreffend: 5 });
    expect(w?.urteil).toBe("wirkt");
  });

  it("legt eine Lehre an den Strategen ab, mit der Gegenprobe als Quelle", async () => {
    ordner = await mkdtemp(path.join(tmpdir(), "lehren-"));
    const k = kopf("a", "2026-09-20T00:00:00Z", "fragil");
    const eintrag = {
      ...k,
      strategie: { regel: "sma" },
      inSample: null,
      outOfSample: null,
      warnungstexte: [],
      bericht: "",
    } as unknown as StrategieEintrag;
    const strategien = {
      liste: async () => [k],
      lies: async () => eintrag,
    } as unknown as StrategienArchiv;
    const wer: string[] = [];
    const lehren = createLehren({
      workdir: ordner,
      prognosen: { liste: async () => [], pruefeAlle: async () => [] } as unknown as Prognosenbuch,
      strategien,
      schreibe: async (_s, prompt, w) => {
        wer.push(w);
        expect(prompt).toContain("fragil: 1 von 4 Varianten tragen");
        return '{"lehre": {"art": "gegenprobe", "text": "Keine Nadelspitzen ablegen.", "begruendung": "1 von 4"}}';
      },
    });
    const [neu] = await lehren.nachbetrachte();
    expect(wer).toEqual(["stratege"]);
    expect(neu).toMatchObject({
      an: "stratege",
      art: "gegenprobe",
      quelle: { strategieId: "a", stand: "fragil" },
    });
    // Dieselbe Gegenprobe wird nicht zweimal betrachtet.
    expect(await lehren.nachbetrachte()).toEqual([]);
  });
});
