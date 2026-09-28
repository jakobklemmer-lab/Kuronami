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

/**
 * Das letzte Swing-Tief: der tiefste Tiefpunkt der letzten `periode` Kerzen **einschließlich**
 * der aktuellen — wie `ta.lowest(low, periode)` in TradingView.
 *
 * Anders als `rollendesTief`, und das mit Absicht: dort geht es um einen Ausbruch unter das
 * eigene Tief, hier um den Ort eines Stops. Wer nach einer Signalkerze mit neuem Tief einsteigt
 * und den Stop unter das Tief der Kerzen **davor** legt, legt ihn über den Kurs.
 */
export function swingTief(kerzen: readonly MarketCandle[], periode: number): Reihe {
  const raus: Reihe = new Array(kerzen.length).fill(undefined);
  if (periode <= 0) return raus;
  for (let i = periode - 1; i < kerzen.length; i += 1) {
    let tief = Number.POSITIVE_INFINITY;
    for (let j = i - periode + 1; j <= i; j += 1) tief = Math.min(tief, kerzen[j].low);
    raus[i] = tief;
  }
  return raus;
}

/** Das letzte Swing-Hoch, gespiegelt zu `swingTief`. */
export function swingHoch(kerzen: readonly MarketCandle[], periode: number): Reihe {
  const raus: Reihe = new Array(kerzen.length).fill(undefined);
  if (periode <= 0) return raus;
  for (let i = periode - 1; i < kerzen.length; i += 1) {
    let hoch = Number.NEGATIVE_INFINITY;
    for (let j = i - periode + 1; j <= i; j += 1) hoch = Math.max(hoch, kerzen[j].high);
    raus[i] = hoch;
  }
  return raus;
}

/**
 * Williams-Fraktale, gerechnet wie der eingebaute Indikator bei TradingView — aber **dort, wo
 * sie feststehen, nicht dort, wo sie gezeichnet werden.**
 *
 * Ein Fraktal-Tief ist eine Kerze, deren Tief unter den `n` Kerzen danach und den `n` Kerzen
 * davor liegt; links dürfen wie bei TradingView bis zu vier gleich tiefe Kerzen dazwischen
 * stehen. Feststehen kann es erst, wenn die `n` Kerzen **danach** abgeschlossen sind.
 * TradingView zeichnet den Pfeil trotzdem `n` Kerzen früher unter die Tiefkerze selbst — wer
 * im Chart „am Pfeil" einsteigt, steigt mit Wissen ein, das es in dem Moment noch nicht gab.
 *
 * Deshalb trägt die Reihe den Wert (das Tief bzw. Hoch der Fraktalkerze) **auf der Kerze, auf
 * der das Fraktal feststeht**, und sonst `undefined`. Als Einstiegsbedingung heißt das: „auf
 * dieser Kerze ist ein Pfeil erschienen" — und eingestiegen wird wie immer zur nächsten
 * Eröffnung.
 */
