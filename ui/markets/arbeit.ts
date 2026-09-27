import { FARBE, type Form, positionsFormen } from "./formen.js";

/**
 * „Kuros Arbeit" im Chart (2026-09-27): was das Haus zu einem Wert erarbeitet hat, auf den
 * Kerzen statt im Fließtext. Zwei Quellen, beide gerechnet:
 *
 *  * **Einzelideen** aus dem Prognosebuch — von boerse oder von Jakob selbst. Der Stand
 *    (wartet, offen, Ziel, Stop …) kommt aus den Kerzen (`gateway/prognosen.ts`), nicht aus
 *    einer Einschätzung.
 *  * **Strategien** aus dem Archiv — ihre Handel, neu gerechnet mit derselben Funktion, die die
 *    Kennzahlen erzeugt hat (`gateway/strategie-chart.ts`). Was nach der Ablage kam, ist als
 *    „ungesehen" gekennzeichnet: das ist die Probe, die beim Bau niemand kennen konnte.
 */

export type PrognoseStand = "wartet" | "offen" | "ziel" | "stop" | "verfallen" | "unaufgeloest";

export interface PrognoseMitStand {
  prognose: {
    id: string;
    angelegt: string;
    von: string;
    symbol: string;
    richtung: "long" | "short";
    ausloeser: number;
    fristTage: number;
    stop: number;
    ziele: number[];
    these?: string;
    widerlegtWenn?: string;
    analyseId?: string;
  };
  verlauf: {
    stand: PrognoseStand;
    ausloeserAm: number | null;
    einstieg: number | null;
    ausstiegAm: number | null;
    ausstieg: number | null;
    r: number | null;
    haltedauerTage: number | null;
  } | null;
  fehler?: string;
}

export interface StrategieHandel {
  einstiegZeit: number;
  ausstiegZeit: number;
  einstieg: number;
  ausstieg: number;
  stop: number;
  ziel: number | null;
  grund: "stop" | "ziel" | "regel" | "zeit" | "fenster" | "ende";
  r: number;
  nachAblage: boolean;
}

export interface StrategieImChart {
  id: string;
  name: string;
  symbol: string;
  intervall: string;
  richtung: "long" | "short";
  status: string;
  von: number;
  bis: number;
  teilung: number | null;
  handel: StrategieHandel[];
  kennzahlenArchiv: {
    anzahl: number;
    trefferquote: number;
    erwartungswertR: number;
    sharpe: number;
  } | null;
  imPruefzeitraum: number;
  seitAblage: { anzahl: number; summeR: number; trefferquote: number | null };
  abweichung?: string;
  signalLetzteKerze: boolean;
  indikatoren: string[];
  regel: string[];
  papier: {
    seit: string;
    handel: {
      einstiegZeit: number;
      ausstiegZeit: number;
      einstieg: number;
      ausstieg: number;
      r: number;
    }[];
  } | null;
}

export interface ArbeitUebersicht {
  strategien: {
    id: string;
    name: string;
    intervall: string;
    status: string;
    von: string;
    bis: string;
    kennzahlen: { anzahl: number; erwartungswertR: number } | null;
  }[];
  analysen: {
    id: string;
    zeit: string;
    titel: string;
    wer: string;
    hatIdee: boolean;
    status: string;
  }[];
  papier: {
    strategieId: string;
    name: string;
    seit: string;
    handel: number;
    offen: boolean;
    gesperrt: boolean;
  }[];
}

export const STAND_WORT: Record<PrognoseStand, string> = {
  wartet: "wartet auf Auslöser",
  offen: "offen",
  ziel: "Ziel erreicht",
  stop: "ausgestoppt",
  verfallen: "nie ausgelöst",
  unaufgeloest: "ohne Ausgang",
};

export function wer(von: string): string {
  if (von === "jakob") return "deine Idee";
  if (von === "boerse") return "Börse";
  return von;
}

function rText(r: number): string {
  return `${r >= 0 ? "+" : "−"}${Math.abs(r).toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 2 })} R`;
}

/**
 * Eine Idee aus dem Prognosebuch als Kasten. Er reicht von der Ablage bis zum Ausgang — oder,
 * solange sie läuft, bis jetzt, und solange sie wartet, bis zum Ende ihrer Frist.
 */
