import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  loadSettings,
  normalizeSettings,
  saveSettings,
  updateSettingsSection,
} from "./store.js";

function fakeStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
    clear: () => data.clear(),
    key: (index) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  };
}

describe("normalizeSettings", () => {
  it("liefert die Vorgabe für undefined/null/fremde Werte", () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings("kaputt")).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(42)).toEqual(DEFAULT_SETTINGS);
  });

  it("übernimmt bekannte Felder und ergänzt fehlende je Abschnitt", () => {
    const result = normalizeSettings({
      appearance: { density: "compact" },
      speech: { wakeWord: "Wal" },
    });
    expect(result.appearance.density).toBe("compact");
    expect(result.appearance.theme).toBe(DEFAULT_SETTINGS.appearance.theme);
    expect(result.speech.wakeWord).toBe("Wal");
    expect(result.speech.bargeIn).toBe(DEFAULT_SETTINGS.speech.bargeIn);
    expect(result.models).toEqual(DEFAULT_SETTINGS.models);
  });

  it("lässt die archivierte Hintergrundwahl fallen, samt eigenem Bild", () => {
    const result = normalizeSettings({
      appearance: {
        density: "compact",
        background: { kind: "custom", dataUrl: `data:image/jpeg;base64,${"A".repeat(4096)}` },
      },
    });
    expect(result.appearance).not.toHaveProperty("background");
    expect(result.appearance.density).toBe("compact");
  });

  it("wirft eine Sprachadresse, die keine ist, samt Geheimnis weg (Browser-Autofill)", () => {
    const eingesetzt = normalizeSettings({
      speech: { endpoint: "jakob", sessionToken: "das-passwort" },
    });
    expect(eingesetzt.speech.endpoint).toBeNull();
    expect(eingesetzt.speech.sessionToken).toBeNull();

    const eigene = normalizeSettings({
      speech: { endpoint: " wss://voice.example.org ", sessionToken: "s3" },
    });
    expect(eigene.speech.endpoint).toBe("wss://voice.example.org");
    expect(eigene.speech.sessionToken).toBe("s3");

    const leer = normalizeSettings({ speech: { endpoint: "", sessionToken: "s3" } });
    expect(leer.speech.endpoint).toBeNull();
    expect(leer.speech.sessionToken).toBe("s3");
  });

  it("behält eine leere Beobachtungsliste und wirft Fremdes aus ihr heraus", () => {
    expect(normalizeSettings({ markets: { watchlist: [] } }).markets.watchlist).toEqual([]);
    expect(
      normalizeSettings({ markets: { watchlist: ["AAPL", 7, null] } }).markets.watchlist,
    ).toEqual(["AAPL"]);
    expect(normalizeSettings({ markets: {} }).markets.watchlist).toEqual(
      DEFAULT_SETTINGS.markets.watchlist,
    );
  });
});

describe("loadSettings/saveSettings", () => {
  it("liefert die Vorgabe, solange nichts gespeichert wurde", () => {
    expect(loadSettings(fakeStorage())).toEqual(DEFAULT_SETTINGS);
  });

  it("speichert und liest denselben Stand zurück", () => {
    const store = fakeStorage();
    const settings = normalizeSettings({ appearance: { density: "compact" } });
    saveSettings(settings, store);
    expect(loadSettings(store).appearance.density).toBe("compact");
    expect(JSON.parse(store.getItem(SETTINGS_STORAGE_KEY) as string).appearance.density).toBe(
      "compact",
    );
  });

  it("fällt bei kaputtem JSON auf die Vorgabe zurück, statt zu werfen", () => {
    const store = fakeStorage();
    store.setItem(SETTINGS_STORAGE_KEY, "{nicht json");
    expect(loadSettings(store)).toEqual(DEFAULT_SETTINGS);
  });
});

describe("updateSettingsSection", () => {
  it("ändert nur den angegebenen Abschnitt und lässt den Rest unverändert", () => {
    const store = fakeStorage();
    const next = updateSettingsSection("speech", { bargeIn: true }, store);
    expect(next.speech.bargeIn).toBe(true);
    expect(next.speech.wakeWord).toBe(DEFAULT_SETTINGS.speech.wakeWord);
    expect(next.models).toEqual(DEFAULT_SETTINGS.models);
    expect(loadSettings(store).speech.bargeIn).toBe(true);
  });

  it("baut auf dem zuvor gespeicherten Stand auf, nicht auf der Vorgabe", () => {
    const store = fakeStorage();
    updateSettingsSection("appearance", { density: "compact" }, store);
    const next = updateSettingsSection("appearance", { theme: "system" }, store);
    expect(next.appearance.density).toBe("compact");
    expect(next.appearance.theme).toBe("system");
  });
});
