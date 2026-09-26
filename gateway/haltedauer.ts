/**
 * Wie lange ein Handel voraussichtlich dauert — gerechnet aus der Geschichte des Wertes.
 *
 * **Warum das fehlte und warum es wehtut.** Jakob am 2026-09-21: „auch die anderen Einstiege
 * usw sind nur für langfristige Trades sinnvoll, also alles was mir bis jetzt als Analyse
 * gegeben wurde bezieht sich nur auf langfristiges weil nur Tageskerzen angeschaut wurden."
 * Genau so ist es. Der Handelstisch lieferte Einstieg, Stop und Ziel — drei Kurse ohne
 * Zeitachse. Ein Ziel 2,8 Tagesspannen entfernt ist auf Tageskerzen eine Sache von Wochen; auf
 * Fünfminutenkerzen eine Sache von Stunden. Beides sieht im Bericht identisch aus, und nur eins
 * davon passt zu dem, was der Leser vorhatte.
 *
 * **Gerechnet, nicht geschätzt** — dieselbe Regel wie beim CRV ([[kuronami-crv-gerechnet]]).
 * Die naheliegende Formel „Zielabstand geteilt durch ATR gleich Anzahl Kerzen" wäre eine
 * Schätzung mit Nachkommastellen: ein Kurs geht nicht geradeaus, er zappelt. Ein Ziel zwei
 * ATR entfernt braucht deshalb nicht zwei Kerzen, sondern eher vier bis zehn, je nachdem, wie
 * sehr der Wert trendet. Diese Zahl ist messbar, also wird sie gemessen.
 *
 * **Wie gemessen wird.** Dieselbe Geometrie — Stop und Ziel als Vielfache des ATR — wird über
 * die Vergangenheit des Wertes gelegt: von jeder Kerze aus vorwärts laufen, bis der Kurs
 * entweder das Ziel oder den Stop erreicht, und zählen, wie lange das gedauert hat. Heraus
 * kommt eine Verteilung, kein Punktwert; berichtet werden Median und Quartile, denn die
 * Haltedauer ist schief verteilt und ein Mittelwert würde von wenigen Ausreißern regiert.
 *
 * **Was das ausdrücklich nicht ist: ein Backtest.** Hier gibt es keine Einstiegsregel — es wird
 * von *jeder* Kerze aus gestartet. Die Trefferquote, die dabei herausfällt, ist deshalb keine
 * Kante, sondern die **Baseline**: das, was ein Würfel bei dieser Stop-Ziel-Geometrie
 * erreicht. Ein Setup muss darüber liegen, sonst ist es keins. Genau deshalb steht sie hier und
 * wird so benannt — und der Erwartungswert in R steht daneben, weil eine Trefferquote allein
 * die gefährlichste Zahl am Handelstisch ist.
 */

import type { Richtung } from "./crv.js";
import { atrReihe } from "./indikatoren.js";
import type { MarketCandle } from "./integrations/markets.js";

export interface DauerEingabe {
  kerzen: readonly MarketCandle[];
  richtung: Richtung;
  einstieg: number;
  stop: number;
  /** Das Ziel, auf das sich die Dauer bezieht — bei mehreren das erste. */
  ziel: number;
  atrPeriode?: number;
  /** Nach so vielen Kerzen gilt ein Fall als offen. Vorgabe 250. */
  maxKerzen?: number;
  /** Höchstzahl der Startpunkte; bei langen Reihen wird gleichmäßig ausgedünnt. */
  maxStarts?: number;
}

export interface DauerErgebnis {
  /** Stop- und Zielabstand, in ATR des letzten Standes gemessen. */
  stopInAtr: number;
  zielInAtr: number;
  /** Wie viele Startpunkte geprüft wurden und wie viele davon aufgingen. */
  faelle: number;
  aufgeloest: number;
  /** Anteil der Fälle, die binnen `maxKerzen` weder Ziel noch Stop erreichten. */
  anteilOffen: number;
  /** Kerzen bis zur Auflösung. */
  medianKerzen: number;
  q25Kerzen: number;
  q75Kerzen: number;
  /** Verstrichene Zeit bis zur Auflösung, in Sekunden — Nächte und Wochenenden inbegriffen. */
  medianSekunden: number;
  q25Sekunden: number;
  q75Sekunden: number;
  /**
   * Anteil der aufgelösten Fälle, die zuerst das Ziel erreichten — **ohne Einstiegsregel**,
   * also die Baseline, die ein Setup schlagen muss.
   */
  nullpunktTrefferquote: number;
  /** Erwartungswert in R bei dieser Trefferquote und diesem CRV, ohne Kosten. */
  nullpunktErwartungswertR: number;
}

