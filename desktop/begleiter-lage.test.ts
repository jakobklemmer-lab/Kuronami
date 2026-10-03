import { describe, expect, it } from "vitest";
import lage from "./begleiter-lage.cjs";

const { FIGUR, FENSTER, setzeAb, ausDemRand, aufbau, figurAus, startLage, trifft } = lage;

// Ein Schirm wie Jakobs Mac: oben die Menüleiste, unten ein Dock.
const mac = {
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  workArea: { x: 0, y: 37, width: 1512, height: 870 },
};
// Ein zweiter Schirm rechts daneben.
const rechts = {
  bounds: { x: 1512, y: 0, width: 1920, height: 1080 },
  workArea: { x: 1512, y: 0, width: 1920, height: 1080 },
};

describe("setzeAb", () => {
  it("hält ihn auf dem Schirm", () => {
    expect(setzeAb({ x: 700, y: -300 }, [mac])).toEqual({ x: 700, y: 37, rand: null });
    expect(setzeAb({ x: 700, y: 2000 }, [mac])).toEqual({
      x: 700,
      y: 907 - FIGUR.hoehe,
      rand: null,
    });
  });

  it("nimmt ihn an einer freien Kante halb hinaus", () => {
    expect(setzeAb({ x: -40, y: 400 }, [mac])).toEqual({
      x: -FIGUR.breite / 2,
      y: 400,
      rand: "links",
    });
    expect(setzeAb({ x: 1400, y: 400 }, [mac])).toEqual({
      x: 1512 - FIGUR.breite / 2,
      y: 400,
      rand: "rechts",
    });
  });

  it("knapp vor der Kante bleibt er ganz da", () => {
    // Mitte 57 px vor der Kante: noch kein Zurücknehmen.
    expect(setzeAb({ x: 57 - FIGUR.breite / 2, y: 400 }, [mac]).rand).toBeNull();
  });

  it("versteckt sich nicht an der Kante zu einem zweiten Schirm", () => {
    const l = setzeAb({ x: 1500 - FIGUR.breite / 2, y: 400 }, [mac, rechts]);
    expect(l.rand).toBeNull();
    expect(l.x).toBe(1512 - FIGUR.breite);
  });

  it("holt ihn vom abgesteckten Schirm auf den nächsten", () => {
    expect(setzeAb({ x: 2500, y: 300 }, [mac])).toEqual({
      x: 1512 - FIGUR.breite / 2,
      y: 300,
      rand: "rechts",
    });
  });
});

describe("aufbau", () => {
  it("stellt die Blase über ihn, wenn oben Platz ist, und bleibt beim Umrechnen bei der Figur", () => {
    const figur = { x: 700, y: 600 };
    const a = aufbau(figur, [mac]);
    expect(a.seite).toBe("oben");
    expect(a.versatz).toBe(0);
    expect(a.fenster).toEqual({ x: 624, y: 340, width: FENSTER.breite, height: FENSTER.hoehe });
    expect(figurAus(a.fenster, a)).toEqual(figur);
  });

  it("stellt die Blase unter ihn, wenn er oben steht", () => {
    const figur = { x: 700, y: 60 };
    const a = aufbau(figur, [mac]);
    expect(a.seite).toBe("unten");
    expect(a.fenster.y).toBe(60);
    expect(figurAus(a.fenster, a)).toEqual(figur);
  });

  it("rückt die Figur im Fenster zur Seite, damit die Blase auf dem Schirm bleibt", () => {
    const a = aufbau({ x: 0, y: 600 }, [mac]);
    expect(a.fenster.x).toBe(0);
    expect(a.versatz).toBe(-(FENSTER.breite - FIGUR.breite) / 2);
    expect(figurAus(a.fenster, a).x).toBe(0);
  });

  it("zurückgenommen hängt das Fenster über die Kante", () => {
    const figur = { x: -FIGUR.breite / 2, y: 400 };
    const a = aufbau(figur, [mac]);
    expect(a.fenster.x).toBeLessThan(0);
    expect(figurAus(a.fenster, a).x).toBe(figur.x);
  });
});

describe("ausDemRand", () => {
  it("holt ihn an dieselbe Kante herein", () => {
    expect(ausDemRand({ x: -84, y: 400, rand: "links" }, [mac])).toEqual({
      x: 0,
      y: 400,
      rand: null,
    });
    expect(ausDemRand({ x: 1428, y: 400, rand: "rechts" }, [mac])).toEqual({
      x: 1512 - FIGUR.breite,
      y: 400,
      rand: null,
    });
    const frei = { x: 500, y: 400, rand: null };
    expect(ausDemRand(frei, [mac])).toBe(frei);
  });
});

describe("startLage", () => {
  it("ohne gemerkte Lage unten rechts auf dem Hauptschirm", () => {
    expect(startLage(null, [mac], mac)).toEqual({
      x: 1512 - FIGUR.breite - 24,
      y: 907 - FIGUR.hoehe - 24,
      rand: null,
    });
  });

  it("eine gemerkte Lage gilt, auch zurückgenommen", () => {
    expect(startLage({ x: -84, y: 300 }, [mac], mac)).toEqual({ x: -84, y: 300, rand: "links" });
    expect(startLage({ x: "kaputt" }, [mac], mac).rand).toBeNull();
  });
});

describe("trifft", () => {
  it("nur innerhalb der gemeldeten Flächen", () => {
    const flaechen = [{ x: 100, y: 280, w: 110, h: 160 }];
    expect(trifft({ x: 150, y: 300 }, flaechen)).toBe(true);
    expect(trifft({ x: 20, y: 300 }, flaechen)).toBe(false);
    expect(trifft({ x: 150, y: 300 }, [])).toBe(false);
  });
});
