/**
 * Nachrechnen (28.09.2026): eine Regel aus einem TradingLab-Video über **alles** — jeden
 * Zeitrahmen, jede Handelssitzung, lange Richtung, kurze und beide, viele Märkte zusammen.
 *
 * Jakob: „Manche Strategien sind aber nicht über Tageskerzen, es gibt für viele Strategien
 * bestimmte Zeitfenster, in denen sie funktionieren … Ich würde hierbei alles durchrechnen
 * wollen." Die Videos nennen fast nie ein Zeitfenster und selten einen Zeitrahmen; deshalb
 * wird nicht geraten, sondern alles gerechnet — und die Zahl der Versuche steht im Ergebnis.
 *
 * Die Regeln selbst stehen in `gateway/kalibrierung.ts`, wörtlich aus den Videos, mit Zeitmarke
 * und Annahmen. Gerechnet wird mit `backtest.ts` wie jede andere Regel: Signal auf der
 * abgeschlossenen Kerze, Einstieg zur nächsten Eröffnung, Stop vor Ziel, Kosten immer dabei.
 * Geurteilt wird nach derselben Schwelle wie in der Strategie-Ablage (`HANDEL_FUER_URTEIL`,
 * 95-%-Intervall), über alle Märkte einer Variante zusammen.
 *
 * Aufgerufen wird das aus den vier Skripten in `werkzeuge/nachrechnen/` (`macd.ts`, `bollinger.ts`, `scalping.ts`,
 * `supertrend.ts`), die nur festlegen, welche Regeln gerechnet werden.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createAnalysen } from "./analysen.js";
import { type Handel, type Strategie, type Zeitfenster, backtest } from "./backtest.js";
import type { ChartInterval, MarketCandle } from "./integrations/markets.js";
import { type Quellregel, vereine } from "./kalibrierung.js";
import { createKerzenquelle } from "./kerzen.js";
import { type Konfidenz, konfidenz } from "./konfidenz.js";
import { HANDEL_FUER_URTEIL } from "./strategien.js";

// ------------------------------------------------------------------------------ Was gerechnet wird

export const INTERVALLE = ["1m", "5m", "15m", "30m", "1h", "1d"] as const;
export type Intervall = (typeof INTERVALLE)[number];

/** Krypto über Binance: lange Historie auf jedem Zeitrahmen, echtes Volumen. DOGE und LTC sind
 *  die Märkte aus dem SuperTrend-Video. */
export const KRYPTO = [
  "binance:BTCUSDT",
  "binance:ETHUSDT",
  "binance:DOGEUSDT",
  "binance:LTCUSDT",
  "binance:SOLUSDT",
  "binance:XRPUSDT",
];
/** Indizes, Rohstoffe, Devisen, Aktien über Yahoo — Tageskerzen ab 2008, darunter nur kurz. */
export const BOERSE = [
  "^GSPC",
  "^NDX",
  "^GDAXI",
  "^DJI",
  "GC=F",
  "CL=F",
  "EURUSD=X",
  "GBPUSD=X",
  "AAPL",
  "MSFT",
];

/**
 * Wie weit zurück, je Zeitrahmen und Quelle. Bei Yahoo sind das die gemessenen Grenzen des
 * Anbieters (1m ~8 Tage, 5m–30m 60 Tage, 1h 730 Tage), bei Binance eine Wahl: 1m über drei
 * Monate sind schon 130.000 Kerzen je Markt.
 */
const RUECKBLICK: Record<Intervall, { binance: string | number; yahoo: string | number }> = {
  "1m": { binance: 92, yahoo: 7 },
  "5m": { binance: 365, yahoo: 58 },
  "15m": { binance: 730, yahoo: 58 },
  "30m": { binance: 730, yahoo: 58 },
  "1h": { binance: "2020-01-01", yahoo: 720 },
  "1d": { binance: "2017-08-17", yahoo: "2008-01-01" },
};

export interface Sitzung {
  name: string;
  zone?: string;
  fenster?: Zeitfenster;
}

/**
 * Die Handelssitzungen, in Ortszeit der jeweiligen Börse — die Zeitzone ankert Sommer- und
 * Winterzeit. Eingestiegen wird nur im Fenster, und an seinem Ende wird glattgestellt (die
 * Vorgabe im Backtest): wer nur in London einsteigt, aber über Nacht liegen bleibt, hätte kein
 * Fenster gehandelt, sondern eine Übernachtposition mit Einstiegsfilter.
 */
