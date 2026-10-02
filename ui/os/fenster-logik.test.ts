import { describe, expect, it } from "vitest";
import {
  MIN_B,
  andockRechteck,
  andockZone,
  begrenze,
  nebeneinander,
  staffel,
  zieheRand,
} from "./fenster-logik.js";

const F = { x: 0, y: 32, b: 1512, h: 820 };

describe("andocken", () => {
  it("erkennt die Ränder und teilt die Fläche", () => {
    expect(andockZone(3, 400, F)).toBe("links");
    expect(andockZone(1510, 400, F)).toBe("rechts");
    expect(andockZone(700, 33, F)).toBe("voll");
    expect(andockZone(700, 400, F)).toBeNull();
    const l = andockRechteck("links", F);
    const r = andockRechteck("rechts", F);
    expect(l.x).toBe(6);
    expect(r.x + r.b).toBeLessThanOrEqual(F.b);
    expect(l.b).toBe(r.b);
  });
});

describe("begrenze", () => {
  it("hält Mindestgröße und Titelleiste auf dem Schirm", () => {
    const r = begrenze({ x: -2000, y: -50, b: 100, h: 100 }, F);
    expect(r.b).toBe(MIN_B);
    expect(r.y).toBe(32);
    expect(r.x + r.b).toBeGreaterThanOrEqual(140);
  });
});

describe("staffel und nebeneinander", () => {
  it("versetzt neue Fenster und füllt die Fläche ohne Überlapp", () => {
    const a = staffel(0, { b: 800, h: 600 }, F);
    const b = staffel(1, { b: 800, h: 600 }, F);
    expect(b.x - a.x).toBe(28);
    const drei = nebeneinander(3, F);
    expect(drei).toHaveLength(3);
    expect(drei[0].h).toBeGreaterThan(drei[1].h);
    const vier = nebeneinander(4, F);
    expect(vier[1].x).toBeGreaterThan(vier[0].x + vier[0].b);
    expect(vier[2].y).toBeGreaterThan(vier[0].y + vier[0].h);
  });
});

describe("zieheRand", () => {
  it("ändert die Größe an Rand und Ecke, nie unter das Minimum", () => {
    const s = { x: 100, y: 100, b: 600, h: 400 };
    expect(zieheRand(s, "se", 50, 30, F)).toEqual({ x: 100, y: 100, b: 650, h: 430 });
    expect(zieheRand(s, "w", 100, 0, F)).toEqual({ x: 200, y: 100, b: 500, h: 400 });
    expect(zieheRand(s, "e", -1000, 0, F).b).toBe(MIN_B);
  });
});
