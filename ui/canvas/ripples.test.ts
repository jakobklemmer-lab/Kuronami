import { describe, expect, it } from "vitest";
import {
  RIPPLE_PROFILES,
  type RippleContext,
  RippleField,
  createRippleRenderer,
} from "./ripples.js";

/**
 * Der Wassereffekt ohne Browser. Möglich, weil `RippleField` weder `canvas` noch
 * `requestAnimationFrame` kennt: es bekommt eine Zeit herein und sagt, welche Kreise es gibt.
 * Der Unterschied zwischen den vier Mustern steht damit in Zahlen und nicht in einem Bild.
 */

/** Eine Uhr in festen Schritten — so wie es ein Bildtakt täte, nur vorhersagbar. */
function run(field: RippleField, fromMs: number, toMs: number, stepMs = 16): void {
  for (let time = fromMs; time <= toMs; time += stepMs) field.step(time);
}

/** Wann in einem Zeitraum Kreise entstanden sind — auch die, die schon wieder weg sind. */
function spawnTimes(field: RippleField, fromMs: number, toMs: number, stepMs = 16): number[] {
  const seen = new Set<number>();
  for (let time = fromMs; time <= toMs; time += stepMs) {
    field.step(time);
    for (const ring of field.visible) seen.add(ring.bornAt);
  }
  return [...seen].sort((a, b) => a - b);
}

interface FakeContext extends RippleContext {
  clears: number;
  arcs: Array<{ x: number; y: number; radius: number }>;
  strokes: number;
  alphas: number[];
}

function fakeContext(): FakeContext {
  const ctx: FakeContext = {
    clears: 0,
    arcs: [],
    strokes: 0,
    alphas: [],
    strokeStyle: "",
    lineWidth: 1,
    globalAlpha: 1,
    clearRect(): void {
      ctx.clears += 1;
    },
    beginPath(): void {},
    arc(x: number, y: number, radius: number): void {
      ctx.arcs.push({ x, y, radius });
      ctx.alphas.push(ctx.globalAlpha);
    },
    stroke(): void {
      ctx.strokes += 1;
    },
  };
  return ctx;
}

function field(): RippleField {
  return new RippleField({ width: 800, height: 300, random: () => 0.5, startedAt: 0 });
}

describe("Wassereffekt · Grundlage", () => {
  it("startet ruhig und leer und wächst erst mit der Zeit", () => {
    const water = field();

    expect(water.state).toBe("idle");
    expect(water.visible).toHaveLength(0);

    water.step(0);
    expect(water.visible).toHaveLength(1);
    expect(water.visible[0].radius).toBe(0);

    water.step(1000);
    expect(water.visible[0].radius).toBeCloseTo(RIPPLE_PROFILES.idle.speed, 5);
  });

  it("lässt einen Kreis verschwinden, sobald er seinen Rand erreicht hat", () => {
    const water = field();
    water.step(0);
    const { maxRadius, speed } = water.visible[0];

    // `complete` setzt den Takt aus — danach kommt kein Nachschub mehr, das Feld läuft leer.
    water.setState("complete", 10);
    run(water, 10, 10 + (maxRadius / speed) * 1000 + 12_000, 100);

    expect(water.visible).toHaveLength(0);
  });
});

