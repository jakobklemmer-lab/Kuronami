/**
 * N9 · Kalibrierung an TradingLab — das Skript, das rechnet. Kein Agent, kein Auftrag an Kuro:
 * dieselben Module wie das Labor (`gateway/backtest.ts`, `universum.ts`), direkt aufgerufen.
 *
 *   npx tsx bau/kalibrierung-n9.ts <ordner>                      nur rechnen
 *   npx tsx bau/kalibrierung-n9.ts <ordner> --ablegen <deutung>  rechnen und ablegen
 *
 * `<ordner>` trägt den Kerzenspeicher (eine Kopie von `workspace/kerzen`, damit das Rechnen
 * nichts ins laufende System schreibt) und bekommt `kalibrierung.md` und `ergebnis.json`.
 * `--ablegen` schreibt zusätzlich ins Arbeitsverzeichnis Kuros: den Bericht nach
 * `wissen/tradinglab/kalibrierung.md`, dieselbe Fassung als Analyse (von „nachtbau") und je
 * Video das Original (long) als Archiv-Eintrag mit gerechnetem Status. `<deutung>` ist ein
 * Markdown-Abschnitt, der nach dem Rechnen geschrieben wurde — die Zahlen darin stammen aus
 * genau diesem Lauf.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createAnalysen } from "../gateway/analysen.js";
import {
  type BacktestErgebnis,
  type Handel,
  type Strategie,
  backtest,
  formatiereBacktest,
} from "../gateway/backtest.js";
import type { ChartInterval, MarketCandle } from "../gateway/integrations/markets.js";
import {
  BOLLINGER_MIT_SWINGSTOP,
  BOLLINGER_VIDEO,
  MACD_MIT_SMA,
  MACD_VIDEO,
  NOTSTOP_PROZENT,
  type Quellregel,
  SCALPING_VIDEO,
  type Vereint,
  vereine,
} from "../gateway/kalibrierung.js";
import { createKerzenquelle } from "../gateway/kerzen.js";
import { nullEingeschlossen } from "../gateway/konfidenz.js";
import { createStrategien } from "../gateway/strategien.js";
import { formatiereUniversum, ueberMaerkte } from "../gateway/universum.js";

const ordner = process.argv[2];
if (!ordner)
  throw new Error("Aufruf: npx tsx bau/kalibrierung-n9.ts <ordner> [--ablegen <deutung.md>]");
const ablegen = process.argv[3] === "--ablegen" ? process.argv[4] : undefined;
const WORKSPACE = process.env.KURO_WORKDIR ?? "/opt/kuronami/workspace";

const quelle = createKerzenquelle({ workdir: ordner });
const unix = (tag: string): number => Math.floor(Date.parse(`${tag}T00:00:00Z`) / 1000);

async function kerzen(
  symbol: string,
  intervall: ChartInterval,
  von: string,
  bis: string,
): Promise<{ symbol: string; kerzen: MarketCandle[] }> {
  const g = await quelle.hole({
    symbol,
    intervall,
    vonUnix: unix(von),
    bisUnix: unix(bis) + 86_400,
  });
  console.error(`  ${symbol} ${intervall}: ${g.kerzen.length} Kerzen (${g.neuGeholt} neu geholt)`);
  return { symbol: `${g.quelle}:${g.symbol}`, kerzen: g.kerzen };
}

// ---------------------------------------------------------------------------------------------
// Zahlen

/** Die Kurzfassung eines Laufs — genau die Spalten, die im Bericht stehen. */
interface Kurz {
  anzahl: number;
  trefferquote: number;
  zielErreicht: number;
  erwartungswertR: number;
  intervall?: [number, number];
  nullBelegt: boolean;
  profitFaktor: number;
  renditeJeHandel: number;
  nullpunktR?: number;
  ungesehenR?: number;
  medianRisikoProzent?: number;
  ohneStop?: number;
  weggefallen?: number;
  /** Wie viele Handel am Stop endeten. */
  stops: number;
}

