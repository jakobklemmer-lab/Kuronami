import type { Handel, Indikator, Strategie } from "./backtest.js";
import { type Konfidenz, konfidenz } from "./konfidenz.js";

/**
 * Die Kalibrierung (N9, 2026-09-28): stimmt unser Werkzeug mit dem überein, was eine Quelle
 * lehrt — und wo wichen die Agenten davon ab?
 *
 * Anlass: Am 27.09. hat der Handelstisch Regeln verworfen, die er selbst erfunden hatte, und
 * das Original nie gerechnet. Hier stehen die Regeln der drei ältesten TradingLab-Videos, mit
 * denen Jakob gelernt hat, **so wörtlich, wie das Transkript es hergibt** — je Regel mit
 * Zeitmarke, und alles, was das Transkript offenlässt, als Annahme. Die Regeln sind in eigenen
 * Worten wiedergegeben; das Transkript selbst liegt nur im Arbeitsverzeichnis
 * (`wissen/tradinglab/roh/`), nicht im Quellbaum.
 *
 * Gerechnet wird mit `backtest.ts` wie jede andere Regel: Signal auf der abgeschlossenen
 * Kerze, Einstieg zur nächsten Eröffnung, Stop vor Ziel, Kosten immer dabei. Das Skript dazu
 * ist `bau/kalibrierung-n9.ts`.
 */

export interface Beleg {
  /** Zeitmarke im Video, `mm:ss` oder `mm:ss–mm:ss`. */
  zeit: string;
  /** Was dort gesagt wird, in eigenen Worten. */
  regel: string;
}

export interface Quellregel {
  /** YouTube-Kennung. */
  video: string;
  titel: string;
  /** Was die Quelle selbst über den Erfolg sagt — eine Behauptung, kein Beleg. */
  behauptung: string;
  /** Die Regel je Richtung bzw. Zweig, jede für sich rechenbar. */
  teile: { teil: string; strategie: Strategie }[];
  belege: Beleg[];
  annahmen: string[];
  /** Was im Video steht, sich aber nicht wörtlich rechnen lässt — mit dem fehlenden Baustein. */
  nichtPruefbar: string[];
}

const ema = (periode: number): Indikator => ({ art: "ema", periode });
const sma = (periode: number): Indikator => ({ art: "sma", periode });
const wert = (w: number): Indikator => ({ art: "wert", wert: w });
const KURS: Indikator = { art: "kurs" };
const MACD: Indikator = { art: "macd", periode: 12, periode2: 26, periode3: 9 };
const SIGNAL: Indikator = { art: "macd_signal", periode: 12, periode2: 26, periode3: 9 };

/** BEST MACD Trading Strategy [86% Win Rate] — `rf_EQvubKlk`. */
function macdOriginal(trend: Indikator): Quellregel["teile"] {
  return [
    {
      teil: "long",
      strategie: {
        name: "TradingLab · BEST MACD (Original, long)",
        richtung: "long",
        einstieg: [
          { links: MACD, vergleich: "kreuzt_ueber", rechts: SIGNAL },
          { links: MACD, vergleich: "unter", rechts: wert(0) },
          { links: KURS, vergleich: "ueber", rechts: trend },
        ],
        stopAn: trend,
        zielR: 1.5,
      },
    },
    {
      teil: "short",
      strategie: {
        name: "TradingLab · BEST MACD (Original, short)",
        richtung: "short",
        einstieg: [
          { links: MACD, vergleich: "kreuzt_unter", rechts: SIGNAL },
          { links: MACD, vergleich: "ueber", rechts: wert(0) },
          { links: KURS, vergleich: "unter", rechts: trend },
        ],
        stopAn: trend,
        zielR: 1.5,
      },
    },
  ];
}

