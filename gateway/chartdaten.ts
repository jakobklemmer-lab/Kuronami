import {
  type Reihe,
  adx,
  atrReihe,
  bollinger,
  ema,
  hatVolumen,
  macd,
  obv,
  ortszeit,
  rsi,
  schlusskurse,
  sma,
  stochastik,
  vwap,
} from "./indikatoren.js";
import {
  type ChartInterval,
  type MarketCandle,
  type MarketChart,
  MarketDataError,
  type MarketsClient,
} from "./integrations/markets.js";

/**
 * Die Kerzen für den Chart der Märkte (2026-09-27, Umbau nach TradingView).
 *
 * **Die Kerzengröße ist die Wahl, nicht der Zeitraum.** Bis hierher fragte die Oberfläche
 * „1 Tag" und bekam 5-Minuten-Kerzen, „Max" und bekam — ohne dass es jemand merkte —
 * Quartalskerzen mit der Aufschrift „1wk". Jakob las „1T" als Tageskerze, wie jeder, der
 * Charts kennt. Hier wird deshalb nach der Kerzengröße gefragt, und die Antwort bringt so viel
 * Historie mit, wie der Anbieter für diese Größe hat. Wohin man schaut, entscheidet der Chart.
 *
 * **Die Grenzen sind gemessen, nicht der Doku entnommen** (2026-09-21 und 2026-09-27): 1m
 * reicht acht Kalendertage zurück, 5m/15m/30m sechzig, 1h zwei Jahre, Tag/Woche/Monat bis zum
 * Beginn der Aufzeichnung — letzteres nur über `period1=0`, denn `range=max` liefert
 * Quartalskerzen.
 *
 * **Die Indikatoren sind dieselben Funktionen wie am Handelstisch** (`indikatoren.ts`). Was
 * Jakob im Chart sieht, ist damit genau die Zahl, auf die sich eine Analyse von boerse stützt
 * — nicht eine zweite Rechnung, die in der dritten Nachkommastelle abweicht und dann erklärt
 * werden muss. Gerechnet wird über die ganze Historie und erst danach ausgeschnitten: ein
 * EMA 200, der am Rand eines nachgeladenen Stücks neu anliefe, wäre dort falsch.
 */

export const INTERVALL_IDS = ["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1wk", "1mo"] as const;
export type IntervallId = (typeof INTERVALL_IDS)[number];

export interface IntervallDef {
  /** Was bei Yahoo angefragt wird. 4h gibt es dort nicht; es entsteht aus 1h. */
  yahoo: ChartInterval;
  sekunden: number;
  /** Wie weit Yahoo zurückreicht. `null` heißt: bis zum Beginn der Aufzeichnung. */
  historieTage: number | null;
  /** Für die Aktualisierung genügt ein kurzes Fenster am Ende. */
  neuTage: number;
  /** So lange gilt ein Stand als frisch genug, um ohne neue Anfrage auszuliefern. */
  frischeSek: number;
  /** Nach so langer Zeit wird die ganze Historie neu geholt statt nur das Ende. */
  vollSek: number;
  /** Aus wie vielen Yahoo-Kerzen eine entsteht (nur 4h). */
  verdichten?: number;
}

