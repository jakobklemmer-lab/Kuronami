import type { IntervallId } from "./intervalle.js";

/**
 * Die Formen, die `/integrations/markets/kerzen` und `/kennzahlen` liefern (`gateway/
 * chartdaten.ts`), und was die Oberfläche daraus rechnet, ohne das Gateway zu fragen.
 */

export interface Kerze {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export type Drahtkerze =
  | [number, number, number, number, number]
  | [number, number, number, number, number, number];

export interface Kurskopf {
  symbol: string;
  name: string;
  currency: string;
  exchange: string;
  price: number;
  change: number;
  changePct: number;
  weekHigh52?: number;
  weekLow52?: number;
  typ?: string;
  zeitzone?: string;
  sitzung?: { start: number; ende: number };
  kursZeit?: number;
  tagHoch?: number;
  tagTief?: number;
  tagVolumen?: number;
  vortag?: number;
  stellen?: number;
}

export interface IndikatorAntwort {
  id: string;
  art: string;
  parameter: number[];
  reihen: Record<string, (number | null)[]>;
  hinweis?: string;
}

export interface KerzenAntwort extends Kurskopf {
  intervall: IntervallId;
  quelle: string;
  kerzen: Drahtkerze[];
  mehr: boolean;
  historieTage: number | null;
  hatVolumen: boolean;
  indikatoren: IndikatorAntwort[];
}

export interface KennzahlenAntwort {
  kopf: Kurskopf;
  kennzahlen: {
    performance: { spanne: string; prozent: number | null }[];
    atrTag: number | null;
    volumenSchnitt30: number | null;
    jahrHoch: number | null;
    jahrTief: number | null;
  };
}

export function ausDraht(draht: readonly Drahtkerze[]): Kerze[] {
  return draht.map((d) => ({
    time: d[0],
    open: d[1],
    high: d[2],
    low: d[3],
    close: d[4],
    ...(d.length > 5 ? { volume: d[5] as number } : {}),
  }));
}

/**
 * Heikin-Ashi: geglättete Kerzen, in denen ein Trend als Folge gleichfarbiger Körper steht.
 * Eröffnung = Mitte der vorigen HA-Kerze, Schluss = Mittel aus O, H, T, S. **Die Werte sind
 * keine Kurse** — die Legende nennt deshalb immer auch den echten Schluss.
 */
export function heikinAshi(kerzen: readonly Kerze[]): Kerze[] {
  const raus: Kerze[] = [];
  for (let i = 0; i < kerzen.length; i += 1) {
    const k = kerzen[i];
    const schluss = (k.open + k.high + k.low + k.close) / 4;
    const vorige = raus[i - 1];
    const eroeffnung = vorige ? (vorige.open + vorige.close) / 2 : (k.open + k.close) / 2;
    raus.push({
      time: k.time,
      open: eroeffnung,
      close: schluss,
      high: Math.max(k.high, eroeffnung, schluss),
      low: Math.min(k.low, eroeffnung, schluss),
      ...(k.volume !== undefined ? { volume: k.volume } : {}),
    });
  }
  return raus;
}

/**
 * Eine Aktualisierung einfügen: ab ihrer ersten Kerze gilt das Neue. Liefert außerdem, ab
 * welcher Stelle sich etwas geändert hat — der Chart braucht dann nur dort `update`.
 */
export function vereine(
  alt: readonly Kerze[],
  neu: readonly Kerze[],
): { kerzen: Kerze[]; ab: number } {
  if (neu.length === 0) return { kerzen: [...alt], ab: alt.length };
  const erste = neu[0].time;
  let ab = alt.length;
  while (ab > 0 && alt[ab - 1].time >= erste) ab -= 1;
  return { kerzen: [...alt.slice(0, ab), ...neu], ab };
}

/** Ältere Kerzen vorn anfügen, ohne eine doppelt zu führen. */
export function voranstellen(aelter: readonly Kerze[], alt: readonly Kerze[]): Kerze[] {
  if (alt.length === 0) return [...aelter];
  const erste = alt[0].time;
  return [...aelter.filter((k) => k.time < erste), ...alt];
}

export interface MarktLage {
  offen: boolean;
  text: string;
}

function uhrzeit(unix: number): string {
  return new Date(unix * 1000).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Ist der Markt offen? Aus der Sitzung, die Yahoo mitliefert — in Ortszeit gesagt. Krypto
 * handelt immer, Devisen von Sonntagabend bis Freitagabend; beides steht so da.
 */
export function marktLage(kopf: Pick<Kurskopf, "typ" | "sitzung">, jetztUnix: number): MarktLage {
  if (kopf.typ === "CRYPTOCURRENCY") return { offen: true, text: "Handel rund um die Uhr" };
  const s = kopf.sitzung;
  if (!s) return { offen: false, text: "" };
  if (jetztUnix >= s.start && jetztUnix < s.ende) {
    return { offen: true, text: `Handel offen · bis ${uhrzeit(s.ende)} Uhr` };
  }
  if (jetztUnix < s.start) {
    const heute =
      new Date(jetztUnix * 1000).toDateString() === new Date(s.start * 1000).toDateString();
    return {
      offen: false,
      text: heute
        ? `Geschlossen · öffnet ${uhrzeit(s.start)} Uhr`
        : `Geschlossen · öffnet ${new Date(s.start * 1000).toLocaleDateString("de-DE", { weekday: "short" })} ${uhrzeit(s.start)} Uhr`,
    };
  }
  return { offen: false, text: "Geschlossen" };
}

/** „1,2 Mio.", „845.300", „3,4 Mrd." */
export function formatVolumen(wert: number): string {
  const betrag = Math.abs(wert);
  if (betrag >= 1e9)
    return `${(wert / 1e9).toLocaleString("de-DE", { maximumFractionDigits: 2 })} Mrd.`;
  if (betrag >= 1e6)
    return `${(wert / 1e6).toLocaleString("de-DE", { maximumFractionDigits: 2 })} Mio.`;
  return Math.round(wert).toLocaleString("de-DE");
}

/**
 * Nachkommastellen für einen Wert: was der Handelsplatz nennt (`stellen`, bei Devisen vier bis
 * fünf), sonst dieselbe Regel wie in der Liste.
 */
export function stellenFuer(preis: number, stellen?: number): number {
  if (stellen !== undefined && stellen >= 0 && stellen <= 8)
    return Math.max(stellen, preis < 1 ? 4 : 2);
  const betrag = Math.abs(preis);
  if (betrag >= 10) return 2;
  if (betrag >= 1) return 4;
  return 6;
}

export function formatKurs(preis: number, stellen: number): string {
  return preis.toLocaleString("de-DE", {
    minimumFractionDigits: stellen,
    maximumFractionDigits: stellen,
  });
}
