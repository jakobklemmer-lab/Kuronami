import { type Punkt, type Zeichnung, fibStufen, positionsZahlen } from "./zeichnungen.js";

/**
 * Was die Zeichenebene malt, als einfache Formen: Linien, Strecken, Kästen, Schrift. Jakobs
 * Zeichnungen und Kuros Arbeit (Ideen, Handel einer Strategie) werden beide hierzu — dann gibt
 * es genau einen Maler, und die Übersetzung in Formen ist ohne Leinwand prüfbar.
 */

export type Form =
  | {
      typ: "hlinie";
      preis: number;
      farbe: string;
      breite?: number;
      strich?: number[];
      text?: string;
      vonZeit?: number;
      bisZeit?: number;
    }
  | { typ: "strecke"; a: Punkt; b: Punkt; farbe: string; breite?: number; strich?: number[] }
  | { typ: "kasten"; a: Punkt; b: Punkt; fuellung: string; rand?: string }
  | { typ: "vlinie"; zeit: number; farbe: string; text?: string; strich?: number[]; zeile?: number }
  | {
      typ: "text";
      punkt: Punkt;
      text: string;
      farbe: string;
      grund?: string;
      ausrichtung?: "links" | "rechts" | "mitte";
      versatzY?: number;
    }
  | { typ: "griff"; punkt: Punkt; farbe: string };

export const FARBE = {
  linie: "#7fb2e5",
  zone: "rgba(127, 178, 229, 0.12)",
  zoneRand: "rgba(127, 178, 229, 0.55)",
  fib: "#c39be0",
  gewinn: "rgba(95, 201, 140, 0.16)",
  gewinnRand: "rgba(95, 201, 140, 0.75)",
  verlust: "rgba(224, 120, 127, 0.16)",
  verlustRand: "rgba(224, 120, 127, 0.75)",
  einstieg: "rgba(237, 240, 245, 0.85)",
  text: "rgba(237, 240, 245, 0.9)",
  leise: "rgba(237, 240, 245, 0.55)",
  griff: "#edf0f5",
  kuro: "#e3b56b",
} as const;

function zahl(wert: number, stellen: number): string {
  return wert.toLocaleString("de-DE", {
    minimumFractionDigits: stellen,
    maximumFractionDigits: stellen,
  });
}

function prozent(wert: number): string {
  return `${wert.toLocaleString("de-DE", { maximumFractionDigits: 2 })} %`;
}

/** Die Formen einer Zeichnung Jakobs. `gewaehlt` legt die Griffe dazu. */
export function formenFuer(z: Zeichnung, gewaehlt: boolean, stellen = 2): Form[] {
  const griffe = (...punkte: Punkt[]): Form[] =>
    gewaehlt ? punkte.map((punkt) => ({ typ: "griff", punkt, farbe: FARBE.griff }) as Form) : [];
  switch (z.art) {
    case "horizontal":
      return [
        {
          typ: "hlinie",
          preis: z.preis,
          farbe: FARBE.linie,
          breite: gewaehlt ? 2 : 1.5,
          text: z.notiz,
        },
      ];
    case "trend":
      return [
        { typ: "strecke", a: z.a, b: z.b, farbe: FARBE.linie, breite: gewaehlt ? 2 : 1.5 },
        ...griffe(z.a, z.b),
      ];
    case "rechteck":
      return [
        {
          typ: "kasten",
          a: z.a,
          b: z.b,
          fuellung: FARBE.zone,
          rand: gewaehlt ? FARBE.linie : FARBE.zoneRand,
        },
        ...(z.notiz
          ? [
              {
                typ: "text",
                punkt: {
                  zeit: Math.min(z.a.zeit, z.b.zeit),
                  preis: Math.max(z.a.preis, z.b.preis),
                },
                text: z.notiz,
                farbe: FARBE.text,
                ausrichtung: "links",
                versatzY: -8,
              } as Form,
            ]
          : []),
        ...griffe(z.a, z.b),
      ];
    case "fib": {
      const von = Math.min(z.a.zeit, z.b.zeit);
      const bis = Math.max(z.a.zeit, z.b.zeit);
      return [
        { typ: "strecke", a: z.a, b: z.b, farbe: FARBE.leise, breite: 1, strich: [4, 4] },
        ...fibStufen(z.a, z.b).map(
          (s) =>
            ({
              typ: "hlinie",
              preis: s.preis,
              farbe: FARBE.fib,
              breite: s.anteil === 0.5 || s.anteil === 0.618 ? 1.5 : 1,
              text: `${zahl(s.anteil * 100, 1)} % · ${zahl(s.preis, stellen)}`,
              vonZeit: von,
              bisZeit: bis,
            }) as Form,
        ),
        ...griffe(z.a, z.b),
      ];
    }
    case "position":
      return [
        ...positionsFormen({
          richtung: z.richtung,
          von: z.a.zeit,
          bis: z.bisZeit,
          einstieg: z.a.preis,
          stop: z.stop,
          ziele: [z.ziel],
          stellen,
        }),
        ...griffe(
          z.a,
          { zeit: z.bisZeit, preis: z.a.preis },
          { zeit: z.a.zeit, preis: z.stop },
          { zeit: z.a.zeit, preis: z.ziel },
        ),
      ];
    case "text":
      return [
        {
          typ: "text",
          punkt: z.a,
          text: z.text,
          farbe: FARBE.text,
          grund: "rgba(20, 28, 36, 0.8)",
          ausrichtung: "links",
        },
        ...griffe(z.a),
      ];
  }
}

