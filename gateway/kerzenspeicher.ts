/**
 * Der Kerzenspeicher — die Historie liegt hier, nicht beim Anbieter.
 *
 * **Warum überhaupt ein Speicher.** Ein Backtest über fünf Jahre Minutenkerzen sind 2,6
 * Millionen Kerzen und rund 2.600 Abrufe bei Binance. Sie bei jedem Lauf neu zu ziehen wäre
 * langsam, unhöflich gegenüber dem Anbieter — und vor allem **nicht wiederholbar**: der
 * Anbieter darf seine Historie jederzeit korrigieren, und ein Backtest, dessen Datengrundlage
 * sich zwischen zwei Läufen stillschweigend ändert, ist keine Prüfung, sondern eine Umfrage.
 * Was hier liegt, liegt fest; eine Korrektur ist eine sichtbare Handlung.
 *
 * **Warum CSV und nicht etwas Schnelleres.** Weil Jakobs Maßstab am Handelstisch „nachrechnen
 * können" ist. Eine Kerzendatei, die sich mit `head` ansehen und in jede Tabelle ziehen lässt,
 * erfüllt ihn; ein Binärformat wäre kleiner und schneller und würde ihn brechen. Die Kosten
 * sind erträglich: ein Jahr Minutenkerzen ist rund 20 MB.
 *
 * **Warum nach Monaten geteilt.** Ein Fenster von drei Tagen soll nicht 160 MB lesen müssen,
 * und ein abgebrochener Download soll dort weitermachen, wo er aufgehört hat. Die Monatsgrenze
 * läuft nach **UTC** — nicht nach der Börsenzeitzone. Das ist Absicht: der Dateiname ist eine
 * Ablage-Entscheidung und darf nicht davon abhängen, in welcher Zone jemand später einen VWAP
 * ankert. Die Zone gehört in den Indikator (`vwap`, `imFenster`), nicht in den Dateinamen.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SEKUNDEN_JE_KERZE } from "./integrations/binance.js";
import type { ChartInterval, MarketCandle } from "./integrations/markets.js";

/** Woher die Kerzen stammen. Teil des Pfades, damit sich zwei Quellen nie vermischen. */
export type Quelle = "binance" | "yahoo";

const QUELLEN: readonly Quelle[] = ["binance", "yahoo"];

export interface SpeicherOrt {
  wurzel: string;
  quelle: Quelle;
  symbol: string;
  intervall: ChartInterval;
}

const KOPFZEILE = "zeit,open,high,low,close,volumen";

/** Nur Zeichen, die in einem Pfad nichts anrichten können — der Symbolname kommt vom Modell. */
const SICHER = /^[A-Za-z0-9.^=\-]{1,20}$/;

export class SpeicherFehler extends Error {}

function pruefe(ort: SpeicherOrt): void {
  if (!QUELLEN.includes(ort.quelle)) {
    throw new SpeicherFehler(`Unbekannte Quelle "${ort.quelle}".`);
  }
  if (!SICHER.test(ort.symbol)) {
    throw new SpeicherFehler(`"${ort.symbol}" taugt nicht als Symbolname für eine Ablage.`);
  }
}

/** `2024-03` aus Unix-Sekunden, in UTC. */
export function monatVon(unixSekunden: number): string {
  return new Date(unixSekunden * 1000).toISOString().slice(0, 7);
}

/** Alle Monate von `von` bis `bis` (ausschließlich), aufsteigend. */
export function monateZwischen(vonUnix: number, bisUnix: number): string[] {
  const raus: string[] = [];
  const zeiger = new Date(vonUnix * 1000);
  zeiger.setUTCDate(1);
  zeiger.setUTCHours(0, 0, 0, 0);
  const ende = bisUnix * 1000;
  while (zeiger.getTime() < ende) {
    raus.push(zeiger.toISOString().slice(0, 7));
    zeiger.setUTCMonth(zeiger.getUTCMonth() + 1);
  }
  return raus;
}

export function ordnerFuer(ort: SpeicherOrt): string {
  pruefe(ort);
  return path.join(ort.wurzel, "kerzen", ort.quelle, ort.symbol, ort.intervall);
}

