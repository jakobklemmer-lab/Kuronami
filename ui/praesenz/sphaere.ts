/**
 * Die Sphäre — Kuronami als Objekt aus Glas.
 *
 * Nach Jakobs Bild: eine transparente Kugel, in der ein einzelnes helles Lichtband schwebt.
 * Kein Wasser mehr, kein Chrom. Das Glas ist still; **das Band lebt.** Es ist eine geschlossene
 * Kurve auf der Kugeloberfläche (eine Acht, wie ein Möbiusband ohne Kante), die langsam um die
 * Kugel wandert. Was Kuro tut, liest man am Band:
 *
 *   * **Ruhe**     — ein Band, langsame Drehung, gedämpft hell.
 *   * **Zuhören**  — das Band atmet: es weitet und verengt sich im Sekundentakt.
 *   * **Denken**   — zwei Bänder, gegenläufig, mit leichtem Taumeln; das Innere wird neblig.
 *   * **Sprechen** — jedes Wortstück ist ein Lichtstoß; das Band wird kurz breiter und heller.
 *   * **Arbeiten** — außen kreisen kleine Punkte, einer je Bedienstetem, wie Boten um das Haus.
 *   * **Fertig**   — ein Ring löst sich von der Kugel und verklingt.
 *
 * Alles Bewegte ist eine Zielgröße, der die Darstellung träge folgt. Ein Zustandswechsel ist
 * dadurch sichtbar, aber nie ein Sprung — ein Objekt aus Glas ruckt nicht.
 */

export type Zustand = "ruhe" | "zuhoeren" | "denken" | "sprechen" | "arbeiten";

export interface Sphaere {
  setZustand(z: Zustand): void;
  /** Ein Lichtstoß — beim Sprechen je Wortstück. `staerke` 0…1. */
  impuls(staerke?: number): void;
  /** Ein Ring löst sich, dann Ruhe. */
  fertig(): void;
  setArbeitende(namen: readonly string[]): void;
  readonly zustand: Zustand;
  destroy(): void;
}

interface Ziel {
  drehung: number; // rad/s um die senkrechte Achse
  taumel: number; // Amplitude der Kippung um die waagerechte Achse
  atmen: number; // 0…1, wie stark der Bandradius pulst
  zweitesBand: number; // 0…1 Deckkraft des zweiten Bands
  nebel: number; // 0…1 Leuchten im Inneren
  helligkeit: number; // Grundhelligkeit des Bands
}

const ZIELE: Readonly<Record<Zustand, Ziel>> = {
  ruhe: { drehung: 0.14, taumel: 0.05, atmen: 0, zweitesBand: 0, nebel: 0.35, helligkeit: 0.72 },
  zuhoeren: { drehung: 0.2, taumel: 0.05, atmen: 1, zweitesBand: 0, nebel: 0.5, helligkeit: 0.9 },
  denken: { drehung: 0.42, taumel: 0.35, atmen: 0, zweitesBand: 1, nebel: 0.9, helligkeit: 0.68 },
  sprechen: { drehung: 0.22, taumel: 0.08, atmen: 0, zweitesBand: 0, nebel: 0.55, helligkeit: 0.85 },
  arbeiten: { drehung: 0.16, taumel: 0.05, atmen: 0, zweitesBand: 0.35, nebel: 0.5, helligkeit: 0.78 },
};

/** Das Licht: kühles Weiß im Kern, Blau im Schein — wie im Bild. */
const KERN = [223, 242, 255] as const;
const SCHEIN = [111, 182, 255] as const;

const GOLDENER_WINKEL = Math.PI * (3 - Math.sqrt(5));
const SEGMENTE = 180;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export interface SphaereOptionen {
  reducedMotion?: boolean;
}

