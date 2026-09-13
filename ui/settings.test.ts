import { describe, expect, it } from "vitest";
import { TOKEN_STORAGE_KEY, loadToken, saveToken } from "./settings.js";

/** Ein Speicher ohne Netz und ohne Browser — dieselbe Rolle wie `SocketLike` in
 * `ui/events/bus.ts`. */
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

describe("Token-Speicher", () => {
  it("liefert null, solange nichts gespeichert wurde", () => {
    expect(loadToken(fakeStorage())).toBeNull();
  });

  it("speichert und liest denselben Token zurück", () => {
    const store = fakeStorage();
    saveToken("geheim-123", store);
    expect(loadToken(store)).toBe("geheim-123");
    expect(store.getItem(TOKEN_STORAGE_KEY)).toBe("geheim-123");
  });

  it("löscht den Eintrag bei einem leeren Token, statt eine leere Zeichenkette zu halten", () => {
    const store = fakeStorage();
    saveToken("geheim-123", store);
    saveToken("", store);
    expect(loadToken(store)).toBeNull();
  });
});
