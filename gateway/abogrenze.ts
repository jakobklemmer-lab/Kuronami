import { ZONE, wienerZeit } from "./gespraeche.js";

/** Der Text, mit dem Claude Code eine erreichte Abo-Grenze meldet (Sitzung oder Woche). */
const GRENZ_TEXT = /You've hit your [a-z ]*limit/i;
/** Floskeln des SDK, die nie bei Jakob ankommen sollen. */
const FLOSKELN = new Set(["Continue from where you left off.", "No response requested."]);

export function istGrenzText(text: string): boolean {
  return GRENZ_TEXT.test(text);
}

export function istFloskel(text: string): boolean {
  return FLOSKELN.has(text.trim());
}

/**
 * Wann die Grenze fällt: zuerst `resetsAt` aus der Grenzmeldung (Unix-Sekunden), sonst die
 * Uhrzeit aus dem Text („resets 5:20pm (UTC)", „resets 17:20"). Der Server läuft in UTC, also
 * gilt die Uhrzeit im Text als UTC. Immer der nächste solche Zeitpunkt nach `jetzt`.
 */
export function zurueckUm(
  text: string,
  info?: { resetsAt?: number } | null,
  jetzt: Date = new Date(),
): Date | null {
  if (info?.resetsAt) return new Date(info.resetsAt * 1000);
  const m = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (!m) return null;
  let stunde = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  const halbtag = m[3]?.toLowerCase();
  if (halbtag === "pm" && stunde < 12) stunde += 12;
  if (halbtag === "am" && stunde === 12) stunde = 0;
  if (stunde > 23 || minute > 59) return null;
  const t = new Date(
    Date.UTC(jetzt.getUTCFullYear(), jetzt.getUTCMonth(), jetzt.getUTCDate(), stunde, minute),
  );
  if (t.getTime() <= jetzt.getTime()) t.setUTCDate(t.getUTCDate() + 1);
  return t;
}

/** „17:20 Uhr", an einem anderen Tag „am 09.10. um 12:00 Uhr" — Wiener Zeit. */
function wann(zurueck: Date, jetzt: Date): string {
  const z = wienerZeit(zurueck.toISOString(), ZONE);
  if (z.tag === wienerZeit(jetzt.toISOString(), ZONE).tag) return `ab ${z.uhr} Uhr`;
  const [, monat, tag] = z.tag.split("-");
  return `am ${tag}.${monat}. ab ${z.uhr} Uhr`;
}

/** Kuros Satz statt des englischen Rohtexts. Siezt, kein Englisch. */
export function grenzSatz(zurueck: Date | null, jetzt: Date = new Date()): string {
  if (!zurueck) {
    return "Ich bin für den Moment an der Grenze des Abos. Sobald es wieder frei ist, arbeite ich weiter, und was bis dahin an Berichten eintrifft, trage ich Ihnen dann von selbst vor.";
  }
  return `Ich bin für den Moment an der Grenze des Abos und kann erst ${wann(zurueck, jetzt)} weiterarbeiten. Was bis dahin an Berichten eintrifft, trage ich Ihnen danach von selbst vor.`;
}

/** Was ein Bediensteter meldet, der an die Grenze lief. */
export function grenzBericht(wer: string, zurueck: Date | null, jetzt: Date = new Date()): string {
  return zurueck
    ? `${wer} wurde vom Abo-Limit unterbrochen, weiter ${wann(zurueck, jetzt)}.`
    : `${wer} wurde vom Abo-Limit unterbrochen.`;
}
