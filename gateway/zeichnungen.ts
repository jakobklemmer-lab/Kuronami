import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Jakobs Zeichnungen im Chart der Märkte (2026-09-27): Linien, Zonen, Fibonacci und
 * Positionsideen, je Wert eine Datei unter `workspace/charts/`.
 *
 * **Warum im Gateway und nicht im Browser.** Zwei Gründe, beide von Jakob: er arbeitet am
 * Rechner und auf dem iPhone, und eine Linie, die nur in einem der beiden steht, ist eine
 * halbe Linie. Und Kuro soll sie kennen — „deine Marke bei 25.600" geht nur, wenn die Marke
 * irgendwo liegt, wo der Handelstisch sie lesen kann (`kurse.ts`, Werkzeug `zeichnungen`).
 *
 * Gezeichnet wird in **Zeit und Preis**, nicht in Kerzen: dieselbe Trendlinie steht auf
 * Tageskerzen und auf Stundenkerzen an derselben Stelle.
 */

export interface Punkt {
  /** Unix-Sekunden, UTC. */
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
      /** Einstieg: Zeit und Kurs. */
      a: Punkt;
      /** Bis wann die Idee gezeichnet ist — nur die Breite des Kastens. */
      bisZeit: number;
      stop: number;
      ziel: number;
    }
  | { id: string; art: "text"; a: Punkt; text: string };

export const ZEICHNUNG_ARTEN = [
  "horizontal",
  "trend",
  "rechteck",
  "fib",
  "position",
  "text",
] as const;

export interface Chartblatt {
  symbol: string;
  geaendert: string;
  zeichnungen: Zeichnung[];
}

export class ZeichnungFehler extends Error {}

const MAX_ZEICHNUNGEN = 300;

function zahl(wert: unknown, name: string): number {
  if (typeof wert !== "number" || !Number.isFinite(wert)) {
    throw new ZeichnungFehler(`${name} ist keine Zahl.`);
  }
  return wert;
}

function punkt(wert: unknown, name: string): Punkt {
  const p = (wert ?? {}) as Record<string, unknown>;
  return { zeit: zahl(p.zeit, `${name}.zeit`), preis: zahl(p.preis, `${name}.preis`) };
}

function kurztext(wert: unknown, max: number): string | undefined {
  if (typeof wert !== "string") return undefined;
  const t = wert.trim().slice(0, max);
  return t.length > 0 ? t : undefined;
}

/**
 * Prüft, was aus dem Browser kommt, und behält nur die bekannten Felder. Eine unbekannte Art
 * wird abgewiesen statt übergangen: sonst verschwände eine Zeichnung beim nächsten Speichern,
 * ohne dass es jemand merkt.
 */
export function pruefeZeichnungen(roh: unknown): Zeichnung[] {
  if (!Array.isArray(roh)) throw new ZeichnungFehler("zeichnungen muss eine Liste sein.");
  if (roh.length > MAX_ZEICHNUNGEN) {
    throw new ZeichnungFehler(`Höchstens ${MAX_ZEICHNUNGEN} Zeichnungen je Wert.`);
  }
  const ids = new Set<string>();
  return roh.map((eintrag, i) => {
    const z = (eintrag ?? {}) as Record<string, unknown>;
    const id = typeof z.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(z.id) ? z.id : null;
    if (id === null) throw new ZeichnungFehler(`Zeichnung ${i + 1} hat keine gültige Kennung.`);
    if (ids.has(id)) throw new ZeichnungFehler(`Die Kennung ${id} steht doppelt.`);
    ids.add(id);
    const notiz = kurztext(z.notiz, 300);
    const mitNotiz = notiz ? { notiz } : {};
    switch (z.art) {
      case "horizontal":
        return { id, art: "horizontal", preis: zahl(z.preis, "preis"), ...mitNotiz };
      case "trend":
      case "rechteck":
        return { id, art: z.art, a: punkt(z.a, "a"), b: punkt(z.b, "b"), ...mitNotiz };
      case "fib":
        return { id, art: "fib", a: punkt(z.a, "a"), b: punkt(z.b, "b") };
      case "position": {
        if (z.richtung !== "long" && z.richtung !== "short") {
          throw new ZeichnungFehler("Eine Position ist long oder short.");
        }
        return {
          id,
          art: "position",
          richtung: z.richtung,
          a: punkt(z.a, "a"),
          bisZeit: zahl(z.bisZeit, "bisZeit"),
          stop: zahl(z.stop, "stop"),
          ziel: zahl(z.ziel, "ziel"),
        };
      }
      case "text": {
        const text = kurztext(z.text, 500);
        if (!text) throw new ZeichnungFehler("Eine Notiz im Chart braucht Text.");
        return { id, art: "text", a: punkt(z.a, "a"), text };
      }
      default:
        throw new ZeichnungFehler(`Unbekannte Zeichnung "${String(z.art)}".`);
    }
  });
}