export const INTERVALLE: Record<IntervallId, IntervallDef> = {
  "1m": { yahoo: "1m", sekunden: 60, historieTage: 7, neuTage: 1, frischeSek: 10, vollSek: 1800 },
  "5m": { yahoo: "5m", sekunden: 300, historieTage: 59, neuTage: 2, frischeSek: 15, vollSek: 3600 },
  "15m": {
    yahoo: "15m",
    sekunden: 900,
    historieTage: 59,
    neuTage: 3,
    frischeSek: 20,
    vollSek: 3600,
  },
  "30m": {
    yahoo: "30m",
    sekunden: 1800,
    historieTage: 59,
    neuTage: 5,
    frischeSek: 30,
    vollSek: 3600,
  },
  "1h": {
    yahoo: "1h",
    sekunden: 3600,
    historieTage: 729,
    neuTage: 10,
    frischeSek: 45,
    vollSek: 7200,
  },
  "4h": {
    yahoo: "1h",
    sekunden: 14_400,
    historieTage: 729,
    neuTage: 14,
    frischeSek: 60,
    vollSek: 7200,
    verdichten: 4,
  },
  "1d": {
    yahoo: "1d",
    sekunden: 86_400,
    historieTage: null,
    neuTage: 30,
    frischeSek: 120,
    vollSek: 21_600,
  },
  "1wk": {
    yahoo: "1wk",
    sekunden: 604_800,
    historieTage: null,
    neuTage: 120,
    frischeSek: 300,
    vollSek: 43_200,
  },
  "1mo": {
    yahoo: "1mo",
    sekunden: 2_592_000,
    historieTage: null,
    neuTage: 400,
    frischeSek: 600,
    vollSek: 43_200,
  },
};

export function istIntervall(wert: string): wert is IntervallId {
  return (INTERVALL_IDS as readonly string[]).includes(wert);
}

// ------------------------------------------------------------------------------ Verdichten

/**
 * Vier Stundenkerzen zu einer. Der Anker ist die **erste Kerze des Handelstags** in der Zone
 * des Handelsplatzes, nicht Mitternacht UTC: beim DAX entstehen so 09–13, 13–17 und 17–17:30
 * Uhr wie bei TradingView, bei Bitcoin (Zone UTC, erste Kerze 00:00) 00, 04, 08 … Uhr.
 */
export function verdichte(
  kerzen: readonly MarketCandle[],
  sekunden: number,
  zone = "UTC",
): MarketCandle[] {
  const raus: MarketCandle[] = [];
  let tag = "";
  let anker = 0;
  let aktuell: MarketCandle | null = null;
  let aktuellerEimer = -1;
  for (const k of kerzen) {
    const t = ortszeit(k.time, zone).tag;
    if (t !== tag) {
      tag = t;
      anker = k.time;
      aktuellerEimer = -1;
    }
    const eimer = Math.floor((k.time - anker) / sekunden);
    if (aktuell === null || eimer !== aktuellerEimer) {
      if (aktuell !== null) raus.push(aktuell);
      aktuellerEimer = eimer;
      aktuell = {
        time: anker + eimer * sekunden,
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
        ...(k.volume !== undefined ? { volume: k.volume } : {}),
      };
      continue;
    }
    aktuell.high = Math.max(aktuell.high, k.high);
    aktuell.low = Math.min(aktuell.low, k.low);
    aktuell.close = k.close;
    if (k.volume !== undefined) aktuell.volume = (aktuell.volume ?? 0) + k.volume;
  }
  if (aktuell !== null) raus.push(aktuell);
  return raus;
}

/** Ein frisches Stück an eine Reihe hängen: ab seiner ersten Kerze gilt das Neue. */
export function fuegeAn(
  alt: readonly MarketCandle[],
  neu: readonly MarketCandle[],
): MarketCandle[] {
  if (neu.length === 0) return [...alt];
  const ab = neu[0].time;
  const behalten = alt.filter((k) => k.time < ab);
  return [...behalten, ...neu];
}

// ------------------------------------------------------------------------------ Indikatoren

export const INDIKATOR_ARTEN = [
  "sma",
  "ema",
  "bb",
  "vwap",
  "rsi",
  "macd",
  "stoch",
  "atr",
  "adx",
  "obv",
] as const;
export type IndikatorArt = (typeof INDIKATOR_ARTEN)[number];

/** Vorgaben und erlaubte Zahl der Parameter je Art. */
const PARAMETER: Record<IndikatorArt, number[]> = {
  sma: [20],
  ema: [50],
  bb: [20, 2],
  vwap: [1],
  rsi: [14],
  macd: [12, 26, 9],
  stoch: [14, 3, 3],
  atr: [14],
  adx: [14],
  obv: [],
};

