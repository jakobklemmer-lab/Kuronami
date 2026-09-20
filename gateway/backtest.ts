import type { Richtung } from "./crv.js";
import {
  type Reihe,
  adx,
  atrReihe,
  bollinger,
  ema,
  macd,
  obv,
  rollendesHoch,
  rollendesTief,
  rsi,
  schlusskurse,
  sma,
  stdabw,
  stochastik,
} from "./indikatoren.js";
import type { MarketCandle } from "./integrations/markets.js";

/**
 * Der Backtest: eine Strategie gegen echte Kerzen laufen lassen und **nachrechenbar** sagen,
 * was dabei herauskäme.
 *
 * Jakobs Ziel steht am Anfang dieses Moduls, damit niemand es beim Ändern vergisst: ein Agent,
 * der irgendwann von selbst eine Strategie mit hoher Trefferquote und guter Sharpe-Ratio live
 * handelt — mit echtem Geld. Alles hier ist auf die Frage gebaut, ob man einem Ergebnis
 * *glauben* darf, nicht darauf, ein schönes Ergebnis zu erzeugen.
 *
 * **Die drei Stellen, an denen ein Backtest lügt, und was hier dagegen steht:**
 *
 *  1. **Blick in die Zukunft.** Bedingungen werden auf einer **abgeschlossenen** Kerze geprüft,
 *     gekauft wird zur **Eröffnung der nächsten**. Kein Einstieg zum Schlusskurs derselben
 *     Kerze, die das Signal gab — den gab es an der Börse nicht.
 *  2. **Der günstige Zufall innerhalb einer Kerze.** Liegen Stop und Ziel in derselben Kerze,
 *     zählt **der Stop**. Ohne Tickdaten weiß niemand, was zuerst kam; die pessimistische
 *     Annahme ist die einzige, die nicht schmeichelt.
 *  3. **Anpassung an die Vergangenheit.** Jeder Lauf wird in zwei Hälften berichtet: der Teil,
 *     an dem man schraubt, und der Teil, den man dabei nicht gesehen hat. Weichen sie stark
 *     voneinander ab, steht das als Warnung im Ergebnis — nicht im Kleingedruckten.
 *
 * Gebühren und Schlupf sind Pflichtparameter mit Vorgabe, keine Option: ein Backtest ohne
 * Kosten ist bei kurzen Haltedauern die häufigste Art, sich selbst zu betrügen.
 */

export type IndikatorArt =
  | "kurs"
  | "wert"
  | "sma"
  | "ema"
  | "rsi"
  | "atr"
  | "hoch"
  | "tief"
  | "stdabw"
  | "macd"
  | "macd_signal"
  | "macd_histogramm"
  | "adx"
  | "di_plus"
  | "di_minus"
  | "stoch_k"
  | "stoch_d"
  | "bollinger_oben"
  | "bollinger_mitte"
  | "bollinger_unten"
  | "bollinger_breite"
  | "obv";

export interface Indikator {
  art: IndikatorArt;
  /**
   * Die erste Periode. Vorgaben je Art: 14 für rsi/atr/adx/stoch, 20 für bollinger, 12 für die
   * schnelle MACD-Linie.
   */
  periode?: number;
  /** Zweite Periode: die langsame MACD-Linie (26) oder die Glättung von %K (3). */
  periode2?: number;
  /** Dritte Periode: die MACD-Signallinie (9) oder die Glättung von %D (3). */
  periode3?: number;
  /** Bandabstand der Bollinger-Bänder in Standardabweichungen. Vorgabe 2. */
  faktor?: number;
  /** Für `kurs`: welches Feld der Kerze. Vorgabe `close`. */
  feld?: "open" | "high" | "low" | "close";
  /** Für `wert`: die Konstante. */
  wert?: number;
}

export type Vergleich = "ueber" | "unter" | "kreuzt_ueber" | "kreuzt_unter";

export interface Bedingung {
  links: Indikator;
  vergleich: Vergleich;
  rechts: Indikator;
}

