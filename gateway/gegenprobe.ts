import { type Indikator, type Strategie, backtest } from "./backtest.js";
import type { MarketCandle } from "./integrations/markets.js";

/**
 * Die Gegenprobe: dieselbe Regel unter anderen Bedingungen.
 *
 * **Warum ein zweiter Agent allein nichts prüft.** Jakobs Ablauf sah jemanden vor, der den
 * Strategen doppelt überprüft. Ein zweites Sprachmodell, das ein erstes beurteilt, ist aber
 * keine Prüfung, sondern eine zweite Meinung — und zwei Meinungen über dieselben Zahlen sind
 * immer noch keine Zahl. Was wirklich prüft, ist **dieselbe Rechnung unter Bedingungen, die
 * der Stratege nicht ausgesucht hat**:
 *
 *  1. **Andere Zeitfenster** — die Regel über Abschnitte, an denen niemand geschraubt hat.
 *  2. **Andere Märkte** — was am DAX trägt, sollte am S&P nicht zusammenbrechen. Tut es das,
 *     beschreibt die Regel eine Eigenheit dieses einen Verlaufs.
 *  3. **Höhere Kosten** — doppelte Gebühr und doppelte Slippage. Eine Strategie, die daran
 *     stirbt, lebte nur von der Annahme eines perfekten Brokers.
 *  4. **Die Parameter-Nachbarschaft** — Perioden um ±20 % verschoben. Das ist die schärfste
 *     Probe: eine Regel, die bei SMA 50 trägt und bei SMA 40 und SMA 60 zusammenfällt, ist an
 *     einen Zufall angepasst. Ein echter Effekt ist eine **Hochebene**, keine Nadelspitze.
 *
 * Die Aufgabe des prüfenden Agenten ist es, die Probe **auszusuchen und zu deuten** — nicht,
 * das Ergebnis zu bestimmen. Das Ergebnis rechnet dieser Code.
 */

export interface Variante {
  name: string;
  strategie: Strategie;
}

export interface VarianteErgebnis {
  name: string;
  symbol: string;
  anzahl: number;
  erwartungswertR: number;
  trefferquote: number;
  sharpe: number;
  gesamtProzent: number;
  warnungen: number;
}

/** Eine Periode um `anteil` verschieben — mindestens um 1, damit sich überhaupt etwas ändert. */
function verschiebe(wert: number, anteil: number): number {
  const neu = Math.round(wert * (1 + anteil));
  if (neu === wert) return anteil > 0 ? wert + 1 : Math.max(1, wert - 1);
  return Math.max(1, neu);
}

function mitPeriode(ind: Indikator, anteil: number): Indikator {
  if (ind.periode === undefined) return ind;
  return { ...ind, periode: verschiebe(ind.periode, anteil) };
}

/**
 * Die Nachbarschaft einer Strategie: dieselbe Regel mit leicht verschobenen Perioden.
 *
 * Verschoben werden **alle** Perioden gemeinsam, nicht jede einzeln: eine Regel mit vier
 * Parametern hätte sonst sechzehn Varianten, und wer genug Varianten rechnet, findet immer
 * eine gute — das wäre dieselbe Falle noch einmal, nur eine Ebene höher.
 */
export function nachbarschaft(strategie: Strategie): Variante[] {
  const verschiebeBedingungen = (anteil: number) =>
    strategie.einstieg.map((b) => ({
      ...b,
      links: mitPeriode(b.links, anteil),
      rechts: mitPeriode(b.rechts, anteil),
    }));
  const verschiebeAusstieg = (anteil: number) =>
    (strategie.ausstieg ?? []).map((b) => ({
      ...b,
      links: mitPeriode(b.links, anteil),
      rechts: mitPeriode(b.rechts, anteil),
    }));
  // Die Stoplinie wandert mit: beim SuperTrend kommen Signal und Stop aus derselben Linie, und
  // ein Signal aus ST(10) mit dem Stop an ST(12) wäre eine dritte Regel, keine Nachbarin.
  const verschiebeStop = (anteil: number) =>
    strategie.stopAn ? { stopAn: mitPeriode(strategie.stopAn, anteil) } : {};

  return [
    {
      name: "Perioden −20 %",
      strategie: {
        ...strategie,
        einstieg: verschiebeBedingungen(-0.2),
        ...(strategie.ausstieg ? { ausstieg: verschiebeAusstieg(-0.2) } : {}),
        ...verschiebeStop(-0.2),
      },
    },
    {
      name: "Perioden +20 %",
      strategie: {
        ...strategie,
        einstieg: verschiebeBedingungen(0.2),
        ...(strategie.ausstieg ? { ausstieg: verschiebeAusstieg(0.2) } : {}),
        ...verschiebeStop(0.2),
      },
    },
    {
      name: "Kosten verdoppelt",
      strategie: {
        ...strategie,
        gebuehrProzent: (strategie.gebuehrProzent ?? 0.1) * 2,
        schlupfProzent: (strategie.schlupfProzent ?? 0.05) * 2,
      },
    },
  ];
}

