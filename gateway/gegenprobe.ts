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
 *  3. **Höhere Kosten** — doppelte Gebühr und doppelter Schlupf. Eine Strategie, die daran
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

  return [
    {
      name: "Perioden −20 %",
      strategie: {
        ...strategie,
        einstieg: verschiebeBedingungen(-0.2),
        ...(strategie.ausstieg ? { ausstieg: verschiebeAusstieg(-0.2) } : {}),
      },
    },
    {
      name: "Perioden +20 %",
      strategie: {
        ...strategie,
        einstieg: verschiebeBedingungen(0.2),
        ...(strategie.ausstieg ? { ausstieg: verschiebeAusstieg(0.2) } : {}),
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
): VarianteErgebnis {
  try {
    const e = backtest(variante.strategie, kerzen, { symbol, intervall: "1d" });
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

export interface GegenprobeUrteil {
  /** Wie viele Varianten mit genug Handeln einen positiven Erwartungswert behalten. */
  tragfaehig: number;
  gepruefte: number;
  anteil: number;
  /** Rein rechnerisch: „robust" ab zwei Dritteln, „fragil" darunter. Kein Urteil über die Idee. */
  einstufung: "robust" | "wackelig" | "fragil";
}

export function urteile(ergebnisse: readonly VarianteErgebnis[]): GegenprobeUrteil {
  const zaehlbar = ergebnisse.filter((e) => e.anzahl >= 10);
  const tragfaehig = zaehlbar.filter((e) => e.erwartungswertR > 0).length;
  const anteil = zaehlbar.length > 0 ? tragfaehig / zaehlbar.length : 0;
  return {
    tragfaehig,
    gepruefte: zaehlbar.length,
    anteil,
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
    "Variante                     Markt      Handel  Treffer  Erwartung  Sharpe  Gesamt",
  ];
  for (const e of ergebnisse) {
    zeilen.push(
      [
        e.name.padEnd(28).slice(0, 28),
        e.symbol.padEnd(10).slice(0, 10),
        String(e.anzahl).padStart(6),
        `${(e.trefferquote * 100).toFixed(0)} %`.padStart(8),
        `${e.erwartungswertR.toFixed(2)} R`.padStart(10),
        e.sharpe.toFixed(2).padStart(7),
        `${e.gesamtProzent.toFixed(1)} %`.padStart(8),
      ].join(" "),
    );
  }
  zeilen.push(
    "",
    `${urteilDavon.tragfaehig} von ${urteilDavon.gepruefte} auswertbaren Varianten behalten einen positiven Erwartungswert — **${urteilDavon.einstufung}**.`,
  );
  if (urteilDavon.einstufung !== "robust") {
    zeilen.push(
      "Eine Regel, die nur bei genau diesen Zahlen trägt, beschreibt den Zufall dieses Verlaufs",
      "und nicht das Verhalten des Marktes. Ein echter Effekt ist eine Hochebene, keine Nadelspitze.",
    );
  }
  zeilen.push(
    "",
    "Varianten mit weniger als zehn Handeln sind nicht mitgezählt — sie sagen nichts.",
  );
  return zeilen.join("\n");
}
