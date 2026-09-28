import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AboStand } from "./abo.js";
import {
  AboGrenzeFehler,
  FEHLVERSUCHE,
  JE_NACHT,
  LehrgangFehler,
  type Versuch,
  createLehrgang,
  fehlversuche,
  leseNotiz,
  notizMarkdown,
  reihenfolge,
  transkriptText,
  verlinkeZeitmarken,
  warumNichtAbo,
  warumNichtJetzt,
  zeitmarke,
} from "./lehrgang.js";
import { type Transkript, type Video, createWissen } from "./wissen.js";

// Nachgebildet aus einer echten Antwort im Stil des MACD-Videos (rf_EQvubKlk).
const ANTWORT = `<begriffe>
- MACD: Indikator aus gleitenden Durchschnitten, zeigt Trends. [0:16]
</begriffe>
<regeln>
- Long nur, wenn die MACD-Linie die Signallinie unter der Nulllinie nach oben kreuzt. [2:24–2:35]
  Wortlaut: "only take buy signals below the zero line"
  Parameter: MACD 12/26/9, Zeitrahmen nicht genannt
  mechanisch prüfbar: ja — Kreuzung und Nulllinie sind Kursdaten.
- Nur mit dem Trend: Kurs über dem 200er-Durchschnitt. [3:19]
  **mechanisch prüfbar:** teils — ob EMA oder SMA, sagt das Video nicht.
- Nur an einer Unterstützung einsteigen. [5:48]
  mechanisch prüfbar: nein — die Zone wird eingezeichnet.
</regeln>
<beispiele>
keine
</beispiele>
<warnungen>
- Nie gegen den Trend handeln. [3:40]
</warnungen>
<behauptungen>
- „86% win rate" im Titel — keine Grundlage genannt.
</behauptungen>
<fehlt>
- [5:55] Die Unterstützungslinie wird nur gezeigt.
</fehlt>`;

describe("leseNotiz", () => {
  it("liest alle sechs Abschnitte und je Regel die Prüfbarkeit", () => {
    const n = leseNotiz(ANTWORT);
    expect(n.fehlend).toEqual([]);
    expect(n.abschnitte.begriffe).toMatch(/^- MACD/);
    expect(n.abschnitte.beispiele).toBe("");
    expect(n.pruefbar).toEqual(["ja", "teils", "nein"]);
  });

  it("verkraftet eine fehlende Schlussmarke und nennt fehlende Abschnitte", () => {
    const n = leseNotiz(
      "<regeln>\n1. Stop unter dem Swing-Tief. [1:00]\n2. Ziel 2R.\n<warnungen>\nkeine.",
    );
    expect(n.abschnitte.regeln).toBe("1. Stop unter dem Swing-Tief. [1:00]\n2. Ziel 2R.");
    expect(n.abschnitte.warnungen).toBe("");
    expect(n.pruefbar).toEqual([null, null]);
    expect(n.fehlend).toEqual(["begriffe", "beispiele", "behauptungen", "fehlt"]);
  });

  it("weist eine Antwort ohne Regeln ab — und eine ohne jede Markierung mit ihrem Anfang", () => {
    expect(() => leseNotiz("<begriffe>x</begriffe>")).toThrow("ohne <regeln>");
    expect(() => leseNotiz("Here are my notes: …")).toThrow(/ohne ihre Markierungen: „Here/);
    expect(() => leseNotiz("")).toThrow(LehrgangFehler);
  });

  it("erkennt die Grenzmeldung des Abos als solche, nicht als kaputte Notiz", () => {
    expect(() => leseNotiz("You've hit your session limit · resets 5:20pm (UTC)")).toThrow(
      AboGrenzeFehler,
    );
  });
});

