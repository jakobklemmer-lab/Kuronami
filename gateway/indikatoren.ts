import type { MarketCandle } from "./integrations/markets.js";

/**
 * Die Indikatoren, auf denen Strategien und Prüfungen stehen — als reine Funktionen über
 * Kerzen, ohne Zustand und ohne Netz.
 *
 * **Jede Reihe ist so lang wie die Kerzenreihe und beginnt mit `undefined`,** solange die
 * Periode noch nicht voll ist. Das ist der Kern: ein Indikator, der seine ersten Werte aus zu
 * wenigen Kerzen schätzt, macht einen Backtest zu einer Erzählung. `undefined` heißt „dazu gibt
 * es noch keine Auskunft", und der Backtest handelt dann nicht.
 *
 * Die Werte lassen sich aus der Kerzentabelle nachrechnen, die im selben Bericht steht — das ist
 * Absicht. Jakobs Maßstab für den Handelstisch: nachrechnen können, nicht glauben müssen.
 */

export type Reihe = (number | undefined)[];

export function schlusskurse(kerzen: readonly MarketCandle[]): number[] {
  return kerzen.map((k) => k.close);
}

/** Einfacher gleitender Durchschnitt. */
export function sma(werte: readonly number[], periode: number): Reihe {
  const raus: Reihe = new Array(werte.length).fill(undefined);
  if (periode <= 0) return raus;
  let summe = 0;
  for (let i = 0; i < werte.length; i += 1) {
    summe += werte[i];
    if (i >= periode) summe -= werte[i - periode];
    if (i >= periode - 1) raus[i] = summe / periode;
  }
  return raus;
}

/**
 * Exponentieller gleitender Durchschnitt, gestartet auf dem SMA der ersten Periode — die
 * übliche Konvention. Ein Start auf dem ersten Kurs würde die ersten Dutzend Werte verzerren,
 * und genau dort liegen in einem kurzen Backtest die meisten Signale.
 */
export function ema(werte: readonly number[], periode: number): Reihe {
  const raus: Reihe = new Array(werte.length).fill(undefined);
  if (periode <= 0 || werte.length < periode) return raus;
  const faktor = 2 / (periode + 1);
  let stand = werte.slice(0, periode).reduce((a, b) => a + b, 0) / periode;
  raus[periode - 1] = stand;
  for (let i = periode; i < werte.length; i += 1) {
    stand = werte[i] * faktor + stand * (1 - faktor);
    raus[i] = stand;
  }
  return raus;
}

/**
 * RSI nach Wilder (geglättet), nicht der einfache Mittelwert: der einfache springt bei jedem
 * Herausfallen einer alten Kerze und erzeugt Signale, die es an der Börse nie gab.
 */
export function rsi(werte: readonly number[], periode = 14): Reihe {
  const raus: Reihe = new Array(werte.length).fill(undefined);
  if (periode <= 0 || werte.length <= periode) return raus;
  let gewinn = 0;
  let verlust = 0;
  for (let i = 1; i <= periode; i += 1) {
    const differenz = werte[i] - werte[i - 1];
    if (differenz >= 0) gewinn += differenz;
    else verlust -= differenz;
  }
  gewinn /= periode;
  verlust /= periode;
  raus[periode] = verlust === 0 ? 100 : 100 - 100 / (1 + gewinn / verlust);
  for (let i = periode + 1; i < werte.length; i += 1) {
    const differenz = werte[i] - werte[i - 1];
    gewinn = (gewinn * (periode - 1) + Math.max(0, differenz)) / periode;
    verlust = (verlust * (periode - 1) + Math.max(0, -differenz)) / periode;
    raus[i] = verlust === 0 ? 100 : 100 - 100 / (1 + gewinn / verlust);
  }
  return raus;
}

/** Die wahre Spanne einer Kerze: Hoch-Tief, oder die Lücke zum Vorschluss, falls sie größer ist. */
export function wahreSpanne(kerzen: readonly MarketCandle[]): Reihe {
  return kerzen.map((k, i) => {
    if (i === 0) return undefined;
    const vorher = kerzen[i - 1].close;
    return Math.max(k.high - k.low, Math.abs(k.high - vorher), Math.abs(k.low - vorher));
  });
}

