import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Richtung } from "./crv.js";
import type { MarketCandle, MarketChart } from "./integrations/markets.js";

/**
 * Der Bar-Replay: den Markt Kerze für Kerze noch einmal durchlaufen, mit verdeckter Zukunft.
 *
 * Jakobs Vorbild ist der Wiedergabe-Modus bei TradingView — Startzeitpunkt wählen, alles
 * Spätere verschwindet, dann Kerze für Kerze vorgehen und jedes erkannte Setup als Handel ins
 * Tagebuch schreiben. Für ein Team aus Sprachmodellen ist das die ehrlichere Prüfung als jede
 * Selbstverpflichtung: **die Daten, die es nicht sehen darf, bekommt es nicht.**
 *
 * Der Unterschied zum Regel-Backtest (`backtest.ts`) ist der Unterschied zwischen Urteil und
 * Verfahren. Hier wird geprüft, ob die *Einschätzung* des Analysten trägt — mit allem, was
 * sich nicht in Regeln fassen lässt. Dort wird geprüft, ob eine *Regel* trägt, und nur eine
 * Regel kann später von selbst laufen. Beides ist nötig, und beides prüft etwas anderes.
 *
 * **Was hier nicht passiert: Handel zum Kurs der Kerze, die gerade entschieden wurde.** Ein
 * Handel wird zur Eröffnung der **nächsten** Kerze angelegt. Wer eine Kerze sieht und zu ihrem
 * Schlusskurs kauft, handelt mit einer Sekunde Vorsprung, die es nie gab.
 */

export interface ReplayHandel {
  nummer: number;
  richtung: Richtung;
  /** Index der Kerze, zu deren Eröffnung eingestiegen wurde. */
  einstiegIndex: number;
  einstiegZeit: number;
  einstieg: number;
  stop: number;
  ziele: number[];
  begruendung: string;
  offen: boolean;
  ausstiegZeit?: number;
  ausstieg?: number;
  grund?: "stop" | "ziel" | "hand" | "ende";
  zielNummer?: number;
  r?: number;
}

export interface ReplayStand {
  id: string;
  symbol: string;
  intervall: string;
  /** Datum der Kerze, auf der die Wiedergabe gerade steht. */
  jetzt: string;
  gesehen: number;
  verbleibend: number;
  handel: ReplayHandel[];
}

export interface ReplayBilanz {
  anzahl: number;
  offen: number;
  trefferquote: number;
  summeR: number;
  erwartungswertR: number;
  profitFaktor: number;
  bestesR: number;
  schlechtestesR: number;
}

interface Sitzung {
  id: string;
  symbol: string;
  name: string;
  intervall: string;
  kerzen: MarketCandle[];
  /** Index der zuletzt aufgedeckten Kerze. */
  zeiger: number;
  /** Wo die Wiedergabe begann — alles davor war Vorlauf. */
  startIndex: number;
  handel: ReplayHandel[];
  erstellt: number;
  beruehrt: number;
}

/**
 * Die Sitzungen liegen im Prozess, nicht in der Datenbank: eine Wiedergabe ist eine Arbeit von
 * Minuten, kein Zustand, der einen Neustart überleben muss. Die Obergrenze verhindert, dass ein
 * vergessener Lauf den Speicher füllt — die älteste Sitzung fällt heraus.
 */
const SITZUNGEN = new Map<string, Sitzung>();
const MAX_SITZUNGEN = 8;
const ALTER_MS = 6 * 60 * 60 * 1000;

function aufraeumen(): void {
  const jetzt = Date.now();
  for (const [id, sitzung] of SITZUNGEN) {
    if (jetzt - sitzung.beruehrt > ALTER_MS) SITZUNGEN.delete(id);
  }
  while (SITZUNGEN.size >= MAX_SITZUNGEN) {
    const aeltester = [...SITZUNGEN.values()].sort((a, b) => a.beruehrt - b.beruehrt)[0];
    if (!aeltester) break;
    SITZUNGEN.delete(aeltester.id);
  }
}

