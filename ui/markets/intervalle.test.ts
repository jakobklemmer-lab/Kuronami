import { describe, expect, it } from "vitest";
import {
  HANDY_ZEITRAEUME,
  type HandyZeitraum,
  anzeigeZeit,
  echteZeit,
  handelsanteilAus,
  handyIntervall,
  handyZeitraum,
  intervall,
  kerzenImZeitraum,
  passendesIntervall,
  zeitraum,
  zeitraumTage,
  zeitraumVon,
} from "./intervalle.js";

const DAX = 30_600 / 86_400; // 09:00–17:30

describe("passendesIntervall", () => {
  it("behält die Kerzengröße, wenn sie zum Zeitraum passt", () => {
    expect(passendesIntervall(30, "1d", DAX)).toBe("1d");
    expect(passendesIntervall(5, "15m", DAX)).toBe("15m");
    expect(passendesIntervall(1826, "1wk", DAX)).toBe("1wk");
  });

  it("springt so wenig wie möglich, wenn sie nicht passt", () => {
    // Ein Tag in Tageskerzen ist eine Kerze — die nächste taugliche ist 15 Minuten.
    expect(passendesIntervall(1, "1d", DAX)).toBe("15m");
    // Fünf Jahre in Stundenkerzen gibt es bei Yahoo nicht — die nächste ist der Tag.
    expect(passendesIntervall(1826, "1h", DAX)).toBe("1d");
    // Drei Monate in 5-Minuten-Kerzen: nur 59 Tage da — die nächste ist die Stunde.
    expect(passendesIntervall(91, "5m", DAX)).toBe("1h");
    // Alles: nur Tag, Woche, Monat reichen so weit.
    expect(passendesIntervall(null, "4h", DAX)).toBe("1d");
  });

  it("zählt unter einem Tag nur die Handelszeit", () => {
    expect(kerzenImZeitraum(1, intervall("1h"), DAX)).toBeCloseTo(8.5);
    expect(kerzenImZeitraum(1, intervall("1h"), 1)).toBe(24);
    // Bitcoin handelt rund um die Uhr: ein Tag in Stundenkerzen reicht.
    expect(passendesIntervall(1, "1h", 1)).toBe("1h");
    expect(passendesIntervall(1, "1h", DAX)).toBe("15m");
  });
});

describe("Zeitraum", () => {
  it("rechnet YTD aus dem Datum", () => {
    const yt = zeitraum("YTD");
    expect(yt && zeitraumTage(yt, new Date("2026-09-27T12:00:00Z"))).toBe(270);
    const alles = zeitraum("Alles");
    expect(alles && zeitraumTage(alles, new Date())).toBeNull();
  });

  it("nimmt die Sitzung als Handelsanteil, Bitcoin als ganzen Tag", () => {
    expect(handelsanteilAus({ start: 1_790_319_600, ende: 1_790_350_200 })).toBeCloseTo(DAX);
    expect(handelsanteilAus({ start: 1_790_467_200, ende: 1_790_553_540 })).toBe(1);
    expect(handelsanteilAus(undefined)).toBe(1);
  });
});

describe("Ortszeit", () => {
  it("verschiebt um den Abstand der Zone und rechnet zurück", () => {
    const t = Date.UTC(2026, 8, 25, 7) / 1000; // 09:00 in Berlin (MESZ)
    const anzeige = anzeigeZeit(t);
    // Die Prüfung läuft in der Zone des Rechners; die Umkehrung muss in jeder stimmen.
    expect(echteZeit(anzeige)).toBe(t);
    expect(anzeige - t === -new Date(t * 1000).getTimezoneOffset() * 60).toBe(true);
  });
});

describe("zeitraumVon", () => {
  const jetzt = new Date("2026-09-27T10:00:00Z"); // ein Sonntag
  // Freitag, 17:25 Ortszeit des Rechners — die letzte DAX-Kerze vor dem Wochenende.
  const freitag = new Date(2026, 8, 25, 17, 25).getTime() / 1000;

  it("nimmt bei „1 Tag“ den letzten Handelstag, nicht die letzten 24 Stunden", () => {
    const eintag = zeitraum("1T");
    if (!eintag) throw new Error("1T fehlt");
    expect(zeitraumVon(eintag, freitag, jetzt, DAX)).toBe(
      new Date(2026, 8, 25, 0, 0).getTime() / 1000,
    );
    // Bitcoin handelt rund um die Uhr: da sind es die 24 Stunden.
    expect(zeitraumVon(eintag, freitag, jetzt, 1)).toBe(freitag - 86_400);
  });

  it("rechnet die übrigen Zeiträume in Kalendertagen, „Alles“ ohne Anfang", () => {
    const drei = zeitraum("3M");
    const alles = zeitraum("Alles");
    if (!drei || !alles) throw new Error("Zeitraum fehlt");
    expect(zeitraumVon(drei, freitag, jetzt, DAX)).toBe(freitag - 91 * 86_400);
    expect(zeitraumVon(alles, freitag, jetzt, DAX)).toBeNull();
  });
});

describe("Telefon", () => {
  const jetzt = new Date("2026-09-27T10:00:00Z");
  const z = (id: string) => handyZeitraum(id) as HandyZeitraum;

  it("lässt die Kerzengröße dem Zeitraum folgen", () => {
    expect(handyIntervall(z("1T"), jetzt, DAX)).toBe("5m");
    expect(handyIntervall(z("5T"), jetzt, DAX)).toBe("30m");
    expect(handyIntervall(z("1M"), jetzt, DAX)).toBe("4h");
    expect(handyIntervall(z("3M"), jetzt, DAX)).toBe("1d");
    expect(handyIntervall(z("1J"), jetzt, DAX)).toBe("1d");
    expect(handyIntervall(z("5J"), jetzt, DAX)).toBe("1wk");
  });

  it("hält jeden Zeitraum zwischen rund 60 und 300 Kerzen, beim DAX wie bei Bitcoin", () => {
    for (const hz of HANDY_ZEITRAEUME) {
      const zr = zeitraum(hz.id);
      const tage = zr ? zeitraumTage(zr, jetzt) : null;
      if (tage === null) throw new Error(`${hz.id} ohne Tage`);
      for (const anteil of [DAX, 1]) {
        const n = kerzenImZeitraum(tage, intervall(handyIntervall(hz, jetzt, anteil)), anteil);
        expect(n, `${hz.id} bei Anteil ${anteil.toFixed(2)}`).toBeGreaterThanOrEqual(50);
        expect(n, `${hz.id} bei Anteil ${anteil.toFixed(2)}`).toBeLessThanOrEqual(370);
      }
    }
  });

  it("kennt nur die Zeiträume des Telefons", () => {
    expect(handyZeitraum("YTD")).toBeUndefined();
    expect(HANDY_ZEITRAEUME.every((h) => zeitraum(h.id) !== undefined)).toBe(true);
  });
});