/** ATR als gleitender Mittelwert der wahren Spannen — dieselbe Rechnung wie in `crv.ts`. */
export function atrReihe(kerzen: readonly MarketCandle[], periode = 14): Reihe {
  const spannen = wahreSpanne(kerzen);
  const raus: Reihe = new Array(kerzen.length).fill(undefined);
  let summe = 0;
  let gezaehlt = 0;
  for (let i = 0; i < spannen.length; i += 1) {
    const wert = spannen[i];
    if (wert === undefined) continue;
    summe += wert;
    gezaehlt += 1;
    if (gezaehlt > periode) {
      const raus_wert = spannen[i - periode];
      if (raus_wert !== undefined) summe -= raus_wert;
      gezaehlt -= 1;
    }
    if (gezaehlt === periode) raus[i] = summe / periode;
  }
  return raus;
}

/** Höchster Hochpunkt der letzten `periode` Kerzen **ohne** die aktuelle — ein Ausbruch über
 * das eigene Hoch wäre sonst immer schon eingetreten. */
export function rollendesHoch(kerzen: readonly MarketCandle[], periode: number): Reihe {
  const raus: Reihe = new Array(kerzen.length).fill(undefined);
  for (let i = periode; i < kerzen.length; i += 1) {
    let hoch = Number.NEGATIVE_INFINITY;
    for (let j = i - periode; j < i; j += 1) hoch = Math.max(hoch, kerzen[j].high);
    raus[i] = hoch;
  }
  return raus;
}

/** Tiefster Tiefpunkt der letzten `periode` Kerzen, ohne die aktuelle. */
export function rollendesTief(kerzen: readonly MarketCandle[], periode: number): Reihe {
  const raus: Reihe = new Array(kerzen.length).fill(undefined);
  for (let i = periode; i < kerzen.length; i += 1) {
    let tief = Number.POSITIVE_INFINITY;
    for (let j = i - periode; j < i; j += 1) tief = Math.min(tief, kerzen[j].low);
    raus[i] = tief;
  }
  return raus;
}

/** Standardabweichung der letzten `periode` Werte — Grundlage für Bänder und für die Volatilität. */
export function stdabw(werte: readonly number[], periode: number): Reihe {
  const raus: Reihe = new Array(werte.length).fill(undefined);
  if (periode <= 1) return raus;
  for (let i = periode - 1; i < werte.length; i += 1) {
    const fenster = werte.slice(i - periode + 1, i + 1);
    const mittel = fenster.reduce((a, b) => a + b, 0) / periode;
    const varianz = fenster.reduce((a, b) => a + (b - mittel) ** 2, 0) / (periode - 1);
    raus[i] = Math.sqrt(varianz);
  }
  return raus;
}

/**
 * MACD: die Differenz zweier exponentieller Durchschnitte, dazu ihre Signallinie und der
 * Abstand zwischen beiden.
 *
 * Die drei Reihen kommen zusammen zurück, weil sie zusammengehören — ein MACD ohne seine
 * Signallinie ist eine halbe Auskunft, und wer beide getrennt anfordert, rechnet die EMAs
 * zweimal.
 */
export function macd(
  werte: readonly number[],
  schnell = 12,
  langsam = 26,
  signalPeriode = 9,
): { macd: Reihe; signal: Reihe; histogramm: Reihe } {
  const emaSchnell = ema(werte, schnell);
  const emaLangsam = ema(werte, langsam);
  const linie: Reihe = werte.map((_, i) => {
    const a = emaSchnell[i];
    const b = emaLangsam[i];
    return a === undefined || b === undefined ? undefined : a - b;
  });

  // Die Signallinie ist ein EMA **auf der MACD-Linie** — er beginnt erst, wo die Linie beginnt.
  const ersterIndex = linie.findIndex((w) => w !== undefined);
  const signal: Reihe = new Array(werte.length).fill(undefined);
  if (ersterIndex >= 0) {
    const dicht = linie.slice(ersterIndex).map((w) => w as number);
    const gerechnet = ema(dicht, signalPeriode);
    for (let i = 0; i < gerechnet.length; i += 1) signal[ersterIndex + i] = gerechnet[i];
  }
  const histogramm: Reihe = werte.map((_, i) => {
    const a = linie[i];
    const b = signal[i];
    return a === undefined || b === undefined ? undefined : a - b;
  });
  return { macd: linie, signal, histogramm };
}

