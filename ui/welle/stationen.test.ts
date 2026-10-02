import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ROUTE_IDS } from "../router/router.js";
import { FILM_BILDER, SCHARFE_BILDER, STATIONEN, WEG, stationFuer } from "./stationen.js";

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
    expect(WEG.map((s) => s.route)).toEqual(["praesenz", "mail", "calendar"]);
  });

  it("hat für jede Station ein scharfes Bild, in beiden Größen", () => {
    expect(SCHARFE_BILDER).toHaveLength(STATIONEN.length);
    for (const i of SCHARFE_BILDER) {
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(FILM_BILDER);
      const name = `f${String(i + 1).padStart(3, "0")}.webp`;
      for (const groesse of ["2k", "4k"]) {
        expect(
          existsSync(path.join(__dirname, "film", "scharf", groesse, name)),
          `${groesse}/${name}`,
        ).toBe(true);
      }
    }
  });
});
