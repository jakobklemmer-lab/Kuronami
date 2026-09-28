import { describe, expect, it } from "vitest";
import {
  type LehrgangKarte,
  abstand,
  dauer,
  lage,
  lehrgangHtml,
  modellName,
  token,
} from "./system.js";

/**
 * Die Formen der System-Seite. Sie entscheiden, ob eine Zahl als Warnung gelesen wird — „knapp"
 * darf nicht nur in der Farbe stehen, und ein Modell soll so heißen, wie Jakob es kennt.
 */

describe("System-Seite", () => {
  it("nennt Modelle beim Namen, egal ob Kennung oder Kurzname", () => {
    expect(modellName("claude-sonnet-5")).toBe("Sonnet 5");
    expect(modellName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(modellName("opus")).toBe("Opus");
    expect(modellName("(geerbt)")).toBe("(geerbt)");
  });

  it("schreibt Token aus und kürzt erst ab einer Million", () => {
    expect(token(18_400)).toBe("18.400");
    // Intl setzt ein geschütztes Leerzeichen zwischen Zahl und Einheit.
    expect(token(2_350_000).replace(/\s/g, " ")).toBe("2,4 Mio.");
  });

  it("sagt die Lage in Worten, nicht nur in Farbe", () => {
    expect(lage(30)).toEqual({ klasse: "", wort: "" });
    expect(lage(30, true).wort).toBe("wird knapp");
    expect(lage(82).klasse).toBe("meter--knapp");
    expect(lage(97)).toEqual({ klasse: "meter--kritisch", wort: "fast erschöpft" });
  });

  it("rechnet Abstände und Dauern lesbar", () => {
    const jetzt = new Date("2026-09-26T20:39:00Z");
    expect(abstand(jetzt, new Date("2026-09-27T01:20:00Z"))).toBe("4 Std. 41 Min.");
    expect(abstand(jetzt, new Date("2026-10-02T10:00:00Z"))).toBe("6 Tagen");
    expect(dauer(4_200)).toBe("4,2 s");
    expect(dauer(72_000)).toBe("1 Min. 12 s");
  });
});

describe("Lehrgang-Karte", () => {
  const stand: LehrgangKarte = {
    videos: 108,
    transkripte: 105,
    ohneUntertitel: 1,
    offen: 2,
    stunden: 14.5,
    durchgearbeitet: 2,
    kalibrierung: { videos: 14, durchgearbeitet: 2 },
    lehrgang: {
      fenster: [1, 6],
      jeNacht: 15,
      aus: false,
      zuletzt: { zeit: "2026-09-29T00:10:00Z", halt: "Sitzungsfenster bei 72 % (Grenze 70 %)" },
      dieseNacht: { versuche: 3, fertig: 2 },
      letzte: [
        { id: "pCmJ8wsAS_w", titel: "Bollinger <RSI>", zeit: "2026-09-28T23:20:00Z", ok: true },
        {
          id: "bKPs2aOsvsk",
          titel: "EASY Scalping",
          zeit: "2026-09-28T23:15:00Z",
          ok: false,
          grund: "Die Notiz kam ohne <regeln>.",
        },
        { id: "rf_EQvubKlk", titel: "BEST MACD", zeit: "2026-09-28T23:10:00Z", ok: true },
        { id: "rf_EQvubKlk", titel: "BEST MACD", zeit: "2026-09-28T23:05:00Z", ok: false },
      ],
      uebersprungen: [],
    },
  };

  it("zeigt Videos, Transkripte und Durchgearbeitetes samt Kalibrierung", () => {
    const html = lehrgangHtml(stand, new Map());
    expect(html).toContain("108 · 14,5 Std.");
    expect(html).toContain("105 · 2 fehlen noch · 1 ohne Untertitel");
    expect(html).toContain("2 von 105 · Kalibrierung 2 von 14");
    expect(html).toContain("Sitzungsfenster bei 72 % (Grenze 70 %)");
    expect(html).toContain("2 Notizen, 1 gescheitert");
  });

  it("klappt Notizen zu, nennt den Grund eines Fehlschlags und zeigt je Video nur den jüngsten Versuch", () => {
    const html = lehrgangHtml(stand, new Map([["rf_EQvubKlk", "<p>Regeln …</p>"]]));
    expect(html.match(/data-notiz=/g)).toHaveLength(2);
    expect(html.match(/BEST MACD/g)).toHaveLength(1);
    expect(html).toContain("<p>Regeln …</p>");
    expect(html).toContain("gescheitert: Die Notiz kam ohne &lt;regeln&gt;.");
    expect(html).toContain("Bollinger &lt;RSI&gt;");
  });

  it("sagt, wenn der Lehrgang abgeschaltet ist, und wenn noch nichts da ist", () => {
    const aus = lehrgangHtml(
      {
        ...stand,
        durchgearbeitet: 0,
        lehrgang: {
          ...(stand.lehrgang as NonNullable<LehrgangKarte["lehrgang"]>),
          aus: true,
          letzte: [],
          dieseNacht: { versuche: 0, fertig: 0 },
        },
      },
      new Map(),
    );
    expect(aus).toContain("abgeschaltet (KURO_LEHRGANG=aus)");
    expect(aus).not.toContain("Sitzungsfenster");
    expect(aus).toContain("Noch keine Notiz.");
  });
});
