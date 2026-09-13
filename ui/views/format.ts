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
