/**
 * Die Indikatoren des Charts, wie die Oberfläche sie anbietet. Gerechnet wird im Gateway mit
 * denselben Funktionen wie am Handelstisch (`gateway/indikatoren.ts`); hier stehen nur Namen,
 * Vorgaben, Farben und wohin eine Reihe gehört — in den Kurs oder in ein eigenes Fenster.
 */

export type IndikatorArt =
  | "sma"
  | "ema"
  | "bb"
  | "vwap"
  | "rsi"
  | "macd"
  | "stoch"
  | "atr"
  | "adx"
  | "obv";

export interface IndikatorDef {
  art: IndikatorArt;
  name: string;
  kurz: string;
  parameter: { name: string; vorgabe: number; schritt?: number }[];
  /** `kurs`: über die Kerzen gelegt. `fenster`: ein eigenes Fenster unter dem Chart. */
  ort: "kurs" | "fenster";
  /** Waagrechte Hilfslinien im Fenster, z. B. 30 und 70 beim RSI. */
  linien?: number[];
  erklaerung: string;
}

export const INDIKATOREN: readonly IndikatorDef[] = [
  {
    art: "sma",
    name: "Gleitender Durchschnitt (SMA)",
    kurz: "SMA",
    parameter: [{ name: "Periode", vorgabe: 20 }],
    ort: "kurs",
    erklaerung:
      "Der Durchschnitt der letzten Schlusskurse. 200 für den großen Trend, 20/50 für Swings.",
  },
  {
    art: "ema",
    name: "Exponentieller Durchschnitt (EMA)",
    kurz: "EMA",
    parameter: [{ name: "Periode", vorgabe: 50 }],
    ort: "kurs",
    erklaerung: "Wie der SMA, gewichtet die jüngsten Kurse aber stärker und folgt schneller.",
  },
  {
    art: "bb",
    name: "Bollinger-Bänder",
    kurz: "BB",
    parameter: [
      { name: "Periode", vorgabe: 20 },
      { name: "Faktor", vorgabe: 2, schritt: 0.1 },
    ],
    ort: "kurs",
    erklaerung:
      "SMA mit Bändern im Abstand der Standardabweichung — eng heißt ruhig, weit heißt bewegt.",
  },
  {
    art: "vwap",
    name: "VWAP",
    kurz: "VWAP",
    parameter: [{ name: "Band-Faktor", vorgabe: 1, schritt: 0.1 }],
    ort: "kurs",
    erklaerung:
      "Der volumengewichtete Durchschnittspreis des Handelstags. Braucht Volumen und Kerzen unter einem Tag.",
  },
  {
    art: "rsi",
    name: "Relative Stärke (RSI)",
    kurz: "RSI",
    parameter: [{ name: "Periode", vorgabe: 14 }],
    ort: "fenster",
    linien: [30, 70],
    erklaerung:
      "Schwung zwischen 0 und 100; über 70 gilt als überkauft, unter 30 als überverkauft.",
  },
  {
    art: "macd",
    name: "MACD",
    kurz: "MACD",
    parameter: [
      { name: "Schnell", vorgabe: 12 },
      { name: "Langsam", vorgabe: 26 },
      { name: "Signal", vorgabe: 9 },
    ],
    ort: "fenster",
    linien: [0],
    erklaerung:
      "Abstand zweier EMAs mit Signallinie; das Histogramm zeigt, ob der Schwung zu- oder abnimmt.",
  },
  {
    art: "stoch",
    name: "Stochastik",
    kurz: "Stoch",
    parameter: [
      { name: "Periode", vorgabe: 14 },
      { name: "%K-Glättung", vorgabe: 3 },
      { name: "%D", vorgabe: 3 },
    ],
    ort: "fenster",
    linien: [20, 80],
    erklaerung: "Wo der Schluss in der Spanne der letzten Kerzen liegt, 0 bis 100.",
  },
  {
    art: "atr",
    name: "Average True Range (ATR)",
    kurz: "ATR",
    parameter: [{ name: "Periode", vorgabe: 14 }],
    ort: "fenster",
    erklaerung:
      "Die durchschnittliche Spanne je Kerze — dieselbe Zahl, an der der Handelstisch Stops misst.",
  },
  {
    art: "adx",
    name: "ADX",
    kurz: "ADX",
    parameter: [{ name: "Periode", vorgabe: 14 }],
    ort: "fenster",
    linien: [20, 25],
    erklaerung:
      "Wie stark ein Trend ist, unabhängig von der Richtung; +DI/−DI zeigen die Richtung.",
  },
  {
    art: "obv",
    name: "On-Balance-Volumen",
    kurz: "OBV",
    parameter: [],
    ort: "fenster",
    erklaerung: "Aufsummiertes Volumen: steigt an Tagen mit höherem Schluss, fällt an den anderen.",
  },
];

