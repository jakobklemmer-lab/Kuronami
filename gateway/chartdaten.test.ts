import { describe, expect, it } from "vitest";
import {
  IndikatorFehler,
  createChartdaten,
  fuegeAn,
  leseIndikatoren,
  rechneKennzahlen,
  verdichte,
} from "./chartdaten.js";
import type { MarketCandle, MarketChart, MarketsClient } from "./integrations/markets.js";

const k = (time: number, close: number, volume?: number): MarketCandle => ({
  time,
  open: close,
  high: close + 1,
  low: close - 1,
  close,
  ...(volume !== undefined ? { volume } : {}),
});

describe("verdichte", () => {
  it("baut 4h-Kerzen ab der ersten Kerze des Handelstags (DAX: 09, 13, 17 Uhr)", () => {
    // 2026-09-25, Stundenkerzen 07:00 … 15:00 UTC = 09:00 … 17:00 Berlin
    const tag = Date.UTC(2026, 8, 25, 7) / 1000;
    const stunden = Array.from({ length: 9 }, (_, i) => k(tag + i * 3600, 100 + i, 10));
    const vier = verdichte(stunden, 14_400, "Europe/Berlin");
    expect(vier.map((x) => (x.time - tag) / 3600)).toEqual([0, 4, 8]);
    expect(vier[0]).toMatchObject({ open: 100, close: 103, high: 104, low: 99, volume: 40 });
    expect(vier[2]).toMatchObject({ open: 108, close: 108, volume: 10 });
  });

  it("fängt jeden Handelstag neu an", () => {
    const montag = Date.UTC(2026, 8, 21, 7) / 1000;
    const dienstag = Date.UTC(2026, 8, 22, 7) / 1000;
    const kerzen = [k(montag, 1), k(montag + 3600, 2), k(dienstag, 3), k(dienstag + 3600, 4)];
    const vier = verdichte(kerzen, 14_400, "Europe/Berlin");
    expect(vier.map((x) => x.time)).toEqual([montag, dienstag]);
  });
});

describe("fuegeAn", () => {
  it("ersetzt ab der ersten neuen Kerze und hängt den Rest an", () => {
    const alt = [k(1, 1), k(2, 2), k(3, 3)];
    expect(fuegeAn(alt, [k(3, 30), k(4, 4)]).map((x) => x.close)).toEqual([1, 2, 30, 4]);
    expect(fuegeAn(alt, [])).toEqual(alt);
  });
});

describe("leseIndikatoren", () => {
  it("ergänzt Vorgaben und baut eine eindeutige Kennung", () => {
    expect(leseIndikatoren("sma:20, ema, bb:20:2.5,macd")).toEqual([
      { id: "sma:20", art: "sma", parameter: [20] },
      { id: "ema:50", art: "ema", parameter: [50] },
      { id: "bb:20:2.5", art: "bb", parameter: [20, 2.5] },
      { id: "macd:12:26:9", art: "macd", parameter: [12, 26, 9] },
    ]);
  });

  it("weist Unbekanntes und Unsinn ab, statt es zu übergehen", () => {
    expect(() => leseIndikatoren("sma:20,zauber")).toThrow(IndikatorFehler);
    expect(() => leseIndikatoren("rsi:-3")).toThrow(IndikatorFehler);
    expect(() => leseIndikatoren("rsi:14:2")).toThrow(IndikatorFehler);
    expect(() => leseIndikatoren(Array(13).fill("sma").join(","))).toThrow(IndikatorFehler);
  });
});

describe("rechneKennzahlen", () => {
  const tag = 86_400;
  const jetzt = Date.UTC(2026, 8, 27, 12) / 1000;
  // Ein Schluss je Tag über zwei Jahre, steigend um 1 je Tag.
  const kerzen = Array.from({ length: 730 }, (_, i) => k(jetzt - (730 - i) * tag, 1000 + i, 100));
  const kurs = 1000 + 730;

  it("rechnet Kalenderspannen vom letzten Schluss davor", () => {
    const z = rechneKennzahlen(kerzen, kurs, jetzt);
    const monat = z.performance.find((p) => p.spanne === "1M");
    expect(monat?.prozent).toBeCloseTo(((kurs - (1000 + 700)) / (1000 + 700)) * 100, 5);
    // Fünf Jahre gibt die Reihe nicht her — dann keine Zahl, nicht eine über kürzere Zeit.
    expect(z.performance.find((p) => p.spanne === "5J")?.prozent).toBeNull();
  });

  it("nimmt für YTD den letzten Schluss des Vorjahres", () => {
    const z = rechneKennzahlen(kerzen, kurs, jetzt);
    const jahresanfang = Date.UTC(2026, 0, 1) / 1000;
    const vorjahr = kerzen.filter((x) => x.time < jahresanfang).at(-1)?.close as number;
    expect(z.performance.find((p) => p.spanne === "YTD")?.prozent).toBeCloseTo(
      ((kurs - vorjahr) / vorjahr) * 100,
      5,
    );
    expect(z.atrTag).toBeCloseTo(2, 5);
    expect(z.volumenSchnitt30).toBe(100);
  });
});

