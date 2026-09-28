import type { Richtung } from "./crv.js";
import { DauerFehler, messeHaltedauer } from "./haltedauer.js";
import {
  type Reihe,
  ZeitzoneFehler,
  adx,
  atrReihe,
  bollinger,
  dema,
  ema,
  engulfing,
  fraktale,
  hatVolumen,
  imFenster,
  macd,
  minuteAus,
  obv,
  rollendesHoch,
  rollendesTief,
  rsi,
  schlusskurse,
  sma,
  spannenStop,
  stdabw,
  stochastik,
  supertrend,
  swingHoch,
  swingTief,
  vwap,
} from "./indikatoren.js";
import type { MarketCandle } from "./integrations/markets.js";
import { type Konfidenz, formatiereKonfidenz, konfidenz, nullEingeschlossen } from "./konfidenz.js";
import { wochenzielZeile } from "./wochenziel.js";

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
 *     Annahme ist die einzige, die nicht schmeichelt. Nachgemessen am 28.09. mit Binance-
 *     Minutenkerzen: das betrifft 0–8 % der Handel und verschiebt Ø R um höchstens 0,08 R.
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
  | "obv"
  | "vwap"
  | "vwap_oben"
  | "vwap_unten"
  | "swing_tief"
  | "swing_hoch"
  | "fraktal_tief"
  | "fraktal_hoch"
  | "dema"
  | "supertrend"
  | "supertrend_richtung"
  | "engulfing"
  | "spanne_unter"
  | "spanne_ueber";

export interface Indikator {
  art: IndikatorArt;
  /**
   * Die erste Periode. Vorgaben je Art: 14 für rsi/atr/adx/stoch, 20 für bollinger, 12 für die
   * schnelle MACD-Linie, 5 Kerzen Rückblick für swing, 2 Kerzen je Seite für fraktal.
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

/**
 * Der Tagesabschnitt, in dem gehandelt wird.
 *
 * Für alles, was feiner ist als eine Tageskerze, ist das keine Feinheit: die Eröffnungsstunde
 * einer Börse verhält sich anders als der Mittag, und eine Regel, die über den ganzen Tag
 * gerechnet wird, mischt beide zu einem Durchschnitt, den es so nie gab.
 */
export interface Zeitfenster {
  /** Beginn in Ortszeit der Börse, `HH:MM`. */
  von: string;
  /** Ende, **ausschließlich**. Liegt es vor `von`, läuft das Fenster über Mitternacht. */
  bis: string;
  /**
   * Beim Verlassen des Fensters glattstellen. **Vorgabe `true`** — und das ist die ehrliche
   * Vorgabe: wer nur in der Eröffnungsstunde einsteigt, aber über Nacht liegen bleibt, hat
   * kein Fenster gehandelt, sondern eine Übernachtposition mit einem Einstiegsfilter. Das
   * Risiko daraus ist ein ganz anderes, und es stünde in keiner Kennzahl.
   */
  ausstiegAmEnde?: boolean;
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
  /**
   * Stop **an einer Linie**: ihr Wert auf der Signalkerze, danach fest — „unter der EMA 200",
   * „unter dem letzten Swing-Tief" (`swing_tief`). Nur eine der drei Stop-Arten.
   *
   * Gebaut am 2026-09-28 für die Kalibrierung an TradingLab (N9): alle drei geprüften Videos
   * setzen den Stop an eine Linie, keins in ATR. Ohne diesen Baustein rechneten die Agenten
   * einen ATR-Stop — eine andere Regel unter demselben Namen.
   */
  stopAn?: Indikator;
  /** Ziel als Vielfaches des Risikos (1 R = Abstand Einstieg → Stop), bei jeder Stop-Art. */
  zielR?: number;
  /** Ziel in Prozent vom Einstieg. */
  zielProzent?: number;
  /** Nach so vielen Kerzen wird glattgestellt, auch ohne Signal. */
  maxKerzen?: number;
  /** Je Seite, in Prozent. Vorgabe 0,1 % Gebühr und 0,05 % Schlupf. */
  gebuehrProzent?: number;
  schlupfProzent?: number;
  /**
   * Zeitzone der Börse als IANA-Angabe (`America/New_York`, `Europe/Berlin`, `UTC`).
   * Vorgabe `UTC`. Sie ankert den VWAP und das Zeitfenster.
   *
   * **Nicht bequem, sondern notwendig:** „09:30" meint eine Eröffnung, und die steht im Sommer
   * auf einem anderen UTC-Stempel als im Winter. Wer das Fenster in UTC setzt, prüft ein halbes
   * Jahr lang ein anderes Fenster als das andere halbe — und sieht es nie, weil beide Hälften
   * plausibel aussehen.
   */
  zone?: string;
  /** Nur in diesem Tagesabschnitt wird eingestiegen. */
  fenster?: Zeitfenster;
}

export type Ausstiegsgrund = "stop" | "ziel" | "regel" | "zeit" | "fenster" | "ende";

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
  /**
   * 95-%-Intervall des Erwartungswerts, aus den Handeln gezogen. Fehlt unter zehn Handeln —
   * dort gäbe es nur eine Scheingenauigkeit. Siehe `konfidenz.ts`.
   */
  konfidenz?: Konfidenz;
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
   * Was derselbe Zeitraum mit Buy-and-Hold gebracht hätte. Die Vergleichszahl, ohne
   * die jede Strategie gut aussieht: wer in einem Aufwärtsjahr 20 % macht, während der Markt
   * 40 % läuft, hat nichts gewonnen, sondern die Hälfte liegen gelassen.
   */
  kaufUndHaltenProzent: number;
  /** Was an diesem Ergebnis nicht zu trauen ist. Leer heißt: nichts aufgefallen. */
  warnungen: string[];
  kosten: { gebuehrProzent: number; schlupfProzent: number };
  /**
   * Was dieselbe Stop-/Ziel-Geometrie **ohne jede Einstiegsregel** erreicht hätte, gemessen an
   * derselben Kerzenreihe. Die Messlatte: schlägt die Regel den Zufall, oder liefert nur ihre
   * Geometrie das Ergebnis? Fehlt, wenn die Strategie kein Ziel hat — dann gibt es nichts
   * zu vergleichen. Siehe `haltedauer.ts`.
   */
  nullpunkt?: { trefferquote: number; erwartungswertR: number };
  /** Signale, aus denen kein Handel wurde, weil die Stoplinie (`stopAn`) falsch lag. */
  ohneStop?: number;
}

