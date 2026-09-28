/**
 * Die Sperrfrist (28.09.2026): die jüngsten Kurse gehören der Schlussprobe, nicht der Suche.
 *
 * Wer an einer Regel schraubt, bis sie im Backtest trägt, hat jeden Zeitraum, den er dabei sah,
 * verbraucht — ein späterer Test darauf misst nur noch, wie gut das Schrauben war. Deshalb sehen
 * die Werkzeuge der Suche (`backtest`, `universum`, `strategie_ablegen`, `gegenprobe` und die
 * Nachrechnung) Kurse nur **bis zur Sperrgrenze**. Was danach kommt, rechnet genau einmal die
 * Schlussprobe (`schlussprobe.ts`) — an der fertig abgelegten, unveränderten Regel.
 *
 * Die Grenze wandert mit dem Kalender mit. Das ist sicher, weil jede Strategie beim Ablegen
 * festhält, bis wohin sie gesehen hat (`gesehenBis`): ihre Schlussprobe beginnt dort, nicht an
 * der Grenze von heute.
 *
 * Wie lang gesperrt wird, hängt am Zeitrahmen — gemessen an dem, was eine Schlussprobe an Handeln
 * braucht: auf Tageskerzen handelt eine Regel ein paar Dutzend Mal im Jahr, auf 1h Hunderte Male.
 */

const TAG = 86_400;

export const SPERRE_TAGE: Readonly<Record<string, number>> = {
  "1m": 30,
  "5m": 60,
  "15m": 90,
  "30m": 90,
  "1h": 180,
  "1d": 730,
  "1wk": 730,
  "1mo": 730,
};

function tagUtc(d: Date): number {
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);
}

/** Der erste gesperrte Tag (UTC, `YYYY-MM-DD`) für diesen Zeitrahmen. */
export function sperrgrenze(intervall: string, jetzt: Date = new Date()): string {
  const tage = SPERRE_TAGE[intervall] ?? SPERRE_TAGE["1d"];
  return new Date((tagUtc(jetzt) - tage * TAG) * 1000).toISOString().slice(0, 10);
}

/**
 * Ein gewünschtes Ende auf die Sperrgrenze kürzen. `bis` ist der letzte **eingeschlossene** Tag;
 * zurück kommt der letzte sichtbare, also der Tag vor der Grenze.
 */
export function kappe(
  bis: string,
  intervall: string,
  jetzt: Date = new Date(),
): { bis: string; gekappt: boolean; grenze: string } {
  const grenze = sperrgrenze(intervall, jetzt);
  const letzterSichtbarer = new Date(Date.parse(`${grenze}T00:00:00Z`) - TAG * 1000)
    .toISOString()
    .slice(0, 10);
  return bis > letzterSichtbarer
    ? { bis: letzterSichtbarer, gekappt: true, grenze }
    : { bis, gekappt: false, grenze };
}

/** Der Satz unter einem gekürzten Ergebnis. */
export function sperrHinweis(grenze: string): string {
  return `Kurse ab ${grenze} sind für die Schlussprobe gesperrt — gerechnet bis zum Tag davor.`;
}