function falscherMarkt(kerzen: MarketCandle[]) {
  const aufrufe: { von: number; bis: number; intervall: string }[] = [];
  const kopf = {
    symbol: "^GDAXI",
    name: "DAX",
    currency: "EUR",
    exchange: "XETRA",
    price: 110,
    change: 1,
    changePct: 1,
    zeitzone: "Europe/Berlin",
  };
  const markets: MarketsClient = {
    search: async () => [],
    chart: async () => {
      throw new Error("nicht benutzt");
    },
    quotes: async () => ({ quotes: [], failed: [] }),
    zeitraum: async (_s, von, bis, intervall): Promise<MarketChart> => {
      aufrufe.push({ von, bis, intervall });
      const drin = kerzen.filter((x) => x.time >= von && x.time < bis);
      return { ...kopf, spark: [], range: "", interval: intervall, candles: drin };
    },
  };
  return { markets, aufrufe };
}

describe("createChartdaten", () => {
  const t0 = 1_790_000_000;
  const kerzen = Array.from({ length: 300 }, (_, i) => k(t0 + i * 300, 100 + (i % 7)));
  let uhr = t0 + 300 * 300;

  it("liefert das Ende, sagt ob es davor mehr gibt, und lädt nach links nach", async () => {
    const { markets } = falscherMarkt(kerzen);
    const daten = createChartdaten({ markets, jetzt: () => uhr });
    const erste = await daten.lade({ symbol: "^GDAXI", intervall: "5m", anzahl: 100 });
    expect(erste.kerzen).toHaveLength(100);
    expect(erste.kerzen[0][0]).toBe(t0 + 200 * 300);
    expect(erste.mehr).toBe(true);
    const davor = await daten.lade({
      symbol: "^GDAXI",
      intervall: "5m",
      anzahl: 150,
      bis: erste.kerzen[0][0],
    });
    expect(davor.kerzen.at(-1)?.[0]).toBe(t0 + 199 * 300);
    expect(davor.kerzen).toHaveLength(150);
    const ganzLinks = await daten.lade({
      symbol: "^GDAXI",
      intervall: "5m",
      anzahl: 100,
      bis: davor.kerzen[0][0],
    });
    expect(ganzLinks.mehr).toBe(false);
  });

  it("rechnet Indikatoren über die ganze Reihe, nicht über den Ausschnitt", async () => {
    const { markets } = falscherMarkt(kerzen);
    const daten = createChartdaten({ markets, jetzt: () => uhr });
    const a = await daten.lade({
      symbol: "^GDAXI",
      intervall: "5m",
      anzahl: 50,
      indikatoren: leseIndikatoren("sma:20"),
    });
    // Am Anfang des Ausschnitts ist der SMA schon voll — er lief über die Kerzen davor an.
    expect(a.indikatoren[0].reihen.wert[0]).not.toBeNull();
    expect(a.indikatoren[0].reihen.wert).toHaveLength(50);
  });

  it("holt innerhalb der Frische nichts neu und danach nur das Ende", async () => {
    const { markets, aufrufe } = falscherMarkt(kerzen);
    const daten = createChartdaten({ markets, jetzt: () => uhr });
    await daten.lade({ symbol: "^GDAXI", intervall: "5m" });
    await daten.lade({ symbol: "^GDAXI", intervall: "5m" });
    expect(aufrufe).toHaveLength(1);
    expect(uhr - aufrufe[0].von).toBe(59 * 86_400);
    uhr += 20;
    await daten.lade({ symbol: "^GDAXI", intervall: "5m", ab: t0 + 299 * 300 });
    expect(aufrufe).toHaveLength(2);
    expect(uhr - aufrufe[1].von).toBe(2 * 86_400);
  });

  it("holt Tag, Woche und Monat ab dem Beginn der Aufzeichnung", async () => {
    const { markets, aufrufe } = falscherMarkt(kerzen);
    const daten = createChartdaten({ markets, jetzt: () => uhr });
    await daten.lade({ symbol: "^GDAXI", intervall: "1d" });
    expect(aufrufe[0]).toMatchObject({ von: 0, intervall: "1d" });
  });
});