export class StrategieFehler extends Error {}

const VORGABE_GEBUEHR = 0.1;
const VORGABE_SCHLUPF = 0.05;
/** Unter so vielen Handeln ist jede Kennzahl Zufall. */
export const MINDEST_HANDEL = 30;

function reiheFuer(ind: Indikator, kerzen: readonly MarketCandle[], zone = "UTC"): Reihe {
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
    case "vwap":
      return vwap(kerzen, zone, ind.faktor ?? 1).vwap;
    case "vwap_oben":
      return vwap(kerzen, zone, ind.faktor ?? 1).oben;
    case "vwap_unten":
      return vwap(kerzen, zone, ind.faktor ?? 1).unten;
    case "swing_tief":
      return swingTief(kerzen, ind.periode ?? 5);
    case "swing_hoch":
      return swingHoch(kerzen, ind.periode ?? 5);
    case "fraktal_tief":
      return fraktale(kerzen, ind.periode ?? 2).tief;
    case "fraktal_hoch":
      return fraktale(kerzen, ind.periode ?? 2).hoch;
    case "dema":
      return dema(schluss, ind.periode ?? 200);
    case "supertrend":
      return supertrend(kerzen, ind.periode ?? 10, ind.faktor ?? 3).linie;
    case "supertrend_richtung":
      return supertrend(kerzen, ind.periode ?? 10, ind.faktor ?? 3).richtung;
    case "engulfing":
      return engulfing(kerzen);
    case "spanne_unter":
      return spannenStop(kerzen, ind.faktor ?? 2).unter;
    case "spanne_ueber":
      return spannenStop(kerzen, ind.faktor ?? 2).ueber;
    default:
      throw new StrategieFehler(`Unbekannter Indikator: ${String((ind as Indikator).art)}`);
  }
}

const VWAP_ARTEN: readonly IndikatorArt[] = ["vwap", "vwap_oben", "vwap_unten"];

