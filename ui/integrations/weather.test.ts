import { describe, expect, it } from "vitest";
import { dayName, describeWeatherCode, mapOpenMeteo, openMeteoUrl } from "./weather.js";

describe("describeWeatherCode", () => {
  it("kennt klar, bewölkt, Regen, Schnee, Gewitter", () => {
    expect(describeWeatherCode(0)).toEqual({ text: "Klar", clear: true });
    expect(describeWeatherCode(3).clear).toBe(false);
    expect(describeWeatherCode(63).text).toBe("Regen");
    expect(describeWeatherCode(73).text).toBe("Schnee");
    expect(describeWeatherCode(95).text).toBe("Gewitter");
  });

  it("gibt für unbekannte Codes einen Strich statt zu raten", () => {
    expect(describeWeatherCode(42).text).toBe("—");
  });
});

describe("mapOpenMeteo", () => {
  const today = new Date(2026, 8, 16, 21, 0, 0);
  const sample = {
    current: { temperature_2m: 16.4, weather_code: 0, is_day: 0 },
    daily: {
      time: ["2026-09-16", "2026-09-17", "2026-09-18"],
      weather_code: [0, 2, 61],
      temperature_2m_max: [27.6, 28.9, 22.1],
      temperature_2m_min: [13.7, 15.2, 12.8],
    },
  };

  it("bildet aktuelle Werte und drei Tage ab", () => {
    const result = mapOpenMeteo(sample, "Wien", today);
    expect(result.place).toBe("Wien");
    expect(result.temperature).toBe(16);
    expect(result.description).toBe("Klar");
    expect(result.night).toBe(true);
    expect(result.forecast).toEqual([
      { name: "Heute", high: 28, low: 14, clear: true },
      { name: "Do", high: 29, low: 15, clear: false },
      { name: "Fr", high: 22, low: 13, clear: false },
    ]);
  });

  it("wirft, wenn die aktuellen Werte fehlen", () => {
    expect(() => mapOpenMeteo({ daily: sample.daily }, "Wien", today)).toThrow(/aktuellen Werte/);
  });

  it("überspringt Tage mit Lücken statt NaN zu zeigen", () => {
    const result = mapOpenMeteo(
      {
        ...sample,
        daily: { ...sample.daily, temperature_2m_max: [27.6, null, 22.1] },
      },
      "Wien",
      today,
    );
    expect(result.forecast.map((d) => d.name)).toEqual(["Heute", "Fr"]);
  });
});

describe("dayName", () => {
  it("nennt den ersten Tag Heute und die weiteren mit Kürzel", () => {
    const today = new Date(2026, 8, 16);
    expect(dayName("2026-09-16", 0, today)).toBe("Heute");
    expect(dayName("2026-09-17", 1, today)).toBe("Do");
  });
});

describe("openMeteoUrl", () => {
  it("fragt aktuelle Werte und drei Tage mit automatischer Zeitzone ab", () => {
    const url = new URL(openMeteoUrl({ place: "Wien", latitude: 48.2085, longitude: 16.3721 }));
    expect(url.hostname).toBe("api.open-meteo.com");
    expect(url.searchParams.get("latitude")).toBe("48.2085");
    expect(url.searchParams.get("forecast_days")).toBe("3");
    expect(url.searchParams.get("timezone")).toBe("auto");
  });
});
