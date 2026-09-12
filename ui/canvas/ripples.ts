import type { UiState } from "../events/bus.js";

/**
 * Der Wassereffekt (S21, Phase 6).
 *
 * Phase 6 startet **ohne** das 3D-Centerpiece (Ninja auf Stein im See, S25) — was hier steht,
 * sind die Wasserkreise allein. Sie sind das einzige Element der Oberfläche, das den Zustand
 * des Systems ohne Text zeigt: vier Zustände, vier Muster.
 *
 *   * `idle`       — langsam. Ein Kreis alle paar Sekunden, weit auslaufend, kaum sichtbar.
 *   * `processing` — schnell. Dichte Folge kleiner, kräftiger Kreise.
 *   * `speaking`   — rhythmisch. Kein gleichmäßiger Takt, sondern Gruppen: drei Kreise dicht
 *                    hintereinander, dann eine Pause — die Form gesprochener Sprache.
 *   * `complete`   — auslaufend. Ein letzter großer Kreis, danach kein Nachschub; das Feld
 *                    läuft leer.
 *
 * **Die Mechanik ist von der Zeichnung getrennt.** `RippleField` kennt weder ein `canvas` noch
 * `requestAnimationFrame`: es bekommt eine Zeit herein und sagt, welche Ringe es gerade gibt.
 * Das ist nicht Selbstzweck — nur so lässt sich "vier Zustände ergeben vier Muster" prüfen,
 * ohne einen Browser zu starten, und der Unterschied zwischen den Mustern steht dann in Zahlen
 * und nicht in einem Screenshot.
 */

/** Was ein Zustand über seine Kreise bestimmt. */
export interface RippleProfile {
  /** Abstand zwischen zwei Anlässen in Millisekunden. 0 heißt: kein Nachschub. */
  spawnIntervalMs: number;
  /** Wie viele Kreise ein Anlass auslöst. 1 ergibt einen gleichmäßigen Takt. */
  burst: number;
  /** Abstand innerhalb eines Anlasses. Nur wirksam, wenn `burst` größer als 1 ist. */
  burstGapMs: number;
  /** Ausbreitung in Pixel je Sekunde. */
  speed: number;
  /** Anteil der halben Feldhöhe, bis zu dem ein Kreis wächst, bevor er verschwindet. */
  maxRadiusFactor: number;
  lineWidth: number;
  /** Deckkraft am Ursprung. Läuft zum Rand hin auf null aus. */
  opacity: number;
  color: string;
  /** Seitliche Streuung des Ursprungs, Anteil der Feldbreite. 0 heißt: immer dieselbe Stelle. */
  spread: number;
}

/** Ripple-Blau und Cyan aus dem Farbschema (`ui/styles/theme.css`). */
export const RIPPLE_BLUE = "#4a7c9c";
export const RIPPLE_CYAN = "#61dafb";

export const RIPPLE_PROFILES: Readonly<Record<UiState, RippleProfile>> = {
  idle: {
    spawnIntervalMs: 2400,
    burst: 1,
    burstGapMs: 0,
    speed: 26,
    maxRadiusFactor: 1.6,
    lineWidth: 1,
    opacity: 0.28,
    color: RIPPLE_BLUE,
    spread: 0.5,
  },
  processing: {
    spawnIntervalMs: 320,
    burst: 1,
    burstGapMs: 0,
    speed: 78,
    maxRadiusFactor: 1.1,
    lineWidth: 1.6,
    opacity: 0.55,
    color: RIPPLE_CYAN,
    spread: 0.18,
  },
  speaking: {
    // Der Rhythmus: drei Kreise dicht hintereinander, dann eine deutliche Pause.
    spawnIntervalMs: 1100,
    burst: 3,
    burstGapMs: 130,
    speed: 52,
    maxRadiusFactor: 1.4,
    lineWidth: 2.2,
    opacity: 0.7,
    color: RIPPLE_CYAN,
    spread: 0.1,
  },
  complete: {
    // Kein Nachschub. Der eine große Kreis kommt beim Zustandswechsel, nicht aus dem Takt.
    spawnIntervalMs: 0,
    burst: 0,
    burstGapMs: 0,
    speed: 34,
    maxRadiusFactor: 2.2,
    lineWidth: 1.4,
    opacity: 0.45,
    color: RIPPLE_BLUE,
    spread: 0,
  },
};

