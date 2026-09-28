import { MINDEST_HANDEL, type Strategie, StrategieFehler, backtest } from "./backtest.js";
import { MINDEST_BEHALTEN, MINDEST_REFERENZ_R } from "./gegenprobe.js";
import type { MarketCandle } from "./integrations/markets.js";
import { konfidenz } from "./konfidenz.js";
import type { SchlussprobeVermerk } from "./strategien.js";

/**
 * Die Schlussprobe (28.09.2026): die abgelegte Regel, **unverändert**, auf den Kursen, die bei
 * ihrer Entwicklung gesperrt waren (`sperre.ts`). Genau einmal.
 *
 * Sie ist das Gegenstück zum Versuchsbuch. Das Versuchsbuch macht die Hürde für ein Ergebnis aus
 * der Suche mit jedem Versuch höher; die Schlussprobe ist der andere Weg zum Kandidaten — ein
 * Zeitraum, an dem niemand geschraubt hat, weil ihn niemand sehen konnte.
 *
 * Bestanden heißt: genug Handel, ein positiver Erwartungswert, und davon ist mindestens die
 * Hälfte dessen übrig, was die Suche versprach — dieselbe Hälfte wie in der Gegenprobe. Ein
 * Intervall ganz über null wird nicht verlangt: ein halbes Jahr gibt dafür selten genug Handel
 * her, und die Stichprobe hat schon die Suche belegt. Geprüft wird hier, ob sie hält.
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
  const maerkte: string[] = [];
  let letzte = abUnix;
  for (const reihe of reihen) {
    if (reihe.kerzen.length === 0) continue;
    try {
      const e = backtest(strategie, reihe.kerzen, { symbol: reihe.symbol, intervall });
      for (const h of e.handel) if (h.einstiegZeit >= abUnix) r.push(h.r);
      maerkte.push(reihe.symbol);
      letzte = Math.max(letzte, reihe.kerzen[reihe.kerzen.length - 1].time);
    } catch (fehler) {
      if (!(fehler instanceof StrategieFehler)) throw fehler;
    }
  }
  const anzahl = r.length;
  const erwartungswertR = anzahl === 0 ? 0 : r.reduce((a, b) => a + b, 0) / anzahl;
  const k = konfidenz(r);
  const referenz = Math.max(vorherR, MINDEST_REFERENZ_R);
  const noetig = referenz * MINDEST_BEHALTEN;

  let urteil: SchlussprobeVermerk["urteil"];
  let begruendung: string;
  if (anzahl < MINDEST_HANDEL) {
    urteil = "zu wenig Handel";
    begruendung = `Nur ${anzahl} Handel seit ${tag(abUnix)} — unter ${MINDEST_HANDEL} ist jedes Ergebnis Zufall. Die Probe darf später noch einmal laufen.`;
  } else if (erwartungswertR <= 0) {
    urteil = "nicht bestanden";
    begruendung = `Auf den gesperrten Kursen ${vorz(erwartungswertR)} R je Handel über ${anzahl} Handel — die Suche hatte ${vorz(vorherR)} R versprochen.`;
  } else if (erwartungswertR < noetig) {
    urteil = "nicht bestanden";
    begruendung = `${vorz(erwartungswertR)} R je Handel über ${anzahl} Handel — weniger als die Hälfte der ${vorz(vorherR)} R aus der Suche. Was übrig bleibt, ist eher Anpassung als Kante.`;
  } else {
    urteil = "bestanden";
    begruendung = `${vorz(erwartungswertR)} R je Handel über ${anzahl} Handel auf Kursen, die bei der Entwicklung niemand gesehen hat — die Suche hatte ${vorz(vorherR)} R versprochen.`;
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
    ? `, 95-%-Intervall ${vorz(v.konfidenz.unten)} bis ${vorz(v.konfidenz.oben)} R`
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
