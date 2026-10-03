import type { Zustand } from "../praesenz/sphaere.js";
import type { Arbeit } from "../welle/gespraech.js";
import { ZUSTAND_SATZ } from "../welle/zustand.js";

/**
 * Kuros Zeile in der Statuszeile (4c): was gerade geschieht, in einem Satz, und seit wann.
 * Wer im Haus die Arbeit tut, steht nicht da — Jakob will die Bediensteten nirgends aufgelistet
 * sehen, nur die Sache. Im Stand gibt es keine Zeile.
 */

export interface KuroZeile {
  text: string;
  seit: number;
}

const STILL: ReadonlySet<Zustand> = new Set(["ruhe", "offline"]);

/** Der Stand eines Auftrags; „übernimmt" sagt noch nichts, dann lieber der Auftrag selbst. */
function sache(a: Arbeit): string {
  const stand = a.stand.trim();
  if (stand && stand !== "übernimmt") return stand;
  return a.auftrag?.trim() || "Arbeitet an einem Auftrag";
}

function grossAnfang(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function kuroZeile(
  zustand: Zustand,
  detail: string | null,
  arbeit: ReadonlyMap<string, Arbeit>,
  zustandSeit: number,
): KuroZeile | null {
  if (arbeit.size > 0) {
    const auftraege = [...arbeit.values()].sort((a, b) => b.seit - a.seit);
    const neuester = auftraege[0] as Arbeit;
    const mehr = auftraege.length > 1 ? ` · und ${auftraege.length - 1} weitere` : "";
    const ersterSatz = sache(neuester).split("\n")[0] ?? "";
    return { text: `${grossAnfang(ersterSatz)}${mehr}`, seit: neuester.seit };
  }
  if (STILL.has(zustand)) return null;
  return { text: detail ?? ZUSTAND_SATZ[zustand], seit: zustandSeit };
}

/** „2:14", ab einer Stunde „1:02:14". */
export function uhrDauer(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}
