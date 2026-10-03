import type { Zustand } from "../praesenz/sphaere.js";
import { agentColor } from "../vendor/kuronami-orb.mjs";
import { ZUSTAND_FARBE } from "../welle/zustand.js";

/**
 * Der kleine Kuro — die Figur für den Begleiter auf dem Desktop. Ein Tintentropfen (黒波, die
 * schwarze Welle) mit Kuros Lichtband quer durch den Körper und zwei leuchtenden Augen. Er trägt
 * dieselben Zustände und Farben wie der große Orb; arbeiten Bedienstete, kreisen ihre Satelliten um
 * ihn. Zieht man eine Datei über ihn, öffnet er den Mund — losgelassen, schluckt er sie.
 *
 * Gezeichnet als SVG: scharf in jeder Größe, durchsichtig, ohne WebGL. Bewegt wird nur, was einen
 * Zustand zeigt; `prefers-reduced-motion` hält ihn still.
 */

export interface Figur {
  setzeZustand(z: Zustand): void;
  bediensteterBeginnt(name: string): void;
  bediensteterFertig(name: string): void;
  /** Eine Datei schwebt über ihm: Mund auf. */
  hunger(an: boolean): void;
  /** Die Datei ist da: er schluckt. */
  schlucke(): Promise<void>;
  /** Wohin er schaut — Bildschirmpunkt im Fenster; `null` geradeaus. */
  schaue(x: number | null, y: number | null): void;
  destroy(): void;
}

const KOERPER =
  "M100 22 C 124 54, 164 92, 164 140 C 164 182, 135 208, 100 208 C 65 208, 36 182, 36 140 C 36 92, 76 54, 100 22 Z";

let zaehler = 0;