export interface IndikatorWunsch {
  id: string;
  art: IndikatorArt;
  parameter: number[];
}

export class IndikatorFehler extends Error {}

/**
 * `sma:20,ema:50,bb:20:2,rsi:14` in Wünsche übersetzen. Unbekanntes wird abgewiesen, nicht
 * übergangen — ein stillschweigend fehlender Indikator sähe aus wie einer ohne Signal.
 */
export function leseIndikatoren(roh: string): IndikatorWunsch[] {
  const teile = roh
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (teile.length > 12) throw new IndikatorFehler("Höchstens zwölf Indikatoren auf einmal.");
  const raus: IndikatorWunsch[] = [];
  for (const teil of teile) {
    const [art, ...zahlen] = teil.split(":");
    if (!(INDIKATOR_ARTEN as readonly string[]).includes(art)) {
      throw new IndikatorFehler(`Unbekannter Indikator "${art}".`);
    }
    const a = art as IndikatorArt;
    const vorgabe = PARAMETER[a];
    if (zahlen.length > vorgabe.length) {
      throw new IndikatorFehler(`${a} nimmt höchstens ${vorgabe.length} Werte.`);
    }
    const parameter = vorgabe.map((v, i) => {
      if (zahlen[i] === undefined || zahlen[i] === "") return v;
      const n = Number(zahlen[i].replace(",", "."));
      if (!Number.isFinite(n) || n <= 0 || n > 500) {
        throw new IndikatorFehler(`"${zahlen[i]}" ist kein brauchbarer Wert für ${a}.`);
      }
      // Perioden sind ganze Kerzen; nur der Faktor der Bänder darf krumm sein.
      return (a === "bb" && i === 1) || (a === "vwap" && i === 0) ? n : Math.round(n);
    });
    raus.push({ id: [a, ...parameter].join(":"), art: a, parameter });
  }
  return raus;
}

export interface IndikatorErgebnis {
  id: string;
  art: IndikatorArt;
  parameter: number[];
  reihen: Record<string, Reihe>;
  /** Warum eine Reihe leer bleibt — statt einer leeren Linie ohne Begründung. */
  hinweis?: string;
}

export function rechneIndikator(
  wunsch: IndikatorWunsch,
  kerzen: readonly MarketCandle[],
  kontext: { intraday: boolean; zone: string },
): IndikatorErgebnis {
  const schluss = schlusskurse(kerzen);
  const p = wunsch.parameter;
  const kopf = { id: wunsch.id, art: wunsch.art, parameter: p };
  switch (wunsch.art) {
    case "sma":
      return { ...kopf, reihen: { wert: sma(schluss, p[0]) } };
    case "ema":
      return { ...kopf, reihen: { wert: ema(schluss, p[0]) } };
    case "bb": {
      const b = bollinger(schluss, p[0], p[1]);
      return { ...kopf, reihen: { mitte: b.mitte, oben: b.oben, unten: b.unten } };
    }
    case "vwap": {
      if (!kontext.intraday) {
        return {
          ...kopf,
          reihen: {},
          hinweis: "Der VWAP gilt je Handelstag und braucht Kerzen unter einem Tag.",
        };
      }
      if (!hatVolumen(kerzen)) {
        return {
          ...kopf,
          reihen: {},
          hinweis: "Yahoo liefert für diesen Wert kein Volumen — ohne Volumen gibt es keinen VWAP.",
        };
      }
      const v = vwap(kerzen, kontext.zone, p[0]);
      return { ...kopf, reihen: { vwap: v.vwap, oben: v.oben, unten: v.unten } };
    }
    case "rsi":
      return { ...kopf, reihen: { wert: rsi(schluss, p[0]) } };
    case "macd": {
      const m = macd(schluss, p[0], p[1], p[2]);
      return { ...kopf, reihen: { macd: m.macd, signal: m.signal, histogramm: m.histogramm } };
    }
    case "stoch": {
      const s = stochastik(kerzen, p[0], p[1], p[2]);
      return { ...kopf, reihen: { k: s.k, d: s.d } };
    }
    case "atr":
      return { ...kopf, reihen: { wert: atrReihe(kerzen, p[0]) } };
    case "adx": {
      const a = adx(kerzen, p[0]);
      return { ...kopf, reihen: { adx: a.adx, diPlus: a.diPlus, diMinus: a.diMinus } };
    }
    case "obv":
      if (!hatVolumen(kerzen)) {
        return {
          ...kopf,
          reihen: {},
          hinweis: "Yahoo liefert für diesen Wert kein Volumen.",
        };
      }
      return { ...kopf, reihen: { wert: obv(kerzen) } };
  }
}

