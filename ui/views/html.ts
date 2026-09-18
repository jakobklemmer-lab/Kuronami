/**
 * Fremder Text in eigenes Markup (Nachtrag 2026-09-16). Seit die Ansichten echte Daten zeigen
 * — Mail-Betreffe von Fremden, Firmennamen von Yahoo, Notiztitel —, darf nichts davon ungeprüft
 * in `innerHTML`. Eine Funktion, überall dieselbe; die Alternative (`textContent` je Knoten)
 * hätte jede Vorlage in DOM-Aufrufe zerlegt.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