describe("Zeitmarken", () => {
  it("schreibt Sekunden als m:ss oder h:mm:ss", () => {
    expect(zeitmarke(0)).toBe("0:00");
    expect(zeitmarke(83.7)).toBe("1:23");
    expect(zeitmarke(3723)).toBe("1:02:03");
  });

  it("macht Marken und Spannen zu Links an die Stelle, bestehende Links bleiben", () => {
    expect(verlinkeZeitmarken("Regel [3:19] und [2:24–2:35].", "rf_EQvubKlk")).toBe(
      "Regel [3:19](https://youtu.be/rf_EQvubKlk?t=199) und [2:24–2:35](https://youtu.be/rf_EQvubKlk?t=144).",
    );
    expect(verlinkeZeitmarken("[1:02:03]", "x")).toBe("[1:02:03](https://youtu.be/x?t=3723)");
    const link = "[0:10](https://youtu.be/x?t=10)";
    expect(verlinkeZeitmarken(link, "x")).toBe(link);
  });

  it("fasst das Transkript in Absätze von gut zwanzig Sekunden", () => {
    const t: Transkript = {
      id: "rf_EQvubKlk",
      titel: "t",
      sprache: "en",
      art: "manuell",
      geholt: "",
      segmente: [
        { start: 0, text: "a" },
        { start: 7, text: "b" },
        { start: 21.5, text: "c" },
        { start: 30, text: "d" },
        { start: 62, text: "e" },
      ],
    };
    expect(transkriptText(t)).toBe("[0:00] a b\n[0:21] c d\n[1:02] e");
  });
});