/**
 * ADX nach Wilder: **wie stark** ein Trend ist, unabhängig von seiner Richtung. Über 25 gilt
 * gemeinhin als Trend, unter 20 als Seitwärtsphase.
 *
 * Die beiden Richtungsindizes (+DI, −DI) kommen mit zurück: erst ihr Verhältnis sagt, wohin
 * der starke Trend läuft.
 */
export function adx(
  kerzen: readonly MarketCandle[],
  periode = 14,
): { adx: Reihe; diPlus: Reihe; diMinus: Reihe } {
  const n = kerzen.length;
  const leer = (): Reihe => new Array(n).fill(undefined);
  const raus = { adx: leer(), diPlus: leer(), diMinus: leer() };
  if (n < periode * 2) return raus;

  const tr: number[] = [0];
  const plusDM: number[] = [0];
  const minusDM: number[] = [0];
  for (let i = 1; i < n; i += 1) {
    const k = kerzen[i];
    const vor = kerzen[i - 1];
    tr.push(Math.max(k.high - k.low, Math.abs(k.high - vor.close), Math.abs(k.low - vor.close)));
    const auf = k.high - vor.high;
    const ab = vor.low - k.low;
    plusDM.push(auf > ab && auf > 0 ? auf : 0);
    minusDM.push(ab > auf && ab > 0 ? ab : 0);
  }

  // Wilders Glättung: erst die Summe der ersten Periode, danach fortgeschrieben.
  let trSumme = 0;
  let plusSumme = 0;
  let minusSumme = 0;
  for (let i = 1; i <= periode; i += 1) {
    trSumme += tr[i];
    plusSumme += plusDM[i];
    minusSumme += minusDM[i];
  }
  const dx: Reihe = leer();
  for (let i = periode; i < n; i += 1) {
    if (i > periode) {
      trSumme = trSumme - trSumme / periode + tr[i];
      plusSumme = plusSumme - plusSumme / periode + plusDM[i];
      minusSumme = minusSumme - minusSumme / periode + minusDM[i];
    }
    if (trSumme === 0) continue;
    const plus = (plusSumme / trSumme) * 100;
    const minus = (minusSumme / trSumme) * 100;
    raus.diPlus[i] = plus;
    raus.diMinus[i] = minus;
    const summe = plus + minus;
    dx[i] = summe === 0 ? 0 : (Math.abs(plus - minus) / summe) * 100;
  }

  let adxStand: number | null = null;
  const start = periode * 2 - 1;
  for (let i = start; i < n; i += 1) {
    if (adxStand === null) {
      let summe = 0;
      let gezaehlt = 0;
      for (let j = periode; j <= i; j += 1) {
        const wert = dx[j];
        if (wert !== undefined) {
          summe += wert;
          gezaehlt += 1;
        }
      }
      if (gezaehlt < periode) continue;
      adxStand = summe / gezaehlt;
    } else {
      const wert = dx[i];
      if (wert === undefined) continue;
      adxStand = (adxStand * (periode - 1) + wert) / periode;
    }
    raus.adx[i] = adxStand;
  }
  return raus;
}

/**
 * Stochastischer Oszillator: wo der Schlusskurs innerhalb der Spanne der letzten `periode`
 * Kerzen liegt. %K ist der rohe Wert (hier bereits geglättet, „slow stochastic"), %D sein
 * gleitender Durchschnitt.
 */