export class DauerFehler extends Error {}

function quantil(sortiert: readonly number[], anteil: number): number {
  if (sortiert.length === 0) return Number.NaN;
  const stelle = (sortiert.length - 1) * anteil;
  const unten = Math.floor(stelle);
  const oben = Math.ceil(stelle);
  if (unten === oben) return sortiert[unten];
  return sortiert[unten] + (sortiert[oben] - sortiert[unten]) * (stelle - unten);
}

/**
 * Misst die Haltedauer über die Vergangenheit.
 *
 * Zwei Festlegungen, die dieselben sind wie im Backtest — damit die Zahlen vergleichbar
 * bleiben und keine davon freundlicher rechnet als die andere:
 *
 *  * **Der Stop schlägt das Ziel**, wenn beide in derselben Kerze liegen. Aus einer Tageskerze
 *    ist nicht ablesbar, was zuerst kam; die ungünstige Annahme ist die einzige, die nicht
 *    schmeichelt.
 *  * Gestartet wird auf dem **Schluss** der Kerze, nicht auf ihrem Hoch oder Tief.
 */
export function messeHaltedauer(eingabe: DauerEingabe): DauerErgebnis {
  const { kerzen, richtung, einstieg, stop, ziel } = eingabe;
  const atrPeriode = eingabe.atrPeriode ?? 14;
  const maxKerzen = eingabe.maxKerzen ?? 250;
  const maxStarts = eingabe.maxStarts ?? 4000;

  for (const [name, wert] of [
    ["Einstieg", einstieg],
    ["Stop", stop],
    ["Ziel", ziel],
  ] as const) {
    if (!Number.isFinite(wert) || wert <= 0) {
      throw new DauerFehler(`${name} ist keine brauchbare Zahl (${wert}).`);
    }
  }
  const risiko = richtung === "long" ? einstieg - stop : stop - einstieg;
  const chance = richtung === "long" ? ziel - einstieg : einstieg - ziel;
  if (risiko <= 0) {
    throw new DauerFehler(
      `Der Stop liegt auf der falschen Seite des Einstiegs — bei ${richtung === "long" ? "Long" : "Short"} gehört er ${richtung === "long" ? "darunter" : "darüber"}.`,
    );
  }
  if (chance <= 0) {
    throw new DauerFehler("Das Ziel liegt auf der falschen Seite des Einstiegs.");
  }

  const atr = atrReihe(kerzen, atrPeriode);
  const letzterAtr = [...atr].reverse().find((wert) => wert !== undefined);
  if (letzterAtr === undefined || letzterAtr <= 0) {
    throw new DauerFehler(
      `Zu wenige Kerzen für einen ATR über ${atrPeriode} Perioden — ohne ihn gibt es kein Maß für „wie lange dauert eine Bewegung dieser Größe".`,
    );
  }
  const stopInAtr = risiko / letzterAtr;
  const zielInAtr = chance / letzterAtr;

  // Gleichmäßig ausdünnen statt nur den Anfang zu nehmen: eine Stichprobe aus zwei Jahren
  // Seitwärtsmarkt am Reihenanfang würde etwas ganz anderes messen als die ganze Reihe.
  const ersterStart = atrPeriode;
  const letzterStart = kerzen.length - 2;
  const moeglich = Math.max(0, letzterStart - ersterStart + 1);
  const schrittweite = Math.max(1, Math.ceil(moeglich / maxStarts));

  const kerzenBis: number[] = [];
  const sekundenBis: number[] = [];
  let faelle = 0;
  let zielZuerst = 0;

  for (let i = ersterStart; i <= letzterStart; i += schrittweite) {
    const a = atr[i];
    if (a === undefined || a <= 0) continue;
    const start = kerzen[i];
    const stopKurs =
      richtung === "long" ? start.close - stopInAtr * a : start.close + stopInAtr * a;
    const zielKurs =
      richtung === "long" ? start.close + zielInAtr * a : start.close - zielInAtr * a;

    const grenze = Math.min(i + maxKerzen, kerzen.length - 1);
    let aufgegangen = false;
    for (let j = i + 1; j <= grenze; j += 1) {
      const k = kerzen[j];
      const stopGetroffen = richtung === "long" ? k.low <= stopKurs : k.high >= stopKurs;
      const zielGetroffen = richtung === "long" ? k.high >= zielKurs : k.low <= zielKurs;
      if (!stopGetroffen && !zielGetroffen) continue;
      kerzenBis.push(j - i);
      sekundenBis.push(k.time - start.time);
      if (zielGetroffen && !stopGetroffen) zielZuerst += 1;
      aufgegangen = true;
      break;
    }
    // **Abgeschnittene Fälle zählen nicht mit.** Ein Startpunkt kurz vor dem Ende der Reihe hat
    // gar nicht genug Kerzen vor sich, um aufzulaufen — er ist kein Beleg für „das dauert
    // länger als `maxKerzen`", sondern nur ein Beleg dafür, dass die Datei dort aufhört. Wer
    // ihn als „offen" mitzählt, meldet einen Anteil Langläufer, der aus dem Dateiende kommt.
    if (!aufgegangen && i + maxKerzen > kerzen.length - 1) continue;
    faelle += 1;
  }

  if (faelle === 0) {
    throw new DauerFehler("Die Kerzenreihe gibt keinen einzigen Startpunkt her.");
  }
  const aufgeloest = kerzenBis.length;
  if (aufgeloest === 0) {
    throw new DauerFehler(
      `In ${faelle} Anläufen wurde weder Ziel noch Stop binnen ${maxKerzen} Kerzen erreicht — die Geometrie passt nicht zu diesem Intervall.`,
    );
  }

  const sortKerzen = [...kerzenBis].sort((a, b) => a - b);
  const sortSekunden = [...sekundenBis].sort((a, b) => a - b);
  const trefferquote = zielZuerst / aufgeloest;
  const crv = chance / risiko;

  return {
    stopInAtr,
    zielInAtr,
    faelle,
    aufgeloest,
    anteilOffen: (faelle - aufgeloest) / faelle,
    medianKerzen: quantil(sortKerzen, 0.5),
    q25Kerzen: quantil(sortKerzen, 0.25),
    q75Kerzen: quantil(sortKerzen, 0.75),
    medianSekunden: quantil(sortSekunden, 0.5),
    q25Sekunden: quantil(sortSekunden, 0.25),
    q75Sekunden: quantil(sortSekunden, 0.75),
    nullpunktTrefferquote: trefferquote,
    nullpunktErwartungswertR: trefferquote * crv - (1 - trefferquote),
  };
}

