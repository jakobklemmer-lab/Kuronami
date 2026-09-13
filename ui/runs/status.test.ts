import { describe, expect, it } from "vitest";
import { RUN_STATUS_LABEL, runStatusClass, runStatusLabel } from "./status.js";

describe("Run-Status-Anzeige", () => {
  it("kennt eine Beschriftung für alle acht Zustände", () => {
    expect(Object.keys(RUN_STATUS_LABEL)).toHaveLength(8);
  });

  it("gibt für einen unbekannten Status ein eigenes, benanntes Abzeichen statt einer Lücke", () => {
    expect(runStatusLabel(null)).toBe("Status unklar");
    expect(runStatusClass(null)).toBe("run-status run-status--unknown");
  });

  it("bildet den Klassennamen aus dem Zustand, Unterstrich zu Bindestrich", () => {
    expect(runStatusClass("awaiting_user")).toBe("run-status run-status--awaiting-user");
    expect(runStatusClass("running")).toBe("run-status run-status--running");
  });
});