/**
 * Ein Positionskasten wie bei TradingView: grün vom Einstieg zum Ziel, rot zum Stop, Zahlen
 * daran. Für Jakobs eigene Ideen und für die Ideen aus dem Prognosebuch derselbe Kasten.
 */
export function positionsFormen(p: {
  richtung: "long" | "short";
  von: number;
  bis: number;
  einstieg: number;
  stop: number;
  ziele: readonly number[];
  stellen?: number;
  /** Überschrift über dem Kasten, z. B. „boerse · wartet". */
  titel?: string;
  farbeTitel?: string;
}): Form[] {
  const stellen = p.stellen ?? 2;
  const ziel = p.ziele[p.ziele.length - 1] ?? p.einstieg;
  const erstes = p.ziele[0] ?? ziel;
  const zahlen = positionsZahlen({
    richtung: p.richtung,
    einstieg: p.einstieg,
    stop: p.stop,
    ziel: erstes,
  });
  const formen: Form[] = [
    {
      typ: "kasten",
      a: { zeit: p.von, preis: p.einstieg },
      b: { zeit: p.bis, preis: ziel },
      fuellung: FARBE.gewinn,
      rand: FARBE.gewinnRand,
    },
    {
      typ: "kasten",
      a: { zeit: p.von, preis: p.einstieg },
      b: { zeit: p.bis, preis: p.stop },
      fuellung: FARBE.verlust,
      rand: FARBE.verlustRand,
    },
    {
      typ: "hlinie",
      preis: p.einstieg,
      farbe: FARBE.einstieg,
      breite: 1.5,
      vonZeit: p.von,
      bisZeit: p.bis,
    },
  ];
  for (const z of p.ziele.slice(0, -1)) {
    formen.push({
      typ: "hlinie",
      preis: z,
      farbe: FARBE.gewinnRand,
      breite: 1,
      strich: [3, 3],
      vonZeit: p.von,
      bisZeit: p.bis,
    });
  }
  const zielText = zahlen.stimmig
    ? `Ziel ${zahl(erstes, stellen)} · ${prozent(zahlen.chanceProzent)} · CRV ${zahl(zahlen.crv as number, 2)}:1`
    : `Ziel ${zahl(erstes, stellen)} · liegt auf der falschen Seite`;
  const oben = p.richtung === "long" ? ziel : p.stop;
  const unten = p.richtung === "long" ? p.stop : ziel;
  formen.push(
    {
      typ: "text",
      punkt: { zeit: p.von, preis: oben },
      text:
        p.richtung === "long"
          ? zielText
          : `Stop ${zahl(p.stop, stellen)} · ${prozent(zahlen.risikoProzent)}`,
      farbe: FARBE.text,
      ausrichtung: "links",
      versatzY: -9,
    },
    {
      typ: "text",
      punkt: { zeit: p.von, preis: unten },
      text:
        p.richtung === "long"
          ? `Stop ${zahl(p.stop, stellen)} · ${prozent(zahlen.risikoProzent)}`
          : zielText,
      farbe: FARBE.text,
      ausrichtung: "links",
      versatzY: 11,
    },
    {
      typ: "text",
      punkt: { zeit: p.bis, preis: p.einstieg },
      text: `${p.richtung === "long" ? "Long" : "Short"} ${zahl(p.einstieg, stellen)}`,
      farbe: FARBE.text,
      ausrichtung: "rechts",
      versatzY: -8,
    },
  );
  if (p.titel) {
    formen.push({
      typ: "text",
      punkt: { zeit: p.von, preis: oben },
      text: p.titel,
      farbe: p.farbeTitel ?? FARBE.kuro,
      ausrichtung: "links",
      versatzY: -24,
    });
  }
  return formen;
}

