/**
 * Die schwarze Welle — Kuros Präsenz.
 *
 * 黒波 heißt „schwarze Welle", und genau das ist hier zu sehen: eine dunkle Wasserfläche von
 * oben, kreisrund, wie ein Teich bei Nacht. Kein Emblem, kein Leuchten. Wasser ist das
 * Gegenteil einer Neon-Anzeige: es reagiert auf alles, was es berührt, und wird von sich aus
 * wieder still.
 *
 * Die Fläche ist eine **echte Wellensimulation** (zwei Höhenpuffer, Nachbar-Mittelwert,
 * Dämpfung), keine Überlagerung von Sinuskurven. Der Unterschied ist, dass man sie an jeder
 * Stelle stören kann — und die Stelle trägt Bedeutung:
 *
 *   * **Rand → Mitte**: etwas kommt an. Zuhören (Schall), Arbeiten (Bedienstete berichten).
 *   * **Mitte → Rand**: etwas geht hinaus. Sprechen — ein Ring pro Wortgruppe.
 *   * **Überall, ohne Richtung**: Denken.
 *   * **Ein einzelner großer Ring**: fertig.
 *
 * Mechanik und Zeichnung sind getrennt, wie schon in `canvas/ripples.ts`: `Wasser` kennt kein
 * Canvas, `mountWelle` kennt keine Zustände. Das erste lässt sich in Zahlen prüfen, das zweite
 * im Bild.
 */

export type WellenZustand = "ruhe" | "zuhoeren" | "denken" | "sprechen" | "arbeiten";

export interface Welle {
  setZustand(zustand: WellenZustand): void;
  /** Ein Ring aus der Mitte — beim Sprechen je Wortgruppe. `staerke` 0…1. */
  impuls(staerke?: number): void;
  /** Ein letzter großer Ring, dann Ruhe. */
  fertig(): void;
  /** Wer gerade arbeitet — jeder Name bekommt eine eigene Quelle am Rand. */
  setArbeitende(namen: readonly string[]): void;
  readonly zustand: WellenZustand;
  destroy(): void;
}

// ---------------------------------------------------------------------------
// Mechanik
// ---------------------------------------------------------------------------

export class Wasser {
  readonly n: number;
  #a: Float32Array;
  #b: Float32Array;
  daempfung = 0.985;

  constructor(n = 128) {
    this.n = n;
    this.#a = new Float32Array(n * n);
    this.#b = new Float32Array(n * n);
  }

  get hoehe(): Float32Array {
    return this.#a;
  }

  /** Eine Störung: Gauß-Hügel um (`x`,`y`) in Gitterkoordinaten 0…1. */
  stoere(x: number, y: number, radius: number, kraft: number): void {
    const n = this.n;
    const cx = x * (n - 1);
    const cy = y * (n - 1);
    const r = Math.max(1, radius * n);
    const r2 = r * r;
    const x0 = Math.max(1, Math.floor(cx - r));
    const x1 = Math.min(n - 2, Math.ceil(cx + r));
    const y0 = Math.max(1, Math.floor(cy - r));
    const y1 = Math.min(n - 2, Math.ceil(cy + r));
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        const dx = xx - cx;
        const dy = yy - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        this.#a[yy * n + xx] += kraft * Math.exp(-d2 / (r2 * 0.35));
      }
    }
  }

  /** Ein Zeitschritt. Die Welle läuft eine Zelle weit. */
  schritt(): void {
    const n = this.n;
    const a = this.#a;
    const b = this.#b;
    const d = this.daempfung;
    for (let y = 1; y < n - 1; y++) {
      const row = y * n;
      for (let x = 1; x < n - 1; x++) {
        const i = row + x;
        b[i] = ((a[i - 1] + a[i + 1] + a[i - n] + a[i + n]) * 0.5 - b[i]) * d;
      }
    }
    // Rand absorbiert: keine Reflexion, das Wasser läuft am Ufer aus.
    for (let x = 0; x < n; x++) {
      b[x] = 0;
      b[(n - 1) * n + x] = 0;
    }
    for (let y = 0; y < n; y++) {
      b[y * n] = 0;
      b[y * n + n - 1] = 0;
    }
    this.#b = a;
    this.#a = b;
  }

  /** Gesamtenergie — für Prüfungen: still heißt nahe null. */
  energie(): number {
    let e = 0;
    for (let i = 0; i < this.#a.length; i++) e += Math.abs(this.#a[i]);
    return e;
  }
}