export function stochastik(
  kerzen: readonly MarketCandle[],
  periode = 14,
  glaettungK = 3,
  glaettungD = 3,
): { k: Reihe; d: Reihe } {
  const roh: Reihe = new Array(kerzen.length).fill(undefined);
  for (let i = periode - 1; i < kerzen.length; i += 1) {
    let hoch = Number.NEGATIVE_INFINITY;
    let tief = Number.POSITIVE_INFINITY;
    for (let j = i - periode + 1; j <= i; j += 1) {
      hoch = Math.max(hoch, kerzen[j].high);
      tief = Math.min(tief, kerzen[j].low);
    }
    const spanne = hoch - tief;
    // Eine Spanne von null heißt: der Kurs stand still. 50 ist dann die ehrliche Mitte.
    roh[i] = spanne === 0 ? 50 : ((kerzen[i].close - tief) / spanne) * 100;
  }
  const k = glaetteReihe(roh, glaettungK);
  const d = glaetteReihe(k, glaettungD);
  return { k, d };
}

/** Gleitender Durchschnitt über eine Reihe mit Lücken — die Lücken bleiben Lücken. */
function glaetteReihe(reihe: Reihe, periode: number): Reihe {
  const raus: Reihe = new Array(reihe.length).fill(undefined);
  if (periode <= 1) return [...reihe];
  for (let i = periode - 1; i < reihe.length; i += 1) {
    let summe = 0;
    let vollstaendig = true;
    for (let j = i - periode + 1; j <= i; j += 1) {
      const wert = reihe[j];
      if (wert === undefined) {
        vollstaendig = false;
        break;
      }
      summe += wert;
    }
    if (vollstaendig) raus[i] = summe / periode;
  }
  return raus;
}

/**
 * Bollinger-Bänder: ein gleitender Durchschnitt und zwei Bänder im Abstand von `faktor`
 * Standardabweichungen. Enge Bänder heißen ruhiger Markt, weite einen bewegten — die Bänder
 * sagen nichts über die Richtung.
 */
export function bollinger(
  werte: readonly number[],
  periode = 20,
  faktor = 2,
): { mitte: Reihe; oben: Reihe; unten: Reihe; breiteProzent: Reihe } {
  const mitte = sma(werte, periode);
  const abweichung = stdabw(werte, periode);
  const oben: Reihe = new Array(werte.length).fill(undefined);
  const unten: Reihe = new Array(werte.length).fill(undefined);
  const breiteProzent: Reihe = new Array(werte.length).fill(undefined);
  for (let i = 0; i < werte.length; i += 1) {
    const m = mitte[i];
    const a = abweichung[i];
    if (m === undefined || a === undefined) continue;
    oben[i] = m + a * faktor;
    unten[i] = m - a * faktor;
    breiteProzent[i] =
      m === 0 ? undefined : (((oben[i] as number) - (unten[i] as number)) / m) * 100;
  }
  return { mitte, oben, unten, breiteProzent };
}

/**
 * On-Balance-Volume: das Volumen wird addiert, wenn der Kurs stieg, und abgezogen, wenn er
 * fiel. Der absolute Stand sagt nichts; seine Richtung im Vergleich zum Kurs schon.
 *
 * **Ohne Volumen gibt es keine Reihe, sondern `undefined`.** Yahoo liefert bei Indizes und
 * Devisen keins, und eine aus Nullen gebaute Linie sähe aus wie eine Auskunft.
 */
export function obv(kerzen: readonly MarketCandle[]): Reihe {
  const hatVolumen = kerzen.some((k) => typeof k.volume === "number" && k.volume > 0);
  if (!hatVolumen) return new Array(kerzen.length).fill(undefined);
  const raus: Reihe = new Array(kerzen.length).fill(undefined);
  let stand = 0;
  raus[0] = 0;
  for (let i = 1; i < kerzen.length; i += 1) {
    const volumen = kerzen[i].volume ?? 0;
    if (kerzen[i].close > kerzen[i - 1].close) stand += volumen;
    else if (kerzen[i].close < kerzen[i - 1].close) stand -= volumen;
    raus[i] = stand;
  }
  return raus;
}
