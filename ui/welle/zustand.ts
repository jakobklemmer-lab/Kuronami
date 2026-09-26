import type { Zustand } from "../praesenz/sphaere.js";

/**
 * Kuros Zustand in der Welle — die reine Ableitung, ohne DOM.
 *
 * Die Welle hat zwei Stimmen, und jede trägt ihr eigenes Licht: **Jakob** das warme der
 * Laterne, **Kuro** das kühle des Orbs. Kuros Licht ist nicht fest; es nimmt die Farbe an, die
 * der Orb gerade trägt — violett beim Denken, türkis beim Arbeiten, bernstein bei einer
 * Rückfrage. Dieselbe Farbe färbt den Film, den Punkt in der Leiste und den Rand der Eingabe.
 * Wer hinsieht, weiß ohne ein Wort, was Kuro gerade tut.
 *
 * Die Farben sind die Halo-Farben des Orbs (`ui/vendor/kuronami-orb.mjs`, `STATES[…].glow`),
 * damit Kugel und Oberfläche nicht zwei Meinungen über denselben Zustand haben.
 */

export const ZUSTAND_FARBE: Readonly<Record<Zustand, string>> = {
  ruhe: "#6d90ff",
  zuhoeren: "#5fc0ff",
  denken: "#8878ff",
  sprechen: "#84a6ff",
  arbeiten: "#56d2c2",
  rueckfrage: "#ffb35c",
  fehler: "#ff5c70",
  offline: "#46506a",
};

/** Wie stark Kuros Licht den Film färbt. In Ruhe kaum, bei einer Rückfrage deutlich. */
export const ZUSTAND_TON: Readonly<Record<Zustand, number>> = {
  ruhe: 0.12,
  zuhoeren: 0.28,
  denken: 0.4,
  sprechen: 0.3,
  arbeiten: 0.36,
  rueckfrage: 0.42,
  fehler: 0.5,
  offline: 0.05,
};

export const ZUSTAND_SATZ: Readonly<Record<Zustand, string>> = {
  ruhe: "Kuro ist da",
  zuhoeren: "Kuro hört zu",
  denken: "Kuro denkt nach",
  sprechen: "Kuro antwortet",
  arbeiten: "Kuro arbeitet",
  rueckfrage: "Kuro wartet auf dich",
  fehler: "Der letzte Auftrag ist gescheitert",
  offline: "Keine Verbindung zum Gateway",
};

export interface Lage {
  /** Ein eigener Zug läuft (die Anfrage an `/channels/web/messages` ist unterwegs). */
  unterwegs: boolean;
  /** Irgendein Zug läuft — auch einer aus der Sprachschicht oder einem anderen Fenster. */
  zugLaeuft: boolean;
  /** Seit wann zuletzt ein Wortstück kam (ms), oder null. */
  letztesStueck: number | null;
  /** Das Werkzeug, das Kuro gerade benutzt, oder null. */
  werkzeug: string | null;
  /** Eine offene Rückfrage an Jakob. */
  rueckfrage: boolean;
  /** Bis wann ein Fehler stehen bleibt (ms). */
  fehlerBis: number;
  offline: boolean;
  mikrofon: boolean;
}

/** Wie lange nach dem letzten Wortstück Kuro noch „spricht". */
export const SPRECHEN_NACHLAUF_MS = 1200;

/**
 * Was der Orb zeigen soll. Die Reihenfolge ist die Rangfolge: ein Fehler überstrahlt alles für
 * ein paar Sekunden, eine offene Frage an Jakob alles Übrige — sie ist das Einzige, bei dem Kuro
 * ohne Jakob nicht weiterkommt.
 */
export function leiteZustandAb(lage: Lage, jetzt: number): Zustand {
  if (jetzt < lage.fehlerBis) return "fehler";
  if (lage.rueckfrage) return "rueckfrage";
  if (lage.offline && !lage.unterwegs) return "offline";
  if (lage.letztesStueck !== null && jetzt - lage.letztesStueck < SPRECHEN_NACHLAUF_MS) {
    return "sprechen";
  }
  if (lage.werkzeug !== null && (lage.unterwegs || lage.zugLaeuft)) return "arbeiten";
  if (lage.unterwegs || lage.zugLaeuft) return "denken";
  if (lage.mikrofon) return "zuhoeren";
  return "ruhe";
}

/** Was Kuro gerade tut, in Jakobs Worten — der Stand unter der Antwort. */
export const WERKZEUG_SATZ: Readonly<Record<string, string>> = {
  WebFetch: "schlägt nach",
  WebSearch: "sucht im Netz",
  Read: "liest nach",
  Write: "notiert",
  Glob: "sucht Dateien",
  Grep: "durchsucht Dateien",
  mcp__haus__beauftrage: "gibt einen Auftrag weiter",
  mcp__haus__stand: "sieht nach, wie weit es ist",
  mcp__haus__abbrechen: "zieht einen Auftrag zurück",
  mcp__buehne__zeige: "legt eine Tafel hin",
  mcp__buehne__verberge: "räumt die Tafeln weg",
  mcp__versand__sende: "verschickt",
};

export function werkzeugSatz(name: string): string {
  if (WERKZEUG_SATZ[name]) return WERKZEUG_SATZ[name];
  // `mcp__server__werkzeug` → „benutzt werkzeug (server)": lesbar, ohne jeden Namen zu kennen.
  const teile = name.split("__");
  if (teile.length === 3 && teile[0] === "mcp") return `benutzt ${teile[2]} (${teile[1]})`;
  return `benutzt ${name}`;
}

/** Wie lange ein Auftrag schon läuft, so wie man es sagt. */
export function laufzeit(seitMs: number, jetzt: number): string {
  const s = Math.max(0, Math.round((jetzt - seitMs) / 1000));
  if (s < 60) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 90) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${min % 60} min`;
}
