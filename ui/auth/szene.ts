/**
 * Die Szene hinter der Anmeldung — nach Jakobs Entwurf (S47, 2026-09-26).
 *
 * Orb = Orchestrator · Licht-Koi = Agenten · Glühwürmchen · Wellen. Canvas 2D, keine
 * Abhängigkeiten. Der Entwurf lief als eigenständige Seite und wusste nichts vom Aufräumen;
 * hier liegt die Maske über der Oberfläche und geht nach der Anmeldung wieder. Deshalb bekommt
 * die Szene ihre Elemente übergeben statt sie per id zu suchen, meldet einen Tipp auf den Orb
 * über einen Rückruf statt über ein Dokument-Ereignis, und `destroy()` hält die Schleife an und
 * nimmt jeden Horcher wieder ab. Sonst liefe sie hinter der Präsenz unsichtbar weiter.
 *
 * Mit dem Orb der Präsenz (`ui/praesenz/sphaere.ts`) hat diese Kugel nur die Idee gemeinsam:
 * sie ist gezeichnet, nicht gerendert, und braucht darum kein WebGL.
 */

export type SzenenZustand =
  | "boot"
  | "idle"
  | "user"
  | "secret"
  | "blind"
  | "auth"
  | "success"
  | "fail";

export interface SzeneElemente {
  /** Die Maske selbst: an ihr hängen Scroll- und Zeigerereignisse. */
  wurzel: HTMLElement;
  canvas: HTMLCanvasElement;
  /** Der Hintergrund, der der Maus mit etwas Parallaxe folgt. */
  hintergrund: HTMLElement;
  /** Platzhalter im Layout, an dem die gezeichnete Kugel steht. */
  anker: HTMLElement;
}

export interface SzeneOptionen {
  /** Anzahl der Licht-Koi (= Agenten), 3–9. */
  agenten?: number;
  /** Ein Tipp auf die Kugel. */
  beimOrb?: () => void;
}

export interface Szene {
  setState(name: SzenenZustand): void;
  /** Ein Tastendruck an der Stelle des Cursors — ein Lichtpunkt fliegt zum Orb. */
  keystroke(x: number, y: number, kind: "user" | "secret" | "del"): void;
  /** Jeder Agent schwimmt zum Orb und bestätigt; das Versprechen endet, wenn alle da sind. */
  handshake(onAck?: (index: number) => void): Promise<void>;
  success(): Promise<void>;
  fail(x?: number, y?: number): void;
  destroy(): void;
}

type Rgb = readonly [number, number, number];

const TAU = Math.PI * 2;
const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;
const damp = (a: number, b: number, rate: number, dt: number): number =>
  lerp(a, b, 1 - Math.exp(-rate * dt));
const rand = (a: number, b: number): number => a + Math.random() * (b - a);
const wrap = (winkel: number): number => {
  let a = winkel;
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
};
const mix = (c1: Rgb, c2: Rgb, k: number): Rgb => [
  lerp(c1[0], c2[0], k) | 0,
  lerp(c1[1], c2[1], k) | 0,
  lerp(c1[2], c2[2], k) | 0,
];
const rgba = (c: Rgb, a: number): string =>
  `rgba(${c[0]},${c[1]},${c[2]},${clamp(a, 0, 1).toFixed(3)})`;
const easeInOut = (x: number): number => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

const COOL: Rgb = [196, 232, 240];
const WARM: Rgb = [255, 212, 168];
const SHU: Rgb = [255, 122, 92];
const WHITE: Rgb = [255, 250, 244];

/* ── Licht-Koi ──────────────────────────────────────────── */

interface Palette {
  body: Rgb;
  accent: Rgb;
}

const PALETTES: readonly Palette[] = [
  { body: [255, 248, 242], accent: [255, 176, 148] }, // Kohaku
  { body: [255, 243, 230], accent: [255, 206, 160] }, // Ogon
  { body: [228, 246, 250], accent: [164, 218, 228] }, // Asagi
  { body: [255, 238, 238], accent: [255, 158, 170] }, // Sakura
];

interface KoiOptionen {
  n?: number;
  len: number;
  w: number;
  speed: number;
  turn?: number;
  pal: Palette;
  alpha?: number;
  x: number;
  y: number;
  a?: number;
  vis?: number;
}

type Rand2 = [number, number];
/** Mittellinie je Glied: Position, Tangente, Normale. */
type Glied = [number, number, number, number, number, number];

interface Umlauf {
  rx: number;
  ry: number;
  dir: number;
  th: number;
  w: number;
  yo: number;
}

class Koi {
  n: number;
  len: number;
  w: number;
  speed: number;
  turn: number;
  pal: Palette;
  alpha: number;
  x: number;
  y: number;
  a: number;
  seg: number;
  phase = rand(0, TAU);
  swim = rand(0, TAU);
  boost = 0;
  vis: number;
  visT: number;
  tx: number;
  ty: number;
  pts: Array<{ x: number; y: number }> = [];
  L: Rand2[] = [];
  R: Rand2[] = [];
  C: Glied[] = [];
  // Nur für die Agenten-Koi
  idx = 0;
  orbit: Umlauf = { rx: 0, ry: 0, dir: 1, th: 0, w: 0, yo: 0 };
  mode: "orbit" | "home" | "seek" | "flee" = "orbit";
  until = 0;
  sx = 0;
  sy = 0;
  acked = true;

  constructor(o: KoiOptionen) {
    this.n = o.n ?? 18;
    this.len = o.len;
    this.w = o.w;
    this.speed = o.speed;
    this.turn = o.turn ?? 2.2;
    this.pal = o.pal;
    this.alpha = o.alpha ?? 1;
    this.x = o.x;
    this.y = o.y;
    this.a = o.a ?? rand(0, TAU);
    this.seg = this.len / (this.n - 1);
    this.vis = o.vis ?? 1;
    this.visT = this.vis;
    this.tx = this.x;
    this.ty = this.y;
    for (let i = 0; i < this.n; i++) {
      this.pts.push({
        x: this.x - Math.cos(this.a) * this.seg * i,
        y: this.y - Math.sin(this.a) * this.seg * i,
      });
    }
  }