export const MACD_VIDEO: Quellregel = {
  video: "rf_EQvubKlk",
  titel: "BEST MACD Trading Strategy [86% Win Rate]",
  behauptung:
    '„86 % Win Rate" im Titel; im Video selbst keine Zahl zu Handel, Markt oder Zeitraum, nur „extrem hohe Trefferquote" (06:41).',
  teile: macdOriginal(ema(200)),
  belege: [
    {
      zeit: "00:58–01:16",
      regel: "MACD mit Standardeinstellungen hinzufügen (keine Änderung genannt).",
    },
    {
      zeit: "02:24–02:35",
      regel:
        "Long nur, wenn MACD-Linie und Signallinie nach oben kreuzen — und das unter der Nulllinie; darüber kein Handel.",
    },
    { zeit: "02:35–02:45", regel: "Short nur bei Kreuzung nach unten über der Nulllinie." },
    {
      zeit: "03:19–04:15",
      regel:
        "Nie gegen den Trend: Kurs über dem 200er-Durchschnitt heißt Aufwärtstrend (nur long), darunter Abwärtstrend (nur short).",
    },
    { zeit: "04:18–04:45", regel: "Beides zusammen, Short gespiegelt." },
    { zeit: "04:56–05:03", regel: "Stop unter dem 200er-Durchschnitt — er wirkt wie eine Wand." },
    { zeit: "05:03–05:08", regel: 'Ziel beim 1,5-fachen Risiko („1.5 profit ratio").' },
  ],
  annahmen: [
    "Der 200er-Durchschnitt ist eine EMA 200: der Name des Indikators fällt in eine Lücke des Transkripts (03:36–04:06). Die SMA 200 ist als Gegenprobe gerechnet.",
    '„Unter der Nulllinie kreuzen" heißt: die MACD-Linie liegt auf der Kreuzungskerze unter null (die Signallinie liegt dort praktisch gleichauf).',
    "Der Stop liegt genau auf dem Wert der EMA an der Signalkerze und bleibt dort; das Video nennt keinen Abstand und kein Nachziehen.",
    'Zeitrahmen: nicht genannt; „200 day" spricht für Tageskerzen. Markt: „fast jeder" — gerechnet am S&P 500 wie die Agenten am 21.09., dazu die üblichen weiteren Märkte.',
  ],
  nichtPruefbar: [
    "Stufe 3 (05:48–06:38): nur an einer Unterstützung einsteigen, an der der Kurs schon einmal abgeprallt ist — nicht prüfbar, Baustein fehlt: Unterstützungszone aus einem früheren Abprall.",
  ],
};

/** Die Gegenprobe zur Annahme „EMA": dieselbe Regel mit der SMA 200. */
export const MACD_MIT_SMA = macdOriginal(sma(200)).map((t) => ({
  ...t,
  strategie: { ...t.strategie, name: t.strategie.name.replace("Original", "SMA 200 statt EMA") },
}));

/** Bollinger Band + RSI Trading Strategy That Actually Works — `pCmJ8wsAS_w`. */
const BB_UNTEN: Indikator = { art: "bollinger_unten", periode: 30, faktor: 2 };
const BB_OBEN: Indikator = { art: "bollinger_oben", periode: 30, faktor: 2 };
const BB_MITTE: Indikator = { art: "bollinger_mitte", periode: 30, faktor: 2 };
const RSI13: Indikator = { art: "rsi", periode: 13 };

/**
 * Das Video nennt keinen Stop. 90 % ist die höchste Angabe, die das Werkzeug annimmt, und
 * greift praktisch nie — so wörtlich, wie ein Backtest mit Pflicht-Stop „ohne Stop" rechnen
 * kann. R ist damit Rendite ÷ 90 %; die Kennzahlen in R sind hier nicht mit denen der anderen
 * Videos vergleichbar, Trefferquote und Rendite schon.
 */
export const NOTSTOP_PROZENT = 90;

