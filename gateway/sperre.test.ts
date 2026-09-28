import { describe, expect, it } from "vitest";
import { kappe, sperrgrenze } from "./sperre.js";

const JETZT = new Date("2026-09-28T17:45:00Z");

describe("Sperrfrist", () => {
  it("sperrt je nach Zeitrahmen verschieden lang", () => {
    expect(sperrgrenze("1h", JETZT)).toBe("2026-04-01");
    expect(sperrgrenze("1d", JETZT)).toBe("2024-09-28");
    expect(sperrgrenze("15m", JETZT)).toBe("2026-06-30");
  });

  it("kürzt ein Ende hinter der Grenze auf den Tag davor", () => {
    expect(kappe("2026-09-28", "1h", JETZT)).toEqual({
      bis: "2026-03-31",
      gekappt: true,
      grenze: "2026-04-01",
    });
  });

  it("lässt ein Ende vor der Grenze stehen", () => {
    expect(kappe("2025-12-31", "1h", JETZT)).toEqual({
      bis: "2025-12-31",
      gekappt: false,
      grenze: "2026-04-01",
    });
  });
});
