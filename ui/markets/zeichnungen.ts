/**
 * Die Geometrie der Zeichenwerkzeuge — ohne `document`, damit sie geprüft werden kann. Die
 * Formen sind dieselben wie in `gateway/zeichnungen.ts`; gespeichert wird dort.
 *
 * Gezeichnet wird in **Zeit und Preis**. Damit eine Linie auf Tages- wie auf Stundenkerzen an
 * derselben Stelle steht, rechnet `logischeStelle` eine Zeit in eine (gebrochene) Kerzenstelle
 * um — auch zwischen zwei Kerzen und rechts hinter der letzten, wo es noch keine gibt.
 */

export interface Punkt {
  zeit: number;
  preis: number;
}

export type Zeichnung =
  | { id: string; art: "horizontal"; preis: number; notiz?: string }
  | { id: string; art: "trend"; a: Punkt; b: Punkt; notiz?: string }
  | { id: string; art: "rechteck"; a: Punkt; b: Punkt; notiz?: string }
  | { id: string; art: "fib"; a: Punkt; b: Punkt }
  | {
      id: string;
      art: "position";
      richtung: "long" | "short";
      a: Punkt;
      bisZeit: number;
      stop: number;
      ziel: number;
    }
  | { id: string; art: "text"; a: Punkt; text: string };

export type Werkzeug =
  | "zeiger"
  | "horizontal"
  | "trend"
  | "rechteck"
  | "fib"
  | "long"
  | "short"
  | "messen"
  | "text";