/** Eine Variante gegen eine Kerzenreihe rechnen. Wirft nicht — ein Fehlschlag ist ein Ergebnis. */
export function pruefeVariante(
  variante: Variante,
  kerzen: readonly MarketCandle[],
  symbol: string,
  intervall = "1d",
): VarianteErgebnis {
  try {
    const e = backtest(variante.strategie, kerzen, { symbol, intervall });
    return {
      name: variante.name,
      symbol,
      anzahl: e.gesamt.anzahl,
      erwartungswertR: e.gesamt.erwartungswertR,
      trefferquote: e.gesamt.trefferquote,
      sharpe: e.gesamt.sharpe,
      gesamtProzent: e.gesamt.gesamtrenditeProzent,
      warnungen: e.warnungen.length,
    };
  } catch {
    return {
      name: variante.name,
      symbol,
      anzahl: 0,
      erwartungswertR: 0,
      trefferquote: 0,
      sharpe: 0,
      gesamtProzent: 0,
      warnungen: 1,
    };
  }
}

/**
 * Wie viel vom Erwartungswert des Originals eine Variante mindestens behalten muss, um als
 * tragfähig zu zählen.
 *
 * **Warum das Vorzeichen allein nicht reicht.** Bis 2026-09-21 zählte hier nur, ob der
 * Erwartungswert positiv blieb. Der prüfer des Handelstischs hat die Lücke an der ersten
 * ernsthaften Swing-Strategie selbst gefunden und benannt: 0,19 R am Heimatmarkt schrumpften
 * an drei blind gewählten Märkten auf 0,01 bis 0,04 R — und das Werkzeug stempelte „robust",
 * weil drei von drei Vorzeichen stimmten. Eine Kante, die auf ein Zwanzigstel zusammenfällt,
 * ist an ihrem Heimatmarkt angepasst; dass sie dabei knapp über null bleibt, ist kein Beleg,
 * sondern eine Rundungsfrage. Die Hälfte ist großzügig gewählt — Schwankung soll erlaubt sein,
 * Verschwinden nicht.
 */
export const MINDEST_BEHALTEN = 0.5;

/** Varianten mit weniger Handeln sagen nichts und werden nicht gezählt. */
export const MINDEST_HANDEL = 10;

/**
 * Ab welchem Erwartungswert des Originals ein **Anteil davon** überhaupt etwas aussagt.
 *
 * Der erste Lauf mit der Anteilsrechnung hat es sofort gezeigt: bei einem Original von 0,01 R
 * standen in der Spalte „behält" Werte wie 1864 % und −1048 %. Beides ist arithmetisch richtig
 * und inhaltlich nichts — wer durch eine Zahl nahe null teilt, misst die Rundung des
 * Kostenmodells, nicht das Überleben einer Kante. Unterhalb dieser Schwelle bleibt es deshalb
 * bei der schwächeren Aussage (nur das Vorzeichen), und die Spalte sagt ehrlich nichts.
 *
 * Die Höhe ist gewählt, nicht hergeleitet: 0,05 R ist etwa ein Viertel dessen, was hier als
 * normale Kante gilt (+0,2 R je Handel). Darunter ist eine Strategie ohnehin kein Kandidat.
 */
export const MINDEST_REFERENZ_R = 0.05;

export interface GegenprobeUrteil {
  /**
   * Wie viele Varianten mit genug Handeln tragen: positiver Erwartungswert **und** mindestens
   * `MINDEST_BEHALTEN` vom Original.
   */
  tragfaehig: number;
  gepruefte: number;
  anteil: number;
  /** Woran gemessen wird: der Erwartungswert des Originals am Heimatmarkt. */
  referenzR?: number;
  /** Median dessen, was die zählbaren Varianten davon behalten. */
  behaltenMedian?: number;
  /** Rein rechnerisch: „robust" ab zwei Dritteln, „fragil" darunter. Kein Urteil über die Idee. */
  einstufung: "robust" | "wackelig" | "fragil";
}

function median(werte: readonly number[]): number | undefined {
  if (werte.length === 0) return undefined;
  const s = [...werte].sort((a, b) => a - b);
  const mitte = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mitte] : (s[mitte - 1] + s[mitte]) / 2;
}