export const BOLLINGER_VIDEO: Quellregel = {
  video: "pCmJ8wsAS_w",
  titel: "Bollinger Band + RSI Trading Strategy That Actually Works",
  behauptung:
    'Keine Zahl — „ziemlich hohe Erfolgsquote, wenn man sie richtig anwendet" (00:07–00:13).',
  teile: [
    {
      teil: "long",
      strategie: {
        name: "TradingLab · Bollinger + RSI (Original, long)",
        richtung: "long",
        einstieg: [
          { links: KURS, vergleich: "unter", rechts: BB_UNTEN },
          { links: RSI13, vergleich: "unter", rechts: wert(25) },
        ],
        ausstieg: [{ links: KURS, vergleich: "ueber", rechts: BB_MITTE }],
        stopProzent: NOTSTOP_PROZENT,
      },
    },
    {
      teil: "short",
      strategie: {
        name: "TradingLab · Bollinger + RSI (Original, short)",
        richtung: "short",
        einstieg: [
          { links: KURS, vergleich: "ueber", rechts: BB_OBEN },
          { links: RSI13, vergleich: "ueber", rechts: wert(75) },
        ],
        ausstieg: [{ links: KURS, vergleich: "unter", rechts: BB_MITTE }],
        stopProzent: NOTSTOP_PROZENT,
      },
    },
  ],
  belege: [
    { zeit: "00:42–00:51", regel: "Bollinger-Bänder mit Länge 30 und Standardabweichung 2." },
    { zeit: "01:30–01:41", regel: "RSI mit Länge 13 statt 14." },
    {
      zeit: "02:49–02:57",
      regel: "Über dem oberen Band short, unter dem unteren Band long — Rückkehr zum Mittelwert.",
    },
    {
      zeit: "03:20–03:42",
      regel:
        "Nur mit extremem RSI: long unter dem unteren Band und RSI unter 25, short über dem oberen Band und RSI über 75.",
    },
    {
      zeit: "03:58–04:04",
      regel: "Ausstieg, wenn der Kurs zum Durchschnitt (Mittellinie) zurückkehrt.",
    },
  ],
  annahmen: [
    `Einen Stop nennt das Video nicht. Gerechnet „ohne Stop" (Notstop ${NOTSTOP_PROZENT} %, greift praktisch nie); als Gegenprobe mit Stop am Swing-Tief bzw. -Hoch der letzten 5 Kerzen.`,
    "Band und RSI gelten am Schlusskurs derselben Kerze; ausgestiegen wird zum ersten Schluss jenseits der Mittellinie.",
    "Zeitrahmen: nicht genannt, also Tageskerzen. Beispielmarkt im Video ist Apple (03:42); gerechnet am S&P 500 wie die Agenten und an Apple, dazu die üblichen weiteren Märkte.",
    "Unsere Bänder rechnen die Standardabweichung mit n−1, TradingView mit n: bei Länge 30 sind unsere Bänder rund 1,7 % weiter. Eine kleine, bekannte Abweichung des Werkzeugs.",
  ],
  nichtPruefbar: [
    'Seitwärtsfilter (04:17–05:26): bei engen Bändern und zahmem RSI nicht handeln — nicht prüfbar, das Video nennt keine Schwelle für „eng" (der Baustein bollinger_breite wäre da).',
    "Divergenz (05:34–06:03): Kurs macht ein tieferes Tief, der RSI ein höheres — nicht prüfbar, Baustein fehlt: Divergenz zwischen Kurs- und Indikator-Swings.",
  ],
};

/** Die Gegenprobe zur Annahme „ohne Stop": Stop am Swing-Tief bzw. -Hoch der letzten 5 Kerzen. */
export const BOLLINGER_MIT_SWINGSTOP = BOLLINGER_VIDEO.teile.map((t) => {
  const { stopProzent: _notstop, ...rest } = t.strategie;
  return {
    ...t,
    strategie: {
      ...rest,
      name: t.strategie.name.replace("Original", "Stop am Swing der letzten 5 Kerzen"),
      stopAn: {
        art: t.strategie.richtung === "long" ? "swing_tief" : "swing_hoch",
        periode: 5,
      } as Indikator,
    },
  };
});

