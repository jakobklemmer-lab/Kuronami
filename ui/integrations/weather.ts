import type { WeatherData, WeatherDay } from "./types.js";

/**
 * Wetter direkt aus dem Browser von Open-Meteo (Nachtrag 2026-09-16, Ablösung von
 * `createMockWeatherProvider`). Kein Schlüssel, CORS offen, deshalb ohne Umweg über das Gateway
 * — anders als Yahoo (`gateway/integrations/markets.ts`), das keine Browser-Anfragen zulässt.
 *
 * Der Ort kommt aus den Einstellungen (`settings.weather`), nicht aus dem Code: eine feste
 * Koordinate wäre nur der nächste Mock.
 */

export interface WeatherPlace {
  place: string;
  latitude: number;
  longitude: number;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** WMO-Wettercode (Open-Meteo `weather_code`) in Worte. Gruppen nach WMO 4677. */
export function describeWeatherCode(code: number): { text: string; clear: boolean } {
  if (code === 0) return { text: "Klar", clear: true };
  if (code === 1) return { text: "Überwiegend klar", clear: true };
  if (code === 2) return { text: "Teils bewölkt", clear: false };
  if (code === 3) return { text: "Bedeckt", clear: false };
  if (code === 45 || code === 48) return { text: "Nebel", clear: false };
  if (code >= 51 && code <= 57) return { text: "Sprühregen", clear: false };
  if (code >= 61 && code <= 67) return { text: "Regen", clear: false };
  if (code >= 71 && code <= 77) return { text: "Schnee", clear: false };
  if (code >= 80 && code <= 82) return { text: "Regenschauer", clear: false };
  if (code === 85 || code === 86) return { text: "Schneeschauer", clear: false };
  if (code >= 95) return { text: "Gewitter", clear: false };
  return { text: "—", clear: false };
}

interface OpenMeteoResponse {
  current?: { temperature_2m?: unknown; weather_code?: unknown; is_day?: unknown };
  daily?: {
    time?: unknown;
    weather_code?: unknown;
    temperature_2m_max?: unknown;
    temperature_2m_min?: unknown;
  };
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Wochentag-Kürzel für ein `YYYY-MM-DD`; der erste Tag heißt „Heute". */
export function dayName(isoDate: string, index: number, today: Date = new Date()): string {
  if (index === 0) return "Heute";
  const date = new Date(`${isoDate}T12:00:00`);
  if (Number.isNaN(date.getTime())) return isoDate;
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  if (sameDay) return "Heute";
  return date.toLocaleDateString("de-DE", { weekday: "short" }).replace(".", "");
}

export function mapOpenMeteo(json: unknown, place: string, today: Date = new Date()): WeatherData {
  const body = (json ?? {}) as OpenMeteoResponse;
  const temperature = num(body.current?.temperature_2m);
  const code = num(body.current?.weather_code);
  if (temperature === null || code === null) {
    throw new Error("Open-Meteo: keine aktuellen Werte in der Antwort.");
  }
  const now = describeWeatherCode(code);

  const times = Array.isArray(body.daily?.time) ? body.daily.time : [];
  const codes = Array.isArray(body.daily?.weather_code) ? body.daily.weather_code : [];
  const highs = Array.isArray(body.daily?.temperature_2m_max) ? body.daily.temperature_2m_max : [];
  const lows = Array.isArray(body.daily?.temperature_2m_min) ? body.daily.temperature_2m_min : [];
  const forecast: WeatherDay[] = [];
  for (let i = 0; i < times.length && forecast.length < 3; i += 1) {
    const high = num(highs[i]);
    const low = num(lows[i]);
    const dayCode = num(codes[i]);
    if (high === null || low === null || dayCode === null) continue;
    forecast.push({
      name: dayName(String(times[i]), i, today),
      high: Math.round(high),
      low: Math.round(low),
      clear: describeWeatherCode(dayCode).clear,
    });
  }

  return {
    place,
    temperature: Math.round(temperature),
    description: now.text,
    night: body.current?.is_day === 0,
    forecast,
  };
}

export function openMeteoUrl(where: WeatherPlace): string {
  const params = new URLSearchParams({
    latitude: String(where.latitude),
    longitude: String(where.longitude),
    current: "temperature_2m,weather_code,is_day",
    daily: "weather_code,temperature_2m_max,temperature_2m_min",
    timezone: "auto",
    forecast_days: "3",
  });
  return `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
}

export async function loadWeather(
  where: WeatherPlace,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
): Promise<WeatherData> {
  const response = await fetchImpl(openMeteoUrl(where));
  if (!response.ok) throw new Error(`Open-Meteo antwortet mit HTTP ${response.status}.`);
  return mapOpenMeteo(await response.json(), where.place);
}