// ---------------------------------------------------------------------------
// Was ein Zustand mit dem Wasser tut
// ---------------------------------------------------------------------------

interface Profil {
  /** Abstand zwischen zwei Störungen in ms. 0 = keine von selbst. */
  intervallMs: number;
  radius: number;
  kraft: number;
  /** Wo: `mitte`, `rand` (r 0,86…0,94) oder `frei` (r < 0,7). */
  ort: "mitte" | "rand" | "frei";
  daempfung: number;
  /** Wie viel vom Mondlicht bleibt. Denken zieht es zurück. */
  licht: number;
}

const PROFILE: Readonly<Record<WellenZustand, Profil>> = {
  ruhe: { intervallMs: 2600, radius: 0.025, kraft: 0.28, ort: "frei", daempfung: 0.985, licht: 1 },
  zuhoeren: { intervallMs: 190, radius: 0.024, kraft: 0.32, ort: "rand", daempfung: 0.984, licht: 0.9 },
  denken: { intervallMs: 420, radius: 0.05, kraft: 0.38, ort: "frei", daempfung: 0.989, licht: 0.5 },
  sprechen: { intervallMs: 560, radius: 0.03, kraft: 0.38, ort: "mitte", daempfung: 0.982, licht: 1 },
  arbeiten: { intervallMs: 600, radius: 0.024, kraft: 0.36, ort: "rand", daempfung: 0.988, licht: 0.7 },
};

/** Der goldene Winkel verteilt die Quellen der Bediensteten gleichmäßig, egal wie viele es sind. */
const GOLDENER_WINKEL = Math.PI * (3 - Math.sqrt(5));

function ortFuer(profil: Profil, zufall: () => number): [number, number] {
  if (profil.ort === "mitte") return [0.5, 0.5];
  const winkel = zufall() * Math.PI * 2;
  const r = profil.ort === "rand" ? 0.43 + zufall() * 0.04 : zufall() * 0.33;
  return [0.5 + Math.cos(winkel) * r, 0.5 + Math.sin(winkel) * r];
}

// ---------------------------------------------------------------------------
// Zeichnung
// ---------------------------------------------------------------------------

export interface WellenFarben {
  tief: [number, number, number];
  kamm: [number, number, number];
  licht: [number, number, number];
}

export const WELLEN_FARBEN: WellenFarben = {
  tief: [0x10, 0x20, 0x28],
  kamm: [0x2c, 0x50, 0x5c],
  licht: [0xe3, 0xec, 0xef],
};

export interface WelleOptionen {
  farben?: WellenFarben;
  gitter?: number;
  reducedMotion?: boolean;
  zufall?: () => number;
}