/** EASY Scalping Strategy For Day Trading (High Win Rate Strategy) — `bKPs2aOsvsk`. */
const FRAKTAL_TIEF: Indikator = { art: "fraktal_tief", periode: 2 };
const FRAKTAL_HOCH: Indikator = { art: "fraktal_hoch", periode: 2 };

function scalpingTeil(
  richtung: "long" | "short",
  tiefe: "20er" | "50er",
  linie: (periode: number) => Indikator,
): Quellregel["teile"][number] {
  const long = richtung === "long";
  const [flach, tief, stop] = tiefe === "20er" ? [20, 50, 50] : [50, 100, 100];
  const fraktal = long ? FRAKTAL_TIEF : FRAKTAL_HOCH;
  // Long: 20 über 50 über 100. Der Pfeil liegt unter der `flach`-Linie, aber noch über der
  // `tief`-Linie — lag der Rücksetzer schon unter der nächsten Linie, gilt der andere Zweig.
  const reihenfolge = long ? "ueber" : "unter";
  const jenseits = long ? "unter" : "ueber";
  const diesseits = long ? "ueber" : "unter";
  return {
    teil: `${richtung}, Rücksetzer unter die ${flach}er`,
    strategie: {
      name: `TradingLab · EASY Scalping (Original, ${richtung}, Rücksetzer unter die ${flach}er)`,
      richtung,
      einstieg: [
        { links: linie(20), vergleich: reihenfolge, rechts: linie(50) },
        { links: linie(50), vergleich: reihenfolge, rechts: linie(100) },
        { links: fraktal, vergleich: jenseits, rechts: linie(flach) },
        { links: fraktal, vergleich: diesseits, rechts: linie(tief) },
      ],
      stopAn: linie(stop),
      zielR: 1.5,
    },
  };
}

export const SCALPING_VIDEO: Quellregel = {
  video: "bKPs2aOsvsk",
  titel: "EASY Scalping Strategy For Day Trading (High Win Rate Strategy)",
  behauptung:
    '„High Win Rate" im Titel, ohne Zahl; „funktioniert in fast allen Märkten" und auf allen Zeitrahmen (00:13, 00:24).',
  teile: [
    scalpingTeil("long", "20er", sma),
    scalpingTeil("long", "50er", sma),
    scalpingTeil("short", "20er", sma),
    scalpingTeil("short", "50er", sma),
  ],
  belege: [
    {
      zeit: "00:00–00:04",
      regel: "Gedacht für den 1-Minuten-Chart; laut 00:24 für alle Zeitrahmen.",
    },
    {
      zeit: "00:37–00:47",
      regel: "Williams-Fraktale mit Periode 2; Farben getauscht, grün ist damit das Fraktal-Tief.",
    },
    { zeit: "01:04", regel: "Drei gleitende Durchschnitte mit 20, 50 und 100." },
    {
      zeit: "01:20–01:34",
      regel:
        "Long nur, wenn die 20er über der 50er und die 50er über der 100er liegt; kreuzen sie sich, kein Handel.",
    },
    {
      zeit: "01:47–01:58",
      regel: "Einstieg long: Rücksetzer unter die 20er (oder 50er), dann grüner Pfeil.",
    },
    { zeit: "02:21–02:25", regel: "Stop knapp unter der 50er, Ziel 1,5-faches Risiko." },
    {
      zeit: "02:33–02:43",
      regel:
        "Lief der Rücksetzer bis unter die 50er, Stop knapp unter der 100er, Ziel weiter 1,5-fach.",
    },
    {
      zeit: "02:55–03:16",
      regel: "Schließt der Kurs unter der 100er, den nächsten grünen Pfeil ignorieren.",
    },
    {
      zeit: "03:22–03:39",
      regel:
        "Short gespiegelt: 100er oben, 20er unten, Kurs über die 20er, roter Pfeil, Stop über der 50er, 1,5-fach.",
    },
    {
      zeit: "03:54–04:10",
      regel: "Warnung: auf 1 Minute sehr viele Signale — nur mit niedrigen Gebühren.",
    },
  ],
  annahmen: [
    'Die Durchschnitte sind SMA: der Indikator „three moving averages" nennt die Art im Transkript nicht.',
    'Der Pfeil zählt auf der Kerze, auf der das Fraktal feststeht — zwei Kerzen nach der Tiefkerze. TradingView zeichnet ihn zwei Kerzen früher; wer im Chart „am Pfeil" einsteigt, nutzt Wissen, das es da noch nicht gab.',
    '„Rücksetzer unter die 20er" heißt: das Tief der Fraktalkerze liegt unter der 20er, aber über der 50er (Stop an der 50er); liegt es unter der 50er, aber über der 100er, Stop an der 100er; unter der 100er kein Handel.',
    'Die Regel „nach einem Schluss unter der 100er den nächsten Pfeil ignorieren" ist nur erfasst, soweit der Schluss in den fünf Kerzen des Fraktals liegt.',
    'Der Stop liegt genau auf der Linie an der Signalkerze („knapp unter" ohne Abstand).',
    "Markt: nicht genannt — gerechnet an BTC/USDT und ETH/USDT bei Binance (die einzige Quelle hier mit langer 1-Minuten-Historie), Kosten wie immer 0,1 % Gebühr + 0,05 % Schlupf je Seite; zum Trennen von Kante und Kosten zusätzlich ohne Kosten.",
  ],
  nichtPruefbar: [],
};

