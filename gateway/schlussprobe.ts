import { MINDEST_HANDEL, type Strategie, StrategieFehler, backtest } from "./backtest.js";
import { MINDEST_BEHALTEN, MINDEST_REFERENZ_R } from "./gegenprobe.js";
import type { MarketCandle } from "./integrations/markets.js";
import { blocklaenge, konfidenz } from "./konfidenz.js";
import type { SchlussprobeVermerk } from "./strategien.js";

/**
 * Die Schlussprobe (28.09.2026): die abgelegte Regel, **unverändert**, auf den Kursen, die bei
 * ihrer Entwicklung gesperrt waren (`sperre.ts`). Genau einmal.
 *
 * Sie ist das Gegenstück zum Versuchsbuch. Das Versuchsbuch macht die Hürde für ein Ergebnis aus
 * der Suche mit jedem Versuch höher; die Schlussprobe ist der andere Weg zum Kandidaten — ein
 * Zeitraum, an dem niemand geschraubt hat, weil ihn niemand sehen konnte.
 *
 * **Das Urteil kommt aus einem Intervall, nicht aus einem Mittelwert (seit 28.09. abends).**
 * Vorher hieß bestanden: 30 Handel, Ø R über null und mindestens die Hälfte des Versprochenen.
 * Nachgerechnet am SuperTrend-Fund (Streuung 2,66 R je Handel) war das ein Münzwurf: eine Regel
 * mit genau der versprochenen Kante bestand in 45 % der Fälle, eine **ohne jede Kante in 33 %**.
 * Bei so breiten Verteilungen sagt der Mittelwert von 30 Handeln nichts.
 *
 * Jetzt, über alle Märkte in Zeitblöcken gezogen und mit 99 % (die Probe darf wiederholt werden,
 * solange sie offen ist — jede Wiederholung ist ein Blick mehr):
 *  - **nicht bestanden**, wenn es ganz unter der Hälfte des Versprochenen liegt — auch über
 *    null: dann gibt es eine Kante, aber nicht die, die die Suche versprach,
 *  - **bestanden**, wenn es ganz über null liegt (und nicht ganz unter der Hälfte),
 *  - sonst ist sie **offen** („zu wenig Handel") und nennt, wie viele Handel es ungefähr braucht.
 * Eine Regel ohne Kante besteht so in rund einem von hundert Fällen statt in einem von drei.
 * Der Preis ist Zeit: eine Trendfolge-Regel mit +0,14 R braucht dafür Tausende Handel.
 *
 * Gerechnet wird über die ganze Reihe, damit Durchschnitte wie die DEMA 200 am Beginn der Probe
 * schon eingeschwungen sind; gezählt werden nur Handel, die ab `ab` beginnen.
 */

export interface ProbenReihe {
  symbol: string;
  kerzen: readonly MarketCandle[];
}

const tag = (unix: number): string => new Date(unix * 1000).toISOString().slice(0, 10);
const komma = (x: number, stellen = 2): string => x.toFixed(stellen).replace(".", ",");
const vorz = (x: number): string => `${x >= 0 ? "+" : "−"}${komma(Math.abs(x))}`;

export function rechneSchlussprobe(
  strategie: Strategie,
  reihen: readonly ProbenReihe[],
  abUnix: number,
  vorherR: number,
  intervall: string,
  jetzt: Date = new Date(),
): SchlussprobeVermerk {
  const r: number[] = [];
  const handel: { einstiegZeit: number; ausstiegZeit: number }[] = [];
  const maerkte: string[] = [];
  let letzte = abUnix;
  for (const reihe of reihen) {
    if (reihe.kerzen.length === 0) continue;
    try {
      const e = backtest(strategie, reihe.kerzen, { symbol: reihe.symbol, intervall });
      for (const h of e.handel) {
        if (h.einstiegZeit < abUnix) continue;
        r.push(h.r);
        handel.push(h);
      }
      maerkte.push(reihe.symbol);
      letzte = Math.max(letzte, reihe.kerzen[reihe.kerzen.length - 1].time);
    } catch (fehler) {
      if (!(fehler instanceof StrategieFehler)) throw fehler;
    }
  }
  const anzahl = r.length;
  const erwartungswertR = anzahl === 0 ? 0 : r.reduce((a, b) => a + b, 0) / anzahl;
  const k = konfidenz(r, {
    zeiten: handel.map((h) => h.einstiegZeit),
    blockSekunden: blocklaenge(handel),
    rand: 0.005,
  });
  const referenz = Math.max(vorherR, MINDEST_REFERENZ_R);
  const noetig = referenz * MINDEST_BEHALTEN;

  let urteil: SchlussprobeVermerk["urteil"];
  let begruendung: string;
  if (anzahl < MINDEST_HANDEL || k === undefined) {
    urteil = "zu wenig Handel";
    begruendung = `Nur ${anzahl} Handel seit ${tag(abUnix)} — unter ${MINDEST_HANDEL} ist jedes Ergebnis Zufall. Die Probe darf später noch einmal laufen.`;
  } else if (k.oben < noetig) {
    urteil = "nicht bestanden";
    begruendung = `${vorz(erwartungswertR)} R je Handel über ${anzahl} Handel; selbst der obere Rand des 99-%-Intervalls (${vorz(k.oben)} R) liegt unter der Hälfte der ${vorz(vorherR)} R aus der Suche. Was die Suche fand, war eher Anpassung als Kante.`;
  } else if (k.unten > 0) {
    urteil = "bestanden";
    begruendung = `${vorz(erwartungswertR)} R je Handel über ${anzahl} Handel auf Kursen, die bei der Entwicklung niemand gesehen hat, und das 99-%-Intervall (${vorz(k.unten)} bis ${vorz(k.oben)} R) liegt ganz über null — die Suche hatte ${vorz(vorherR)} R versprochen.`;
  } else {
    urteil = "zu wenig Handel";
    const streuung = k.streuung ?? 0;
    const schaetzung =
      streuung > 0
        ? ` Bei ${komma(streuung)} R Streuung je Handel braucht es, um ${vorz(referenz)} R von null zu trennen, grob ${Math.ceil((((2.58 + 0.84) * streuung) / referenz) ** 2)} Handel.`
        : "";
    begruendung = `Noch offen: ${vorz(erwartungswertR)} R über ${anzahl} Handel, 99-%-Intervall ${vorz(k.unten)} bis ${vorz(k.oben)} R — das schließt „keine Kante" so wenig aus wie „die versprochene".${schaetzung} Die Probe darf später noch einmal laufen.`;
  }

  return {
    am: jetzt.toISOString(),
    von: tag(abUnix),
    bis: tag(letzte),
    maerkte,
    anzahl,
    erwartungswertR,
    ...(k ? { konfidenz: k } : {}),
    vorherR,
    urteil,
    begruendung,
  };
}

export function formatiereSchlussprobe(name: string, v: SchlussprobeVermerk): string {
  const intervall = v.konfidenz
    ? `, 99-%-Intervall ${vorz(v.konfidenz.unten)} bis ${vorz(v.konfidenz.oben)} R`
    : "";
  return [
    `## Schlussprobe: ${name}`,
    "",
    `Gesperrter Zeitraum ${v.von} bis ${v.bis}, ${v.maerkte.length} Markt/Märkte (${v.maerkte.join(", ")}).`,
    `${v.anzahl} Handel, Ø ${vorz(v.erwartungswertR)} R${intervall}.`,
    "",
    `**${v.urteil}** — ${v.begruendung}`,
  ].join("\n");
}
