import { type Handel, type Indikator, type Strategie, backtest, signalAm } from "./backtest.js";
import type { MarketCandle } from "./integrations/markets.js";
import type { StrategieEintrag } from "./strategien.js";

/**
 * Eine abgelegte Strategie im Chart (2026-09-27, Jakob: „einen Button, mit dem ich mir die
 * ausgearbeiteten Strategien … direkt im Produkt visualisieren lassen kann").
 *
 * **Die Handel werden gerechnet, nicht erinnert.** Das Archiv hält die Regel vollständig, aber
 * nicht die einzelnen Handel. Sie entstehen hier neu — mit derselben Funktion `backtest`, die
 * die Kennzahlen im Archiv erzeugt hat, auf derselben Kerzenquelle. Was im Chart steht, ist
 * damit genau das, was die Regel tut, und kein Bild davon.
 *
 * **Und die Zeit seit der Ablage kommt dazu.** Gerechnet wird vom Beginn des geprüften
 * Zeitraums bis heute; jeder Handel, der nach dem Ende des Prüfzeitraums beginnt, ist als
 * `nachAblage` markiert. Das ist die ehrlichste Probe, die es gibt: Kerzen, die beim Bau der
 * Regel niemand gesehen haben kann. Steht vor der Ablage eine andere Zahl an Handeln als im
 * Archiv, hat der Anbieter seine Historie berichtigt — das wird gesagt, nicht geglättet.
 */

export interface StrategieHandel extends Handel {
  nachAblage: boolean;
}

export interface StrategieImChart {
  id: string;
  name: string;
  symbol: string;
  intervall: string;
  richtung: "long" | "short";
  status: string;
  /** Beginn und Ende des geprüften Zeitraums, Unix-Sekunden. */
  von: number;
  bis: number;
  /** Ab hier „ungesehen" im Backtest (Out-of-Sample), Unix-Sekunden. */
  teilung: number | null;
  handel: StrategieHandel[];
  /** Die Kennzahlen, wie sie im Archiv stehen — nicht neu gerechnet. */
  kennzahlenArchiv: StrategieEintrag["kennzahlen"];
  /** Wie viele Handel der Neulauf im Prüfzeitraum findet, und wie viele danach. */
  imPruefzeitraum: number;
  seitAblage: { anzahl: number; summeR: number; trefferquote: number | null };
  /** Weicht der Neulauf vom Archiv ab, steht hier der Satz dazu. */
  abweichung?: string;
  /** Meldet die Regel auf der letzten abgeschlossenen Kerze einen Einstieg? */
  signalLetzteKerze: boolean;
  /** Die Indikatoren der Regel in der Schreibweise des Charts (`sma:200`, `adx:14`). */
  indikatoren: string[];
  /** Die Regel in Worten, für die Legende. */
  regel: string[];
}

/** Ein Regel-Indikator in der Schreibweise des Charts — soweit der Chart ihn zeichnen kann. */
export function chartIndikatorFuer(i: Indikator): string | null {
  const p = i.periode;
  switch (i.art) {
    case "sma":
    case "ema":
    case "rsi":
    case "atr":
      return `${i.art}:${p ?? (i.art === "sma" ? 20 : i.art === "ema" ? 50 : 14)}`;
    case "macd":
    case "macd_signal":
    case "macd_histogramm":
      return `macd:${p ?? 12}:${i.periode2 ?? 26}:${i.periode3 ?? 9}`;
    case "adx":
    case "di_plus":
    case "di_minus":
      return `adx:${p ?? 14}`;
    case "stoch_k":
    case "stoch_d":
      return `stoch:${p ?? 14}:${i.periode2 ?? 3}:${i.periode3 ?? 3}`;
    case "bollinger_oben":
    case "bollinger_mitte":
    case "bollinger_unten":
    case "bollinger_breite":
      return `bb:${p ?? 20}:${i.faktor ?? 2}`;
    case "obv":
      return "obv";
    case "vwap":
    case "vwap_oben":
    case "vwap_unten":
      return `vwap:${i.faktor ?? 1}`;
    default:
      return null;
  }
}

const NAMEN: Partial<Record<Indikator["art"], string>> = {
  kurs: "Kurs",
  sma: "SMA",
  ema: "EMA",
  rsi: "RSI",
  atr: "ATR",
  hoch: "Hoch",
  tief: "Tief",
  macd: "MACD",
  macd_signal: "MACD-Signal",
  macd_histogramm: "MACD-Histogramm",
  adx: "ADX",
  di_plus: "+DI",
  di_minus: "−DI",
  stoch_k: "Stoch %K",
  stoch_d: "Stoch %D",
  bollinger_oben: "oberes Bollinger-Band",
  bollinger_mitte: "Bollinger-Mitte",
  bollinger_unten: "unteres Bollinger-Band",
  bollinger_breite: "Bollinger-Breite",
  obv: "OBV",
  vwap: "VWAP",
  swing_tief: "Swing-Tief",
  swing_hoch: "Swing-Hoch",
  fraktal_tief: "Fraktal-Tief",
  fraktal_hoch: "Fraktal-Hoch",
};

