import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AlarmFehler,
  alarmText,
  createAlarme,
  loestAus,
  richtungFuer,
  starteAlarmTakt,
} from "./alarme.js";
import type { MarketsClient } from "./integrations/markets.js";

async function ablage() {
  const workdir = await mkdtemp(path.join(tmpdir(), "alarme-"));
  return createAlarme({ workdir, jetzt: () => new Date("2026-09-27T08:00:00Z") });
}

describe("Richtung und Auslösen", () => {
  it("nimmt die Richtung aus dem Kurs beim Anlegen", () => {
    expect(richtungFuer(25600, 25408)).toBe("ueber");
    expect(richtungFuer(25000, 25408)).toBe("unter");
    expect(() => richtungFuer(25408, 25408)).toThrow(AlarmFehler);
  });

  it("löst an der Marke selbst aus, nicht erst dahinter", () => {
    expect(loestAus({ richtung: "ueber", preis: 100 }, 100)).toBe(true);
    expect(loestAus({ richtung: "ueber", preis: 100 }, 99.99)).toBe(false);
    expect(loestAus({ richtung: "unter", preis: 100 }, 100)).toBe(true);
  });
});

describe("createAlarme", () => {
  it("löst einmal aus und bleibt dann stehen, bis er neu scharf ist", async () => {
    const a = await ablage();
    const alarm = await a.lege({ symbol: "^gdaxi", name: "DAX", preis: 25600, kurs: 25408 });
    expect(alarm).toMatchObject({ symbol: "^GDAXI", richtung: "ueber", status: "aktiv" });

    expect(await a.pruefe(new Map([["^GDAXI", 25500]]))).toEqual([]);
    const erst = await a.pruefe(new Map([["^GDAXI", 25610]]));
    expect(erst.map((x) => x.id)).toEqual([alarm.id]);
    expect(await a.pruefe(new Map([["^GDAXI", 25700]]))).toEqual([]);

    const wieder = await a.scharf(alarm.id, 25700);
    expect(wieder?.richtung).toBe("unter");
    expect(wieder?.status).toBe("aktiv");
    expect(await a.loesche(alarm.id)).toBe(true);
    expect(await a.liste()).toEqual([]);
  });

  it("verträgt zwei Schreiber gleichzeitig", async () => {
    const a = await ablage();
    await Promise.all([
      a.lege({ symbol: "A", preis: 2, kurs: 1 }),
      a.lege({ symbol: "B", preis: 2, kurs: 1 }),
      a.lege({ symbol: "C", preis: 2, kurs: 1 }),
    ]);
    expect((await a.liste()).map((x) => x.symbol).sort()).toEqual(["A", "B", "C"]);
  });
});

describe("starteAlarmTakt", () => {
  it("fragt nur Werte mit aktivem Alarm ab und meldet das Auslösen", async () => {
    const a = await ablage();
    await a.lege({ symbol: "BTC-USD", name: "Bitcoin", preis: 90000, kurs: 84500 });
    const gefragt: string[][] = [];
    const markets = {
      quotes: async (symbole: readonly string[]) => {
        gefragt.push([...symbole]);
        return { quotes: [{ symbol: "BTC-USD", price: 90100 }], failed: [] };
      },
    } as unknown as MarketsClient;
    const gemeldet: string[] = [];
    const takt = starteAlarmTakt({
      alarme: a,
      markets,
      melde: (x) => gemeldet.push(alarmText(x)),
      taktMs: 1e9,
    });
    await takt.jetzt();
    await takt.jetzt();
    takt.stop();
    expect(gefragt).toEqual([["BTC-USD"]]);
    expect(gemeldet).toEqual(["Bitcoin hat 90.000 erreicht — Kurs 90.100"]);
  });
});
