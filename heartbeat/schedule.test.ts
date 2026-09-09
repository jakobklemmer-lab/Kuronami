import { describe, expect, it } from "vitest";
import {
  CronParseError,
  cronMatches,
  nextFireAfter,
  parseCron,
  previousFireAtOrBefore,
} from "./schedule.js";

/**
 * Der Cron-Parser ohne Datenbank. Minutengranularität, lokale Zeit des Prozesses — die Tests
 * bauen `Date` mit lokalen Feldern (`new Date(2026, 8, 9, 7, 0)`), damit sie unabhängig von
 * der Zeitzone des Läufers grün bleiben.
 */

describe("parseCron", () => {
  it("nimmt die Grundformen an", () => {
    expect(() => parseCron("0 7 * * *")).not.toThrow();
    expect(() => parseCron("*/15 * * * *")).not.toThrow();
    expect(() => parseCron("30 8 * * 1-5")).not.toThrow();
    expect(() => parseCron("0 0,12 1 */2 *")).not.toThrow();
  });

  it("weist alles ab, was nicht der Form entspricht", () => {
    expect(() => parseCron("0 7 * *")).toThrow(CronParseError); // vier Felder
    expect(() => parseCron("60 7 * * *")).toThrow(CronParseError); // Minute außerhalb 0-59
    expect(() => parseCron("0 7 * * MON")).toThrow(CronParseError); // kein Namensalias
    expect(() => parseCron("0 7 * * * 2026")).toThrow(CronParseError); // sechs Felder
    expect(() => parseCron("*/0 7 * * *")).toThrow(CronParseError); // Schrittweite 0
    expect(() => parseCron("9-5 7 * * *")).toThrow(CronParseError); // rückwärts
  });
});

describe("cronMatches", () => {
  it("täglich 07:00", () => {
    const expr = parseCron("0 7 * * *");
    expect(cronMatches(expr, new Date(2026, 8, 9, 7, 0))).toBe(true);
    expect(cronMatches(expr, new Date(2026, 8, 9, 7, 1))).toBe(false);
    expect(cronMatches(expr, new Date(2026, 8, 9, 8, 0))).toBe(false);
  });

  it("alle 15 Minuten", () => {
    const expr = parseCron("*/15 * * * *");
    for (const m of [0, 15, 30, 45]) {
      expect(cronMatches(expr, new Date(2026, 8, 9, 3, m))).toBe(true);
    }
    expect(cronMatches(expr, new Date(2026, 8, 9, 3, 7))).toBe(false);
  });

  it("werktags 08:30 (dow eingeschränkt, dom offen → dow muss passen)", () => {
    const expr = parseCron("30 8 * * 1-5");
    expect(cronMatches(expr, new Date(2026, 8, 9, 8, 30))).toBe(true); // 2026-09-09 ist ein Mittwoch
    expect(cronMatches(expr, new Date(2026, 8, 12, 8, 30))).toBe(false); // Samstag
    expect(cronMatches(expr, new Date(2026, 8, 13, 8, 30))).toBe(false); // Sonntag
  });
});

describe("previousFireAtOrBefore / nextFireAfter", () => {
  const expr = parseCron("0 7 * * *");

  it("findet den heutigen 07:00 von einem späteren Zeitpunkt aus", () => {
    const prev = previousFireAtOrBefore(expr, new Date(2026, 8, 9, 9, 30));
    expect(prev).toEqual(new Date(2026, 8, 9, 7, 0));
  });

  it("liegt der Zeitpunkt vor 07:00, ist es der gestrige 07:00", () => {
    const prev = previousFireAtOrBefore(expr, new Date(2026, 8, 9, 6, 59));
    expect(prev).toEqual(new Date(2026, 8, 8, 7, 0));
  });

  it("nextFireAfter ist der morgige 07:00, wenn heute 07:00 schon vorbei ist", () => {
    const next = nextFireAfter(expr, new Date(2026, 8, 9, 7, 0));
    expect(next).toEqual(new Date(2026, 8, 10, 7, 0));
  });

  it("Sekundenanteil spielt keine Rolle (Minutenraster)", () => {
    const prev = previousFireAtOrBefore(expr, new Date(2026, 8, 9, 7, 0, 45));
    expect(prev).toEqual(new Date(2026, 8, 9, 7, 0));
  });
});
