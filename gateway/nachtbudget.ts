import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Fenster } from "./abo.js";
import { ZONE, wienerZeit } from "./gespraeche.js";

/**
 * Das Nachtbudget (02.10.): was Nachtbau und Lehrgang **zusammen** in einer Nacht vom Abo nehmen.
 *
 * Jakob am 02.10.: „Pro Nacht darf nur 10 % des Wochenlimits verbraucht werden, also aktueller
 * Stand + 10 = Stopp" — und die Lehrgänge zählen dazu. Sieben Nächte nehmen so höchstens 70 % der
 * Woche; der Rest gehört dem Tag.
 *
 * Dazu das Fenster, das in den Morgen reicht: ein Sitzungsfenster, das erst nach dem Ende der
 * Nacht zurückgesetzt wird, teilt sich die Nacht mit Jakobs Morgen. Was der Nachtbau darin nimmt,
 * fehlt ihm und Kuro bis zum nächsten Fenster — darin bleibt die Nacht unter 30 %.
 *
 * Der Stand zu Beginn der Nacht wird beim ersten Blick aufs Abo festgehalten
 * (`<workdir>/nacht/<Tag>.json`, angelegt mit `wx`): wer zuerst fragt, Nachtbau oder Lehrgang,
 * schreibt ihn, der andere liest ihn.
 */

/** Ende der Nacht (Wiener Uhrzeit), Vorgabe — `NACHTBAU_ENDE` in der `.env` überschreibt. */
export const NACHT_ENDE = "08:00";
/** So viele Prozentpunkte des Wochenfensters darf eine Nacht nehmen. */
export const NACHT_ANTEIL_WOCHE = 10;
/** Höchststand des Sitzungsfensters, das in Jakobs Morgen reicht. */
export const GRENZE_LETZTES_FENSTER = 30;
/** So lange läuft ein Sitzungsfenster des Abos. */
const SITZUNG_MS = 5 * 60 * 60 * 1000;

export interface Nachtgrenzen {
  /** Höchststand des Sitzungsfensters (%), ab dem nichts Neues beginnt. */
  sitzung: number;
  /** Höchststand des Wochenfensters (%). */
  woche: number;
  /** Stand des Wochenfensters zu Beginn der Nacht. */
  wocheStart: number;
  /** Reicht das laufende (oder das nächste) Sitzungsfenster über das Ende der Nacht hinaus? */
  letztesFenster: boolean;
}

function minuten(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) throw new Error(`Uhrzeit „${hhmm}" nicht lesbar (erwartet HH:MM)`);
  return Number(m[1]) * 60 + Number(m[2]);
}

function wienerMinute(jetzt: Date): number {
  const [h, m] = wienerZeit(jetzt.toISOString(), ZONE).uhr.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Ist es Nacht — zwischen Mitternacht und `ende` (Wiener Zeit)? */
export function inDerNacht(jetzt: Date, ende = NACHT_ENDE): boolean {
  return wienerMinute(jetzt) < minuten(ende);
}

/** Der nächste Zeitpunkt, an dem es in Wien `ende` schlägt (auf die Minute). */
export function naechstesEnde(jetzt: Date, ende = NACHT_ENDE): Date {
  const bis = (minuten(ende) - wienerMinute(jetzt) + 24 * 60) % (24 * 60);
  const t = new Date(jetzt.getTime() + bis * 60_000);
  t.setUTCSeconds(0, 0);
  return t;
}

/**
 * Die Grenzen dieser Nacht. `normal` sind die Grenzen des Aufrufers ohne Nachtbudget (Nachtbau
 * 85/85, Lehrgang 70/85); die Nacht kann sie nur enger machen, nie weiter.
 */
export function nachtgrenzen(opts: {
  fenster: readonly Fenster[];
  wocheStart: number;
  jetzt: Date;
  ende?: string;
  normal: { sitzung: number; woche: number };
}): Nachtgrenzen {
  const { fenster, jetzt, normal } = opts;
  const sitzung = fenster.find((f) => f.id === "sitzung");
  const woche = fenster.find((f) => f.id === "woche");
  // Wird die Woche mitten in der Nacht zurückgesetzt, zählt der neue Stand als Beginn.
  const wocheStart = Math.min(opts.wocheStart, woche?.prozent ?? opts.wocheStart);
  const zurueck = sitzung?.zurueck ? Date.parse(sitzung.zurueck) : Number.NaN;
  // Kein laufendes Fenster: das nächste beginnt mit dem nächsten Aufruf.
  const reset =
    sitzung && sitzung.prozent > 0 && zurueck > jetzt.getTime()
      ? zurueck
      : jetzt.getTime() + SITZUNG_MS;
  const letztesFenster = reset > naechstesEnde(jetzt, opts.ende).getTime();
  return {
    sitzung: letztesFenster ? Math.min(normal.sitzung, GRENZE_LETZTES_FENSTER) : normal.sitzung,
    woche: Math.min(normal.woche, Math.round(wocheStart) + NACHT_ANTEIL_WOCHE),
    wocheStart,
    letztesFenster,
  };
}

/**
 * Stand des Wochenfensters zu Beginn dieser Nacht: beim ersten Aufruf der Nacht `aktuell`
 * festhalten, danach das Festgehaltene lesen.
 */
export async function wocheZuBeginn(
  workdir: string,
  jetzt: Date,
  aktuell: number,
): Promise<number> {
  const tag = wienerZeit(jetzt.toISOString(), ZONE).tag;
  const datei = path.join(workdir, "nacht", `${tag}.json`);
  await mkdir(path.dirname(datei), { recursive: true });
  try {
    await writeFile(
      datei,
      `${JSON.stringify({ wocheStart: aktuell, zeit: jetzt.toISOString() })}\n`,
      { flag: "wx" },
    );
    return aktuell;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    try {
      const roh = JSON.parse(await readFile(datei, "utf8")) as { wocheStart?: unknown };
      if (typeof roh.wocheStart === "number") return roh.wocheStart;
    } catch {
      // Der andere schreibt gerade — dann gilt der eigene Blick, er liegt Sekunden daneben.
    }
    return aktuell;
  }
}