/**
 * Sekunden als Zeitspanne, wie ein Mensch sie sagt.
 *
 * Die verstrichene Zeit wird **kalendarisch** genannt, nicht in Handelstagen: sie enthält
 * Nächte und Wochenenden, weil sie aus echten Zeitstempeln kommt. „6 Tage" heißt hier also
 * sechs Tage am Kalender, nicht sechs Handelstage — für die Frage „wann komme ich da wieder
 * raus" ist das die Zahl, die zählt.
 */
export function dauerText(sekunden: number): string {
  if (!Number.isFinite(sekunden) || sekunden < 0) return "unbekannt";
  if (sekunden < 5_400) return `${Math.round(sekunden / 60)} Min`;
  if (sekunden < 172_800) {
    const stunden = sekunden / 3600;
    return `${stunden < 10 ? stunden.toFixed(1) : Math.round(stunden)} Std`;
  }
  const tage = sekunden / 86_400;
  if (tage < 60) return `${tage < 10 ? tage.toFixed(1) : Math.round(tage)} Tage`;
  const monate = tage / 30.44;
  return `${monate < 10 ? monate.toFixed(1) : Math.round(monate)} Monate`;
}

/** Die Zeilen für den Bericht. Wer sie abschreibt, schreibt gerechnete Zahlen ab. */
export function formatiereHaltedauer(e: DauerErgebnis, intervall?: string): string {
  const zeilen = [
    `Voraussichtliche Haltedauer${intervall ? ` (${intervall}-Kerzen)` : ""}`,
    `  Median ${dauerText(e.medianSekunden)} (${e.medianKerzen.toFixed(0)} Kerzen)`,
    `  mittlere Hälfte ${dauerText(e.q25Sekunden)} bis ${dauerText(e.q75Sekunden)} (${e.q25Kerzen.toFixed(0)}–${e.q75Kerzen.toFixed(0)} Kerzen)`,
    `  Stop ${e.stopInAtr.toFixed(2)} ATR entfernt, Ziel ${e.zielInAtr.toFixed(2)} ATR`,
    `  gemessen an ${e.faelle} Stellen der eigenen Geschichte; ${(e.anteilOffen * 100).toFixed(1)} % liefen darin weder ins Ziel noch in den Stop`,
    `  Baseline ohne Einstiegsregel: ${(e.nullpunktTrefferquote * 100).toFixed(1)} % Treffer, Erwartungswert ${e.nullpunktErwartungswertR >= 0 ? "+" : ""}${e.nullpunktErwartungswertR.toFixed(2)} R — ein Setup muss darüber liegen, sonst ist es keins`,
  ];
  return zeilen.join("\n");
}