/** Kommt irgendwo in den Bedingungen ein VWAP vor? Entscheidet über zwei Abweisungen unten. */
export function nutztVwap(s: Strategie): boolean {
  const alle = [...s.einstieg, ...(s.ausstieg ?? [])];
  return alle.some((b) => VWAP_ARTEN.includes(b.links.art) || VWAP_ARTEN.includes(b.rechts.art));
}

/** Intervalle, auf denen ein Sitzungsindikator nichts zu suchen hat. */
const GROB: readonly string[] = ["1d", "1wk", "1mo"];

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

/**
 * Darf aus einem Signal auf Kerze `index` ein Einstieg werden?
 *
 * Geprüft wird **die Kerze, auf der eingestiegen wird** — also die nächste, denn das Signal
 * steht auf der abgeschlossenen Kerze und gekauft wird zur folgenden Eröffnung. Ein Signal um
 * 10:55 bei einem Fenster bis 11:00 würde sonst um 11:00 ausgeführt, also außerhalb dessen, was
 * geprüft wurde.
 *
 * Im Betrieb gibt es die nächste Kerze noch nicht. Ihr Zeitpunkt wird dann aus dem Abstand der
 * beiden letzten Kerzen fortgeschrieben — exakt bei einer lückenlosen Reihe, und damit fällt
 * hier dieselbe Entscheidung wie im Backtest. **Das ist der Punkt:** eine Strategie, die im
 * Betrieb anders bewertet wird als in der Prüfung, macht die Kennzahlen wertlos.
 */
export function einstiegErlaubt(
  strategie: Strategie,
  kerzen: readonly MarketCandle[],
  index: number,
): boolean {
  const fenster = strategie.fenster;
  if (fenster === undefined) return true;
  const naechste = kerzen[index + 1];
  let zeit: number;
  if (naechste !== undefined) {
    zeit = naechste.time;
  } else if (index >= 1) {
    zeit = kerzen[index].time + (kerzen[index].time - kerzen[index - 1].time);
  } else {
    return false;
  }
  return imFenster(zeit, strategie.zone ?? "UTC", minuteAus(fenster.von), minuteAus(fenster.bis));
}

/**
 * Trifft die Regel auf einer **bestimmten** Kerze zu?
 *
 * Dieselbe Auswertung wie im Backtest, nur für einen einzelnen Zeitpunkt — der Papierhandel
 * (`papierhandel.ts`) fragt damit die zuletzt **abgeschlossene** Kerze ab. Es ist bewusst
 * dieselbe Funktion und kein Nachbau: eine Strategie, die im Backtest anders bewertet wird als
 * im Betrieb, ist schlimmer als keine geprüfte Strategie. Der Betrieb wäre dann ein anderes
 * Verfahren als das, was die Kennzahlen erzeugt hat.
 */
export function signalAm(
  strategie: Strategie,
  kerzen: readonly MarketCandle[],
  index: number,
): { einstieg: boolean; ausstieg: boolean } {
  if (index < 0 || index >= kerzen.length) return { einstieg: false, ausstieg: false };
  const zone = strategie.zone ?? "UTC";
  const einstieg = strategie.einstieg.map((b) => ({
    links: reiheFuer(b.links, kerzen, zone),
    rechts: reiheFuer(b.rechts, kerzen, zone),
    vergleich: b.vergleich,
  }));
  const ausstieg = (strategie.ausstieg ?? []).map((b) => ({
    links: reiheFuer(b.links, kerzen, zone),
    rechts: reiheFuer(b.rechts, kerzen, zone),
    vergleich: b.vergleich,
  }));
  return {
    einstieg:
      einstiegErlaubt(strategie, kerzen, index) &&
      einstieg.length > 0 &&
      einstieg.every((b) => trifftZu(b, index)),
    ausstieg: ausstieg.length > 0 && ausstieg.some((b) => trifftZu(b, index)),
  };
}

/** Der ATR(14) an einer Kerze — der Papierhandel setzt seinen Stop damit wie der Backtest. */
export function atrAm(kerzen: readonly MarketCandle[], index: number): number | undefined {
  return atrReihe(kerzen, 14)[index];
}

