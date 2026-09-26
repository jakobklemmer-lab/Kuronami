/**
 * Dieselbe Regel über viele Märkte — die schärfste Probe, die es hier gibt.
 *
 * **Warum das die eigentliche Prüfung ist.** Jakob hat die Frage selbst gestellt: „ob man nicht
 * die Strategie für jedes Währungspaar, für jede Aktie usw abändern muss". Die Antwort trennt
 * zwei Dinge, die im Backtest gleich aussehen:
 *
 *  * Ein **Mechanismus** ist eine Aussage über Verhalten — wer handelt gegen dich und warum
 *    verliert er. Er sollte überall wirken, wo dieses Verhalten vorkommt, nur unterschiedlich
 *    stark.
 *  * Eine **Kurvenanpassung** ist eine Aussage über *einen* Verlauf. Sie trägt dort, wo sie
 *    gebaut wurde, und nirgends sonst.
 *
 * Beide liefern auf ihrem Heimatmarkt schöne Zahlen. Nur die Übertragung unterscheidet sie, und
 * nur **unverändert**: wer je Markt nachjustiert, prüft nicht mehr die Regel, sondern seine
 * Fähigkeit, Parameter zu finden — und die hat noch jeder.
 *
 * **Der gemeinsame Topf ist der Kern.** Zwölf Märkte mit je 25 Handeln sind einzeln nichts
 * (`MINDEST_HANDEL` ist 30, und ein Konfidenzintervall über 25 Handel ist so breit wie die
 * Skala). Zusammengeworfen sind es 300 Handel — und weil alles in R gerechnet ist, sind sie
 * vergleichbar. Deshalb steht hier ein Intervall über **alle** Handel, nicht nur eine Tabelle
 * je Markt. Eine Kante, die über zwölf Märkte hinweg belegt ist, ist etwas anderes als zwölf
 * Kennzahlen, von denen zwei gut aussehen.
 *
 * **Was hier bewusst fehlt: eine Bestenliste.** Der beste Markt einer Liste ist immer gut —
 * das ist die Auswahl, nicht die Regel. Die Einstufung sieht deshalb auf den Median und auf
 * den gemeinsamen Topf, nie auf den Spitzenreiter.
 */

import { type Strategie, backtest } from "./backtest.js";
import type { MarketCandle } from "./integrations/markets.js";
import { type Konfidenz, konfidenz, nullEingeschlossen } from "./konfidenz.js";

export interface MarktKerzen {
  symbol: string;
  kerzen: readonly MarketCandle[];
}

export interface MarktErgebnis {
  symbol: string;
  anzahl: number;
  erwartungswertR: number;
  trefferquote: number;
  sharpe: number;
  gesamtProzent: number;
  kaufUndHaltenProzent: number;
  /** Untere Grenze des 95-%-Intervalls, wenn es genug Handel gab. */
  konfidenzUnten?: number;
  /** Was dieselbe Geometrie ohne Einstiegsregel gebracht hätte. */
  nullpunktR?: number;
  warnungen: number;
  /** Gesetzt, wenn dieser Markt gar nicht gerechnet werden konnte. */
  fehler?: string;
  /**
   * Zu wenige Handel für eine Aussage — der Markt steht in der Tabelle, zählt aber nicht als
   * Beleg. Ohne diese Grenze macht ein Markt mit **einem** Handel aus „zwei von drei tragen"
   * eine Aussage, die auf einer einzigen Kerze steht.
   */
  zuWenigeHandel?: boolean;
}

/** Ab so vielen Handeln zählt ein einzelner Markt als Beleg — dieselbe Grenze wie beim Intervall. */
export const MINDEST_HANDEL_JE_MARKT = 10;

export type Uebertragbarkeit = "uebertragbar" | "gemischt" | "einzelfall";