function kennung(): string {
  return Array.from({ length: 8 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join(
    "",
  );
}

export function tag(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

function zahl(wert: number): string {
  const betrag = Math.abs(wert);
  return wert.toFixed(betrag >= 1000 ? 2 : betrag >= 1 ? 3 : 6);
}

export class ReplayFehler extends Error {}

/**
 * Eine Wiedergabe beginnen. `abDatum` ist der Startzeitpunkt: alles davor ist sichtbarer
 * Vorlauf, alles danach verdeckt.
 */
export function starte(chart: MarketChart, abDatum: string): Sitzung {
  const ab = Math.floor(new Date(`${abDatum}T00:00:00Z`).getTime() / 1000);
  const startIndex = chart.candles.findIndex((k) => k.time >= ab);
  if (chart.candles.length === 0) {
    throw new ReplayFehler("Für diesen Zeitraum kamen keine Kerzen.");
  }
  if (startIndex <= 0) {
    throw new ReplayFehler(
      `Zum ${abDatum} gibt es keinen Vorlauf im geladenen Zeitraum. Lade mehr Tage davor, sonst startet die Wiedergabe blind.`,
    );
  }
  if (startIndex >= chart.candles.length - 1) {
    throw new ReplayFehler(
      `Ab ${abDatum} liegt fast nichts mehr — die Wiedergabe hätte nichts abzuspielen.`,
    );
  }
  aufraeumen();
  const sitzung: Sitzung = {
    id: kennung(),
    symbol: chart.symbol,
    name: chart.name,
    intervall: chart.interval,
    kerzen: [...chart.candles],
    zeiger: startIndex,
    startIndex,
    handel: [],
    erstellt: Date.now(),
    beruehrt: Date.now(),
  };
  SITZUNGEN.set(sitzung.id, sitzung);
  return sitzung;
}

export function hole(id: string): Sitzung {
  const sitzung = SITZUNGEN.get(id);
  if (!sitzung) {
    throw new ReplayFehler(
      `Keine Wiedergabe mit der Kennung ${id}. Entweder ist sie abgelaufen oder der Gateway wurde neu gestartet — dann fang neu an.`,
    );
  }
  sitzung.beruehrt = Date.now();
  return sitzung;
}

/** Die Kerzen, die gerade sichtbar sind — höchstens `grenze`, die jüngsten zuletzt. */
export function sichtbar(sitzung: Sitzung, grenze = 60): MarketCandle[] {
  const bis = sitzung.zeiger + 1;
  return sitzung.kerzen.slice(Math.max(0, bis - grenze), bis);
}

/**
 * Einen Schritt weiter. Prüft dabei jede offene Position gegen die neu aufgedeckte Kerze —
 * Stop vor Ziel, wenn beide in dieselbe Kerze fallen.
 */
export function weiter(
  sitzung: Sitzung,
  schritte = 1,
): { neu: MarketCandle[]; ereignisse: string[] } {
  const ereignisse: string[] = [];
  const neu: MarketCandle[] = [];
  for (let s = 0; s < schritte; s += 1) {
    if (sitzung.zeiger >= sitzung.kerzen.length - 1) {
      ereignisse.push("Das Ende des geladenen Zeitraums ist erreicht.");
      break;
    }
    sitzung.zeiger += 1;
    const kerze = sitzung.kerzen[sitzung.zeiger];
    neu.push(kerze);

    for (const handel of sitzung.handel) {
      if (!handel.offen || sitzung.zeiger <= handel.einstiegIndex) continue;
      const long = handel.richtung === "long";
      const risiko = Math.abs(handel.einstieg - handel.stop);
      const stopGetroffen = long ? kerze.low <= handel.stop : kerze.high >= handel.stop;
      if (stopGetroffen) {
        handel.offen = false;
        handel.ausstieg = handel.stop;
        handel.ausstiegZeit = kerze.time;
        handel.grund = "stop";
        handel.r = -1;
        ereignisse.push(`Handel ${handel.nummer} ausgestoppt am ${tag(kerze.time)} (−1,00 R).`);
        continue;
      }
      const ziele = [...handel.ziele].sort((a, b) => (long ? a - b : b - a));
      for (let z = ziele.length - 1; z >= 0; z -= 1) {
        const ziel = ziele[z];
        const erreicht = long ? kerze.high >= ziel : kerze.low <= ziel;
        if (erreicht) {
          handel.offen = false;
          handel.ausstieg = ziel;
          handel.ausstiegZeit = kerze.time;
          handel.grund = "ziel";
          handel.zielNummer = z + 1;
          handel.r = risiko > 0 ? Math.abs(ziel - handel.einstieg) / risiko : 0;
          ereignisse.push(
            `Handel ${handel.nummer} erreicht Ziel ${z + 1} am ${tag(kerze.time)} (+${(handel.r ?? 0).toFixed(2)} R).`,
          );
          break;
        }
      }
    }
  }
  return { neu, ereignisse };
}

/**
 * Einen Handel eintragen. Eingestiegen wird zur Eröffnung der **nächsten** Kerze — der Kurs,
 * den man bekäme, wenn man jetzt entscheidet.
 */
export function handeln(
  sitzung: Sitzung,
  eingabe: { richtung: Richtung; stop: number; ziele: number[]; begruendung: string },
): ReplayHandel {
  if (sitzung.handel.some((h) => h.offen)) {
    throw new ReplayFehler(
      "Es läuft noch ein Handel. Erst glattstellen oder auslaufen lassen — zwei Positionen gleichzeitig prüfen heißt, keine von beiden sauber zu prüfen.",
    );
  }
  const naechste = sitzung.kerzen[sitzung.zeiger + 1];
  if (!naechste) {
    throw new ReplayFehler(
      "Keine Kerze mehr übrig, zu deren Eröffnung eingestiegen werden könnte.",
    );
  }
  const einstieg = naechste.open;
  const long = eingabe.richtung === "long";
  if (long && eingabe.stop >= einstieg) {
    throw new ReplayFehler(
      `Long mit Stop ${eingabe.stop} über dem Einstieg ${zahl(einstieg)} — der Stop liegt auf der falschen Seite.`,
    );
  }
  if (!long && eingabe.stop <= einstieg) {
    throw new ReplayFehler(
      `Short mit Stop ${eingabe.stop} unter dem Einstieg ${zahl(einstieg)} — der Stop liegt auf der falschen Seite.`,
    );
  }
  for (const ziel of eingabe.ziele) {
    if (long ? ziel <= einstieg : ziel >= einstieg) {
      throw new ReplayFehler(`Das Ziel ${ziel} liegt auf der falschen Seite des Einstiegs.`);
    }
  }
  const handel: ReplayHandel = {
    nummer: sitzung.handel.length + 1,
    richtung: eingabe.richtung,
    einstiegIndex: sitzung.zeiger + 1,
    einstiegZeit: naechste.time,
    einstieg,
    stop: eingabe.stop,
    ziele: [...eingabe.ziele],
    begruendung: eingabe.begruendung,
    offen: true,
  };
  sitzung.handel.push(handel);
  return handel;
}

/** Von Hand glattstellen — zum Schlusskurs der aktuell sichtbaren Kerze. */
export function stellGlatt(sitzung: Sitzung): ReplayHandel {
  const handel = sitzung.handel.find((h) => h.offen);
  if (!handel) throw new ReplayFehler("Es läuft kein Handel.");
  const kerze = sitzung.kerzen[sitzung.zeiger];
  const long = handel.richtung === "long";
  const risiko = Math.abs(handel.einstieg - handel.stop);
  handel.offen = false;
  handel.ausstieg = kerze.close;
  handel.ausstiegZeit = kerze.time;
  handel.grund = "hand";
  handel.r =
    risiko > 0
      ? (long ? kerze.close - handel.einstieg : handel.einstieg - kerze.close) / risiko
      : 0;
  return handel;
}

export function bilanz(handel: readonly ReplayHandel[]): ReplayBilanz {
  const fertig = handel.filter((h) => !h.offen && typeof h.r === "number");
  const rs = fertig.map((h) => h.r as number);
  const gewinne = rs.filter((r) => r > 0);
  const verluste = rs.filter((r) => r <= 0);
  const summe = rs.reduce((a, b) => a + b, 0);
  return {
    anzahl: fertig.length,
    offen: handel.filter((h) => h.offen).length,
    trefferquote: fertig.length > 0 ? gewinne.length / fertig.length : 0,
    summeR: summe,
    erwartungswertR: fertig.length > 0 ? summe / fertig.length : 0,
    profitFaktor:
      verluste.length > 0
        ? gewinne.reduce((a, b) => a + b, 0) / Math.abs(verluste.reduce((a, b) => a + b, 0))
        : gewinne.length > 0
          ? Number.POSITIVE_INFINITY
          : 0,
    bestesR: rs.length > 0 ? Math.max(...rs) : 0,
    schlechtestesR: rs.length > 0 ? Math.min(...rs) : 0,
  };
}

export function stand(sitzung: Sitzung): ReplayStand {
  return {
    id: sitzung.id,
    symbol: sitzung.symbol,
    intervall: sitzung.intervall,
    jetzt: tag(sitzung.kerzen[sitzung.zeiger].time),
    gesehen: sitzung.zeiger - sitzung.startIndex + 1,
    verbleibend: sitzung.kerzen.length - 1 - sitzung.zeiger,
    handel: sitzung.handel,
  };
}

/** Die Kerzentabelle, wie der Analyst sie liest. */
export function formatiereKerzen(kerzen: readonly MarketCandle[]): string {
  return kerzen
    .map((k) => [tag(k.time), zahl(k.open), zahl(k.high), zahl(k.low), zahl(k.close)].join("  "))
    .join("\n");
}

export function formatiereStand(sitzung: Sitzung): string {
  const s = stand(sitzung);
  const b = bilanz(sitzung.handel);
  const zeilen = [
    `Wiedergabe ${s.id} · ${sitzung.symbol} (${sitzung.name}) · ${s.intervall}`,
    `Steht auf ${s.jetzt} — ${s.gesehen} Kerzen abgespielt, ${s.verbleibend} noch verdeckt.`,
    "",
    `Tagebuch: ${b.anzahl} abgeschlossen, ${b.offen} offen.`,
  ];
  if (b.anzahl > 0) {
    zeilen.push(
      `Trefferquote ${(b.trefferquote * 100).toFixed(0)} %, Summe ${b.summeR >= 0 ? "+" : ""}${b.summeR.toFixed(2)} R, ` +
        `Erwartungswert ${b.erwartungswertR.toFixed(2)} R je Handel, Profitfaktor ${b.profitFaktor === Number.POSITIVE_INFINITY ? "∞" : b.profitFaktor.toFixed(2)}`,
      `Bester ${b.bestesR.toFixed(2)} R, schlechtester ${b.schlechtestesR.toFixed(2)} R`,
    );
  }
  if (sitzung.handel.length > 0) {
    zeilen.push("", "Nr  Richtung  Einstieg   Stop      Ausgang");
    for (const h of sitzung.handel) {
      const ausgang = h.offen
        ? "läuft"
        : `${h.grund}${h.zielNummer ? ` ${h.zielNummer}` : ""} ${(h.r ?? 0) >= 0 ? "+" : ""}${(h.r ?? 0).toFixed(2)} R`;
      zeilen.push(
        `${String(h.nummer).padEnd(3)} ${h.richtung.padEnd(9)} ${zahl(h.einstieg).padEnd(10)} ${zahl(h.stop).padEnd(9)} ${ausgang}`,
      );
    }
  }
  return zeilen.join("\n");
}

/**
 * Das Tagebuch auf die Platte — die Entsprechung zu der Excel-Tabelle, die ein Mensch beim
 * Bar-Replay nebenher führt. Jakob kann es später lesen; der Analyst kann sich nicht
 * nachträglich an ein besseres Ergebnis erinnern.
 */
export async function schreibeTagebuch(
  sitzung: Sitzung,
  workdir: string,
  wer: string,
): Promise<string> {
  const ordner = path.join(workdir, "replays");
  await mkdir(ordner, { recursive: true });
  const datei = path.join(
    ordner,
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${sitzung.id}.json`,
  );
  const inhalt = {
    id: sitzung.id,
    wer,
    symbol: sitzung.symbol,
    name: sitzung.name,
    intervall: sitzung.intervall,
    von: tag(sitzung.kerzen[sitzung.startIndex].time),
    bis: tag(sitzung.kerzen[sitzung.zeiger].time),
    abgespielt: sitzung.zeiger - sitzung.startIndex + 1,
    bilanz: bilanz(sitzung.handel),
    handel: sitzung.handel.map((h) => ({
      ...h,
      einstiegTag: tag(h.einstiegZeit),
      ausstiegTag: h.ausstiegZeit ? tag(h.ausstiegZeit) : null,
    })),
  };
  await writeFile(datei, `${JSON.stringify(inhalt, null, 2)}\n`, "utf8");
  return datei;
}

/** Nur für Tests: den Sitzungsspeicher leeren. */
export function vergissAlles(): void {
  SITZUNGEN.clear();
}