function median(werte: number[]): number | undefined {
  if (werte.length === 0) return undefined;
  const s = [...werte].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Eine Regel ohne Ziel (Bollinger: raus an der Mittellinie) hat keine Quote „Ziel erreicht". */
function ohneZiel(handel: readonly Handel[]): boolean {
  return handel.length === 0 || handel.every((h) => h.ziel === null);
}

function risikoProzent(handel: readonly Handel[]): number | undefined {
  return median(handel.map((h) => (Math.abs(h.einstieg - h.stop) / h.einstieg) * 100));
}

function kurzAus(e: BacktestErgebnis): Kurz {
  const g = e.gesamt;
  const n = e.handel.length;
  return {
    anzahl: g.anzahl,
    trefferquote: g.trefferquote,
    zielErreicht: ohneZiel(e.handel)
      ? Number.NaN
      : e.handel.filter((h) => h.grund === "ziel").length / n,
    erwartungswertR: g.erwartungswertR,
    ...(g.konfidenz
      ? { intervall: [g.konfidenz.unten, g.konfidenz.oben] as [number, number] }
      : {}),
    nullBelegt: g.konfidenz !== undefined && !nullEingeschlossen(g.konfidenz),
    profitFaktor: g.profitFaktor,
    renditeJeHandel: n === 0 ? 0 : e.handel.reduce((a, h) => a + h.renditeProzent, 0) / n,
    ...(e.nullpunkt ? { nullpunktR: e.nullpunkt.erwartungswertR } : {}),
    ...(e.outOfSample.kennzahlen.anzahl > 0
      ? { ungesehenR: e.outOfSample.kennzahlen.erwartungswertR }
      : {}),
    ...(risikoProzent(e.handel) !== undefined
      ? { medianRisikoProzent: risikoProzent(e.handel) }
      : {}),
    ...(e.ohneStop ? { ohneStop: e.ohneStop } : {}),
    stops: e.handel.filter((h) => h.grund === "stop").length,
  };
}

function kurzVereint(v: Vereint): Kurz {
  const handel = v.handel;
  return {
    anzahl: v.anzahl,
    trefferquote: v.trefferquote,
    zielErreicht: ohneZiel(handel) ? Number.NaN : v.zielErreicht,
    erwartungswertR: v.erwartungswertR,
    ...(v.konfidenz
      ? { intervall: [v.konfidenz.unten, v.konfidenz.oben] as [number, number] }
      : {}),
    nullBelegt: v.konfidenz !== undefined && !nullEingeschlossen(v.konfidenz),
    profitFaktor: v.profitFaktor,
    renditeJeHandel:
      handel.length === 0 ? 0 : handel.reduce((a, h) => a + h.renditeProzent, 0) / handel.length,
    ...(risikoProzent(handel) !== undefined ? { medianRisikoProzent: risikoProzent(handel) } : {}),
    weggefallen: v.weggefallen,
    stops: handel.filter((h) => h.grund === "stop").length,
  };
}

interface Lauf {
  titel: string;
  markt: string;
  intervall: string;
  von: string;
  bis: string;
  kosten: string;
  teile: { teil: string; kurz: Kurz }[];
  zusammen?: Kurz;
}

function rechne(
  titel: string,
  teile: Quellregel["teile"],
  markt: { symbol: string; kerzen: MarketCandle[] },
  intervall: string,
  kostenlos = false,
): { lauf: Lauf; ergebnisse: BacktestErgebnis[] } {
  const ergebnisse = teile.map((t) =>
    backtest(
      kostenlos ? { ...t.strategie, gebuehrProzent: 0, schlupfProzent: 0 } : t.strategie,
      markt.kerzen,
      { symbol: markt.symbol, intervall },
    ),
  );
  const lauf: Lauf = {
    titel,
    markt: markt.symbol,
    intervall,
    von: ergebnisse[0].von,
    bis: ergebnisse[0].bis,
    kosten: kostenlos ? "ohne Kosten" : "0,1 % Gebühr + 0,05 % Schlupf je Seite",
    teile: teile.map((t, i) => ({ teil: t.teil, kurz: kurzAus(ergebnisse[i]) })),
  };
  if (teile.length > 1) lauf.zusammen = kurzVereint(vereine(ergebnisse.map((e) => e.handel)));
  return { lauf, ergebnisse };
}

// ---------------------------------------------------------------------------------------------
// Darstellung

const komma = (x: number, stellen = 2): string => x.toFixed(stellen).replace(".", ",");
const pct = (x: number): string => (Number.isNaN(x) ? "–" : `${komma(x * 100, 1)} %`);
const vorz = (x: number, stellen = 2): string =>
  `${x >= 0 ? "+" : "−"}${komma(Math.abs(x), stellen)}`;
const rr = (x: number): string => `${vorz(x)} R`;

function intervallText(k: Kurz): string {
  if (!k.intervall) return "zu wenige Handel für ein Intervall";
  const [u, o] = k.intervall;
  return `${vorz(u)} bis ${vorz(o)} R${k.nullBelegt ? "" : " (schließt null ein)"}`;
}

function tabelle(zeilen: { name: string; k: Kurz }[], mitNullpunkt = true): string {
  const kopf = [
    "| | Handel | Ziel erreicht | Treffer nach Kosten | ⌀ je Handel | Erwartungswert (95-%-Intervall) |",
    "|:--|--:|--:|--:|--:|:--|",
  ];
  if (mitNullpunkt) {
    kopf[0] += " Nullpunkt |";
    kopf[1] += "--:|";
  }
  return [
    ...kopf,
    ...zeilen.map(
      ({ name, k }) =>
        `| ${name} | ${k.anzahl} | ${pct(k.zielErreicht)} | ${pct(k.trefferquote)} | ${vorz(k.renditeJeHandel)} % | ${rr(k.erwartungswertR)} (${intervallText(k)}) |${mitNullpunkt ? ` ${k.nullpunktR === undefined ? "–" : rr(k.nullpunktR)} |` : ""}`,
    ),
  ].join("\n");
}

function laufTabelle(l: Lauf): string {
  const zeilen = l.teile.map((t) => ({ name: t.teil, k: t.kurz }));
  if (l.zusammen) zeilen.push({ name: "**zusammen**", k: l.zusammen });
  const gesamt = l.zusammen ?? l.teile[0].kurz;
  const ohneStop = l.teile.reduce((a, t) => a + (t.kurz.ohneStop ?? 0), 0);
  const fuss = [
    gesamt.medianRisikoProzent === undefined
      ? ""
      : gesamt.medianRisikoProzent >= NOTSTOP_PROZENT - 0.5
        ? `Ohne Stop gerechnet (Notstop ${NOTSTOP_PROZENT} %, ausgelöst: ${gesamt.stops}-mal).`
        : `Typisches Risiko je Handel (Median): ${komma(gesamt.medianRisikoProzent, 3)} % vom Kurs.`,
    gesamt.weggefallen
      ? `${gesamt.weggefallen} Handel fielen weg, weil schon eine Position lief.`
      : "",
    ohneStop > 0
      ? `${ohneStop} Signale ohne Handel, weil die Stoplinie auf der falschen Seite lag.`
      : "",
  ].filter(Boolean);
  return [tabelle(zeilen), ...(fuss.length > 0 ? ["", fuss.join(" ")] : [])].join("\n");
}

// ---------------------------------------------------------------------------------------------
// Der Lauf

const VON_1D = "2015-01-01";
const BIS = "2026-09-21";
/** Die weiteren Märkte stehen vor dem Rechnen fest und gelten für beide Tagesvideos gleich. */
const MAERKTE_1D = ["^GSPC", "^GDAXI", "AAPL", "GC=F", "EURUSD=X", "BTC-USD"];

console.error("Kerzen:");
const tag: Record<string, { symbol: string; kerzen: MarketCandle[] }> = {};
for (const s of MAERKTE_1D) tag[s] = await kerzen(s, "1d", VON_1D, BIS);
const btc1m = await kerzen("binance:BTCUSDT", "1m", "2026-06-22", BIS);
const eth1m = await kerzen("binance:ETHUSDT", "1m", "2026-06-22", BIS);
const btc5m = await kerzen("binance:BTCUSDT", "5m", "2025-09-22", BIS);
const btc1h = await kerzen("binance:BTCUSDT", "1h", "2020-01-01", BIS);
const spx1h = await kerzen("^GSPC", "1h", "2024-09-23", BIS);

async function agentenRegel(
  datei: string,
): Promise<{ strategie: Strategie; archiv: Kurz; name: string }> {
  const e = JSON.parse(await readFile(path.join(WORKSPACE, "strategien", datei), "utf8"));
  const k = e.kennzahlen;
  return {
    name: e.name,
    strategie: e.strategie,
    archiv: {
      anzahl: k.anzahl,
      trefferquote: k.trefferquote,
      zielErreicht: Number.NaN,
      erwartungswertR: k.erwartungswertR,
      ...(k.konfidenz
        ? { intervall: [k.konfidenz.unten, k.konfidenz.oben] as [number, number] }
        : {}),
      nullBelegt: k.konfidenz ? !nullEingeschlossen(k.konfidenz) : false,
      profitFaktor: k.profitFaktor,
      renditeJeHandel: Number.NaN,
      stops: Number.NaN,
    },
  };
}

const spx = tag["^GSPC"];
const ergebnis: Record<string, unknown> = {};

// --- MACD ------------------------------------------------------------------------------------
console.error("MACD …");
const macd = rechne("Original", MACD_VIDEO.teile, spx, "1d");
const macdSma = rechne("Gegenprobe SMA 200", MACD_MIT_SMA, spx, "1d");
// Das Video nennt keinen Zeitrahmen; die Tageskerze ist eine Annahme. Gegenprobe auf 1h.
const macd1h = [
  rechne("S&P 500 1h", MACD_VIDEO.teile, spx1h, "1h"),
  rechne("BTC/USDT 1h", MACD_VIDEO.teile, btc1h, "1h"),
];
const macdAgent = await agentenRegel("2026-09-21T18-39-10-319Z-19a4352827fb.json");
const macdAgentNeu = kurzAus(
  backtest(macdAgent.strategie, spx.kerzen, { symbol: spx.symbol, intervall: "1d" }),
);
const macdMaerkte = MACD_VIDEO.teile.map((t) =>
  ueberMaerkte(
    t.strategie,
    MAERKTE_1D.map((s) => tag[s]),
    { intervall: "1d" },
  ),
);

// Die Leiter: vom Agenten zum Original, ein Unterschied nach dem anderen (long, S&P 500).
const a = macdAgent.strategie;
const nullLinie = {
  links: MACD_VIDEO.teile[0].strategie.einstieg[1].links,
  vergleich: "unter" as const,
  rechts: { art: "wert" as const, wert: 0 },
};
const ueberEma = MACD_VIDEO.teile[0].strategie.einstieg[2];
const macdLeiter: { schritt: string; s: Strategie }[] = [
  { schritt: "Agenten-Regel vom 21.09. (neu gerechnet)", s: a },
  {
    schritt: "+ Kreuzung nur unter der Nulllinie",
    s: { ...a, einstieg: [...a.einstieg, nullLinie] },
  },
  {
    schritt: "+ nur über der EMA 200",
    s: { ...a, einstieg: [...a.einstieg, nullLinie, ueberEma] },
  },
];
{
  const { stopAtr: _atr, ...ohneAtr } = macdLeiter[2].s;
  macdLeiter.push({
    schritt: "Stop an der EMA 200 statt 2 ATR",
    s: { ...ohneAtr, stopAn: { art: "ema", periode: 200 } },
  });
  macdLeiter.push({
    schritt: "Ziel 1,5 R statt 3 R",
    s: { ...ohneAtr, stopAn: { art: "ema", periode: 200 }, zielR: 1.5 },
  });
  const { ausstieg: _aus, ...ohneAusstieg } = {
    ...ohneAtr,
    stopAn: { art: "ema" as const, periode: 200 },
    zielR: 1.5,
  };
  macdLeiter.push({
    schritt: "ohne Ausstieg bei Gegenkreuzung = Original (long)",
    s: ohneAusstieg,
  });
}
const macdLeiterKurz = macdLeiter.map((l) => ({
  name: l.schritt,
  k: kurzAus(
    backtest({ ...l.s, name: l.schritt }, spx.kerzen, { symbol: spx.symbol, intervall: "1d" }),
  ),
}));

// --- Bollinger -------------------------------------------------------------------------------
console.error("Bollinger …");
const bb = rechne("Original", BOLLINGER_VIDEO.teile, spx, "1d");
const bbAapl = rechne("Original an Apple", BOLLINGER_VIDEO.teile, tag.AAPL, "1d");
const bbSwing = rechne("Gegenprobe Stop am Swing", BOLLINGER_MIT_SWINGSTOP, spx, "1d");
const bb1h = [
  rechne("S&P 500 1h", BOLLINGER_VIDEO.teile, spx1h, "1h"),
  rechne("BTC/USDT 1h", BOLLINGER_VIDEO.teile, btc1h, "1h"),
];
const bbAgent = await agentenRegel("2026-09-21T18-26-57-645Z-3b4ec14ace8d.json");
const bbAgentNeu = kurzAus(
  backtest(bbAgent.strategie, spx.kerzen, { symbol: spx.symbol, intervall: "1d" }),
);
const bbMaerkte = BOLLINGER_VIDEO.teile.map((t) =>
  ueberMaerkte(
    t.strategie,
    MAERKTE_1D.map((s) => tag[s]),
    { intervall: "1d" },
  ),
);
const b = bbAgent.strategie;
const bb30 = { art: "bollinger_unten" as const, periode: 30, faktor: 2 };
const rsiUnter25 = BOLLINGER_VIDEO.teile[0].strategie.einstieg[1];
const mitte30 = BOLLINGER_VIDEO.teile[0].strategie.ausstieg ?? [];
const bbLeiter: { schritt: string; s: Strategie }[] = [
  { schritt: "Agenten-Regel vom 21.09. (neu gerechnet)", s: b },
  {
    schritt: "Bänder mit Länge 30 statt 20",
    s: { ...b, einstieg: [{ ...b.einstieg[0], rechts: bb30 }, b.einstieg[1]] },
  },
  {
    schritt: "+ RSI 13 unter 25",
    s: { ...b, einstieg: [{ ...b.einstieg[0], rechts: bb30 }, b.einstieg[1], rsiUnter25] },
  },
  {
    schritt: '− Filter „über der SMA 200"',
    s: { ...b, einstieg: [{ ...b.einstieg[0], rechts: bb30 }, rsiUnter25] },
  },
];
{
  const { zielR: _z, maxKerzen: _m, ...ohneZiel } = bbLeiter[3].s;
  bbLeiter.push({
    schritt: "raus an der Mittellinie statt Ziel 2 R / 10 Kerzen",
    s: { ...ohneZiel, ausstieg: mitte30 },
  });
  const { stopAtr: _atr, ...ohneAtr } = { ...ohneZiel, ausstieg: mitte30 };
  bbLeiter.push({
    schritt: "ohne Stop (wie im Video) = Original (long)",
    s: { ...ohneAtr, stopProzent: 90 },
  });
}
const bbLeiterKurz = bbLeiter.map((l) => ({
  name: l.schritt,
  k: kurzAus(
    backtest({ ...l.s, name: l.schritt }, spx.kerzen, { symbol: spx.symbol, intervall: "1d" }),
  ),
}));

// --- Scalping --------------------------------------------------------------------------------
console.error("Scalping …");
const sc = [
  rechne("BTC/USDT 1m", SCALPING_VIDEO.teile, btc1m, "1m"),
  rechne("BTC/USDT 1m", SCALPING_VIDEO.teile, btc1m, "1m", true),
  rechne("ETH/USDT 1m", SCALPING_VIDEO.teile, eth1m, "1m"),
  rechne("ETH/USDT 1m", SCALPING_VIDEO.teile, eth1m, "1m", true),
  rechne("BTC/USDT 5m", SCALPING_VIDEO.teile, btc5m, "5m"),
  rechne("BTC/USDT 5m", SCALPING_VIDEO.teile, btc5m, "5m", true),
  rechne("BTC/USDT 1h", SCALPING_VIDEO.teile, btc1h, "1h"),
  rechne("BTC/USDT 1h", SCALPING_VIDEO.teile, btc1h, "1h", true),
];

Object.assign(ergebnis, {
  macd: {
    original: macd.lauf,
    sma: macdSma.lauf,
    stunde: macd1h.map((x) => x.lauf),
    agentArchiv: macdAgent.archiv,
    agentNeu: macdAgentNeu,
    leiter: macdLeiterKurz,
  },
  bollinger: {
    original: bb.lauf,
    apple: bbAapl.lauf,
    swing: bbSwing.lauf,
    stunde: bb1h.map((x) => x.lauf),
    agentArchiv: bbAgent.archiv,
    agentNeu: bbAgentNeu,
    leiter: bbLeiterKurz,
  },
  scalping: sc.map((x) => x.lauf),
  universum: {
    macd: macdMaerkte.map((u) => ({
      strategie: u.strategie,
      einstufung: u.einstufung,
      gesamtHandel: u.gesamtHandel,
      gemeinsamR: u.gemeinsamErwartungswertR,
      positiv: u.positiv,
      gerechnet: u.gerechnet,
      maerkte: u.maerkte,
    })),
    bollinger: bbMaerkte.map((u) => ({
      strategie: u.strategie,
      einstufung: u.einstufung,
      gesamtHandel: u.gesamtHandel,
      gemeinsamR: u.gemeinsamErwartungswertR,
      positiv: u.positiv,
      gerechnet: u.gerechnet,
      maerkte: u.maerkte,
    })),
  },
});

// ---------------------------------------------------------------------------------------------
// Der Bericht

function regelteil(q: Quellregel): string {
  return [
    `**Video:** [${q.titel}](https://www.youtube.com/watch?v=${q.video}) · Behauptung: ${q.behauptung}`,
    "",
    "Die Regel, wie das Video sie sagt (eigene Worte, Zeitmarke):",
    "",
    ...q.belege.map((b) => `- **${b.zeit}** ${b.regel}`),
    "",
    "Annahmen, wo das Transkript offen bleibt:",
    "",
    ...q.annahmen.map((x) => `- ${x}`),
    ...(q.nichtPruefbar.length > 0
      ? ["", "Nicht gerechnet:", "", ...q.nichtPruefbar.map((x) => `- ${x}`)]
      : []),
  ].join("\n");
}

function universumZeile(u: (typeof macdMaerkte)[number]): string {
  const gezaehlt = u.maerkte.filter((m) => !m.fehler);
  const treffer =
    gezaehlt.reduce((a, m) => a + m.trefferquote * m.anzahl, 0) / Math.max(1, u.gesamtHandel);
  return `${u.einstufung} — ${u.positiv} von ${u.gerechnet} Märkten positiv, zusammen ${u.gesamtHandel} Handel, Treffer ${pct(treffer)}, ${rr(u.gemeinsamErwartungswertR)}`;
}

function vergleich(
  behauptung: string,
  original: Kurz,
  originalMarkt: string,
  uebertragbar: string,
  agent: { name: string; archiv: Kurz; neu: Kurz } | null,
): string {
  const zeilen = [
    "| | TradingLab sagt | Das Original bei uns | Die Agenten am 21.09. |",
    "|:--|:--|:--|:--|",
    `| Regel | wie oben | wörtlich, long und short | ${agent ? agent.name : "nie gerechnet"} |`,
    `| Markt | nicht genannt | ${originalMarkt} | ${agent ? "S&P 500, 1d, 2015–2026, nur long" : "–"} |`,
    `| Handel | – | ${original.anzahl} | ${agent ? `${agent.archiv.anzahl} (heute neu gerechnet: ${agent.neu.anzahl})` : "–"} |`,
    `| Trefferquote | ${behauptung} | ${pct(original.trefferquote)} nach Kosten${Number.isNaN(original.zielErreicht) ? " (kein Ziel, raus an der Mittellinie)" : `, Ziel erreicht ${pct(original.zielErreicht)}`} | ${agent ? `${pct(agent.archiv.trefferquote)} (neu: ${pct(agent.neu.trefferquote)})` : "–"} |`,
    `| Erwartungswert | – | ${rr(original.erwartungswertR)}, ${intervallText(original)} | ${agent ? `${rr(agent.archiv.erwartungswertR)} (neu: ${rr(agent.neu.erwartungswertR)})` : "–"} |`,
    `| ⌀ Rendite je Handel | – | ${vorz(original.renditeJeHandel)} % | ${agent ? `${vorz(agent.neu.renditeJeHandel)} % (neu)` : "–"} |`,
    `| Übertragbarkeit | „fast jeder Markt" | ${uebertragbar} | ${agent ? "siehe Archiv" : "–"} |`,
  ];
  return zeilen.join("\n");
}

const md: string[] = [
  "# Kalibrierung: stimmt das Werkzeug mit TradingLab überein?",
  "",
  `Gerechnet vom Nachtbau am ${new Date().toLocaleDateString("de-DE", { timeZone: "Europe/Vienna" })} (Aufgabe N9), per Skript direkt über den Backtest — kein Agent. Die drei ältesten Videos, mit denen Jakob gelernt hat, **wörtlich** umgesetzt; was das Transkript offenlässt, steht als Annahme da. Gerechnet ohne Blick in die Zukunft: Signal auf der abgeschlossenen Kerze, Einstieg zur nächsten Eröffnung, Stop vor Ziel, Kosten 0,1 % Gebühr + 0,05 % Schlupf je Seite, wenn nicht anders gesagt.`,
  "",
  '**Wie man die Spalten liest.** „Ziel erreicht" ist das, was ein Chart als Gewinn zeigt: das Ziel kam vor dem Stop. „Treffer nach Kosten" zählt nur Handel, die nach Gebühren und Schlupf im Plus sind. Der Erwartungswert in R ist der Gewinn je Handel in Vielfachen des eingesetzten Risikos; das Intervall sagt, ob er sich von null unterscheiden lässt. Der Nullpunkt ist dieselbe Stop-Ziel-Geometrie ohne Einstiegsregel — schlägt die Regel ihn nicht, wählt sie nur den Zeitpunkt, nicht das Ergebnis.',
  "",
  "@@DEUTUNG@@",
  "",
  '## 1 · BEST MACD („86 % Win Rate")',
  "",
  regelteil(MACD_VIDEO),
  "",
  "### Drei Spalten",
  "",
  vergleich(
    "86 % (Titel)",
    macd.lauf.zusammen as Kurz,
    "S&P 500, 1d, 2015–2026",
    macdMaerkte
      .map((u) => `${u.strategie.includes("long") ? "long" : "short"}: ${universumZeile(u)}`)
      .join("; "),
    { name: macdAgent.name, archiv: macdAgent.archiv, neu: macdAgentNeu },
  ),
  "",
  `### Das Original im Einzelnen (S&P 500, 1d, ${macd.lauf.von} bis ${macd.lauf.bis})`,
  "",
  laufTabelle(macd.lauf),
  "",
  "Gegenprobe zur Annahme EMA: dieselbe Regel mit der SMA 200.",
  "",
  laufTabelle(macdSma.lauf),
  "",
  "Gegenprobe zur Annahme Tageskerze: dieselbe Regel auf Stundenkerzen (EMA 200 = 200 Stunden).",
  "",
  ...macd1h.flatMap((x) => [
    `${x.lauf.titel}, ${x.lauf.von} bis ${x.lauf.bis}:`,
    "",
    laufTabelle(x.lauf),
    "",
  ]),
  "### Wo die Agenten abwichen — Schritt für Schritt (long, S&P 500)",
  "",
  "Jede Zeile ändert gegenüber der vorigen genau eine Sache; die letzte ist das Original.",
  "",
  tabelle(macdLeiterKurz),
  "",
  "### Übertragbarkeit",
  "",
  ...macdMaerkte.flatMap((u) => ["```", formatiereUniversum(u), "```", ""]),
  "## 2 · Bollinger + RSI",
  "",
  regelteil(BOLLINGER_VIDEO),
  "",
  "### Drei Spalten",
  "",
  vergleich(
    '„ziemlich hoch" (ohne Zahl)',
    bb.lauf.zusammen as Kurz,
    "S&P 500, 1d, 2015–2026",
    bbMaerkte
      .map((u) => `${u.strategie.includes("long") ? "long" : "short"}: ${universumZeile(u)}`)
      .join("; "),
    { name: bbAgent.name, archiv: bbAgent.archiv, neu: bbAgentNeu },
  ),
  "",
  "Ohne Stop ist 1 R hier 90 % des Einstiegs; vergleichbar sind deshalb Trefferquote und ⌀ Rendite je Handel, nicht die R-Zahlen.",
  "",
  `### Das Original im Einzelnen (S&P 500, 1d, ${bb.lauf.von} bis ${bb.lauf.bis})`,
  "",
  laufTabelle(bb.lauf),
  "",
  "An Apple, dem Beispiel aus dem Video:",
  "",
  laufTabelle(bbAapl.lauf),
  "",
  "Gegenprobe mit Stop am Swing-Tief bzw. -Hoch der letzten 5 Kerzen (S&P 500):",
  "",
  laufTabelle(bbSwing.lauf),
  "",
  "Gegenprobe zur Annahme Tageskerze: dieselbe Regel auf Stundenkerzen.",
  "",
  ...bb1h.flatMap((x) => [
    `${x.lauf.titel}, ${x.lauf.von} bis ${x.lauf.bis}:`,
    "",
    laufTabelle(x.lauf),
    "",
  ]),
  "### Wo die Agenten abwichen — Schritt für Schritt (long, S&P 500)",
  "",
  tabelle(bbLeiterKurz),
  "",
  "### Übertragbarkeit",
  "",
  ...bbMaerkte.flatMap((u) => ["```", formatiereUniversum(u), "```", ""]),
  "## 3 · EASY Scalping (Williams-Fraktale)",
  "",
  regelteil(SCALPING_VIDEO),
  "",
  "Die Agenten haben dieses Video nie umgesetzt — die dritte Spalte bleibt leer.",
  "",
  ...sc.flatMap((x) => [
    `### ${x.lauf.titel}, ${x.lauf.kosten} (${x.lauf.von} bis ${x.lauf.bis})`,
    "",
    laufTabelle(x.lauf),
    "",
  ]),
];

const roh = md.join("\n");
await writeFile(path.join(ordner, "ergebnis.json"), `${JSON.stringify(ergebnis, null, 2)}\n`);
const deutung = ablegen
  ? await readFile(ablegen, "utf8")
  : "## Was das heißt\n\n_(folgt nach dem Rechnen)_";
const bericht = roh.replace("@@DEUTUNG@@", deutung.trim());
await writeFile(path.join(ordner, "kalibrierung.md"), bericht);
console.error(`Geschrieben: ${path.join(ordner, "kalibrierung.md")}`);

if (ablegen) {
  await writeFile(path.join(WORKSPACE, "wissen", "tradinglab", "kalibrierung.md"), bericht);
  const analyse = await createAnalysen({ workdir: WORKSPACE }).lege({
    wer: "nachtbau",
    auftrag:
      "N9 aus dem Bauplan: die drei ältesten TradingLab-Videos (MACD, Bollinger + RSI, Scalping) wörtlich umsetzen, fehlende Bausteine bauen, per Skript rechnen und in drei Spalten vergleichen — TradingLabs Angabe, das Original bei uns, die Regeln der Agenten vom 21.09.",
    bericht,
    beitraege: [],
    kostenUsd: 0,
    dauerMs: 0,
    hatIdee: false,
  });
  console.error(`Analyse: ${analyse?.id}`);

  // Je Video das Original (long) ins Archiv — mit gerechnetem Status und der Übertragbarkeit
  // über dieselben Märkte, wie `strategie_ablegen` es täte.
  const archiv = createStrategien({ workdir: WORKSPACE });
  const eintraege: {
    e: BacktestErgebnis;
    s: Strategie;
    markt: string;
    intervall: string;
    maerkte: { symbol: string; kerzen: MarketCandle[] }[];
  }[] = [
    {
      e: macd.ergebnisse[0],
      s: MACD_VIDEO.teile[0].strategie,
      markt: spx.symbol,
      intervall: "1d",
      maerkte: MAERKTE_1D.map((s) => tag[s]),
    },
    {
      e: bb.ergebnisse[0],
      s: BOLLINGER_VIDEO.teile[0].strategie,
      markt: spx.symbol,
      intervall: "1d",
      maerkte: MAERKTE_1D.map((s) => tag[s]),
    },
    {
      e: sc[0].ergebnisse[0],
      s: SCALPING_VIDEO.teile[0].strategie,
      markt: btc1m.symbol,
      intervall: "1m",
      maerkte: [btc1m, eth1m],
    },
    {
      e: sc[0].ergebnisse[1],
      s: SCALPING_VIDEO.teile[1].strategie,
      markt: btc1m.symbol,
      intervall: "1m",
      maerkte: [btc1m, eth1m],
    },
  ];
  for (const x of eintraege) {
    const u = ueberMaerkte(x.s, x.maerkte, { intervall: x.intervall });
    const kopf = await archiv.lege({
      name: x.s.name,
      wer: "nachtbau",
      symbol: x.markt,
      intervall: x.intervall,
      von: x.e.von,
      bis: x.e.bis,
      strategie: x.s,
      kennzahlen: x.e.gesamt,
      inSample: x.e.inSample,
      outOfSample: x.e.outOfSample,
      warnungstexte: x.e.warnungen,
      bericht: `${formatiereBacktest(x.e)}\n\n${formatiereUniversum(u)}`,
      universum: {
        einstufung: u.einstufung,
        maerkte: u.gerechnet,
        gesamtHandel: u.gesamtHandel,
        gemeinsamErwartungswertR: u.gemeinsamErwartungswertR,
        begruendung: u.begruendung,
      },
    });
    await archiv.aendere(kopf.id, {
      notiz: `Kalibrierung N9 (Nachtbau, 28.09.): das TradingLab-Original wörtlich, Annahmen und Vergleich in der Analyse ${analyse?.id ?? "–"} und in wissen/tradinglab/kalibrierung.md. Der Status ist gerechnet, nicht gesetzt.`,
    });
    console.error(`Archiv: ${kopf.id} ${kopf.status} ${x.s.name}`);
  }
}
