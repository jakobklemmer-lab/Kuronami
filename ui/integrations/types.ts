/**
 * Die Antwortformen der Gateway-Routen `/integrations/*`, wie die Oberfläche sie liest
 * (Nachtrag 2026-09-16 — Nachfolger der Typen aus dem gelöschten `ui/mock/data.ts`). Die
 * Gegenstücke stehen in `gateway/integrations/*.ts`; `ui/` importiert bewusst nichts aus
 * `gateway/`, weil der Browser-Build (`ui/tsconfig.json`) keine Node-Typen kennt. Ändert sich
 * eine Form, ändert sie sich an beiden Stellen — das ist der Preis für zwei getrennte Builds.
 */

// --- Mail -----------------------------------------------------------------

export interface MailMessage {
  id: string;
  from: string;
  subject: string;
  preview: string;
  receivedAt: string;
  unread: boolean;
}

export interface MailData {
  messages: MailMessage[];
  unreadCount: number;
}

// --- Märkte ---------------------------------------------------------------

export interface MarketSearchHit {
  symbol: string;
  name: string;
  exchange: string;
  type: string;
}

export interface MarketCandle {
  /** Unix-Sekunden. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface MarketQuote {
  symbol: string;
  name: string;
  currency: string;
  exchange: string;
  price: number;
  change: number;
  changePct: number;
  spark: number[];
}

export interface MarketQuotesData {
  quotes: MarketQuote[];
  failed: string[];
}

export interface MarketChart extends MarketQuote {
  range: string;
  interval: string;
  candles: MarketCandle[];
}

// --- Wetter (kommt direkt von Open-Meteo, siehe ui/integrations/weather.ts) --

export interface WeatherDay {
  name: string;
  high: number;
  low: number;
  clear: boolean;
}

export interface WeatherData {
  place: string;
  temperature: number;
  description: string;
  night: boolean;
  forecast: WeatherDay[];
}

// --- System ---------------------------------------------------------------

export interface SystemGauge {
  id: "cpu" | "ram" | "disk" | "net";
  label: string;
  /** Füllstand des Rings, 0–100. */
  percent: number;
  readout: string;
  readoutSub: string | null;
}

export interface SystemData {
  gauges: SystemGauge[];
}

// --- Kalender -------------------------------------------------------------

export interface AgendaEvent {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  location: string | null;
  allDay: boolean;
  account: string;
}

export interface CalendarData {
  connected: boolean;
  reason: string | null;
  events: AgendaEvent[];
}

// --- Notizen, Dateien, Recherche ---------------------------------------------

export interface NoteSummary {
  id: string;
  title: string;
  kind: string;
  tags: string[];
  updatedAt: string;
  excerpt: string;
}

export interface NotesData {
  notes: NoteSummary[];
}

export interface FileEntry {
  id: string;
  name: string;
  path: string;
  kind: "artifact" | "note";
  mimeType: string | null;
  sizeBytes: number | null;
  modifiedAt: string;
}

export interface FilesData {
  files: FileEntry[];
}

export interface ResearchFinding {
  id: string;
  tool: string;
  summary: string;
  artifactUri: string;
  savedAt: string;
}

export interface ResearchData {
  findings: ResearchFinding[];
}
