import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ZeichnungFehler,
  beschreibeZeichnungen,
  createZeichnungen,
  dateinameFuer,
  pruefeZeichnungen,
} from "./zeichnungen.js";

const tag = Date.UTC(2026, 8, 18, 7) / 1000;

describe("pruefeZeichnungen", () => {
  it("behält nur bekannte Felder", () => {
    const [z] = pruefeZeichnungen([
      { id: "h1", art: "horizontal", preis: 25600, farbe: "rot", boese: "<script>" },
    ]);
    expect(z).toEqual({ id: "h1", art: "horizontal", preis: 25600 });
  });

  it("weist Unbekanntes, Doppeltes und Unsinn ab", () => {
    expect(() => pruefeZeichnungen([{ id: "x", art: "zauberstab" }])).toThrow(ZeichnungFehler);
    expect(() =>
      pruefeZeichnungen([
        { id: "a", art: "horizontal", preis: 1 },
        { id: "a", art: "horizontal", preis: 2 },
      ]),
    ).toThrow(/doppelt/);
    expect(() => pruefeZeichnungen([{ id: "a", art: "horizontal", preis: "viel" }])).toThrow(
      ZeichnungFehler,
    );
    expect(() =>
      pruefeZeichnungen([
        {
          id: "p",
          art: "position",
          richtung: "seitwärts",
          a: { zeit: 1, preis: 1 },
          bisZeit: 2,
          stop: 0.5,
          ziel: 2,
        },
      ]),
    ).toThrow(ZeichnungFehler);
  });
});

describe("beschreibeZeichnungen", () => {
  it("schreibt, was ein Analyst ohne Rückfrage versteht", () => {
    const zeilen = beschreibeZeichnungen([
      { id: "h", art: "horizontal", preis: 25600, notiz: "Widerstand" },
      {
        id: "p",
        art: "position",
        richtung: "long",
        a: { zeit: tag, preis: 25450 },
        bisZeit: tag + 86400 * 10,
        stop: 25200,
        ziel: 25950,
      },
    ]);
    expect(zeilen[0]).toBe('Horizontale Linie bei 25.600 („Widerstand")');
    expect(zeilen[1]).toBe(
      "Long-Idee: Einstieg 25.450, Stop 25.200, Ziel 25.950 (gezeichnet ab 18.09.2026)",
    );
  });
});

describe("createZeichnungen", () => {
  it("legt je Wert eine Datei an und liest sie zurück", async () => {
    const workdir = await mkdtemp(path.join(tmpdir(), "zeichnungen-"));
    const ablage = createZeichnungen({ workdir, jetzt: () => new Date("2026-09-27T08:00:00Z") });
    expect((await ablage.lies("^GDAXI")).zeichnungen).toEqual([]);
    await ablage.schreibe("^GDAXI", [{ id: "h1", art: "horizontal", preis: 25600 }]);
    const blatt = await ablage.lies("^GDAXI");
    expect(blatt.zeichnungen).toHaveLength(1);
    expect(blatt.geaendert).toBe("2026-09-27T08:00:00.000Z");
    const roh = JSON.parse(await readFile(path.join(workdir, "charts", "GDAXI.json"), "utf8"));
    expect(roh.symbol).toBe("^GDAXI");
  });

  it("macht aus jedem Symbol einen harmlosen Dateinamen", () => {
    expect(dateinameFuer("^GDAXI")).toBe("GDAXI.json");
    expect(dateinameFuer("EURUSD=X")).toBe("EURUSD_X.json");
    expect(dateinameFuer("../../etc")).toBe(".._.._ETC.json");
  });
});
