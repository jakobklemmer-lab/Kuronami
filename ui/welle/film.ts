import {
  begrenze,
  bildIndex,
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
 * **Der Film bewegt sich nur beim Wechsel des Bereichs.** Dann fährt die Kamera an den Ort des
 * neuen Bereichs (`stationen.ts`); sonst steht das Bild. Bis zum 2026-09-26 folgte die Kamera
 * außerdem der Maus, zog Ringe hinter ihr her, das Korn flimmerte mit 24 Bildern je Sekunde, und
 * Scrollen fuhr den Film hinaus. Jakob: „bewegt sich fast schon zu viel … für den Sinn und Zweck
 * einfach too much." Das ist weg. Die Fahrt beim Wechsel blieb — eine Überblendung an ihrer
 * Stelle war „sehr sehr unflüssig", und Jakob wollte sie ausdrücklich behalten. Im Stand bewegt
 * sich so vor allem einer: Kuro.
 *
 * Gezeichnet wird in WebGL, weil ein Shader drei Dinge in einem Zug kann: zwei Nachbarbilder
 * mischen (flüssig auch zwischen den Bildern), **Kuros Licht** schwach in den Film legen (die
 * Farbe seines Zustands, `zustand.ts`) und ein feines, stehendes Filmkorn. Ohne WebGL zeichnet
 * eine 2D-Leinwand dasselbe ohne Korn.
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
  /**
   * Schärfere Fassungen der Bilder, an denen der Film stillsteht (die Orte der Bereiche).
   *
   * Die Fahrt läuft über die leichten Bilder — in der Bewegung sieht niemand ihre Unschärfe, und
   * 121 große Bilder hielte kein Speicher entpackt vor. Steht der Film, tritt die scharfe Fassung
   * an ihre Stelle. Anlass: auf Jakobs UWQHD-Schirm (3440 px breit) wurden die 1920er-Bilder fast
   * aufs Doppelte gestreckt und waren „sehr unscharf".
   */
  scharf?: { ordner: string; bilder: readonly number[] };
}

export interface Film {
  /** Fährt in einem Zug an einen Ort — für den Wechsel des Bereichs. */
  fahre(ort: number): void;
  /** Kuros Licht: Farbe als `#rrggbb` und wie stark sie den Film färbt. */
  setzeTon(farbe: string, staerke: number): void;
  /** Wie weit der Film zurücktritt, 0 (ganz da) bis 1 (schwarz). */
  setzeDunkel(wert: number): void;
  destroy(): void;
}

/** Wie lange die scharfe Fassung beim Ankommen über das leichte Bild blendet. */
const SCHAERFE_MS = 250;

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
uniform float uKorn;
uniform vec2 uAufloesung;
varying vec2 vUv;

float zufall(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec2 uv = (vUv - 0.5) * uSicht + 0.5 + uVersatz;

  vec3 farbe = mix(texture2D(uA, uv).rgb, texture2D(uB, uv).rgb, uMisch);

  // Kuros Licht färbt die hellen Stellen — Laternen, Himmel, Wasser —, nicht das Schwarz.
  float hell = dot(farbe, vec3(0.299, 0.587, 0.114));
  vec3 getoent = farbe * (0.55 + uTon * 0.9);
  farbe = mix(farbe, getoent, uTonKraft * smoothstep(0.04, 0.65, hell));

  vec2 q = vUv - 0.5;
  float vignette = smoothstep(0.95, 0.25, length(q * vec2(1.05, 1.3)));
  farbe *= mix(0.5, 1.0, vignette);
  farbe *= 1.0 - uDunkel;

  // Das Korn steht: es gibt dem Bild Stoff, flimmert aber nicht.
  float korn = zufall(vUv * uAufloesung) - 0.5;
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
  korn: number;
  aufloesung: [number, number];
}

