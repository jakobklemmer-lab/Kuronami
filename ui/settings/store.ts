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

export type ThemeMode = "dark" | "system";
export type Density = "comfortable" | "compact";

export interface AppearanceSettings {
  theme: ThemeMode;
  /** Von Hand gewählter Akzent, falls gesetzt — überschreibt den aus dem Raum abgeleiteten
   * Akzent (`ui/theme/palette.ts`). `null` heißt: dem Raum folgen. */
  accentOverride: string | null;
  density: Density;
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
    endpoint: null,
    sessionToken: null,
  },
  markets: {
    // Ein Startpunkt, bis der Nutzer die Liste selbst füllt: DAX, S&P 500, Bitcoin, Euro/Dollar.
    watchlist: ["^GDAXI", "^GSPC", "BTC-USD", "EURUSD=X"],
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
  return {
    appearance,
    models: mergeSection(DEFAULT_SETTINGS.models, candidate.models),
    approvals: mergeSection(DEFAULT_SETTINGS.approvals, candidate.approvals),
    memory: mergeSection(DEFAULT_SETTINGS.memory, candidate.memory),
    integrations: mergeSection(DEFAULT_SETTINGS.integrations, candidate.integrations),
    speech: mergeSection(DEFAULT_SETTINGS.speech, candidate.speech),
    markets: normalizeMarkets(candidate.markets),
    weather: mergeSection(DEFAULT_SETTINGS.weather, candidate.weather),
  };
}

/** Die Liste selbst wird geprüft, nicht nur verschmolzen: nur Zeichenketten bleiben, und ein
 * gespeichertes `[]` ist eine Entscheidung des Nutzers (alles entfernt), keine Lücke. */
function normalizeMarkets(stored: unknown): MarketsSettings {
  const record =
    typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
  if (!Array.isArray(record.watchlist))
    return { watchlist: [...DEFAULT_SETTINGS.markets.watchlist] };
  return {
    watchlist: record.watchlist.filter((entry): entry is string => typeof entry === "string"),
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
