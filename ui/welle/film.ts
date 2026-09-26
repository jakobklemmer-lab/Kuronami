import {
  begrenze,
  bildpaar,
  deckung,
  fahrdauer,
  ladeReihenfolge,
  naechstesGeladenes,
  sanft,
} from "./film-rechnung.js";

/**
 * Der Film hinter der Welle.
 *
 * Zehn Sekunden Kamerafahrt, erzeugt am 2026-09-26 mit Kling v3 Pro aus Jakobs Raum
 * (`ui/assets/praesenz.jpg` als erstes Bild, Artlist-Generierung
 * `01a0de9e-b3eb-78ad-a29a-1b4445db4a8f`): vom Bonsai durchs Fenster auf die Terrasse mit den
 * schwimmenden Laternen. Hier liegt er als 121 Einzelbilder (jedes zweite der 24 fps), in zwei
 * Größen: `film/sd/` mit 1280 px für Telefone und kleine Fenster, `film/hd/` mit 1920 px.
 *
 * Der Film läuft nie von selbst. Er steht an einer Stelle — dem Ort des offenen Bereichs
 * (`stationen.ts`) oder, in „Dein Tag", dem Scrollstand — und fährt nur, wenn Jakob etwas tut.
 *
 * Gezeichnet wird in WebGL, weil ein Shader drei Dinge in einem Zug kann, die eine
 * Leinwand in 2D nur mit mehreren Durchgängen schafft: zwei Nachbarbilder mischen (flüssig auch
 * zwischen den Bildern), **Kuros Licht** in den Film legen (die Farbe seines Zustands,
 * `zustand.ts`) und ein feines Filmkorn. Dazu folgt die Kamera ein wenig der Maus, und wo sie
 * sich bewegt, laufen schwache Ringe übers Bild. Ohne WebGL zeichnet eine 2D-Leinwand dasselbe
 * ohne Korn und Ringe.
 */

export interface FilmOptionen {
  /** Ordner der Einzelbilder, mit Schrägstrich am Ende. Die Bilder heißen `f001.webp` … */
  ordner: string;
  anzahl: number;
  /** Seitenverhältnis der Bilder. */
  bildB: number;
  bildH: number;
  /** Wo der Film beim Öffnen steht, 0 bis 1. */
  start?: number;
}

export interface Film {
  /** Folgt einem Wert weich nach — für den Scrollstand, der sich laufend ändert. */
  folge(ort: number): void;
  /** Fährt in einem Zug an einen Ort — für den Wechsel des Bereichs. */
  fahre(ort: number): void;
  /** Kuros Licht: Farbe als `#rrggbb` und wie stark sie den Film färbt. */
  setzeTon(farbe: string, staerke: number): void;
  /** Wie weit der Film zurücktritt, 0 (ganz da) bis 1 (schwarz). */
  setzeDunkel(wert: number): void;
  destroy(): void;
}

const ECKEN = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);