export function dateiFuer(ort: SpeicherOrt, monat: string): string {
  return path.join(ordnerFuer(ort), `${monat}.csv`);
}

/**
 * Eine Zeile schreiben.
 *
 * Die Kurse gehen als `String(zahl)` hinaus, nicht mit fester Nachkommastelle: eine Rundung
 * hier wäre eine stille Änderung der Daten. Fehlendes Volumen bleibt ein **leeres Feld** und
 * wird nicht zu `0` — der Unterschied zwischen „hat nicht gehandelt" und „wir wissen es nicht"
 * ist genau der, an dem ein VWAP oder ein OBV kippt.
 */
function zeileVon(k: MarketCandle): string {
  return `${k.time},${k.open},${k.high},${k.low},${k.close},${k.volume ?? ""}`;
}

function kerzeVon(zeile: string): MarketCandle | null {
  const teile = zeile.split(",");
  if (teile.length < 5) return null;
  const zahlen = teile.slice(0, 5).map(Number);
  if (zahlen.some((z) => !Number.isFinite(z))) return null;
  const [time, open, high, low, close] = zahlen as [number, number, number, number, number];
  const rohVolumen = teile[5];
  const volumen =
    rohVolumen === undefined || rohVolumen.trim() === "" ? undefined : Number(rohVolumen);
  return {
    time,
    open,
    high,
    low,
    close,
    ...(volumen !== undefined && Number.isFinite(volumen) ? { volume: volumen } : {}),
  };
}

