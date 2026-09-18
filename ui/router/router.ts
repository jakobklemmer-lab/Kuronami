/**
 * Der Router des UI-Zwischenschubs: genau eine aktive Ansicht im Hauptfenster, adressiert über
 * den Hash-Teil der URL (`#/mail`, `#/settings/appearance`, …).
 *
 * **Warum Hash-Routing statt echter Pfade:** `ui/serve.ts`/`ui/build.ts` liefern Dateien anhand
 * ihres Pfads aus (kein SPA-Fallback für unbekannte Pfade). Ein echter Pfad wie `/mail` bräuchte
 * eine Änderung an der Ausliefer-Infrastruktur, nur um dieselbe `index.html` für jeden Pfad
 * zurückzugeben. Der Hash-Teil ist dagegen rein client-seitig: derselbe Server, dieselbe Datei,
 * und trotzdem eine direkt aufrufbare, merk- und teilbare Adresse (`http://localhost:3001/#/mail`
 * lässt sich eintippen, per Lesezeichen sichern und — wichtig für `detach.ts` — per
 * `window.open` in einem zweiten Fenster laden, das beim Laden genau diese Ansicht zeigt.
 */

export const ROUTE_IDS = [
  "home",
  "mail",
  "calendar",
  "trading",
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
  "models",
  "approvals",
  "memory",
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

export const DEFAULT_ROUTE: RouteId = "home";
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