// ------------------------------------------------------------------------------ Kennzahlen

export interface Kennzahlen {
  /** Veränderung in Prozent über die Spanne, vom letzten Schluss davor bis zum Kurs. */
  performance: { spanne: string; prozent: number | null }[];
  /** ATR 14 auf Tageskerzen — die durchschnittliche Tagesspanne, wie in der CRV-Rechnung. */
  atrTag: number | null;
  /** Durchschnittliches Tagesvolumen der letzten 30 Handelstage, wenn es Volumen gibt. */
  volumenSchnitt30: number | null;
  /** Hoch und Tief seit Jahresbeginn. */
  jahrHoch: number | null;
  jahrTief: number | null;
}

const SPANNEN: { spanne: string; tage?: number; ytd?: true }[] = [
  { spanne: "1W", tage: 7 },
  { spanne: "1M", tage: 30 },
  { spanne: "3M", tage: 91 },
  { spanne: "6M", tage: 182 },
  { spanne: "YTD", ytd: true },
  { spanne: "1J", tage: 365 },
  { spanne: "5J", tage: 1826 },
];

/** Der letzte Schluss an oder vor `zeit` — die Kerze, gegen die gerechnet wird. */
function schlussVor(kerzen: readonly MarketCandle[], zeit: number): number | null {
  let lo = 0;
  let hi = kerzen.length - 1;
  let treffer = -1;
  while (lo <= hi) {
    const mitte = (lo + hi) >> 1;
    if (kerzen[mitte].time <= zeit) {
      treffer = mitte;
      lo = mitte + 1;
    } else {
      hi = mitte - 1;
    }
  }
  return treffer >= 0 ? kerzen[treffer].close : null;
}

/**
 * Die Kennzahlen neben dem Chart, aus Tageskerzen gerechnet. Die Performance-Spannen sind
 * Kalenderspannen wie bei TradingView: „1M" heißt vom letzten Schluss vor 30 Tagen bis zum
 * Kurs jetzt. Reicht die Historie nicht so weit, steht dort `null` statt einer Zahl über einen
 * kürzeren Zeitraum.
 */
export function rechneKennzahlen(
  tageskerzen: readonly MarketCandle[],
  kurs: number,
  jetztUnix: number,
  zone = "UTC",
): Kennzahlen {
  const erste = tageskerzen[0]?.time ?? Number.POSITIVE_INFINITY;
  const jahr = ortszeit(jetztUnix, zone).tag.slice(0, 4);
  const imJahr = tageskerzen.filter((k) => ortszeit(k.time, zone).tag.slice(0, 4) === jahr);
  const vorJahr = imJahr.length > 0 ? imJahr[0].time - 1 : jetztUnix;

  const performance = SPANNEN.map(({ spanne, tage, ytd }) => {
    const ziel = ytd ? vorJahr : jetztUnix - (tage ?? 0) * 86_400;
    if (ziel < erste) return { spanne, prozent: null };
    const basis = schlussVor(tageskerzen, ziel);
    return {
      spanne,
      prozent: basis !== null && basis !== 0 ? ((kurs - basis) / basis) * 100 : null,
    };
  });

  const atr = atrReihe(tageskerzen, 14);
  const letzteAtr = atr.length > 0 ? atr[atr.length - 1] : undefined;
  const letzte30 = tageskerzen.slice(-30).map((k) => k.volume ?? 0);
  const mitVolumen = letzte30.filter((v) => v > 0);

  return {
    performance,
    atrTag: letzteAtr ?? null,
    volumenSchnitt30:
      mitVolumen.length >= 10 ? mitVolumen.reduce((a, b) => a + b, 0) / mitVolumen.length : null,
    jahrHoch: imJahr.length > 0 ? Math.max(...imJahr.map((k) => k.high)) : null,
    jahrTief: imJahr.length > 0 ? Math.min(...imJahr.map((k) => k.low)) : null,
  };
}