export interface Strategie {
  name: string;
  richtung: Richtung;
  /** **Alle** müssen zutreffen. Eine leere Liste wäre „immer kaufen" und wird abgewiesen. */
  einstieg: Bedingung[];
  /** **Eine** genügt. Optional — ohne Ausstiegsregel tragen Stop, Ziel und Zeit den Handel. */
  ausstieg?: Bedingung[];
  /** Stop als Vielfaches des ATR(14) zum Einstiegszeitpunkt. */
  stopAtr?: number;
  /** Stop in Prozent vom Einstieg. Entweder das oder `stopAtr`, nicht beides. */
  stopProzent?: number;
  /** Ziel als Vielfaches des Risikos (1 R = Abstand Einstieg → Stop). */
  zielR?: number;
  /** Ziel in Prozent vom Einstieg. */
  zielProzent?: number;
  /** Nach so vielen Kerzen wird glattgestellt, auch ohne Signal. */
  maxKerzen?: number;
  /** Je Seite, in Prozent. Vorgabe 0,1 % Gebühr und 0,05 % Schlupf. */
  gebuehrProzent?: number;
  schlupfProzent?: number;
}

export type Ausstiegsgrund = "stop" | "ziel" | "regel" | "zeit" | "ende";

export interface Handel {
  einstiegZeit: number;
  ausstiegZeit: number;
  einstieg: number;
  ausstieg: number;
  stop: number;
  ziel: number | null;
  grund: Ausstiegsgrund;
  /** Nach Kosten, in Prozent auf den Einsatz. */
  renditeProzent: number;
  /** Nach Kosten, in Vielfachen des anfänglichen Risikos. Die ehrlichere Zahl. */
  r: number;
  kerzen: number;
}

export interface Kennzahlen {
  anzahl: number;
  /** Anteil der Handel mit R > 0. */
  trefferquote: number;
  durchschnittR: number;
  /** Erwartungswert je Handel in R — die Zahl, die zählt. Trefferquote allein sagt nichts. */
  erwartungswertR: number;
  profitFaktor: number;
  gesamtrenditeProzent: number;
  maxDrawdownProzent: number;
  /** Annualisiert aus den Renditen der Kapitalkurve je Kerze. */
  sharpe: number;
  /**
   * Wie Sharpe, aber nur die Abwärtsschwankung im Nenner. Eine Strategie, die in Sprüngen
   * gewinnt und ruhig verliert, wird von Sharpe bestraft und von Sortino richtig bewertet.
   */
  sortino: number;
  /** Durchschnittlicher Gewinn und Verlust je Handel, in R — die zwei Zahlen hinter der Trefferquote. */
  durchschnittGewinnR: number;
  durchschnittVerlustR: number;
  groessterGewinnR: number;
  groessterVerlustR: number;
  laengsteVerlustserie: number;
  durchschnittKerzen: number;
}

export interface Abschnitt {
  von: string;
  bis: string;
  kennzahlen: Kennzahlen;
}

export interface BacktestErgebnis {
  strategie: string;
  symbol: string;
  richtung: Richtung;
  von: string;
  bis: string;
  kerzen: number;
  intervall: string;
  handel: Handel[];
  gesamt: Kennzahlen;
  /** Der Teil, an dem man schrauben darf. */
  inSample: Abschnitt;
  /** Der Teil, den man dabei nicht gesehen hat. */
  outOfSample: Abschnitt;
  /**
   * Was derselbe Zeitraum mit Kaufen-und-Liegenlassen gebracht hätte. Die Vergleichszahl, ohne
   * die jede Strategie gut aussieht: wer in einem Aufwärtsjahr 20 % macht, während der Markt
   * 40 % läuft, hat nichts gewonnen, sondern die Hälfte liegen gelassen.
   */
  kaufUndHaltenProzent: number;
  /** Was an diesem Ergebnis nicht zu trauen ist. Leer heißt: nichts aufgefallen. */
  warnungen: string[];
  kosten: { gebuehrProzent: number; schlupfProzent: number };
}

export class StrategieFehler extends Error {}

const VORGABE_GEBUEHR = 0.1;
const VORGABE_SCHLUPF = 0.05;
/** Unter so vielen Handeln ist jede Kennzahl Zufall. */
export const MINDEST_HANDEL = 30;