export function indikatorDef(art: string): IndikatorDef | undefined {
  return INDIKATOREN.find((d) => d.art === art);
}

export interface AktiverIndikator {
  art: IndikatorArt;
  parameter: number[];
}

/** Die Kennung, unter der das Gateway die Reihen liefert: `sma:20`, `bb:20:2`, `obv`. */
export function indikatorId(i: AktiverIndikator): string {
  return [i.art, ...i.parameter].join(":");
}

/** `sma:200` → `{ art: "sma", parameter: [200] }`, ergänzt um Vorgaben. `null` bei Unbekanntem. */
export function ausId(id: string): AktiverIndikator | null {
  const [art, ...rest] = id.split(":");
  const def = indikatorDef(art ?? "");
  if (!def) return null;
  const parameter = def.parameter.map((p, i) => {
    const n = Number(rest[i]);
    return Number.isFinite(n) && n > 0 ? n : p.vorgabe;
  });
  return { art: def.art, parameter };
}

/** Die Anfrage an das Gateway: jede Kennung einmal, in fester Reihenfolge. */
export function anfrageFuer(aktive: readonly AktiverIndikator[]): string {
  return [...new Set(aktive.map(indikatorId))].join(",");
}

/** Die Aufschrift in der Legende: „SMA 20", „BB 20 2", „MACD 12 26 9". */
export function beschriftung(i: AktiverIndikator): string {
  const def = indikatorDef(i.art);
  return [def?.kurz ?? i.art, ...i.parameter.map((p) => p.toLocaleString("de-DE"))].join(" ");
}

/**
 * Farben: ruhig und voneinander unterscheidbar auf dem dunklen Grund, keine davon grün oder
 * rot — die gehören den Kerzen. Mehrere Durchschnitte bekommen der Reihe nach die nächste.
 */
export const FARBEN = [
  "#e3b56b",
  "#7fb2e5",
  "#c39be0",
  "#6fd1c3",
  "#e6947a",
  "#b8c27a",
  "#e88fb7",
] as const;

export function farbeFuer(position: number): string {
  return FARBEN[position % FARBEN.length] as string;
}

/** Welche Reihen eines Indikators wie gezeichnet werden. */
export interface ReihenStil {
  name: string;
  art: "linie" | "saeulen";
  farbe: string;
  breite: number;
  gestrichelt?: boolean;
}

export function reihenStile(art: IndikatorArt, farbe: string): ReihenStil[] {
  switch (art) {
    case "bb":
      return [
        { name: "mitte", art: "linie", farbe, breite: 1, gestrichelt: true },
        { name: "oben", art: "linie", farbe, breite: 1 },
        { name: "unten", art: "linie", farbe, breite: 1 },
      ];
    case "vwap":
      return [
        { name: "vwap", art: "linie", farbe, breite: 2 },
        { name: "oben", art: "linie", farbe, breite: 1, gestrichelt: true },
        { name: "unten", art: "linie", farbe, breite: 1, gestrichelt: true },
      ];
    case "macd":
      return [
        { name: "histogramm", art: "saeulen", farbe, breite: 1 },
        { name: "macd", art: "linie", farbe: "#7fb2e5", breite: 1.5 },
        { name: "signal", art: "linie", farbe: "#e3a86b", breite: 1.5 },
      ];
    case "stoch":
      return [
        { name: "k", art: "linie", farbe: "#7fb2e5", breite: 1.5 },
        { name: "d", art: "linie", farbe: "#e3a86b", breite: 1.5 },
      ];
    case "adx":
      return [
        { name: "adx", art: "linie", farbe, breite: 2 },
        { name: "diPlus", art: "linie", farbe: "#5fc98c", breite: 1 },
        { name: "diMinus", art: "linie", farbe: "#e0787f", breite: 1 },
      ];
    default:
      return [
        { name: "wert", art: "linie", farbe, breite: art === "sma" || art === "ema" ? 1.5 : 1.5 },
      ];
  }
}