export interface Ring {
  x: number;
  y: number;
  radius: number;
  maxRadius: number;
  speed: number;
  lineWidth: number;
  opacity: number;
  color: string;
  /** In welchem Zustand dieser Kreis entstanden ist. */
  bornIn: UiState;
  bornAt: number;
}

/**
 * Das Stück `CanvasRenderingContext2D`, das gezeichnet wird. Schmal gehalten, damit ein Test
 * eine Attrappe einsetzen kann — ein echter Kontext erfüllt diese Form.
 */
export interface RippleContext {
  clearRect(x: number, y: number, width: number, height: number): void;
  beginPath(): void;
  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    counterclockwise?: boolean,
  ): void;
  stroke(): void;
  strokeStyle: unknown;
  lineWidth: number;
  globalAlpha: number;
}

export interface RippleFieldOptions {
  width: number;
  height: number;
  /** Vorgabe `Math.random`. Der Test setzt eine feste Folge ein. */
  random?: () => number;
  /** Startzeit in Millisekunden. Vorgabe 0. */
  startedAt?: number;
  state?: UiState;
}

/**
 * Die Kreise als Zustandsmaschine über der Zeit. Kein Zeitgeber, keine Zeichenfläche — beides
 * kommt von außen (`createRippleRenderer`).
 */
export class RippleField {
  private readonly rings: Ring[] = [];
  private random: () => number;
  private currentState: UiState;
  private width: number;
  private height: number;
  private lastStepAt: number;
  private nextSpawnAt: number;
  /** Wie viele Kreise des laufenden Anlasses schon gesetzt sind. */
  private burstIndex = 0;

  constructor(options: RippleFieldOptions) {
    this.width = options.width;
    this.height = options.height;
    this.random = options.random ?? Math.random;
    this.currentState = options.state ?? "idle";
    this.lastStepAt = options.startedAt ?? 0;
    this.nextSpawnAt = this.lastStepAt;
  }

  get state(): UiState {
    return this.currentState;
  }

  get profile(): RippleProfile {
    return RIPPLE_PROFILES[this.currentState];
  }