/** Arten, deren Wert ein Kurs ist. Nur an so einer Linie kann ein Stop liegen. */
const KURSLINIEN: readonly IndikatorArt[] = [
  "kurs",
  "wert",
  "sma",
  "ema",
  "hoch",
  "tief",
  "bollinger_oben",
  "bollinger_mitte",
  "bollinger_unten",
  "vwap",
  "vwap_oben",
  "vwap_unten",
  "swing_tief",
  "swing_hoch",
  "fraktal_tief",
  "fraktal_hoch",
  "dema",
  "supertrend",
  "spanne_unter",
  "spanne_ueber",
];

/** Der Wert der Stoplinie (`stopAn`) an einer Kerze — der Papierhandel fragt ihn wie `atrAm`. */
export function stopLinieAm(
  strategie: Strategie,
  kerzen: readonly MarketCandle[],
  index: number,
): number | undefined {
  if (strategie.stopAn === undefined) return undefined;
  return reiheFuer(strategie.stopAn, kerzen, strategie.zone ?? "UTC")[index];
}

/**
 * Wo der Stop für einen Einstieg zu `kurs` liegt, aus ATR oder Linie der **Signalkerze**.
 * Dieselbe Rechnung im Backtest und im Papierhandel.
 *
 * `null` heißt: kein Stop bestimmbar, also kein Handel. Das gilt auch für eine Linie auf der
 * **falschen Seite** — ein Long mit der EMA 200 über dem Einstieg. Den Stop dann still
 * irgendwohin zu legen hieße, eine andere Regel zu rechnen als die genannte; wie oft es
 * vorkam, steht im Ergebnis.
 *
 * Geprüft wird die Linie gegen die **rohe Eröffnung** `roh`, nicht gegen den um den Schlupf
 * verschlechterten `kurs`. Eröffnet ein Short bei 140,07 über seinem Stop bei 140,00, ist der
 * Stop gerissen, bevor der Handel beginnt — der Schlupf schob den Einstieg aber auf 139,99996
 * zurück unter die Linie, und AAPL 1d rechnete so am 28.09. einen Handel mit 0,00004 $ Risiko
 * und −15.179 R.
 */
export function stopFuer(
  strategie: Strategie,
  kurs: number,
  atrWert: number | undefined,
  linienWert: number | undefined,
  roh: number = kurs,
): number | null {
  const long = strategie.richtung === "long";
  if (strategie.stopAtr !== undefined) {
    if (atrWert === undefined) return null;
    return long ? kurs - atrWert * strategie.stopAtr : kurs + atrWert * strategie.stopAtr;
  }
  if (strategie.stopAn !== undefined) {
    if (linienWert === undefined) return null;
    const naechster = long ? Math.min(kurs, roh) : Math.max(kurs, roh);
    if (long ? linienWert >= naechster : linienWert <= naechster) return null;
    return linienWert;
  }
  const anteil = (strategie.stopProzent ?? 0) / 100;
  return long ? kurs * (1 - anteil) : kurs * (1 + anteil);
}

