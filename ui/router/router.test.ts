import { describe, expect, it } from "vitest";
import { DEFAULT_ROUTE, DEFAULT_SETTINGS_SECTION, hashFor, parseHash } from "./router.js";

describe("parseHash", () => {
  it("liefert die Vorgabe-Route für einen leeren Hash", () => {
    expect(parseHash("")).toEqual({ view: DEFAULT_ROUTE });
    expect(parseHash("#")).toEqual({ view: DEFAULT_ROUTE });
    expect(parseHash("#/")).toEqual({ view: DEFAULT_ROUTE });
  });

  it("erkennt eine einfache Route mit oder ohne führendes #", () => {
    expect(parseHash("#/mail")).toEqual({ view: "mail" });
    expect(parseHash("/mail")).toEqual({ view: "mail" });
  });

  it("fällt auf die Vorgabe-Route zurück, wenn der Name unbekannt ist", () => {
    expect(parseHash("#/erfunden")).toEqual({ view: DEFAULT_ROUTE });
  });

  it("führt ein Lesezeichen auf das archivierte Dashboard in die Präsenz", () => {
    expect(DEFAULT_ROUTE).toBe("praesenz");
    expect(parseHash("#/home")).toEqual({ view: "praesenz" });
  });

  it("liest den Einstellungs-Abschnitt mit", () => {
    expect(parseHash("#/settings/haushalt")).toEqual({ view: "settings", section: "haushalt" });
  });

  it("fällt bei Einstellungen ohne oder mit unbekanntem Abschnitt auf die Vorgabe zurück", () => {
    expect(parseHash("#/settings")).toEqual({
      view: "settings",
      section: DEFAULT_SETTINGS_SECTION,
    });
    expect(parseHash("#/settings/erfunden")).toEqual({
      view: "settings",
      section: DEFAULT_SETTINGS_SECTION,
    });
  });
});

describe("hashFor", () => {
  it("baut den Hash für eine einfache Route", () => {
    expect(hashFor("mail")).toBe("#/mail");
  });

  it("baut den Hash für Einstellungen samt Abschnitt", () => {
    expect(hashFor("settings", "haushalt")).toBe("#/settings/haushalt");
  });

  it("nimmt die Vorgabe, wenn Einstellungen ohne Abschnitt gebaut werden", () => {
    expect(hashFor("settings")).toBe(`#/settings/${DEFAULT_SETTINGS_SECTION}`);
  });

  it("ist die Umkehrung von parseHash für jede Route", () => {
    for (const view of [
      "praesenz",
      "mail",
      "calendar",
      "trading",
      "research",
      "files",
      "system",
    ] as const) {
      expect(parseHash(hashFor(view))).toEqual({ view });
    }
  });
});
