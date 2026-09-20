import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Abschnitt, Kennzahlen, Strategie } from "./backtest.js";

/**
 * Das Strategie-Archiv.
 *
 * Der Unterschied zum Analysen-Archiv ist der Unterschied zwischen einem Einfall und einem
 * Verfahren. Jakob hat ihn selbst gezogen: „Trades, über die ich mit dem Team diskutiere, sind
 * Einzeltrades, die aufgrund von Nachrichten ansetzen und die kein repetitives Pattern dahinter
 * haben, welches in einer Strategie gehandhabt werden könnte." Eine Strategie ist das Gegenteil:
 * eine Regel, die sich wiederholt, also auch prüfen lässt — und deren Ergebnis nicht aus einer
 * Meinung besteht, sondern aus Kennzahlen mit Datum.
 *
 * Deshalb liegt hier **immer die Regel samt ihrem Prüfergebnis**, nie die Regel allein. Eine
 * Strategie ohne Backtest ist ein Vorschlag; sie kommt in den Status `entwurf` und bleibt dort.
 *
 * **Was es hier nicht gibt: einen Knopf, der Geld bewegt.** Das Fernziel ist ein Agent, der eine
 * geprüfte Strategie selbst live handelt. Bis dahin fehlt eine Anbindung an einen Broker, und
 * dieser Ablageort tut nicht so, als gäbe es sie: der höchste Status ist `kandidat` — geprüft,
 * ungesehen bestanden, wartet auf Jakobs Entscheidung.
 */

export type StrategieStatus = "entwurf" | "geprueft" | "kandidat" | "verworfen";

export interface StrategieKopf {
  id: string;
  /** ISO-Zeitpunkt der Ablage. */
  zeit: string;
  name: string;
  wer: string;
  symbol: string;
  intervall: string;
  von: string;
  bis: string;
  status: StrategieStatus;
  kennzahlen: Kennzahlen | null;
  /** Wie viele Vorbehalte das Prüfergebnis trägt. Null heißt: keiner ist aufgefallen. */
  warnungen: number;
}

export interface StrategieEintrag extends StrategieKopf {
  /** Die Regel selbst — vollständig, damit ein späterer Lauf sie wiederholen kann. */
  strategie: Strategie;
  inSample: Abschnitt | null;
  outOfSample: Abschnitt | null;
  warnungstexte: string[];
  /** Das Prüfergebnis im Wortlaut, wie es der Handelstisch gelesen hat. */
  bericht: string;
  notiz?: string;
}

export interface StrategienArchiv {
  lege(eintrag: {
    name: string;
    wer: string;
    symbol: string;
    intervall: string;
    von: string;
    bis: string;
    strategie: Strategie;
    kennzahlen: Kennzahlen | null;
    inSample: Abschnitt | null;
    outOfSample: Abschnitt | null;
    warnungstexte: string[];
    bericht: string;
    status?: StrategieStatus;
  }): Promise<StrategieKopf>;
  liste(grenze?: number): Promise<StrategieKopf[]>;
  lies(id: string): Promise<StrategieEintrag | null>;
  aendere(
    id: string,
    felder: { status?: StrategieStatus; notiz?: string },
  ): Promise<StrategieEintrag | null>;
}

export interface StrategienDeps {
  workdir: string;
  /** Unterordner. Vorgabe `strategien`. */
  ordner?: string;
}

/** Sortierbar und im Dateinamen lesbar. */
function dateiZeit(d: Date): string {
  return d.toISOString().replace(/:/g, "-").replace(/\./g, "-");
}

/**
 * Bestanden oder nicht — und zwar nach einer Regel, die vor dem Ergebnis feststeht.
 *
 * Ein Backtest, der erst nach dem Blick auf die Zahlen bewertet wird, bewertet sich selbst.
 * Deshalb steht die Schwelle hier im Code: genug Handel, positiver Erwartungswert, und der
 * ungesehene Teil muss den geschraubten tragen. Wer sie ändern will, ändert eine versionierte
 * Datei — nicht seine Meinung.
 */
