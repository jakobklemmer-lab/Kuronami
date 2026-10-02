import { type Netz, baueNetz, schritt } from "./graph-sim.js";

/**
 * Der Graph des Brain auf einer Leinwand — zoomen mit dem Rad, verschieben durch Ziehen der
 * Fläche, Notizen ziehen, mit der Maus darüber die Nachbarn hervorheben, Klick öffnet die Notiz.
 * Gezeichnet wird nur, solange sich etwas bewegt oder Jakob etwas tut.
 */

export interface GraphDaten {
  knoten: Array<{ pfad: string; titel: string; ordner: string }>;
  kanten: Array<[string, string]>;
}

export interface GraphOptionen {
  aktiv?: string | null;
  /** Der kleine Graph neben einer Notiz: Namen immer, kein Rad-Zoom ohne Klick. */
  lokal?: boolean;
  onOeffne(pfad: string): void;
}

/** Farbe je Ordner — dieselben Lichter wie überall in Kuronami. */
export const GRUPPEN_FARBE: Record<string, string> = {
  "": "#e8eff1",
  Bereiche: "#f4b860",
  Trading: "#7fd3a8",
  Wissen: "#6d90ff",
  Gespräche: "#93a7b0",
  Planung: "#8878ff",
  Finanzen: "#ffb35c",
  Eingang: "#56d2c2",
};

function farbe(gruppe: string): string {
  return GRUPPEN_FARBE[gruppe] ?? "#b4a6ff";
}