export function mountWelle(canvas: HTMLCanvasElement, opts: WelleOptionen = {}): Welle {
  const farben = opts.farben ?? WELLEN_FARBEN;
  const n = opts.gitter ?? 128;
  const zufall = opts.zufall ?? Math.random;
  const ruhig = opts.reducedMotion ?? false;

  const wasser = new Wasser(n);
  const puffer = document.createElement("canvas");
  puffer.width = n;
  puffer.height = n;
  const pctxN = puffer.getContext("2d");
  const ctxN = canvas.getContext("2d");
  if (!pctxN || !ctxN) throw new Error("Kein 2D-Kontext für die Welle.");
  // Einmal geprüft, dann fest — TypeScript trägt das Narrowing nicht in die Closures unten.
  const pctx: CanvasRenderingContext2D = pctxN;
  const ctx: CanvasRenderingContext2D = ctxN;
  const bild = pctx.createImageData(n, n);
  const px = bild.data;

  // Kreismaske einmal vorberechnen: 1 innen, weicher Rand, 0 außen.
  const maske = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = (x + 0.5) / n - 0.5;
      const dy = (y + 0.5) / n - 0.5;
      const d = Math.sqrt(dx * dx + dy * dy);
      const rand = 0.5;
      const weich = 0.035;
      maske[y * n + x] = d > rand ? 0 : d < rand - weich ? 1 : (rand - d) / weich;
    }
  }

  let zustand: WellenZustand = "ruhe";
  let arbeitende: string[] = [];
  let letzteStoerung = 0;
  let lichtIst = 1;
  let laeuft = true;
  let frame = 0;

  function groesse(): void {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  function stoereNachProfil(jetzt: number): void {
    const profil = PROFILE[zustand];
    if (ruhig && zustand === "ruhe") return;
    if (profil.intervallMs === 0 || jetzt - letzteStoerung < profil.intervallMs) return;
    letzteStoerung = jetzt;

    if (zustand === "arbeiten" && arbeitende.length > 0) {
      // Jeder Bedienstete hat seinen festen Platz am Ufer.
      const i = frame % arbeitende.length;
      const winkel = i * GOLDENER_WINKEL - Math.PI / 2;
      const r = 0.44;
      wasser.stoere(
        0.5 + Math.cos(winkel) * r,
        0.5 + Math.sin(winkel) * r,
        profil.radius,
        profil.kraft,
      );
      return;
    }
    const [x, y] = ortFuer(profil, zufall);
    wasser.stoere(x, y, profil.radius, profil.kraft);
  }

  function zeichne(): void {
    const h = wasser.hoehe;
    // Licht kommt von oben links, flach — so werfen die Wellenkämme lange Schatten.
    const lx = -0.6;
    const ly = -0.8;
    const [tr, tg, tb] = farben.tief;
    const [kr, kg, kb] = farben.kamm;
    const [lr, lg, lb] = farben.licht;

    for (let y = 1; y < n - 1; y++) {
      for (let x = 1; x < n - 1; x++) {
        const i = y * n + x;
        const m = maske[i];
        const o = i * 4;
        if (m <= 0) {
          px[o + 3] = 0;
          continue;
        }
        const dx = h[i + 1] - h[i - 1];
        const dy = h[i + n] - h[i - n];
        const schatten = dx * lx + dy * ly;
        // Grundhelligkeit: leichte Kuppe zur Mitte hin — Wasser ist nie flach ausgeleuchtet.
        const cx = (x + 0.5) / n - 0.5;
        const cy = (y + 0.5) / n - 0.5;
        // Zum Ufer hin dunkler, nicht zur Mitte hin heller: das ist ein Becken, keine Kugel.
        const vign = 1 - Math.min(1, Math.sqrt(cx * cx + cy * cy) * 2) * 0.45;
        let t = 0.3 * vign + schatten * 1.25;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        // Der Glanz ist matt: ein Hauch Mondlicht auf den Kämmen, kein Chrom.
        const spek = schatten > 0 ? Math.min(1, schatten * 4.5) ** 4 * 0.42 * lichtIst : 0;

        px[o] = tr + (kr - tr) * t + (lr - kr) * spek;
        px[o + 1] = tg + (kg - tg) * t + (lg - kg) * spek;
        px[o + 2] = tb + (kb - tb) * t + (lb - kb) * spek;
        px[o + 3] = Math.round(255 * m);
      }
    }
    pctx.putImageData(bild, 0, 0);

    groesse();
    const w = canvas.width;
    const hh = canvas.height;
    ctx.clearRect(0, 0, w, hh);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(puffer, 1, 1, n - 2, n - 2, 0, 0, w, hh);

    // Das Mondlicht: ein einziger, weicher Reflex oben links. Beim Denken zieht er sich zurück.
    const g = ctx.createRadialGradient(w * 0.4, hh * 0.36, 0, w * 0.4, hh * 0.36, w * 0.62);
    g.addColorStop(0, `rgba(${lr},${lg},${lb},${0.06 * lichtIst})`);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.save();
    ctx.beginPath();
    ctx.arc(w / 2, hh / 2, Math.min(w, hh) / 2 - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, hh);
    ctx.restore();
  }

  function tick(jetzt: number): void {
    if (!laeuft) return;
    frame++;
    stoereNachProfil(jetzt);
    wasser.daempfung = ruhig ? 0.96 : PROFILE[zustand].daempfung;
    wasser.schritt();
    // Das Licht folgt dem Zustand träge — ein Wechsel darf sichtbar sein, aber nicht springen.
    const ziel = PROFILE[zustand].licht;
    lichtIst += (ziel - lichtIst) * 0.04;
    zeichne();
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  return {
    get zustand() {
      return zustand;
    },
    setZustand(z) {
      if (z === zustand) return;
      zustand = z;
      // Ein Zustandswechsel darf sofort zu sehen sein, nicht erst nach dem nächsten Intervall.
      letzteStoerung = 0;
    },
    impuls(staerke = 0.5) {
      const k = 0.28 + Math.min(1, Math.max(0, staerke)) * 0.75;
      wasser.stoere(0.5, 0.5, 0.03 + staerke * 0.03, k);
    },
    fertig() {
      wasser.stoere(0.5, 0.5, 0.09, 1.3);
      zustand = "ruhe";
    },
    setArbeitende(namen) {
      arbeitende = [...namen];
    },
    destroy() {
      laeuft = false;
    },
  };
}
