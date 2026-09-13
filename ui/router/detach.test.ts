import { describe, expect, it, vi } from "vitest";
import { DEFAULT_WINDOW_FEATURES, detachView, shouldDetachOnDragEnd } from "./detach.js";

describe("shouldDetachOnDragEnd", () => {
  it("gilt als Abdocken, wenn dropEffect none ist", () => {
    expect(shouldDetachOnDragEnd("none")).toBe(true);
  });

  it("gilt nicht als Abdocken bei jedem anderen dropEffect", () => {
    expect(shouldDetachOnDragEnd("move")).toBe(false);
    expect(shouldDetachOnDragEnd("copy")).toBe(false);
    expect(shouldDetachOnDragEnd("link")).toBe(false);
  });
});

describe("detachView", () => {
  it("öffnet die Route unter der Basis-URL mit dem passenden Hash", () => {
    const opener = vi.fn(() => ({ focus: vi.fn() }) as unknown as Window);
    const ok = detachView("mail", {
      opener,
      baseUrl: () => "http://localhost:3001/",
    });
    expect(ok).toBe(true);
    expect(opener).toHaveBeenCalledWith(
      "http://localhost:3001/#/mail",
      "kuronami-mail",
      DEFAULT_WINDOW_FEATURES,
    );
  });

  it("hängt den Einstellungs-Abschnitt an, wenn angegeben", () => {
    const opener = vi.fn(() => ({ focus: vi.fn() }) as unknown as Window);
    detachView("settings", {
      opener,
      section: "models",
      baseUrl: () => "http://localhost:3001/",
    });
    expect(opener).toHaveBeenCalledWith(
      "http://localhost:3001/#/settings/models",
      "kuronami-settings",
      DEFAULT_WINDOW_FEATURES,
    );
  });

  it("meldet einen blockierten Popup über onBlocked und gibt false zurück", () => {
    const onBlocked = vi.fn();
    const ok = detachView("home", {
      opener: () => null,
      baseUrl: () => "http://localhost:3001/",
      onBlocked,
    });
    expect(ok).toBe(false);
    expect(onBlocked).toHaveBeenCalledOnce();
  });

  it("ruft focus() auf dem geöffneten Fenster auf, wenn vorhanden", () => {
    const focus = vi.fn();
    detachView("home", {
      opener: () => ({ focus }) as unknown as Window,
      baseUrl: () => "http://localhost:3001/",
    });
    expect(focus).toHaveBeenCalledOnce();
  });
});