// ------------------------------------------------------------------------------ Der Speicher

/** Eine Kerze auf dem Draht: `[zeit, eröffnung, hoch, tief, schluss, volumen?]`. */
export type Drahtkerze =
  | [number, number, number, number, number]
  | [number, number, number, number, number, number];

export function aufDraht(k: MarketCandle): Drahtkerze {
  return k.volume !== undefined
    ? [k.time, k.open, k.high, k.low, k.close, k.volume]
    : [k.time, k.open, k.high, k.low, k.close];
}

export type Kurskopf = Omit<MarketChart, "candles" | "spark" | "range" | "interval">;

export interface ChartAntwort extends Kurskopf {
  intervall: IntervallId;
  quelle: string;
  kerzen: Drahtkerze[];
  /** Gibt es vor der ersten gelieferten Kerze noch ältere? */
  mehr: boolean;
  /** Wie weit diese Kerzengröße beim Anbieter zurückreicht, in Tagen (`null`: alles). */
  historieTage: number | null;
  hatVolumen: boolean;
  indikatoren: {
    id: string;
    art: IndikatorArt;
    parameter: number[];
    reihen: Record<string, (number | null)[]>;
    hinweis?: string;
  }[];
}

export interface ChartAnfrage {
  symbol: string;
  intervall: IntervallId;
  indikatoren?: IndikatorWunsch[];
  /** Nur Kerzen **ab** diesem Zeitpunkt (einschließlich) — für die Aktualisierung. */
  ab?: number;
  /** Nur Kerzen **vor** diesem Zeitpunkt — zum Nachladen nach links. */
  bis?: number;
  /** Wie viele Kerzen höchstens, gezählt vom Ende. Vorgabe 1.500. */
  anzahl?: number;
}

interface Eintrag {
  roh: MarketCandle[];
  kopf: Kurskopf;
  geholtVoll: number;
  geholtNeu: number;
}

export interface Chartdaten {
  lade(anfrage: ChartAnfrage): Promise<ChartAntwort>;
  kennzahlen(symbol: string): Promise<{ kopf: Kurskopf; kennzahlen: Kennzahlen }>;
}

function kopfAus(chart: MarketChart): Kurskopf {
  const { candles: _c, spark: _s, range: _r, interval: _i, ...kopf } = chart;
  return kopf;
}

export interface ChartdatenDeps {
  markets: MarketsClient;
  jetzt?: () => number;
}

const MAX_EINTRAEGE = 120;