describe("notizMarkdown", () => {
  it("setzt Kopf, Überschriften und Links; leere Abschnitte heißen „keine“", () => {
    const md = notizMarkdown({
      video: { id: "rf_EQvubKlk", titel: "BEST MACD", dauer: 426, kalibrierung: true },
      transkript: {
        id: "rf_EQvubKlk",
        titel: "BEST MACD",
        sprache: "en",
        art: "manuell",
        geholt: "",
        segmente: [{ start: 0, text: "x" }],
      },
      notiz: leseNotiz(ANTWORT),
      modell: "Sonnet",
      zeit: new Date("2026-09-28T23:12:00Z"),
    });
    expect(md).toMatch(/^# BEST MACD\n/);
    expect(md).toContain(
      "https://www.youtube.com/watch?v=rf_EQvubKlk) · 7:06 · Kalibrierungsvideo",
    );
    // 23:12 UTC ist in Wien schon der nächste Tag.
    expect(md).toContain("**Durchgearbeitet:** 29.09.2026 01:12 (Wien), Sonnet");
    expect(md).toContain("**Regeln:** 3 — mechanisch prüfbar: 1 ja · 1 teils · 1 nein");
    expect(md).toContain("## Beispiele\n\n_keine_");
    expect(md).toContain("[3:19](https://youtu.be/rf_EQvubKlk?t=199)");
  });
});

// ------------------------------------------------------------------------------ Wann und was

/** 01:30 Wiener Sommerzeit. */
const NACHT = new Date("2026-09-28T23:30:00Z");

const abo = (sitzung: number, woche = 10): Extract<AboStand, { verfuegbar: true }> => ({
  verfuegbar: true,
  plan: "pro",
  fenster: [
    { id: "sitzung", name: "Sitzung", prozent: sitzung, zurueck: null, warnung: false },
    { id: "woche", name: "Woche", prozent: woche, zurueck: null, warnung: false },
  ],
  aufteilung: [],
  zusatz: false,
  stand: NACHT.toISOString(),
});

const versuch = (id: string, zeit: string, ok = true, extra: Partial<Versuch> = {}): Versuch => ({
  id,
  zeit,
  ok,
  ...extra,
});

describe("warumNichtJetzt", () => {
  it("arbeitet nur zwischen eins und sechs Uhr Wiener Zeit", () => {
    expect(warumNichtJetzt(new Date("2026-09-28T22:59:00Z"), [])).toBe("ruht bis 1:00 Uhr");
    expect(warumNichtJetzt(new Date("2026-09-28T23:00:00Z"), [])).toBeNull();
    expect(warumNichtJetzt(new Date("2026-09-29T03:59:00Z"), [])).toBeNull();
    expect(warumNichtJetzt(new Date("2026-09-29T04:00:00Z"), [])).toBe("ruht bis 1:00 Uhr");
  });

  it(`hört nach ${JE_NACHT} Versuchen in dieser Nacht auf; frühere Nächte zählen nicht`, () => {
    const heute = Array.from({ length: JE_NACHT - 1 }, (_, i) =>
      versuch(`v${i}`, "2026-09-28T23:10:00Z", i % 2 === 0),
    );
    const gestern = Array.from({ length: 20 }, () => versuch("alt", "2026-09-27T23:10:00Z"));
    expect(warumNichtJetzt(NACHT, [...gestern, ...heute])).toBeNull();
    // Gescheiterte zählen mit — auch sie haben gekostet.
    const voll = [...heute, versuch("x", "2026-09-28T23:20:00Z", false)];
    expect(warumNichtJetzt(NACHT, voll)).toMatch(`${JE_NACHT} Videos`);
  });
});

describe("warumNichtAbo", () => {
  it("lernt nur unter 70 % Sitzung und 85 % Woche", () => {
    expect(warumNichtAbo(abo(69.9))).toBeNull();
    expect(warumNichtAbo(abo(70))).toBe("Sitzungsfenster bei 70 % (Grenze 70 %)");
    expect(warumNichtAbo(abo(10, 85))).toBe("Wochenfenster bei 85 % (Grenze 85 %)");
  });

  it("lernt nicht, wenn der Stand fehlt", () => {
    expect(
      warumNichtAbo({ verfuegbar: false, grund: "kein Netz", stand: NACHT.toISOString() }),
    ).toBe("Abo-Stand nicht lesbar (kein Netz)");
    expect(warumNichtAbo({ ...abo(0), fenster: [] })).toBe("Abo-Stand ohne Sitzungsfenster");
  });
});

describe("reihenfolge und fehlversuche", () => {
  const liste: Video[] = [
    { id: "a", titel: "A", dauer: 60 },
    { id: "k1", titel: "K1", dauer: 60, kalibrierung: true },
    { id: "b", titel: "B", dauer: 60 },
    { id: "k2", titel: "K2", dauer: 60, kalibrierung: true },
  ];

  it("nimmt Kalibrierungsvideos zuerst und lässt Notiertes aus", () => {
    expect(reihenfolge(liste, new Set(["k1"]), []).map((v) => v.id)).toEqual(["k2", "a", "b"]);
  });

  it(`überspringt ein Video nach ${FEHLVERSUCHE} Fehlschlägen; die Abo-Grenze zählt nicht`, () => {
    const v = [
      versuch("k1", "t1", false),
      versuch("k1", "t2", false, { grenze: true }),
      versuch("k2", "t3", false),
      versuch("k2", "t4", true),
      versuch("k2", "t5", false),
    ];
    expect(fehlversuche("k1", v)).toBe(1);
    // Nach einer gelungenen Notiz beginnt die Zählung neu.
    expect(fehlversuche("k2", v)).toBe(1);
    const zweimal = [...v, versuch("k1", "t6", false)];
    expect(reihenfolge(liste, new Set(), zweimal).map((x) => x.id)).toEqual(["k2", "a", "b"]);
  });
});

// ------------------------------------------------------------------------------ Der Takt

async function aufbau(opt: {
  videos: Video[];
  ohne?: string[];
  antwort?: (prompt: string) => string | Promise<string>;
  stand?: AboStand;
  jetzt?: Date;
}) {
  const workdir = await mkdtemp(path.join(tmpdir(), "lehrgang-"));
  const ordner = path.join(workdir, "wissen", "tradinglab");
  await mkdir(path.join(ordner, "roh"), { recursive: true });
  await writeFile(path.join(ordner, "inventar.json"), JSON.stringify({ videos: opt.videos }));
  for (const v of opt.videos) {
    const ohne = opt.ohne?.includes(v.id);
    const t: Transkript = {
      id: v.id,
      titel: v.titel,
      sprache: "en",
      art: ohne ? "ohne" : "manuell",
      segmente: ohne ? [] : [{ start: 0, text: `Transcript of ${v.id}` }],
      geholt: "",
    };
    await writeFile(path.join(ordner, "roh", `${v.id}.json`), JSON.stringify(t));
  }
  const wissen = createWissen({ workdir });
  const schreibe = vi.fn(async (_system: string, prompt: string) =>
    opt.antwort ? opt.antwort(prompt) : ANTWORT,
  );
  const aboFrage = vi.fn(async () => opt.stand ?? abo(20));
  let inSchlange = 0;
  const lehrgang = createLehrgang({
    workdir,
    wissen,
    schreibe,
    modell: "Sonnet",
    abo: aboFrage,
    schlange: async (arbeit) => {
      inSchlange += 1;
      return arbeit();
    },
    aus: () => false,
    jetzt: () => opt.jetzt ?? NACHT,
  });
  return { workdir, ordner, wissen, lehrgang, schreibe, aboFrage, schlange: () => inSchlange };
}

const video = (id: string, kalibrierung = false): Video => ({
  id: id.padEnd(11, "x"),
  titel: `Video ${id}`,
  dauer: 300,
  ...(kalibrierung ? { kalibrierung } : {}),
});

describe("createLehrgang", () => {
  it("arbeitet in Kuros Schlange Video um Video ab, Kalibrierung zuerst, und legt Notizen ab", async () => {
    const liste = [video("a"), video("k", true), video("o", true)];
    const { ordner, wissen, lehrgang, schreibe, schlange } = await aufbau({
      videos: liste,
      ohne: [video("o").id],
    });
    const r = await lehrgang.takt();
    // Das Kalibrierungsvideo ohne Untertitel wird übergangen, nicht versucht.
    expect(r.gelernt.map((v) => [v.id, v.ok])).toEqual([
      [video("k").id, true],
      [video("a").id, true],
    ]);
    expect(r.halt).toMatch(/^nichts offen/);
    expect(schreibe).toHaveBeenCalledTimes(2);
    expect(schreibe.mock.calls[0]?.[1]).toContain("Transcript of kxxxxxxxxxx");
    expect(schlange()).toBe(2);
    const notiz = await readFile(path.join(ordner, "notizen", `${video("k").id}.md`), "utf8");
    expect(notiz).toContain("# Video k");
    expect(notiz).toContain("Kalibrierungsvideo");
    expect(await wissen.stand("tradinglab")).toMatchObject({
      durchgearbeitet: 2,
      kalibrierung: { videos: 2, durchgearbeitet: 1 },
    });
    const stand = await lehrgang.stand();
    expect(stand.dieseNacht).toEqual({ versuche: 2, fertig: 2 });
    expect(stand.letzte[0]?.titel).toBe("Video a");
    expect(stand.zuletzt?.halt).toMatch(/^nichts offen/);
  });

  it(`hört nach ${JE_NACHT} Videos in der Nacht auf`, async () => {
    const liste = Array.from({ length: JE_NACHT + 3 }, (_, i) => video(`v${i}`));
    const { lehrgang, schreibe } = await aufbau({ videos: liste });
    const r = await lehrgang.takt();
    expect(r.gelernt).toHaveLength(JE_NACHT);
    expect(r.halt).toBe(`${JE_NACHT} Videos in dieser Nacht — genug`);
    // Der nächste Takt in derselben Nacht beginnt nichts mehr.
    expect((await lehrgang.takt()).gelernt).toHaveLength(0);
    expect(schreibe).toHaveBeenCalledTimes(JE_NACHT);
  });

  it("beginnt kein Video über der Grenze des Sitzungsfensters", async () => {
    const { lehrgang, schreibe } = await aufbau({ videos: [video("a")], stand: abo(71) });
    expect(await lehrgang.takt()).toEqual({
      gelernt: [],
      halt: "Sitzungsfenster bei 71 % (Grenze 70 %)",
    });
    expect(schreibe).not.toHaveBeenCalled();
  });

  it("fragt tagsüber nicht einmal das Abo", async () => {
    const { lehrgang, aboFrage } = await aufbau({
      videos: [video("a")],
      jetzt: new Date("2026-09-29T10:00:00Z"),
    });
    expect((await lehrgang.takt()).halt).toBe("ruht bis 1:00 Uhr");
    expect(aboFrage).not.toHaveBeenCalled();
  });

  it("hält nach einem Fehlschlag an, versucht es im nächsten Takt wieder und überspringt dann", async () => {
    const kaputt = video("k");
    const { lehrgang, schreibe } = await aufbau({
      videos: [kaputt, video("b")],
      antwort: (prompt) => (prompt.includes(kaputt.id) ? "Sorry, I can't." : ANTWORT),
    });
    const erster = await lehrgang.takt();
    expect(erster.gelernt.map((v) => v.ok)).toEqual([false]);
    expect(erster.halt).toMatch(
      `gescheitert an ${kaputt.id}: Die Notiz kam ohne ihre Markierungen`,
    );
    const zweiter = await lehrgang.takt();
    expect(zweiter.gelernt.map((v) => v.ok)).toEqual([false]);
    const dritter = await lehrgang.takt();
    expect(dritter.gelernt.map((v) => [v.id, v.ok])).toEqual([[video("b").id, true]]);
    expect(schreibe).toHaveBeenCalledTimes(3);
    // Der Fehler verschwindet nicht: er steht mit Grund auf der System-Seite.
    const stand = await lehrgang.stand();
    expect(stand.uebersprungen).toEqual([
      { id: kaputt.id, titel: "Video k", grund: expect.stringMatching(/Sorry, I can't/) },
    ]);
  });

  it("bricht an der Abo-Grenze die Nacht ab, ohne das Video zu bestrafen", async () => {
    const { lehrgang } = await aufbau({
      videos: [video("a"), video("b")],
      antwort: () => "You've hit your session limit · resets 5:20pm (UTC)",
    });
    const r = await lehrgang.takt();
    expect(r.gelernt).toHaveLength(1);
    expect(r.gelernt[0]).toMatchObject({ ok: false, grenze: true });
    expect(r.halt).toMatch(/^Abo-Grenze/);
    expect((await lehrgang.stand()).uebersprungen).toEqual([]);
  });

  it("läuft nie zweimal gleichzeitig", async () => {
    let los: () => void = () => {};
    const warte = new Promise<void>((r) => {
      los = r;
    });
    const { lehrgang } = await aufbau({
      videos: [video("a")],
      antwort: async () => {
        await warte;
        return ANTWORT;
      },
    });
    const erster = lehrgang.takt();
    expect(await lehrgang.takt()).toEqual({ gelernt: [], halt: "läuft schon" });
    los();
    expect((await erster).gelernt).toHaveLength(1);
  });

  it("schreibt nichts Geheimes in die Notiz", async () => {
    const { ordner, lehrgang } = await aufbau({
      videos: [video("a")],
      antwort: () =>
        ANTWORT.replace("keine", "- Login mit postgres://kuro:geheim123@db:5432 [1:00]"),
    });
    await lehrgang.takt();
    const notiz = await readFile(path.join(ordner, "notizen", `${video("a").id}.md`), "utf8");
    expect(notiz).toContain("Login mit postgres://kuro:");
    expect(notiz).not.toContain("geheim123");
  });

  it("arbeitet von Hand ein bestimmtes Video durch, auch außerhalb der Nacht", async () => {
    const { lehrgang } = await aufbau({
      videos: [video("a"), video("b")],
      jetzt: new Date("2026-09-29T10:00:00Z"),
    });
    expect(await lehrgang.lerne(video("b").id)).toMatchObject({ id: video("b").id, ok: true });
    await expect(lehrgang.lerne("AAAAAAAAAAA")).rejects.toThrow(LehrgangFehler);
  });
});