function reiheFuer(ind: Indikator, kerzen: readonly MarketCandle[]): Reihe {
  const schluss = schlusskurse(kerzen);
  const periode = ind.periode ?? 14;
  switch (ind.art) {
    case "kurs":
      return kerzen.map((k) => k[ind.feld ?? "close"]);
    case "wert": {
      if (ind.wert === undefined) throw new StrategieFehler("Ein `wert` ohne Zahl.");
      return kerzen.map(() => ind.wert);
    }
    case "sma":
      return sma(schluss, periode);
    case "ema":
      return ema(schluss, periode);
    case "rsi":
      return rsi(schluss, periode);
    case "atr":
      return atrReihe(kerzen, periode);
    case "hoch":
      return rollendesHoch(kerzen, periode);
    case "tief":
      return rollendesTief(kerzen, periode);
    case "stdabw":
      return stdabw(schluss, periode);
    case "macd":
      return macd(schluss, ind.periode ?? 12, ind.periode2 ?? 26, ind.periode3 ?? 9).macd;
    case "macd_signal":
      return macd(schluss, ind.periode ?? 12, ind.periode2 ?? 26, ind.periode3 ?? 9).signal;
    case "macd_histogramm":
      return macd(schluss, ind.periode ?? 12, ind.periode2 ?? 26, ind.periode3 ?? 9).histogramm;
    case "adx":
      return adx(kerzen, periode).adx;
    case "di_plus":
      return adx(kerzen, periode).diPlus;
    case "di_minus":
      return adx(kerzen, periode).diMinus;
    case "stoch_k":
      return stochastik(kerzen, periode, ind.periode2 ?? 3, ind.periode3 ?? 3).k;
    case "stoch_d":
      return stochastik(kerzen, periode, ind.periode2 ?? 3, ind.periode3 ?? 3).d;
    case "bollinger_oben":
      return bollinger(schluss, ind.periode ?? 20, ind.faktor ?? 2).oben;
    case "bollinger_mitte":
      return bollinger(schluss, ind.periode ?? 20, ind.faktor ?? 2).mitte;
    case "bollinger_unten":
      return bollinger(schluss, ind.periode ?? 20, ind.faktor ?? 2).unten;
    case "bollinger_breite":
      return bollinger(schluss, ind.periode ?? 20, ind.faktor ?? 2).breiteProzent;
    case "obv":
      return obv(kerzen);
    default:
      throw new StrategieFehler(`Unbekannter Indikator: ${String((ind as Indikator).art)}`);
  }
}

interface Gerechnet {
  links: Reihe;
  rechts: Reihe;
  vergleich: Vergleich;
}

function trifftZu(b: Gerechnet, i: number): boolean {
  const links = b.links[i];
  const rechts = b.rechts[i];
  if (links === undefined || rechts === undefined) return false;
  if (b.vergleich === "ueber") return links > rechts;
  if (b.vergleich === "unter") return links < rechts;
  const linksVor = b.links[i - 1];
  const rechtsVor = b.rechts[i - 1];
  if (linksVor === undefined || rechtsVor === undefined) return false;
  if (b.vergleich === "kreuzt_ueber") return linksVor <= rechtsVor && links > rechts;
  return linksVor >= rechtsVor && links < rechts;
}

function pruefeStrategie(s: Strategie): void {
  if (s.einstieg.length === 0) {
    throw new StrategieFehler(
      "Eine Strategie ohne Einstiegsbedingung kauft immer — das ist keine Strategie, sondern ein Kauf.",
    );
  }
  if (s.stopAtr !== undefined && s.stopProzent !== undefined) {
    throw new StrategieFehler("Stop entweder in ATR oder in Prozent, nicht beides.");
  }
  if (s.stopAtr === undefined && s.stopProzent === undefined) {
    throw new StrategieFehler(
      "Ohne Verlustbegrenzung wird hier nicht gehandelt — auch nicht auf dem Papier.",
    );
  }
  if (s.zielR !== undefined && s.zielProzent !== undefined) {
    throw new StrategieFehler("Ziel entweder in R oder in Prozent, nicht beides.");
  }
  for (const wert of [s.stopAtr, s.stopProzent, s.zielR, s.zielProzent]) {
    if (wert !== undefined && (!Number.isFinite(wert) || wert <= 0)) {
      throw new StrategieFehler("Stop- und Zielangaben sind positive Zahlen.");
    }
  }
}