const VERTEX = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAGMENT = `
precision mediump float;
uniform sampler2D uA;
uniform sampler2D uB;
uniform float uMisch;
uniform vec2 uSicht;
uniform vec2 uVersatz;
uniform vec3 uTon;
uniform float uTonKraft;
uniform float uDunkel;
uniform float uZeit;
uniform float uKorn;
uniform vec2 uMaus;
uniform float uRinge;
uniform vec2 uAufloesung;
varying vec2 vUv;

float zufall(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec2 uv = (vUv - 0.5) * uSicht + 0.5 + uVersatz;

  // Ringe um die Maus, wie ein Tropfen auf dem Wasser. Sie klingen mit der Entfernung und mit
  // der Zeit seit der letzten Bewegung ab (uRinge).
  vec2 d = (vUv - uMaus) * vec2(uAufloesung.x / uAufloesung.y, 1.0);
  float r = length(d);
  float ring = sin(r * 42.0 - uZeit * 3.0) * exp(-r * 7.0) * uRinge;
  uv += (d / max(r, 0.0001)) * ring * 0.0035;

  vec3 farbe = mix(texture2D(uA, uv).rgb, texture2D(uB, uv).rgb, uMisch);

  // Kuros Licht färbt die hellen Stellen — Laternen, Himmel, Wasser —, nicht das Schwarz.
  float hell = dot(farbe, vec3(0.299, 0.587, 0.114));
  vec3 getoent = farbe * (0.55 + uTon * 0.9);
  farbe = mix(farbe, getoent, uTonKraft * smoothstep(0.04, 0.65, hell));

  vec2 q = vUv - 0.5;
  float vignette = smoothstep(0.95, 0.25, length(q * vec2(1.05, 1.3)));
  farbe *= mix(0.5, 1.0, vignette);
  farbe *= 1.0 - uDunkel;

  float korn = zufall(vUv * uAufloesung + fract(uZeit * 7.13)) - 0.5;
  farbe += korn * uKorn;

  gl_FragColor = vec4(farbe, 1.0);
}`;

function hexZuRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return [1, 1, 1];
  return [
    Number.parseInt(m[1], 16) / 255,
    Number.parseInt(m[2], 16) / 255,
    Number.parseInt(m[3], 16) / 255,
  ];
}

/** Nähert einen Wert an sein Ziel an, unabhängig von der Bildrate. */
function naehere(wert: number, ziel: number, dt: number, tempo: number): number {
  const neu = wert + (ziel - wert) * (1 - Math.exp(-dt * tempo));
  return Math.abs(ziel - neu) < 1e-4 ? ziel : neu;
}

interface Zeichner {
  zeichne(zustand: Bildzustand): void;
  groesse(b: number, h: number): void;
  destroy(): void;
}

interface Bildzustand {
  a: HTMLImageElement;
  b: HTMLImageElement;
  ia: number;
  ib: number;
  misch: number;
  sicht: [number, number];
  versatz: [number, number];
  ton: [number, number, number];
  tonKraft: number;
  dunkel: number;
  zeit: number;
  korn: number;
  maus: [number, number];
  ringe: number;
  aufloesung: [number, number];
}