/** Dateiname aus dem Symbol: `^GDAXI` → `GDAXI`, `EURUSD=X` → `EURUSD_X`. */
export function dateinameFuer(symbol: string): string {
  const sauber = symbol
    .toUpperCase()
    .replace(/\^/g, "")
    .replace(/[^A-Z0-9.-]/g, "_");
  return `${sauber || "_"}.json`;
}

function datum(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Europe/Berlin",
  });
}

function preis(wert: number): string {
  return wert.toLocaleString("de-DE", { maximumFractionDigits: wert >= 100 ? 2 : 5 });
}

/**
 * Die Zeichnungen als Text — für Kuro und den Handelstisch. Wortlaut, den ein Analyst ohne
 * Rückfrage versteht: was gezogen ist, wo, und von wann bis wann.
 */
export function beschreibeZeichnungen(zeichnungen: readonly Zeichnung[]): string[] {
  return zeichnungen.map((z) => {
    const notiz = "notiz" in z && z.notiz ? ` („${z.notiz}")` : "";
    switch (z.art) {
      case "horizontal":
        return `Horizontale Linie bei ${preis(z.preis)}${notiz}`;
      case "trend":
        return `Trendlinie von ${preis(z.a.preis)} (${datum(z.a.zeit)}) nach ${preis(z.b.preis)} (${datum(z.b.zeit)})${notiz}`;
      case "rechteck":
        return `Zone ${preis(Math.min(z.a.preis, z.b.preis))}–${preis(Math.max(z.a.preis, z.b.preis))} vom ${datum(Math.min(z.a.zeit, z.b.zeit))} bis ${datum(Math.max(z.a.zeit, z.b.zeit))}${notiz}`;
      case "fib":
        return `Fibonacci-Retracement von ${preis(z.a.preis)} (${datum(z.a.zeit)}) bis ${preis(z.b.preis)} (${datum(z.b.zeit)})`;
      case "position":
        return `${z.richtung === "long" ? "Long" : "Short"}-Idee: Einstieg ${preis(z.a.preis)}, Stop ${preis(z.stop)}, Ziel ${preis(z.ziel)} (gezeichnet ab ${datum(z.a.zeit)})`;
      case "text":
        return `Notiz bei ${preis(z.a.preis)} (${datum(z.a.zeit)}): ${z.text}`;
    }
  });
}

export interface ZeichnungenAblage {
  lies(symbol: string): Promise<Chartblatt>;
  schreibe(symbol: string, zeichnungen: Zeichnung[]): Promise<Chartblatt>;
}

export function createZeichnungen(deps: {
  workdir: string;
  jetzt?: () => Date;
}): ZeichnungenAblage {
  const ordner = path.join(deps.workdir, "charts");
  const jetzt = deps.jetzt ?? (() => new Date());
  return {
    async lies(symbol) {
      try {
        const roh = JSON.parse(await readFile(path.join(ordner, dateinameFuer(symbol)), "utf8"));
        return {
          symbol,
          geaendert: typeof roh.geaendert === "string" ? roh.geaendert : "",
          zeichnungen: pruefeZeichnungen(roh.zeichnungen ?? []),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { symbol, geaendert: "", zeichnungen: [] };
        }
        throw error;
      }
    },
    async schreibe(symbol, zeichnungen) {
      await mkdir(ordner, { recursive: true });
      const blatt: Chartblatt = {
        symbol,
        geaendert: jetzt().toISOString(),
        zeichnungen: pruefeZeichnungen(zeichnungen),
      };
      // Erst daneben schreiben, dann umbenennen: ein Absturz mitten im Schreiben hinterlässt
      // die alte Fassung, nicht eine halbe Datei, die beim nächsten Lesen alles verliert.
      const ziel = path.join(ordner, dateinameFuer(symbol));
      await writeFile(`${ziel}.neu`, JSON.stringify(blatt, null, 2), "utf8");
      await rename(`${ziel}.neu`, ziel);
      return blatt;
    },
  };
}
