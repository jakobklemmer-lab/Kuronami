/**
 * Die persistierten Einstellungen (S-Zwischenschub, Punkt 5) — ein einziges JSON-Objekt in
 * `localStorage`, in Abschnitte gegliedert wie die Einstellungsseite selbst. Dasselbe
 * Speicher-Injektionsmuster wie überall in `ui/` (`explicit?: Storage`, Vorgabe `localStorage`).
 *
 * **Felder ohne heutige Anbindung bleiben trotzdem Teil des Schemas.** Modelle, Freigaben,
 * Gedächtnis, Integrationen und Sprache haben heute keine Verbindung zu echten Backend-Werten —
 * die Einstellungsseite zeigt sie sichtbar, aber deaktiviert (siehe `ui/settings/view.ts`). Die
 * Werte werden trotzdem gespeichert: wenn die echte Anbindung kommt, ist das Feld schon da und
 * die Oberfläche muss nicht rückwirkend ein neues Schema einführen.
 *
 * `loadSettings` verschmilzt gespeicherte Werte mit `DEFAULT_SETTINGS`, Feld für Feld je
 * Abschnitt — ein älterer gespeicherter Stand mit weniger Feldern (oder ein late-hinzugekommenes
 * Feld) bekommt die Vorgabe, statt `undefined` durchzureichen oder das ganze Objekt zu verwerfen.
 */

import type { Oberflaeche } from "../oberflaeche.js";

export type ThemeMode = "dark" | "system";
export type Density = "comfortable" | "compact";

export interface AppearanceSettings {
  theme: ThemeMode;
  /** Von Hand gewählter Akzent, falls gesetzt — überschreibt den aus dem Raum abgeleiteten
   * Akzent (`ui/theme/palette.ts`). `null` heißt: dem Raum folgen. */
  accentOverride: string | null;
  density: Density;
  /** Welche Oberfläche gilt: die Präsenz („standard") oder die Welle („modern"), `ui/oberflaeche.ts`. */
  oberflaeche: Oberflaeche;
}

export interface ModelSettings {
  routineModel: string | null;
  architectureModel: string | null;
}

export type RiskLevel = "read" | "soft_write" | "hard_write" | "destructive";

export interface ApprovalSettings {
  /** Bis zu welcher Risikostufe Werkzeugaufrufe ohne Rückfrage laufen dürfen. */
  autoApproveUpTo: RiskLevel;
}

export interface MemorySettings {
  location: string | null;
}

export interface IntegrationSettings {
  n8nEndpoint: string | null;
}

export interface SpeechSettings {
  inputDevice: string | null;
  outputDevice: string | null;
  wakeWord: string;
  bargeIn: boolean;
  /**
   * Nur zuhören, solange die Leertaste gedrückt ist (2026-09-27). Jakob: „wenn ich nebenbei Videos
   * laufen habe". Gilt nur mit Tastatur — auf dem Telefon bleibt das Mikrofon offen, sonst wäre
   * es dort gar nicht zu benutzen (`ui/voice/sprechtaste.ts`).
   */
  sprechtaste: boolean;
  /**
   * Adresse des Sprachprozesses (S30), z. B. `ws://localhost:8790`. Leer = die Vorgabe aus
   * `ui/voice/session.ts`.
   */
  endpoint: string | null;
  /**
   * `VOICE_SESSION_TOKEN` — das gemeinsame Geheimnis des WebSocket-Randes der Sprachschicht.
   *
   * Ein **anderer** Wert als der Verbindungs-Token unter System: der gehört dem Gateway
   * (`GATEWAY_WEB_TOKEN`), dieser dem Sprachprozess. Zwei Prozesse, zwei Ausweise — derselbe
   * Grund wie in `gateway/identity.ts`.
   */
  sessionToken: string | null;
}

/** Die Beobachtungsliste der Trading-Ansicht und der Markets-Karte (Nachtrag 2026-09-16):
 * Yahoo-Finance-Symbole, vom Nutzer über die Suche zusammengestellt. */
export interface MarketsSettings {
  watchlist: string[];
  /** Wie der Chart zuletzt aussah (2026-09-27) — Kerzengröße, Darstellung, Indikatoren. */
  chart: ChartSettings;
}

export interface ChartSettings {
  intervall: string;
  typ: "kerzen" | "heikin" | "balken" | "linie" | "flaeche";
  indikatoren: { art: string; parameter: number[] }[];
  volumen: boolean;
  log: boolean;
  magnet: boolean;
  /** Der Zeitraum der schlichten Telefonansicht; die Kerzengröße folgt ihm (`handyIntervall`). */
  handyZeitraum: string;
}

export const DEFAULT_CHART: ChartSettings = {
  intervall: "1d",
  typ: "kerzen",
  indikatoren: [],
  volumen: true,
  log: false,
  magnet: false,
  handyZeitraum: "3M",
};

