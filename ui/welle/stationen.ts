import type { IconName } from "../icons.js";
import type { RouteId } from "../router/router.js";
import { bildIndex } from "./film-rechnung.js";

/**
 * Die Orte der Welle.
 *
 * Jeder Bereich ist ein Ort auf der Fahrt, die der Film zeigt: aus dem Raum, am Bonsai vorbei,
 * durchs Fenster und hinaus auf die Terrasse mit den Laternen. Kuro wohnt im Raum; Post und
 * Kalender liegen noch drinnen, die Märkte draußen über dem Wasser. Ein Wechsel des Bereichs ist
 * deshalb eine Kamerafahrt von einem Ort zum anderen — die Leiste oben zeigt denselben Weg.
 *
 * `ort` ist die Stelle im Film (0 = erstes Bild, 1 = letztes). Die Reihenfolge der Liste ist die
 * Reihenfolge auf dem Weg; sie muss mit `ort` steigen, sonst führe die Kamera beim Weiterklicken
 * rückwärts (geprüft in `stationen.test.ts`).
 *
 * Die Routen sind dieselben wie in der Präsenz (`ui/router/router.ts`), damit ein Lesezeichen wie
 * `#/mail` in beiden Oberflächen dasselbe öffnet.
 */

export interface Station {
  route: RouteId;
  name: string;
  ikon: IconName;
  ort: number;
}

export const STATIONEN: readonly Station[] = [
  { route: "praesenz", name: "Kuro", ikon: "praesenz", ort: 0 },
  { route: "mail", name: "Post", ikon: "mail", ort: 0.1 },
  { route: "calendar", name: "Kalender", ikon: "calendar", ort: 0.18 },
  { route: "research", name: "Recherche", ikon: "research", ort: 0.26 },
  { route: "files", name: "Dateien", ikon: "files", ort: 0.34 },
  { route: "analysen", name: "Analysen", ikon: "analysen", ort: 0.46 },
  { route: "strategien", name: "Strategien", ikon: "strategien", ort: 0.56 },
  { route: "trading", name: "Märkte", ikon: "trading", ort: 0.7 },
  { route: "system", name: "System", ikon: "system", ort: 0.84 },
  { route: "settings", name: "Einstellungen", ikon: "settings", ort: 1 },
];

/** Wie viele Bilder der Film hat (`ui/welle/film/sd|hd/`). */
export const FILM_BILDER = 121;

/**
 * Die Bilder, an denen der Film stillsteht — je Station eines. Nur für sie liegen scharfe
 * Fassungen in `film/scharf/2k|4k/`; wer eine Station hinzufügt oder verschiebt, muss dort das
 * passende Bild erzeugen (Befehl in `progress.md`, S49). `stationen.test.ts` prüft, dass es da ist.
 */
export const SCHARFE_BILDER: readonly number[] = STATIONEN.map((s) =>
  bildIndex(s.ort, FILM_BILDER),
);

/** Die Station einer Route. Jede `RouteId` hat genau eine — sonst wäre sie ein halber Weg. */
export function stationFuer(route: RouteId): Station {
  const station = STATIONEN.find((s) => s.route === route);
  if (!station) throw new Error(`Die Route "${route}" hat keinen Ort in der Welle.`);
  return station;
}

/**
 * Stationen, die in der Leiste oben stehen. Seit dem 02.10. nur Kuro, Post und Kalender — Jakob:
 * alles außer Mail und Kalender wandert nach Kuro OS (`/os/`), das Web bleibt für leichte
 * Anfragen. Die übrigen Bereiche bleiben über ⌘K und ihre Adresse erreichbar, ihre Orte im Film
 * bleiben, wo sie sind.
 */
export const WEG = STATIONEN.filter((s) => ["praesenz", "mail", "calendar"].includes(s.route));
