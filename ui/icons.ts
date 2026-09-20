/**
 * Das Icon-Set des UI-Zwischenschubs (Punkt 7: "Emoji als Icons" raus). Handgezeichnete,
 * strichbasierte Symbole statt Unicode-Symbolzeichen (die vorherige Fassung nutzte `⌂ ✉ ▦ ↗ ◎
 * ▤ ⚙ ◔`) oder echter Emoji (`📄` im alten `main.ts`) — beide haben dasselbe Problem wie eine
 * Kanji-Textglyphe ohne installierte Schrift: das Aussehen haengt vom System-Font ab und ist
 * nicht garantiert gleich. Reine Zeichenketten (kein `document`), damit dieses Modul ohne
 * Browser pruefbar bleibt (`ui/icons.test.ts`) — Verwendung ist `container.insertAdjacentHTML`
 * bzw. Vorlagen-Strings in den Views.
 *
 * Einheitlicher Stil: 20×20-Ansichtsfenster, `stroke="currentColor"`, `fill="none"`,
 * Strichbreite 1.5, runde Kappen/Ecken — eine Familie, keine gemischten Stile.
 */

export type IconName =
  | "home"
  | "mail"
  | "calendar"
  | "trading"
  | "research"
  | "analysen"
  | "files"
  | "system"
  | "settings"
  | "bell"
  | "chevron"
  | "mic"
  | "collapse"
  | "close"
  | "upload"
  | "refresh"
  | "artifact"
  | "check"
  | "warning"
  | "moon"
  | "sun"
  | "plusSquare"
  | "terminal"
  | "focus"
  | "praesenz"
  | "monitor"
  | "dumbbell"
  | "utensils"
  | "book"
  | "phone";