// ------------------------------------------------------------------------------ Treffer und Ziehen

/** Welcher Teil einer Zeichnung getroffen ist. `ganz` heißt: die Zeichnung als Ganzes. */
export type Teil = "ganz" | "a" | "b" | "stop" | "ziel" | "ende";

export interface Umrechnung {
  x(zeit: number): number | null;
  y(preis: number): number | null;
}

const GRIFF_PX = 7;
const LINIE_PX = 5;

function nah(x1: number, y1: number, x2: number, y2: number, px = GRIFF_PX): boolean {
  return Math.hypot(x1 - x2, y1 - y2) <= px;
}

function streckenAbstand(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / l2));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Trifft der Zeiger (px, py) die Zeichnung? Griffe vor Flächen, wie man es erwartet. */
export function triff(z: Zeichnung, px: number, py: number, u: Umrechnung): Teil | null {
  const punkt = (p: Punkt) => {
    const x = u.x(p.zeit);
    const y = u.y(p.preis);
    return x === null || y === null ? null : { x, y };
  };
  switch (z.art) {
    case "horizontal": {
      const y = u.y(z.preis);
      return y !== null && Math.abs(py - y) <= LINIE_PX ? "ganz" : null;
    }
    case "trend":
    case "fib":
    case "rechteck": {
      const a = punkt(z.a);
      const b = punkt(z.b);
      if (!a || !b) return null;
      if (nah(px, py, a.x, a.y)) return "a";
      if (nah(px, py, b.x, b.y)) return "b";
      if (z.art === "trend")
        return streckenAbstand(px, py, a.x, a.y, b.x, b.y) <= LINIE_PX ? "ganz" : null;
      const innen =
        px >= Math.min(a.x, b.x) - LINIE_PX &&
        px <= Math.max(a.x, b.x) + LINIE_PX &&
        py >= Math.min(a.y, b.y) - LINIE_PX &&
        py <= Math.max(a.y, b.y) + LINIE_PX;
      return innen ? "ganz" : null;
    }
    case "position": {
      const x1 = u.x(z.a.zeit);
      const x2 = u.x(z.bisZeit);
      const ye = u.y(z.a.preis);
      const ys = u.y(z.stop);
      const yz = u.y(z.ziel);
      if (x1 === null || x2 === null || ye === null || ys === null || yz === null) return null;
      if (nah(px, py, x1, ys)) return "stop";
      if (nah(px, py, x1, yz)) return "ziel";
      if (nah(px, py, x2, ye)) return "ende";
      if (nah(px, py, x1, ye)) return "a";
      const innen =
        px >= Math.min(x1, x2) &&
        px <= Math.max(x1, x2) &&
        py >= Math.min(ys, yz) &&
        py <= Math.max(ys, yz);
      return innen ? "ganz" : null;
    }
    case "text": {
      const a = punkt(z.a);
      if (!a) return null;
      const breite = Math.max(40, z.text.length * 6.5);
      return px >= a.x - 4 && px <= a.x + breite && Math.abs(py - a.y) <= 10 ? "ganz" : null;
    }
  }
}

/** Den getroffenen Teil an einen neuen Ort ziehen. `von` ist der Punkt, an dem das Ziehen begann. */
export function ziehe(z: Zeichnung, teil: Teil, von: Punkt, nach: Punkt): Zeichnung {
  const dz = nach.zeit - von.zeit;
  const dp = nach.preis - von.preis;
  const schiebe = (p: Punkt): Punkt => ({ zeit: p.zeit + dz, preis: p.preis + dp });
  switch (z.art) {
    case "horizontal":
      return { ...z, preis: z.preis + dp };
    case "trend":
    case "rechteck":
    case "fib":
      if (teil === "a") return { ...z, a: nach };
      if (teil === "b") return { ...z, b: nach };
      return { ...z, a: schiebe(z.a), b: schiebe(z.b) };
    case "position":
      if (teil === "stop") return { ...z, stop: nach.preis };
      if (teil === "ziel") return { ...z, ziel: nach.preis };
      if (teil === "ende") return { ...z, bisZeit: Math.max(z.a.zeit + 1, nach.zeit) };
      if (teil === "a")
        return { ...z, a: { zeit: Math.min(nach.zeit, z.bisZeit - 1), preis: nach.preis } };
      return {
        ...z,
        a: schiebe(z.a),
        bisZeit: z.bisZeit + dz,
        stop: z.stop + dp,
        ziel: z.ziel + dp,
      };
    case "text":
      return { ...z, a: schiebe(z.a) };
  }
}