describe("Wassereffekt · vier Zustände, vier Muster", () => {
  it("idle ist langsam, processing dicht — der Unterschied ist messbar", () => {
    const ruhig = field();
    const arbeit = field();
    arbeit.setState("processing", 0);

    const ruhigeKreise = spawnTimes(ruhig, 0, 6000);
    const arbeitsKreise = spawnTimes(arbeit, 0, 6000);

    // Sechs Sekunden bei 2400 ms Takt: drei Anlässe (0, 2400, 4800).
    expect(ruhigeKreise).toEqual([0, 2400, 4800]);
    // Dieselben sechs Sekunden bei 320 ms Takt: neunzehn.
    expect(arbeitsKreise).toHaveLength(19);
    expect(arbeitsKreise.length).toBeGreaterThan(ruhigeKreise.length * 5);

    // Und sie sehen anders aus, nicht nur schneller: andere Farbe, andere Geschwindigkeit.
    expect(RIPPLE_PROFILES.processing.color).not.toBe(RIPPLE_PROFILES.idle.color);
    expect(RIPPLE_PROFILES.processing.speed).toBeGreaterThan(RIPPLE_PROFILES.idle.speed);
  });

  it("speaking ist rhythmisch: Gruppen zu dritt, dann eine Pause", () => {
    const water = field();
    water.setState("speaking", 0);

    const times = spawnTimes(water, 0, 6000, 8);
    const gaps = times.slice(1).map((time, index) => time - times[index]);
    const { burst, burstGapMs, spawnIntervalMs } = RIPPLE_PROFILES.speaking;

    // Kein gleichmäßiger Takt — genau das unterscheidet "rhythmisch" von "schnell".
    expect(new Set(gaps).size).toBe(2);

    const kurz = gaps.filter((gap) => gap === burstGapMs);
    const lang = gaps.filter((gap) => gap === spawnIntervalMs);
    // Je Gruppe `burst - 1` kurze Abstände, zwischen zwei Gruppen genau eine Pause.
    expect(lang.length).toBeGreaterThanOrEqual(3);
    expect(kurz).toHaveLength((lang.length + 1) * (burst - 1));
    expect(Math.min(...lang)).toBeGreaterThan(Math.max(...kurz));
  });

  it("complete setzt einen letzten Kreis und danach keinen mehr", () => {
    const water = field();
    water.setState("processing", 0);
    run(water, 0, 1000);
    expect(water.visible.length).toBeGreaterThan(1);

    water.setState("complete", 1000);
    expect(water.visible.filter((ring) => ring.bornIn === "complete")).toHaveLength(1);
    // Der Abschlusskreis läuft weiter als jeder andere — das ist das "Auslaufende".
    expect(RIPPLE_PROFILES.complete.maxRadiusFactor).toBeGreaterThan(
      RIPPLE_PROFILES.processing.maxRadiusFactor,
    );

    run(water, 1000, 30_000, 100);
    expect(water.visible).toHaveLength(0);
  });

  it("ein Zustandswechsel wirkt sofort und lässt Bestehendes auslaufen", () => {
    const water = field();
    water.step(0);
    expect(water.visible).toHaveLength(1);

    // Ohne Wechsel käme der nächste Kreis erst bei 2400 ms. Der Wechsel ist selbst ein Anlass.
    water.setState("processing", 100);
    water.step(100);
    expect(water.visible).toHaveLength(2);
    expect(water.visible[0].bornIn).toBe("idle");
    expect(water.visible[1].bornIn).toBe("processing");
  });
});

describe("Wassereffekt · Zeichnung", () => {
  it("zeichnet je Kreis genau einen Bogen und blendet zum Rand hin aus", () => {
    const water = field();
    water.setState("processing", 0);
    run(water, 0, 1200);

    const ctx = fakeContext();
    water.draw(ctx);

    expect(ctx.clears).toBe(1);
    expect(ctx.arcs).toHaveLength(water.visible.length);
    expect(ctx.strokes).toBe(water.visible.length);

    const radien = ctx.arcs.map((arc) => arc.radius);
    expect(Math.max(...radien)).toBeGreaterThan(Math.min(...radien));
    expect(Math.max(...ctx.alphas)).toBeLessThanOrEqual(RIPPLE_PROFILES.processing.opacity);
    expect(Math.min(...ctx.alphas)).toBeGreaterThanOrEqual(0);
  });

  it("der Renderer richtet die Fläche ein, läuft, und gibt den Takt wieder her", () => {
    let nextHandle = 1;
    const pending = new Map<number, (time: number) => void>();
    const ctx = fakeContext();

    const canvas = {
      width: 0,
      height: 0,
      clientWidth: 640,
      clientHeight: 200,
      getContext: () => ctx,
    } as unknown as HTMLCanvasElement;

    const renderer = createRippleRenderer({
      canvas,
      random: () => 0.5,
      now: () => 0,
      requestFrame: (callback) => {
        const handle = nextHandle;
        nextHandle += 1;
        pending.set(handle, callback);
        return handle;
      },
      cancelFrame: (handle) => {
        pending.delete(handle);
      },
    });

    expect(renderer.running).toBe(false);
    renderer.start();
    expect(renderer.running).toBe(true);
    // `resize` beim Start: die Fläche trägt jetzt ihre Darstellungsgröße.
    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(200);

    let frames = 0;
    for (let time = 0; time <= 800; time += 16) {
      const entry = [...pending.entries()][0];
      expect(entry).toBeDefined();
      pending.delete(entry[0]);
      entry[1](time);
      frames += 1;
    }
    expect(frames).toBeGreaterThan(10);
    expect(ctx.clears).toBe(frames);

    renderer.setState("speaking");
    expect(renderer.field.state).toBe("speaking");

    renderer.stop();
    expect(renderer.running).toBe(false);
    expect(pending.size).toBe(0);
  });

  it("ohne 2D-Kontext bleibt der Fehler stehen, statt still nichts zu zeichnen", () => {
    const canvas = {
      width: 10,
      height: 10,
      clientWidth: 10,
      clientHeight: 10,
      getContext: () => null,
    } as unknown as HTMLCanvasElement;

    expect(() => createRippleRenderer({ canvas })).toThrow(/2D-Kontext/);
  });
});