export function fraktale(kerzen: readonly MarketCandle[], n = 2): { tief: Reihe; hoch: Reihe } {
  const tief: Reihe = new Array(kerzen.length).fill(undefined);
  const hoch: Reihe = new Array(kerzen.length).fill(undefined);
  if (n <= 0) return { tief, hoch };
  const lo = (i: number): number | undefined => kerzen[i]?.low;
  const hi = (i: number): number | undefined => kerzen[i]?.high;

  // `strikt(a, b)` heißt „a liegt jenseits von b": fürs Tief höher, fürs Hoch tiefer.
  const ist = (
    feld: (i: number) => number | undefined,
    f: number,
    strikt: (a: number, b: number) => boolean,
    gleichOder: (a: number, b: number) => boolean,
  ): boolean => {
    const mitte = feld(f) as number;
    for (let i = 1; i <= n; i += 1) {
      const danach = feld(f + i);
      if (danach === undefined || !strikt(danach, mitte)) return false;
    }
    // Links: `gleich` Kerzen dürfen gleich weit (oder weniger weit) reichen, dann müssen `n`
    // strikt dahinter liegen — die fünf Varianten aus TradingViews eigenem Code.
    for (let gleich = 0; gleich <= 4; gleich += 1) {
      let passt = true;
      for (let j = 1; j <= gleich && passt; j += 1) {
        const w = feld(f - j);
        passt = w !== undefined && gleichOder(w, mitte);
      }
      for (let i = 1; i <= n && passt; i += 1) {
        const w = feld(f - gleich - i);
        passt = w !== undefined && strikt(w, mitte);
      }
      if (passt) return true;
    }
    return false;
  };

  for (let t = 2 * n; t < kerzen.length; t += 1) {
    const f = t - n;
    if (
      ist(
        lo,
        f,
        (a, b) => a > b,
        (a, b) => a >= b,
      )
    )
      tief[t] = lo(f);
    if (
      ist(
        hi,
        f,
        (a, b) => a < b,
        (a, b) => a <= b,
      )
    )
      hoch[t] = hi(f);
  }
  return { tief, hoch };
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

// ---------------------------------------------------------------------------
// Sitzungszeit — der Anker unter VWAP und Zeitfenster
// ---------------------------------------------------------------------------

/**
 * Die Ortszeit einer Kerze.
 *
 * Kerzen tragen Unix-Sekunden, und alles, was dieses Haus bisher anzeigte, war UTC. Für einen
 * Tagesindikator reicht das. Für Scalping nicht: „nur zwischen 09:30 und 11:00" meint die
 * Eröffnung einer Börse, und die steht im Sommer auf einem anderen UTC-Stempel als im Winter.
 * Wer das Fenster in UTC setzt, prüft ein halbes Jahr lang ein anderes Fenster als das andere
 * halbe — und merkt es nie, weil beide Hälften plausibel aussehen.
 *
 * Deshalb hier `Intl` mit echter Zeitzone statt einer Stundenrechnung von Hand. Die Formatierer
 * sind teuer zu bauen und billig zu benutzen, also werden sie behalten.
 */
export class ZeitzoneFehler extends Error {}

const formatierer = new Map<string, Intl.DateTimeFormat>();

function formatiererFuer(zone: string): Intl.DateTimeFormat {
  const vorhanden = formatierer.get(zone);
  if (vorhanden !== undefined) return vorhanden;
  let neu: Intl.DateTimeFormat;
  try {
    neu = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    throw new ZeitzoneFehler(
      `Unbekannte Zeitzone "${zone}". Erwartet wird eine IANA-Angabe wie Europe/Berlin.`,
    );
  }
  formatierer.set(zone, neu);
  return neu;
}

interface Ortszeit {
  /** `YYYY-MM-DD` in der Zone — der Tagesanker. */
  tag: string;
  /** Minuten seit Mitternacht in der Zone, 0 bis 1439. */
  minute: number;
}

const zeitCache = new Map<string, Ortszeit>();

export function ortszeit(unixSekunden: number, zone: string): Ortszeit {
  const schluessel = `${zone}|${unixSekunden}`;
  const gemerkt = zeitCache.get(schluessel);
  if (gemerkt !== undefined) return gemerkt;
  const teile = formatiererFuer(zone).formatToParts(new Date(unixSekunden * 1000));
  let jahr = "";
  let monat = "";
  let tag = "";
  let stunde = 0;
  let minute = 0;
  for (const teil of teile) {
    if (teil.type === "year") jahr = teil.value;
    else if (teil.type === "month") monat = teil.value;
    else if (teil.type === "day") tag = teil.value;
    else if (teil.type === "hour") stunde = Number(teil.value);
    else if (teil.type === "minute") minute = Number(teil.value);
  }
  const wert: Ortszeit = { tag: `${jahr}-${monat}-${tag}`, minute: stunde * 60 + minute };
  // Der Cache ist auf einen Lauf ausgelegt, nicht auf Ewigkeit: eine mehrjährige 5-Minuten-Reihe
  // hat Hunderttausende Stempel, und ein unbegrenzter Cache wäre dann der Speicherfresser.
  if (zeitCache.size > 400_000) zeitCache.clear();
  zeitCache.set(schluessel, wert);
  return wert;
}

/** `"09:30"` → 570. Wirft bei allem, was keine Uhrzeit ist. */
export function minuteAus(uhrzeit: string): number {
  const treffer = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(uhrzeit.trim());
  if (treffer === null) {
    throw new ZeitzoneFehler(`"${uhrzeit}" ist keine Uhrzeit. Erwartet wird HH:MM, z. B. 09:30.`);
  }
  return Number(treffer[1]) * 60 + Number(treffer[2]);
}

/**
 * Liegt die Kerze im Fenster? Ein Fenster, dessen Ende vor seinem Anfang steht, läuft über
 * Mitternacht — für Krypto und die asiatische Sitzung ist das der Normalfall, kein Fehler.
 */
export function imFenster(
  unixSekunden: number,
  zone: string,
  vonMinute: number,
  bisMinute: number,
): boolean {
  const { minute } = ortszeit(unixSekunden, zone);
  return vonMinute <= bisMinute
    ? minute >= vonMinute && minute < bisMinute
    : minute >= vonMinute || minute < bisMinute;
}

// ---------------------------------------------------------------------------
// VWAP
// ---------------------------------------------------------------------------

/** Trägt die Reihe überhaupt Volumen? Ohne das ist ein VWAP keine Linie, sondern eine Lüge. */
export function hatVolumen(kerzen: readonly MarketCandle[]): boolean {
  return kerzen.some((k) => typeof k.volume === "number" && k.volume > 0);
}

export interface VwapReihen {
  vwap: Reihe;
  /** VWAP plus `faktor` volumengewichtete Standardabweichungen. */
  oben: Reihe;
  unten: Reihe;
}

/**
 * Volumengewichteter Durchschnittskurs, **je Sitzung neu angesetzt**.
 *
 * Das Zurücksetzen ist der ganze Indikator. Ein VWAP, der über Wochen durchläuft, ist ein
 * träger gleitender Durchschnitt mit Volumengewicht und hat mit dem, was ein Daytrader VWAP
 * nennt, nichts zu tun: der misst, wo der Markt **heute** im Schnitt gehandelt hat, und
 * gegen diese Linie wird gekauft und verkauft. Der Anker ist deshalb der Sitzungstag in der
 * Zeitzone der Börse — nicht der UTC-Tag, der mitten in der US-Sitzung umspringt.
 *
 * Die Bänder sind die volumengewichtete Standardabweichung um den VWAP, aus denselben
 * laufenden Summen: E[p²] − E[p]². Damit lässt sich „Rücklauf an den VWAP" von „Abprall am
 * Band" unterscheiden, ohne einen zweiten Indikator.
 *
 * **Ohne Volumen kommt eine Reihe aus `undefined` zurück** — wie beim OBV. Der Aufrufer muss
 * das prüfen; `backtest.ts` tut es und weist die Strategie ab, statt sie nie auslösen zu
 * lassen. Eine Regel, die stumm nie feuert, sieht aus wie eine Regel, die nicht funktioniert.
 */
export function vwap(kerzen: readonly MarketCandle[], zone = "UTC", faktor = 1): VwapReihen {
  const leer = (): Reihe => new Array(kerzen.length).fill(undefined);
  const raus: VwapReihen = { vwap: leer(), oben: leer(), unten: leer() };
  if (!hatVolumen(kerzen)) return raus;

  let anker = "";
  let summeV = 0;
  let summePV = 0;
  let summePPV = 0;
  for (let i = 0; i < kerzen.length; i += 1) {
    const k = kerzen[i];
    const tag = ortszeit(k.time, zone).tag;
    if (tag !== anker) {
      anker = tag;
      summeV = 0;
      summePV = 0;
      summePPV = 0;
    }
    const volumen = k.volume ?? 0;
    // Typischer Kurs statt Schlusskurs: eine 5-Minuten-Kerze ist kein Punkt, und der Schluss
    // allein überbewertet das Ende des Intervalls.
    const typisch = (k.high + k.low + k.close) / 3;
    summeV += volumen;
    summePV += typisch * volumen;
    summePPV += typisch * typisch * volumen;
    // Eine Kerze ohne Volumen am Sitzungsanfang lässt die Summe auf null — dann gibt es noch
    // keinen Durchschnitt, und `undefined` ist die richtige Auskunft.
    if (summeV <= 0) continue;
    const mittel = summePV / summeV;
    const varianz = Math.max(0, summePPV / summeV - mittel * mittel);
    const abweichung = Math.sqrt(varianz);
    raus.vwap[i] = mittel;
    raus.oben[i] = mittel + faktor * abweichung;
    raus.unten[i] = mittel - faktor * abweichung;
  }
  return raus;
}

/**
 * Double EMA (Mulloy 1994): 2·EMA − EMA(EMA), wie TradingViews `DEMA`. Die zweite Glättung
 * beginnt, sobald die erste steht — bei 200 Kerzen Periode also erst nach rund 400 Kerzen.
 * Gebaut am 28.09. für das SuperTrend-Video von TradingLab (DEMA 200 als Trendfilter).
 */
export function dema(werte: readonly number[], periode: number): Reihe {
  const raus: Reihe = new Array(werte.length).fill(undefined);
  const e1 = ema(werte, periode);
  const start = e1.findIndex((w) => w !== undefined);
  if (start < 0) return raus;
  const e2 = ema(e1.slice(start) as number[], periode);
  for (let i = 0; i < e2.length; i += 1) {
    const a = e1[start + i];
    const b = e2[i];
    if (a !== undefined && b !== undefined) raus[start + i] = 2 * a - b;
  }
  return raus;
}

/**
 * SuperTrend wie TradingViews `ta.supertrend(faktor, periode)`: Bänder um (Hoch+Tief)/2 im
 * Abstand faktor·ATR, die nur nachziehen, nie zurückweichen. Der ATR ist hier der nach Wilder
 * (RMA, Start auf dem Mittel der ersten Spannen) wie bei TradingView — nicht der gleitende
 * Mittelwert aus `atrReihe`, sonst läge die Linie woanders als im Chart.
 *
 * `linie` ist das aktive Band: unter dem Kurs im Aufwärtstrend, darüber im Abwärtstrend.
 * `richtung` ist +1 aufwärts, −1 abwärts (TradingView zählt umgekehrt). Ein Kaufsignal ist der
 * Wechsel auf +1 — der Schluss kreuzt die Linie nach oben, weil sie dabei vom oberen aufs untere
 * Band springt.
 */
export function supertrend(
  kerzen: readonly MarketCandle[],
  periode = 10,
  faktor = 3,
): { linie: Reihe; richtung: Reihe } {
  const n = kerzen.length;
  const linie: Reihe = new Array(n).fill(undefined);
  const richtung: Reihe = new Array(n).fill(undefined);
  if (periode <= 0 || n < periode) return { linie, richtung };
  const spanne = (i: number): number => {
    const k = kerzen[i];
    if (i === 0) return k.high - k.low;
    const v = kerzen[i - 1].close;
    return Math.max(k.high - k.low, Math.abs(k.high - v), Math.abs(k.low - v));
  };
  let atr = 0;
  for (let i = 0; i < periode; i += 1) atr += spanne(i);
  atr /= periode;
  let vorOben: number | undefined;
  let vorUnten: number | undefined;
  let warOben = true;
  for (let i = periode - 1; i < n; i += 1) {
    if (i >= periode) atr = (atr * (periode - 1) + spanne(i)) / periode;
    const k = kerzen[i];
    const mitte = (k.high + k.low) / 2;
    let oben = mitte + faktor * atr;
    let unten = mitte - faktor * atr;
    let auf = false;
    if (vorOben !== undefined && vorUnten !== undefined) {
      const vorSchluss = kerzen[i - 1].close;
      unten = unten > vorUnten || vorSchluss < vorUnten ? unten : vorUnten;
      oben = oben < vorOben || vorSchluss > vorOben ? oben : vorOben;
      auf = warOben ? k.close > oben : !(k.close < unten);
    }
    linie[i] = auf ? unten : oben;
    richtung[i] = auf ? 1 : -1;
    vorOben = oben;
    vorUnten = unten;
    warOben = !auf;
  }
  return { linie, richtung };
}

/**
 * Engulfing-Kerze: +1, wenn eine grüne Kerze den Körper einer roten Vorkerze ganz umschließt
 * (Eröffnung ≤ Vorschluss, Schluss ≥ Voreröffnung, größerer Körper), −1 gespiegelt, sonst 0.
 * Das ist die Lehrbuchform; der Indikator im BEST-Scalping-Video ist ein fremdes Skript, dessen
 * Zusatzbedingungen niemand kennt.
 */
export function engulfing(kerzen: readonly MarketCandle[]): Reihe {
  return kerzen.map((k, i) => {
    if (i === 0) return undefined;
    const v = kerzen[i - 1];
    const koerper = Math.abs(k.close - k.open);
    const vorKoerper = Math.abs(v.close - v.open);
    if (koerper <= vorKoerper) return 0;
    if (v.close < v.open && k.close > k.open && k.open <= v.close && k.close >= v.open) return 1;
    if (v.close > v.open && k.close < k.open && k.open >= v.close && k.close <= v.open) return -1;
    return 0;
  });
}

/** Schluss minus bzw. plus `faktor` Kerzenspannen (Hoch−Tief) — ein Stop „zweimal die Länge
 *  der Einstiegskerze" (TradingLab, BEST Scalping, 05:13). */
export function spannenStop(
  kerzen: readonly MarketCandle[],
  faktor = 2,
): { unter: Reihe; ueber: Reihe } {
  return {
    unter: kerzen.map((k) => k.close - faktor * (k.high - k.low)),
    ueber: kerzen.map((k) => k.close + faktor * (k.high - k.low)),
  };
}