  update(dt: number, speedMul: number, time: number): void {
    const dx = this.tx - this.x;
    const dy = this.ty - this.y;
    const dist = Math.hypot(dx, dy);
    const turn = this.turn * (1 + this.boost) * dt;
    this.a += clamp(wrap(Math.atan2(dy, dx) - this.a), -turn, turn);
    this.a += Math.sin(time * 0.9 + this.phase) * 0.35 * dt;
    let sp = this.speed * speedMul * (1 + this.boost * 1.6);
    sp *= clamp(dist / (this.len * 0.7), 0.35, 1);
    this.x += Math.cos(this.a) * sp * dt;
    this.y += Math.sin(this.a) * sp * dt;
    this.swim += dt * (3 + (sp / this.len) * 6);
    this.boost = Math.max(0, this.boost - dt * 0.9);
    this.vis = damp(this.vis, this.visT, 2.5, dt);
    const p = this.pts;
    p[0].x = this.x;
    p[0].y = this.y;
    for (let i = 1; i < this.n; i++) {
      const a = p[i - 1];
      const b = p[i];
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      const d = Math.hypot(ex, ey) || 1;
      b.x = a.x + (ex / d) * this.seg;
      b.y = a.y + (ey / d) * this.seg;
    }
  }

  /** Umriss mit Schwimmbewegung und Körperprofil berechnen. */
  shape(wm: number): void {
    const n = this.n;
    const p = this.pts;
    const w = this.w * wm;
    for (let i = 0; i < n; i++) {
      const a = p[i > 0 ? i - 1 : 0];
      const b = p[i < n - 1 ? i + 1 : n - 1];
      let tx = a.x - b.x;
      let ty = a.y - b.y;
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl;
      ty /= tl;
      const nx = -ty;
      const ny = tx;
      const u = i / (n - 1);
      const sway = Math.sin(this.swim - u * 5.4) * this.w * 0.5 * u ** 1.5;
      const cx = p[i].x + nx * sway;
      const cy = p[i].y + ny * sway;
      const prof =
        u < 0.3
          ? 0.62 + 0.38 * Math.sin((u / 0.3) * Math.PI * 0.5)
          : 0.1 + 0.9 * (1 - (u - 0.3) / 0.7) ** 1.3;
      const hw = prof * w;
      this.L[i] = [cx + nx * hw, cy + ny * hw];
      this.R[i] = [cx - nx * hw, cy - ny * hw];
      this.C[i] = [cx, cy, tx, ty, nx, ny];
    }
  }

  fins(c: CanvasRenderingContext2D, a: number): void {
    const n = this.n;
    const C = this.C;
    const w = this.w;
    const pal = this.pal;
    // Brustflossen
    const flap = 0.75 + 0.25 * Math.sin(this.swim * 1.4);
    const f = C[Math.round((n - 1) * 0.2)];
    c.fillStyle = rgba(pal.body, 0.3 * a);
    for (let s = -1; s <= 1; s += 2) {
      const bx = f[0] + f[4] * s * w * 0.55;
      const by = f[1] + f[5] * s * w * 0.55;
      const ox = (f[4] * s * 1.2 - f[2] * 0.9) * w * 1.25 * flap;
      const oy = (f[5] * s * 1.2 - f[3] * 0.9) * w * 1.25 * flap;
      c.beginPath();
      c.moveTo(bx + f[2] * w * 0.3, by + f[3] * w * 0.3);
      c.quadraticCurveTo(bx + f[4] * s * w * 1.3, by + f[5] * s * w * 1.3, bx + ox, by + oy);
      c.quadraticCurveTo(
        bx - f[2] * w * 0.2,
        by - f[3] * w * 0.2,
        bx - f[2] * w * 0.5,
        by - f[3] * w * 0.5,
      );
      c.closePath();
      c.fill();
    }
    // Schwanzflosse
    const t0 = C[n - 1];
    const t1 = C[n - 4];
    let dx = t0[0] - t1[0];
    let dy = t0[1] - t1[1];
    const dl = Math.hypot(dx, dy) || 1;
    dx /= dl;
    dy /= dl;
    const nx = -dy;
    const ny = dx;
    const fl = this.len * 0.26;
    const sp = w * 1.25;
    const fx = Math.sin(this.swim * 1.1 - 1.2) * 0.35;
    const tg = c.createLinearGradient(t0[0], t0[1], t0[0] + dx * fl, t0[1] + dy * fl);
    tg.addColorStop(0, rgba(pal.accent, 0.5 * a));
    tg.addColorStop(1, rgba(pal.body, 0.06 * a));
    c.fillStyle = tg;
    c.beginPath();
    c.moveTo(t0[0] + nx * w * 0.12, t0[1] + ny * w * 0.12);
    c.quadraticCurveTo(
      t0[0] + dx * fl * 0.3 + nx * sp * 0.9,
      t0[1] + dy * fl * 0.3 + ny * sp * 0.9,
      t0[0] + dx * fl + nx * sp * (1 + fx),
      t0[1] + dy * fl + ny * sp * (1 + fx),
    );
    c.quadraticCurveTo(
      t0[0] + dx * fl * 0.75 + nx * sp * 0.15,
      t0[1] + dy * fl * 0.75 + ny * sp * 0.15,
      t0[0] + dx * fl * 0.55,
      t0[1] + dy * fl * 0.55,
    );
    c.quadraticCurveTo(
      t0[0] + dx * fl * 0.75 - nx * sp * 0.15,
      t0[1] + dy * fl * 0.75 - ny * sp * 0.15,
      t0[0] + dx * fl - nx * sp * (1 - fx),
      t0[1] + dy * fl - ny * sp * (1 - fx),
    );
    c.quadraticCurveTo(
      t0[0] + dx * fl * 0.3 - nx * sp * 0.9,
      t0[1] + dy * fl * 0.3 - ny * sp * 0.9,
      t0[0] - nx * w * 0.12,
      t0[1] - ny * w * 0.12,
    );
    c.closePath();
    c.fill();
  }