export interface UniversumErgebnis {
  strategie: string;
  maerkte: MarktErgebnis[];
  /** Wie viele Märkte überhaupt gerechnet werden konnten. */
  gerechnet: number;
  /** Wie viele davon einen positiven Erwartungswert hatten. */
  positiv: number;
  medianErwartungswertR: number;
  /** Alle Handel aller Märkte zusammen. */
  gesamtHandel: number;
  gemeinsamErwartungswertR: number;
  gemeinsam?: Konfidenz;
  /** Wie viel vom Ergebnis am besten Markt hängt: sein Anteil an der Summe aller R. */
  anteilBesterMarkt: number;
  /**
   * Wie viele der bewertbaren Märkte ihre eigene **Baseline** schlagen — also mehr bringen
   * als dieselbe Stop-Ziel-Geometrie ganz ohne Einstiegsregel. `undefined`, wenn sich für
   * keinen Markt eine Baseline rechnen ließ.
   */
  schlaegtNullpunkt?: { davon: number; von: number };
  einstufung: Uebertragbarkeit;
  begruendung: string;
}

function median(werte: readonly number[]): number {
  if (werte.length === 0) return 0;
  const s = [...werte].sort((a, b) => a - b);
  const mitte = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mitte] : (s[mitte - 1] + s[mitte]) / 2;
}

/**
 * Die Regel über alle übergebenen Märkte, **ohne** je Markt etwas zu verändern.
 *
 * Ein Markt, an dem der Backtest scheitert (zu wenige Kerzen, fehlendes Volumen für einen
 * VWAP), fällt mit seiner Begründung heraus und zählt nicht als Ergebnis. Ihn stillschweigend
 * zu überspringen wäre die bequemste Art, eine Regel gut aussehen zu lassen.
 */