function kennzahlenAus(
  handel: readonly Handel[],
  kapitalkurve: readonly number[],
  proJahr: number,
): Kennzahlen {
  const anzahl = handel.length;
  if (anzahl === 0) {
    return {
      anzahl: 0,
      trefferquote: 0,
      durchschnittR: 0,
      erwartungswertR: 0,
      profitFaktor: 0,
      gesamtrenditeProzent: 0,
      maxDrawdownProzent: 0,
      sharpe: 0,
      sortino: 0,
      durchschnittGewinnR: 0,
      durchschnittVerlustR: 0,
      groessterGewinnR: 0,
      groessterVerlustR: 0,
      laengsteVerlustserie: 0,
      durchschnittKerzen: 0,
    };
  }
  const treffer = handel.filter((h) => h.r > 0);
  const gewinnSumme = treffer.reduce((a, h) => a + h.r, 0);
  const verlustSumme = handel.filter((h) => h.r <= 0).reduce((a, h) => a - h.r, 0);
  const summeR = handel.reduce((a, h) => a + h.r, 0);

  let serie = 0;
  let laengste = 0;
  for (const h of handel) {
    serie = h.r <= 0 ? serie + 1 : 0;
    laengste = Math.max(laengste, serie);
  }

  let spitze = kapitalkurve[0] ?? 1;
  let drawdown = 0;
  for (const stand of kapitalkurve) {
    spitze = Math.max(spitze, stand);
    drawdown = Math.max(drawdown, (spitze - stand) / spitze);
  }

  const renditen: number[] = [];
  for (let i = 1; i < kapitalkurve.length; i += 1) {
    const vorher = kapitalkurve[i - 1];
    if (vorher > 0) renditen.push(kapitalkurve[i] / vorher - 1);
  }
  const mittel = renditen.length > 0 ? renditen.reduce((a, b) => a + b, 0) / renditen.length : 0;
  const varianz =
    renditen.length > 1
      ? renditen.reduce((a, b) => a + (b - mittel) ** 2, 0) / (renditen.length - 1)
      : 0;
  const abweichung = Math.sqrt(varianz);
  const sharpe = abweichung > 0 ? (mittel / abweichung) * Math.sqrt(proJahr) : 0;
  // Sortino: im Nenner nur die Ausschläge nach unten. Aufwärtsschwankung ist kein Risiko.
  const unten = renditen.map((r) => Math.min(0, r));
  const abwaerts = Math.sqrt(
    unten.length > 0 ? unten.reduce((a, b) => a + b * b, 0) / unten.length : 0,
  );
  const sortino = abwaerts > 0 ? (mittel / abwaerts) * Math.sqrt(proJahr) : 0;

  const verluste = handel.filter((h) => h.r <= 0).map((h) => h.r);
  const gewinneR = treffer.map((h) => h.r);

  const erst = kapitalkurve[0] ?? 1;
  const letzt = kapitalkurve[kapitalkurve.length - 1] ?? 1;

  return {
    anzahl,
    trefferquote: treffer.length / anzahl,
    durchschnittR: summeR / anzahl,
    erwartungswertR: summeR / anzahl,
    profitFaktor:
      verlustSumme > 0
        ? gewinnSumme / verlustSumme
        : gewinnSumme > 0
          ? Number.POSITIVE_INFINITY
          : 0,
    gesamtrenditeProzent: (letzt / erst - 1) * 100,
    maxDrawdownProzent: drawdown * 100,
    sharpe,
    sortino,
    durchschnittGewinnR:
      gewinneR.length > 0 ? gewinneR.reduce((a, b) => a + b, 0) / gewinneR.length : 0,
    durchschnittVerlustR:
      verluste.length > 0 ? verluste.reduce((a, b) => a + b, 0) / verluste.length : 0,
    groessterGewinnR: gewinneR.length > 0 ? Math.max(...gewinneR) : 0,
    groessterVerlustR: verluste.length > 0 ? Math.min(...verluste) : 0,
    laengsteVerlustserie: laengste,
    durchschnittKerzen: handel.reduce((a, h) => a + h.kerzen, 0) / anzahl,
  };
}