export const SITZUNGEN: readonly Sitzung[] = [
  { name: "ganzer Tag" },
  { name: "Asien", zone: "Asia/Tokyo", fenster: { von: "09:00", bis: "15:00" } },
  { name: "London", zone: "Europe/London", fenster: { von: "08:00", bis: "16:30" } },
  { name: "New York", zone: "America/New_York", fenster: { von: "09:30", bis: "16:00" } },
  { name: "London+New York", zone: "America/New_York", fenster: { von: "08:00", bis: "11:30" } },
];

export const RICHTUNGEN = ["beide", "long", "short"] as const;
export type Richtungswahl = (typeof RICHTUNGEN)[number];

/** Jakobs Risiko je Handel: 1 % von [Kapital]. Für die Spalte „€ je Woche". */
const RISIKO_EURO = 15;

// ------------------------------------------------------------------------------ Das Urteil

export type Urteil = "belegt" | "nicht belegt" | "widerlegt" | "zu wenig Handel";

/**
 * Dieselbe Schwelle wie `bewerte` in der Ablage: erst ab 200 Handeln, belegt nur mit einem
 * Intervall ganz über null **und** einem Plus im ungesehenen Teil, widerlegt nur ganz darunter.
 */
export function urteile(anzahl: number, k: Konfidenz | undefined, ungesehenR: number): Urteil {
  if (anzahl < HANDEL_FUER_URTEIL || k === undefined) return "zu wenig Handel";
  if (k.oben < 0) return "widerlegt";
  if (k.unten > 0 && ungesehenR > 0) return "belegt";
  return "nicht belegt";
}