export function neueId(): string {
  return `z${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

// ------------------------------------------------------------------------------ Zeit ↔ Stelle

/**
 * Die gebrochene Kerzenstelle einer Zeit in einer aufsteigenden Zeitreihe. Zwischen zwei Kerzen
 * wird geteilt, vor der ersten und hinter der letzten mit dem Kerzenabstand weitergezählt.
 */
export function logischeStelle(zeit: number, zeiten: readonly number[], schritt: number): number {
  const n = zeiten.length;
  if (n === 0) return 0;
  const erste = zeiten[0] as number;
  const letzte = zeiten[n - 1] as number;
  if (zeit <= erste) return (zeit - erste) / schritt;
  if (zeit >= letzte) return n - 1 + (zeit - letzte) / schritt;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mitte = (lo + hi) >> 1;
    if ((zeiten[mitte] as number) <= zeit) lo = mitte;
    else hi = mitte;
  }
  const a = zeiten[lo] as number;
  const b = zeiten[hi] as number;
  return lo + (b === a ? 0 : (zeit - a) / (b - a));
}

/** Die Umkehrung: aus einer (gebrochenen) Stelle die Zeit. */
export function zeitAnStelle(stelle: number, zeiten: readonly number[], schritt: number): number {
  const n = zeiten.length;
  if (n === 0) return 0;
  const erste = zeiten[0] as number;
  const letzte = zeiten[n - 1] as number;
  if (stelle <= 0) return Math.round(erste + stelle * schritt);
  if (stelle >= n - 1) return Math.round(letzte + (stelle - (n - 1)) * schritt);
  const lo = Math.floor(stelle);
  const a = zeiten[lo] as number;
  const b = zeiten[lo + 1] as number;
  return Math.round(a + (stelle - lo) * (b - a));
}

// ------------------------------------------------------------------------------ Fibonacci

export const FIB_STUFEN = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;

/** Die Stufen von `a` (0 %) nach `b` (100 %) — gezogen wird wie bei TradingView vom Hoch zum Tief oder umgekehrt. */
export function fibStufen(a: Punkt, b: Punkt): { anteil: number; preis: number }[] {
  return FIB_STUFEN.map((anteil) => ({ anteil, preis: b.preis + (a.preis - b.preis) * anteil }));
}

// ------------------------------------------------------------------------------ Position

export interface PositionsZahlen {
  risiko: number;
  chance: number;
  /** Chance durch Risiko. `null`, wenn Stop oder Ziel auf der falschen Seite liegen. */
  crv: number | null;
  risikoProzent: number;
  chanceProzent: number;
  /** Ab welcher Trefferquote sich das trägt: 1/(1+CRV). */
  breakeven: number | null;
  stimmig: boolean;
}

/**
 * Die Zahlen einer Positionsidee, wie sie im Kasten stehen. Dieselbe Arithmetik wie
 * `gateway/crv.ts` — die ausführliche Rechnung mit ATR und 52-Wochen-Lage holt die Ansicht
 * von dort. Ein Stop auf der falschen Seite ergibt **kein** CRV, nicht ein negatives.
 */
export function positionsZahlen(p: {
  richtung: "long" | "short";
  einstieg: number;
  stop: number;
  ziel: number;
}): PositionsZahlen {
  const long = p.richtung === "long";
  const risiko = long ? p.einstieg - p.stop : p.stop - p.einstieg;
  const chance = long ? p.ziel - p.einstieg : p.einstieg - p.ziel;
  const stimmig = risiko > 0 && chance > 0;
  const crv = stimmig ? chance / risiko : null;
  return {
    risiko,
    chance,
    crv,
    risikoProzent: p.einstieg !== 0 ? (Math.abs(risiko) / p.einstieg) * 100 : 0,
    chanceProzent: p.einstieg !== 0 ? (Math.abs(chance) / p.einstieg) * 100 : 0,
    breakeven: crv !== null ? 1 / (1 + crv) : null,
    stimmig,
  };
}

/** Eine neue Positionsidee aus einem Klick: Stop und Ziel im Abstand einer Spanne, CRV 2. */
export function neuePosition(
  richtung: "long" | "short",
  a: Punkt,
  spanne: number,
  kerzenAbstand: number,
): Extract<Zeichnung, { art: "position" }> {
  const s = spanne > 0 ? spanne : a.preis * 0.01;
  return {
    id: neueId(),
    art: "position",
    richtung,
    a,
    bisZeit: a.zeit + kerzenAbstand * 20,
    stop: richtung === "long" ? a.preis - s : a.preis + s,
    ziel: richtung === "long" ? a.preis + 2 * s : a.preis - 2 * s,
  };
}

// ------------------------------------------------------------------------------ Messen

export interface Messung {
  differenz: number;
  prozent: number;
  kerzen: number;
  sekunden: number;
}

export function messe(a: Punkt, b: Punkt, kerzen: number): Messung {
  return {
    differenz: b.preis - a.preis,
    prozent: a.preis !== 0 ? ((b.preis - a.preis) / a.preis) * 100 : 0,
    kerzen: Math.round(kerzen),
    sekunden: b.zeit - a.zeit,
  };
}

/** „3 T 4 Std", „45 Min", „2 W 1 T" — für die Dauer einer Messung. */
export function dauerText(sekunden: number): string {
  const s = Math.abs(sekunden);
  const tage = Math.floor(s / 86_400);
  const stunden = Math.floor((s % 86_400) / 3600);
  const minuten = Math.round((s % 3600) / 60);
  if (tage >= 14) {
    const wochen = Math.floor(tage / 7);
    const rest = tage % 7;
    return rest > 0 ? `${wochen} W ${rest} T` : `${wochen} W`;
  }
  if (tage > 0) return stunden > 0 ? `${tage} T ${stunden} Std` : `${tage} T`;
  if (stunden > 0) return minuten > 0 ? `${stunden} Std ${minuten} Min` : `${stunden} Std`;
  return `${minuten} Min`;
}

// ------------------------------------------------------------------------------ Treffer

/** Abstand eines Punkts zu einer Strecke, in Pixeln. */
export function abstandZurStrecke(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const laenge2 = dx * dx + dy * dy;
  const t =
    laenge2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / laenge2));
  const fx = x1 + t * dx;
  const fy = y1 + t * dy;
  return Math.hypot(px - fx, py - fy);
}

/**
 * Der Magnet: liegt der Zeiger nah an Eröffnung, Hoch, Tief oder Schluss der Kerze darunter,
 * rastet er dort ein. `toleranz` in Preiseinheiten — die Ansicht rechnet sie aus Pixeln um.
 */
export function einrasten(
  preis: number,
  kerze: { open: number; high: number; low: number; close: number } | undefined,
  toleranz: number,
): number {
  if (!kerze) return preis;
  let bester = preis;
  let abstand = toleranz;
  for (const w of [kerze.open, kerze.high, kerze.low, kerze.close]) {
    const d = Math.abs(w - preis);
    if (d <= abstand) {
      abstand = d;
      bester = w;
    }
  }
  return bester;
}

// ------------------------------------------------------------------------------ Worte

function preisText(wert: number): string {
  return wert.toLocaleString("de-DE", { maximumFractionDigits: wert >= 100 ? 2 : 5 });
}

function datumText(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/** Eine Zeichnung als Satz — für die Frage an Kuro und die Liste im Chart. */
export function beschreibe(z: Zeichnung): string {
  switch (z.art) {
    case "horizontal":
      return `Linie bei ${preisText(z.preis)}${z.notiz ? ` („${z.notiz}")` : ""}`;
    case "trend":
      return `Trendlinie ${preisText(z.a.preis)} (${datumText(z.a.zeit)}) → ${preisText(z.b.preis)} (${datumText(z.b.zeit)})`;
    case "rechteck":
      return `Zone ${preisText(Math.min(z.a.preis, z.b.preis))}–${preisText(Math.max(z.a.preis, z.b.preis))}`;
    case "fib":
      return `Fibonacci ${preisText(z.a.preis)} → ${preisText(z.b.preis)}`;
    case "position": {
      const zahlen = positionsZahlen({
        richtung: z.richtung,
        einstieg: z.a.preis,
        stop: z.stop,
        ziel: z.ziel,
      });
      return `${z.richtung === "long" ? "Long" : "Short"}-Idee: Einstieg ${preisText(z.a.preis)}, Stop ${preisText(z.stop)}, Ziel ${preisText(z.ziel)}${zahlen.crv !== null ? ` (CRV ${zahlen.crv.toLocaleString("de-DE", { maximumFractionDigits: 2 })}:1)` : ""}`;
    }
    case "text":
      return `Notiz bei ${preisText(z.a.preis)}: ${z.text}`;
  }
}