const CHART_TYPEN = ["kerzen", "heikin", "balken", "linie", "flaeche"] as const;

/** Nur, was die Oberfläche kennt — ein kaputter oder alter Stand fällt auf die Vorgabe. */
function normalizeChart(stored: unknown): ChartSettings {
  const c =
    typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
  const indikatoren = Array.isArray(c.indikatoren)
    ? c.indikatoren
        .filter(
          (i): i is { art: string; parameter: number[] } =>
            typeof i === "object" &&
            i !== null &&
            typeof (i as { art?: unknown }).art === "string" &&
            Array.isArray((i as { parameter?: unknown }).parameter) &&
            (i as { parameter: unknown[] }).parameter.every(
              (p) => typeof p === "number" && Number.isFinite(p),
            ),
        )
        .slice(0, 12)
    : [];
  return {
    intervall: typeof c.intervall === "string" ? c.intervall : DEFAULT_CHART.intervall,
    typ: (CHART_TYPEN as readonly unknown[]).includes(c.typ)
      ? (c.typ as ChartSettings["typ"])
      : "kerzen",
    indikatoren,
    volumen: typeof c.volumen === "boolean" ? c.volumen : true,
    log: c.log === true,
    magnet: c.magnet === true,
    handyZeitraum:
      typeof c.handyZeitraum === "string" ? c.handyZeitraum : DEFAULT_CHART.handyZeitraum,
  };
}

/** Der Ort der Wetterkarte (Nachtrag 2026-09-16) — Open-Meteo braucht Koordinaten, der Name
 * steht nur zur Anzeige daneben. */
export interface WeatherSettings {
  place: string;
  latitude: number;
  longitude: number;
}

export interface KuronamiSettings {
  appearance: AppearanceSettings;
  models: ModelSettings;
  approvals: ApprovalSettings;
  memory: MemorySettings;
  integrations: IntegrationSettings;
  speech: SpeechSettings;
  markets: MarketsSettings;
  weather: WeatherSettings;
}

export const DEFAULT_SETTINGS: KuronamiSettings = {
  appearance: {
    theme: "dark",
    accentOverride: null,
    density: "comfortable",
    oberflaeche: "standard",
  },
  models: {
    routineModel: null,
    architectureModel: null,
  },
  approvals: {
    autoApproveUpTo: "read",
  },
  memory: {
    location: null,
  },
  integrations: {
    n8nEndpoint: null,
  },
  speech: {
    inputDevice: null,
    outputDevice: null,
    wakeWord: "Kuronami",
    // Seit S31 ist Barge-in gebaut und in der Pipeline **immer** an: sie unterbricht, sobald
    // das VAD den Nutzer hört. Dieses Feld bleibt trotzdem stehen — es beschreibt, was die
    // Oberfläche anzeigt, und hat heute keinen Schalter im Sprachprozess dahinter.
    bargeIn: true,
    sprechtaste: true,
    endpoint: null,
    sessionToken: null,
  },
  markets: {
    // Ein Startpunkt, bis der Nutzer die Liste selbst füllt: DAX, S&P 500, Bitcoin, Euro/Dollar.
    watchlist: ["^GDAXI", "^GSPC", "BTC-USD", "EURUSD=X"],
    chart: DEFAULT_CHART,
  },
  weather: {
    place: "Wien",
    latitude: 48.2085,
    longitude: 16.3721,
  },
};

export const SETTINGS_STORAGE_KEY = "kuronami.settings.v1";

