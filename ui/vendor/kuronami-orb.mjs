/*!
 * KuronamiOrb – interaktives 3D-Element für das Kuronami-Dashboard.
 *
 * Ein lebendiges Partikelwesen mit dunklem Kern (黒波, „schwarze Welle“).
 * Es zeigt Zustände (idle, listening, thinking, speaking, working, attention,
 * error, offline), reagiert auf Maus, Klick, Ziehen, Tippen und Stimme und
 * lässt Sub-Agenten als eigene Satelliten aus sich herauswachsen, die nach
 * getaner Arbeit wieder zurückfließen.
 *
 * Abhängigkeit: three (r150+). Kein Build-Schritt nötig.
 *   import { KuronamiOrb } from './kuronami-orb.js';
 *   const orb = new KuronamiOrb(document.querySelector('#orb'));
 *
 * In Kuronami seit 2026-09-26 (S47), unverändert aus Jakobs Orb-Entwurf übernommen — bis auf
 * den Import unten: die Oberfläche lädt ihre Module ohne Bundler und ohne Importmap, ein bloßer
 * Paketname wäre kein gültiger Browser-Import. three liegt gepinnt daneben (r170, identisch mit
 * `three@0.170.0/build/three.module.min.js` aus der npm-Registry). Die Anbindung an Kuros
 * Ereignisse steckt in `ui/praesenz/sphaere.ts`, nicht hier.
 */
import * as THREE from './three.module.min.mjs';

const MAX_SLOTS = 8;
const TAU = Math.PI * 2;
const BODY_R = 0.97; // Radius des dunklen Kerns (Glaskante liegt bei 1.0)

// ---------------------------------------------------------------------------
// Zustände: Zielwerte, zwischen denen weich überblendet wird
// ---------------------------------------------------------------------------
const BASE = {
  colA: '#8db4ff', // Grundfarbe der Partikel
  colB: '#eef4ff', // heiße Kerne / Highlights
  colC: '#4a64d6', // Tiefe, Schattenseite
  glow: '#6d90ff', // Halo
  bright: 1.0,
  halo: 0.5,
  rim: 1.0, // Glaskante
  heart: 0.25, // Glühen im dunklen Kern
  flow: 0.05, // Oberflächenströmung (rad/s)
  bands: 0, // Bänder mit gegenläufiger Rotation (Denken)
  swirl: 0,
  noiseAmp: 0.035,
  noiseFreq: 1.5,
  noiseSpeed: 0.1,
  swell: 0.03, // große, langsame Dünung – die „Welle“ in Kuronami
  swellSpeed: 0.35,
  wave: 0, // Reaktion auf Audio-Pegel
  stream: 0.1, // Gedankenströme im Inneren
  streamSpeed: 0.04,
  ring: 0, // Arbeitsringe (Tools)
  ringSpeed: 0.5,
  lean: 0, // Vorderseite lehnt sich zum Betrachter
  contract: 0,
  jitter: 0,
  spin: 0.05,
  breathe: 0.012,
  breatheRate: 0.2,
  sparkle: 0.2,
};

const STATES = {
  idle: {},
  listening: {
    colA: '#7fd4ff', colB: '#f0fcff', colC: '#3c86dc', glow: '#5fc0ff',
    bright: 1.15, halo: 0.75, rim: 1.2, heart: 0.35, flow: 0.035, noiseAmp: 0.03, swell: 0.02,
    wave: 0.24, lean: 0.12, spin: 0.02, breathe: 0.008, sparkle: 0.3,
  },
  thinking: {
    colA: '#9d8dff', colB: '#f2edff', colC: '#5549cf', glow: '#8878ff',
    bright: 1.08, halo: 0.7, heart: 0.4, flow: 0.16, bands: 1, swirl: 0.9,
    noiseAmp: 0.07, noiseFreq: 2.1, noiseSpeed: 0.45, swell: 0.015,
    stream: 1, streamSpeed: 0.3, spin: 0.12, breathe: 0.025, breatheRate: 0.45, sparkle: 1,
  },
  speaking: {
    colA: '#a8c6ff', colB: '#ffffff', colC: '#5b7de6', glow: '#84a6ff',
    bright: 1.22, halo: 0.85, rim: 1.25, heart: 0.55, flow: 0.07, noiseAmp: 0.03, swell: 0.025,
    wave: 0.32, stream: 0.3, streamSpeed: 0.12, spin: 0.06, sparkle: 0.5,
  },
  working: {
    colA: '#6fe0cf', colB: '#e8fffb', colC: '#2d8c9c', glow: '#56d2c2',
    bright: 1.02, halo: 0.6, heart: 0.3, flow: 0.1, noiseAmp: 0.045,
    ring: 1, ringSpeed: 1.0, stream: 0.45, streamSpeed: 0.16, spin: 0.08, sparkle: 0.4,
  },
  attention: {
    colA: '#ffc978', colB: '#fff4e0', colC: '#d8843e', glow: '#ffb35c',
    bright: 1.1, halo: 0.75, heart: 0.4, flow: 0.05, lean: 0.08, sparkle: 0.4,
  },
  error: {
    colA: '#ff6f7e', colB: '#ffe0e4', colC: '#b6364e', glow: '#ff5c70',
    bright: 1.0, halo: 0.65, heart: 0.3, noiseAmp: 0.08, noiseSpeed: 1.1, jitter: 0.02, spin: 0.03, sparkle: 0.3,
  },
  offline: {
    colA: '#5b6680', colB: '#9aa4b8', colC: '#333c52', glow: '#46506a',
    bright: 0.42, halo: 0.12, rim: 0.35, heart: 0.05, flow: 0.012, noiseAmp: 0.02, noiseSpeed: 0.03, swell: 0.01,
    stream: 0, spin: 0.01, contract: 0.07, breathe: 0.004, sparkle: 0,
  },
};

const COLOR_KEYS = ['colA', 'colB', 'colC', 'glow'];
const NUM_KEYS = Object.keys(BASE).filter((k) => typeof BASE[k] === 'number');

const DEFAULT_LABELS = {
  idle: null, // null → tagline
  listening: 'Listening…',
  thinking: 'Thinking…',
  speaking: 'Speaking…',
  working: 'Working…',
  attention: 'Needs your input',
  error: 'Something went wrong',
  offline: 'Offline',
  agentCount: (n) => (n === 1 ? '1 agent' : `${n} agents`),
  background: (n) => `${n === 1 ? '1 agent' : `${n} agents`} working in the background`,
  more: (n) => `+${n} more`,
};