export function mountFilm(canvas: HTMLCanvasElement, opt: FilmOptionen): Film {
  const ruhig = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const grob = globalThis.matchMedia?.("(pointer: coarse)").matches ?? false;
  const n = opt.anzahl;
  const bilder: Array<HTMLImageElement | null> = new Array(n).fill(null);
  const geladen: boolean[] = new Array(n).fill(false);

  const scharfeBilder = new Map<number, HTMLImageElement>();
  const scharfDa = new Set(opt.scharf?.bilder ?? []);
  /**
   * Ein Ort mit scharfer Fassung wird genau auf sein Bild gelegt. Sonst stünde der Film zwischen
   * zwei Bildern, und beim Tausch gegen das scharfe rückte die Kamera um einen Bruchteil.
   */
  const aufBild = (wert: number): number => {
    const i = bildIndex(wert, n);
    return scharfDa.has(i) ? i / (n - 1) : begrenze(wert);
  };

  /** Seit wann die scharfe Fassung des Standbilds einblendet (Bildzeit), oder `null`. */
  let scharfSeit: number | null = null;
  let letzteSchaerfe = 0;

  let ort = aufBild(opt.start ?? 0);
  let ziel = ort;
  let fahrt: { von: number; nach: number; beginn: number; dauer: number } | null = null;
  let ton: [number, number, number] = hexZuRgb("#6d90ff");
  let tonZiel = ton;
  let tonKraft = 0.1;
  let tonKraftZiel = 0.1;
  let dunkel = 0;
  let dunkelZiel = 0;
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

  // Die scharfen Fassungen, eine nach der anderen, die des Startorts zuerst. Scheitert eine, bleibt
  // an diesem Ort die leichte stehen — unschärfer, aber da.
  const scharfeReihe = [...scharfDa].sort(
    (x, y) => Math.abs(x - bildIndex(ort, n)) - Math.abs(y - bildIndex(ort, n)),
  );
  const ladeScharf = (k: number): void => {
    const i = scharfeReihe[k];
    if (weg || i === undefined || !opt.scharf) return;
    const bild = new Image();
    bild.decoding = "async";
    bild.src = `${opt.scharf.ordner}f${String(i + 1).padStart(3, "0")}.webp`;
    bild
      .decode()
      .then(() => {
        if (weg) return;
        scharfeBilder.set(i, bild);
        neuZeichnen = true;
      })
      .catch((error: unknown) => console.error(`[welle] Scharfes Bild ${bild.src} fehlt:`, error))
      .finally(() => ladeScharf(k + 1));
  };
  ladeScharf(0);

  // ---------------------------------------------------------------- Größe
  const passeAn = (): void => {
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
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

  // ---------------------------------------------------------------- Schleife
  let letzte = performance.now();
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

    // Im Stand, genau auf einem Bild mit scharfer Fassung, blendet diese in einer Viertelsekunde
    // über das leichte Bild. Ein harter Tausch sah beim Ankommen aus wie ein Nachfokussieren.
    const paar = bildpaar(ort, n);
    const scharf = !fahrt && ort === ziel && paar.t === 0 ? scharfeBilder.get(paar.a) : undefined;
    if (!scharf) scharfSeit = null;
    else scharfSeit ??= t;
    const schaerfe = scharf && scharfSeit !== null ? begrenze((t - scharfSeit) / SCHAERFE_MS) : 0;
    // Auch der letzte Schritt (ganz scharf) muss noch gezeichnet werden.
    if (schaerfe !== letzteSchaerfe) bewegt = true;
    letzteSchaerfe = schaerfe;

    // Nichts hat sich geändert: nichts zeichnen. Ein stehender Film kostet so keine Grafik.
    if (!bewegt) return;

    // Die Kennung der scharfen Fassung liegt hinter denen der leichten Bilder, damit der Zeichner
    // die beiden nicht verwechselt.
    const leichtA = naechstesGeladenes(paar.a, geladen);
    const leichtB = naechstesGeladenes(paar.b, geladen);
    let ia: number | null;
    let ib: number | null;
    let misch: number;
    if (scharf && (schaerfe >= 1 || leichtA === null)) {
      ia = ib = n + paar.a;
      misch = 0;
    } else if (scharf) {
      ia = leichtA;
      ib = n + paar.a;
      misch = schaerfe;
    } else {
      ia = leichtA;
      ib = leichtB;
      misch = paar.t;
    }
    if (ia === null || ib === null) return;
    const a = ia >= n ? scharf : bilder[ia];
    const b = ib >= n ? scharf : bilder[ib];
    if (!a || !b) return;

    const [sx, sy] = deckung(canvas.width, canvas.height, opt.bildB, opt.bildH);
    const sicht: [number, number] = [sx, sy];
    const versatz: [number, number] = [0, 0];
    zeichner.zeichne({
      a,
      b,
      ia,
      ib,
      misch: ia === ib ? 0 : misch,
      sicht,
      versatz,
      ton,
      tonKraft,
      dunkel,
      korn: grob ? 0.02 : 0.03,
      aufloesung: [canvas.width, canvas.height],
    });
  };
  schleife = requestAnimationFrame(tick);

  return {
    fahre(wert) {
      const nach = aufBild(wert);
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
    korn: u("uKorn"),
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
      gl.uniform1f(orte.korn, z.korn);
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
// 2D — ohne WebGL dasselbe Bild, ohne Korn
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