export interface Vereint {
  anzahl: number;
  /** Anteil der Handel mit positivem Ergebnis **nach** Kosten. */
  trefferquote: number;
  /** Anteil der Handel, die ihr Ziel vor dem Stop erreicht haben — die „Win Rate" im Chart. */
  zielErreicht: number;
  erwartungswertR: number;
  profitFaktor: number;
  konfidenz?: Konfidenz;
  /** Handel, die wegfielen, weil schon eine Position aus einem anderen Teil lief. */
  weggefallen: number;
  /** Die behaltenen Handel, nach Einstiegszeit. */
  handel: Handel[];
}

/**
 * Mehrere Teile einer Regel (long und short, oder zwei Stop-Zweige) zu **einem** Handelsbuch.
 *
 * Wie im Backtest selbst läuft höchstens eine Position gleichzeitig: nach Einstiegszeit
 * geordnet, fällt ein Handel weg, der beginnt, solange ein anderer noch läuft. Wie viele das
 * waren, steht im Ergebnis — eine Vereinigung, die still Handel doppelt zählt, würde eine
 * Regel besser aussehen lassen, als ein einzelnes Konto sie handeln könnte.
 */
export function vereine(teile: readonly (readonly Handel[])[]): Vereint {
  const alle = teile.flat().sort((a, b) => a.einstiegZeit - b.einstiegZeit);
  const behalten: Handel[] = [];
  let frei = Number.NEGATIVE_INFINITY;
  for (const h of alle) {
    if (h.einstiegZeit < frei) continue;
    behalten.push(h);
    frei = h.ausstiegZeit;
  }
  const r = behalten.map((h) => h.r);
  const gewinn = r.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const verlust = r.filter((x) => x <= 0).reduce((a, b) => a - b, 0);
  const anzahl = behalten.length;
  const k = konfidenz(r);
  return {
    anzahl,
    trefferquote: anzahl === 0 ? 0 : r.filter((x) => x > 0).length / anzahl,
    zielErreicht: anzahl === 0 ? 0 : behalten.filter((h) => h.grund === "ziel").length / anzahl,
    erwartungswertR: anzahl === 0 ? 0 : r.reduce((a, b) => a + b, 0) / anzahl,
    profitFaktor: verlust > 0 ? gewinn / verlust : gewinn > 0 ? Number.POSITIVE_INFINITY : 0,
    ...(k !== undefined ? { konfidenz: k } : {}),
    weggefallen: alle.length - anzahl,
    handel: behalten,
  };
}