export function mountFilm(canvas: HTMLCanvasElement, opt: FilmOptionen): Film {
  const ruhig = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const grob = globalThis.matchMedia?.("(pointer: coarse)").matches ?? false;
  const n = opt.anzahl;
  const bilder: Array<HTMLImageElement | null> = new Array(n).fill(null);
  const geladen: boolean[] = new Array(n).fill(false);

  let ort = begrenze(opt.start ?? 0);
  let ziel = ort;
  let fahrt: { von: number; nach: number; beginn: number; dauer: number } | null = null;
  let ton: [number, number, number] = hexZuRgb("#6d90ff");
  let tonZiel = ton;
  let tonKraft = 0.1;
  let tonKraftZiel = 0.1;
  let dunkel = 0;
  let dunkelZiel = 0;
  let maus: [number, number] = [0.5, 0.5];
  let mausZiel: [number, number] = [0.5, 0.5];
  let ringe = 0;
  let neuZeichnen = true;
  let weg = false;

  const zeichner = webglZeichner(canvas) ?? leinwandZeichner(canvas);

  // ---------------------------------------------------------------- Laden
  const reihe = ladeReihenfolge(n, Math.round(ort * (n - 1)));
  let naechster = 0;
  let fehlschlaege = 0;
  const ladeNaechstes = (): void => {
    if (weg || naechster >= reihe.length) return;
    const i = reihe[naechster++];
    const bild = new Image();
    bild.decoding = "async";
    bild.src = `${opt.ordner}f${String(i + 1).padStart(3, "0")}.webp`;
    const fertig = (): void => {
      if (weg) return;
      bilder[i] = bild;
      geladen[i] = true;
      neuZeichnen = true;
      ladeNaechstes();
    };
    // Auf dem Telefon nur laden, nicht vorab entpacken: 121 entpackte Bilder hielte Safari
    // nicht im Speicher. Am Rechner entpackt `decode()` vorab, damit das Scrollen nicht an
    // einem Bild hängt, das erst beim Zeichnen entpackt wird.
    const warte = grob
      ? new Promise<void>((ok, nein) => {
          bild.onload = () => ok();
          bild.onerror = () => nein(new Error("nicht ladbar"));
        })
      : bild.decode();
    warte.then(fertig).catch((error: unknown) => {
      fehlschlaege++;
      // Ein fehlendes Bild ist ein Fehler, kein Grund zu schweigen — aber auch keiner, den Film
      // anzuhalten: gezeichnet wird dann das nächste, das da ist.
      console.error(`[welle] Filmbild ${bild.src} fehlt:`, error);
      if (fehlschlaege === n) console.error("[welle] Kein einziges Filmbild ließ sich laden.");
      ladeNaechstes();
    });
  };
  for (let k = 0; k < 6; k++) ladeNaechstes();

  // ---------------------------------------------------------------- Größe
  const passeAn = (): void => {
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 1.5);
    const b = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== b || canvas.height !== h) {
      canvas.width = b;
      canvas.height = h;
      zeichner.groesse(b, h);
      neuZeichnen = true;
    }
  };
  const beobachter = new ResizeObserver(passeAn);
  beobachter.observe(canvas);
  passeAn();

  // ---------------------------------------------------------------- Maus
  const beiZeiger = (e: PointerEvent): void => {
    if (ruhig || e.pointerType === "touch") return;
    mausZiel = [e.clientX / globalThis.innerWidth, 1 - e.clientY / globalThis.innerHeight];
    ringe = Math.min(1, ringe + 0.08);
  };
  globalThis.addEventListener("pointermove", beiZeiger, { passive: true });

  // ---------------------------------------------------------------- Schleife
  let letzte = performance.now();
  let letztesKorn = 0;
  let schleife = 0;
  const tick = (t: number): void => {
    schleife = requestAnimationFrame(tick);
    const dt = Math.min(0.1, (t - letzte) / 1000);
    letzte = t;
    let bewegt = neuZeichnen;
    neuZeichnen = false;

    if (fahrt) {
      const k = (t - fahrt.beginn) / fahrt.dauer;
      ort = fahrt.von + (fahrt.nach - fahrt.von) * sanft(k);
      if (k >= 1) {
        ort = fahrt.nach;
        ziel = ort;
        fahrt = null;
      }
      bewegt = true;
    } else if (ort !== ziel) {
      ort = naehere(ort, ziel, dt, 6);
      bewegt = true;
    }

    const vorher = tonKraft + dunkel + ton[0] + ton[1] + ton[2];
    tonKraft = naehere(tonKraft, tonKraftZiel, dt, 2.5);
    dunkel = naehere(dunkel, dunkelZiel, dt, 4);
    ton = [
      naehere(ton[0], tonZiel[0], dt, 2.5),
      naehere(ton[1], tonZiel[1], dt, 2.5),
      naehere(ton[2], tonZiel[2], dt, 2.5),
    ];
    if (tonKraft + dunkel + ton[0] + ton[1] + ton[2] !== vorher) bewegt = true;

    const mx = naehere(maus[0], mausZiel[0], dt, 2);
    const my = naehere(maus[1], mausZiel[1], dt, 2);
    if (mx !== maus[0] || my !== maus[1]) bewegt = true;
    maus = [mx, my];
    if (ringe > 0) {
      ringe = ringe < 0.002 ? 0 : ringe * Math.exp(-dt * 1.4);
      bewegt = true;
    }

    // Das Korn läuft mit 24 Bildern je Sekunde wie auf Film — aber nur am Rechner: auf dem
    // Telefon hielte es die Grafik dauernd wach und kostete Akku für ein Detail.
    const korn = !ruhig && !grob && t - letztesKorn > 1000 / 24;
    if (korn) letztesKorn = t;
    if (!bewegt && !korn) return;

    const paar = bildpaar(ort, n);
    const ia = naechstesGeladenes(paar.a, geladen);
    const ib = naechstesGeladenes(paar.b, geladen);
    if (ia === null || ib === null) return;
    const a = bilder[ia];
    const b = bilder[ib];
    if (!a || !b) return;

    // Ein wenig Rand um das Bild, damit die Kamera der Maus folgen kann, ohne dass eine Kante
    // ins Bild rutscht.
    const [sx, sy] = deckung(canvas.width, canvas.height, opt.bildB, opt.bildH);
    const sicht: [number, number] = [sx / 1.05, sy / 1.05];
    const versatz: [number, number] = [
      (maus[0] - 0.5) * (1 - sicht[0]) * 0.7,
      (maus[1] - 0.5) * (1 - sicht[1]) * 0.7,
    ];
    zeichner.zeichne({
      a,
      b,
      ia,
      ib,
      misch: ia === ib ? 0 : paar.t,
      sicht,
      versatz,
      ton,
      tonKraft,
      dunkel,
      zeit: t / 1000,
      korn: ruhig || grob ? 0.02 : 0.035,
      maus,
      ringe,
      aufloesung: [canvas.width, canvas.height],
    });
  };
  schleife = requestAnimationFrame(tick);

  return {
    folge(wert) {
      fahrt = null;
      ziel = begrenze(wert);
      if (ruhig) ort = ziel;
    },
    fahre(wert) {
      const nach = begrenze(wert);
      if (ruhig || Math.abs(nach - ort) < 1e-4) {
        fahrt = null;
        ort = nach;
        ziel = nach;
        neuZeichnen = true;
        return;
      }
      fahrt = { von: ort, nach, beginn: performance.now(), dauer: fahrdauer(ort, nach) };
    },
    setzeTon(farbe, staerke) {
      tonZiel = hexZuRgb(farbe);
      tonKraftZiel = begrenze(staerke);
    },
    setzeDunkel(wert) {
      dunkelZiel = begrenze(wert);
    },
    destroy() {
      weg = true;
      cancelAnimationFrame(schleife);
      beobachter.disconnect();
      globalThis.removeEventListener("pointermove", beiZeiger);
      zeichner.destroy();
    },
  };
}