/** Verteilungsfunktion der Standardnormalverteilung (Abramowitz/Stegun 7.1.26, Fehler < 1e-7). */
function normalVerteilung(z: number): number {
  const t = 1 / (1 + 0.3275911 * (Math.abs(z) / Math.SQRT2));
  const polynom =
    t *
    (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - polynom * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/**
 * Die Hürde nach `versuche` Varianten (Bonferroni, einseitig 2,5 % insgesamt). Wer 80 Varianten
 * rechnet, findet bei 95 % Sicherheit rund zwei „belegte" ganz ohne Kante — dieselbe Regel
 * muss dann so deutlich über null liegen, dass sie das auch nach 80 Versuchen noch tut.
 */
export function strengeHuerde(versuche: number): number {
  const ziel = 1 - 0.025 / Math.max(1, versuche);
  let unten = 0;
  let oben = 10;
  for (let i = 0; i < 60; i += 1) {
    const mitte = (unten + oben) / 2;
    if (normalVerteilung(mitte) < ziel) unten = mitte;
    else oben = mitte;
  }
  return (unten + oben) / 2;
}

/** Wie viele Standardfehler der Mittelwert über null liegt. */
export function zWert(r: readonly number[]): number {
  if (r.length < 2) return 0;
  const mittel = r.reduce((a, b) => a + b, 0) / r.length;
  const varianz = r.reduce((a, b) => a + (b - mittel) ** 2, 0) / (r.length - 1);
  return varianz > 0 ? mittel / Math.sqrt(varianz / r.length) : 0;
}

// ------------------------------------------------------------------------------ Eine Zeile

export interface Zeile {
  regel: string;
  richtung: Richtungswahl;
  intervall: Intervall;
  sitzung: string;
  anzahl: number;
  trefferquote: number;
  erwartungswertR: number;
  ohneKostenR: number;
  renditeProzent: number;
  konfidenz?: Konfidenz;
  ungesehenR: number;
  /** Handel je Woche, gemittelt über die Märkte mit Kerzen in diesem Zeitrahmen. */
  jeWoche: number;
  maerkteMitHandel: number;
  maerktePositiv: number;
  urteil: Urteil;
  /** Hält „belegt" auch nach allen Versuchen dieses Laufs? Erst am Ende gesetzt. */
  streng?: boolean;
  z: number;
  /** Je Markt: Handel und Erwartungswert — für die CSV-Datei. */
  maerkte: { symbol: string; anzahl: number; erwartungswertR: number }[];
}

interface MarktLauf {
  symbol: string;
  wochen: number;
  /** Je Teil der Regel: die Handel mit und ohne Kosten, und ab wann „ungesehen" gilt. */
  teile: { richtung: "long" | "short"; mit: Handel[]; ohne: Handel[] }[];
  ungesehenAb: number;
}

const mittel = (x: readonly number[]): number =>
  x.length === 0 ? 0 : x.reduce((a, b) => a + b, 0) / x.length;

/** Fasst die Läufe einer Variante über alle Märkte zu einer Zeile zusammen. */
export function zeileAus(
  kopf: Pick<Zeile, "regel" | "richtung" | "intervall" | "sitzung">,
  laeufe: readonly MarktLauf[],
): Zeile {
  const passt = (r: "long" | "short") => kopf.richtung === "beide" || kopf.richtung === r;
  const alleMit: Handel[] = [];
  const alleOhne: Handel[] = [];
  const ungesehen: number[] = [];
  const maerkte: Zeile["maerkte"] = [];
  let wochen = 0;
  for (const lauf of laeufe) {
    const teile = lauf.teile.filter((t) => passt(t.richtung));
    const mit = vereine(teile.map((t) => t.mit)).handel;
    const ohne = vereine(teile.map((t) => t.ohne)).handel;
    alleMit.push(...mit);
    alleOhne.push(...ohne);
    ungesehen.push(...mit.filter((h) => h.einstiegZeit >= lauf.ungesehenAb).map((h) => h.r));
    wochen += lauf.wochen;
    maerkte.push({
      symbol: lauf.symbol,
      anzahl: mit.length,
      erwartungswertR: mittel(mit.map((h) => h.r)),
    });
  }
  const r = alleMit.map((h) => h.r);
  const k = konfidenz(r);
  const ungesehenR = mittel(ungesehen);
  return {
    ...kopf,
    anzahl: r.length,
    trefferquote: r.length === 0 ? 0 : r.filter((x) => x > 0).length / r.length,
    erwartungswertR: mittel(r),
    ohneKostenR: mittel(alleOhne.map((h) => h.r)),
    renditeProzent: mittel(alleMit.map((h) => h.renditeProzent)),
    ...(k ? { konfidenz: k } : {}),
    ungesehenR,
    jeWoche: wochen > 0 ? r.length / wochen : 0,
    maerkteMitHandel: maerkte.filter((m) => m.anzahl > 0).length,
    maerktePositiv: maerkte.filter((m) => m.anzahl > 0 && m.erwartungswertR > 0).length,
    urteil: urteile(r.length, k, ungesehenR),
    z: zWert(r),
    maerkte,
  };
}

/** Setzt `streng` an jeder belegten Zeile — nach der Zahl der Varianten, die überhaupt ein
 *  Urteil bekommen konnten. Zurück kommt diese Zahl und die Hürde. */
export function pruefeMehrfach(zeilen: Zeile[]): { versuche: number; huerde: number } {
  const versuche = zeilen.filter((z) => z.urteil !== "zu wenig Handel").length;
  const huerde = strengeHuerde(versuche);
  for (const z of zeilen) if (z.urteil === "belegt") z.streng = z.z > huerde;
  return { versuche, huerde };
}

// ------------------------------------------------------------------------------ Darstellung

const komma = (x: number, stellen = 2): string => x.toFixed(stellen).replace(".", ",");
const vorz = (x: number, stellen = 2): string =>
  `${x >= 0 ? "+" : "−"}${komma(Math.abs(x), stellen)}`;
const prozent = (x: number): string => `${komma(x * 100, 0)} %`;

function intervallText(k: Konfidenz | undefined): string {
  return k ? `${vorz(k.unten)} bis ${vorz(k.oben)}` : "–";
}

function urteilText(z: Zeile): string {
  if (z.urteil === "belegt") return z.streng ? "**belegt, auch streng**" : "belegt (nicht streng)";
  if (z.urteil === "nicht belegt" && z.konfidenz?.noetigeHandel)
    return `nicht belegt (~${z.konfidenz.noetigeHandel} nötig)`;
  return z.urteil;
}

const KOPF =
  "| Zeitrahmen | Sitzung | Handel | je Woche | Treffer | Ø R (mit Kosten) | 95-%-Intervall | Ø R ohne Kosten | ungesehen | € je Woche | Märkte +/mit Handel | Urteil |";
const TRENN = "|---|---|---:|---:|---:|---:|---|---:|---:|---:|---:|---|";

export function tabellenZeile(z: Zeile): string {
  const euro = z.jeWoche * z.erwartungswertR * RISIKO_EURO;
  return `| ${z.intervall} | ${z.sitzung} | ${z.anzahl} | ${komma(z.jeWoche, 1)} | ${prozent(z.trefferquote)} | ${vorz(z.erwartungswertR)} | ${intervallText(z.konfidenz)} | ${vorz(z.ohneKostenR)} | ${vorz(z.ungesehenR)} | ${vorz(euro, 0)} € | ${z.maerktePositiv}/${z.maerkteMitHandel} | ${urteilText(z)} |`;
}

// ------------------------------------------------------------------------------ Der Lauf

export interface Aufruf {
  /** Kurzname für Dateien und Ausgabe, z. B. `supertrend`. */
  name: string;
  regeln: readonly Quellregel[];
  /** Nur diese Zeitrahmen (`--intervalle 15m,1h`). */
  intervalle?: readonly Intervall[];
  /** Nur diese Märkte (`--maerkte binance:BTCUSDT,^GSPC`). */
  maerkte?: readonly string[];
  /** Keine Sitzungsfenster, nur der ganze Tag (`--ohne-sitzungen`). */
  ohneSitzungen?: boolean;
  /** Den Bericht zusätzlich unter „Analysen" ablegen (`--analyse`). */
  analyse?: boolean;
  workdir?: string;
}

/** Liest die Schalter der Kommandozeile. */
export function schalter(argv: readonly string[]): Omit<Aufruf, "name" | "regeln"> {
  const wert = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const intervalle = wert("--intervalle")?.split(",");
  for (const i of intervalle ?? []) {
    if (!(INTERVALLE as readonly string[]).includes(i))
      throw new Error(`Unbekannter Zeitrahmen „${i}". Möglich: ${INTERVALLE.join(", ")}.`);
  }
  return {
    ...(intervalle ? { intervalle: intervalle as Intervall[] } : {}),
    ...(wert("--maerkte") ? { maerkte: (wert("--maerkte") as string).split(",") } : {}),
    ...(argv.includes("--ohne-sitzungen") ? { ohneSitzungen: true } : {}),
    ...(argv.includes("--analyse") ? { analyse: true } : {}),
  };
}

const TAG = 86_400;

function vonUnix(rueck: string | number, bis: number): number {
  return typeof rueck === "number"
    ? bis - rueck * TAG
    : Math.floor(Date.parse(`${rueck}T00:00:00Z`) / 1000);
}

export async function rechneNach(aufruf: Aufruf): Promise<Zeile[]> {
  const workdir = aufruf.workdir ?? process.env.KURO_WORKDIR ?? "/opt/kuronami/workspace";
  const quelle = createKerzenquelle({ workdir });
  const heute = new Date();
  const bis = Math.floor(
    Date.UTC(heute.getUTCFullYear(), heute.getUTCMonth(), heute.getUTCDate()) / 1000,
  );
  const intervalle = aufruf.intervalle ?? INTERVALLE;
  const maerkte = aufruf.maerkte ?? [...KRYPTO, ...BOERSE];
  const log = (s: string) => console.error(s);

  // Kerzen einmal je Markt und Zeitrahmen — alle Regeln rechnen auf denselben.
  const kerzen = new Map<string, { symbol: string; kerzen: MarketCandle[] }>();
  const fehlt: string[] = [];
  for (const intervall of intervalle) {
    log(`Kerzen ${intervall} …`);
    for (const symbol of maerkte) {
      const binance = symbol.startsWith("binance:");
      const rueck = RUECKBLICK[intervall][binance ? "binance" : "yahoo"];
      try {
        const g = await quelle.hole({
          symbol,
          intervall: intervall as ChartInterval,
          vonUnix: vonUnix(rueck, bis),
          bisUnix: bis,
        });
        if (g.kerzen.length < 250) {
          fehlt.push(`${symbol} ${intervall}: nur ${g.kerzen.length} Kerzen`);
          continue;
        }
        kerzen.set(`${symbol}|${intervall}`, { symbol, kerzen: g.kerzen });
        log(`  ${symbol}: ${g.kerzen.length} Kerzen (${g.neuGeholt} neu)`);
      } catch (e) {
        fehlt.push(`${symbol} ${intervall}: ${(e as Error).message.slice(0, 120)}`);
      }
    }
  }

  const zeilen: Zeile[] = [];
  const abgewiesen = new Map<string, number>();
  for (const regel of aufruf.regeln) {
    for (const intervall of intervalle) {
      const sitzungen =
        intervall === "1d" || aufruf.ohneSitzungen ? SITZUNGEN.slice(0, 1) : SITZUNGEN;
      for (const sitzung of sitzungen) {
        const laeufe: MarktLauf[] = [];
        for (const symbol of maerkte) {
          const reihe = kerzen.get(`${symbol}|${intervall}`);
          if (!reihe) continue;
          const lauf: MarktLauf = {
            symbol,
            wochen: (reihe.kerzen[reihe.kerzen.length - 1].time - reihe.kerzen[0].time) / (7 * TAG),
            teile: [],
            ungesehenAb: Number.POSITIVE_INFINITY,
          };
          for (const teil of regel.teile) {
            const mitFenster: Strategie = {
              ...teil.strategie,
              ...(sitzung.fenster ? { zone: sitzung.zone, fenster: sitzung.fenster } : {}),
            };
            try {
              const mit = backtest(mitFenster, reihe.kerzen, { symbol, intervall });
              const ohne = backtest(
                { ...mitFenster, gebuehrProzent: 0, schlupfProzent: 0 },
                reihe.kerzen,
                { symbol, intervall },
              );
              lauf.teile.push({
                richtung: teil.strategie.richtung,
                mit: mit.handel,
                ohne: ohne.handel,
              });
              lauf.ungesehenAb = Math.floor(Date.parse(`${mit.outOfSample.von}T00:00:00Z`) / 1000);
            } catch (e) {
              const grund = (e as Error).message.slice(0, 100);
              abgewiesen.set(grund, (abgewiesen.get(grund) ?? 0) + 1);
            }
          }
          if (lauf.teile.length > 0) laeufe.push(lauf);
        }
        for (const richtung of RICHTUNGEN) {
          const gibt = regel.teile.some(
            (t) => richtung === "beide" || t.strategie.richtung === richtung,
          );
          if (!gibt) continue;
          zeilen.push(
            zeileAus({ regel: regel.titel, richtung, intervall, sitzung: sitzung.name }, laeufe),
          );
        }
      }
      log(`${regel.titel} · ${intervall} gerechnet`);
    }
  }
  const { versuche, huerde } = pruefeMehrfach(zeilen);

  // ------------------------------------------------------------------ Bericht
  const datum = heute.toISOString().slice(0, 10);
  const teile: string[] = [
    `# Nachgerechnet: ${aufruf.regeln.map((r) => r.titel).join(" · ")}`,
    "",
    `Gerechnet am ${datum} mit \`werkzeuge/nachrechnen/${aufruf.name}.ts\`. Zeitrahmen ${intervalle.join(", ")}; ${maerkte.length} Märkte; Sitzungen ${aufruf.ohneSitzungen ? "keine" : SITZUNGEN.map((s) => s.name).join(", ")} (Einstieg nur im Fenster, am Ende glattgestellt). Kosten 0,1 % Gebühr + 0,05 % Schlupf je Seite; „ohne Kosten“ zeigt, ob überhaupt eine Kante da ist, bevor die Kosten sie fressen.`,
    "",
    `**Urteil wie in der Strategie-Ablage:** erst ab ${HANDEL_FUER_URTEIL} Handeln über alle Märkte zusammen; belegt, wenn das 95-%-Intervall ganz über null liegt und der ungesehene Teil (die letzten 30 % jedes Marktes) im Plus ist; widerlegt nur ganz unter null. „Ø R“ ist der Durchschnitt je Handel, Verlierer eingerechnet. „€ je Woche“: Handel je Woche und Markt × Ø R × 15 € Risiko.`,
    "",
    `**Mehrfachtest:** ${versuche} Varianten konnten ein Urteil bekommen. Ohne jede Kante wären davon rund ` +
      `${komma(versuche * 0.025, 1)} zufällig „belegt“. „Streng belegt“ heißt: der Mittelwert liegt mehr als ` +
      `${komma(huerde, 2)} Standardfehler über null — so deutlich, dass es auch nach ${versuche} Versuchen kein Zufall ist.`,
    "",
  ];
  const belegt = zeilen.filter((z) => z.urteil === "belegt");
  teile.push(
    "## Ergebnis",
    "",
    belegt.length === 0
      ? "Keine Variante ist belegt."
      : [
          `${belegt.length} Variante(n) belegt, davon ${belegt.filter((z) => z.streng).length} auch streng:`,
          "",
          `| Regel | Richtung |${KOPF.slice(1)}`,
          `|---|---${TRENN.slice(0)}`,
          ...belegt.map((z) => `| ${z.regel} | ${z.richtung} ${tabellenZeile(z)}`),
        ].join("\n"),
    "",
  );
  for (const regel of aufruf.regeln) {
    teile.push(
      `## ${regel.titel}`,
      "",
      `Video: https://www.youtube.com/watch?v=${regel.video} · Behauptung: ${regel.behauptung}`,
      "",
    );
    teile.push(
      "**Regeln aus dem Video:**",
      "",
      ...regel.belege.map((b) => `- ${b.zeit}: ${b.regel}`),
      "",
    );
    teile.push("**Annahmen:**", "", ...regel.annahmen.map((a) => `- ${a}`), "");
    if (regel.nichtPruefbar.length > 0)
      teile.push("**Nicht gerechnet:**", "", ...regel.nichtPruefbar.map((n) => `- ${n}`), "");
    for (const richtung of RICHTUNGEN) {
      const eigene = zeilen.filter((z) => z.regel === regel.titel && z.richtung === richtung);
      if (eigene.length === 0) continue;
      teile.push(
        `### ${richtung === "beide" ? "Long und short in einem Konto" : richtung}`,
        "",
        KOPF,
        TRENN,
        ...eigene.map(tabellenZeile),
        "",
      );
    }
  }
  if (fehlt.length > 0) teile.push("## Ohne Kerzen", "", ...fehlt.map((f) => `- ${f}`), "");
  if (abgewiesen.size > 0)
    teile.push(
      "## Vom Backtest abgewiesen",
      "",
      ...[...abgewiesen].map(([grund, n]) => `- ${n}×: ${grund}`),
      "",
    );
  const bericht = teile.join("\n");

  const ordner = path.join(workdir, "wissen", "tradinglab", "nachrechnung");
  await mkdir(ordner, { recursive: true });
  const md = path.join(ordner, `${aufruf.name}-${datum}.md`);
  const csv = path.join(ordner, `${aufruf.name}-${datum}.csv`);
  await writeFile(md, bericht);
  await writeFile(
    csv,
    [
      "regel;richtung;zeitrahmen;sitzung;markt;handel;ø_r",
      ...zeilen.flatMap((z) =>
        z.maerkte.map((m) =>
          [
            z.regel,
            z.richtung,
            z.intervall,
            z.sitzung,
            m.symbol,
            m.anzahl,
            komma(m.erwartungswertR, 3),
          ].join(";"),
        ),
      ),
    ].join("\n"),
  );
  if (aufruf.analyse) {
    await createAnalysen({ workdir }).lege({
      wer: "nachrechnung",
      auftrag: `Nachrechnen über alle Zeitrahmen, Sitzungen und Märkte: ${aufruf.regeln.map((r) => r.titel).join(" · ")}`,
      bericht,
      beitraege: [],
      kostenUsd: 0,
      dauerMs: 0,
      hatIdee: false,
    });
  }

  // ------------------------------------------------------------------ Kurzfassung im Terminal
  const aus = (s = "") => console.log(s);
  aus();
  aus(`${aufruf.regeln.map((r) => r.titel).join(" · ")}`);
  aus(`${zeilen.length} Varianten, ${versuche} mit genug Handeln für ein Urteil.`);
  aus();
  aus("Long und short in einem Konto, ganzer Tag, mit Kosten:");
  for (const z of zeilen.filter((x) => x.richtung === "beide" && x.sitzung === "ganzer Tag")) {
    aus(
      `  ${aufruf.regeln.length > 1 ? `${z.regel.slice(0, 28).padEnd(29)}` : ""}${z.intervall.padEnd(4)} ${String(z.anzahl).padStart(6)} Handel  ${prozent(z.trefferquote).padStart(5)} Treffer  Ø ${vorz(z.erwartungswertR)} R  [${intervallText(z.konfidenz)}]  ohne Kosten ${vorz(z.ohneKostenR)} R  → ${z.urteil}`,
    );
  }
  aus();
  aus(
    belegt.length === 0
      ? "Belegt: keine Variante."
      : `Belegt: ${belegt.length}, davon streng ${belegt.filter((z) => z.streng).length}:`,
  );
  for (const z of belegt) {
    aus(
      `  ${z.regel.slice(0, 28)} · ${z.richtung} · ${z.intervall} · ${z.sitzung}: ${z.anzahl} Handel, Ø ${vorz(z.erwartungswertR)} R, ungesehen ${vorz(z.ungesehenR)} R${z.streng ? " — streng" : ""}`,
    );
  }
  aus(`Ohne jede Kante wären rund ${komma(versuche * 0.025, 1)} Varianten zufällig „belegt“.`);
  aus();
  aus(`Bericht: ${md}`);
  aus(`Alle Märkte einzeln: ${csv}`);
  if (aufruf.analyse) aus("Abgelegt unter Analysen.");
  return zeilen;
}
