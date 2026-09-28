import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Strategie } from "./backtest.js";
import type { Konfidenz } from "./konfidenz.js";

/**
 * Das Versuchsbuch (28.09.2026): jede Regel, die je gerechnet wurde, in einer Zeile.
 *
 * Anlass: Die Nachrechnung der TradingLab-Videos fand bei MACD 6 „belegte" Varianten unter 155 —
 * reiner Zufall hätte 3,9 erwarten lassen. Wer lange genug Varianten probiert, findet immer eine,
 * die gut aussieht; die Schwelle dagegen muss deshalb **mit der Zahl der Versuche wachsen**, und
 * zwar über alle Läufe und alle Bediensteten hinweg, nicht je Lauf. Vorher zählte jeder Lauf nur
 * sich selbst — offen seit S44: „nichts zählt die Zahl der probierten Varianten".
 *
 * Gezählt wird, was eine Regel gegen Kurse rechnet, um sie zu finden: `backtest`, `universum`,
 * `strategie_ablegen`, die Nachrechnungen. Die Gegenprobe zählt nicht — sie prüft eine schon
 * abgelegte Regel, statt eine neue zu suchen.
 *
 * Dieselbe Regel auf denselben Märkten im selben Zeitrahmen ist **ein** Versuch, auch wenn sie
 * zehnmal gerechnet wird (`schluessel`). Eine Nachrechnung zählt ihre Varianten; läuft sie noch
 * einmal, zählt sie nicht doppelt.
 */

export interface Versuch {
  zeit: string;
  wer: string;
  /** `backtest`, `universum`, `ablage`, `nachrechnung`, `nachtrag`. */
  werkzeug: string;
  /** Was als derselbe Versuch gilt. Siehe `regelSchluessel`. */
  schluessel: string;
  name: string;
  /** Wie viele Varianten die Zeile zählt: 1 für einen Backtest, viele für eine Nachrechnung. */
  varianten: number;
  anzahl?: number;
  erwartungswertR?: number;
  z?: number;
}

export interface VersuchsStand {
  /** Alle Versuche bisher, diesen eingeschlossen. */
  versuche: number;
  /** Seit wann das Buch zählt (ISO), oder `null` bei leerem Buch. */
  seit: string | null;
  /** Wie viele Standardfehler ein Ergebnis über null liegen muss, um nach allen Versuchen zu halten. */
  huerde: number;
}

export interface Versuchsbuch {
  zaehle(versuch: Omit<Versuch, "zeit">): Promise<VersuchsStand>;
  stand(): Promise<VersuchsStand>;
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

/** Der z-Wert aus einem 95-%-Intervall, wenn die einzelnen Handel nicht mehr vorliegen. */
export function zAusIntervall(mittel: number, k: Konfidenz): number {
  const standardfehler = (k.oben - k.unten) / (2 * 1.96);
  return standardfehler > 0 ? mittel / standardfehler : 0;
}

/** Schlüssel mit sortierten Feldern — dieselbe Regel ergibt immer dieselbe Zeichenkette. */
function stabil(wert: unknown): string {
  if (Array.isArray(wert)) return `[${wert.map(stabil).join(",")}]`;
  if (wert !== null && typeof wert === "object") {
    const felder = Object.entries(wert as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${felder.map(([k, v]) => `${JSON.stringify(k)}:${stabil(v)}`).join(",")}}`;
  }
  return JSON.stringify(wert);
}

/**
 * Dieselbe Regel, dieselben Märkte, derselbe Zeitrahmen → derselbe Schlüssel. Der Name zählt
 * nicht: wer eine Regel umbenennt, hat keine neue probiert. Kosten zählen mit — eine Regel, die
 * erst mit halben Gebühren trägt, ist ein eigener Versuch.
 */
export function regelSchluessel(
  strategie: Strategie,
  symbole: readonly string[],
  intervall: string,
): string {
  const { name: _name, ...regel } = strategie;
  const inhalt = stabil({ regel, symbole: [...symbole].sort(), intervall });
  return createHash("sha1").update(inhalt).digest("hex").slice(0, 16);
}

function standAus(zeilen: readonly Versuch[]): VersuchsStand {
  const je = new Map<string, number>();
  for (const z of zeilen) je.set(z.schluessel, Math.max(je.get(z.schluessel) ?? 0, z.varianten));
  const versuche = [...je.values()].reduce((a, b) => a + b, 0);
  return { versuche, seit: zeilen[0]?.zeit ?? null, huerde: strengeHuerde(versuche) };
}

export function createVersuchsbuch(deps: { workdir: string }): Versuchsbuch {
  const datei = path.join(deps.workdir, "labor", "versuche.jsonl");

  async function lies(): Promise<Versuch[]> {
    try {
      return (await readFile(datei, "utf8"))
        .split("\n")
        .filter((z) => z.trim() !== "")
        .map((z) => JSON.parse(z) as Versuch);
    } catch {
      return [];
    }
  }

  return {
    async zaehle(versuch) {
      const zeile: Versuch = { zeit: new Date().toISOString(), ...versuch };
      await mkdir(path.dirname(datei), { recursive: true });
      await appendFile(datei, `${JSON.stringify(zeile)}\n`, "utf8");
      return standAus(await lies());
    },
    async stand() {
      return standAus(await lies());
    },
  };
}

const komma = (x: number, stellen = 2): string => x.toFixed(stellen).replace(".", ",");

/** Der Satz unter jedem Ergebnis: wie viele Versuche es gab und ob dieses Ergebnis danach hält. */
export function formatiereVersuch(stand: VersuchsStand, z: number): string {
  const haelt = z > stand.huerde;
  return [
    `**Versuchsbuch:** Versuch Nr. ${stand.versuche}${stand.seit ? ` (gezählt seit ${stand.seit.slice(0, 10)})` : ""}.`,
    `Nach ${stand.versuche} Versuchen hält ein Ergebnis erst ab ${komma(stand.huerde)} Standardfehlern über null — dieses liegt bei ${komma(z)}: ${haelt ? "**hält** auch nach allen Versuchen." : "hält **nicht**; ohne bestandene Schlussprobe kein Kandidat."}`,
  ].join("\n");
}
