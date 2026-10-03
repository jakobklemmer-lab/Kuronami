import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AboStand, Fenster } from "./abo.js";
import { grenzenJetzt } from "./lehrgang.js";
import { inDerNacht, nachtgrenzen, naechstesEnde, wocheZuBeginn } from "./nachtbudget.js";

const NORMAL = { sitzung: 85, woche: 85 };

function fenster(sitzung: number, zurueck: string | null, woche: number): Fenster[] {
  return [
    { id: "sitzung", name: "Sitzung", prozent: sitzung, zurueck, warnung: false },
    { id: "woche", name: "Woche", prozent: woche, zurueck: "2026-10-09T10:00:00Z", warnung: false },
  ];
}

describe("Nachtzeit", () => {
  it("Nacht ist Mitternacht bis zum Ende, Wiener Zeit", () => {
    // 00:30 und 07:59 Wien (Sommerzeit, UTC+2) sind Nacht, 08:00 und 23:30 nicht.
    expect(inDerNacht(new Date("2026-10-02T22:30:00Z"))).toBe(true);
    expect(inDerNacht(new Date("2026-10-03T05:59:00Z"))).toBe(true);
    expect(inDerNacht(new Date("2026-10-03T06:00:00Z"))).toBe(false);
    expect(inDerNacht(new Date("2026-10-02T21:30:00Z"))).toBe(false);
    expect(inDerNacht(new Date("2026-10-03T06:30:00Z"), "09:00")).toBe(true);
  });

  it("das nächste Ende liegt am selben Morgen", () => {
    expect(naechstesEnde(new Date("2026-10-02T22:30:00Z")).toISOString()).toBe(
      "2026-10-03T06:00:00.000Z",
    );
  });
});

describe("nachtgrenzen", () => {
  const nacht = new Date("2026-10-02T23:00:00Z"); // 01:00 Wien

  it("die Woche darf zehn Punkte über den Stand zu Nachtbeginn", () => {
    const g = nachtgrenzen({
      fenster: fenster(5, "2026-10-03T03:00:00Z", 14),
      wocheStart: 12,
      jetzt: nacht,
      normal: NORMAL,
    });
    expect(g.woche).toBe(22);
    expect(g.sitzung).toBe(85);
    expect(g.letztesFenster).toBe(false);
  });

  it("nie über die eigene Grenze hinaus", () => {
    const g = nachtgrenzen({
      fenster: fenster(5, null, 80),
      wocheStart: 80,
      jetzt: nacht,
      normal: NORMAL,
    });
    expect(g.woche).toBe(85);
  });

  it("ein Fenster, das in den Morgen reicht, bleibt unter 30 %", () => {
    // 05:30 Wien: ein neues Fenster liefe bis 10:30 — über 08:00 hinaus.
    const frueh = new Date("2026-10-03T03:30:00Z");
    const neu = nachtgrenzen({
      fenster: fenster(0, null, 14),
      wocheStart: 12,
      jetzt: frueh,
      normal: NORMAL,
    });
    expect(neu.letztesFenster).toBe(true);
    expect(neu.sitzung).toBe(30);
    // Läuft das Fenster vor acht ab, gilt die volle Grenze.
    const alt = nachtgrenzen({
      fenster: fenster(40, "2026-10-03T05:00:00Z", 14),
      wocheStart: 12,
      jetzt: frueh,
      normal: NORMAL,
    });
    expect(alt.letztesFenster).toBe(false);
    expect(alt.sitzung).toBe(85);
    // Ein abgelaufenes Fenster zählt wie keines.
    const abgelaufen = nachtgrenzen({
      fenster: fenster(40, "2026-10-03T03:00:00Z", 14),
      wocheStart: 12,
      jetzt: frueh,
      normal: NORMAL,
    });
    expect(abgelaufen.letztesFenster).toBe(true);
  });

  it("wird die Woche nachts zurückgesetzt, zählt der neue Stand", () => {
    const g = nachtgrenzen({
      fenster: fenster(5, null, 1),
      wocheStart: 70,
      jetzt: nacht,
      normal: NORMAL,
    });
    expect(g.wocheStart).toBe(1);
    expect(g.woche).toBe(11);
  });
});

describe("wocheZuBeginn", () => {
  it("der erste Blick der Nacht gilt, auch für den zweiten Fragenden", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "nachtbudget-"));
    const nacht = new Date("2026-10-02T23:00:00Z");
    expect(await wocheZuBeginn(dir, nacht, 12)).toBe(12);
    expect(await wocheZuBeginn(dir, new Date("2026-10-03T02:00:00Z"), 19)).toBe(12);
    const datei = JSON.parse(await readFile(path.join(dir, "nacht", "2026-10-03.json"), "utf8"));
    expect(datei.wocheStart).toBe(12);
    // Die nächste Nacht beginnt neu.
    expect(await wocheZuBeginn(dir, new Date("2026-10-03T23:00:00Z"), 25)).toBe(25);
  });
});

describe("Lehrgang im Nachtbudget", () => {
  const abo = (sitzung: number, woche: number, zurueck: string | null = null): AboStand => ({
    verfuegbar: true,
    plan: "pro",
    fenster: fenster(sitzung, zurueck, woche),
    aufteilung: [],
    zusatz: false,
    stand: "",
  });

  it("nachts teilt er sich die zehn Punkte mit dem Nachtbau, tagsüber nicht", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "nachtbudget-"));
    const nacht = new Date("2026-10-02T23:00:00Z");
    // Der Nachtbau hat um 00:30 bei 12 % festgehalten.
    await wocheZuBeginn(dir, new Date("2026-10-02T22:30:00Z"), 12);
    expect(await grenzenJetzt(abo(10, 20), dir, nacht, "08:00")).toEqual({
      sitzung: 70,
      woche: 22,
    });
    const tag = new Date("2026-10-03T10:00:00Z");
    expect(await grenzenJetzt(abo(10, 20), dir, tag, "08:00")).toEqual({ sitzung: 70, woche: 85 });
  });

  it("in einer freigegebenen Nacht 98/98, aber nur für ein Sitzungsfenster", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "nachtbudget-"));
    vi.stubEnv("NACHTBAU_FREI", "2026-10-03");
    const frei = { sitzung: 98, woche: 98 };
    const zu = { sitzung: 0, woche: 98 };
    const um = (t: string, a: AboStand) => grenzenJetzt(a, dir, new Date(t), "08:00");
    // 00:30 Wien: das Abendfenster (96 %, zurück 01:10) zählt nicht zur Nacht.
    expect(await um("2026-10-03T22:30:00Z", abo(96, 67, "2026-10-03T23:10:00Z"))).toEqual(zu);
    // 01:10 Wien frei, kein Fenster läuft: das erste der Nacht beginnt.
    expect(await um("2026-10-03T23:10:00Z", abo(0, 67))).toEqual(frei);
    // 03:00 Wien im Fenster, das um 01:10 begann.
    expect(await um("2026-10-04T01:00:00Z", abo(60, 75, "2026-10-04T04:10:00Z"))).toEqual(frei);
    // 06:30 Wien: das erste ist um, ein zweites beginnt nicht — und wenn doch eins läuft, auch nicht.
    expect(await um("2026-10-04T04:30:00Z", abo(0, 80))).toEqual(zu);
    expect(await um("2026-10-04T04:30:00Z", abo(5, 80, "2026-10-04T09:15:00Z"))).toEqual(zu);
    // Die nächste Nacht ist nicht freigegeben.
    expect(await um("2026-10-04T22:30:00Z", abo(0, 80))).not.toEqual(frei);
    vi.unstubAllEnvs();
  });
});