export function ueberMaerkte(
  strategie: Strategie,
  maerkte: readonly MarktKerzen[],
  optionen: { intervall?: string } = {},
): UniversumErgebnis {
  const ergebnisse: MarktErgebnis[] = [];
  const alleR: number[] = [];
  const rJeMarkt = new Map<string, number>();

  for (const markt of maerkte) {
    try {
      const e = backtest(strategie, markt.kerzen, {
        symbol: markt.symbol,
        intervall: optionen.intervall,
      });
      for (const h of e.handel) alleR.push(h.r);
      rJeMarkt.set(
        markt.symbol,
        e.handel.reduce((summe, h) => summe + h.r, 0),
      );
      ergebnisse.push({
        symbol: markt.symbol,
        anzahl: e.gesamt.anzahl,
        erwartungswertR: e.gesamt.erwartungswertR,
        trefferquote: e.gesamt.trefferquote,
        sharpe: e.gesamt.sharpe,
        gesamtProzent: e.gesamt.gesamtrenditeProzent,
        kaufUndHaltenProzent: e.kaufUndHaltenProzent,
        ...(e.gesamt.konfidenz ? { konfidenzUnten: e.gesamt.konfidenz.unten } : {}),
        ...(e.nullpunkt ? { nullpunktR: e.nullpunkt.erwartungswertR } : {}),
        warnungen: e.warnungen.length,
        ...(e.gesamt.anzahl < MINDEST_HANDEL_JE_MARKT ? { zuWenigeHandel: true } : {}),
      });
    } catch (fehler) {
      ergebnisse.push({
        symbol: markt.symbol,
        anzahl: 0,
        erwartungswertR: 0,
        trefferquote: 0,
        sharpe: 0,
        gesamtProzent: 0,
        kaufUndHaltenProzent: 0,
        warnungen: 0,
        fehler: fehler instanceof Error ? fehler.message : String(fehler),
      });
    }
  }

  const gerechnete = ergebnisse.filter(
    (e) => e.fehler === undefined && e.anzahl >= MINDEST_HANDEL_JE_MARKT,
  );
  const positiv = gerechnete.filter((e) => e.erwartungswertR > 0).length;
  const gemeinsamErwartungswertR =
    alleR.length > 0 ? alleR.reduce((a, b) => a + b, 0) / alleR.length : 0;
  const gemeinsam = konfidenz(alleR);

  // Wie stark hängt das Gesamtergebnis an einem einzigen Markt? Summe aller positiven
  // Markt-R-Summen als Nenner — sonst könnte ein Verlustmarkt den Anteil über 100 % treiben.
  const positiveSummen = [...rJeMarkt.values()].filter((w) => w > 0);
  const summePositiv = positiveSummen.reduce((a, b) => a + b, 0);
  const bester = positiveSummen.length > 0 ? Math.max(...positiveSummen) : 0;
  const anteilBesterMarkt = summePositiv > 0 ? bester / summePositiv : 0;

  const medianEw = median(gerechnete.map((e) => e.erwartungswertR));

  // **Der Vergleich, der eine übertragbare Regel von einer übertragbaren *Geometrie* trennt.**
  // Eine Regel kann über zehn Märkte hinweg positiv sein und trotzdem nichts leisten: wenn
  // dieselbe Stop-Ziel-Geometrie ohne jede Einstiegsregel dasselbe bringt, ist das Ergebnis
  // eine Eigenschaft von Stop und Ziel, nicht der Regel. Und Stop und Ziel wählt man frei.
  const mitNullpunkt = gerechnete.filter((e) => e.nullpunktR !== undefined);
  const schlaegtNullpunkt =
    mitNullpunkt.length > 0
      ? {
          davon: mitNullpunkt.filter((e) => e.erwartungswertR > (e.nullpunktR ?? 0)).length,
          von: mitNullpunkt.length,
        }
      : undefined;
  const nullpunktVerfehlt =
    schlaegtNullpunkt !== undefined && schlaegtNullpunkt.davon <= schlaegtNullpunkt.von / 2;

  let einstufung: Uebertragbarkeit;
  let begruendung: string;
  if (gerechnete.length < 3) {
    einstufung = "einzelfall";
    begruendung = `Nur ${gerechnete.length} Markt${gerechnete.length === 1 ? "" : "e"} gerechnet — über Übertragbarkeit sagt das nichts. Nimm mindestens drei.`;
  } else if (anteilBesterMarkt > 0.6) {
    // **Die Konzentrationsprüfung steht vor allem anderen.** Ein gemeinsamer Topf kann ein
    // sauberes Intervall haben und trotzdem von einem einzigen Markt gefüllt sein — dann ist
    // die Zusammenfassung nur eine andere Art, denselben Einzelfall zu zeigen.
    einstufung = "einzelfall";
    begruendung = `${(anteilBesterMarkt * 100).toFixed(0)} % des gesamten Gewinns kommen aus einem einzigen Markt. Ohne ihn bleibt nichts — die Regel beschreibt diesen einen Verlauf, egal wie der gemeinsame Topf aussieht.`;
  } else if (nullpunktVerfehlt && schlaegtNullpunkt !== undefined) {
    einstufung = "gemischt";
    begruendung = `Die Regel schlägt ihre eigene Baseline nur an ${schlaegtNullpunkt.davon} von ${schlaegtNullpunkt.von} Märkten — auf den anderen bringt dieselbe Stop-Ziel-Geometrie ohne jede Einstiegsregel dasselbe oder mehr. Was hier überträgt, ist die Geometrie, nicht die Regel. Der Erwartungswert über alle Handel liegt bei ${gemeinsamErwartungswertR >= 0 ? "+" : ""}${gemeinsamErwartungswertR.toFixed(2)} R.`;
  } else if (gemeinsam !== undefined && !nullEingeschlossen(gemeinsam) && gemeinsam.unten > 0) {
    if (positiv / gerechnete.length >= 2 / 3) {
      einstufung = "uebertragbar";
      begruendung = `Über alle ${gerechnete.length} Märkte zusammen ${alleR.length} Handel, Erwartungswert +${gemeinsamErwartungswertR.toFixed(2)} R mit einem Intervall, das die Null nicht einschließt — und ${positiv} von ${gerechnete.length} Märkten tragen einzeln. Das ist das Muster eines Mechanismus, nicht einer Anpassung.`;
    } else {
      einstufung = "gemischt";
      begruendung = `Der gemeinsame Topf ist belegt (+${gemeinsamErwartungswertR.toFixed(2)} R), aber nur ${positiv} von ${gerechnete.length} Märkten tragen einzeln. Kläre, was die tragenden Märkte gemeinsam haben, bevor du das für eine allgemeine Regel hältst.`;
    }
  } else if (positiv <= gerechnete.length / 2) {
    einstufung = "einzelfall";
    begruendung = `Nur ${positiv} von ${gerechnete.length} Märkten tragen, und über alle zusammen ist der Erwartungswert nicht von null zu unterscheiden.`;
  } else {
    einstufung = "gemischt";
    begruendung = `${positiv} von ${gerechnete.length} Märkten tragen, aber über alle ${alleR.length} Handel zusammen ist der Erwartungswert (${gemeinsamErwartungswertR >= 0 ? "+" : ""}${gemeinsamErwartungswertR.toFixed(2)} R) nicht von null zu unterscheiden. Mehr Märkte oder ein längerer Zeitraum würden das entscheiden.`;
  }

  return {
    strategie: strategie.name,
    maerkte: ergebnisse,
    gerechnet: gerechnete.length,
    positiv,
    medianErwartungswertR: medianEw,
    gesamtHandel: alleR.length,
    gemeinsamErwartungswertR,
    ...(gemeinsam ? { gemeinsam } : {}),
    anteilBesterMarkt,
    ...(schlaegtNullpunkt !== undefined ? { schlaegtNullpunkt } : {}),
    einstufung,
    begruendung,
  };
}