const AGENT_COLORS = {
  explore: '#6fe6d0',
  plan: '#b7a0ff',
  'general-purpose': '#ffc97e',
  'claude-code-guide': '#ff9fc6',
  'statusline-setup': '#8fcfff',
};
const AGENT_PALETTE = ['#6fe6d0', '#b7a0ff', '#ffc97e', '#ff9fc6', '#8fcfff', '#b4f08a', '#ffa988', '#d9b8ff'];
const ERROR_RGB = hexToRgb('#ff5f72');
const STOPPED_RGB = hexToRgb('#8a93a8');

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------
function clamp(v, a = 0, b = 1) {
  return Math.min(b, Math.max(a, v));
}
function smoothstep(a, b, v) {
  const t = clamp((v - a) / (b - a));
  return t * t * (3 - 2 * t);
}
function hexToRgb(hex) {
  let h = String(hex).replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
export function agentColor(type = '') {
  const key = String(type).toLowerCase();
  return AGENT_COLORS[key] || AGENT_PALETTE[hashString(key) % AGENT_PALETTE.length];
}
export function prettyAgentName(type = '') {
  const bare = String(type || 'agent').split(':').pop();
  if (bare === 'general-purpose') return 'General';
  return bare
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}
function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function angleDelta(from, to) {
  return ((((to - from) % TAU) + TAU * 1.5) % TAU) - TAU / 2;
}

// ---------------------------------------------------------------------------
// Shader
// ---------------------------------------------------------------------------
// 3D-Simplex-Noise: Ian McEwan, Ashima Arts / Stefan Gustavson (MIT-Lizenz)
const NOISE_GLSL = /* glsl */ `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
    i.z + vec4(0.0, i1.z, i2.z, 1.0)) +
    i.y + vec4(0.0, i1.y, i2.y, 1.0)) +
    i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}`;

const PARTICLE_VS = /* glsl */ `
attribute vec4 aRand;
attribute float aKind;   // 0 Wolke · 1 Gedankenstrom · 2 Arbeitsring · 3 Sub-Agent-Pool
attribute float aIndex;

uniform float uTime;
uniform float uIntro;
uniform float uFlow;
uniform float uSwirl;
uniform float uStreamPhase;
uniform float uRingPhase;
uniform float uNoiseTime;
uniform float uSwellPhase;
uniform float uWavePhase;
uniform mat3 uSpin;
uniform float uScale;
uniform float uNoiseAmp;
uniform float uNoiseFreq;
uniform float uSwell;
uniform float uWave;
uniform float uLevel;
uniform vec3 uAudio;
uniform float uStream;
uniform float uRing;
uniform float uLean;
uniform float uContract;
uniform float uJitter;
uniform float uSparkle;
uniform float uBright;
uniform float uGain;
uniform vec3 uPointerDir;
uniform float uPointerAmt;
uniform vec3 uShockDir;
uniform float uShockT;
uniform float uShockAmp;
uniform vec3 uSlotPos[MAX_SLOTS];
uniform vec3 uSlotCol[MAX_SLOTS];
uniform vec4 uSlotState[MAX_SLOTS]; // x: Ablösung 0..1 · y: Aktivität · z: Sichtbarkeit · w: Abschluss-Glühen
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uColC;
uniform float uPointScale;
uniform float uSize;
uniform vec3 uCenterView;
uniform float uBodyR;
uniform float uAbsorb;

varying vec3 vColor;
varying float vHot;

#define TAU 6.28318530718
${NOISE_GLSL}

vec3 rotY(vec3 p, float a) {
  float c = cos(a), s = sin(a);
  return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}
vec3 rotAxis(vec3 p, vec3 k, float a) {
  float c = cos(a), s = sin(a);
  return p * c + cross(k, p) * s + k * dot(k, p) * (1.0 - c);
}
vec3 bez(vec3 a, vec3 b, vec3 c, float t) {
  float u = 1.0 - t;
  return u * u * a + 2.0 * u * t * b + t * t * c;
}
float hash11(float n) { return fract(sin(n) * 43758.5453123); }
// Tennisball-Naht: geschlossene Kurve auf der Einheitskugel
vec3 seam(float th, float b) {
  float a = 1.0 - b;
  float c = 2.0 * sqrt(a * b);
  return vec3(a * cos(th) + b * cos(3.0 * th), c * sin(2.0 * th), a * sin(th) - b * sin(3.0 * th));
}

void main() {
  // ---- Ruheposition in der Wolke (jedes Partikel hat eine)
  vec3 d = position;
  float band = sin(d.y * 6.5 + aRand.x * 0.8);
  d = rotY(d, uFlow * (0.55 + 0.45 * aRand.y) + uSwirl * band);

  float n = snoise(d * uNoiseFreq + vec3(0.0, uNoiseTime, uNoiseTime * 0.6));
  // Leuchtende Wellenlinien wandern über die Oberfläche – die „Welle“ in Kuronami
  float ph1 = dot(d, vec3(0.62, 0.36, 0.70)) * 9.0 - uSwellPhase * 2.6 + n * 2.2;
  float ph2 = dot(d, vec3(-0.52, 0.80, -0.30)) * 7.0 + uSwellPhase * 1.9 + n * 1.6;
  float crest = pow(0.5 + 0.5 * sin(ph1), 10.0) * 0.95 + pow(0.5 + 0.5 * sin(ph2), 12.0) * 0.65;
  float wv = sin(d.y * 6.0 + uWavePhase * 1.7) * sin(d.x * 5.0 - uWavePhase * 1.3) * 0.6
           + sin(d.z * 9.0 + uWavePhase * 2.3) * 0.4;
  float audio = 0.3 * uLevel + 0.7 * uAudio.y;
  float r = 0.97 - aRand.z * aRand.z * aRand.z * 0.2;
  r *= 1.0 + n * uNoiseAmp + (crest - 0.2) * uSwell * 0.8 + wv * uWave * audio;
  r *= uScale * (1.0 - uContract);
  vec3 p = uSpin * (d * r);
  vec3 pn = normalize(p);
  // Randlicht: tangentiale Partikel (Silhouette) leuchten stärker – wie eine Glaskante
  vec3 nv = normalize(mat3(modelViewMatrix) * pn);
  float rim = pow(1.0 - abs(nv.z), 2.2);

  // Maus: die Oberfläche wölbt sich dem Zeiger entgegen
  float pd = max(dot(pn, uPointerDir), 0.0);
  float reach = pow(pd, 12.0) * uPointerAmt;
  p += pn * reach * 0.13;
  // Aufmerksamkeit: Vorderseite lehnt sich zum Betrachter
  p += pn * pow(max(pn.z, 0.0), 3.0) * uLean;
  // Schockwelle (Klick, Aufwachen, Rufen)
  float sa = acos(clamp(dot(pn, uShockDir), -1.0, 1.0));
  float shock = exp(-pow((sa - uShockT * 2.6) * 4.0, 2.0)) * exp(-uShockT * 1.5) * uShockAmp;
  p += pn * shock * 0.17;

  float hot = shock * 1.4 + reach * 1.2 + crest * crest * 0.35 * step(0.55, aRand.y);
  float tw = pow(0.5 + 0.5 * sin(uTime * (1.3 + aRand.x * 3.2) + aRand.y * 40.0), 14.0);
  hot += step(1.0 - (0.02 + 0.1 * uSparkle), aRand.w) * tw * (0.8 + uSparkle);
  vec3 col = mix(uColC, uColA, clamp(0.15 + 0.85 * crest + n * 0.2 + pn.y * 0.1, 0.0, 1.0));
  float alpha = (0.25 + 0.45 * aRand.y) * (0.14 + crest * 3.2 + max(wv, 0.0) * audio * 0.9) * (1.0 + rim * 0.8);
  alpha *= 1.0 - 0.4 * uStream; // beim Denken tritt die Hülle zurück, die Ströme innen nach vorn
  float size = 0.6 + 0.9 * aRand.w * aRand.w * aRand.w;

  if (aKind > 0.5 && aKind < 1.5) {
    // ---- Gedankenströme im Inneren
    float k = aIndex;
    float dir = mod(k, 2.0) < 0.5 ? 1.0 : -1.0;
    float t = fract(aRand.x + uStreamPhase * (0.7 + 0.25 * k) * dir);
    float th = t * TAU;
    vec3 s = seam(th, 0.22 + 0.08 * k);
    s = rotAxis(s, normalize(vec3(0.35 + 0.6 * k, 1.0, 0.25 - 0.3 * k)), 1.2 * k + 0.4);
    s = s * (0.58 + 0.05 * k) + (aRand.yzw - 0.5) * 0.05;
    s = uSpin * (s * uScale);
    float e = clamp(uStream * 1.4 - aRand.w * 0.4, 0.0, 1.0);
    e = e * e * (3.0 - 2.0 * e);
    p = mix(p, s, e);
    float head = pow(0.5 + 0.5 * sin(th * 3.0 - uStreamPhase * 14.0 * dir + k * 2.1), 10.0);
    hot += head * e * 1.4;
    col = mix(col, mix(uColA, uColB, head * 0.8), e);
    alpha = mix(alpha, (0.9 + 2.6 * head) * (0.6 + 0.4 * aRand.y) * uStream, e);
  } else if (aKind > 1.5 && aKind < 2.5) {
    // ---- Arbeitsringe (Tools laufen)
    float k = aIndex;
    float R = mix(1.34, 1.47, k);
    float seg = 30.0 + 10.0 * k;
    float a = (floor(aRand.x * seg) + fract(aRand.x * seg) * 0.6) / seg * TAU;
    a += uRingPhase * (k < 0.5 ? 1.0 : -0.75);
    vec3 nrm = normalize(k < 0.5 ? vec3(0.15, 0.95, 0.3) : vec3(-0.6, 0.7, 0.4));
    vec3 u = normalize(cross(nrm, vec3(0.0, 0.0, 1.0)));
    vec3 v = cross(nrm, u);
    vec3 rp = (u * cos(a) + v * sin(a)) * R * uScale + nrm * (aRand.y - 0.5) * 0.02 + (aRand.zwy - 0.5) * 0.016;
    float e = clamp(uRing * 1.5 - aRand.w * 0.5, 0.0, 1.0);
    e = e * e * (3.0 - 2.0 * e);
    vec3 mid = normalize(p + rp + vec3(0.001)) * 1.3;
    p = bez(p, mid, rp, e);
    float tick = pow(0.5 + 0.5 * sin(a * 2.0 - uRingPhase * 3.0), 18.0);
    hot += tick * e * 0.7;
    col = mix(col, mix(uColA, uColB, 0.3 + tick * 0.6), e);
    alpha = mix(alpha, 0.55 + 0.45 * aRand.y, e);
  } else if (aKind > 2.5) {
    // ---- Sub-Agenten: Partikel lösen sich und formen einen Satelliten
    int si = int(aIndex + 0.5);
    vec4 st = uSlotState[si];
    float m = st.x;
    if (m > 0.0005) {
      vec3 sp = uSlotPos[si];
      vec3 sc = uSlotCol[si];
      vec3 sn = normalize(sp);
      float act = st.y;
      vec3 sd = rotY(position, uTime * (0.6 + 0.6 * aRand.y) + aRand.x * TAU);
      // Mini-Kugel: 60 % Hülle, 40 % leuchtender Kern
      float shell = step(aRand.z, 0.6);
      float sr = 0.18 * mix((aRand.z - 0.6) / 0.4 * 0.6, 0.84 + 0.16 * aRand.z / 0.6, shell);
      sr *= 1.0 + 0.2 * act * sin(uTime * 12.0 + aRand.x * TAU) + st.w * 0.5;
      vec3 satP = sp + sd * sr;
      vec3 gate = sn * 1.08 + (aRand.yzw - 0.5) * 0.2;
      float t = clamp(m * 1.6 - aRand.w * 0.6, 0.0, 1.0);
      t = t * t * (3.0 - 2.0 * t);
      vec3 bp = bez(p, gate, satP, t);
      // Kuriere pendeln entlang der Verbindung
      float cw = step(aRand.x, 0.2) * smoothstep(0.92, 1.0, m);
      float ct = fract(aRand.y + uTime * (0.2 + 0.22 * aRand.z) * (1.0 + act * 2.0));
      float cpos = aRand.z > 0.5 ? ct : 1.0 - ct;
      vec3 c0 = sn * 1.02 * uScale;
      vec3 cm = mix(c0, sp, 0.5) + sn * 0.1 + vec3(0.0, 0.12, 0.0);
      vec3 cp = bez(c0, cm, sp, cpos) + (aRand.zwy - 0.5) * 0.03;
      p = mix(bp, cp, cw);
      float along = mix(t, cpos, cw);
      col = mix(col, mix(sc, vec3(1.0), (1.0 - shell) * 0.35), clamp(along * 1.3, 0.0, 1.0));
      hot += (st.w * 1.3 + act * 0.6 * step(0.75, aRand.y)) * t;
      float satA = (0.7 + 0.9 * aRand.y) * (1.0 + (1.0 - shell) * 0.8 + act * 0.8 + st.w * 1.5) * st.z;
      alpha = mix(alpha, satA, t);
      alpha *= mix(1.0, (0.2 + 0.8 * sin(3.14159 * cpos)) * 1.4, cw);
      size *= mix(1.0, 0.9, t);
    }
  }

  // Intro: Partikel sammeln sich beim Start
  float intro = clamp(uIntro * 1.35 - aRand.w * 0.35, 0.0, 1.0);
  intro = 1.0 - pow(1.0 - intro, 3.0);
  vec3 scatter = normalize(position + (aRand.xyz - 0.5) * 0.6) * (2.4 + aRand.x * 2.4);
  p = mix(scatter, p, intro);
  alpha *= intro;

  // Fehler: nervöses Zittern
  float jt = floor(uTime * 22.0);
  p += (vec3(hash11(jt + aRand.x * 91.7), hash11(jt + aRand.y * 57.3), hash11(jt + aRand.z * 33.1)) - 0.5)
       * uJitter * step(0.6, aRand.w);

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  // Verdeckung durch den dunklen Kern (gleiche Absorption wie im Hintergrund-Shader)
  vec3 rel = mv.xyz - uCenterView;
  float rho = length(rel.xy);
  float bodyR = uBodyR * uScale;
  float occl = 1.0;
  if (rho < bodyR) {
    float zf = sqrt(bodyR * bodyR - rho * rho);
    occl = exp(-uAbsorb * clamp(zf - rel.z, 0.0, 2.0 * zf));
  }

  float ps = uSize * size * uPointScale / -mv.z;
  gl_PointSize = clamp(ps, 1.5, 32.0);
  float fade = clamp(ps / 1.5, 0.25, 1.0);
  vColor = col * alpha * uBright * uGain * occl * fade;
  vHot = hot * alpha * uGain * occl * fade;
}`;

const PARTICLE_FS = /* glsl */ `
uniform vec3 uColB;
varying vec3 vColor;
varying float vHot;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d2 = dot(c, c);
  if (d2 > 1.0) discard;
  float soft = exp(-d2 * 4.2);
  float core = exp(-d2 * 14.0);
  vec3 col = vColor * soft + uColB * core * vHot * 0.9;
  gl_FragColor = vec4(col, max(col.r, max(col.g, col.b)));
}`;

const BACKDROP_VS = /* glsl */ `
varying vec2 vP;
void main() {
  vP = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const BACKDROP_FS = /* glsl */ `
uniform float uR;
uniform float uAbsorb;
uniform float uBodyAlpha;
uniform vec3 uBodyCol;
uniform vec3 uGlowCol;
uniform float uHalo;
uniform float uHeart;
uniform vec3 uHeartCol;
uniform float uShockT;
uniform float uShockAmp;
uniform float uFlash;
uniform vec3 uFlashCol;
uniform float uLevel;
uniform float uShellR;
uniform float uRim;
uniform vec4 uSatGlow[MAX_SLOTS]; // xy: Position auf der Ebene · z: Radius · w: Stärke
uniform vec3 uSatCol[MAX_SLOTS];
varying vec2 vP;
void main() {
  float r = length(vP);
  float x = r / uR;
  // Glaskante: dünner Lichtring, Reflexbogen oben links, Lichtpunkt unten
  vec2 dir2 = vP / max(r, 1e-4);
  float edge = exp(-pow((r - uShellR) * 95.0, 2.0)) * (0.45 + 0.55 * smoothstep(-0.8, 0.9, dot(dir2, normalize(vec2(0.8, -0.45)))));
  float innerGlow = smoothstep(0.7, 1.0, r / uShellR) * (1.0 - smoothstep(0.995, 1.0, r / uShellR)) * 0.1;
  float arc = smoothstep(0.55, 1.0, dot(dir2, normalize(vec2(-0.55, 0.83)))) * exp(-pow((r - uShellR * 0.93) * 20.0, 2.0));
  float caustic = exp(-pow(length(vP - vec2(0.03, -uShellR * 0.9)) * 13.0, 2.0));
  float zf = sqrt(max(0.0, 1.0 - x * x)) * uR;
  // dunkler Kern: Absorption proportional zur durchquerten Dicke
  float bodyA = (1.0 - exp(-uAbsorb * 2.0 * zf)) * uBodyAlpha;
  bodyA *= 1.0 - smoothstep(0.97, 1.0, x);
  vec3 nrm = normalize(vec3(vP, zf + 1e-4));
  float lit = clamp(dot(nrm, normalize(vec3(-0.45, 0.7, 0.55))), 0.0, 1.0);
  vec3 body = uBodyCol * (0.7 + 0.6 * lit);
  // Glühen im Inneren
  vec3 heart = uHeartCol * uHeart * exp(-x * x * 3.2) * (0.22 + 0.25 * uLevel);
  // Halo außerhalb der Silhouette
  float o = max(r - uR * 1.08, 0.0);
  float halo = exp(-o * 2.4) * 0.55 + exp(-o * 7.5) * 0.45;
  halo *= smoothstep(uR * 0.6, uR * 1.1, r);
  vec3 glow = uGlowCol * halo * uHalo * 0.5;
  glow += uFlashCol * uFlash * exp(-o * 3.0) * smoothstep(uR * 0.3, uR * 1.1, r) * 0.55;
  float ring = exp(-pow((r - uR * (1.1 + uShockT * 1.5)) * 6.0, 2.0)) * exp(-uShockT * 2.0) * uShockAmp;
  glow += uGlowCol * ring * 0.28;
  // Aura der Sub-Agenten-Satelliten
  for (int i = 0; i < MAX_SLOTS; i++) {
    vec4 s = uSatGlow[i];
    if (s.w <= 0.0) continue;
    float dd = length(vP - s.xy) / s.z;
    glow += uSatCol[i] * (exp(-dd * dd * 2.2) * 0.2 + exp(-dd * dd * 9.0) * 0.18) * s.w;
  }
  vec3 glass = mix(uGlowCol, vec3(0.9, 0.95, 1.0), 0.35) * edge * 0.62 + uGlowCol * innerGlow
             + vec3(0.86, 0.92, 1.0) * arc * 0.16 + mix(uGlowCol, vec3(1.0), 0.4) * caustic * 0.32;
  vec3 col = body * bodyA + heart + glow + glass * uRim;
  gl_FragColor = vec4(col, max(bodyA, max(col.r, max(col.g, col.b))));
}`;

// ---------------------------------------------------------------------------
// Styles (einmalig eingefügt, alle Klassen mit ko- Präfix)
// ---------------------------------------------------------------------------
const CSS = `
.ko-root{position:relative;width:100%;height:100%;min-height:280px;overflow:hidden;color:#e7edff;font-family:inherit;-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent}
.ko-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:pan-y;outline:none}
.ko-root.is-hover .ko-canvas{cursor:pointer}
.ko-root.is-drag .ko-canvas{cursor:grabbing}
.ko-layer{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.ko-tag{position:absolute;left:0;top:0;display:flex;align-items:center;gap:6px;max-width:210px;padding:3px 9px 3px 7px;border-radius:999px;background:rgba(9,13,24,.46);border:1px solid rgba(255,255,255,.07);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);font-size:10.5px;line-height:1.35;letter-spacing:.02em;white-space:nowrap;opacity:0;will-change:transform,opacity;transition:border-color .3s,background .3s}
.ko-tag i{flex:none;width:6px;height:6px;border-radius:50%;background:var(--c);box-shadow:0 0 8px var(--c)}
.ko-tag b{font-weight:500;color:rgba(236,241,255,.93)}
.ko-tag small{overflow:hidden;text-overflow:ellipsis;font-size:10px;color:rgba(178,192,220,.64)}
.ko-tag.is-hover{border-color:var(--c);background:rgba(12,17,30,.7)}
.ko-caption{position:absolute;left:50%;top:70%;transform:translateX(-50%);width:min(92%,440px);text-align:center;pointer-events:none}
.ko-name{font-size:12px;font-weight:500;letter-spacing:.42em;padding-left:.42em;color:rgba(234,240,255,.94)}
.ko-status{margin-top:7px;min-height:1.4em;font-size:11.5px;letter-spacing:.01em;color:rgba(172,186,212,.76);transition:opacity .17s ease}
.ko-status.is-fading{opacity:0}
.ko-agents{display:flex;flex-direction:column;align-items:center;gap:6px;margin-top:14px}
.ko-agent{display:grid;grid-template-columns:10px auto minmax(0,1fr) auto;align-items:center;gap:8px;width:min(100%,340px);padding:6px 11px;border-radius:10px;background:rgba(11,15,27,.42);border:1px solid rgba(255,255,255,.06);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);font-size:11px;text-align:left;transition:opacity .45s ease,transform .45s ease,border-color .3s}
.ko-agent.is-enter{opacity:0;transform:translateY(-4px)}
.ko-agent.is-leave{opacity:0;transform:translateY(4px)}
.ko-agent.is-hover{border-color:var(--c)}
.ko-dot{justify-self:center;width:7px;height:7px;border-radius:50%;background:var(--c);box-shadow:0 0 10px var(--c);animation:ko-pulse 1.6s ease-in-out infinite}
.ko-dot.is-icon{width:auto;height:auto;background:none;box-shadow:none;animation:none;font-size:10.5px;line-height:1;color:var(--c)}
.ko-agent.is-error .ko-dot.is-icon{color:#ff7d8b}
.ko-agent b{font-weight:500;white-space:nowrap;color:rgba(236,241,255,.93)}
.ko-act{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:rgba(172,186,212,.68)}
.ko-agent time{font-variant-numeric:tabular-nums;font-size:10.5px;color:rgba(150,164,190,.56)}
.ko-more{font-size:10.5px;color:rgba(160,174,200,.58)}
@keyframes ko-pulse{0%,100%{opacity:1}50%{opacity:.45}}
@media (prefers-reduced-motion:reduce){.ko-dot{animation:none}}
`;
function injectStyles() {
  if (typeof document === 'undefined' || document.getElementById('ko-styles')) return;
  const style = document.createElement('style');
  style.id = 'ko-styles';
  style.textContent = CSS;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Komponente
// ---------------------------------------------------------------------------
export class KuronamiOrb extends EventTarget {
  static STATES = Object.keys(STATES);

  /**
   * @param {HTMLElement} container  Element, das den Orb aufnimmt (braucht eine Größe)
   * @param {object} [options]
   */
  constructor(container, options = {}) {
    super();
    if (!container) throw new Error('KuronamiOrb: container fehlt');
    this.opts = {
      name: 'KURONAMI',
      tagline: 'Always here. Always working.',
      labels: {},
      caption: true, // Name + Statuszeile unter dem Orb
      agentList: true, // Liste der Sub-Agenten unter der Statuszeile
      agentTags: true, // kleine Namensschilder an den Satelliten
      size: 0.34, // Durchmesser des Kerns als Anteil der kürzeren Container-Seite
      offsetY: 0.06, // Kern etwas über die Mitte schieben (Anteil der Höhe)
      quality: 'high', // 'high' | 'medium' | 'low'
      maxDpr: 2,
      interactive: true, // Hover, Klick, Ziehen
      followPointer: true, // dreht sich leicht zum Mauszeiger (seitenweit)
      drowseAfter: 60, // Sekunden ohne Interaktion bis zum Dösen (0 = aus)
      intro: true,
      minDwell: 280, // ms Mindestdauer pro Zustand gegen Flackern
      maxAgentRows: 5,
      bodyOpacity: 1,
      palette: {}, // z. B. { thinking: { colA: '#...' } }
      ...options,
    };
    this.labels = { ...DEFAULT_LABELS, ...this.opts.labels };
    this.container = container;
    this._reduced = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    this._targets = {};
    for (const name of Object.keys(STATES)) {
      const merged = { ...BASE, ...STATES[name], ...(this.opts.palette[name] || {}) };
      for (const k of COLOR_KEYS) merged[k] = hexToRgb(merged[k]);
      this._targets[name] = merged;
    }
    this._p = { ...this._targets.idle };
    for (const k of COLOR_KEYS) this._p[k] = this._targets.idle[k].slice();

    this._bornAt = performance.now();
    this._state = 'idle';
    this._visual = 'idle';
    this._detail = '';
    this._stateChangedAt = 0;
    this._time = 0;
    this._last = 0;
    this._ph = { flow: 0, swirl: 0, stream: 0, ring: 0, noise: 0, swell: 0, wave: 0 };
    this._orbit = -0.35;
    this._level = 0;
    this._pulse = 0;
    this._extLevel = 0;
    this._extLevelAt = -1e9;
    this._audioBands = new THREE.Vector3();
    this._analysers = new Set();
    this._mediaNodes = new WeakMap();
    this._flash = 0;
    this._flashCol = this._p.glow.slice();
    this._shockT = 10;
    this._speechUntil = 0;
    this._afterSpeech = null;
    this._typingUntil = 0;
    this._lastKeyShock = 0;
    this._inputFocused = false;
    this._lastInteraction = performance.now();
    this._drowsy = false;
    this._nextCall = 0;
    this._visible = true;
    this._dprScale = 1;
    this._perfAcc = 0;
    this._perfN = 0;
    this._runningCount = 0;
    this._agentSeq = 0;
    this._agentOrder = 0;
    this._chipTick = 0;
    this.agentsMap = new Map();
    this._slots = new Array(MAX_SLOTS).fill(null);

    // Interaktion
    this._pointer = new THREE.Vector2(-1e4, -1e4);
    this._pointerIn = false;
    this._ptrAmt = 0;
    this._ptrWorld = new THREE.Vector3(0, 0, 1);
    this._hoverOrb = false;
    this._hoverAgent = null;
    this._down = null;
    this._tilt = new THREE.Vector2();
    this._tiltTarget = new THREE.Vector2();
    this._spinQ = new THREE.Quaternion();
    this._dragVel = new THREE.Vector2();
    this._raycaster = new THREE.Raycaster();
    this._sphere = new THREE.Sphere(new THREE.Vector3(), 1.02);
    this._tmpQ = new THREE.Quaternion();
    this._tmpQ2 = new THREE.Quaternion();
    this._tmpM = new THREE.Matrix4();
    this._tmpV = new THREE.Vector3();
    this._tmpV2 = new THREE.Vector3();
    this._axisY = new THREE.Vector3(0, 1, 0);
    this._axisX = new THREE.Vector3(1, 0, 0);
    this._spinAxis = new THREE.Vector3(0.12, 1, 0.08).normalize();

    this._buildDom();
    this._buildScene();
    this._bindEvents();
    this._resize();
    this._applyStatus(true);
    this._raf = requestAnimationFrame(this._frame);
  }

  // ------------------------------------------------------------ öffentliche API

  /** Aktueller Zustand. */
  get state() {
    return this._state;
  }

  /** Momentaufnahme aller bekannten Sub-Agenten. */
  get agents() {
    return [...this.agentsMap.values()].map(publicAgent);
  }

  /**
   * Zustand setzen: 'idle' | 'listening' | 'thinking' | 'speaking' | 'working' | 'attention' | 'error' | 'offline'
   * @param {string} state
   * @param {{detail?: string, force?: boolean}} [o]  detail = Text für working/attention/error (z. B. "Bash · npm test")
   */
  setState(state, { detail, force = false } = {}) {
    if (!STATES[state]) {
      console.warn(`KuronamiOrb: unbekannter Zustand "${state}"`);
      return;
    }
    if (detail !== undefined) this._detail = detail || '';
    else if (state !== this._state && state !== this._pendingState) this._detail = '';
    const now = performance.now();
    // Nach speak(): idle wartet, bis die (simulierte) Sprachausgabe fertig ist
    if (state === 'idle' && this._speechUntil > now && !force) {
      this._afterSpeech = 'idle';
      return;
    }
    const urgent = force || state === 'error' || state === 'attention';
    const since = now - this._stateChangedAt;
    if (!urgent && state !== this._state && since < this.opts.minDwell) {
      this._pendingState = state;
      clearTimeout(this._dwellTimer);
      this._dwellTimer = setTimeout(() => {
        const s = this._pendingState;
        this._pendingState = null;
        if (s) this._applyState(s);
      }, this.opts.minDwell - since);
      return;
    }
    this._pendingState = null;
    clearTimeout(this._dwellTimer);
    this._applyState(state);
  }

  /** Detailtext ändern (z. B. aktuelles Tool), ohne den Zustand zu wechseln. */
  setDetail(text = '') {
    this._detail = text;
    this._applyStatus();
  }

  setTagline(text) {
    this.opts.tagline = text;
    this._applyStatus();
  }

  setName(text) {
    this.opts.name = text;
    this.nameEl.textContent = text;
  }

  /**
   * „Sprechen“ ohne echtes Audio: Orb spricht für eine zur Textlänge passende Dauer.
   * @param {string|number} textOrSeconds
   */
  speak(textOrSeconds) {
    const secs =
      typeof textOrSeconds === 'number'
        ? textOrSeconds
        : clamp(0.9 + String(textOrSeconds || '').length / 110, 1.2, 5);
    this.setState('speaking', { force: true });
    this._speechUntil = performance.now() + secs * 1000;
    this._afterSpeech = null;
  }

  /** Kurzer Impuls, z. B. pro gestreamtem Text-Chunk. 0..1 */
  pulse(strength = 0.5) {
    this._pulse = Math.min(1.2, this._pulse + strength * 0.6);
  }

  /** Externer Audiopegel 0..1 (falls du selbst analysierst). */
  setLevel(v) {
    this._extLevel = clamp(+v || 0);
    this._extLevelAt = performance.now();
  }

  /**
   * Audioquelle anschließen: MediaStream (Mikrofon), <audio>/<video> (TTS) oder AudioNode.
   * @returns {() => void} Funktion zum Trennen
   */
  connectAudio(source) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return () => {};
    const ctx = (this._audioCtx ||= new Ctx());
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    let node;
    if (typeof MediaStream !== 'undefined' && source instanceof MediaStream) {
      node = ctx.createMediaStreamSource(source);
    } else if (typeof HTMLMediaElement !== 'undefined' && source instanceof HTMLMediaElement) {
      node = this._mediaNodes.get(source);
      if (!node) {
        node = ctx.createMediaElementSource(source);
        node.connect(ctx.destination); // weiterhin hörbar
        this._mediaNodes.set(source, node);
      }
    } else if (source && typeof source.connect === 'function') {
      node = source;
    } else {
      console.warn('KuronamiOrb.connectAudio: unbekannte Quelle', source);
      return () => {};
    }
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.55;
    node.connect(analyser);
    const entry = {
      analyser,
      time: new Uint8Array(analyser.fftSize),
      freq: new Uint8Array(analyser.frequencyBinCount),
      binHz: ctx.sampleRate / analyser.fftSize,
    };
    this._analysers.add(entry);
    return () => {
      try {
        node.disconnect(analyser);
      } catch {
        /* schon getrennt */
      }
      this._analysers.delete(entry);
    };
  }

  /** Signalisiert Tippen (Wellen + „hört zu“-Pose). */
  notifyTyping() {
    const now = performance.now();
    this._wake(now);
    this._typingUntil = now + 1400;
    if (now - this._lastKeyShock > 160) {
      this._lastKeyShock = now;
      this._shock(this._frontLocal(), 0.28);
    }
    this.pulse(0.12);
  }

  /** Eingabefeld koppeln: Tippen & Fokus werden automatisch gezeigt. Gibt eine Lösen-Funktion zurück. */
  bindInput(el) {
    const onInput = () => this.notifyTyping();
    const onFocus = () => {
      this._inputFocused = true;
      this._wake(performance.now());
    };
    const onBlur = () => {
      this._inputFocused = false;
    };
    el.addEventListener('input', onInput);
    el.addEventListener('focus', onFocus);
    el.addEventListener('blur', onBlur);
    return () => {
      el.removeEventListener('input', onInput);
      el.removeEventListener('focus', onFocus);
      el.removeEventListener('blur', onBlur);
      this._inputFocused = false;
    };
  }

  /** Aufleuchten, optional in Farbe ('#hex' oder [r,g,b]). */
  flash(color, strength = 0.5) {
    this._flashCol = Array.isArray(color) ? color.slice() : color ? hexToRgb(color) : this._p.glow.slice();
    this._flash = Math.max(this._flash, strength);
  }

  /**
   * Sub-Agent hinzufügen – er wächst als Satellit aus dem Orb.
   * @param {{id?: string, type?: string, name?: string, description?: string, color?: string}} info
   * @returns {string} id
   */
  addAgent({ id, type = 'general-purpose', name, description = '', color } = {}) {
    id = id ?? `agent-${++this._agentSeq}`;
    const now = performance.now();
    const existing = this.agentsMap.get(id);
    if (existing) {
      if (existing.status !== 'running') {
        // Wiederaufnahme: gleicher Agent läuft erneut
        Object.assign(existing, { status: 'running', started: now, ended: 0, releaseAt: 0, removeAt: 0, absorbed: false, mixTarget: 1, glow: 0 });
        existing.rgb = existing.baseRgb.slice();
        if (existing.slot < 0) this._assignSlot(existing);
        this._renderChip(existing);
      }
      this.updateAgent(id, { type, name, description });
      return id;
    }
    const hex = color || agentColor(type);
    const a = {
      id,
      type,
      name: name || prettyAgentName(type),
      description,
      colorHex: hex,
      baseRgb: hexToRgb(hex),
      rgb: hexToRgb(hex),
      status: 'running',
      activity: '',
      tools: 0,
      started: now,
      ended: 0,
      slot: -1,
      mix: 0,
      mixTarget: 1,
      act: 0,
      glow: 0,
      vis: 1,
      angle: null,
      releaseAt: 0,
      removeAt: 0,
      absorbed: false,
      order: ++this._agentOrder,
      pos: new THREE.Vector3(),
      px: null,
      tag: null,
      chip: null,
    };
    this.agentsMap.set(id, a);
    this._assignSlot(a);
    this._createChip(a);
    this._applyStatus();
    this._emitAgents();
    return id;
  }

  /** Sub-Agent aktualisieren: { activity, description, type, name, tools } */
  updateAgent(id, patch = {}) {
    const a = this.agentsMap.get(id);
    if (!a) return;
    let blip = false;
    if (patch.type && patch.type !== a.type) {
      a.type = patch.type;
      if (!patch.name) a.name = prettyAgentName(patch.type);
    }
    if (patch.name) a.name = patch.name;
    if (patch.description !== undefined && patch.description) a.description = patch.description;
    if (patch.activity !== undefined && patch.activity !== a.activity) {
      a.activity = patch.activity || '';
      blip = !!patch.activity;
    }
    if (typeof patch.tools === 'number') a.tools = patch.tools;
    if (blip && a.status === 'running') a.act = Math.max(a.act, 0.7);
    this._renderChip(a);
  }

  /** Kurzes Aufblitzen eines Satelliten (z. B. pro Tool-Aufruf). */
  agentBlip(id, strength = 1) {
    const a = this.agentsMap.get(id);
    if (a && a.status === 'running') a.act = Math.max(a.act, strength);
  }

  /**
   * Sub-Agent abschließen – Satellit leuchtet auf und fließt zurück.
   * @param {string} id
   * @param {{status?: 'done'|'error'|'stopped', summary?: string}} [o]
   */
  completeAgent(id, { status = 'done', summary } = {}) {
    const a = this.agentsMap.get(id);
    if (!a || a.status !== 'running') return;
    const now = performance.now();
    a.status = status;
    a.ended = now;
    a.glow = 1;
    if (summary) a.activity = String(summary).split('\n')[0];
    a.releaseAt = now + (status === 'error' ? 1100 : 600);
    a.removeAt = now + (status === 'error' ? 6500 : status === 'stopped' ? 2600 : 3400);
    if (status === 'error') this.flash(ERROR_RGB, 0.25);
    this._renderChip(a);
    this._layoutChips();
    this._applyStatus();
    this._emitAgents();
  }

  /** Sub-Agent sofort entfernen (ohne Abschluss-Animation in der Liste). */
  removeAgent(id) {
    const a = this.agentsMap.get(id);
    if (!a) return;
    if (a.status === 'running') a.status = 'stopped';
    a.mixTarget = 0;
    a.releaseAt = 0;
    a.removeAt = performance.now();
    this._applyStatus();
    this._emitAgents();
  }

  clearAgents() {
    for (const id of [...this.agentsMap.keys()]) this.removeAgent(id);
  }

  /** Rendering pausieren/fortsetzen (z. B. wenn die Seite verborgen ist). */
  pause() {
    this._paused = true;
  }
  resume() {
    this._paused = false;
    this._last = 0;
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    clearTimeout(this._dwellTimer);
    clearTimeout(this._statusTimer);
    this._ro?.disconnect();
    this._io?.disconnect();
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup', this._onPointerUp);
    window.removeEventListener('pointercancel', this._onPointerUp);
    this.canvas.removeEventListener('pointerdown', this._onPointerDown);
    this.canvas.removeEventListener('pointerleave', this._onPointerLeave);
    this.canvas.removeEventListener('webglcontextlost', this._onContextLost);
    this._analysers.clear();
    this._audioCtx?.close?.().catch(() => {});
    this.points.geometry.dispose();
    this.points.material.dispose();
    this.backdrop.geometry.dispose();
    this.backdrop.material.dispose();
    this.renderer.dispose();
    this.root.remove();
  }

  // ------------------------------------------------------------ Aufbau

  _buildDom() {
    injectStyles();
    const root = document.createElement('div');
    root.className = 'ko-root';
    root.innerHTML = `
      <canvas class="ko-canvas"></canvas>
      <div class="ko-layer ko-tags"></div>
      <div class="ko-caption">
        <div class="ko-name"></div>
        <div class="ko-status" aria-live="polite"></div>
        <div class="ko-agents"></div>
      </div>`;
    this.container.appendChild(root);
    this.root = root;
    this.canvas = root.querySelector('.ko-canvas');
    this.tagLayer = root.querySelector('.ko-tags');
    this.captionEl = root.querySelector('.ko-caption');
    this.nameEl = root.querySelector('.ko-name');
    this.statusEl = root.querySelector('.ko-status');
    this.agentListEl = root.querySelector('.ko-agents');
    this.moreEl = document.createElement('div');
    this.moreEl.className = 'ko-more';
    this.nameEl.textContent = this.opts.name;
    if (!this.opts.caption) this.captionEl.style.display = 'none';
    if (!this.opts.agentList) this.agentListEl.style.display = 'none';
    this.canvas.setAttribute('role', 'img');
  }

  _buildScene() {
    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      alpha: true,
      premultipliedAlpha: true,
      powerPreference: 'high-performance',
    });
    renderer.setClearColor(0x000000, 0);
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    this.camera.position.set(0, 0, 10);

    const premultipliedOver = {
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    };

    // Hintergrund: dunkler Kern + Halo in einem kameraparallelen Quad
    this.bu = {
      uR: { value: 0.9 },
      uAbsorb: { value: 0.54 },
      uBodyAlpha: { value: this.opts.bodyOpacity },
      uBodyCol: { value: new THREE.Vector3(0.012, 0.02, 0.042) },
      uGlowCol: { value: new THREE.Vector3() },
      uHalo: { value: 0.5 },
      uHeart: { value: 0.25 },
      uHeartCol: { value: new THREE.Vector3() },
      uShockT: { value: 10 },
      uShockAmp: { value: 0 },
      uFlash: { value: 0 },
      uFlashCol: { value: new THREE.Vector3(1, 1, 1) },
      uLevel: { value: 0 },
      uShellR: { value: 1 },
      uRim: { value: 1 },
      uSatGlow: { value: Array.from({ length: MAX_SLOTS }, () => new THREE.Vector4(0, 0, 1, 0)) },
      uSatCol: { value: Array.from({ length: MAX_SLOTS }, () => new THREE.Vector3(1, 1, 1)) },
    };
    this.backdrop = new THREE.Mesh(
      new THREE.PlaneGeometry(9, 9),
      new THREE.ShaderMaterial({
        uniforms: this.bu,
        vertexShader: BACKDROP_VS,
        fragmentShader: BACKDROP_FS,
        defines: { MAX_SLOTS },
        ...premultipliedOver,
      }),
    );
    this.backdrop.renderOrder = 0;
    this.backdrop.frustumCulled = false;
    this.scene.add(this.backdrop);

    // Partikel
    const q = { high: 1, medium: 0.62, low: 0.38 }[this.opts.quality] ?? 1;
    const counts = {
      cloud: Math.round(10500 * q),
      stream: Math.round(3000 * q),
      ring: Math.round(2600 * q),
      slot: Math.max(180, Math.round(620 * q)),
    };
    const total = counts.cloud + counts.stream + counts.ring + counts.slot * MAX_SLOTS;
    const base = new Float32Array(total * 3);
    const rand = new Float32Array(total * 4);
    const kind = new Float32Array(total);
    const index = new Float32Array(total);
    let i = 0;
    const push = (k, idx) => {
      const u = Math.random() * 2 - 1;
      const phi = Math.random() * TAU;
      const s = Math.sqrt(1 - u * u);
      base[i * 3] = s * Math.cos(phi);
      base[i * 3 + 1] = u;
      base[i * 3 + 2] = s * Math.sin(phi);
      for (let c = 0; c < 4; c++) rand[i * 4 + c] = Math.random();
      kind[i] = k;
      index[i] = idx;
      i++;
    };
    for (let n = 0; n < counts.cloud; n++) push(0, 0);
    for (let n = 0; n < counts.stream; n++) push(1, n % 3);
    for (let n = 0; n < counts.ring; n++) push(2, n % 2);
    for (let s = 0; s < MAX_SLOTS; s++) for (let n = 0; n < counts.slot; n++) push(3, s);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(base, 3));
    geo.setAttribute('aRand', new THREE.BufferAttribute(rand, 4));
    geo.setAttribute('aKind', new THREE.BufferAttribute(kind, 1));
    geo.setAttribute('aIndex', new THREE.BufferAttribute(index, 1));

    this.u = {
      uTime: { value: 0 },
      uIntro: { value: this.opts.intro && !this._reduced ? 0 : 1 },
      uFlow: { value: 0 },
      uSwirl: { value: 0 },
      uStreamPhase: { value: 0 },
      uRingPhase: { value: 0 },
      uNoiseTime: { value: 0 },
      uSwellPhase: { value: 0 },
      uWavePhase: { value: 0 },
      uSpin: { value: new THREE.Matrix3() },
      uScale: { value: 1 },
      uNoiseAmp: { value: 0.05 },
      uNoiseFreq: { value: 1.5 },
      uSwell: { value: 0.03 },
      uWave: { value: 0 },
      uLevel: { value: 0 },
      uAudio: { value: this._audioBands },
      uStream: { value: 0 },
      uRing: { value: 0 },
      uLean: { value: 0 },
      uContract: { value: 0 },
      uJitter: { value: 0 },
      uSparkle: { value: 0 },
      uBright: { value: 1 },
      uGain: { value: 0.4 },
      uPointerDir: { value: new THREE.Vector3(0, 0, 1) },
      uPointerAmt: { value: 0 },
      uShockDir: { value: new THREE.Vector3(0, 0, 1) },
      uShockT: { value: 10 },
      uShockAmp: { value: 0 },
      uSlotPos: { value: Array.from({ length: MAX_SLOTS }, () => new THREE.Vector3()) },
      uSlotCol: { value: Array.from({ length: MAX_SLOTS }, () => new THREE.Vector3(1, 1, 1)) },
      uSlotState: { value: Array.from({ length: MAX_SLOTS }, () => new THREE.Vector4(0, 0, 1, 0)) },
      uColA: { value: new THREE.Vector3() },
      uColB: { value: new THREE.Vector3() },
      uColC: { value: new THREE.Vector3() },
      uPointScale: { value: 1000 },
      uSize: { value: 0.019 },
      uCenterView: { value: new THREE.Vector3(0, 0, -10) },
      uBodyR: { value: BODY_R },
      uAbsorb: { value: 0.54 },
    };
    this.points = new THREE.Points(
      geo,
      new THREE.ShaderMaterial({
        uniforms: this.u,
        vertexShader: PARTICLE_VS,
        fragmentShader: PARTICLE_FS,
        defines: { MAX_SLOTS },
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneFactor,
        blendSrcAlpha: THREE.OneFactor,
        blendDstAlpha: THREE.OneFactor,
      }),
    );
    this.points.renderOrder = 1;
    this.points.frustumCulled = false;
    this.scene.add(this.points);
  }

  _bindEvents() {
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(this.root);
    this._io = new IntersectionObserver((entries) => {
      this._visible = entries[entries.length - 1]?.isIntersecting ?? true;
    });
    this._io.observe(this.root);
    window.addEventListener('pointermove', this._onPointerMove, { passive: true });
    window.addEventListener('pointerup', this._onPointerUp);
    window.addEventListener('pointercancel', this._onPointerUp);
    this.canvas.addEventListener('pointerdown', this._onPointerDown);
    this.canvas.addEventListener('pointerleave', this._onPointerLeave);
    this.canvas.addEventListener('webglcontextlost', this._onContextLost);
  }

  _onContextLost = (e) => {
    e.preventDefault(); // three stellt den Kontext wieder her
  };

  _resize() {
    const w = Math.max(1, this.root.clientWidth);
    const h = Math.max(1, this.root.clientHeight);
    const dpr = Math.max(0.75, Math.min(this.opts.maxDpr, window.devicePixelRatio || 1) * this._dprScale);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    const cam = this.camera;
    const orbPx = (this.opts.size * Math.min(w, h)) / 2; // Radius 1 (Welt) in CSS-Pixeln
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    const dist = (h / 2 / orbPx) / tanHalf;
    const shift = Math.round(this.opts.offsetY * h);
    cam.aspect = w / h;
    cam.position.set(0, 0, dist);
    cam.near = Math.max(0.1, dist - 8);
    cam.far = dist + 8;
    cam.setViewOffset(w, h, 0, shift, w, h);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    this._w = w;
    this._h = h;
    this._orbPx = orbPx;
    this._center = { x: w / 2, y: h / 2 - shift };
    this.u.uPointScale.value = (h * dpr) / (2 * tanHalf);
    this.u.uCenterView.value.set(0, 0, 0).applyMatrix4(cam.matrixWorldInverse);
    this.captionEl.style.top = `${Math.round(this._center.y + orbPx * 1.2 + 24)}px`;
  }

  // ------------------------------------------------------------ Interaktion

  _localXY(e) {
    const rect = this.root.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top, rect };
  }

  _onPointerMove = (e) => {
    const now = performance.now();
    const { x, y, rect } = this._localXY(e);
    this._wake(now);
    this._pointer.set(x, y);
    this._pointerIn = x >= 0 && y >= 0 && x <= rect.width && y <= rect.height;
    if (this.opts.followPointer) {
      const nx = clamp((x - this._center.x) / (rect.width * 0.5), -1.6, 1.6);
      const ny = clamp((y - this._center.y) / (rect.height * 0.5), -1.6, 1.6);
      this._tiltTarget.set(ny * 0.14, nx * 0.2);
    }
    const d = this._down;
    if (d) {
      const dx = x - d.lastX;
      const dy = y - d.lastY;
      const dt = Math.max(1, now - d.lastT) / 1000;
      d.moved += Math.abs(dx) + Math.abs(dy);
      d.lastX = x;
      d.lastY = y;
      d.lastT = now;
      if (d.onOrb && d.moved > 5) {
        this.root.classList.add('is-drag');
        this._rotateBy(dx, dy);
        this._dragVel.set(dx / dt, dy / dt).multiplyScalar(0.5).add(this._dragVel.clone().multiplyScalar(0.5));
      }
    } else if (this.opts.interactive) {
      this._hoverAgent = this._pointerIn ? this._agentAt(x, y) : null;
      const onOrb = this._pointerIn && Math.hypot(x - this._center.x, y - this._center.y) < this._orbPx * 1.05;
      this.root.classList.toggle('is-hover', !!(this._hoverAgent || onOrb));
    }
  };

  _onPointerLeave = () => {
    if (!this._down) this.root.classList.remove('is-hover');
  };

  _onPointerDown = (e) => {
    if (!this.opts.interactive || e.button > 0) return;
    const { x, y } = this._localXY(e);
    const onOrb = Math.hypot(x - this._center.x, y - this._center.y) < this._orbPx * 1.05;
    const agent = this._agentAt(x, y);
    if (!onOrb && !agent) return;
    const now = performance.now();
    this._down = { x, y, lastX: x, lastY: y, lastT: now, moved: 0, onOrb: onOrb && !agent, agent };
    this._dragVel.set(0, 0);
    this.canvas.setPointerCapture?.(e.pointerId);
  };

  _onPointerUp = () => {
    const d = this._down;
    if (!d) return;
    this._down = null;
    this.root.classList.remove('is-drag');
    if (d.moved > 6) return;
    if (d.agent) {
      this.agentBlip(d.agent.id, 1);
      this.dispatchEvent(new CustomEvent('agentclick', { detail: publicAgent(d.agent) }));
    } else if (d.onOrb) {
      const local = this._ptrWorld.clone().applyQuaternion(this._tmpQ.copy(this.points.quaternion).invert());
      this._shock(local, 1);
      this.flash(null, 0.35);
      this.dispatchEvent(new CustomEvent('orbclick', { detail: { state: this._state } }));
    }
  };

  _rotateBy(dx, dy) {
    this._tmpQ.setFromAxisAngle(this._axisY, dx * 0.0085);
    this._tmpQ2.setFromAxisAngle(this._axisX, dy * 0.0085);
    this._spinQ.premultiply(this._tmpQ).premultiply(this._tmpQ2).normalize();
  }

  _agentAt(x, y) {
    let best = null;
    let bestD = Math.max(18, this._orbPx * 0.24);
    for (const a of this.agentsMap.values()) {
      if (!a.px || a.mix < 0.5) continue;
      const dd = Math.hypot(x - a.px.x, y - a.px.y);
      if (dd < bestD) {
        bestD = dd;
        best = a;
      }
    }
    return best;
  }

  _wake(now) {
    this._lastInteraction = now;
    if (this._drowsy) {
      this._drowsy = false;
      this._shock(this._frontLocal(), 0.45);
      this.flash(null, 0.2);
      this._applyStatus();
    }
  }

  _frontLocal() {
    return this._tmpV2.set(0, 0, 1).applyQuaternion(this._tmpQ.copy(this.points.quaternion).invert()).clone();
  }

  _shock(localDir, amp) {
    this.u.uShockDir.value.copy(localDir).normalize();
    this._shockT = 0;
    this.u.uShockAmp.value = amp;
    this.bu.uShockAmp.value = amp;
  }

  // ------------------------------------------------------------ Zustandslogik

  _applyState(state) {
    const prev = this._state;
    if (state !== 'speaking') this._speechUntil = 0;
    if (state !== prev) {
      this._state = state;
      this._stateChangedAt = performance.now();
      if (state === 'error') {
        this._shock(this._frontLocal(), 0.7);
        this.flash(ERROR_RGB, 0.45);
      }
      if (state === 'attention') this._nextCall = 0;
      this._visual = this._computeVisual(performance.now());
      this.dispatchEvent(new CustomEvent('statechange', { detail: { state, prev, detail: this._detail } }));
    }
    this._applyStatus();
  }

  // Tippen lässt einen ruhenden Orb sichtbar zuhören
  _computeVisual(now) {
    return this._state === 'idle' && this._typingUntil > now ? 'listening' : this._state;
  }

  _statusText() {
    const st = this._visual;
    const L = this.labels;
    let text = (st === 'working' || st === 'attention' || st === 'error') && this._detail ? this._detail : L[st] ?? this.opts.tagline;
    if (!text) text = this.opts.tagline;
    const running = this._countRunning();
    if (running) text = st === 'idle' ? L.background(running) : `${text} · ${L.agentCount(running)}`;
    return text;
  }

  _applyStatus(immediate = false) {
    const text = this._statusText();
    this.canvas.setAttribute('aria-label', `${this.opts.name}: ${text}`);
    if (immediate || this._statusShown === undefined) {
      this._statusShown = text;
      this.statusEl.textContent = text;
      return;
    }
    if (text === this._statusShown && !this._statusTimer) return;
    this._statusPending = text;
    if (this._statusTimer) return;
    this.statusEl.classList.add('is-fading');
    this._statusTimer = setTimeout(() => {
      this._statusTimer = null;
      this._statusShown = this._statusPending;
      this.statusEl.textContent = this._statusShown;
      this.statusEl.classList.remove('is-fading');
    }, 170);
  }

  _countRunning() {
    let n = 0;
    for (const a of this.agentsMap.values()) if (a.status === 'running') n++;
    return n;
  }

  // ------------------------------------------------------------ Sub-Agenten

  _assignSlot(a) {
    const free = this._slots.indexOf(null);
    if (free < 0) return; // alle Plätze belegt – erscheint, sobald einer frei wird
    this._slots[free] = a;
    a.slot = free;
    a.mix = 0;
    a.mixTarget = a.status === 'running' ? 1 : 0;
    a.angle = null;
    a.absorbed = false;
    this.flash(a.rgb, 0.3);
  }

  _createChip(a) {
    const chip = document.createElement('div');
    chip.className = 'ko-agent is-enter';
    chip.innerHTML = '<i class="ko-dot"></i><b></b><span class="ko-act"></span><time></time>';
    a.chip = chip;
    this._renderChip(a);
    requestAnimationFrame(() => chip.classList.remove('is-enter'));
    this._layoutChips();

    if (this.opts.agentTags) {
      const tag = document.createElement('div');
      tag.className = 'ko-tag';
      tag.innerHTML = '<i></i><b></b><small></small>';
      this.tagLayer.appendChild(tag);
      a.tag = tag;
      this._renderChip(a);
    }
  }

  _renderChip(a) {
    const color = a.status === 'error' ? '#ff7d8b' : a.colorHex;
    const activity = a.activity || a.description || '';
    if (a.chip) {
      a.chip.style.setProperty('--c', color);
      for (const s of ['running', 'done', 'error', 'stopped']) a.chip.classList.toggle(`is-${s}`, a.status === s);
      a.chip.title = a.description || '';
      const dot = a.chip.firstChild;
      const icon = a.status === 'done' ? '✓' : a.status === 'error' ? '✕' : a.status === 'stopped' ? '–' : '';
      dot.className = icon ? 'ko-dot is-icon' : 'ko-dot';
      dot.textContent = icon;
      a.chip.children[1].textContent = a.name;
      a.chip.children[2].textContent = activity;
    }
    if (a.tag) {
      a.tag.style.setProperty('--c', color);
      const short = activity.length > 26 ? `${activity.slice(0, 25)}…` : activity;
      if (a.tag.children[2].textContent !== short || a.tag.children[1].textContent !== a.name) a.tagW = 0;
      a.tag.children[1].textContent = a.name;
      a.tag.children[2].textContent = short;
    }
  }

  _layoutChips() {
    if (!this.opts.agentList) return;
    const list = [...this.agentsMap.values()].filter((a) => a.chip).sort((x, y) => x.order - y.order);
    // Bei Überlauf zuerst fertige, dann laufende (jeweils die ältesten) ausblenden – Fehler bleiben sichtbar
    const rank = { done: 0, stopped: 0, running: 1, error: 2 };
    const drop = new Set(
      [...list]
        .sort((x, y) => rank[x.status] - rank[y.status] || x.order - y.order)
        .slice(0, Math.max(0, list.length - this.opts.maxAgentRows)),
    );
    const shown = list.filter((a) => !drop.has(a));
    const hidden = drop.size;
    for (const a of list) {
      const on = shown.includes(a);
      if (on && a.chip.parentNode !== this.agentListEl) this.agentListEl.appendChild(a.chip);
      if (!on && a.chip.parentNode) a.chip.remove();
    }
    for (const a of shown) this.agentListEl.appendChild(a.chip); // Reihenfolge sichern
    if (hidden > 0) {
      this.moreEl.textContent = this.labels.more(hidden);
      this.agentListEl.appendChild(this.moreEl);
    } else if (this.moreEl.parentNode) this.moreEl.remove();
  }

  _emitAgents() {
    this.dispatchEvent(new CustomEvent('agentschange', { detail: this.agents }));
  }

  _updateAgents(dt, now) {
    let changed = false;
    for (const a of this.agentsMap.values()) {
      if (a.releaseAt && now >= a.releaseAt) {
        a.releaseAt = 0;
        a.mixTarget = 0;
      }
      if (a.slot >= 0) {
        const rate = a.mixTarget > a.mix ? 1 / 1.5 : 1 / 1.25;
        a.mix = a.mixTarget > a.mix ? Math.min(a.mixTarget, a.mix + dt * rate) : Math.max(a.mixTarget, a.mix - dt * rate);
        if (!a.absorbed && a.mixTarget === 0 && a.mix < 0.3) {
          a.absorbed = true;
          if (a.status === 'done') {
            this.flash(a.rgb, 0.55);
            this.pulse(0.4);
          }
        }
        if (a.mixTarget === 0 && a.mix <= 0) {
          this._slots[a.slot] = null;
          a.slot = -1;
          a.px = null;
        }
      }
      a.act *= Math.exp(-dt * 3);
      a.glow *= Math.exp(-dt * (a.status === 'running' ? 3 : 1.1));
      const tgt = a.status === 'error' ? ERROR_RGB : a.status === 'stopped' ? STOPPED_RGB : a.baseRgb;
      const k = 1 - Math.exp(-dt * 4);
      for (let c = 0; c < 3; c++) a.rgb[c] += (tgt[c] - a.rgb[c]) * k;
      a.vis = a.status === 'error' ? 0.65 + 0.35 * Math.sin(now * 0.03) : 1;
      if (a.removeAt && now >= a.removeAt && a.slot < 0) {
        if (a.chip && !a.chip.classList.contains('is-leave')) {
          a.chip.classList.add('is-leave');
          const chip = a.chip;
          setTimeout(() => {
            chip.remove();
            this._layoutChips();
          }, 460);
        }
        a.tag?.remove();
        this.agentsMap.delete(a.id);
        changed = true;
      }
    }
    // Wartende Agenten bekommen frei gewordene Plätze
    if (this._slots.includes(null)) {
      for (const a of this.agentsMap.values()) {
        if (a.slot < 0 && a.status === 'running') {
          this._assignSlot(a);
          if (!this._slots.includes(null)) break;
        }
      }
    }
    // Umlaufbahn: laufende Satelliten gleichmäßig verteilt, zurückkehrende bleiben stehen
    const orbiting = this._slots.filter((a) => a && a.mixTarget > 0).sort((x, y) => x.order - y.order);
    const n = orbiting.length;
    orbiting.forEach((a, k) => {
      const target = this._orbit + (TAU * k) / Math.max(1, n);
      a.angle = a.angle == null ? target : a.angle + angleDelta(a.angle, target) * (1 - Math.exp(-dt * 2.2));
    });
    const R = 1.78;
    const tilt = 0.44;
    for (let s = 0; s < MAX_SLOTS; s++) {
      const a = this._slots[s];
      const st = this.u.uSlotState.value[s];
      if (!a) {
        st.set(0, 0, 1, 0);
        continue;
      }
      if (a.angle == null) a.angle = this._orbit;
      const x = Math.cos(a.angle) * R;
      const z = Math.sin(a.angle) * R;
      const bob = Math.sin(this._time * 0.9 + a.order * 1.7) * 0.05;
      a.pos.set(x, -z * Math.sin(tilt) + bob, z * Math.cos(tilt));
      this.u.uSlotPos.value[s].copy(a.pos);
      this.u.uSlotCol.value[s].set(a.rgb[0], a.rgb[1], a.rgb[2]);
      const hover = this._hoverAgent === a ? 0.35 : 0;
      st.set(a.mix, clamp(a.act + hover), a.vis, a.glow);
    }
    const running = this._countRunning();
    if (running !== this._runningCount || changed) {
      this._runningCount = running;
      this._applyStatus();
      if (changed) this._emitAgents();
    }
  }

  // ------------------------------------------------------------ Audio

  _updateAudio(dt, now) {
    let lvl = 0;
    let real = false;
    let low = 0;
    let mid = 0;
    let high = 0;
    for (const e of this._analysers) {
      e.analyser.getByteTimeDomainData(e.time);
      let sum = 0;
      for (let i = 0; i < e.time.length; i++) {
        const v = (e.time[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / e.time.length);
      lvl = Math.max(lvl, clamp(Math.pow(rms * 5.5, 0.85)));
      e.analyser.getByteFrequencyData(e.freq);
      const band = (f0, f1) => {
        const a = Math.max(1, Math.floor(f0 / e.binHz));
        const b = Math.min(e.freq.length - 1, Math.ceil(f1 / e.binHz));
        let s = 0;
        for (let i = a; i <= b; i++) s += e.freq[i];
        return s / ((b - a + 1) * 255);
      };
      low = Math.max(low, clamp(band(60, 250) * 1.6));
      mid = Math.max(mid, clamp(band(250, 2000) * 1.9));
      high = Math.max(high, clamp(band(2000, 6000) * 2.6));
      real = true;
    }
    if (now - this._extLevelAt < 500) {
      lvl = Math.max(lvl, this._extLevel);
      real = true;
    }
    this._pulse *= Math.exp(-dt * 4.5);
    lvl = Math.max(lvl, this._pulse);
    const t = this._time;
    if (this._visual === 'speaking' && !real && this._pulse < 0.05) {
      // Sprachähnliche Hüllkurve, wenn kein echtes Audio anliegt
      const syl = Math.max(0, Math.sin(t * 8.3) * 0.5 + Math.sin(t * 13.7 + 1.2) * 0.3 + Math.sin(t * 3.1) * 0.2);
      const phrase = smoothstep(-0.35, 0.1, Math.sin(t * 0.85) + Math.sin(t * 0.37) * 0.5);
      lvl = Math.max(lvl, syl * phrase * 0.8);
    }
    if (this._visual === 'listening' && !real) lvl = Math.max(lvl, 0.07 + 0.05 * Math.sin(t * 2.1));
    const k = lvl > this._level ? 1 - Math.exp(-dt * 22) : 1 - Math.exp(-dt * 6);
    this._level += (lvl - this._level) * k;
    const L = this._level;
    if (!real) {
      low = L * (0.8 + 0.2 * Math.sin(t * 5.1));
      mid = L;
      high = L * 0.6 * (0.5 + 0.5 * Math.sin(t * 17.3));
    }
    const kb = 1 - Math.exp(-dt * 14);
    this._audioBands.x += (low - this._audioBands.x) * kb;
    this._audioBands.y += (mid - this._audioBands.y) * kb;
    this._audioBands.z += (high - this._audioBands.z) * kb;
  }

  // ------------------------------------------------------------ Frame

  _frame = (now) => {
    this._raf = requestAnimationFrame(this._frame);
    // (Verborgene Tabs pausiert der Browser selbst – requestAnimationFrame feuert dort nicht)
    if (this._paused || !this._visible) {
      this._last = 0;
      return;
    }
    const dt = this._last ? Math.min(0.05, Math.max(0.001, (now - this._last) / 1000)) : 1 / 60;
    this._last = now;
    const motion = this._reduced ? 0.35 : 1;
    this._time += dt;

    // Sprachausgabe beendet → nachgeholten Zustand anwenden
    if (this._speechUntil && now > this._speechUntil) {
      this._speechUntil = 0;
      if (this._afterSpeech) {
        const s = this._afterSpeech;
        this._afterSpeech = null;
        this._applyState(s);
      }
    }

    const visual = this._computeVisual(now);
    const drowsy =
      this.opts.drowseAfter > 0 &&
      this._state === 'idle' &&
      this._runningCount === 0 &&
      now - this._lastInteraction > this.opts.drowseAfter * 1000;
    if (visual !== this._visual || drowsy !== this._drowsy) {
      this._visual = visual;
      this._drowsy = drowsy;
      this._applyStatus();
    }

    this._updateAudio(dt, now);
    this._updateAgents(dt, now);
    this._updateParams(dt, now, motion);
    this._updatePointer(dt);

    if (this._state === 'attention' && now >= this._nextCall) {
      this._nextCall = now + 1900;
      this._shock(this._frontLocal(), 0.85);
    }

    this.renderer.render(this.scene, this.camera);
    this._updateDom(now);
    this._trackPerformance(dt);
  };

  _updateParams(dt, now, motion) {
    const T = this._targets[this._visual];
    const P = this._p;
    const tgt = { ...T };
    const running = this._runningCount;
    const attentive = this._typingUntil > now || this._inputFocused;
    if (this._drowsy) {
      tgt.bright *= 0.72;
      tgt.halo *= 0.55;
      tgt.flow *= 0.5;
      tgt.spin *= 0.4;
      tgt.heart *= 0.5;
      tgt.sparkle *= 0.3;
    }
    if (attentive) {
      tgt.lean += 0.05;
      tgt.bright *= 1.05;
      tgt.halo += 0.06;
    }
    if (running) {
      tgt.halo += Math.min(0.2, 0.05 * running);
      tgt.stream = Math.max(tgt.stream, 0.35);
      tgt.spin += 0.02;
    }
    const kNum = 1 - Math.exp(-dt * 2.6);
    for (const key of NUM_KEYS) P[key] += (tgt[key] - P[key]) * kNum;
    const kCol = 1 - Math.exp(-dt * 2.2);
    for (const key of COLOR_KEYS) {
      const c = P[key];
      const t = tgt[key];
      c[0] += (t[0] - c[0]) * kCol;
      c[1] += (t[1] - c[1]) * kCol;
      c[2] += (t[2] - c[2]) * kCol;
    }

    // Phasen aufsummieren (Geschwindigkeitswechsel ohne Sprünge)
    const ph = this._ph;
    ph.flow += dt * P.flow * motion;
    ph.swirl += dt * P.swirl * P.bands * motion;
    ph.stream += dt * P.streamSpeed * motion;
    ph.ring += dt * P.ringSpeed * motion;
    ph.noise += dt * P.noiseSpeed * motion;
    ph.swell += dt * P.swellSpeed * motion;
    ph.wave += dt * (3 + this._level * 7) * motion;
    this._orbit += dt * 0.11 * motion;

    // Eigenrotation + Schwung nach dem Ziehen
    this._tmpQ.setFromAxisAngle(this._spinAxis, dt * P.spin * motion);
    this._spinQ.premultiply(this._tmpQ);
    if (!this._down && this._dragVel.lengthSq() > 1) {
      this._rotateBy(this._dragVel.x * dt, this._dragVel.y * dt);
      this._dragVel.multiplyScalar(Math.exp(-dt * 2.4));
    }
    this._spinQ.normalize();
    this.u.uSpin.value.setFromMatrix4(this._tmpM.makeRotationFromQuaternion(this._spinQ));

    // Neigung zum Zeiger
    const kt = 1 - Math.exp(-dt * 2.5);
    this._tilt.x += (this._tiltTarget.x - this._tilt.x) * kt;
    this._tilt.y += (this._tiltTarget.y - this._tilt.y) * kt;
    this.points.rotation.set(this._tilt.x, this._tilt.y, 0);
    this.points.updateMatrixWorld();

    const breathe = Math.sin(this._time * TAU * P.breatheRate) * P.breathe;
    const scale = 1 + breathe + this._level * P.wave * 0.12 + this._audioBands.x * P.wave * 0.05;

    this._flash *= Math.exp(-dt * 1.6);
    this._shockT += dt;

    const u = this.u;
    u.uTime.value = this._time;
    if (u.uIntro.value < 1) u.uIntro.value = clamp((now - this._bornAt) / 2400); // echte Zeit, unabhängig von der Framerate
    u.uFlow.value = ph.flow;
    u.uSwirl.value = ph.swirl;
    u.uStreamPhase.value = ph.stream;
    u.uRingPhase.value = ph.ring;
    u.uNoiseTime.value = ph.noise;
    u.uSwellPhase.value = ph.swell;
    u.uWavePhase.value = ph.wave;
    u.uScale.value = scale;
    u.uNoiseAmp.value = P.noiseAmp;
    u.uNoiseFreq.value = P.noiseFreq;
    u.uSwell.value = P.swell;
    u.uWave.value = P.wave;
    u.uLevel.value = this._level;
    u.uStream.value = P.stream;
    u.uRing.value = P.ring;
    u.uLean.value = P.lean;
    u.uContract.value = P.contract;
    u.uJitter.value = P.jitter;
    u.uSparkle.value = P.sparkle;
    u.uBright.value = P.bright * (1 + this._flash * 0.25);
    u.uShockT.value = this._shockT;
    u.uColA.value.fromArray(P.colA);
    u.uColB.value.fromArray(P.colB);
    u.uColC.value.fromArray(P.colC);

    const b = this.bu;
    b.uR.value = BODY_R * scale * (1 - P.contract);
    b.uShellR.value = scale * (1 - P.contract);
    b.uRim.value = P.rim * (1 + this._flash * 0.6 + this._level * 0.3);
    b.uGlowCol.value.fromArray(P.glow);
    b.uHeartCol.value.fromArray(P.colA);
    b.uHalo.value = P.halo * (1 + this._level * 0.35);
    b.uHeart.value = P.heart * (1 + this._flash);
    b.uShockT.value = this._shockT;
    b.uFlash.value = this._flash;
    b.uFlashCol.value.fromArray(this._flashCol);
    b.uLevel.value = this._level;
  }

  _updatePointer(dt) {
    let amt = 0;
    if (this._pointerIn && this.opts.interactive) {
      const ndc = this._tmpV.set((this._pointer.x / this._w) * 2 - 1, -(this._pointer.y / this._h) * 2 + 1, 0);
      this._raycaster.setFromCamera(ndc, this.camera);
      const ray = this._raycaster.ray;
      this._sphere.radius = 1.02 * this.u.uScale.value;
      const hit = ray.intersectSphere(this._sphere, this._tmpV2);
      if (hit) {
        this._ptrWorld.copy(hit).normalize();
        amt = 1;
      } else {
        const cp = ray.closestPointToPoint(this._sphere.center, this._tmpV2);
        const dist = cp.length() - 1;
        this._ptrWorld.copy(cp).normalize();
        amt = Math.exp(-Math.max(0, dist) * 3.2);
      }
      this.u.uPointerDir.value.copy(this._ptrWorld).applyQuaternion(this._tmpQ.copy(this.points.quaternion).invert());
    }
    this._ptrAmt += (amt - this._ptrAmt) * (1 - Math.exp(-dt * 5));
    this.u.uPointerAmt.value = this._ptrAmt * (this._drowsy ? 0.4 : 1);
  }

  _updateDom(now) {
    const cam = this.camera;
    const bodyR = this.bu.uR.value;
    const absorb = this.u.uAbsorb.value;
    const center = this.u.uCenterView.value;
    const satPx = this._orbPx * 0.2;
    const satGlow = this.bu.uSatGlow.value;
    const satCol = this.bu.uSatCol.value;
    for (let s = 0; s < MAX_SLOTS; s++) satGlow[s].w = 0;
    for (const a of this.agentsMap.values()) {
      if (a.slot < 0) {
        if (a.tag) a.tag.style.opacity = '0';
        continue;
      }
      const world = this._tmpV.copy(a.pos).applyMatrix4(this.points.matrixWorld);
      const view = this._tmpV2.copy(world).applyMatrix4(cam.matrixWorldInverse);
      const rx = view.x - center.x;
      const ry = view.y - center.y;
      const rz = view.z - center.z;
      const rho = Math.hypot(rx, ry);
      let occl = 1;
      if (rho < bodyR) {
        const zf = Math.sqrt(bodyR * bodyR - rho * rho);
        occl = Math.exp(-absorb * clamp(zf - rz, 0, 2 * zf));
      }
      // Aura: Satellit aus Kamerasicht auf die Hintergrund-Ebene (z = 0) projiziert
      const k = cam.position.z / Math.max(0.1, cam.position.z - world.z);
      const strength = clamp(a.mix * 1.4 - 0.2) * (0.15 + 0.85 * occl) * a.vis * (1 + a.glow + a.act * 0.5);
      satGlow[a.slot].set(world.x * k, world.y * k, 0.42 * k, strength);
      satCol[a.slot].fromArray(a.rgb);
      world.project(cam);
      const x = (world.x * 0.5 + 0.5) * this._w;
      const y = (-world.y * 0.5 + 0.5) * this._h;
      a.px = { x, y };
      if (a.tag) {
        const left = x < this._center.x;
        const off = satPx + 8;
        const tw = a.tagW || (a.tagW = a.tag.offsetWidth);
        const tx = clamp(left ? x - off - tw : x + off, 4, this._w - tw - 4);
        const ty = clamp(y, 14, this._h - 14);
        a.tag.style.transform = `translate3d(${tx.toFixed(1)}px, ${ty.toFixed(1)}px, 0) translateY(-50%)`;
        const vis = clamp(a.mix * 1.6 - 0.4) * (0.1 + 0.9 * occl) * (a.status === 'running' ? 1 : 0.75);
        a.tag.style.opacity = vis.toFixed(3);
        a.tag.classList.toggle('is-hover', this._hoverAgent === a);
      }
      a.chip?.classList.toggle('is-hover', this._hoverAgent === a);
    }
    if (now - this._chipTick > 500) {
      this._chipTick = now;
      for (const a of this.agentsMap.values()) {
        const t = a.chip?.children[3];
        if (t) t.textContent = formatElapsed((a.ended || now) - a.started);
      }
    }
  }

  _trackPerformance(dt) {
    this._perfAcc += dt;
    this._perfN++;
    if (this._perfAcc < 3) return;
    const avg = this._perfAcc / this._perfN;
    this._perfAcc = 0;
    this._perfN = 0;
    // Unter ~28 fps: Auflösung schrittweise reduzieren
    if (avg > 1 / 28 && this._dprScale > 0.55) {
      this._dprScale = Math.max(0.55, this._dprScale - 0.15);
      this._resize();
    }
  }
}

function publicAgent(a) {
  return {
    id: a.id,
    type: a.type,
    name: a.name,
    description: a.description,
    status: a.status,
    activity: a.activity,
    color: a.colorHex,
    startedAt: a.started,
    endedAt: a.ended || null,
  };
}

export default KuronamiOrb;