export function mountFigur(host: HTMLElement): Figur {
  const id = `fg${++zaehler}`;
  const wurzel = document.createElement("div");
  wurzel.className = "fg";
  wurzel.dataset.zustand = "ruhe";
  wurzel.innerHTML = `
    <svg class="fg-svg" viewBox="0 0 200 240" aria-hidden="true">
      <defs>
        <radialGradient id="${id}-tinte" cx="38%" cy="40%" r="70%">
          <stop offset="0" stop-color="#1d3340"/>
          <stop offset="0.45" stop-color="#0a141a"/>
          <stop offset="1" stop-color="#020507"/>
        </radialGradient>
        <radialGradient id="${id}-glanz" cx="50%" cy="50%" r="50%">
          <stop offset="0" stop-color="#ffffff" stop-opacity="0.55"/>
          <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
        </radialGradient>
        <filter id="${id}-schein" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="3.2" result="b"/>
          <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <filter id="${id}-weich" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="9"/>
        </filter>
        <clipPath id="${id}-form"><path d="${KOERPER}"/></clipPath>
      </defs>
      <ellipse class="fg-schatten" cx="100" cy="226" rx="46" ry="7"/>
      <g class="fg-hinten"></g>
      <g class="fg-leib">
        <g class="fg-atem">
          <path class="fg-aura" d="${KOERPER}" filter="url(#${id}-weich)"/>
          <path class="fg-koerper" d="${KOERPER}" fill="url(#${id}-tinte)"/>
          <g clip-path="url(#${id}-form)">
            <path class="fg-band" d="M20 168 C 52 152, 78 184, 104 166 S 156 150, 184 164" filter="url(#${id}-schein)"/>
            <path class="fg-band fg-band--zwei" d="M20 180 C 56 166, 84 194, 110 178 S 160 166, 184 176"/>
            <ellipse cx="74" cy="78" rx="20" ry="28" fill="url(#${id}-glanz)" transform="rotate(-24 74 78)" opacity="0.5"/>
          </g>
          <path class="fg-rand" d="${KOERPER}" filter="url(#${id}-schein)"/>
          <g class="fg-gesicht">
            <g class="fg-augen" filter="url(#${id}-schein)">
              <ellipse class="fg-auge" cx="80" cy="124" rx="7.5" ry="10.5"/>
              <ellipse class="fg-auge" cx="120" cy="124" rx="7.5" ry="10.5"/>
            </g>
            <path class="fg-mund" d="M92 147 Q 100 153, 108 147" filter="url(#${id}-schein)"/>
            <ellipse class="fg-schlund" cx="100" cy="146" rx="11" ry="9"/>
          </g>
        </g>
        <g class="fg-wellen">
          <ellipse cx="100" cy="212" rx="40" ry="6"/>
          <ellipse cx="100" cy="212" rx="40" ry="6"/>
        </g>
      </g>
      <g class="fg-vorn"></g>
      <g class="fg-happen" opacity="0">
        <path d="M-9 -12 h12 l6 6 v18 h-18 z" fill="#e8eff1"/>
        <path d="M3 -12 v6 h6" fill="none" stroke="#93a7b0" stroke-width="1.4"/>
      </g>
    </svg>`;
  host.append(wurzel);

  const svg = wurzel.querySelector("svg") as SVGSVGElement;
  const hinten = svg.querySelector(".fg-hinten") as SVGGElement;
  const vorn = svg.querySelector(".fg-vorn") as SVGGElement;
  const augen = svg.querySelector(".fg-augen") as SVGGElement;
  const happen = svg.querySelector(".fg-happen") as SVGGElement;
  const ruhig = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  const satelliten = new Map<
    string,
    { el: SVGCircleElement; phase: number; geht: number | null }
  >();
  let blick = { x: 0, y: 0 };
  let ziel = { x: 0, y: 0 };
  let lebt = true;
  let rahmen = 0;
  /** Ob der Takt läuft. Er ruht, sobald der Blick angekommen ist und kein Satellit kreist —
   * vorher setzte er jedes Bild SVG-Attribute, auch wenn sich nichts bewegte. */
  let laeuft = false;

  const setzeFarbe = (z: Zustand) => {
    wurzel.style.setProperty("--licht", ZUSTAND_FARBE[z]);
  };
  setzeFarbe("ruhe");

  // Blinzeln in unregelmäßigen Abständen, wie ein Lebewesen — nie im Takt.
  let blinzelUhr: ReturnType<typeof setTimeout> | null = null;
  const blinzle = () => {
    if (!lebt) return;
    if (wurzel.dataset.zustand !== "offline") {
      augen.classList.add("ist-zu");
      globalThis.setTimeout(() => augen.classList.remove("ist-zu"), 130);
    }
    blinzelUhr = globalThis.setTimeout(blinzle, 2600 + Math.random() * 4200);
  };
  if (!ruhig) blinzelUhr = globalThis.setTimeout(blinzle, 1800);

  const takt = (t: number) => {
    if (!lebt) return;
    // Der Blick folgt weich, nicht ruckartig.
    blick = { x: blick.x + (ziel.x - blick.x) * 0.12, y: blick.y + (ziel.y - blick.y) * 0.12 };
    augen.setAttribute("transform", `translate(${blick.x.toFixed(2)} ${blick.y.toFixed(2)})`);
    // Satelliten auf einer geneigten Bahn; was hinter ihm ist, liegt hinter dem Körper.
    for (const [name, s] of satelliten) {
      const w = s.phase + (ruhig ? 0 : t / 1600);
      const x = 100 + Math.cos(w) * 86;
      const y = 140 + Math.sin(w) * 26 - Math.cos(w) * 10;
      const tief = Math.sin(w);
      s.el.setAttribute("cx", x.toFixed(1));
      s.el.setAttribute("cy", y.toFixed(1));
      s.el.setAttribute("r", (5 + tief * 1.6).toFixed(2));
      const sollHinten = tief < 0;
      if (sollHinten && s.el.parentNode !== hinten) hinten.append(s.el);
      if (!sollHinten && s.el.parentNode !== vorn) vorn.append(s.el);
      if (s.geht !== null && t > s.geht) {
        s.el.remove();
        satelliten.delete(name);
      }
    }
    const angekommen = Math.abs(ziel.x - blick.x) + Math.abs(ziel.y - blick.y) < 0.02;
    if (angekommen && satelliten.size === 0) {
      laeuft = false;
      return;
    }
    rahmen = requestAnimationFrame(takt);
  };
  const wecke = () => {
    if (laeuft || !lebt) return;
    laeuft = true;
    rahmen = requestAnimationFrame(takt);
  };

  return {
    setzeZustand(z) {
      wurzel.dataset.zustand = z;
      setzeFarbe(z);
    },
    bediensteterBeginnt(name) {
      if (satelliten.has(name)) return;
      const el = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      el.classList.add("fg-satellit");
      el.style.setProperty("--farbe", agentColor(name));
      el.setAttribute("r", "5");
      const titel = document.createElementNS("http://www.w3.org/2000/svg", "title");
      titel.textContent = name;
      el.append(titel);
      vorn.append(el);
      satelliten.set(name, { el, phase: satelliten.size * 2.1, geht: null });
      wurzel.classList.toggle("hat-satelliten", satelliten.size > 0);
      wecke();
    },
    bediensteterFertig(name) {
      const s = satelliten.get(name);
      if (!s) return;
      s.el.classList.add("ist-fertig");
      s.geht = performance.now() + 900;
      globalThis.setTimeout(
        () => wurzel.classList.toggle("hat-satelliten", satelliten.size > 1),
        900,
      );
    },
    hunger(an) {
      wurzel.classList.toggle("ist-hungrig", an);
    },
    async schlucke() {
      wurzel.classList.remove("ist-hungrig");
      wurzel.classList.add("ist-schluckt");
      if (!ruhig) {
        await happen.animate(
          [
            { transform: "translate(100px, -10px) rotate(-14deg) scale(1)", opacity: 0 },
            {
              transform: "translate(100px, 60px) rotate(-6deg) scale(1)",
              opacity: 1,
              offset: 0.35,
            },
            { transform: "translate(100px, 148px) rotate(0deg) scale(0.25)", opacity: 0 },
          ],
          { duration: 620, easing: "cubic-bezier(0.45, 0, 0.55, 1)" },
        ).finished;
      }
      await new Promise((fertig) => globalThis.setTimeout(fertig, ruhig ? 0 : 420));
      wurzel.classList.remove("ist-schluckt");
    },
    schaue(x, y) {
      if (x === null || y === null) {
        ziel = { x: 0, y: 0 };
        wecke();
        return;
      }
      const r = svg.getBoundingClientRect();
      const mx = r.left + r.width / 2;
      const my = r.top + r.height * 0.52;
      const dx = x - mx;
      const dy = y - my;
      const d = Math.hypot(dx, dy) || 1;
      const weite = Math.min(1, d / 260);
      ziel = { x: (dx / d) * 5 * weite, y: (dy / d) * 4 * weite };
      wecke();
    },
    destroy() {
      lebt = false;
      cancelAnimationFrame(rahmen);
      if (blinzelUhr) globalThis.clearTimeout(blinzelUhr);
      wurzel.remove();
    },
  };
}
