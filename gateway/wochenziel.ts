/**
 * Jakobs Wochenziel — eine Beobachtungsgröße, keine Vorgabe.
 *
 * Am 2026-09-27 sagte Jakob: „ab jetzt schauen, dass wir in der Woche hundert Euro circa
 * verdienen könnten." Die boerse rechnete dagegen: auf [Kapital] Kapital sind das sechs bis sieben
 * Prozent pro Woche, und keine geprüfte Regel trägt das. Ihr Vorschlag, den Jakob angenommen hat:
 * **die Ein-Prozent-Regel bleibt**, und die 100 € laufen daneben mit — als Zahl, an der man sieht,
 * wie weit eine Regel oder eine Woche davon entfernt ist, nie als Grund, eine Position größer
 * zu machen.
 *
 * Deshalb steht die Zahl dort, wo gerechnet wird (Backtest, Akte), und nicht im Kopf eines
 * Analysten: „0,4 Handel je Woche × 0,19 R × 15 €" ist Arithmetik, und Arithmetik, auf die Geld
 * gesetzt werden könnte, macht hier Code.
 */

export interface Wochenziel {
  kapitalEuro: number;
  /** Risiko je Handel in Prozent des Kapitals — Jakobs Regel: 1. */
  risikoProzent: number;
  zielEuro: number;
}

function positiv(roh: string | undefined, vorgabe: number): number {
  const n = Number(roh?.trim().replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : vorgabe;
}

export function wochenziel(env: NodeJS.ProcessEnv = process.env): Wochenziel {
  return {
    kapitalEuro: positiv(env.KURO_KAPITAL_EURO, 1500),
    risikoProzent: positiv(env.KURO_RISIKO_PROZENT, 1),
    zielEuro: positiv(env.KURO_WOCHENZIEL_EURO, 100),
  };
}

/** Ein R in Euro: das Risiko eines Handels nach Jakobs Regel. */
export function risikoEuro(w: Wochenziel): number {
  return (w.kapitalEuro * w.risikoProzent) / 100;
}

export function euro(wert: number, vorzeichen = false): string {
  const text = Math.abs(wert).toLocaleString("de-DE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const zeichen = wert < 0 ? "−" : vorzeichen && wert > 0 ? "+" : "";
  return `${zeichen}${text} €`;
}

function zahl(wert: number, stellen = 2): string {
  return wert.toLocaleString("de-DE", {
    minimumFractionDigits: stellen,
    maximumFractionDigits: stellen,
  });
}

const TAG_MS = 86_400_000;

/**
 * Was eine Regel je Woche erwarten lässt: wie oft sie handelt, mal was ein Handel im Mittel
 * bringt, mal was ein R in Euro ist. `null`, wenn der Zeitraum keine Woche lang ist oder nichts
 * gehandelt wurde — dann gibt es keine Häufigkeit, nur eine Behauptung.
 */
export function jeWoche(
  anzahl: number,
  vonIso: string,
  bisIso: string,
  erwartungswertR: number,
  w: Wochenziel = wochenziel(),
): { handelJeWoche: number; euroJeWoche: number } | null {
  const wochen = (Date.parse(bisIso) - Date.parse(vonIso)) / TAG_MS / 7;
  if (!Number.isFinite(wochen) || wochen < 1 || anzahl <= 0) return null;
  const handelJeWoche = anzahl / wochen;
  return { handelJeWoche, euroJeWoche: handelJeWoche * erwartungswertR * risikoEuro(w) };
}

/** Die Zeile für einen Backtest-Bericht. Leer, wenn es nichts zu rechnen gibt. */
export function wochenzielZeile(
  gesamt: { anzahl: number; erwartungswertR: number; von: string; bis: string },
  ungesehen: { anzahl: number; erwartungswertR: number; von: string; bis: string } | null,
  w: Wochenziel = wochenziel(),
): string {
  const g = jeWoche(gesamt.anzahl, gesamt.von, gesamt.bis, gesamt.erwartungswertR, w);
  if (!g) return "";
  const u = ungesehen
    ? jeWoche(ungesehen.anzahl, ungesehen.von, ungesehen.bis, ungesehen.erwartungswertR, w)
    : null;
  const r = `${gesamt.erwartungswertR >= 0 ? "+" : ""}${zahl(gesamt.erwartungswertR)} R`;
  return [
    `  Wochenziel (Beobachtung, keine Vorgabe): ${zahl(g.handelJeWoche)} Handel je Woche × ${r} × ${euro(risikoEuro(w))} Risiko (${zahl(w.risikoProzent, 0)} % von ${euro(w.kapitalEuro)}) = ${euro(g.euroJeWoche, true)} je Woche erwartet`,
    `    — Jakobs Ziel ${euro(w.zielEuro)}${u ? `; im ungesehenen Teil ${euro(u.euroJeWoche, true)}` : ""}. Größere Positionen sind kein Weg dorthin; mehr Handel mit belegter Kante schon.`,
  ].join("\n");
}

/** Montag der laufenden Woche in Wien, als `JJJJ-MM-TT`. */
export function wochenbeginn(jetzt: Date): string {
  const tag = (d: Date): string =>
    new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Vienna" }).format(d);
  const wochentag = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Vienna",
    weekday: "short",
  }).format(jetzt);
  const zurueck = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(wochentag);
  return tag(new Date(jetzt.getTime() - Math.max(0, zurueck) * TAG_MS));
}

/** Das Datum eines Zeitpunkts in Wien, als `JJJJ-MM-TT`. */
export function wienerTag(unixSekunden: number): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Vienna" }).format(
    new Date(unixSekunden * 1000),
  );
}