export function createChartdaten(deps: ChartdatenDeps): Chartdaten {
  const jetzt = deps.jetzt ?? (() => Math.floor(Date.now() / 1000));
  const speicher = new Map<string, Eintrag>();
  const unterwegs = new Map<string, Promise<Eintrag>>();

  async function hole(symbol: string, def: IntervallDef): Promise<Eintrag> {
    const schluessel = `${symbol.toUpperCase()}|${def.yahoo}`;
    const t = jetzt();
    const alt = speicher.get(schluessel);
    if (alt && t - alt.geholtNeu < def.frischeSek) return alt;
    const laufend = unterwegs.get(schluessel);
    if (laufend) return laufend;

    const auftrag = (async (): Promise<Eintrag> => {
      const bis = t + 60;
      if (alt && t - alt.geholtVoll < def.vollSek) {
        // Nur das Ende nachholen. Die Historie davor ändert sich nicht jede Minute, und sie
        // jedes Mal ganz zu holen hieße bei Bitcoin in 5-Minuten-Kerzen 17.000 Kerzen alle
        // fünfzehn Sekunden.
        const neu = await deps.markets.zeitraum(symbol, t - def.neuTage * 86_400, bis, def.yahoo);
        const eintrag: Eintrag = {
          roh: fuegeAn(alt.roh, neu.candles),
          kopf: kopfAus(neu),
          geholtVoll: alt.geholtVoll,
          geholtNeu: t,
        };
        speicher.set(schluessel, eintrag);
        return eintrag;
      }
      const von = def.historieTage === null ? 0 : t - def.historieTage * 86_400;
      const voll = await deps.markets.zeitraum(symbol, von, bis, def.yahoo);
      const eintrag: Eintrag = {
        roh: voll.candles,
        kopf: kopfAus(voll),
        geholtVoll: t,
        geholtNeu: t,
      };
      if (speicher.size >= MAX_EINTRAEGE) {
        const aeltester = speicher.keys().next().value;
        if (aeltester !== undefined) speicher.delete(aeltester);
      }
      speicher.delete(schluessel);
      speicher.set(schluessel, eintrag);
      return eintrag;
    })();
    unterwegs.set(schluessel, auftrag);
    try {
      return await auftrag;
    } finally {
      unterwegs.delete(schluessel);
    }
  }

  return {
    async lade(anfrage) {
      const def = INTERVALLE[anfrage.intervall];
      const eintrag = await hole(anfrage.symbol, def);
      const zone = eintrag.kopf.zeitzone ?? "UTC";
      const kerzen = def.verdichten ? verdichte(eintrag.roh, def.sekunden, zone) : eintrag.roh;

      let von = 0;
      let bisIndex = kerzen.length;
      if (anfrage.ab !== undefined) {
        von = kerzen.findIndex((k) => k.time >= (anfrage.ab as number));
        if (von < 0) von = kerzen.length;
        // Mehr als ein Tag an neuen Kerzen ist keine Aktualisierung mehr.
        von = Math.max(von, kerzen.length - 500);
      } else {
        if (anfrage.bis !== undefined) {
          const i = kerzen.findIndex((k) => k.time >= (anfrage.bis as number));
          bisIndex = i < 0 ? kerzen.length : i;
        }
        const anzahl = Math.min(Math.max(anfrage.anzahl ?? 1500, 50), 5000);
        von = Math.max(0, bisIndex - anzahl);
      }
      const ausschnitt = kerzen.slice(von, bisIndex);
      const intraday = def.sekunden < 86_400;

      const indikatoren = (anfrage.indikatoren ?? []).map((w) => {
        const e = rechneIndikator(w, kerzen, { intraday, zone });
        const reihen: Record<string, (number | null)[]> = {};
        for (const [name, reihe] of Object.entries(e.reihen)) {
          reihen[name] = reihe.slice(von, bisIndex).map((x) => (x === undefined ? null : x));
        }
        return { ...e, reihen };
      });

      return {
        ...eintrag.kopf,
        intervall: anfrage.intervall,
        quelle: "Yahoo Finance",
        kerzen: ausschnitt.map(aufDraht),
        mehr: von > 0,
        historieTage: def.historieTage,
        hatVolumen: hatVolumen(kerzen),
        indikatoren,
      };
    },

    async kennzahlen(symbol) {
      const eintrag = await hole(symbol, INTERVALLE["1d"]);
      if (eintrag.roh.length === 0) {
        throw new MarketDataError(`Keine Tageskerzen für ${symbol}.`);
      }
      return {
        kopf: eintrag.kopf,
        kennzahlen: rechneKennzahlen(
          eintrag.roh,
          eintrag.kopf.price,
          jetzt(),
          eintrag.kopf.zeitzone ?? "UTC",
        ),
      };
    },
  };
}
