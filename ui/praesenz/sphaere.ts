/**
 * Der Orb — Kuronami als Objekt aus Glas, nach Jakobs Bild.
 *
 * Der Orb selbst ist kein gezeichnetes Ding mehr, sondern ein **gerendertes**: ein
 * Video-Loop (`/assets/orb.mp4`) einer Glaskugel mit einem Lichtband darin, auf Schwarz
 * erzeugt und per `mix-blend-mode: screen` über den Raum gelegt — das Schwarz wird zum Raum,
 * das Glas bleibt Glas, das Band leuchtet. Bis das Video geladen ist, steht das Standbild.
 *
 * Was Kuro tut, liest man daran, **wie** das Video läuft — nicht an einer zweiten Grafik:
 *
 *   * **Ruhe**     — ruhiges Tempo, gedämpft.
 *   * **Zuhören**  — der Orb atmet: er wird im Sekundentakt eine Spur größer und kleiner.
 *   * **Denken**   — das Band läuft schneller, der Schein wird tiefer, ein leichtes Taumeln.
 *   * **Sprechen** — jedes Wortstück ist ein Lichtstoß: kurz heller, kurz breiterer Schein.
 *   * **Arbeiten** — außen kreisen kleine Boten, einer je Bedienstetem.
 *   * **Fertig**   — ein Ring löst sich vom Glas und verklingt.
 *
 * Boten und Ring liegen auf einem durchsichtigen Canvas über dem Video; alles andere sind
 * CSS-Variablen am Host (`--orb-hell`, `--orb-scale`, `--orb-glow`, `--orb-kipp`) und die
 * Abspielgeschwindigkeit. Jede Größe folgt ihrem Ziel träge — Glas ruckt nicht.
 */

export type Zustand = "ruhe" | "zuhoeren" | "denken" | "sprechen" | "arbeiten";

export interface Sphaere {
  setZustand(z: Zustand): void;
  impuls(staerke?: number): void;
  fertig(): void;
  setArbeitende(namen: readonly string[]): void;
  readonly zustand: Zustand;
  destroy(): void;
}

interface Ziel {
  tempo: number; // Abspielgeschwindigkeit
  atmen: number; // 0…1
  glow: number; // px des Scheins
  hell: number; // Grundhelligkeit
  taumel: number; // Grad Kippung
}

const ZIELE: Readonly<Record<Zustand, Ziel>> = {
  ruhe: { tempo: 0.85, atmen: 0, glow: 14, hell: 0.96, taumel: 0 },
  zuhoeren: { tempo: 1.05, atmen: 1, glow: 20, hell: 1.05, taumel: 0 },
  denken: { tempo: 1.75, atmen: 0, glow: 30, hell: 0.92, taumel: 3 },
  sprechen: { tempo: 1.2, atmen: 0, glow: 22, hell: 1.02, taumel: 0 },
  arbeiten: { tempo: 1.0, atmen: 0, glow: 18, hell: 0.98, taumel: 0 },
};

const KERN = [223, 242, 255] as const;
const SCHEIN = [127, 184, 255] as const;
const GOLDENER_WINKEL = Math.PI * (3 - Math.sqrt(5));

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export interface SphaereOptionen {
  reducedMotion?: boolean;
  video?: string;
  poster?: string;
}

export function mountSphaere(host: HTMLElement, opts: SphaereOptionen = {}): Sphaere {
  const ruhig = opts.reducedMotion ?? false;
  host.innerHTML = `
    <video class="p-orb__video" autoplay loop muted playsinline preload="auto"
           poster="${opts.poster ?? "/assets/orb.jpg"}" aria-hidden="true">
      <source src="${opts.video ?? "/assets/orb.mp4"}" type="video/mp4" />
    </video>
    <canvas class="p-orb__overlay" aria-hidden="true"></canvas>
  `;
  const videoN = host.querySelector<HTMLVideoElement>("video");
  const canvasN = host.querySelector<HTMLCanvasElement>("canvas");
  const ctxN = canvasN?.getContext("2d") ?? null;
  if (!videoN || !canvasN || !ctxN) throw new Error("Der Orb konnte nicht aufgebaut werden.");
  // Einmal geprüft, dann fest — TypeScript trägt das Narrowing nicht in die Closures.
  const video: HTMLVideoElement = videoN;
  const canvas: HTMLCanvasElement = canvasN;
  const ctx: CanvasRenderingContext2D = ctxN;
  // Autoplay kann vom Browser verweigert werden — dann steht das Standbild, und ein Tipp
  // auf den Orb (der ohnehin das Mikrofon schaltet) startet es.
  video.play().catch(() => undefined);
  host.addEventListener("click", () => void video.play().catch(() => undefined), { once: true });

  let zustand: Zustand = "ruhe";
  let ist: Ziel = { ...ZIELE.ruhe };
  let energie = 0;
  let arbeitende: string[] = [];
  let ringe: number[] = [];
  let laeuft = true;

  function zeichneOverlay(jetzt: number): void {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.clearRect(0, 0, w, h);
    // Das Overlay ist größer als der Orb (160 %); der Orb sitzt in der Mitte mit Radius R.
    const cx = w / 2;
    const cy = h / 2;
    const R = (w / 1.6) * 0.5 * 0.9;

    if (arbeitende.length > 0) {
      for (let i = 0; i < arbeitende.length; i++) {
        const a = (jetzt / 1000) * 0.45 + i * GOLDENER_WINKEL;
        const bx = cx + Math.cos(a) * R * 1.3;
        const by = cy + Math.sin(a) * R * 0.42 + R * 0.1;
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

    ringe = ringe.filter((start) => jetzt - start < 900);
    for (const start of ringe) {
      const t = (jetzt - start) / 900;
      ctx.strokeStyle = `rgba(${KERN[0]},${KERN[1]},${KERN[2]},${(1 - t) * 0.5})`;
      ctx.lineWidth = (1.5 - t) * dpr;
      ctx.beginPath();
      ctx.arc(cx, cy, R * (1 + t * 0.45), 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function tick(jetzt: number): void {
    if (!laeuft) return;
    const ziel = ZIELE[zustand];
    const k = ruhig ? 0.03 : 0.06;
    ist = {
      tempo: lerp(ist.tempo, ruhig ? 0.5 : ziel.tempo, k),
      atmen: lerp(ist.atmen, ruhig ? 0 : ziel.atmen, k),
      glow: lerp(ist.glow, ziel.glow, k),
      hell: lerp(ist.hell, ziel.hell, k),
      taumel: lerp(ist.taumel, ruhig ? 0 : ziel.taumel, k),
    };
    energie *= ruhig ? 0.8 : 0.9;

    if (Math.abs(video.playbackRate - ist.tempo) > 0.01) video.playbackRate = ist.tempo;
    const atem = ist.atmen * Math.sin((jetzt / 1000) * Math.PI * 1.15) * 0.022;
    const kipp = ist.taumel * Math.sin((jetzt / 1000) * 0.7);
    host.style.setProperty("--orb-scale", (1 + atem + energie * 0.02).toFixed(4));
    host.style.setProperty("--orb-hell", (ist.hell + energie * 0.35).toFixed(3));
    host.style.setProperty("--orb-glow", (ist.glow + energie * 18).toFixed(1));
    host.style.setProperty("--orb-kipp", `${kipp.toFixed(2)}deg`);

    zeichneOverlay(jetzt);
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
      ringe.push(performance.now());
      zustand = "ruhe";
    },
    setArbeitende(namen) {
      arbeitende = [...namen];
    },
    destroy() {
      laeuft = false;
      video.pause();
    },
  };
}