export function mountSphaere(canvas: HTMLCanvasElement, opts: SphaereOptionen = {}): Sphaere {
  const ctxN = canvas.getContext("2d");
  if (!ctxN) throw new Error("Kein 2D-Kontext für die Sphäre.");
  const ctx: CanvasRenderingContext2D = ctxN;
  const ruhig = opts.reducedMotion ?? false;

  let zustand: Zustand = "ruhe";
  let ist: Ziel = { ...ZIELE.ruhe };
  let arbeitende: string[] = [];
  let energie = 0; // vom Sprechen, zerfällt
  let ringe: { start: number }[] = [];
  let laeuft = true;
  let phi = 0; // Drehwinkel
  let letzteZeit = performance.now();

  function groesse(): { w: number; h: number; dpr: number } {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    return { w, h, dpr };
  }

  /**
   * Eine Acht auf der Kugel, gedreht um die senkrechte Achse (`phi`) und leicht gekippt.
   * Liefert Bildkoordinaten (relativ zur Mitte, Einheit = Kugelradius) und die Tiefe z
   * (−1 hinten … +1 vorn).
   */
  function band(
    phase: number,
    kipp: number,
    radius: number,
  ): Array<{ x: number; y: number; z: number }> {
    const punkte: Array<{ x: number; y: number; z: number }> = [];
    const cy = Math.cos(kipp);
    const sy = Math.sin(kipp);
    const cp = Math.cos(phi + phase);
    const sp = Math.sin(phi + phase);
    for (let i = 0; i <= SEGMENTE; i++) {
      const t = (i / SEGMENTE) * Math.PI * 2;
      // Acht auf der Einheitskugel.
      let x = Math.sin(t);
      let y = Math.sin(2 * t) * 0.55;
      let z = Math.cos(t);
      const l = Math.hypot(x, y, z) || 1;
      x /= l;
      y /= l;
      z /= l;
      // um Y drehen
      const x1 = x * cp + z * sp;
      const z1 = -x * sp + z * cp;
      // um X kippen
      const y2 = y * cy - z1 * sy;
      const z2 = y * sy + z1 * cy;
      punkte.push({ x: x1 * radius, y: y2 * radius, z: z2 });
    }
    return punkte;
  }

  function zeichneBand(
    cx: number,
    cy: number,
    R: number,
    pts: Array<{ x: number; y: number; z: number }>,
    deckkraft: number,
    breite: number,
  ): void {
    if (deckkraft <= 0.01) return;
    // Hinten zuerst, damit das Vordere darüberliegt: Segmente nach Tiefe sortieren.
    const seg: Array<{ a: (typeof pts)[number]; b: (typeof pts)[number]; z: number }> = [];
    for (let i = 0; i < pts.length - 1; i++) {
      seg.push({ a: pts[i], b: pts[i + 1], z: (pts[i].z + pts[i + 1].z) / 2 });
    }
    seg.sort((p, q) => p.z - q.z);
    ctx.lineCap = "round";
    for (const s of seg) {
      const tiefe = (s.z + 1) / 2; // 0 hinten, 1 vorn
      const a = deckkraft * (0.18 + tiefe * 0.82);
      const w = breite * (0.35 + tiefe * 0.65);
      // Schein
      ctx.strokeStyle = `rgba(${SCHEIN[0]},${SCHEIN[1]},${SCHEIN[2]},${a * 0.45})`;
      ctx.lineWidth = w * 3.4;
      ctx.beginPath();
      ctx.moveTo(cx + s.a.x * R, cy + s.a.y * R);
      ctx.lineTo(cx + s.b.x * R, cy + s.b.y * R);
      ctx.stroke();
      // Kern
      ctx.strokeStyle = `rgba(${KERN[0]},${KERN[1]},${KERN[2]},${a})`;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(cx + s.a.x * R, cy + s.a.y * R);
      ctx.lineTo(cx + s.b.x * R, cy + s.b.y * R);
      ctx.stroke();
    }
  }

  function zeichne(jetzt: number): void {
    const { w, h, dpr } = groesse();
    const cx = w / 2;
    const cy = h * 0.46;
    const R = Math.min(w, h) * 0.34;
    ctx.clearRect(0, 0, w, h);

    // ---- Spiegelung auf dem Tresen: eine flache, weiche Ellipse in Bandfarbe.
    const sp = ctx.createRadialGradient(cx, cy + R * 1.55, 0, cx, cy + R * 1.55, R * 1.1);
    sp.addColorStop(0, `rgba(${SCHEIN[0]},${SCHEIN[1]},${SCHEIN[2]},${0.09 * ist.helligkeit})`);
    sp.addColorStop(1, "rgba(0,0,0,0)");
    ctx.save();
    ctx.scale(1, 0.28);
    ctx.fillStyle = sp;
    ctx.fillRect(0, (cy + R * 1.55) / 0.28 - R * 1.2, w, R * 2.4);
    ctx.restore();

    // ---- Das Glas: fast unsichtbar, am Rand ein Hauch heller (Fresnel).
    const glas = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R);
    glas.addColorStop(0, "rgba(200,222,238,0.020)");
    glas.addColorStop(0.75, "rgba(200,222,238,0.035)");
    glas.addColorStop(1, "rgba(200,222,238,0.11)");
    ctx.fillStyle = glas;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();

    // ---- Nebel im Inneren: das Licht des Bands, das im Glas hängen bleibt.
    const nebel = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.95);
    nebel.addColorStop(0, `rgba(${SCHEIN[0]},${SCHEIN[1]},${SCHEIN[2]},${0.11 * ist.nebel})`);
    nebel.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = nebel;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();

    // ---- Die Bänder.
    const atem = ist.atmen * Math.sin(jetzt / 1000 * Math.PI * 1.15) * 0.035;
    const radius = 0.9 + atem;
    const kipp = 0.32 + Math.sin(jetzt / 1000 * 0.37) * ist.taumel;
    const hell = Math.min(1.15, ist.helligkeit + energie * 0.55);
    const breite = (3.1 + energie * 2.6) * dpr;

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.985, 0, Math.PI * 2);
    ctx.clip();
    zeichneBand(cx, cy, R, band(Math.PI / 2, -kipp * 0.8, radius * 0.97), ist.zweitesBand * hell * 0.6, breite * 0.8);
    zeichneBand(cx, cy, R, band(0, kipp, radius), hell, breite);
    ctx.restore();

    // ---- Glasrand und Glanz: was die Kugel überhaupt als Glas zeigt.
    const rand = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
    rand.addColorStop(0, "rgba(230,240,250,0.42)");
    rand.addColorStop(0.5, "rgba(230,240,250,0.08)");
    rand.addColorStop(1, "rgba(230,240,250,0.22)");
    ctx.strokeStyle = rand;
    ctx.lineWidth = 1.2 * dpr;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();

    const glanz = ctx.createRadialGradient(cx - R * 0.42, cy - R * 0.48, 0, cx - R * 0.42, cy - R * 0.48, R * 0.38);
    glanz.addColorStop(0, "rgba(255,255,255,0.20)");
    glanz.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = glanz;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();

    // ---- Boten: je Bedienstetem ein Punkt, der außen kreist.
    if (arbeitende.length > 0) {
      for (let i = 0; i < arbeitende.length; i++) {
        const a = jetzt / 1000 * 0.45 + i * GOLDENER_WINKEL;
        const bx = cx + Math.cos(a) * R * 1.28;
        const by = cy + Math.sin(a) * R * 0.42 + R * 0.05; // flache Bahn, wie auf dem Tresen
        const vorn = Math.sin(a) > 0;
        const al = vorn ? 0.85 : 0.35;
        ctx.fillStyle = `rgba(${SCHEIN[0]},${SCHEIN[1]},${SCHEIN[2]},${al * 0.45})`;
        ctx.beginPath();
        ctx.arc(bx, by, 5 * dpr, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `rgba(${KERN[0]},${KERN[1]},${KERN[2]},${al})`;
        ctx.beginPath();
        ctx.arc(bx, by, 1.8 * dpr, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ---- Ringe vom Fertigwerden.
    ringe = ringe.filter((r) => jetzt - r.start < 900);
    for (const r of ringe) {
      const t = (jetzt - r.start) / 900;
      ctx.strokeStyle = `rgba(${KERN[0]},${KERN[1]},${KERN[2]},${(1 - t) * 0.5})`;
      ctx.lineWidth = (1.5 - t) * dpr;
      ctx.beginPath();
      ctx.arc(cx, cy, R * (1 + t * 0.45), 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function tick(jetzt: number): void {
    if (!laeuft) return;
    const dt = Math.min(0.05, (jetzt - letzteZeit) / 1000);
    letzteZeit = jetzt;

    const ziel = ZIELE[zustand];
    const k = ruhig ? 0.02 : 0.06;
    ist = {
      drehung: lerp(ist.drehung, ruhig ? 0.02 : ziel.drehung, k),
      taumel: lerp(ist.taumel, ruhig ? 0 : ziel.taumel, k),
      atmen: lerp(ist.atmen, ruhig ? 0 : ziel.atmen, k),
      zweitesBand: lerp(ist.zweitesBand, ziel.zweitesBand, k),
      nebel: lerp(ist.nebel, ziel.nebel, k),
      helligkeit: lerp(ist.helligkeit, ziel.helligkeit, k),
    };
    phi += ist.drehung * dt;
    energie *= ruhig ? 0.8 : 0.9;

    zeichne(jetzt);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  return {
    get zustand() {
      return zustand;
    },
    setZustand(z) {
      zustand = z;
    },
    impuls(staerke = 0.5) {
      energie = Math.min(1.4, energie + 0.25 + Math.max(0, Math.min(1, staerke)) * 0.6);
    },
    fertig() {
      ringe.push({ start: performance.now() });
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
