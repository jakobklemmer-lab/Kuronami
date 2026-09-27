import { describe, expect, it } from "vitest";
import { ausDraht, formatVolumen, heikinAshi, marktLage, vereine, voranstellen } from "./kerzen.js";

const k = (time: number, open: number, high: number, low: number, close: number) => ({
  time,
  open,
  high,
  low,
  close,
});

describe("Kerzen", () => {
  it("liest Drahtkerzen mit und ohne Volumen", () => {
    expect(
      ausDraht([
        [1, 2, 3, 1, 2],
        [2, 2, 4, 2, 3, 900],
      ]),
    ).toEqual([
      { time: 1, open: 2, high: 3, low: 1, close: 2 },
      { time: 2, open: 2, high: 4, low: 2, close: 3, volume: 900 },
    ]);
  });

  it("rechnet Heikin-Ashi aus der vorigen HA-Kerze", () => {
    const ha = heikinAshi([k(1, 10, 12, 9, 11), k(2, 11, 14, 10, 13)]);
    expect(ha[0]).toMatchObject({ open: 10.5, close: 10.5 });
    expect(ha[1].open).toBeCloseTo(10.5);
    expect(ha[1].close).toBeCloseTo(12);
    expect(ha[1].high).toBe(14);
  });

  it("fügt Aktualisierungen ein und sagt, ab wo sich etwas geändert hat", () => {
    const alt = [k(1, 1, 1, 1, 1), k(2, 2, 2, 2, 2), k(3, 3, 3, 3, 3)];
    const { kerzen, ab } = vereine(alt, [k(3, 3, 4, 3, 4), k(4, 4, 4, 4, 4)]);
    expect(kerzen.map((x) => x.close)).toEqual([1, 2, 4, 4]);
    expect(ab).toBe(2);
    expect(voranstellen([k(0, 0, 0, 0, 0), k(1, 9, 9, 9, 9)], alt).map((x) => x.time)).toEqual([
      0, 1, 2, 3,
    ]);
    expect(voranstellen([k(0, 0, 0, 0, 0), k(1, 9, 9, 9, 9)], alt)[1].close).toBe(1);
  });
});

describe("marktLage", () => {
  const sitzung = { start: 1_790_319_600, ende: 1_790_350_200 };
  it("sagt offen, geschlossen und rund um die Uhr", () => {
    expect(marktLage({ sitzung }, sitzung.start + 60).offen).toBe(true);
    expect(marktLage({ sitzung }, sitzung.ende + 60)).toEqual({
      offen: false,
      text: "Geschlossen",
    });
    expect(marktLage({ typ: "CRYPTOCURRENCY" }, 0).text).toBe("Handel rund um die Uhr");
  });
});

describe("formatVolumen", () => {
  it("kürzt große Zahlen deutsch", () => {
    expect(formatVolumen(1_234_567)).toBe("1,23 Mio.");
    expect(formatVolumen(15_016_546_304)).toBe("15,02 Mrd.");
    expect(formatVolumen(845_300)).toBe("845.300");
  });
});