function wort(i: Indikator): string {
  if (i.art === "wert") return (i.wert ?? 0).toLocaleString("de-DE");
  const name = NAMEN[i.art] ?? i.art;
  return i.periode ? `${name} ${i.periode}` : name;
}

const VERGLEICH = {
  ueber: "über",
  unter: "unter",
  kreuzt_ueber: "kreuzt nach oben",
  kreuzt_unter: "kreuzt nach unten",
} as const;

/** Die Regel in Sätzen: „Einstieg, wenn Kurs über SMA 200 und ADX 14 über 25". */
export function regelInWorten(s: Strategie): string[] {
  const teil = (b: Strategie["einstieg"][number]) =>
    `${wort(b.links)} ${VERGLEICH[b.vergleich]} ${wort(b.rechts)}`;
  const zeilen = [
    `${s.richtung === "long" ? "Long" : "Short"}-Einstieg, wenn ${s.einstieg.map(teil).join(" und ")}`,
  ];
  if (s.ausstieg && s.ausstieg.length > 0) {
    zeilen.push(`Ausstieg, wenn ${s.ausstieg.map(teil).join(" oder ")}`);
  }
  const stop = s.stopAtr
    ? `${s.stopAtr} ATR`
    : s.stopProzent
      ? `${s.stopProzent} %`
      : s.stopAn
        ? `an ${wort(s.stopAn)}`
        : null;
  const ziel = s.zielR ? `${s.zielR} R` : s.zielProzent ? `${s.zielProzent} %` : null;
  if (stop || ziel)
    zeilen.push(
      [stop ? `Stop ${stop}` : "", ziel ? `Ziel ${ziel}` : ""].filter(Boolean).join(", "),
    );
  if (s.maxKerzen) zeilen.push(`Spätestens nach ${s.maxKerzen} Kerzen raus`);
  return zeilen;
}

function tagUnix(tag: string): number {
  return Math.floor(Date.parse(`${tag}T00:00:00Z`) / 1000);
}

export function strategieImChart(
  eintrag: StrategieEintrag,
  kerzen: readonly MarketCandle[],
): StrategieImChart {
  const s = eintrag.strategie;
  const von = tagUnix(eintrag.von);
  const bis = tagUnix(eintrag.bis) + 86_400;
  const ergebnis = backtest(s, kerzen, { symbol: eintrag.symbol, intervall: eintrag.intervall });
  const handel: StrategieHandel[] = ergebnis.handel.map((h) => ({
    ...h,
    nachAblage: h.einstiegZeit >= bis,
  }));
  const davor = handel.filter((h) => !h.nachAblage && h.grund !== "ende");
  const danach = handel.filter((h) => h.nachAblage);
  const gewinner = danach.filter((h) => h.r > 0).length;

  const archiviert = eintrag.kennzahlen?.anzahl;
  // Ein Handel, der am Ende des Prüfzeitraums noch offen war, stand im Archiv als „ende" und
  // läuft im Neulauf weiter. Deshalb wird mit Spielraum eins verglichen, nicht auf Gleichheit.
  const abweichung =
    archiviert !== undefined && Math.abs(archiviert - davor.length) > 1
      ? `Im Archiv stehen ${archiviert} Handel für den Prüfzeitraum, der Neulauf findet ${davor.length}. Der Anbieter hat seine Kerzen seither berichtigt — die Kennzahlen im Archiv gelten für die damaligen.`
      : undefined;

  const indikatoren = new Set<string>();
  for (const b of [...s.einstieg, ...(s.ausstieg ?? [])]) {
    for (const i of [b.links, b.rechts]) {
      const id = chartIndikatorFuer(i);
      if (id) indikatoren.add(id);
    }
  }
  // Die Stoplinie gehört ins Bild: wer „Stop an EMA 200" liest, will die EMA 200 sehen.
  const stopLinie = s.stopAn ? chartIndikatorFuer(s.stopAn) : null;
  if (stopLinie) indikatoren.add(stopLinie);

  const letzte = kerzen.length - 2; // die zuletzt **abgeschlossene** Kerze, wie im Papierhandel
  return {
    id: eintrag.id,
    name: eintrag.name,
    symbol: eintrag.symbol,
    intervall: eintrag.intervall,
    richtung: s.richtung,
    status: eintrag.status,
    von,
    bis,
    teilung: eintrag.outOfSample ? tagUnix(eintrag.outOfSample.von) : null,
    handel,
    kennzahlenArchiv: eintrag.kennzahlen,
    imPruefzeitraum: davor.length,
    seitAblage: {
      anzahl: danach.length,
      summeR: danach.reduce((summe, h) => summe + h.r, 0),
      trefferquote: danach.length > 0 ? gewinner / danach.length : null,
    },
    ...(abweichung ? { abweichung } : {}),
    signalLetzteKerze: letzte >= 0 ? signalAm(s, kerzen, letzte).einstieg : false,
    indikatoren: [...indikatoren],
    regel: regelInWorten(s),
  };
}
