/**
 * Der Router des UI-Zwischenschubs: genau eine aktive Ansicht im Hauptfenster, adressiert über
 * den Hash-Teil der URL (`#/mail`, `#/settings/appearance`, …).
 *
 * **Warum Hash-Routing statt echter Pfade:** `ui/serve.ts`/`ui/build.ts` liefern Dateien anhand
 * ihres Pfads aus (kein SPA-Fallback für unbekannte Pfade). Ein echter Pfad wie `/mail` bräuchte
 * eine Änderung an der Ausliefer-Infrastruktur, nur um dieselbe `index.html` für jeden Pfad
 * zurückzugeben. Der Hash-Teil ist dagegen rein client-seitig: derselbe Server, dieselbe Datei,
 * und trotzdem eine direkt aufrufbare, merk- und teilbare Adresse (`http://localhost:3001/#/mail`
 * lässt sich eintippen und per Lesezeichen sichern.
 */

export const ROUTE_IDS = [
  // Die Präsenz (2026-09-18): Kuro als Gegenüber statt als Dashboard — seit S47 die einzige
  // Startseite. Das alte Dashboard (`home`) liegt mit der klassischen Hülle im Archiv; ein
  // Lesezeichen darauf landet über die Vorgabe hier.
  "praesenz",
  "mail",
  "calendar",
  "trading",
  // Das Analysen-Archiv (2026-09-20): fertige Einschätzungen zum Nachlesen, bevor ein Trade
  // wirklich losgeht. Eigene Route, damit es ein Lesezeichen sein kann.
  "analysen",
  // Das Strategie-Archiv (2026-09-20): geprüfte Regeln samt Kennzahlen — der Ort, an dem
  // entschieden wird, was irgendwann von selbst laufen darf.
  "strategien",
  "research",
  "files",
  "system",
  "settings",
] as const;

export type RouteId = (typeof ROUTE_IDS)[number];

export function isRouteId(value: string): value is RouteId {
  return (ROUTE_IDS as readonly string[]).includes(value);
}

export const SETTINGS_SECTION_IDS = [
  "appearance",
  // "models", "approvals" und "memory" sind am 18.09.2026 zu "haushalt" zusammengefallen:
  // sie zeigten Schalter für einen Modell-Router, eine Policy-Engine und eine Kompaktierung,
  // die es seit dem Motorwechsel nicht mehr gibt.
  "haushalt",
  "integrations",
  "apiKeys",
  "mcpServers",
  "speech",
  "system",
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

export function isSettingsSectionId(value: string): value is SettingsSectionId {
  return (SETTINGS_SECTION_IDS as readonly string[]).includes(value);
}

export interface ParsedRoute {
  view: RouteId;
  /** Nur bei `view === "settings"` gesetzt — Vorgabe `"appearance"`, wenn der Hash keinen oder
   * einen unbekannten Abschnitt nennt. */
  section?: SettingsSectionId;
}

export const DEFAULT_ROUTE: RouteId = "praesenz";
export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = "appearance";

/** Liest `location.hash` (mit oder ohne führendes `#`) in eine typisierte Route. Erkennt keine
 * Route oder keinen Abschnitt, ist die jeweilige Vorgabe die Antwort — nie ein Absturz auf einen
 * fremden oder leeren Hash. */
export function parseHash(hash: string): ParsedRoute {
  const trimmed = hash.replace(/^#/, "");
  const segments = trimmed.split("/").filter((segment) => segment.length > 0);
  const [rawView, rawSection] = segments;

  const view: RouteId = rawView !== undefined && isRouteId(rawView) ? rawView : DEFAULT_ROUTE;
  if (view !== "settings") return { view };

  const section: SettingsSectionId =
    rawSection !== undefined && isSettingsSectionId(rawSection)
      ? rawSection
      : DEFAULT_SETTINGS_SECTION;
  return { view, section };
}

/** Die Kehrfunktion zu `parseHash` — baut den Hash-Teil (mit `#`) für eine Route. */
export function hashFor(view: RouteId, section?: SettingsSectionId): string {
  if (view === "settings") return `#/settings/${section ?? DEFAULT_SETTINGS_SECTION}`;
  return `#/${view}`;
}