function storage(explicit?: Storage): Storage | null {
  if (explicit) return explicit;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function mergeSection<T extends object>(defaults: T, stored: unknown): T {
  if (typeof stored !== "object" || stored === null) return { ...defaults };
  return { ...defaults, ...(stored as Partial<T>) };
}

/** Baut ein vollständiges `KuronamiSettings` aus rohem, möglicherweise unvollständigem oder
 * fremdem JSON — jedes fehlende oder falsch geformte Feld fällt auf `DEFAULT_SETTINGS` zurück. */
export function normalizeSettings(raw: unknown): KuronamiSettings {
  const candidate = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  // Die Hintergrundwahl gehörte zur klassischen Hülle (bis S47). Ein gespeicherter Stand trägt
  // sie noch — als eigenes Bild eine Data-URL von einigen hundert Kilobyte —, und
  // `mergeSection` reichte sie bei jedem Speichern weiter. Hier fällt sie weg.
  const { background: _archiviert, ...appearance } = mergeSection(
    DEFAULT_SETTINGS.appearance,
    candidate.appearance,
  ) as AppearanceSettings & { background?: unknown };
  if (appearance.oberflaeche !== "modern") appearance.oberflaeche = "standard";
  return {
    appearance,
    models: mergeSection(DEFAULT_SETTINGS.models, candidate.models),
    approvals: mergeSection(DEFAULT_SETTINGS.approvals, candidate.approvals),
    memory: mergeSection(DEFAULT_SETTINGS.memory, candidate.memory),
    integrations: mergeSection(DEFAULT_SETTINGS.integrations, candidate.integrations),
    speech: normalizeSpeech(candidate.speech),
    markets: normalizeMarkets(candidate.markets),
    weather: mergeSection(DEFAULT_SETTINGS.weather, candidate.weather),
  };
}

/**
 * Die Adresse der Sprachschicht muss eine WebSocket-Adresse sein — alles andere fällt auf die
 * Vorgabe zurück, und das Geheimnis daneben mit.
 *
 * Anlass (2026-09-27): Chrome hielt „Sprachprozess" (Textfeld) und „Sitzungs-Token"
 * (Passwortfeld) für eine Anmeldemaske und setzte den Benutzernamen und das Passwort der
 * Oberfläche ein. Die Sprachschicht wurde danach unter dem Anmeldenamen gesucht, und ein Neustart
 * des Dienstes half nicht, weil der Fehler im Browser lag. Steht in der Adresse etwas, das
 * keine ist, stammt das Geheimnis aus demselben Griff — es bleibt nicht stehen.
 */
export function istSprachAdresse(value: string): boolean {
  return /^wss?:\/\/[^\s/]+/i.test(value);
}

function normalizeSpeech(stored: unknown): SpeechSettings {
  const speech = mergeSection(DEFAULT_SETTINGS.speech, stored);
  const endpoint = typeof speech.endpoint === "string" ? speech.endpoint.trim() : "";
  if (endpoint.length === 0) return { ...speech, endpoint: null };
  if (istSprachAdresse(endpoint)) return { ...speech, endpoint };
  return { ...speech, endpoint: null, sessionToken: null };
}

/** Die Liste selbst wird geprüft, nicht nur verschmolzen: nur Zeichenketten bleiben, und ein
 * gespeichertes `[]` ist eine Entscheidung des Nutzers (alles entfernt), keine Lücke. */
function normalizeMarkets(stored: unknown): MarketsSettings {
  const record =
    typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
  const chart = normalizeChart(record.chart);
  if (!Array.isArray(record.watchlist))
    return { watchlist: [...DEFAULT_SETTINGS.markets.watchlist], chart };
  return {
    watchlist: record.watchlist.filter((entry): entry is string => typeof entry === "string"),
    chart,
  };
}

export function loadSettings(explicit?: Storage): KuronamiSettings {
  const store = storage(explicit);
  if (!store) return normalizeSettings(undefined);
  try {
    const raw = store.getItem(SETTINGS_STORAGE_KEY);
    if (raw === null) return normalizeSettings(undefined);
    return normalizeSettings(JSON.parse(raw));
  } catch {
    // Kaputtes JSON oder kein Zugriff — Vorgabe statt Absturz (AGENTS.md gilt für Fehler im
    // Verlauf, nicht für eine unlesbare Kleinigkeit wie einen beschädigten Einstellungs-Blob).
    return normalizeSettings(undefined);
  }
}

export function saveSettings(settings: KuronamiSettings, explicit?: Storage): void {
  const store = storage(explicit);
  if (!store) return;
  try {
    store.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Kein Speicherplatz oder kein Zugriff — gilt dann nur für diese Sitzung im Arbeitsspeicher.
  }
}

/** Ändert genau einen Abschnitt und speichert das Ergebnis. Gibt die vollständigen, neuen
 * Einstellungen zurück. */
export function updateSettingsSection<K extends keyof KuronamiSettings>(
  section: K,
  patch: Partial<KuronamiSettings[K]>,
  explicit?: Storage,
): KuronamiSettings {
  const current = loadSettings(explicit);
  const next: KuronamiSettings = {
    ...current,
    [section]: { ...current[section], ...patch },
  };
  saveSettings(next, explicit);
  return next;
}

export type SettingsListener = (settings: KuronamiSettings) => void;

/** Ein winziger Sender für Änderungen, die außerhalb der Einstellungsseite sichtbar werden
 * müssen — Hintergrund/Akzent/Dichte wirken auf die ganze Hülle (Seitenleiste, Mic-Button), die
 * unabhängig von der gerade aktiven Ansicht sichtbar bleibt (Punkt 4a: immer genau eine aktive
 * Ansicht, aber die Hülle liegt außerhalb davon). */
export function createSettingsBus() {
  const listeners = new Set<SettingsListener>();
  return {
    emit(settings: KuronamiSettings): void {
      for (const listener of listeners) listener(settings);
    },
    subscribe(listener: SettingsListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const settingsBus = createSettingsBus();