  /** `bloom` = breiter, weicher Durchgang in den Glow-Puffer. */
  draw(c: CanvasRenderingContext2D, bloom: boolean, extra = 1): void {
    const a = this.alpha * this.vis * extra;
    if (a < 0.015) return;
    const wm = bloom ? 1.8 : 1;
    this.shape(wm);
    const n = this.n;
    const C = this.C;
    const head = C[0];
    const tail = C[n - 1];
    const pal = this.pal;
    if (!bloom) this.fins(c, a);
    traceBody(c, this, this.w * wm);
    const g = c.createLinearGradient(head[0], head[1], tail[0], tail[1]);
    g.addColorStop(0, rgba(pal.body, 0.95 * a));
    g.addColorStop(0.36, rgba(pal.accent, 0.85 * a));
    g.addColorStop(0.62, rgba(pal.body, 0.6 * a));
    g.addColorStop(1, rgba(pal.accent, 0.15 * a));
    c.fillStyle = g;
    c.fill();
    if (!bloom) {
      // seidiger Lichtgrat entlang der Wirbelsäule
      c.beginPath();
      c.moveTo(C[1][0], C[1][1]);
      for (let i = 2; i < Math.floor(n * 0.72); i++) c.lineTo(C[i][0], C[i][1]);
      c.strokeStyle = rgba(WHITE, 0.55 * a);
      c.lineWidth = Math.max(0.6, this.w * 0.14);
      c.lineCap = "round";
      c.stroke();
    }
  }
}

function traceBody(c: CanvasRenderingContext2D, k: Koi, w: number): void {
  const L = k.L;
  const R = k.R;
  const h = k.C[0];
  const n = k.n;
  c.beginPath();
  c.moveTo(R[0][0], R[0][1]);
  c.quadraticCurveTo(h[0] + h[2] * w * 1.3, h[1] + h[3] * w * 1.3, L[0][0], L[0][1]);
  for (let i = 1; i < n - 1; i++) {
    c.quadraticCurveTo(L[i][0], L[i][1], (L[i][0] + L[i + 1][0]) / 2, (L[i][1] + L[i + 1][1]) / 2);
  }
  c.lineTo(L[n - 1][0], L[n - 1][1]);
  c.lineTo(R[n - 1][0], R[n - 1][1]);
  for (let i = n - 2; i > 0; i--) {
    c.quadraticCurveTo(R[i][0], R[i][1], (R[i][0] + R[i - 1][0]) / 2, (R[i][1] + R[i - 1][1]) / 2);
  }
  c.lineTo(R[0][0], R[0][1]);
  c.closePath();
}

/* ── Zustände ───────────────────────────────────────────── */

const PRESETS: Readonly<
  Record<SzenenZustand, { frost: number; glow: number; spin: number; bright: number }>
> = {
  boot: { frost: 1, glow: 0.25, spin: 0.5, bright: 0.35 },
  idle: { frost: 0, glow: 0.72, spin: 1, bright: 1 },
  user: { frost: 0, glow: 0.9, spin: 1.3, bright: 1 },
  secret: { frost: 0.85, glow: 0.55, spin: 0.6, bright: 0.75 },
  blind: { frost: 1, glow: 0.35, spin: 0.4, bright: 0.5 },
  auth: { frost: 0.15, glow: 1, spin: 2.6, bright: 1 },
  success: { frost: 0, glow: 1.2, spin: 3.4, bright: 1 },
  fail: { frost: 0.45, glow: 0.6, spin: 0.8, bright: 0.9 },
};

// Laternen im Hintergrundbild (relative Bildkoordinaten), dazu sein Seitenverhältnis.
const IMG_AR = 2752 / 1536;
const LANTERNS = [
  { u: 0.0708, v: 0.7085, r: 0.034, k: 1 },
  { u: 0.2558, v: 0.6577, r: 0.024, k: 0.85 },
  { u: 0.3, v: 0.6353, r: 0.02, k: 0.45 },
] as const;

const GLOW_SCALE = 0.25;

interface Fly {
  x: number;
  y: number;
  vx: number;
  vy: number;
  ph: number;
  f: number;
  s: number;
  z: number;
}

interface Ripple {
  x: number;
  y: number;
  r0: number;
  max: number;
  life: number;
  speed: number;
  color: Rgb;
  width: number;
}

interface Mote {
  x0: number;
  y0: number;
  cx: number;
  cy: number;
  t: number;
  dur: number;
  color: Rgb;
  trail: number[];
}