const ETIKETT: Record<Uebertragbarkeit, string> = {
  uebertragbar: "ÜBERTRAGBAR",
  gemischt: "GEMISCHT",
  einzelfall: "EINZELFALL",
};

export function formatiereUniversum(e: UniversumErgebnis): string {
  const zeilen = [
    `${e.strategie} — dieselbe Regel über ${e.maerkte.length} Märkte, unverändert`,
    "",
    "Markt          Handel  EW in R  Treffer   Baseline  Sharpe  gegen Buy-and-Hold",
  ];
  for (const m of e.maerkte) {
    if (m.fehler !== undefined) {
      zeilen.push(`${m.symbol.padEnd(15)} — nicht gerechnet: ${m.fehler}`);
      continue;
    }
    zeilen.push(
      [
        m.symbol.padEnd(15),
        String(m.anzahl).padStart(6),
        `${m.erwartungswertR >= 0 ? "+" : ""}${m.erwartungswertR.toFixed(2)}`.padStart(9),
        `${(m.trefferquote * 100).toFixed(0)} %`.padStart(9),
        (m.nullpunktR === undefined
          ? "—"
          : `${m.nullpunktR >= 0 ? "+" : ""}${m.nullpunktR.toFixed(2)}`
        ).padStart(11),
        m.sharpe.toFixed(2).padStart(8),
        `${(m.gesamtProzent - m.kaufUndHaltenProzent).toFixed(1)} %`.padStart(20),
        m.zuWenigeHandel ? "   (zu wenige Handel — zählt nicht)" : "",
      ].join(""),
    );
  }

  zeilen.push(
    "",
    `Zusammen: ${e.gesamtHandel} Handel, davon ${e.gerechnet} Märkte mit genug Handeln für eine eigene Aussage; Erwartungswert ${e.gemeinsamErwartungswertR >= 0 ? "+" : ""}${e.gemeinsamErwartungswertR.toFixed(2)} R`,
  );
  if (e.gemeinsam) {
    zeilen.push(
      `  95-%-Intervall ${e.gemeinsam.unten >= 0 ? "+" : ""}${e.gemeinsam.unten.toFixed(2)} bis ${e.gemeinsam.oben >= 0 ? "+" : ""}${e.gemeinsam.oben.toFixed(2)} R`,
    );
  }
  zeilen.push(
    `  Median je Markt ${e.medianErwartungswertR >= 0 ? "+" : ""}${e.medianErwartungswertR.toFixed(2)} R · ${e.positiv} von ${e.gerechnet} Märkten positiv · bester Markt trägt ${(e.anteilBesterMarkt * 100).toFixed(0)} % des Gewinns`,
    ...(e.schlaegtNullpunkt
      ? [
          `  Schlägt die eigene Baseline an ${e.schlaegtNullpunkt.davon} von ${e.schlaegtNullpunkt.von} Märkten`,
        ]
      : []),
    "",
    `**${ETIKETT[e.einstufung]}** — ${e.begruendung}`,
    "",
    "Die Einstufung ist gerechnet, nicht geurteilt. Sie sieht auf den Median und den",
    "gemeinsamen Topf, nie auf den besten Markt: der beste Markt einer Liste ist immer gut.",
  );
  return zeilen.join("\n");
}