/** Wie viele Kerzen ein Jahr hat — für die Annualisierung der Sharpe-Ratio. */
export function kerzenProJahr(intervall: string): number {
  switch (intervall) {
    case "1m":
      return 252 * 390;
    case "5m":
      return 252 * 78;
    case "15m":
      return 252 * 26;
    case "30m":
      return 252 * 13;
    case "1h":
      return 252 * 7;
    case "1wk":
      return 52;
    case "1mo":
      return 12;
    default:
      return 252;
  }
}

function iso(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

/**
 * Der Lauf.
 *
 * `outOfSampleAnteil` schneidet den hinteren Teil ab, **bevor** jemand ihn zu sehen bekommt:
 * die Kennzahlen beider Hälften stehen getrennt im Ergebnis. Wer eine Strategie am vorderen
 * Teil schraubt und sie am hinteren zerfällt, sieht es an einer Zahl statt an einem Bauchgefühl.
 */
export function backtest(
  strategie: Strategie,
  kerzen: readonly MarketCandle[],
  optionen: { symbol?: string; intervall?: string; outOfSampleAnteil?: number } = {},
): BacktestErgebnis {
  pruefeStrategie(strategie);
  if (kerzen.length < 50) {
    throw new StrategieFehler(
      `Nur ${kerzen.length} Kerzen. Unter 50 ist jedes Ergebnis Zufall — hol einen längeren Zeitraum.`,
    );
  }

  const intervall = optionen.intervall ?? "1d";
  const gebuehr = (strategie.gebuehrProzent ?? VORGABE_GEBUEHR) / 100;
  const schlupf = (strategie.schlupfProzent ?? VORGABE_SCHLUPF) / 100;
  const long = strategie.richtung === "long";

  const einstieg = strategie.einstieg.map((b) => ({
    links: reiheFuer(b.links, kerzen),
    rechts: reiheFuer(b.rechts, kerzen),
    vergleich: b.vergleich,
  }));
  const ausstieg = (strategie.ausstieg ?? []).map((b) => ({
    links: reiheFuer(b.links, kerzen),
    rechts: reiheFuer(b.rechts, kerzen),
    vergleich: b.vergleich,
  }));
  const atr = atrReihe(kerzen, 14);

  const handel: Handel[] = [];
  // Die Kapitalkurve trägt je Kerze einen Stand — auch wenn nichts läuft. Nur so ist die
  // Sharpe-Ratio das, was sie sein soll: Ertrag gemessen an der Schwankung über die Zeit, nicht
  // über die Handel. Eine Strategie, die selten handelt, sieht sonst besser aus, als sie ist.
  const kapitalkurve: number[] = [];
  let kapital = 1;

  let offen: {
    index: number;
    einstieg: number;
    stop: number;
    ziel: number | null;
  } | null = null;

  for (let i = 0; i < kerzen.length; i += 1) {
    const kerze = kerzen[i];

    if (offen !== null) {
      const stopTrifft = long ? kerze.low <= offen.stop : kerze.high >= offen.stop;
      const zielTrifft =
        offen.ziel !== null && (long ? kerze.high >= offen.ziel : kerze.low <= offen.ziel);

      let ausstiegKurs: number | null = null;
      let grund: Ausstiegsgrund | null = null;
      // Zuerst der Stop: liegen beide in derselben Kerze, zählt er. Siehe Kopfkommentar.
      if (stopTrifft) {
        ausstiegKurs = offen.stop;
        grund = "stop";
      } else if (zielTrifft && offen.ziel !== null) {
        ausstiegKurs = offen.ziel;
        grund = "ziel";
      } else if (ausstieg.length > 0 && ausstieg.some((b) => trifftZu(b, i))) {
        ausstiegKurs = kerze.close;
        grund = "regel";
      } else if (strategie.maxKerzen !== undefined && i - offen.index >= strategie.maxKerzen) {
        ausstiegKurs = kerze.close;
        grund = "zeit";
      } else if (i === kerzen.length - 1) {
        ausstiegKurs = kerze.close;
        grund = "ende";
      }

      if (ausstiegKurs !== null && grund !== null) {
        const risiko = Math.abs(offen.einstieg - offen.stop);
        const brutto = long ? ausstiegKurs - offen.einstieg : offen.einstieg - ausstiegKurs;
        const kosten = (offen.einstieg + ausstiegKurs) * (gebuehr + schlupf);
        const netto = brutto - kosten;
        handel.push({
          einstiegZeit: kerzen[offen.index].time,
          ausstiegZeit: kerze.time,
          einstieg: offen.einstieg,
          ausstieg: ausstiegKurs,
          stop: offen.stop,
          ziel: offen.ziel,
          grund,
          renditeProzent: (netto / offen.einstieg) * 100,
          r: risiko > 0 ? netto / risiko : 0,
          kerzen: i - offen.index,
        });
        kapital *= 1 + netto / offen.einstieg;
        offen = null;
      }
    }

    // Signal auf der abgeschlossenen Kerze, Einstieg zur Eröffnung der nächsten.
    if (offen === null && i + 1 < kerzen.length && einstieg.every((b) => trifftZu(b, i))) {
      const roh = kerzen[i + 1].open;
      const kurs = long ? roh * (1 + schlupf) : roh * (1 - schlupf);
      const spanne = atr[i];
      let stop: number;
      if (strategie.stopAtr !== undefined) {
        if (spanne === undefined) {
          kapitalkurve.push(kapital);
          continue;
        }
        stop = long ? kurs - spanne * strategie.stopAtr : kurs + spanne * strategie.stopAtr;
      } else {
        const anteil = (strategie.stopProzent ?? 0) / 100;
        stop = long ? kurs * (1 - anteil) : kurs * (1 + anteil);
      }
      const risiko = Math.abs(kurs - stop);
      let ziel: number | null = null;
      if (strategie.zielR !== undefined) {
        ziel = long ? kurs + risiko * strategie.zielR : kurs - risiko * strategie.zielR;
      } else if (strategie.zielProzent !== undefined) {
        const anteil = strategie.zielProzent / 100;
        ziel = long ? kurs * (1 + anteil) : kurs * (1 - anteil);
      }
      offen = { index: i + 1, einstieg: kurs, stop, ziel };
    }

    kapitalkurve.push(kapital);
  }

  const anteil = optionen.outOfSampleAnteil ?? 0.3;
  const grenzeIndex = Math.floor(kerzen.length * (1 - anteil));
  const grenzeZeit = kerzen[Math.max(0, Math.min(kerzen.length - 1, grenzeIndex))].time;
  const vorne = handel.filter((h) => h.einstiegZeit < grenzeZeit);
  const hinten = handel.filter((h) => h.einstiegZeit >= grenzeZeit);
  const proJahr = kerzenProJahr(intervall);

  const gesamt = kennzahlenAus(handel, kapitalkurve, proJahr);
  const kaufUndHalten = (kerzen[kerzen.length - 1].close / kerzen[0].close - 1) * 100;
  const inSample: Abschnitt = {
    von: iso(kerzen[0].time),
    bis: iso(grenzeZeit),
    kennzahlen: kennzahlenAus(vorne, kapitalkurve.slice(0, grenzeIndex + 1), proJahr),
  };
  const outOfSample: Abschnitt = {
    von: iso(grenzeZeit),
    bis: iso(kerzen[kerzen.length - 1].time),
    kennzahlen: kennzahlenAus(hinten, kapitalkurve.slice(grenzeIndex), proJahr),
  };

  return {
    strategie: strategie.name,
    symbol: optionen.symbol ?? "",
    richtung: strategie.richtung,
    von: iso(kerzen[0].time),
    bis: iso(kerzen[kerzen.length - 1].time),
    kerzen: kerzen.length,
    intervall,
    handel,
    gesamt,
    inSample,
    outOfSample,
    kaufUndHaltenProzent: kaufUndHalten,
    warnungen: warnungenAus(gesamt, inSample, outOfSample, handel, kaufUndHalten),
    kosten: {
      gebuehrProzent: strategie.gebuehrProzent ?? VORGABE_GEBUEHR,
      schlupfProzent: strategie.schlupfProzent ?? VORGABE_SCHLUPF,
    },
  };
}

/**
 * Was an einem Ergebnis nicht zu trauen ist.
 *
 * Diese Liste ist der Grund, warum dieses Modul existiert. Eine Trefferquote von 80 % ist ohne
 * die Nebenzahlen keine gute Nachricht: sie entsteht mühelos, wenn man das Ziel eng und den Stop
 * weit setzt, und der erste Ausreißer frisst dann zehn Gewinne. Jede Warnung hier ist eine, die
 * Jakob sonst erst mit echtem Geld bemerkt.
 */
export function warnungenAus(
  gesamt: Kennzahlen,
  inSample: Abschnitt,
  outOfSample: Abschnitt,
  handel: readonly Handel[],
  kaufUndHaltenProzent?: number,
): string[] {
  const warnungen: string[] = [];
  if (gesamt.anzahl === 0) return ["Kein einziger Handel — die Bedingungen trafen nie zu."];
  if (gesamt.anzahl < MINDEST_HANDEL) {
    warnungen.push(
      `Nur ${gesamt.anzahl} Handel. Unter ${MINDEST_HANDEL} ist jede Kennzahl Zufall, auch eine schöne.`,
    );
  }
  if (gesamt.trefferquote >= 0.7 && gesamt.erwartungswertR < 0.15) {
    warnungen.push(
      `Trefferquote ${(gesamt.trefferquote * 100).toFixed(0)} %, aber nur ${gesamt.erwartungswertR.toFixed(2)} R je Handel: viele kleine Gewinne, wenige große Verluste. Diese Kurve kippt mit einem einzigen Ausreißer.`,
    );
  }
  if (gesamt.erwartungswertR <= 0) {
    warnungen.push(
      `Der Erwartungswert ist ${gesamt.erwartungswertR.toFixed(2)} R — die Strategie verliert auf Dauer, egal wie die Trefferquote aussieht.`,
    );
  }
  if (outOfSample.kennzahlen.anzahl >= 5) {
    const drinnen = inSample.kennzahlen.erwartungswertR;
    const draussen = outOfSample.kennzahlen.erwartungswertR;
    if (drinnen > 0 && draussen < drinnen * 0.5) {
      warnungen.push(
        `Im ungesehenen Teil bleibt von ${drinnen.toFixed(2)} R nur ${draussen.toFixed(2)} R übrig. Das ist das Muster einer an die Vergangenheit angepassten Strategie.`,
      );
    }
  } else if (gesamt.anzahl > 0) {
    warnungen.push(
      "Im ungesehenen Teil liegen zu wenige Handel, um ihn zu beurteilen — der Zeitraum ist zu kurz.",
    );
  }
  if (gesamt.maxDrawdownProzent > 30) {
    warnungen.push(
      `Zwischendurch standen ${gesamt.maxDrawdownProzent.toFixed(0)} % Verlust auf der Kurve. Das muss man aushalten können, nicht nur ausrechnen.`,
    );
  }
  const stops = handel.filter((h) => h.grund === "stop").length;
  if (stops === 0) {
    warnungen.push(
      "Kein einziger Stop wurde je ausgelöst. Entweder liegt er unrealistisch weit, oder der Zeitraum enthält keine schlechte Phase.",
    );
  }
  if (
    kaufUndHaltenProzent !== undefined &&
    gesamt.gesamtrenditeProzent < kaufUndHaltenProzent &&
    kaufUndHaltenProzent > 0
  ) {
    warnungen.push(
      `Kaufen und liegen lassen hätte ${kaufUndHaltenProzent.toFixed(1)} % gebracht, die Strategie ${gesamt.gesamtrenditeProzent.toFixed(1)} %. Mehr Arbeit, mehr Gebühren, weniger Ertrag.`,
    );
  }
  const gewinne = handel.filter((h) => h.r > 0).map((h) => h.r);
  if (gewinne.length > 2) {
    const groesster = Math.max(...gewinne);
    const summe = gewinne.reduce((a, b) => a + b, 0);
    if (groesster > summe * 0.5) {
      warnungen.push(
        "Mehr als die Hälfte des Gewinns kommt aus einem einzigen Handel. Ohne ihn ist die Strategie eine andere.",
      );
    }
  }
  return warnungen;
}

function prozent(wert: number): string {
  return `${wert.toFixed(1)} %`;
}

/**
 * Die Leistungsübersicht in der Form, die Jakob vom Strategy Tester bei TradingView kennt —
 * dieselben Kennzahlen unter deutschen Namen, in derselben Reihenfolge, damit sich beides
 * nebeneinanderlegen lässt: Nettoergebnis, Handel, Trefferquote, Profitfaktor, mittlerer
 * Gewinn/Verlust, größter Gewinn/Verlust, Rückschlag, Sharpe, Sortino, Haltedauer.
 */
function kennzahlenZeilen(k: Kennzahlen): string {
  if (k.anzahl === 0) return "  keine Handel";
  return [
    `  Nettoergebnis ${prozent(k.gesamtrenditeProzent)} · Handel ${k.anzahl} · Trefferquote ${prozent(k.trefferquote * 100)}`,
    `  Erwartungswert ${k.erwartungswertR.toFixed(2)} R · Profitfaktor ${k.profitFaktor === Number.POSITIVE_INFINITY ? "∞" : k.profitFaktor.toFixed(2)} · max. Rückschlag ${prozent(k.maxDrawdownProzent)}`,
    `  Gewinn ⌀ ${k.durchschnittGewinnR.toFixed(2)} R (größter ${k.groessterGewinnR.toFixed(2)} R) · Verlust ⌀ ${k.durchschnittVerlustR.toFixed(2)} R (größter ${k.groessterVerlustR.toFixed(2)} R)`,
    `  Sharpe ${k.sharpe.toFixed(2)} · Sortino ${k.sortino.toFixed(2)} · längste Verlustserie ${k.laengsteVerlustserie} · Haltedauer ⌀ ${k.durchschnittKerzen.toFixed(1)} Kerzen`,
  ].join("\n");
}

/** Das Ergebnis als Text für einen Bericht — mit den Warnungen oben, nicht unten. */
export function formatiereBacktest(e: BacktestErgebnis): string {
  const zeilen = [
    `${e.strategie} · ${e.symbol || "ohne Symbol"} · ${e.richtung === "long" ? "Long" : "Short"}`,
    `${e.von} bis ${e.bis}, ${e.kerzen} Kerzen à ${e.intervall}, Kosten ${e.kosten.gebuehrProzent} % Gebühr + ${e.kosten.schlupfProzent} % Schlupf je Seite`,
  ];
  if (e.warnungen.length > 0) {
    zeilen.push("", "Vorbehalte:");
    for (const w of e.warnungen) zeilen.push(`  ⚠ ${w}`);
  }
  zeilen.push(
    "",
    "Gesamt:",
    kennzahlenZeilen(e.gesamt),
    `  Kaufen und liegen lassen im selben Zeitraum: ${prozent(e.kaufUndHaltenProzent)}`,
    "",
    `Geschraubt (${e.inSample.von} bis ${e.inSample.bis}):`,
    kennzahlenZeilen(e.inSample.kennzahlen),
    "",
    `Ungesehen (${e.outOfSample.von} bis ${e.outOfSample.bis}):`,
    kennzahlenZeilen(e.outOfSample.kennzahlen),
  );
  if (e.handel.length > 0) {
    const letzte = e.handel.slice(-8);
    zeilen.push(
      "",
      `Die letzten ${letzte.length} Handel (Einstieg → Ausstieg, Grund, R):`,
      ...letzte.map(
        (h) =>
          `  ${iso(h.einstiegZeit)} → ${iso(h.ausstiegZeit)}  ${h.einstieg.toFixed(2)} → ${h.ausstieg.toFixed(2)}  ${h.grund}  ${h.r >= 0 ? "+" : ""}${h.r.toFixed(2)} R`,
      ),
    );
  }
  zeilen.push(
    "",
    "Gerechnet ohne Blick in die Zukunft: Signal auf der abgeschlossenen Kerze, Einstieg zur",
    "nächsten Eröffnung; liegen Stop und Ziel in derselben Kerze, zählt der Stop (dieselbe",
    "pessimistische Annahme wie im Strategy Tester bei TradingView). Kerzen aus derselben",
    "geprüften Quelle wie die Kurstafel.",
  );
  return zeilen.join("\n");
}