// ---------------------------------------------------------------------------
// WebGL
// ---------------------------------------------------------------------------

function webglZeichner(canvas: HTMLCanvasElement): Zeichner | null {
  const gl = canvas.getContext("webgl", {
    alpha: false,
    antialias: false,
    depth: false,
    premultipliedAlpha: false,
    powerPreference: "high-performance",
  });
  if (!gl) return null;

  const shader = (art: number, quelle: string): WebGLShader | null => {
    const s = gl.createShader(art);
    if (!s) return null;
    gl.shaderSource(s, quelle);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error("[welle] Shader:", gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  };
  const vs = shader(gl.VERTEX_SHADER, VERTEX);
  const fs = shader(gl.FRAGMENT_SHADER, FRAGMENT);
  const programm = gl.createProgram();
  if (!vs || !fs || !programm) return null;
  gl.attachShader(programm, vs);
  gl.attachShader(programm, fs);
  gl.linkProgram(programm);
  if (!gl.getProgramParameter(programm, gl.LINK_STATUS)) {
    console.error("[welle] Programm:", gl.getProgramInfoLog(programm));
    return null;
  }
  gl.useProgram(programm);

  const puffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, puffer);
  gl.bufferData(gl.ARRAY_BUFFER, ECKEN, gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(programm, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const u = (name: string) => gl.getUniformLocation(programm, name);
  const orte = {
    a: u("uA"),
    b: u("uB"),
    misch: u("uMisch"),
    sicht: u("uSicht"),
    versatz: u("uVersatz"),
    ton: u("uTon"),
    tonKraft: u("uTonKraft"),
    dunkel: u("uDunkel"),
    zeit: u("uZeit"),
    korn: u("uKorn"),
    maus: u("uMaus"),
    ringe: u("uRinge"),
    aufloesung: u("uAufloesung"),
  };
  gl.uniform1i(orte.a, 0);
  gl.uniform1i(orte.b, 1);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

  // Zwei Plätze für Bilder. Beim Weiterfahren wandert das Bild von B nach A, und nur das neue
  // wird hochgeladen — ein Bild je Schritt statt zwei.
  const plaetze = [0, 1].map(() => {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { tex, index: -1 };
  });
  const platzFuer = (index: number, bild: HTMLImageElement, behalte: number): number => {
    const da = plaetze.findIndex((p) => p.index === index);
    if (da >= 0) return da;
    const frei = plaetze.findIndex((p) => p.index !== behalte);
    gl.bindTexture(gl.TEXTURE_2D, plaetze[frei].tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, bild);
    plaetze[frei].index = index;
    return frei;
  };

  return {
    groesse(b, h) {
      gl.viewport(0, 0, b, h);
    },
    zeichne(z) {
      const pa = platzFuer(z.ia, z.a, z.ib);
      const pb = z.ia === z.ib ? pa : platzFuer(z.ib, z.b, z.ia);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, plaetze[pa].tex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, plaetze[pb].tex);
      gl.uniform1f(orte.misch, z.misch);
      gl.uniform2f(orte.sicht, z.sicht[0], z.sicht[1]);
      gl.uniform2f(orte.versatz, z.versatz[0], z.versatz[1]);
      gl.uniform3f(orte.ton, z.ton[0], z.ton[1], z.ton[2]);
      gl.uniform1f(orte.tonKraft, z.tonKraft);
      gl.uniform1f(orte.dunkel, z.dunkel);
      gl.uniform1f(orte.zeit, z.zeit);
      gl.uniform1f(orte.korn, z.korn);
      gl.uniform2f(orte.maus, z.maus[0], z.maus[1]);
      gl.uniform1f(orte.ringe, z.ringe);
      gl.uniform2f(orte.aufloesung, z.aufloesung[0], z.aufloesung[1]);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    },
    destroy() {
      for (const p of plaetze) gl.deleteTexture(p.tex);
      gl.deleteBuffer(puffer);
      gl.deleteProgram(programm);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}

// ---------------------------------------------------------------------------
// 2D — ohne WebGL dasselbe Bild, ohne Korn und Ringe
// ---------------------------------------------------------------------------

function leinwandZeichner(canvas: HTMLCanvasElement): Zeichner {
  const ctx = canvas.getContext("2d");
  return {
    groesse() {},
    zeichne(z) {
      if (!ctx) return;
      const b = canvas.width;
      const h = canvas.height;
      const male = (bild: HTMLImageElement, alpha: number): void => {
        const sb = bild.naturalWidth * z.sicht[0];
        const sh = bild.naturalHeight * z.sicht[1];
        const sx = (bild.naturalWidth - sb) / 2 + z.versatz[0] * bild.naturalWidth;
        const sy = (bild.naturalHeight - sh) / 2 - z.versatz[1] * bild.naturalHeight;
        ctx.globalAlpha = alpha;
        ctx.drawImage(bild, sx, sy, sb, sh, 0, 0, b, h);
      };
      male(z.a, 1);
      if (z.misch > 0) male(z.b, z.misch);
      ctx.globalAlpha = 1;
      const [r, g, bl] = z.ton.map((x) => Math.round(x * 255));
      ctx.fillStyle = `rgba(${r}, ${g}, ${bl}, ${z.tonKraft * 0.18})`;
      ctx.fillRect(0, 0, b, h);
      ctx.fillStyle = `rgba(0, 0, 0, ${z.dunkel})`;
      ctx.fillRect(0, 0, b, h);
    },
    destroy() {},
  };
}
