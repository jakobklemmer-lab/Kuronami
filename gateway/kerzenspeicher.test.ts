import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MarketCandle } from "./integrations/markets.js";
import {
  SpeicherFehler,
  type SpeicherOrt,
  bestand,
  dateiFuer,
  lade,
  luecken,
  monatVon,
  monateZwischen,
  sichere,
} from "./kerzenspeicher.js";

const MINUTE = 60;
/** 2024-03-05 00:00 UTC */
const START = 1_709_596_800;

function kerze(versatzMinuten: number, close: number, volume?: number): MarketCandle {
  return {
    time: START + versatzMinuten * MINUTE,
    open: close - 1,
    high: close + 2,
    low: close - 3,
    close,
    ...(volume !== undefined ? { volume } : {}),
  };
}

describe("monatVon / monateZwischen", () => {
  it("teilt nach UTC-Monaten, nicht nach der Börsenzone", () => {
    expect(monatVon(START)).toBe("2024-03");
    // 2024-03-05 plus 90 Tage endet am 2024-06-03 — der Juni gehört also dazu.
    expect(monateZwischen(START, START + 86_400 * 90)).toEqual([
      "2024-03",
      "2024-04",
      "2024-05",
      "2024-06",
    ]);
    // Ein Fenster innerhalb eines Monats ergibt genau einen Monat.
    expect(monateZwischen(START, START + 3600)).toEqual(["2024-03"]);
  });
});

describe("Kerzenspeicher", () => {
  let wurzel: string;
  let ort: SpeicherOrt;

  beforeEach(async () => {
    wurzel = await mkdtemp(path.join(tmpdir(), "kuro-kerzen-"));
    ort = { wurzel, quelle: "binance", symbol: "BTCUSDT", intervall: "1m" };
  });
  afterEach(async () => {
    await rm(wurzel, { recursive: true, force: true });
  });

  it("legt ab, liest zurück und hält das Fenster ein", async () => {
    const ergebnis = await sichere(ort, [kerze(0, 100, 1.5), kerze(1, 101, 2), kerze(2, 102)]);
    expect(ergebnis).toMatchObject({ neu: 3, berichtigt: 0, gesamt: 3, monate: ["2024-03"] });

    const zurueck = await lade(ort, START, START + 3 * MINUTE);
    expect(zurueck.map((k) => k.close)).toEqual([100, 101, 102]);
    // Fehlendes Volumen bleibt fehlend und wird nicht zu einer 0.
    expect(zurueck[0].volume).toBe(1.5);
    expect(zurueck[2].volume).toBeUndefined();

    // Das Ende ist ausschließlich.
    expect(await lade(ort, START, START + 2 * MINUTE)).toHaveLength(2);
  });

  it("führt zusammen statt anzuhängen und zählt Berichtigungen", async () => {
    await sichere(ort, [kerze(0, 100), kerze(1, 101)]);
    // Zweiter Abruf überlappt: eine Kerze gleich, eine berichtigt, eine neu.
    const ergebnis = await sichere(ort, [kerze(1, 101), kerze(1, 101), kerze(2, 102)]);
    expect(ergebnis.neu).toBe(1);
    expect(ergebnis.berichtigt).toBe(0);

    const berichtigung = await sichere(ort, [kerze(1, 999)]);
    expect(berichtigung.berichtigt).toBe(1);

    const zurueck = await lade(ort, START, START + 10 * MINUTE);
    expect(zurueck.map((k) => k.close)).toEqual([100, 999, 102]);
    expect(zurueck).toHaveLength(3);
  });

  it("schreibt eine Datei, die ein Mensch lesen kann", async () => {
    await sichere(ort, [kerze(0, 100, 1.5)]);
    const inhalt = await readFile(dateiFuer(ort, "2024-03"), "utf8");
    expect(inhalt.split("\n")[0]).toBe("zeit,open,high,low,close,volumen");
    expect(inhalt).toContain(`${START},99,102,97,100,1.5`);
  });

  it("verteilt über Monatsgrenzen hinweg und meldet den Bestand", async () => {
    const ende = Math.floor(new Date("2024-04-01T00:00:00Z").getTime() / 1000);
    await sichere(ort, [kerze(0, 100), { ...kerze(0, 200), time: ende }]);
    const b = await bestand(ort);
    expect(b.monate.map((m) => m.monat)).toEqual(["2024-03", "2024-04"]);
    expect(b.kerzen).toBe(2);
    expect(b.von).toBe(START);
    expect(b.bis).toBe(ende);
  });

  it("meldet leeren Bestand, statt über einen fehlenden Ordner zu stolpern", async () => {
    expect(await bestand(ort)).toEqual({ monate: [], kerzen: 0 });
    expect(await lade(ort, START, START + 3600)).toEqual([]);
  });

  it("weist Symbolnamen ab, die in einem Pfad nichts zu suchen haben", () => {
    for (const boese of ["../../etc", "a/b", ""]) {
      expect(() => dateiFuer({ ...ort, symbol: boese }, "2024-03")).toThrow(SpeicherFehler);
    }
  });

  it("findet Lücken, ohne jede Handelspause zu einer zu erklären", () => {
    const reihe = [kerze(0, 100), kerze(1, 101), kerze(2, 102), kerze(60, 103)];
    const gefunden = luecken(reihe, "1m");
    expect(gefunden).toHaveLength(1);
    expect(gefunden[0]).toMatchObject({ fehlendeKerzen: 57 });
    // Eine lückenlose Reihe meldet nichts.
    expect(luecken([kerze(0, 100), kerze(1, 101)], "1m")).toEqual([]);
  });
});