  /** Die Kreise, die es gerade gibt. Nur lesend. */
  get visible(): readonly Ring[] {
    return this.rings;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  /**
   * Wechselt den Zustand. Der Wechsel selbst ist ein Anlass: der nächste Kreis kommt sofort
   * und nicht erst, wenn der Takt des alten Zustands abgelaufen wäre — sonst hinge die
   * Anzeige beim Wechsel von `idle` (2,4 Sekunden Takt) auf `processing` sekundenlang nach.
   * Bestehende Kreise bleiben stehen und laufen zu Ende; das Wasser hat kein Gedächtnis,
   * aber auch keinen Schnitt.
   */
  setState(next: UiState, nowMs: number): void {
    if (next === this.currentState) return;
    this.currentState = next;
    this.burstIndex = 0;
    if (next === "complete") {
      // Der eine letzte, große Kreis. Danach kein Nachschub mehr (`spawnIntervalMs: 0`).
      this.spawn(nowMs);
      this.nextSpawnAt = Number.POSITIVE_INFINITY;
      return;
    }
    this.nextSpawnAt = nowMs;
  }

  /** Rückt das Feld auf `nowMs` vor: Kreise wachsen, verbrauchte fallen weg, neue kommen. */
  step(nowMs: number): void {
    const elapsed = Math.max(0, nowMs - this.lastStepAt);
    this.lastStepAt = nowMs;

    if (elapsed > 0) {
      const seconds = elapsed / 1000;
      for (let index = this.rings.length - 1; index >= 0; index -= 1) {
        const ring = this.rings[index];
        ring.radius += ring.speed * seconds;
        if (ring.radius >= ring.maxRadius) this.rings.splice(index, 1);
      }
    }

    const profile = this.profile;
    // `complete` hat keinen Takt: sein einziger Kreis kommt beim Zustandswechsel.
    if (profile.spawnIntervalMs <= 0 || profile.burst <= 0) return;

    // Eine Obergrenze je Aufruf: ein Schritt über eine sehr lange Pause (Tab im Hintergrund)
    // soll nicht tausend Kreise auf einmal erzeugen.
    let guard = 64;
    while (nowMs >= this.nextSpawnAt && guard > 0) {
      guard -= 1;
      this.spawn(this.nextSpawnAt);
      this.burstIndex += 1;
      if (this.burstIndex < profile.burst) {
        // Noch im selben Anlass: der nächste Kreis folgt dicht.
        this.nextSpawnAt += profile.burstGapMs;
      } else {
        // Der Anlass ist abgearbeitet — Pause bis zum nächsten.
        this.burstIndex = 0;
        this.nextSpawnAt += profile.spawnIntervalMs;
      }
    }
  }

  /** Zeichnet den aktuellen Stand. Löscht die Fläche vorher — sie gehört ganz dem Wasser. */
  draw(ctx: RippleContext): void {
    ctx.clearRect(0, 0, this.width, this.height);
    for (const ring of this.rings) {
      const progress = ring.maxRadius > 0 ? ring.radius / ring.maxRadius : 1;
      ctx.globalAlpha = Math.max(0, ring.opacity * (1 - progress));
      ctx.strokeStyle = ring.color;
      ctx.lineWidth = ring.lineWidth;
      ctx.beginPath();
      ctx.arc(ring.x, ring.y, Math.max(0.5, ring.radius), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  private spawn(atMs: number): void {
    const profile = this.profile;
    const centre = this.width / 2;
    const offset = profile.spread > 0 ? (this.random() - 0.5) * this.width * profile.spread : 0;
    this.rings.push({
      x: centre + offset,
      y: this.height * 0.55,
      radius: 0,
      maxRadius: Math.max(8, (this.height / 2) * profile.maxRadiusFactor),
      speed: profile.speed,
      lineWidth: profile.lineWidth,
      opacity: profile.opacity,
      color: profile.color,
      bornIn: this.currentState,
      bornAt: atMs,
    });
  }
}

export interface RippleRendererOptions {
  canvas: HTMLCanvasElement;
  state?: UiState;
  random?: () => number;
  /** Vorgabe `requestAnimationFrame`. */
  requestFrame?: (callback: (time: number) => void) => number;
  cancelFrame?: (handle: number) => void;
  now?: () => number;
}

export interface RippleRenderer {
  start(): void;
  stop(): void;
  setState(state: UiState): void;
  /** Passt die Fläche an ihre Darstellungsgröße an (inklusive Gerätepixelverhältnis). */
  resize(): void;
  readonly field: RippleField;
  readonly running: boolean;
}

/**
 * Verbindet das Feld mit einer Zeichenfläche und dem Bildtakt des Browsers. Bewusst dünn:
 * alles, was eine Entscheidung trifft, steht in `RippleField`.
 */
export function createRippleRenderer(options: RippleRendererOptions): RippleRenderer {
  const { canvas } = options;
  const requestFrame =
    options.requestFrame ??
    ((callback: (time: number) => void) => globalThis.requestAnimationFrame(callback));
  const cancelFrame =
    options.cancelFrame ?? ((handle: number) => globalThis.cancelAnimationFrame(handle));
  const now = options.now ?? (() => performance.now());

  const field = new RippleField({
    width: canvas.width,
    height: canvas.height,
    random: options.random,
    startedAt: now(),
    state: options.state,
  });

  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    // Ohne Kontext gibt es nichts zu zeichnen, und das darf nicht stumm bleiben: die
    // Oberfläche sähe sonst aus wie ein System, das gerade nichts tut.
    throw new Error("Die Zeichenfläche liefert keinen 2D-Kontext — der Wassereffekt läuft nicht.");
  }

  let handle: number | null = null;

  function resize(): void {
    const ratio = globalThis.devicePixelRatio ?? 1;
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    field.resize(width, height);
  }

  function frame(time: number): void {
    field.step(time);
    field.draw(ctx as RippleContext);
    handle = requestFrame(frame);
  }

  return {
    start(): void {
      if (handle !== null) return;
      resize();
      handle = requestFrame(frame);
    },
    stop(): void {
      if (handle === null) return;
      cancelFrame(handle);
      handle = null;
    },
    setState(state: UiState): void {
      field.setState(state, now());
    },
    resize,
    field,
    get running(): boolean {
      return handle !== null;
    },
  };
}
