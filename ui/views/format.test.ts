import { describe, expect, it } from "vitest";
import { formatDateLong, formatRelativeTime } from "./format.js";

describe("formatRelativeTime", () => {
  const now = new Date("2026-09-13T12:00:00.000Z");

  it('zeigt "gerade eben" fuer unter einer Minute', () => {
    expect(formatRelativeTime(new Date("2026-09-13T11:59:30.000Z").toISOString(), now)).toBe(
      "gerade eben",
    );
  });

  it("zeigt Minuten fuer unter einer Stunde", () => {
    expect(formatRelativeTime(new Date("2026-09-13T11:45:00.000Z").toISOString(), now)).toBe(
      "vor 15 Min.",
    );
  });

  it("zeigt Stunden fuer unter einem Tag", () => {
    expect(formatRelativeTime(new Date("2026-09-13T09:00:00.000Z").toISOString(), now)).toBe(
      "vor 3 Std.",
    );
  });

  it("zeigt Tage darueber hinaus", () => {
    expect(formatRelativeTime(new Date("2026-09-11T12:00:00.000Z").toISOString(), now)).toBe(
      "vor 2 Tg.",
    );
  });

  it('behandelt einen Zeitpunkt in der Zukunft als "gerade eben", nicht negativ', () => {
    expect(formatRelativeTime(new Date("2026-09-13T13:00:00.000Z").toISOString(), now)).toBe(
      "gerade eben",
    );
  });
});

describe("formatDateLong", () => {
  it("formatiert als deutsches Langdatum mit Wochentag", () => {
    const result = formatDateLong(new Date("2026-09-13T12:00:00.000Z"));
    expect(result).toContain("2026");
    expect(result).toMatch(/September/);
  });
});
