import { describe, expect, it } from "vitest";
import { ORB_ZUSTAND, statuszeile } from "./sphaere.js";

/** Die Übersetzung zwischen Kuros Zuständen und denen des Orbs — ohne Browser, ohne WebGL. */

describe("ORB_ZUSTAND", () => {
  it("bildet jeden Zustand auf einen eigenen Zustand des Orbs ab", () => {
    const ziele = Object.values(ORB_ZUSTAND);
    expect(new Set(ziele).size).toBe(ziele.length);
    expect(ORB_ZUSTAND.rueckfrage).toBe("attention");
    expect(ORB_ZUSTAND.offline).toBe("offline");
  });
});

describe("statuszeile", () => {
  it("lässt kein Detail weg, das es nicht gibt", () => {
    expect(statuszeile(undefined)).toBeUndefined();
  });

  it("nimmt die erste Zeile mit Inhalt, ohne Stacktrace darunter", () => {
    expect(statuszeile("\n  Der Gateway antwortet nicht.\n    at fetch (client.ts:12)")).toBe(
      "Der Gateway antwortet nicht.",
    );
  });

  it("fasst Leerraum zusammen und kürzt lange Zeilen mit Auslassungszeichen", () => {
    expect(statuszeile("Gibt   weiter …")).toBe("Gibt weiter …");
    const lang = statuszeile("x".repeat(200), 80);
    expect(lang).toHaveLength(80);
    expect(lang?.endsWith("…")).toBe(true);
  });
});
