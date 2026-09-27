/**
 * Zeit-/Datumsformatierung fuer die Cockpit- und Detailansichten — reine Funktionen mit `now`
 * als Parameter (Vorgabe: der tatsaechliche Zeitpunkt), damit ein Test einen festen Zeitpunkt
 * hereinreichen kann statt gegen die echte Uhr zu pruefen.
 */

export function formatClockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

export function formatDateLong(date: Date): string {
  return date.toLocaleDateString("de-DE", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** "vor 5 Min." / "vor 3 Std." / "vor 2 Tg." — grob genug fuer eine Vorschauzeile, keine
 * Sekundengenauigkeit. Ein Zeitpunkt in der Zukunft (Uhrzeitdrift, Mock-Daten) zeigt "gerade
 * eben" statt einer negativen Dauer. */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const deltaMs = now.getTime() - new Date(iso).getTime();
  if (deltaMs < 60_000) return "gerade eben";
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `vor ${minutes} Min.`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `vor ${hours} Std.`;
  const days = Math.floor(hours / 24);
  return `vor ${days} Tg.`;
}

/** Mitternacht des Tages, in dem `datum` liegt — in der Zeitzone des Browsers. */
function tagesbeginn(datum: Date): number {
  return new Date(datum.getFullYear(), datum.getMonth(), datum.getDate()).getTime();
}

/**
 * Der Name des Tages, zu dem ein Zeitpunkt gehört, als Überschrift einer Liste: „Heute",
 * „Gestern", innerhalb der letzten Woche der Wochentag mit Datum, davor nur das Datum (mit Jahr,
 * wenn es nicht das laufende ist). Eine lange Liste zerfällt damit in Abschnitte, die man
 * überblickt, statt in dreißig gleich aussehende Zeilen mit „vor 11 Std." am Rand.
 */
export function tagesGruppe(iso: string, now: Date = new Date()): string {
  const datum = new Date(iso);
  const tage = Math.round((tagesbeginn(now) - tagesbeginn(datum)) / 86_400_000);
  if (tage <= 0) return "Heute";
  if (tage === 1) return "Gestern";
  if (tage < 7) {
    return datum.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" });
  }
  return datum.toLocaleDateString("de-DE", {
    day: "numeric",
    month: "long",
    ...(datum.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** Einträge in Tagesabschnitte teilen; die Reihenfolge der Einträge bleibt, wie sie kam. */
export function gruppiereNachTag<T>(
  eintraege: readonly T[],
  zeitpunkt: (eintrag: T) => string,
  now: Date = new Date(),
): Array<{ titel: string; eintraege: T[] }> {
  const gruppen: Array<{ titel: string; eintraege: T[] }> = [];
  for (const eintrag of eintraege) {
    const titel = tagesGruppe(zeitpunkt(eintrag), now);
    const letzte = gruppen[gruppen.length - 1];
    if (letzte && letzte.titel === titel) letzte.eintraege.push(eintrag);
    else gruppen.push({ titel, eintraege: [eintrag] });
  }
  return gruppen;
}

/** Eine Zahl deutsch, mit fester Stellenzahl: „0,17", „1.864,20". Nie „0.17" neben „25.408,64". */
export function formatZahl(wert: number, stellen = 2): string {
  if (!Number.isFinite(wert)) return wert > 0 ? "∞" : "−∞";
  const text = Math.abs(wert).toLocaleString("de-DE", {
    minimumFractionDigits: stellen,
    maximumFractionDigits: stellen,
  });
  return wert < 0 && text.replace(/[0,.]/g, "") !== "" ? `−${text}` : text;
}

/** Ein Erwartungswert in R, immer mit Vorzeichen — „+0,01 R" und „−0,16 R" sind verschiedene
 * Aussagen, und ein fehlendes Plus liest sich wie eine Null. */
export function formatR(wert: number): string {
  const text = formatZahl(wert, 2);
  return `${wert > 0 && text.replace(/[0,.]/g, "") !== "" ? "+" : ""}${text} R`;
}

/** Ein Anteil in Prozent, deutsch: „39,7 %". */
export function formatAnteil(prozent: number, stellen = 1): string {
  return `${formatZahl(prozent, stellen)} %`;
}

/** Ein Kerzenintervall als Wort: „1d" → „Tageskerzen", „15m" → „15-Minuten-Kerzen". */
export function kerzenName(intervall: string): string {
  const fest: Record<string, string> = {
    "1d": "Tageskerzen",
    "1wk": "Wochenkerzen",
    "1mo": "Monatskerzen",
    "1h": "Stundenkerzen",
    "60m": "Stundenkerzen",
  };
  if (fest[intervall]) return fest[intervall];
  const minuten = /^(\d+)m$/.exec(intervall);
  if (minuten) return `${minuten[1]}-Minuten-Kerzen`;
  const stunden = /^(\d+)h$/.exec(intervall);
  if (stunden) return `${stunden[1]}-Stunden-Kerzen`;
  return `Kerzen zu ${intervall}`;
}

/** Ein Kalendertag kurz: „2015-01-02" → „2. Jan. 2015". Unlesbares bleibt, wie es kam. */
export function formatTagKurz(tag: string): string {
  const datum = /^\d{4}-\d{2}-\d{2}$/.test(tag) ? new Date(`${tag}T12:00:00`) : new Date(tag);
  if (Number.isNaN(datum.getTime())) return tag;
  return datum.toLocaleDateString("de-DE", { day: "numeric", month: "short", year: "numeric" });
}