export function prognoseFormen(e: PrognoseMitStand, jetztUnix: number, stellen = 2): Form[] {
  const p = e.prognose;
  const von = Math.floor(Date.parse(p.angelegt) / 1000);
  const v = e.verlauf;
  const frist = von + p.fristTage * 86_400;
  const bis =
    v?.ausstiegAm ??
    (v?.stand === "wartet"
      ? Math.max(frist, jetztUnix)
      : v?.stand === "verfallen"
        ? frist
        : jetztUnix);
  const stand = v ? STAND_WORT[v.stand] : "Stand nicht gerechnet";
  const titel = `${wer(p.von)} · ${stand}${v?.r !== null && v?.r !== undefined ? ` · ${rText(v.r)}` : ""}`;
  const formen = positionsFormen({
    richtung: p.richtung,
    von,
    bis,
    einstieg: p.ausloeser,
    stop: p.stop,
    ziele: p.ziele,
    stellen,
    titel,
    farbeTitel:
      v?.stand === "ziel" ? FARBE.gewinnRand : v?.stand === "stop" ? FARBE.verlustRand : FARBE.kuro,
  });
  if (v?.ausloeserAm && v.einstieg !== null) {
    formen.push({
      typ: "griff",
      punkt: { zeit: v.ausloeserAm, preis: v.einstieg },
      farbe: FARBE.kuro,
    });
  }
  if (v?.ausstiegAm && v.ausstieg !== null && v.ausloeserAm && v.einstieg !== null) {
    formen.push({
      typ: "strecke",
      a: { zeit: v.ausloeserAm, preis: v.einstieg },
      b: { zeit: v.ausstiegAm, preis: v.ausstieg },
      farbe: FARBE.kuro,
      breite: 1.5,
      strich: [5, 4],
    });
  }
  return formen;
}

export interface Marke {
  time: number;
  position: "aboveBar" | "belowBar";
  shape: "arrowUp" | "arrowDown" | "circle";
  color: string;
  text: string;
}

/**
 * Die Handel einer Strategie: Einstieg als Pfeil, Ausstieg als Punkt mit dem Ergebnis in R,
 * dazwischen eine Strecke, und Stop und Ziel als kurze Linien über die Dauer. Dazu die zwei
 * Grenzen, an denen man eine Strategie misst — ab wann der Backtest „ungesehen" rechnete und
 * ab wann sie im Archiv lag.
 */
export function strategieFormen(s: StrategieImChart): { formen: Form[]; marken: Marke[] } {
  const formen: Form[] = [];
  const marken: Marke[] = [];
  const long = s.richtung === "long";
  for (const h of s.handel) {
    const offen = h.grund === "ende";
    const farbe = offen ? FARBE.kuro : h.r >= 0 ? FARBE.gewinnRand : FARBE.verlustRand;
    formen.push({
      typ: "hlinie",
      preis: h.stop,
      farbe: FARBE.verlustRand,
      breite: 1,
      strich: [2, 3],
      vonZeit: h.einstiegZeit,
      bisZeit: h.ausstiegZeit,
    });
    if (h.ziel !== null) {
      formen.push({
        typ: "hlinie",
        preis: h.ziel,
        farbe: FARBE.gewinnRand,
        breite: 1,
        strich: [2, 3],
        vonZeit: h.einstiegZeit,
        bisZeit: h.ausstiegZeit,
      });
    }
    formen.push({
      typ: "strecke",
      a: { zeit: h.einstiegZeit, preis: h.einstieg },
      b: { zeit: h.ausstiegZeit, preis: h.ausstieg },
      farbe,
      breite: h.nachAblage ? 2 : 1.5,
      ...(offen ? { strich: [5, 4] } : {}),
    });
    marken.push({
      time: h.einstiegZeit,
      position: long ? "belowBar" : "aboveBar",
      shape: long ? "arrowUp" : "arrowDown",
      color: h.nachAblage ? FARBE.kuro : "#9fb6cc",
      text: h.nachAblage ? "ungesehen" : "",
    });
    marken.push({
      time: h.ausstiegZeit,
      position: long ? "aboveBar" : "belowBar",
      shape: "circle",
      color: farbe,
      text: offen ? "offen" : rText(h.r),
    });
  }
  for (const h of s.papier?.handel ?? []) {
    marken.push({
      time: h.ausstiegZeit,
      position: long ? "aboveBar" : "belowBar",
      shape: "circle",
      color: FARBE.kuro,
      text: `Papier ${rText(h.r)}`,
    });
  }
  if (s.teilung !== null) {
    formen.push({
      typ: "vlinie",
      zeit: s.teilung,
      farbe: FARBE.leise,
      text: "ab hier ungesehen im Backtest",
      strich: [4, 4],
      zeile: 1,
    });
  }
  formen.push({
    typ: "vlinie",
    zeit: s.bis,
    farbe: FARBE.kuro,
    text: "abgelegt — danach echte Zukunft",
    strich: [6, 4],
  });
  // Die Marken des Charts müssen zeitlich sortiert sein, sonst verweigert er sie.
  marken.sort((a, b) => a.time - b.time);
  return { formen, marken };
}

/** Die Kurzzeile unter dem Namen einer Strategie. */
export function strategieZeile(s: StrategieImChart): string {
  const k = s.kennzahlenArchiv;
  const teile = [
    k ? `${k.anzahl} Handel` : `${s.imPruefzeitraum} Handel`,
    k ? `Erwartungswert ${rText(k.erwartungswertR)}` : "",
    k ? `Treffer ${Math.round(k.trefferquote * 100)} %` : "",
  ].filter(Boolean);
  const seit =
    s.seitAblage.anzahl > 0
      ? `seit der Ablage ${s.seitAblage.anzahl} Handel, zusammen ${rText(s.seitAblage.summeR)}`
      : "seit der Ablage noch kein Handel";
  return `${teile.join(" · ")} — ${seit}`;
}