export function pruefeStrategie(s: Strategie): void {
  if (s.einstieg.length === 0) {
    throw new StrategieFehler(
      "Eine Strategie ohne Einstiegsbedingung kauft immer — das ist keine Strategie, sondern ein Kauf.",
    );
  }
  const stopArten = [s.stopAtr, s.stopProzent, s.stopAn].filter((w) => w !== undefined).length;
  if (stopArten > 1) {
    throw new StrategieFehler(
      "Stop entweder in ATR, in Prozent oder an einer Linie (stopAn), nicht beides.",
    );
  }
  if (stopArten === 0) {
    throw new StrategieFehler(
      "Ohne Verlustbegrenzung wird hier nicht gehandelt — auch nicht auf dem Papier.",
    );
  }
  if (s.stopAn !== undefined && !KURSLINIEN.includes(s.stopAn.art)) {
    throw new StrategieFehler(
      `Ein Stop an ${s.stopAn.art} liegt nicht auf der Kursachse — ein RSI von 30 ist kein Kurs von 30. Nimm eine Linie wie ema, sma oder swing_tief.`,
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
  if (s.zone !== undefined || s.fenster !== undefined) {
    // Zone und Uhrzeiten werden hier einmal durchgerechnet, damit ein Tippfehler beim Anlegen
    // auffällt und nicht erst mitten in einem Lauf über zwei Millionen Kerzen.
    try {
      const zone = s.zone ?? "UTC";
      imFenster(0, zone, 0, 1);
      if (s.fenster !== undefined) {
        const von = minuteAus(s.fenster.von);
        const bis = minuteAus(s.fenster.bis);
        if (von === bis) {
          throw new ZeitzoneFehler(
            `Das Fenster beginnt und endet um ${s.fenster.von} — es ist null Minuten lang.`,
          );
        }
      }
    } catch (fehler) {
      if (fehler instanceof ZeitzoneFehler) throw new StrategieFehler(fehler.message);
      throw fehler;
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
    ...(() => {
      const k = konfidenz(handel.map((h) => h.r));
      return k === undefined ? {} : { konfidenz: k };
    })(),
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

/**
 * Kerzen je Jahr, **gemessen** an der Reihe statt aus einer Tabelle (seit 28.09.). Die Tabelle
 * oben rechnet mit 252 Börsentagen zu 6,5 Stunden — richtig für Aktien, aber Krypto handelt
 * rund um die Uhr: bei 1h sind das 8.766 Kerzen im Jahr statt 1.764, und die Sharpe-Ratio jeder
 * Krypto-Stundenregel stand um den Faktor √5 ≈ 2,2 zu niedrig im Bericht.
 */
export function kerzenJeJahr(kerzen: readonly MarketCandle[], intervall: string): number {
  const jahre = (kerzen[kerzen.length - 1].time - kerzen[0].time) / (365.25 * 86_400);
  return jahre >= 0.25 ? (kerzen.length - 1) / jahre : kerzenProJahr(intervall);
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

  // **Zwei Abweisungen, die eine ganze Klasse von Scheinbefunden verhindern.**
  //
  // Am 2026-09-21 hat der stratege zehn Strategien gebaut, die „VWAP-EMA-Scalp" hießen und auf
  // Tageskerzen liefen — weil es keine feineren gab. Dabei ist ein sitzungsweiser VWAP auf
  // Tageskerzen keine Näherung, sondern ein anderer Indikator: er setzt sich bei jeder Kerze
  // zurück und ist damit nichts als der typische Kurs des Tages. Und ein Fenster von 09:30 bis
  // 11:00 trifft auf einer Tageskerze entweder immer oder nie zu. Beides ergibt Kennzahlen, die
  // aussehen wie ein Ergebnis. Lieber kein Ergebnis als eins, das etwas anderes misst als sein
  // Name sagt.
  if (GROB.includes(intervall)) {
    if (strategie.fenster !== undefined) {
      throw new StrategieFehler(
        `Ein Zeitfenster (${strategie.fenster.von}–${strategie.fenster.bis}) auf ${intervall}-Kerzen trifft entweder immer oder nie zu. Nimm ein Intervall von 1h oder feiner.`,
      );
    }
    if (nutztVwap(strategie)) {
      throw new StrategieFehler(
        `Ein VWAP wird je Sitzung neu angesetzt und ist auf ${intervall}-Kerzen nur der typische Kurs einer einzelnen Kerze — kein VWAP. Nimm ein Intervall von 1h oder feiner.`,
      );
    }
  }
  if (nutztVwap(strategie) && !hatVolumen(kerzen)) {
    throw new StrategieFehler(
      "Diese Kerzen tragen kein Volumen, und ohne Volumen gibt es keinen VWAP. Die Regel würde stumm nie auslösen — das sieht aus wie eine Regel, die nicht funktioniert, ist aber eine, die nichts zu rechnen hat.",
    );
  }

  const gebuehr = (strategie.gebuehrProzent ?? VORGABE_GEBUEHR) / 100;
  const schlupf = (strategie.schlupfProzent ?? VORGABE_SCHLUPF) / 100;
  const long = strategie.richtung === "long";

  const zone = strategie.zone ?? "UTC";
  const einstieg = strategie.einstieg.map((b) => ({
    links: reiheFuer(b.links, kerzen, zone),
    rechts: reiheFuer(b.rechts, kerzen, zone),
    vergleich: b.vergleich,
  }));
  const ausstieg = (strategie.ausstieg ?? []).map((b) => ({
    links: reiheFuer(b.links, kerzen, zone),
    rechts: reiheFuer(b.rechts, kerzen, zone),
    vergleich: b.vergleich,
  }));
  const atr = atrReihe(kerzen, 14);
  const stopLinie =
    strategie.stopAn === undefined ? undefined : reiheFuer(strategie.stopAn, kerzen, zone);
  let falscheSeite = 0;
  const fenster = strategie.fenster;
  const fensterVon = fenster === undefined ? 0 : minuteAus(fenster.von);
  const fensterBis = fenster === undefined ? 0 : minuteAus(fenster.bis);
  const imHandelsfenster = (index: number): boolean =>
    fenster === undefined || imFenster(kerzen[index].time, zone, fensterVon, fensterBis);

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
      // **Das Fenster kommt zuerst.** Diese Kerze liegt schon draußen; glattgestellt wurde zu
      // ihrer Eröffnung, also am Ende der letzten Kerze im Fenster. Ihr Hoch und Tief gehören
      // uns deshalb nicht mehr — wer hier erst Stop und Ziel prüft, lässt eine Position an
      // einer Bewegung teilnehmen, die sie nicht mehr erlebt hat.
      if (fenster !== undefined && fenster.ausstiegAmEnde !== false && !imHandelsfenster(i)) {
        ausstiegKurs = kerze.open;
        grund = "fenster";
      } else if (stopTrifft) {
        // **Eine Lücke über den Stop hinweg wird nicht zum Stopkurs bedient.** Ein Stop ist
        // eine Bestens-Order: eröffnet die Kerze schon jenseits des Stops, ist der erste
        // handelbare Kurs die Eröffnung, nicht der Wunschkurs. Wer hier immer den Stop
        // einsetzt, rechnet sich genau die Verluste klein, die in Wirklichkeit wehtun —
        // Übernachtlücken, Quartalszahlen, Sonntagnacht bei Krypto. Das ist die eine
        // Schmeichelei, die eine Strategie tragfähig aussehen lässt, die es nicht ist.
        //
        // Beim **Ziel** bleibt es umgekehrt beim Zielkurs: eine Limit-Order würde bei einer
        // Lücke darüber hinaus besser ausgeführt, und die bessere Annahme ist hier die, die
        // nicht schmeichelt.
        ausstiegKurs = long ? Math.min(offen.stop, kerze.open) : Math.max(offen.stop, kerze.open);
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
        // **Der Schlupf zählt einmal je Seite, nicht anderthalbmal.** Der Einstiegskurs oben
        // ist bereits der verschlechterte (`roh * (1 + schlupf)`) — dort steckt der Schlupf der
        // Einstiegsseite schon drin. Ihn hier noch einmal auf den Einstieg zu rechnen hieß, ihn
        // doppelt zu bezahlen; bei einem Scalp, dessen Risiko nur ein Zehntelprozent des Kurses
        // beträgt, war das kein Rundungsfehler, sondern in einem gemessenen Fall 0,21 R je
        // Handel. Gefunden am 2026-09-21 beim Nachrechnen eines echten Laufs von Hand: Risiko
        // 77,55, ausgewiesene Kosten 97,53 — davon 16,26 Schlupf, die schon im Einstieg saßen.
        // Der Ausstiegskurs ist **nicht** verschlechtert, also trägt er beides.
        const kosten = offen.einstieg * gebuehr + ausstiegKurs * (gebuehr + schlupf);
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
    if (
      offen === null &&
      i + 1 < kerzen.length &&
      einstiegErlaubt(strategie, kerzen, i) &&
      einstieg.every((b) => trifftZu(b, i))
    ) {
      const roh = kerzen[i + 1].open;
      const kurs = long ? roh * (1 + schlupf) : roh * (1 - schlupf);
      const stop = stopFuer(strategie, kurs, atr[i], stopLinie?.[i], roh);
      if (stop === null) {
        if (stopLinie?.[i] !== undefined) falscheSeite += 1;
        kapitalkurve.push(kapital);
        continue;
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
  const proJahr = kerzenJeJahr(kerzen, intervall);

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

  const nullpunkt = messeNullpunkt(
    strategie,
    kerzen,
    atr,
    medianerRisikoAnteil(handel),
    2 * (gebuehr + schlupf),
  );
  const warnungen = warnungenAus(gesamt, inSample, outOfSample, handel, kaufUndHalten, nullpunkt);
  if (falscheSeite > 0) {
    warnungen.push(
      `${falscheSeite} Signal${falscheSeite === 1 ? "" : "e"} ohne Handel: die Stoplinie lag auf der falschen Seite des Einstiegs. Diese Fälle deckt die Regel nicht ab — sie sind nicht mitgerechnet.`,
    );
  }

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
    ...(nullpunkt !== undefined ? { nullpunkt } : {}),
    warnungen,
    ...(falscheSeite > 0 ? { ohneStop: falscheSeite } : {}),
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
/**
 * Die Baseline: dieselbe Geometrie, von jeder Kerze aus, ohne Einstiegsregel.
 *
 * Dafür wird aus Stop und Ziel der Strategie ein Beispielhandel am letzten Kurs gebaut und
 * `messeHaltedauer` über die ganze Reihe gelegt. **Mit denselben Kosten wie die Regel** (seit
 * 28.09.): vorher trat eine Regel nach Kosten gegen einen Zufall ohne Kosten an, und die
 * Warnung „schlägt den Zufall nicht" sperrte dann Regeln, die ihn vor Kosten schlugen. Kommt nichts heraus — kein Ziel, zu wenige
 * Kerzen, eine Geometrie, die sich in `maxKerzen` nie auflöst —, fehlt die Baseline einfach.
 * Eine geschätzte Messlatte wäre schlimmer als keine.
 */
function messeNullpunkt(
  strategie: Strategie,
  kerzen: readonly MarketCandle[],
  atr: Reihe,
  risikoAnteil?: number,
  /** Gebühr und Schlupf beider Seiten, als Anteil vom Kurs. */
  kostenAnteil = 0,
): { trefferquote: number; erwartungswertR: number } | undefined {
  const letzterKurs = kerzen[kerzen.length - 1]?.close;
  if (letzterKurs === undefined || letzterKurs <= 0) return undefined;
  const letzterAtr = [...atr].reverse().find((w) => w !== undefined);

  let risiko: number;
  if (strategie.stopAtr !== undefined) {
    if (letzterAtr === undefined || letzterAtr <= 0) return undefined;
    risiko = letzterAtr * strategie.stopAtr;
  } else if (strategie.stopProzent !== undefined) {
    risiko = (letzterKurs * strategie.stopProzent) / 100;
  } else if (strategie.stopAn !== undefined && risikoAnteil !== undefined) {
    // Eine Linie hat keinen festen Abstand. Als Geometrie gilt der typische Abstand der
    // wirklichen Handel (Median), damit der Vergleich nicht an einem Ausreißer hängt.
    risiko = letzterKurs * risikoAnteil;
  } else {
    return undefined;
  }

  let chance: number;
  if (strategie.zielR !== undefined) chance = risiko * strategie.zielR;
  else if (strategie.zielProzent !== undefined)
    chance = (letzterKurs * strategie.zielProzent) / 100;
  else return undefined;

  const long = strategie.richtung === "long";
  try {
    const gemessen = messeHaltedauer({
      kerzen,
      richtung: strategie.richtung,
      einstieg: letzterKurs,
      stop: long ? letzterKurs - risiko : letzterKurs + risiko,
      ziel: long ? letzterKurs + chance : letzterKurs - chance,
      maxKerzen: strategie.maxKerzen ?? 250,
    });
    return {
      trefferquote: gemessen.nullpunktTrefferquote,
      erwartungswertR: gemessen.nullpunktErwartungswertR - (kostenAnteil * letzterKurs) / risiko,
    };
  } catch (fehler) {
    if (fehler instanceof DauerFehler) return undefined;
    throw fehler;
  }
}

/** Der Median von |Einstieg − Stop| / Einstieg über die Handel, oder nichts ohne Handel. */
function medianerRisikoAnteil(handel: readonly Handel[]): number | undefined {
  const anteile = handel
    .map((h) => Math.abs(h.einstieg - h.stop) / h.einstieg)
    .filter((a) => Number.isFinite(a) && a > 0)
    .sort((a, b) => a - b);
  if (anteile.length === 0) return undefined;
  const mitte = Math.floor(anteile.length / 2);
  return anteile.length % 2 === 1 ? anteile[mitte] : (anteile[mitte - 1] + anteile[mitte]) / 2;
}

/**
 * Vorbehalte, die der Bericht nennt, die einen Kandidaten aber **nicht sperren** (seit 28.09.).
 * Stichprobe und Intervall prüft `bewerte` selbst — auch über den gemeinsamen Topf, den diese
 * Warnungen nicht kennen. Kaufen-und-liegen-lassen und der Rückschlag rechnen mit voll
 * investiertem Kapital, Jakob handelt mit 1 % Risiko je Handel. Seine Regel: „eine Strategie ist
 * ein Gewinner, solange sie oft genug greifen kann und insgesamt mehr Plus als Minus erwirtschaftet."
 */
const NUR_HINWEIS: readonly RegExp[] = [
  /^Nur \d+ Handel\./,
  /^Trefferquote \d+ %, aber nur /,
  /^Der Erwartungswert ist zwar \+/,
  /^Zwischendurch standen /,
  /^Kaufen und liegen lassen hätte /,
];

/** Hält dieser Vorbehalt eine Strategie vom Kandidaten ab? */
export function sperrt(warnung: string): boolean {
  return !NUR_HINWEIS.some((muster) => muster.test(warnung));
}

export function warnungenAus(
  gesamt: Kennzahlen,
  inSample: Abschnitt,
  outOfSample: Abschnitt,
  handel: readonly Handel[],
  kaufUndHaltenProzent?: number,
  nullpunkt?: { trefferquote: number; erwartungswertR: number },
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
  } else if (gesamt.konfidenz !== undefined && nullEingeschlossen(gesamt.konfidenz)) {
    // Die Warnung, die am häufigsten fehlen wird — und die am meisten spart. Ein positiver
    // Erwartungswert, dessen Intervall die Null einschließt, ist keine Kante, sondern eine
    // Stichprobe, die zufällig so ausgefallen ist.
    const noetig =
      gesamt.konfidenz.noetigeHandel !== undefined
        ? ` Bei dieser Streuung bräuchte es rund ${gesamt.konfidenz.noetigeHandel} Handel, um das zu entscheiden.`
        : "";
    warnungen.push(
      `Der Erwartungswert ist zwar +${gesamt.erwartungswertR.toFixed(2)} R, aber das 95-%-Intervall reicht von ${gesamt.konfidenz.unten.toFixed(2)} bis ${gesamt.konfidenz.oben.toFixed(2)} R — er ist nicht von null zu unterscheiden.${noetig}`,
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
  if (nullpunkt !== undefined && gesamt.anzahl >= 10) {
    // **Der Vergleich, der die meisten „funktionierenden" Regeln entzaubert.** Wenn dieselbe
    // Stop-Ziel-Geometrie ohne jede Einstiegsregel schon dasselbe bringt, dann arbeitet nicht
    // die Regel, sondern die Geometrie — und die ist frei wählbar.
    if (gesamt.erwartungswertR <= nullpunkt.erwartungswertR) {
      warnungen.push(
        `Ohne jede Einstiegsregel bringt dieselbe Stop-Ziel-Geometrie ${nullpunkt.erwartungswertR >= 0 ? "+" : ""}${nullpunkt.erwartungswertR.toFixed(2)} R (Trefferquote ${(nullpunkt.trefferquote * 100).toFixed(0)} %). Die Regel schlägt den Zufall nicht — sie wählt nur, wann die Geometrie läuft.`,
      );
    }
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
    ...(k.konfidenz ? [formatiereKonfidenz(k.konfidenz, k.erwartungswertR)] : []),
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
    ...[
      wochenzielZeile(
        { ...e.gesamt, von: e.von, bis: e.bis },
        { ...e.outOfSample.kennzahlen, von: e.outOfSample.von, bis: e.outOfSample.bis },
      ),
    ].filter(Boolean),
    ...(e.nullpunkt
      ? [
          `  Nullpunkt (dieselbe Geometrie ohne Einstiegsregel): Trefferquote ${prozent(e.nullpunkt.trefferquote * 100)}, ${e.nullpunkt.erwartungswertR >= 0 ? "+" : ""}${e.nullpunkt.erwartungswertR.toFixed(2)} R`,
        ]
      : []),
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
    "nächsten Eröffnung; liegen Stop und Ziel in derselben Kerze, zählt der Stop. (TradingView",
    "nimmt stattdessen an, der Kurs laufe zuerst zum näheren Extrem, und rechnet ohne Gebühren,",
    "wenn man sie nicht einträgt.) Kerzen aus derselben geprüften Quelle wie die Kurstafel.",
  );
  return zeilen.join("\n");
}
