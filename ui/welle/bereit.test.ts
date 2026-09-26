import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client.js";
import { verfolge } from "./bereit.js";

/**
 * Ein Bereich zeigt sich erst, wenn seine ersten Antworten da sind — aber nie später als die
 * Obergrenze. Beides muss stimmen: zu früh, und die Platzhalter springen sichtbar um; nie, und
 * die Seite bleibt leer, weil ein Anbieter hängt.
 */

function kontrollierteApi() {
  const offen: Array<(wert: unknown) => void> = [];
  const api: ApiClient = {
    get: () => new Promise((los) => offen.push(los as (wert: unknown) => void)) as never,
    post: () => Promise.resolve() as never,
    patch: () => Promise.resolve() as never,
    delete: () => Promise.resolve() as never,
  };
  return { api, beantworte: () => offen.shift()?.({}) };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("verfolge", () => {
  it("wartet, bis die Antwort da ist, und dann noch die Ruhe", async () => {
    const { api, beantworte } = kontrollierteApi();
    const v = verfolge(api);
    void v.api.get("/a");
    let fertig = false;
    void v.bereit({ ruheMs: 60, hoechstensMs: 700 }).then(() => {
      fertig = true;
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(fertig).toBe(false);
    beantworte();
    await vi.advanceTimersByTimeAsync(59);
    expect(fertig).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(fertig).toBe(true);
  });

  it("wartet auch auf eine Anfrage, die erst nach der ersten Antwort gestellt wird", async () => {
    const { api, beantworte } = kontrollierteApi();
    const v = verfolge(api);
    void v.api.get("/kurse").then(() => void v.api.get("/kerzen"));
    let fertig = false;
    void v.bereit({ ruheMs: 60, hoechstensMs: 700 }).then(() => {
      fertig = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    beantworte();
    await vi.advanceTimersByTimeAsync(200);
    expect(fertig).toBe(false);
    beantworte();
    await vi.advanceTimersByTimeAsync(61);
    expect(fertig).toBe(true);
  });

  it("zeigt sich spätestens an der Obergrenze, auch wenn eine Antwort hängt", async () => {
    const { api } = kontrollierteApi();
    const v = verfolge(api);
    void v.api.get("/haengt");
    let fertig = false;
    void v.bereit({ ruheMs: 60, hoechstensMs: 700 }).then(() => {
      fertig = true;
    });
    await vi.advanceTimersByTimeAsync(699);
    expect(fertig).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(fertig).toBe(true);
  });

  it("ist nach der Ruhe bereit, wenn der Bereich gar nichts lädt", async () => {
    const { api } = kontrollierteApi();
    const v = verfolge(api);
    let fertig = false;
    void v.bereit({ ruheMs: 60, hoechstensMs: 700 }).then(() => {
      fertig = true;
    });
    await vi.advanceTimersByTimeAsync(61);
    expect(fertig).toBe(true);
  });

  it("zählt eine gescheiterte Anfrage als beendet", async () => {
    const api: ApiClient = {
      get: () => Promise.reject(new Error("weg")),
      post: () => Promise.resolve() as never,
      patch: () => Promise.resolve() as never,
      delete: () => Promise.resolve() as never,
    };
    const v = verfolge(api);
    await v.api.get("/a").catch(() => undefined);
    let fertig = false;
    void v.bereit({ ruheMs: 60, hoechstensMs: 700 }).then(() => {
      fertig = true;
    });
    await vi.advanceTimersByTimeAsync(61);
    expect(fertig).toBe(true);
  });
});
