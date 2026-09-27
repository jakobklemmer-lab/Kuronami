import { describe, expect, it } from "vitest";
import {
  formatAnteil,
  formatDateLong,
  formatR,
  formatRelativeTime,
  formatTagKurz,
  formatZahl,
  gruppiereNachTag,
  kerzenName,
  tagesGruppe,
} from "./format.js";

describe("formatRelativeTime", () => {
  const now = new Date("2026-09-13T12:00:00.000Z");

  it('zeigt "gerade eben" fuer unter einer Minute', () => {
    expect(formatRelativeTime(new Date("2026-09-13T11:59:30.000Z").toISOString(), now)).toBe(
      "gerade eben",
    );
  });

  it("zeigt Minuten fuer unter einer Stunde", () => {
    expect(formatRelativeTime(new Date("2026-09-13T11:45:00.000Z").toISOString(), now)).toBe(
      "vor 15 Min.",
    );
  });

  it("zeigt Stunden fuer unter einem Tag", () => {
    expect(formatRelativeTime(new Date("2026-09-13T09:00:00.000Z").toISOString(), now)).toBe(
      "vor 3 Std.",
    );
  });

  it("zeigt Tage darueber hinaus", () => {
    expect(formatRelativeTime(new Date("2026-09-11T12:00:00.000Z").toISOString(), now)).toBe(
      "vor 2 Tg.",
    );
  });

  it('behandelt einen Zeitpunkt in der Zukunft als "gerade eben", nicht negativ', () => {
    expect(formatRelativeTime(new Date("2026-09-13T13:00:00.000Z").toISOString(), now)).toBe(
      "gerade eben",
    );
  });
});

describe("formatDateLong", () => {
  it("formatiert als deutsches Langdatum mit Wochentag", () => {
    const result = formatDateLong(new Date("2026-09-13T12:00:00.000Z"));
    expect(result).toContain("2026");
    expect(result).toMatch(/September/);
  });
});

describe("tagesGruppe", () => {
  const jetzt = new Date(2026, 8, 26, 21, 30);

  it("nennt heute und gestern beim Namen", () => {
    expect(tagesGruppe(new Date(2026, 8, 26, 0, 5).toISOString(), jetzt)).toBe("Heute");
    expect(tagesGruppe(new Date(2026, 8, 25, 23, 59).toISOString(), jetzt)).toBe("Gestern");
  });

  it("nennt in der letzten Woche den Wochentag, davor nur das Datum", () => {
    expect(tagesGruppe(new Date(2026, 8, 23, 10).toISOString(), jetzt)).toBe(
      "Mittwoch, 23. September",
    );
    expect(tagesGruppe(new Date(2026, 8, 12, 10).toISOString(), jetzt)).toBe("12. September");
    expect(tagesGruppe(new Date(2025, 11, 30, 10).toISOString(), jetzt)).toBe("30. Dezember 2025");
  });

  it("zählt einen Zeitpunkt in der Zukunft zu heute", () => {
    expect(tagesGruppe(new Date(2026, 8, 27, 3).toISOString(), jetzt)).toBe("Heute");
  });
});

describe("gruppiereNachTag", () => {
  it("fasst aufeinanderfolgende Einträge desselben Tages zusammen", () => {
    const jetzt = new Date(2026, 8, 26, 21, 30);
    const zeiten = [
      new Date(2026, 8, 26, 21),
      new Date(2026, 8, 26, 9),
      new Date(2026, 8, 25, 18),
    ].map((d) => ({ am: d.toISOString() }));
    const gruppen = gruppiereNachTag(zeiten, (e) => e.am, jetzt);
    expect(gruppen.map((g) => [g.titel, g.eintraege.length])).toEqual([
      ["Heute", 2],
      ["Gestern", 1],
    ]);
  });
});

describe("formatZahl/formatR/formatAnteil", () => {
  it("schreibt deutsch, mit echtem Minus", () => {
    expect(formatZahl(0.17)).toBe("0,17");
    expect(formatZahl(-0.16)).toBe("−0,16");
    expect(formatZahl(1864.2, 1)).toBe("1.864,2");
    expect(formatZahl(Number.POSITIVE_INFINITY)).toBe("∞");
  });

  it("setzt beim Erwartungswert immer ein Vorzeichen, außer bei null", () => {
    expect(formatR(0.01)).toBe("+0,01 R");
    expect(formatR(-0.66)).toBe("−0,66 R");
    expect(formatR(0.001)).toBe("0,00 R");
    expect(formatR(-0.001)).toBe("0,00 R");
  });

  it("schreibt Anteile mit einer Nachkommastelle", () => {
    expect(formatAnteil(39.68)).toBe("39,7 %");
  });
});

describe("kerzenName/formatTagKurz", () => {
  it("nennt Intervalle in Worten", () => {
    expect(kerzenName("1d")).toBe("Tageskerzen");
    expect(kerzenName("15m")).toBe("15-Minuten-Kerzen");
    expect(kerzenName("4h")).toBe("4-Stunden-Kerzen");
    expect(kerzenName("3mo")).toBe("Kerzen zu 3mo");
  });

  it("schreibt Kalendertage kurz und lässt Unlesbares stehen", () => {
    expect(formatTagKurz("2015-01-02")).toBe("2. Jan. 2015");
    expect(formatTagKurz("irgendwann")).toBe("irgendwann");
  });
});
