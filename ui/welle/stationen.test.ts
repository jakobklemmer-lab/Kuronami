import { describe, expect, it } from "vitest";
import { ROUTE_IDS } from "../router/router.js";
import { STATIONEN, WEG, stationFuer } from "./stationen.js";

describe("Stationen der Welle", () => {
  it("gibt jeder Route genau einen Ort", () => {
    for (const route of ROUTE_IDS) expect(stationFuer(route).route).toBe(route);
    expect(STATIONEN).toHaveLength(ROUTE_IDS.length);
  });

  it("legt die Orte in Wegrichtung, von 0 bis 1", () => {
    const orte = STATIONEN.map((s) => s.ort);
    expect(orte[0]).toBe(0);
    expect(orte.at(-1)).toBe(1);
    for (let i = 1; i < orte.length; i++) expect(orte[i]).toBeGreaterThan(orte[i - 1]);
  });

  it("stellt die Einstellungen nicht in den Weg", () => {
    expect(WEG.map((s) => s.route)).not.toContain("settings");
    expect(WEG[0].route).toBe("praesenz");
  });
});