/**
 * @param referenzR Der Erwartungswert des Originals am Heimatmarkt. Fehlt er oder ist er nicht
 *   positiv, wird nur das Vorzeichen geprüft — an einer Regel, die schon im Original nichts
 *   abwirft, ist ein Anteil davon keine Aussage.
 */
export function urteile(
  ergebnisse: readonly VarianteErgebnis[],
  referenzR?: number,
): GegenprobeUrteil {
  const zaehlbar = ergebnisse.filter((e) => e.anzahl >= MINDEST_HANDEL);
  const referenz =
    referenzR !== undefined && referenzR >= MINDEST_REFERENZ_R ? referenzR : undefined;
  const schwelle = referenz === undefined ? 0 : referenz * MINDEST_BEHALTEN;
  const tragfaehig = zaehlbar.filter(
    (e) => e.erwartungswertR > 0 && e.erwartungswertR >= schwelle,
  ).length;
  const anteil = zaehlbar.length > 0 ? tragfaehig / zaehlbar.length : 0;
  return {
    tragfaehig,
    gepruefte: zaehlbar.length,
    anteil,
    ...(referenz === undefined ? {} : { referenzR: referenz }),
    ...(referenz === undefined
      ? {}
      : { behaltenMedian: median(zaehlbar.map((e) => e.erwartungswertR / referenz)) }),
    einstufung: anteil >= 0.67 ? "robust" : anteil >= 0.5 ? "wackelig" : "fragil",
  };
}

export function formatiereGegenprobe(
  name: string,
  ergebnisse: readonly VarianteErgebnis[],
  urteilDavon: GegenprobeUrteil,
): string {
  const zeilen = [
    `Gegenprobe zu „${name}"`,
    "",
    "Variante                     Markt      Handel  Treffer  Erwartung  Sharpe    Gesamt   behält",
  ];
  const referenz = urteilDavon.referenzR;
  for (const e of ergebnisse) {
    const behalten =
      referenz === undefined ? "—" : `${((e.erwartungswertR / referenz) * 100).toFixed(0)} %`;
    zeilen.push(
      [
        e.name.padEnd(28).slice(0, 28),
        e.symbol.padEnd(10).slice(0, 10),
        String(e.anzahl).padStart(6),
        `${(e.trefferquote * 100).toFixed(0)} %`.padStart(8),
        `${e.erwartungswertR.toFixed(2)} R`.padStart(10),
        e.sharpe.toFixed(2).padStart(7),
        `${e.gesamtProzent.toFixed(1)} %`.padStart(9),
        (e.anzahl >= MINDEST_HANDEL ? behalten : "—").padStart(8),
      ].join(" "),
    );
  }
  zeilen.push(
    "",
    referenz === undefined
      ? `${urteilDavon.tragfaehig} von ${urteilDavon.gepruefte} auswertbaren Varianten behalten einen positiven Erwartungswert — **${urteilDavon.einstufung}**.`
      : `${urteilDavon.tragfaehig} von ${urteilDavon.gepruefte} auswertbaren Varianten tragen — positiv **und** mindestens ${(MINDEST_BEHALTEN * 100).toFixed(0)} % vom Original (${referenz.toFixed(2)} R) — **${urteilDavon.einstufung}**.`,
  );
  if (urteilDavon.behaltenMedian !== undefined) {
    zeilen.push(
      `Im Mittel bleibt von der Kante ${(urteilDavon.behaltenMedian * 100).toFixed(0)} % übrig.`,
    );
  } else {
    zeilen.push(
      "Gemessen wird hier nur das Vorzeichen: das Original wirft zu wenig ab, als dass ein",
      "Anteil davon etwas aussagen würde. Das ist die schwächere Aussage — und der Grund dafür",
      "liegt in der Strategie, nicht in der Prüfung.",
    );
  }
  if (urteilDavon.einstufung !== "robust") {
    zeilen.push(
      "Eine Regel, die nur bei genau diesen Zahlen trägt, beschreibt den Zufall dieses Verlaufs",
      "und nicht das Verhalten des Marktes. Ein echter Effekt ist eine Hochebene, keine Nadelspitze.",
    );
  }
  zeilen.push(
    "",
    `Varianten mit weniger als ${MINDEST_HANDEL} Handeln sind nicht mitgezählt — sie sagen nichts.`,
  );
  if (referenz !== undefined) {
    zeilen.push(
      "Gezählt wird nicht nur das Vorzeichen: eine Variante, die knapp über null landet, während",
      "das Original ein Vielfaches abwirft, ist kein Beleg für die Regel, sondern gegen sie.",
    );
  }
  return zeilen.join("\n");
}
