import { describe, expect, it } from "vitest";
import { SIDEBAR_COLLAPSED_KEY, loadSidebarCollapsed, saveSidebarCollapsed } from "./collapse.js";

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

describe("Sidebar-Einklapp-Zustand", () => {
  it("ist ausgeklappt, solange nichts gespeichert wurde", () => {
    expect(loadSidebarCollapsed(fakeStorage())).toBe(false);
  });

  it("speichert und liest den eingeklappten Zustand zurück", () => {
    const store = fakeStorage();
    saveSidebarCollapsed(true, store);
    expect(loadSidebarCollapsed(store)).toBe(true);
    expect(store.getItem(SIDEBAR_COLLAPSED_KEY)).toBe("1");
  });

  it("liest den ausgeklappten Zustand nach explizitem Zurücksetzen", () => {
    const store = fakeStorage();
    saveSidebarCollapsed(true, store);
    saveSidebarCollapsed(false, store);
    expect(loadSidebarCollapsed(store)).toBe(false);
  });
});