const PATHS: Record<IconName, string> = {
  home: '<path d="M3.5 10.5 10 4l6.5 6.5" /><path d="M5.5 8.8V16h9V8.8" />',
  mail: '<rect x="3" y="5" width="14" height="10" rx="1.5" /><path d="m3.5 5.8 6.5 5 6.5-5" />',
  calendar:
    '<rect x="3" y="4.5" width="14" height="12" rx="1.5" /><path d="M3 8.5h14" /><path d="M7 3v3M13 3v3" />',
  trading: '<path d="M3.5 13.5 8 9l3 3 5.5-6" /><path d="M13 6h3.5v3.5" />',
  research: '<circle cx="8.5" cy="8.5" r="5" /><path d="m16.5 16.5-4.2-4.2" />',
  // Analysen: ein abgelegtes Blatt mit einer Kurslinie darauf — Lesestoff, kein Live-Blick.
  analysen:
    '<path d="M5 3.5h6.5L15.5 7.4V16a.5.5 0 0 1-.5.5H5a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5Z" /><path d="M11.3 3.7v3.8h3.9" /><path d="m6.8 13.6 2-2.3 1.7 1.5 2.3-3" />',
  files: '<path d="M4 4.5h5l1.5 2H16v9a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 4 15.5Z" />',
  system:
    '<rect x="4" y="4" width="12" height="12" rx="1.5" /><path d="M8 8h4v4H8Z" /><path d="M8 1.5V4M12 1.5V4M8 16v2.5M12 16v2.5M1.5 8H4M1.5 12H4M16 8h2.5M16 12h2.5" />',
  settings:
    '<circle cx="10" cy="10" r="2.6" /><path d="M10 3.3v2M10 14.7v2M16.7 10h-2M5.3 10h-2M15 5l-1.4 1.4M6.4 13.6 5 15M15 15l-1.4-1.4M6.4 6.4 5 5" />',
  bell: '<path d="M6 8.5a4 4 0 1 1 8 0c0 3 1 4.2 1 4.2H5s1-1.2 1-4.2Z" /><path d="M8.3 15a1.8 1.8 0 0 0 3.4 0" />',
  chevron: '<path d="m7.5 4.5 6 5.5-6 5.5" />',
  mic: '<rect x="7.5" y="3" width="5" height="8.5" rx="2.5" /><path d="M5 10a5 5 0 0 0 10 0" /><path d="M10 15v2.5M7 17.5h6" />',
  collapse:
    '<rect x="3" y="4" width="14" height="12" rx="1.5" /><path d="M8.5 4v12" /><path d="m6 8-1.5 2L6 12" />',
  close: '<path d="m5 5 10 10M15 5 5 15" />',
  upload:
    '<path d="M10 13.5V4.5M6.5 8 10 4.5 13.5 8" /><path d="M4 14.5v1a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-1" />',
  refresh:
    '<path d="M4.5 10a5.5 5.5 0 0 1 9.6-3.6M15.5 10a5.5 5.5 0 0 1-9.6 3.6" /><path d="M14 3.5v3h-3M6 16.5v-3h3" />',
  artifact:
    '<path d="M6 3.5h6l2.5 2.5V16a.5.5 0 0 1-.5.5H6a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5Z" /><path d="M12 3.5V6h2.5" />',
  check: '<path d="m4.5 10.5 3.5 3.5L15.5 6" />',
  warning:
    '<path d="M10 3.5 17 16H3Z" /><path d="M10 8v3.5" /><circle cx="10" cy="13.7" r="0.6" fill="currentColor" stroke="none" />',
  moon: '<path d="M15.4 12.4A6.4 6.4 0 0 1 7.6 4.6a6.6 6.6 0 1 0 7.8 7.8Z" />',
  sun: '<circle cx="10" cy="10" r="3.6" /><path d="M10 2.6v1.8M10 15.6v1.8M17.4 10h-1.8M4.4 10H2.6M15.2 4.8l-1.3 1.3M6.1 13.9l-1.3 1.3M15.2 15.2l-1.3-1.3M6.1 6.1 4.8 4.8" />',
  plusSquare:
    '<rect x="4" y="4" width="12" height="12" rx="2.5" /><path d="M10 7.4v5.2M7.4 10h5.2" />',
  terminal:
    '<rect x="3" y="4" width="14" height="12" rx="2.5" /><path d="m6.6 8.4 2.3 1.9-2.3 1.9M11 12.6h3" />',
  praesenz: '<circle cx="10" cy="10" r="7" /><path d="M6 10.6c1.3-1.4 2.7-1.4 4 0s2.7 1.4 4 0" />',
  focus:
    '<circle cx="10" cy="10" r="6.4" /><circle cx="10" cy="10" r="1.9" fill="currentColor" stroke="none" />',
  monitor:
    '<rect x="3" y="4.5" width="14" height="9.6" rx="1.8" /><path d="M7.6 17h4.8M10 14.1V17" />',
  dumbbell: '<path d="M4 8.2v3.6M6.4 6.4v7.2M13.6 6.4v7.2M16 8.2v3.6M6.4 10h7.2" />',
  utensils:
    '<path d="M6 3v4.4M4.3 3v3.1a1.7 1.7 0 0 0 3.4 0V3M6 8.6V17" /><path d="M13.6 3c-1.1 1.3-1.7 3-1.7 4.8 0 1.5.6 2.4 1.7 2.6V17" />',
  book: '<path d="M10 6.4S8.7 4.8 4.2 4.8v9.9c4.5 0 5.8 1.6 5.8 1.6s1.3-1.6 5.8-1.6V4.8c-4.5 0-5.8 1.6-5.8 1.6Z" /><path d="M10 6.4v9.9" />',
  phone:
    '<path d="M6.3 3.9 8 3.2l1.7 3.1-1.5 1.3a8.8 8.8 0 0 0 3.2 3.2l1.3-1.5 3.1 1.7-.7 1.7a1.6 1.6 0 0 1-1.8.9A11.4 11.4 0 0 1 5.4 5.7a1.6 1.6 0 0 1 .9-1.8Z" />',
};

export interface IconOptions {
  /** Klasse auf dem `<svg>`-Wurzelelement, fuer Groesse/Farbe ueber CSS. */
  className?: string;
  /** `aria-hidden` ist die Vorgabe (die meisten Icons stehen neben Text, der die Bedeutung
   * traegt) — auf `false` setzen, wenn das Icon selbst die einzige Bedeutung ist. */
  decorative?: boolean;
}

/** Baut ein einzelnes Icon als Markup-Zeichenkette. */
export function icon(name: IconName, options: IconOptions = {}): string {
  const className = options.className ? ` class="${options.className}"` : "";
  const hidden = options.decorative === false ? "" : ' aria-hidden="true"';
  return `<svg${className} viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"${hidden}>${PATHS[name]}</svg>`;
}

export const ICON_NAMES: readonly IconName[] = Object.keys(PATHS) as IconName[];
