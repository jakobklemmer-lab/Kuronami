import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WINDOW_FEATURES,
  DETACHED_WINDOW_SIZE,
  type TauriGlobal,
  detachView,
  detectDetachTarget,
  shouldDetachOnDragEnd,
} from "./detach.js";

/** Ein Ersatz für die globale Tauri-API (S29). Merkt sich, womit ein Fenster gebaut wurde. */
function fakeTauri(options: { throwOnCreate?: boolean } = {}) {
  const created: { label: string; options: Record<string, unknown> }[] = [];
  const scope: { __TAURI__?: TauriGlobal } = {
    __TAURI__: {
      webviewWindow: {
        WebviewWindow: class {
          constructor(label: string, windowOptions: Record<string, unknown>) {
            if (options.throwOnCreate) throw new Error("Label bereits vergeben");
            created.push({ label, options: windowOptions });
          }
        } as unknown as TauriGlobal["webviewWindow"] extends infer T
          ? T extends { WebviewWindow: infer C }
            ? C
            : never
          : never,
      },
    },
  };
  return { scope, created };
}

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

describe("detectDetachTarget (S29)", () => {
  it("meldet den Browser, wenn keine Tauri-API da ist", () => {
    expect(detectDetachTarget({})).toBe("browser");
  });

  it("meldet den Browser, wenn __TAURI__ da ist, aber ohne WebviewWindow", () => {
    expect(detectDetachTarget({ __TAURI__: {} })).toBe("browser");
  });

  it("meldet Tauri, wenn die globale API bereitsteht", () => {
    expect(detectDetachTarget(fakeTauri().scope)).toBe("tauri");
  });
});

describe("detachView unter Tauri (S29)", () => {
  it("baut ein WebviewWindow statt window.open aufzurufen", () => {
    const { scope, created } = fakeTauri();
    const opener = vi.fn(() => ({ focus: vi.fn() }) as unknown as Window);

    const ok = detachView("mail", { scope, opener, baseUrl: () => "http://localhost:3001/" });

    expect(ok).toBe(true);
    expect(opener).not.toHaveBeenCalled();
    expect(created).toHaveLength(1);
    expect(created[0]?.label).toBe("kuronami-mail");
    expect(created[0]?.options).toMatchObject({
      url: "http://localhost:3001/#/mail",
      width: DETACHED_WINDOW_SIZE.width,
      height: DETACHED_WINDOW_SIZE.height,
    });
  });

  it("traegt den Einstellungs-Abschnitt auch unter Tauri mit", () => {
    const { scope, created } = fakeTauri();
    detachView("settings", { scope, section: "models", baseUrl: () => "http://localhost:3001/" });
    expect(created[0]?.options.url).toBe("http://localhost:3001/#/settings/models");
  });

  it("wertet ein bereits vergebenes Fenster-Label als Erfolg, nicht als Fehlschlag", () => {
    const { scope } = fakeTauri({ throwOnCreate: true });
    const onBlocked = vi.fn();
    expect(detachView("mail", { scope, onBlocked, baseUrl: () => "http://x/" })).toBe(true);
    // Unter Tauri gibt es keinen Popup-Blocker — der Hinweis darf hier nie erscheinen.
    expect(onBlocked).not.toHaveBeenCalled();
  });
});