export function mountGraph(
  host: HTMLElement,
  daten: GraphDaten,
  opt: GraphOptionen,
): { setzeAktiv(pfad: string | null): void; zentriere(): void; loesen(): void } {
  const leinwand = document.createElement("canvas");
  leinwand.className = "g-leinwand";
  host.append(leinwand);
  const ctx = leinwand.getContext("2d") as CanvasRenderingContext2D;
  const netz: Netz = baueNetz(daten.knoten, daten.kanten);
  let aktiv = opt.aktiv ?? null;
  let schwebe: number | null = null;
  let breite = 0;
  let hoehe = 0;
  let dpr = 1;
  const kamera = { s: 1, x: 0, y: 0 };
  let laeuft = false;
  let ziehen: { art: "knoten"; i: number } | { art: "flaeche"; x: number; y: number } | null = null;
  let bewegt = false;
  let lebt = true;

  // Vorlauf ohne Zeichnen: der Graph steht schon beim ersten Bild fast still.
  for (let i = 0; i < (opt.lokal ? 160 : 140); i++) schritt(netz);

  const radius = (grad: number) => Math.min(14, 3.2 + Math.sqrt(grad) * 1.7);
  const zuBild = (x: number, y: number) => ({
    x: breite / 2 + kamera.x + x * kamera.s,
    y: hoehe / 2 + kamera.y + y * kamera.s,
  });
  const zuWelt = (x: number, y: number) => ({
    x: (x - breite / 2 - kamera.x) / kamera.s,
    y: (y - hoehe / 2 - kamera.y) / kamera.s,
  });

  function zentriere() {
    if (netz.knoten.length === 0 || breite === 0) return;
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const k of netz.knoten) {
      minX = Math.min(minX, k.x);
      maxX = Math.max(maxX, k.x);
      minY = Math.min(minY, k.y);
      maxY = Math.max(maxY, k.y);
    }
    const s = Math.min(
      2.2,
      (breite - 60) / Math.max(1, maxX - minX),
      (hoehe - 60) / Math.max(1, maxY - minY),
    );
    kamera.s = Math.max(0.15, s);
    kamera.x = -((minX + maxX) / 2) * kamera.s;
    kamera.y = -((minY + maxY) / 2) * kamera.s;
    zeichne();
  }

  function zeichne() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, breite, hoehe);
    const hervor = schwebe;
    const nah = hervor !== null ? netz.nachbarn[hervor] : null;
    const istHell = (i: number) => hervor === null || i === hervor || (nah?.has(i) ?? false);

    // Kanten
    ctx.lineWidth = 1;
    for (const { a, b } of netz.kanten) {
      const pa = zuBild(netz.knoten[a].x, netz.knoten[a].y);
      const pb = zuBild(netz.knoten[b].x, netz.knoten[b].y);
      const betont = hervor !== null && (a === hervor || b === hervor);
      ctx.strokeStyle = betont
        ? "rgba(244, 184, 96, 0.7)"
        : hervor !== null
          ? "rgba(232, 239, 241, 0.04)"
          : "rgba(232, 239, 241, 0.13)";
      ctx.lineWidth = betont ? 1.4 : 1;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }

    // Knoten
    netz.knoten.forEach((k, i) => {
      const p = zuBild(k.x, k.y);
      const r = radius(k.grad) * Math.max(0.7, Math.min(1.6, Math.sqrt(kamera.s)));
      ctx.globalAlpha = istHell(i) ? 1 : 0.18;
      ctx.fillStyle = farbe(k.gruppe);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      if (k.id === aktiv) {
        ctx.strokeStyle = "#f4b860";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 4, 0, Math.PI * 2);
        ctx.stroke();
      }
    });

    // Namen: beim Heranzoomen, an großen Knoten, an dem unter der Maus und seinen Nachbarn.
    ctx.font = `${opt.lokal ? 11 : 12}px Figtree, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    netz.knoten.forEach((k, i) => {
      const zeigen =
        opt.lokal ||
        k.id === aktiv ||
        (hervor !== null ? istHell(i) : kamera.s > 1.25 || k.grad >= 7);
      if (!zeigen) return;
      const p = zuBild(k.x, k.y);
      const r = radius(k.grad) * Math.max(0.7, Math.min(1.6, Math.sqrt(kamera.s)));
      ctx.globalAlpha = istHell(i) ? (i === hervor ? 1 : 0.82) : 0.12;
      ctx.fillStyle = i === hervor ? "#ffffff" : "#c9d4d8";
      const text = k.titel.length > 34 ? `${k.titel.slice(0, 33)}…` : k.titel;
      ctx.fillText(text, p.x, p.y + r + 4);
    });
    ctx.globalAlpha = 1;
  }

  function takt() {
    if (!lebt) return;
    const weiter = schritt(netz) || ziehen?.art === "knoten";
    zeichne();
    if (weiter) requestAnimationFrame(takt);
    else laeuft = false;
  }
  function wecke(waerme = 0.25) {
    netz.waerme = Math.max(netz.waerme, waerme);
    if (laeuft) return;
    laeuft = true;
    requestAnimationFrame(takt);
  }

  function treffer(px: number, py: number): number | null {
    let bester: number | null = null;
    let abstand = Number.POSITIVE_INFINITY;
    netz.knoten.forEach((k, i) => {
      const p = zuBild(k.x, k.y);
      const d = Math.hypot(p.x - px, p.y - py);
      const r = radius(k.grad) * Math.max(0.7, Math.min(1.6, Math.sqrt(kamera.s))) + 5;
      if (d < r && d < abstand) {
        bester = i;
        abstand = d;
      }
    });
    return bester;
  }

  const lage = (e: PointerEvent | WheelEvent) => {
    const r = leinwand.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  leinwand.addEventListener("pointerdown", (e) => {
    const p = lage(e);
    const i = treffer(p.x, p.y);
    bewegt = false;
    leinwand.setPointerCapture(e.pointerId);
    if (i !== null) {
      ziehen = { art: "knoten", i };
      netz.knoten[i].fest = true;
    } else {
      ziehen = { art: "flaeche", x: p.x, y: p.y };
    }
  });
  leinwand.addEventListener("pointermove", (e) => {
    const p = lage(e);
    if (ziehen?.art === "knoten") {
      const w = zuWelt(p.x, p.y);
      const k = netz.knoten[ziehen.i];
      k.x = w.x;
      k.y = w.y;
      bewegt = true;
      wecke(0.3);
      return;
    }
    if (ziehen?.art === "flaeche") {
      kamera.x += p.x - ziehen.x;
      kamera.y += p.y - ziehen.y;
      if (Math.abs(p.x - ziehen.x) + Math.abs(p.y - ziehen.y) > 1) bewegt = true;
      ziehen = { art: "flaeche", x: p.x, y: p.y };
      zeichne();
      return;
    }
    const i = treffer(p.x, p.y);
    if (i !== schwebe) {
      schwebe = i;
      leinwand.style.cursor = i === null ? "grab" : "pointer";
      zeichne();
    }
  });
  const loslassen = (e: PointerEvent) => {
    if (ziehen?.art === "knoten") {
      const k = netz.knoten[ziehen.i];
      k.fest = false;
      if (!bewegt) opt.onOeffne(k.id);
    }
    ziehen = null;
    if (leinwand.hasPointerCapture(e.pointerId)) leinwand.releasePointerCapture(e.pointerId);
  };
  leinwand.addEventListener("pointerup", loslassen);
  leinwand.addEventListener("pointercancel", loslassen);
  leinwand.addEventListener("pointerleave", () => {
    if (schwebe !== null && !ziehen) {
      schwebe = null;
      zeichne();
    }
  });
  leinwand.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const p = lage(e);
      const vorher = zuWelt(p.x, p.y);
      kamera.s = Math.min(5, Math.max(0.12, kamera.s * Math.exp(-e.deltaY * 0.0015)));
      const nachher = zuBild(vorher.x, vorher.y);
      kamera.x += p.x - nachher.x;
      kamera.y += p.y - nachher.y;
      zeichne();
    },
    { passive: false },
  );
  leinwand.addEventListener("dblclick", (e) => {
    const p = lage(e as unknown as PointerEvent);
    if (treffer(p.x, p.y) === null) zentriere();
  });

  const groesse = new ResizeObserver(() => {
    const r = host.getBoundingClientRect();
    const erstes = breite === 0;
    breite = Math.max(1, r.width);
    hoehe = Math.max(1, r.height);
    dpr = globalThis.devicePixelRatio || 1;
    leinwand.width = Math.round(breite * dpr);
    leinwand.height = Math.round(hoehe * dpr);
    leinwand.style.width = `${breite}px`;
    leinwand.style.height = `${hoehe}px`;
    if (erstes) zentriere();
    else zeichne();
  });
  groesse.observe(host);
  wecke(netz.waerme);

  return {
    setzeAktiv(pfad) {
      aktiv = pfad;
      zeichne();
    },
    zentriere,
    loesen() {
      lebt = false;
      groesse.disconnect();
      leinwand.remove();
    },
  };
}