export function starteSzene(el: SzeneElemente, opts: SzeneOptionen = {}): Szene {
  const { canvas, hintergrund: bgEl, anker: anchor, wurzel } = el;
  const ctxN = canvas.getContext("2d");
  // Niedrig aufgelöster Bloom-Puffer
  const glow = document.createElement("canvas");
  const gctxN = glow.getContext("2d");
  if (ctxN === null || gctxN === null) {
    throw new Error("Die Anmeldeszene bekommt keinen 2D-Kontext.");
  }
  const ctx: CanvasRenderingContext2D = ctxN;
  const gctx: CanvasRenderingContext2D = gctxN;

  const REDUCED = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const MOTION = REDUCED ? 0.3 : 1;

  let W = 0;
  let H = 0;
  let DPR = 1;
  let time = 0;
  const orb = { x: 0, y: 0, r: 140 };
  const pointer = { x: -1e4, y: -1e4, nx: 0, ny: 0, sx: 0, sy: 0, last: -10, inside: false };
  const par = { x: 0, y: 0 };

  // Animierte Größen (…T = Zielwert, wird weich angesteuert)
  const S = {
    state: "boot" as SzenenZustand,
    frost: 1, // Milchglas über dem Orb (Privatsphäre)
    frostT: 1,
    glow: 0.2, // Leuchtkraft des Orbs
    glowT: 0.25,
    spin: 0.5, // Tempo der inneren Koi
    spinT: 0.5,
    warn: 0, // Zinnober-Tönung bei Fehlern
    warnT: 0,
    flare: 0, // Erfolgs-Aufleuchten
    flareT: 0,
    bright: 0, // Sichtbarkeit von Koi & Glühwürmchen
    brightT: 0,
    pulse: 0, // kurzer Puls bei Tastendruck
  };

  let inner: Koi[] = [];
  let innerAngle = 0;
  let lastOrbR = 0;
  let agents: Koi[] = [];
  let nearest = -1;
  let hs: { ack(i: number): void } | null = null; // laufender Handshake
  let waveT0 = -1; // Start der Erfolgswelle
  let flies: Fly[] = [];
  const ripples: Ripple[] = [];
  const motes: Mote[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let raf = 0;
  let laeuft = true;

  const later = (fn: () => void, ms: number): void => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };

  /* ── Größe & Orb-Position ───────────────────────────────── */

  function makeInner(): void {
    const r = orb.r;
    lastOrbR = r;
    inner = [
      new Koi({
        x: orb.x - r * 0.3,
        y: orb.y - r * 0.35,
        a: 0,
        len: r * 1.04,
        w: r * 0.085,
        speed: r * 0.56,
        turn: 2.6,
        pal: PALETTES[0],
        n: 22,
      }),
      new Koi({
        x: orb.x + r * 0.3,
        y: orb.y + r * 0.35,
        a: Math.PI,
        len: r * 0.92,
        w: r * 0.078,
        speed: r * 0.56,
        turn: 2.6,
        pal: PALETTES[3],
        n: 22,
      }),
    ];
  }

  function measureOrb(): void {
    const r = anchor.getBoundingClientRect();
    if (r.width > 0) {
      orb.x = r.left + r.width / 2;
      orb.y = r.top + r.height / 2;
      orb.r = r.width / 2;
    }
    if (inner.length > 0 && Math.abs(orb.r - lastOrbR) > lastOrbR * 0.08) makeInner();
  }

  function resize(): void {
    DPR = Math.min(globalThis.devicePixelRatio || 1, 2);
    W = globalThis.innerWidth;
    H = globalThis.innerHeight;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    glow.width = Math.ceil(W * GLOW_SCALE);
    glow.height = Math.ceil(H * GLOW_SCALE);
    gctx.setTransform(GLOW_SCALE, 0, 0, GLOW_SCALE, 0, 0);
    measureOrb();
    seedFlies();
  }

  /* ── Zeiger ─────────────────────────────────────────────── */

  const isUI = (target: EventTarget | null): boolean =>
    target instanceof Element &&
    target.closest("form, button, a, input, label, .an-chip, .an-lock") !== null;
  const onPointerMove = (e: PointerEvent): void => {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.last = time;
    pointer.inside = true;
    pointer.nx = (e.clientX / W) * 2 - 1;
    pointer.ny = (e.clientY / H) * 2 - 1;
  };
  const onPointerLeave = (): void => {
    pointer.inside = false;
    pointer.nx = 0;
    pointer.ny = 0;
  };
  const onPointerDown = (e: PointerEvent): void => {
    if (isUI(e.target) || (e.pointerType === "mouse" && e.button !== 0)) return;
    touch(e.clientX, e.clientY);
  };

  /* ── Hintergrund: Parallaxe & Laternen-Flackern ─────────── */

  function updateParallax(): void {
    par.x = REDUCED ? 0 : -pointer.sx * 14;
    par.y = REDUCED ? 0 : -pointer.sy * 9;
    bgEl.style.transform = `translate3d(${par.x.toFixed(2)}px,${par.y.toFixed(2)}px,0)`;
  }

  function coverMap(u: number, v: number): { x: number; y: number; s: number } {
    const bw = W * 1.05;
    const bh = H * 1.05;
    const bx = -W * 0.025 + par.x;
    const by = -H * 0.025 + par.y;
    let iw: number;
    let ih: number;
    if (bw / bh > IMG_AR) {
      iw = bw;
      ih = bw / IMG_AR;
    } else {
      ih = bh;
      iw = bh * IMG_AR;
    }
    return { x: bx + (bw - iw) / 2 + u * iw, y: by + (bh - ih) / 2 + v * ih, s: iw };
  }

  function drawLanterns(): void {
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < LANTERNS.length; i++) {
      const L = LANTERNS[i];
      const p = coverMap(L.u, L.v);
      const rr = L.r * p.s * 2.6;
      if (p.x < -rr || p.x > W + rr || p.y < -rr || p.y > H + rr) continue;
      const fl =
        0.72 +
        0.14 * Math.sin(time * 2.1 + i * 1.7) +
        0.09 * Math.sin(time * 5.3 + i) +
        0.05 * Math.sin(time * 11.7 + i * 3);
      const a = 0.17 * L.k * fl * (0.55 + 0.45 * S.bright);
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rr);
      g.addColorStop(0, rgba(WARM, a));
      g.addColorStop(0.35, rgba([255, 178, 110], a * 0.45));
      g.addColorStop(1, rgba([255, 170, 100], 0));
      ctx.fillStyle = g;
      ctx.fillRect(p.x - rr, p.y - rr, rr * 2, rr * 2);
    }
    ctx.globalCompositeOperation = "source-over";
  }

  /* ── Glühwürmchen (Hotaru) ──────────────────────────────── */

  function newFly(anywhere: boolean): Fly {
    return {
      x: rand(0, W),
      y: anywhere ? rand(H * 0.12, H) : H + rand(5, 40),
      vx: 0,
      vy: 0,
      ph: rand(0, TAU),
      f: rand(0.45, 1.1),
      s: rand(0.7, 1.7),
      z: rand(0.35, 1),
    };
  }
  function seedFlies(): void {
    const n = Math.round(clamp((W * H) / 40000, 12, 48));
    while (flies.length < n) flies.push(newFly(true));
    flies = flies.slice(0, n);
  }
  function updateFlies(dt: number): void {
    const follow = pointer.inside && time - pointer.last < 3;
    for (const f of flies) {
      let tx = Math.sin(time * 0.31 * f.f + f.ph) * 11;
      let ty = Math.cos(time * 0.23 * f.f + f.ph * 1.3) * 7 - 5 * f.z;
      if (follow) {
        const dx = pointer.x - f.x;
        const dy = pointer.y - f.y;
        const d = Math.hypot(dx, dy) || 1;
        if (d < 220) {
          const k = (1 - d / 220) * 46;
          tx += (dx / d) * k;
          ty += (dy / d) * k;
        }
      }
      f.vx = damp(f.vx, tx, 1.4, dt);
      f.vy = damp(f.vy, ty, 1.4, dt);
      f.x += f.vx * dt * MOTION;
      f.y += f.vy * dt * MOTION;
      if (f.y < -30 || f.x < -40 || f.x > W + 40) Object.assign(f, newFly(false));
    }
  }
  function drawFlies(): void {
    for (const f of flies) {
      const blink = (0.5 + 0.5 * Math.sin(time * f.f * 1.7 + f.ph)) ** 2.4;
      const a = (0.2 + 0.8 * blink) * f.z * S.bright;
      if (a < 0.02) continue;
      ctx.fillStyle = rgba(WARM, a);
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.s * 0.85, 0, TAU);
      ctx.fill();
      gctx.fillStyle = rgba(WARM, a * 0.9);
      gctx.beginPath();
      gctx.arc(f.x, f.y, f.s * 5, 0, TAU);
      gctx.fill();
    }
  }

  /* ── Wellenringe ────────────────────────────────────────── */

  function ripple(
    x: number,
    y: number,
    o: { r0?: number; max?: number; speed?: number; color?: Rgb; width?: number } = {},
  ): void {
    ripples.push({
      x,
      y,
      r0: o.r0 ?? 0,
      max: o.max ?? 150,
      life: 1,
      speed: o.speed ?? 1,
      color: o.color ?? COOL,
      width: o.width ?? 1.2,
    });
  }
  function drawRipples(dt: number): void {
    for (let i = ripples.length - 1; i >= 0; i--) {
      const p = ripples[i];
      p.life -= dt * 0.85 * p.speed;
      if (p.life <= 0) {
        ripples.splice(i, 1);
        continue;
      }
      const k = 1 - p.life;
      const r = p.r0 + (p.max - p.r0) * (1 - (1 - k) ** 3);
      const a = p.life * p.life;
      ctx.lineWidth = p.width;
      ctx.strokeStyle = rgba(p.color, 0.6 * a);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, TAU);
      ctx.stroke();
      ctx.strokeStyle = rgba(p.color, 0.22 * a);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 0.7, 0, TAU);
      ctx.stroke();
      gctx.lineWidth = p.width * 6;
      gctx.strokeStyle = rgba(p.color, 0.28 * a);
      gctx.beginPath();
      gctx.arc(p.x, p.y, r, 0, TAU);
      gctx.stroke();
    }
  }

  /* ── Lichtpunkte: Tastendruck fliegt zum Orchestrator ───── */

  function mote(x: number, y: number, color: Rgb): void {
    const cx = (x + orb.x) / 2 + rand(-90, 90);
    const cy = Math.min(y, orb.y) - rand(30, 110);
    motes.push({ x0: x, y0: y, cx, cy, t: 0, dur: rand(0.75, 1), color, trail: [] });
  }
  function drawMotes(dt: number): void {
    for (let i = motes.length - 1; i >= 0; i--) {
      const m = motes[i];
      m.t += (dt / m.dur) * (REDUCED ? 3 : 1);
      if (m.t >= 1) {
        motes.splice(i, 1);
        onMoteArrive();
        continue;
      }
      const k = easeInOut(m.t);
      const q = 1 - k;
      const x = q * q * m.x0 + 2 * q * k * m.cx + k * k * orb.x;
      const y = q * q * m.y0 + 2 * q * k * m.cy + k * k * orb.y;
      m.trail.push(x, y);
      if (m.trail.length > 22) m.trail.splice(0, 2);
      for (let j = 0; j < m.trail.length; j += 2) {
        const a = j / m.trail.length;
        ctx.fillStyle = rgba(m.color, a * 0.65);
        ctx.beginPath();
        ctx.arc(m.trail[j], m.trail[j + 1], 0.6 + a * 1.4, 0, TAU);
        ctx.fill();
      }
      gctx.fillStyle = rgba(m.color, 0.9);
      gctx.beginPath();
      gctx.arc(x, y, 7, 0, TAU);
      gctx.fill();
    }
  }
  function onMoteArrive(): void {
    S.pulse = Math.min(1, S.pulse + 0.6);
    for (const k of inner) k.boost = Math.min(1.4, k.boost + 0.5);
    ripple(orb.x, orb.y, { r0: orb.r * 0.98, max: orb.r * 1.3, color: COOL, speed: 1.7, width: 1 });
  }

  /* ── Orb (Orchestrator) ─────────────────────────────────── */

  const frostTex = ((): HTMLCanvasElement => {
    const c = document.createElement("canvas");
    c.width = 160;
    c.height = 160;
    const x = c.getContext("2d");
    if (x === null) return c;
    const img = x.createImageData(160, 160);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = 205 + Math.random() * 50;
      d[i] = v;
      d[i + 1] = Math.min(255, v + 6);
      d[i + 2] = 255;
      d[i + 3] = Math.random() < 0.55 ? Math.random() * 110 : 0;
    }
    x.putImageData(img, 0, 0);
    return c;
  })();

  function updateInner(dt: number): void {
    innerAngle += dt * 0.8 * S.spin * MOTION;
    const r = orb.r;
    for (let i = 0; i < inner.length; i++) {
      const th = innerAngle + i * Math.PI;
      inner[i].tx = orb.x + Math.cos(th) * r * 0.52;
      inner[i].ty = orb.y + Math.sin(th) * r * 0.4;
      inner[i].update(dt * MOTION, 0.7 + S.spin * 0.45, time);
    }
  }

  function drawOrb(): void {
    const x = orb.x;
    const y = orb.y;
    const r = orb.r * (1 + 0.006 * Math.sin(time * 0.9) + 0.025 * S.pulse);
    const fl = S.flare;
    const wn = S.warn;

    // Halo
    const hr = r * (1.75 + fl * 0.9);
    let g = ctx.createRadialGradient(x, y, r * 0.85, x, y, hr);
    g.addColorStop(
      0,
      rgba(mix(COOL, SHU, wn), 0.08 + S.glow * 0.08 + fl * 0.35 + S.pulse * 0.06 + wn * 0.12),
    );
    g.addColorStop(1, rgba(COOL, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, hr, 0, TAU);
    ctx.fill();

    // Glaskörper
    g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.05, x, y, r);
    g.addColorStop(0, "rgba(214,238,244,0.11)");
    g.addColorStop(0.72, "rgba(84,134,150,0.08)");
    g.addColorStop(1, "rgba(172,216,226,0.2)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();

    // Innenleben (zugeschnitten)
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r * 0.975, 0, TAU);
    ctx.clip();
    g = ctx.createRadialGradient(x, y + r * 0.78, 0, x, y + r * 0.78, r * 0.75);
    g.addColorStop(0, rgba(WARM, 0.1 + S.glow * 0.07));
    g.addColorStop(1, rgba(WARM, 0));
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
    const crisp = (1 - S.frost * 0.88) * (0.5 + 0.38 * S.glow);
    for (const k of inner) k.draw(ctx, false, crisp);
    if (S.frost > 0.01) {
      ctx.globalAlpha = S.frost;
      g = ctx.createRadialGradient(x - r * 0.2, y - r * 0.25, 0, x, y, r);
      g.addColorStop(0, "rgba(226,241,245,0.3)");
      g.addColorStop(1, "rgba(150,196,208,0.22)");
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
      ctx.globalAlpha = S.frost * 0.32;
      ctx.drawImage(frostTex, x - r, y - r, r * 2, r * 2);
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    // Weiches Leuchten der inneren Koi (scheint durch das Milchglas)
    gctx.save();
    gctx.beginPath();
    gctx.arc(x, y, r, 0, TAU);
    gctx.clip();
    for (const k of inner) k.draw(gctx, true, 0.3 + S.frost * 0.32 + fl * 0.8);
    gctx.restore();

    // Rand, Innenschatten, Glanzlicht
    g = ctx.createLinearGradient(x - r, y - r, x + r, y + r);
    g.addColorStop(0, "rgba(255,255,255,0.58)");
    g.addColorStop(0.45, "rgba(255,255,255,0.08)");
    g.addColorStop(1, "rgba(190,226,234,0.34)");
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.stroke();
    ctx.lineWidth = r * 0.06;
    ctx.strokeStyle = "rgba(6,14,18,0.2)";
    ctx.beginPath();
    ctx.arc(x, y, r * 0.965, 0, TAU);
    ctx.stroke();
    ctx.lineCap = "round";
    ctx.lineWidth = Math.max(1.5, r * 0.022);
    ctx.strokeStyle = "rgba(255,255,255,0.3)";
    ctx.beginPath();
    ctx.arc(x, y, r * 0.9, Math.PI * 1.1, Math.PI * 1.38);
    ctx.stroke();
    ctx.lineWidth = Math.max(1, r * 0.012);
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.beginPath();
    ctx.arc(x, y, r * 0.9, Math.PI * 1.43, Math.PI * 1.5);
    ctx.stroke();

    if (wn > 0.01) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = rgba(SHU, 0.8 * wn);
      ctx.beginPath();
      ctx.arc(x, y, r * 1.012, 0, TAU);
      ctx.stroke();
      gctx.lineWidth = 12;
      gctx.strokeStyle = rgba(SHU, 0.55 * wn);
      gctx.beginPath();
      gctx.arc(x, y, r, 0, TAU);
      gctx.stroke();
    }
    if (fl > 0.01) {
      g = ctx.createRadialGradient(x, y, 0, x, y, r * 1.15);
      g.addColorStop(0, rgba(WHITE, 0.9 * fl));
      g.addColorStop(0.5, rgba(COOL, 0.35 * fl));
      g.addColorStop(1, rgba(COOL, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r * 1.15, 0, TAU);
      ctx.fill();
    }
  }

  /* ── Agenten-Koi ────────────────────────────────────────── */

  function makeAgents(): void {
    const count = clamp(Math.round(opts.agenten ?? 6), 3, 9);
    const base = clamp(orb.r * 0.55, 44, 104);
    agents = [];
    for (let i = 0; i < count; i++) {
      const side = i % 2 ? 1 : -1;
      const len = base * rand(0.8, 1.15);
      const k = new Koi({
        x: side > 0 ? W + len * 1.5 : -len * 1.5,
        y: rand(H * 0.25, H * 0.7),
        a: side > 0 ? Math.PI : 0,
        len,
        w: len * 0.13,
        speed: rand(52, 78),
        turn: rand(1.7, 2.3),
        pal: PALETTES[(i + 1) % PALETTES.length],
        alpha: rand(0.55, 0.85),
        n: 16,
        vis: 0,
      });
      k.visT = 1;
      k.idx = i;
      k.orbit = {
        rx: rand(1.85, 3.1),
        ry: rand(0.5, 0.95),
        dir: i % 3 === 0 ? -1 : 1,
        th: rand(0, TAU),
        w: rand(0.1, 0.18),
        yo: rand(-0.3, 0.25),
      };
      agents.push(k);
    }
  }

  function steerAgents(dt: number): void {
    const st = S.state;
    const away = st === "secret" || st === "blind";
    nearest = -1;
    if (pointer.inside && time - pointer.last < 1.8 && !away && st !== "auth" && st !== "success") {
      let best = 260;
      for (const k of agents) {
        const d = Math.hypot(pointer.x - k.x, pointer.y - k.y);
        if (d < best && k.mode === "orbit") {
          best = d;
          nearest = k.idx;
        }
      }
    }
    for (const k of agents) {
      const o = k.orbit;
      o.th += o.dir * o.w * dt * MOTION * (st === "auth" ? 2.4 : 1);
      let rx = Math.min(orb.r * o.rx, W * 0.46);
      let ry = orb.r * o.ry;
      let cy = orb.y + orb.r * o.yo;
      if (away) {
        cy = orb.y - orb.r * 1.05;
        ry *= 0.55;
        rx = Math.min(rx * 1.15, W * 0.47);
      }
      let tx = orb.x + Math.cos(o.th) * rx;
      let ty = cy + Math.sin(o.th) * ry;
      if (k.mode === "home") {
        tx = orb.x;
        ty = orb.y;
      } else if (k.mode === "seek" || k.mode === "flee") {
        if (time < k.until) {
          tx = k.sx;
          ty = k.sy;
        } else k.mode = "orbit";
      } else if (k.idx === nearest) {
        tx = pointer.x;
        ty = pointer.y;
      }
      k.tx = clamp(tx, 30, W - 30);
      k.ty = clamp(ty, 40, H - 30);

      const mul =
        k.mode === "home" ? 5 : st === "success" ? 2.2 : k.mode === "flee" ? 2.4 : away ? 0.7 : 1;
      k.update(dt * MOTION, mul, time);

      if (k.mode === "home") {
        const d = Math.hypot(k.x - orb.x, k.y - orb.y);
        // Berührung des Orbs = Bestätigung
        if (!k.acked && d < orb.r * 1.1) {
          k.acked = true;
          ripple(k.x, k.y, { max: 46, color: WARM, speed: 1.8 });
          S.pulse = Math.min(1, S.pulse + 0.5);
          hs?.ack(k.idx);
          if (st !== "success") {
            k.mode = "orbit";
            k.boost = 0.6;
          }
        }
        if (st === "success" && d < orb.r * 0.9) k.visT = 0;
      }
    }
  }

  function drawAgents(front: boolean): void {
    for (const k of agents) {
      if (k.y >= orb.y !== front) continue;
      k.draw(gctx, true, S.bright * 0.6);
      k.draw(ctx, false, S.bright);
    }
  }

  /* ── Interaktion ────────────────────────────────────────── */

  function touch(x: number, y: number): void {
    if (Math.hypot(x - orb.x, y - orb.y) < orb.r) {
      ripple(orb.x, orb.y, { r0: orb.r, max: orb.r * 1.7, color: WARM, speed: 0.9, width: 1.4 });
      for (const k of inner) k.boost = 1.5;
      S.pulse = 1;
      opts.beimOrb?.();
      return;
    }
    ripple(x, y, { max: 150, color: COOL, speed: 0.9 });
    ripple(x, y, { max: 90, color: COOL, speed: 1.3, width: 0.8 });
    if (S.state === "auth" || S.state === "success") return;
    // Füttern: nahe Koi schwimmen zur Stelle
    for (const k of agents) {
      if (k.mode === "home") continue;
      if (Math.hypot(k.x - x, k.y - y) < Math.max(320, W * 0.25)) {
        k.mode = "seek";
        k.sx = x + rand(-20, 20);
        k.sy = y + rand(-20, 20);
        k.until = time + rand(1.8, 2.6);
        k.boost = 0.7;
      }
    }
  }

  function keystroke(x: number, y: number, kind: "user" | "secret" | "del"): void {
    if (kind === "secret") {
      ripple(x, y, { max: 22, color: COOL, speed: 2.4, width: 0.9 });
      S.pulse = Math.min(1, S.pulse + 0.25);
      return;
    }
    ripple(x, y, { max: 30, color: WARM, speed: 2.2, width: 0.9 });
    if (kind === "del") return;
    mote(x, y, WARM);
    let best: Koi | null = null;
    let bd = 1e9;
    for (const k of agents) {
      if (k.mode !== "orbit") continue;
      const d = Math.hypot(k.x - x, k.y - y);
      if (d < bd) {
        bd = d;
        best = k;
      }
    }
    if (best !== null && Math.random() < 0.5) {
      best.mode = "seek";
      best.sx = x;
      best.sy = y - 50;
      best.until = time + 1.1;
    }
  }

  /* ── Zustände ───────────────────────────────────────────── */

  function setState(name: SzenenZustand): void {
    const p = PRESETS[name];
    S.state = name;
    S.frostT = p.frost;
    S.glowT = p.glow;
    S.spinT = p.spin;
    S.brightT = p.bright;
    if (name !== "success") {
      S.flareT = 0;
      for (const k of agents) {
        k.visT = name === "blind" ? 0.45 : 1;
        if (k.mode === "home" && name !== "auth") k.mode = "orbit";
      }
    }
  }

  function handshake(onAck?: (index: number) => void): Promise<void> {
    return new Promise((resolve) => {
      const n = agents.length;
      let done = 0;
      const finish = (): void => {
        if (hs) {
          hs = null;
          resolve();
        }
      };
      hs = {
        ack(i) {
          done++;
          onAck?.(i);
          if (done >= n) later(finish, 180);
        },
      };
      if (REDUCED || !n) {
        agents.forEach((_k, i) => later(() => hs?.ack(i), 50 * i));
        later(finish, 50 * n + 150);
        return;
      }
      agents.forEach((k, i) => {
        k.acked = false;
        later(() => {
          if (S.state === "auth") {
            k.mode = "home";
            k.boost = 1.2;
          }
        }, i * 70);
      });
      // Zeitlimit: Nachzügler gelten als bestätigt
      later(() => {
        for (const k of agents) {
          if (!k.acked) {
            k.acked = true;
            k.mode = "orbit";
            hs?.ack(k.idx);
          }
        }
        finish();
      }, 1300);
    });
  }

  function success(): Promise<void> {
    setState("success");
    S.flareT = 1;
    for (const k of agents) {
      k.mode = "home";
      k.boost = 1.2;
    }
    return new Promise((resolve) => {
      if (REDUCED) {
        waveT0 = time - 2;
        later(resolve, 350);
        return;
      }
      later(() => {
        waveT0 = time;
      }, 350);
      later(resolve, 1450);
    });
  }

  function fail(x = W / 2, y = H * 0.85): void {
    setState("fail");
    S.warn = 1;
    S.warnT = 0;
    ripple(x, y, { max: 230, color: SHU, speed: 1.1, width: 1.6 });
    ripple(orb.x, orb.y, { r0: orb.r, max: orb.r * 1.7, color: SHU, speed: 1, width: 1.4 });
    // Koi erschrecken und stieben auseinander
    for (const k of agents) {
      const a = Math.atan2(k.y - y, k.x - x) + rand(-0.5, 0.5);
      k.mode = "flee";
      k.sx = k.x + Math.cos(a) * 360;
      k.sy = k.y + Math.sin(a) * 260;
      k.until = time + 1.4;
      k.boost = 1.8;
      k.acked = true;
    }
    for (const k of inner) k.boost = 1.4;
  }

  // Kuronami – „schwarze Welle": breitet sich vom Orb über den Bildschirm aus
  function drawWave(): void {
    if (waveT0 < 0) return;
    const p = clamp((time - waveT0) / 1.1, 0, 1);
    const e = p ** 1.7;
    const maxR = Math.hypot(Math.max(orb.x, W - orb.x), Math.max(orb.y, H - orb.y)) + 60;
    const R = orb.r * 0.9 + (maxR - orb.r * 0.9) * e;
    ctx.beginPath();
    for (let i = 0; i <= 120; i++) {
      const a = (i / 120) * TAU;
      const rr = R * (1 + 0.02 * Math.sin(a * 7 + time * 5) + 0.012 * Math.sin(a * 13 - time * 7));
      const px = orb.x + Math.cos(a) * rr;
      const py = orb.y + Math.sin(a) * rr;
      if (i) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
    }
    ctx.closePath();
    const g = ctx.createRadialGradient(orb.x, orb.y, R * 0.5, orb.x, orb.y, R);
    g.addColorStop(0, "rgba(10,20,24,0.98)");
    g.addColorStop(0.86, "rgba(12,24,29,0.94)");
    g.addColorStop(1, "rgba(30,52,60,0.86)");
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = 16;
    ctx.strokeStyle = rgba(COOL, 0.14 * (1 - p * 0.5));
    ctx.stroke();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = rgba(WHITE, 0.8 * (1 - p * 0.55));
    ctx.stroke();
  }

  /* ── Hauptschleife ──────────────────────────────────────── */

  let last = 0;
  let frame = 0;
  function loop(now: number): void {
    if (!laeuft) return;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
    last = now;
    time += dt;
    frame++;
    if (frame % 20 === 0) measureOrb();

    pointer.sx = damp(pointer.sx, pointer.nx, 2.2, dt);
    pointer.sy = damp(pointer.sy, pointer.ny, 2.2, dt);
    S.frost = damp(S.frost, S.frostT, 2.6, dt);
    S.glow = damp(S.glow, S.glowT, 2, dt);
    S.spin = damp(S.spin, S.spinT, 1.6, dt);
    S.warn = damp(S.warn, S.warnT, 1.8, dt);
    S.flare = damp(S.flare, S.flareT, 2.4, dt);
    S.bright = damp(S.bright, S.brightT, 1.3, dt);
    S.pulse = Math.max(0, S.pulse - dt * 2.2);

    updateParallax();
    ctx.clearRect(0, 0, W, H);
    gctx.clearRect(0, 0, W, H);

    drawLanterns();
    updateFlies(dt);
    drawFlies();
    updateInner(dt);
    steerAgents(dt);
    drawAgents(false);
    drawOrb();
    drawAgents(true);
    drawMotes(dt);
    drawRipples(dt);

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.9;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(glow, 0, 0, W, H);
    ctx.restore();

    drawWave();
    raf = requestAnimationFrame(loop);
  }

  resize();
  makeInner();
  makeAgents();
  globalThis.addEventListener("resize", resize);
  globalThis.addEventListener("pointermove", onPointerMove, { passive: true });
  globalThis.addEventListener("pointerdown", onPointerDown, { passive: true });
  document.documentElement.addEventListener("pointerleave", onPointerLeave);
  // Die Maske scrollt selbst (auf kleinen Bildschirmen), nicht das Fenster.
  wurzel.addEventListener("scroll", measureOrb, { passive: true });
  void document.fonts?.ready.then(() => {
    if (laeuft) measureOrb();
  });
  raf = requestAnimationFrame(loop);

  return {
    setState,
    keystroke,
    handshake,
    success,
    fail,
    destroy() {
      laeuft = false;
      cancelAnimationFrame(raf);
      for (const t of timers) clearTimeout(t);
      timers.clear();
      globalThis.removeEventListener("resize", resize);
      globalThis.removeEventListener("pointermove", onPointerMove);
      globalThis.removeEventListener("pointerdown", onPointerDown);
      document.documentElement.removeEventListener("pointerleave", onPointerLeave);
      wurzel.removeEventListener("scroll", measureOrb);
    },
  };
}