export function bewerte(
  kennzahlen: Kennzahlen | null,
  outOfSample: Abschnitt | null,
  warnungen: readonly string[],
): StrategieStatus {
  if (kennzahlen === null || kennzahlen.anzahl === 0) return "entwurf";
  if (kennzahlen.anzahl < 30) return "geprueft";
  if (kennzahlen.erwartungswertR <= 0) return "verworfen";
  const draussen = outOfSample?.kennzahlen;
  if (!draussen || draussen.anzahl < 5) return "geprueft";
  if (draussen.erwartungswertR <= 0) return "verworfen";
  if (warnungen.length === 0 && kennzahlen.sharpe >= 1) return "kandidat";
  return "geprueft";
}

export function createStrategien(deps: StrategienDeps): StrategienArchiv {
  const ordner = path.join(deps.workdir, deps.ordner ?? "strategien");

  async function pfadeAlle(): Promise<string[]> {
    try {
      const dateien = await readdir(ordner);
      return dateien.filter((d) => d.endsWith(".json")).sort((a, b) => b.localeCompare(a));
    } catch {
      return [];
    }
  }

  async function leseDatei(datei: string): Promise<StrategieEintrag | null> {
    try {
      return JSON.parse(await readFile(path.join(ordner, datei), "utf8")) as StrategieEintrag;
    } catch {
      return null;
    }
  }

  async function dateiZu(id: string): Promise<string | null> {
    if (!/^[0-9a-f]{12}$/.test(id)) return null;
    return (await pfadeAlle()).find((d) => d.endsWith(`-${id}.json`)) ?? null;
  }

  function kopfVon(e: StrategieEintrag): StrategieKopf {
    const {
      strategie: _s,
      inSample: _i,
      outOfSample: _o,
      warnungstexte: _w,
      bericht: _b,
      notiz: _n,
      ...kopf
    } = e;
    return kopf;
  }

  return {
    async lege(eintrag) {
      const jetzt = new Date();
      const id = Array.from(
        { length: 12 },
        () => "0123456789abcdef"[Math.floor(Math.random() * 16)],
      ).join("");
      const voll: StrategieEintrag = {
        id,
        zeit: jetzt.toISOString(),
        name: eintrag.name,
        wer: eintrag.wer,
        symbol: eintrag.symbol,
        intervall: eintrag.intervall,
        von: eintrag.von,
        bis: eintrag.bis,
        status:
          eintrag.status ?? bewerte(eintrag.kennzahlen, eintrag.outOfSample, eintrag.warnungstexte),
        kennzahlen: eintrag.kennzahlen,
        warnungen: eintrag.warnungstexte.length,
        strategie: eintrag.strategie,
        inSample: eintrag.inSample,
        outOfSample: eintrag.outOfSample,
        warnungstexte: eintrag.warnungstexte,
        bericht: eintrag.bericht,
      };
      await mkdir(ordner, { recursive: true });
      await writeFile(
        path.join(ordner, `${dateiZeit(jetzt)}-${id}.json`),
        `${JSON.stringify(voll, null, 2)}\n`,
        "utf8",
      );
      return kopfVon(voll);
    },

    async liste(grenze = 50) {
      const dateien = (await pfadeAlle()).slice(0, grenze);
      const alle = await Promise.all(dateien.map(leseDatei));
      return alle.filter((e): e is StrategieEintrag => e !== null).map(kopfVon);
    },

    async lies(id) {
      const datei = await dateiZu(id);
      return datei ? leseDatei(datei) : null;
    },

    async aendere(id, felder) {
      const datei = await dateiZu(id);
      if (!datei) return null;
      const alt = await leseDatei(datei);
      if (!alt) return null;
      const neu: StrategieEintrag = {
        ...alt,
        ...(felder.status ? { status: felder.status } : {}),
        ...(felder.notiz !== undefined ? { notiz: felder.notiz } : {}),
      };
      await writeFile(path.join(ordner, datei), `${JSON.stringify(neu, null, 2)}\n`, "utf8");
      return neu;
    },
  };
}
