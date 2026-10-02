import { describe, expect, it } from "vitest";
import { baueNetz, schritt } from "./graph-sim.js";

describe("Graph-Simulation", () => {
  it("bringt verbundene Notizen näher zusammen als unverbundene und kommt zur Ruhe", () => {
    const knoten = ["a", "b", "c"].map((p) => ({ pfad: p, titel: p, ordner: "" }));
    const netz = baueNetz(knoten, [["a", "b"]]);
    let laeuft = true;
    for (let i = 0; i < 600 && laeuft; i++) laeuft = schritt(netz);
    const [a, b, c] = netz.knoten;
    const ab = Math.hypot(a.x - b.x, a.y - b.y);
    const ac = Math.hypot(a.x - c.x, a.y - c.y);
    expect(ab).toBeLessThan(ac);
    expect(laeuft).toBe(false);
    expect(netz.knoten[0].grad).toBe(1);
  });
});