async function leseMonat(ort: SpeicherOrt, monat: string): Promise<MarketCandle[]> {
  let inhalt: string;
  try {
    inhalt = await readFile(dateiFuer(ort, monat), "utf8");
  } catch (fehler) {
    if ((fehler as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw fehler;
  }
  const kerzen: MarketCandle[] = [];
  for (const zeile of inhalt.split("\n")) {
    const sauber = zeile.trim();
    if (sauber === "" || sauber === KOPFZEILE) continue;
    const kerze = kerzeVon(sauber);
    if (kerze !== null) kerzen.push(kerze);
  }
  return kerzen;
}

/** Kerzen aus dem Speicher, Fenster `[von, bis)`, aufsteigend. */
export async function lade(
  ort: SpeicherOrt,
  vonUnix: number,
  bisUnix: number,
): Promise<MarketCandle[]> {
  const raus: MarketCandle[] = [];
  for (const monat of monateZwischen(vonUnix, bisUnix)) {
    for (const kerze of await leseMonat(ort, monat)) {
      if (kerze.time >= vonUnix && kerze.time < bisUnix) raus.push(kerze);
    }
  }
  raus.sort((a, b) => a.time - b.time);
  return raus;
}

export interface SicherungsErgebnis {
  /** Wie viele Kerzen danach insgesamt in den berührten Monaten liegen. */
  gesamt: number;
  /** Wie viele davon neu hinzugekommen sind. */
  neu: number;
  /** Wie viele vorhandene Kerzen durch eine andere Fassung ersetzt wurden. */
  berichtigt: number;
  monate: string[];
}

/**
 * Kerzen ablegen — zusammengeführt, nicht angehängt.
 *
 * Ein neuer Abruf überlappt fast immer mit dem, was schon da liegt. Stumpfes Anhängen erzeugt
 * Doppelte, und ein Indikator über eine doppelte Kerzenreihe rechnet mit einer Periode, die es
 * nicht gibt. Deshalb wird je Zeitstempel zusammengeführt. **Weicht eine neue Kerze von der
 * gespeicherten ab, gewinnt die neue — und es wird gezählt.** Eine stille Berichtigung wäre
 * genau die Sorte Änderung, gegen die dieser Speicher überhaupt gebaut ist; die Zahl steht
 * deshalb im Ergebnis und gehört in den Bericht.
 */
export async function sichere(
  ort: SpeicherOrt,
  kerzen: readonly MarketCandle[],
): Promise<SicherungsErgebnis> {
  const nachMonat = new Map<string, MarketCandle[]>();
  for (const kerze of kerzen) {
    const monat = monatVon(kerze.time);
    const liste = nachMonat.get(monat);
    if (liste === undefined) nachMonat.set(monat, [kerze]);
    else liste.push(kerze);
  }

  const ergebnis: SicherungsErgebnis = { gesamt: 0, neu: 0, berichtigt: 0, monate: [] };
  if (nachMonat.size === 0) return ergebnis;

  await mkdir(ordnerFuer(ort), { recursive: true });
  for (const monat of [...nachMonat.keys()].sort()) {
    const vorhanden = await leseMonat(ort, monat);
    const zusammen = new Map<number, MarketCandle>();
    for (const kerze of vorhanden) zusammen.set(kerze.time, kerze);
    for (const kerze of nachMonat.get(monat) ?? []) {
      const alt = zusammen.get(kerze.time);
      if (alt === undefined) ergebnis.neu += 1;
      else if (zeileVon(alt) !== zeileVon(kerze)) ergebnis.berichtigt += 1;
      zusammen.set(kerze.time, kerze);
    }
    const sortiert = [...zusammen.values()].sort((a, b) => a.time - b.time);
    const inhalt = `${KOPFZEILE}\n${sortiert.map(zeileVon).join("\n")}\n`;
    await writeFile(dateiFuer(ort, monat), inhalt, "utf8");
    ergebnis.gesamt += sortiert.length;
    ergebnis.monate.push(monat);
  }
  return ergebnis;
}

export interface Bestand {
  monate: { monat: string; kerzen: number; von: number; bis: number }[];
  kerzen: number;
  von?: number;
  bis?: number;
}

/** Was liegt überhaupt da? Grundlage für „lade, was fehlt" und für einen ehrlichen Bericht. */
export async function bestand(ort: SpeicherOrt): Promise<Bestand> {
  let dateien: string[];
  try {
    dateien = await readdir(ordnerFuer(ort));
  } catch (fehler) {
    if ((fehler as NodeJS.ErrnoException).code === "ENOENT") return { monate: [], kerzen: 0 };
    throw fehler;
  }
  const raus: Bestand = { monate: [], kerzen: 0 };
  for (const datei of dateien.filter((d) => d.endsWith(".csv")).sort()) {
    const monat = datei.slice(0, -4);
    const kerzen = await leseMonat(ort, monat);
    if (kerzen.length === 0) continue;
    raus.monate.push({
      monat,
      kerzen: kerzen.length,
      von: kerzen[0].time,
      bis: kerzen[kerzen.length - 1].time,
    });
    raus.kerzen += kerzen.length;
  }
  if (raus.monate.length > 0) {
    raus.von = raus.monate[0].von;
    raus.bis = raus.monate[raus.monate.length - 1].bis;
  }
  return raus;
}

export interface Luecke {
  von: number;
  bis: number;
  fehlendeKerzen: number;
}

/**
 * Lücken in einer Kerzenreihe.
 *
 * **Eine Lücke ist nicht automatisch ein Fehler** — Aktien handeln nachts nicht, und auch
 * Binance hat Wartungsfenster. Sie ist aber immer eine Auskunft, die in den Bericht gehört:
 * ein Backtest über eine Reihe mit einem fehlenden Halbjahr sieht genauso aus wie einer über
 * eine vollständige, und nur diese Zahl verrät den Unterschied.
 */
export function luecken(
  kerzen: readonly MarketCandle[],
  intervall: ChartInterval,
  abFaktor = 2,
): Luecke[] {
  const schritt = SEKUNDEN_JE_KERZE[intervall];
  const raus: Luecke[] = [];
  for (let i = 1; i < kerzen.length; i += 1) {
    const abstand = kerzen[i].time - kerzen[i - 1].time;
    if (abstand > schritt * abFaktor) {
      raus.push({
        von: kerzen[i - 1].time,
        bis: kerzen[i].time,
        fehlendeKerzen: Math.round(abstand / schritt) - 1,
      });
    }
  }
  return raus;
}
