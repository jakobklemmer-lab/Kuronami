import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * Das Verbrauchsbuch — wer im Haus wie viele Token verbraucht (2026-09-26).
 *
 * Bis hierher zeigte die System-Seite „Kosten je Agent und Tag", gefaltet aus dem
 * Ereignisprotokoll des alten Motors. Seit dem Motorwechsel am 18.09. schreibt niemand mehr
 * hinein; die Seite zeigte also sieben Tage lang „$0,00" — und selbst eine richtige Zahl wäre
 * die falsche gewesen: Kuro läuft über Jakobs Abo, der Dollarbetrag des SDK ist eine Schätzung
 * und keine Rechnung. Jakob: „die Kosten entfernen und dafür die session limits, token usage
 * usw abbilden, also quasi den orchestrator."
 *
 * Also zählt dieses Buch Token, keine Dollar: jeder Zug des Butlers und jeder Auftrag eines
 * Bediensteten (auch der Spezialisten am Handelstisch) als eine Zeile, abgelegt je Tag als
 * JSONL unter `verbrauch/` im Arbeitsbereich. Tage nach Wiener Zeit — ein Zug um 00:30 gehört
 * zu dem Tag, an dem Jakob ihn erlebt, nicht zu dem des Servers (UTC).
 */

export interface Posten {
  /** ISO-Zeitpunkt, an dem der Lauf endete. */
  zeit: string;
  /** `kuro`, ein Bediensteter oder ein Spezialist. */
  wer: string;
  /** Bei einem Spezialisten: in wessen Auftrag er arbeitete (`boerse`). */
  unter?: string;
  modell: string;
  /** Eingabe zum vollen Satz (`input_tokens`). */
  neu: number;
  cacheGelesen: number;
  cacheGeschrieben: number;
  ausgabe: number;
  /** Modellaufrufe in diesem Lauf. */
  schritte: number;
  dauerMs: number;
  ok: boolean;
  /** Nur bei Kuro: über welchen Kanal der Zug kam. */
  kanal?: string;
  /** Nur bei Kuro: wie groß der Prompt beim letzten Aufruf war — so voll ist sein Kontext. */
  kontext?: number;
  /** Das Kontextfenster des Modells, wie das SDK es meldet. */
  fenster?: number;
}

/** Die Summe über eine Menge Posten. */
export interface Summe {
  laeufe: number;
  neu: number;
  cacheGelesen: number;
  cacheGeschrieben: number;
  ausgabe: number;
  dauerMs: number;
  fehlgeschlagen: number;
}

export interface Uebersicht {
  /** Der älteste Tag, der im Buch steht — vorher wurde nicht gezählt. */
  seit: string | null;
  heute: Record<string, Summe>;
  woche: Record<string, Summe>;
  /** Die jüngsten Posten, neuester zuerst. */
  letzte: Posten[];
  /** Kuros jüngster Zug — daraus liest die Seite, wie voll sein Kontext ist. */
  kuro: Posten | null;
}

export interface Verbrauchsbuch {
  buche(posten: Posten): Promise<void>;
  /** Alle Posten der letzten `tage` Tage (einschließlich heute), ältester zuerst. */
  lies(tage: number, jetzt?: Date): Promise<Posten[]>;
  uebersicht(jetzt?: Date): Promise<Uebersicht>;
}

const ZEITZONE = "Europe/Vienna";
const TAG = new Intl.DateTimeFormat("sv-SE", {
  timeZone: ZEITZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Der Kalendertag in Wien, als `JJJJ-MM-TT`. */
export function tagVon(zeit: Date): string {
  return TAG.format(zeit);
}

/** Die letzten `n` Kalendertage bis `jetzt`, ältester zuerst. */
export function letzteTage(n: number, jetzt: Date): string[] {
  const tage: string[] = [];
  // Mittags gerechnet, damit kein Sprung der Sommerzeit einen Tag doppelt oder gar nicht trifft.
  const mittag = new Date(`${tagVon(jetzt)}T12:00:00Z`);
  for (let i = n - 1; i >= 0; i--) {
    tage.push(tagVon(new Date(mittag.getTime() - i * 86_400_000)));
  }
  return tage;
}

/**
 * Was ein abgeschlossener Lauf verbraucht hat, aus der Schlussmeldung des SDK.
 *
 * Auch ein gescheiterter Lauf (Budget, Rundenzahl) hat Token gekostet und zählt mit; `ok` sagt,
 * ob er zu Ende kam. Das Modell ist das mit der meisten Ausgabe — ein Lauf, der nebenbei ein
 * kleines Modell für eine Zusammenfassung ruft, gehört trotzdem dem, das geantwortet hat.
 */
export function ausErgebnis(
  r: SDKResultMessage,
): Pick<
  Posten,
  "modell" | "neu" | "cacheGelesen" | "cacheGeschrieben" | "ausgabe" | "schritte" | "ok" | "fenster"
> {
  const modelle = Object.entries(r.modelUsage ?? {}).sort(
    ([, a], [, b]) => b.outputTokens - a.outputTokens,
  );
  const [modell, haupt] = modelle[0] ?? ["?", undefined];
  return {
    modell,
    neu: r.usage.input_tokens ?? 0,
    cacheGelesen: r.usage.cache_read_input_tokens ?? 0,
    cacheGeschrieben: r.usage.cache_creation_input_tokens ?? 0,
    ausgabe: r.usage.output_tokens ?? 0,
    schritte: r.num_turns,
    ok: r.subtype === "success",
    ...(haupt?.contextWindow ? { fenster: haupt.contextWindow } : {}),
  };
}

export function leereSumme(): Summe {
  return {
    laeufe: 0,
    neu: 0,
    cacheGelesen: 0,
    cacheGeschrieben: 0,
    ausgabe: 0,
    dauerMs: 0,
    fehlgeschlagen: 0,
  };
}

function addiere(s: Summe, p: Posten): void {
  s.laeufe += 1;
  s.neu += p.neu;
  s.cacheGelesen += p.cacheGelesen;
  s.cacheGeschrieben += p.cacheGeschrieben;
  s.ausgabe += p.ausgabe;
  s.dauerMs += p.dauerMs;
  if (!p.ok) s.fehlgeschlagen += 1;
}

/** Die reine Faltung: Posten rein, Übersicht raus. Getrennt vom Lesen, damit sie prüfbar ist. */
export function fasse(posten: Posten[], jetzt: Date, grenze = 20): Uebersicht {
  const tage = letzteTage(7, jetzt);
  const heute = tage[tage.length - 1];
  const inWoche = new Set(tage);
  const uebersicht: Uebersicht = {
    seit: null,
    heute: {},
    woche: {},
    letzte: [],
    kuro: null,
  };

  for (const p of posten) {
    const tag = tagVon(new Date(p.zeit));
    if (uebersicht.seit === null || tag < uebersicht.seit) uebersicht.seit = tag;
    if (!inWoche.has(tag)) continue;
    uebersicht.woche[p.wer] ??= leereSumme();
    addiere(uebersicht.woche[p.wer], p);
    if (tag === heute) {
      uebersicht.heute[p.wer] ??= leereSumme();
      addiere(uebersicht.heute[p.wer], p);
    }
    if (p.wer === "kuro" && (!uebersicht.kuro || p.zeit > uebersicht.kuro.zeit)) {
      uebersicht.kuro = p;
    }
  }

  uebersicht.letzte = [...posten].sort((a, b) => b.zeit.localeCompare(a.zeit)).slice(0, grenze);
  return uebersicht;
}

/** Eine Zeile ist nur dann ein Posten, wenn die Felder da sind, mit denen gerechnet wird. */
function istPosten(x: unknown): x is Posten {
  if (typeof x !== "object" || x === null) return false;
  const p = x as Record<string, unknown>;
  return (
    typeof p.zeit === "string" &&
    typeof p.wer === "string" &&
    typeof p.neu === "number" &&
    typeof p.ausgabe === "number"
  );
}

export function createVerbrauch(opt: { workdir: string }): Verbrauchsbuch {
  const ordner = path.join(opt.workdir, "verbrauch");
  const datei = (tag: string) => path.join(ordner, `${tag}.jsonl`);

  const lies = async (tage: number, jetzt = new Date()): Promise<Posten[]> => {
    const gesucht = new Set(letzteTage(tage, jetzt));
    let namen: string[];
    try {
      namen = await readdir(ordner);
    } catch {
      return [];
    }
    const posten: Posten[] = [];
    for (const name of namen.sort()) {
      const tag = name.replace(/\.jsonl$/, "");
      if (!gesucht.has(tag)) continue;
      const inhalt = await readFile(datei(tag), "utf8").catch(() => "");
      for (const zeile of inhalt.split("\n")) {
        if (!zeile.trim()) continue;
        try {
          const p: unknown = JSON.parse(zeile);
          if (istPosten(p)) posten.push(p);
        } catch {
          // Eine halb geschriebene Zeile (Absturz mitten im Anhängen) kostet diese Zeile,
          // nicht den Tag.
        }
      }
    }
    return posten;
  };

  return {
    async buche(posten) {
      await mkdir(ordner, { recursive: true });
      await appendFile(datei(tagVon(new Date(posten.zeit))), `${JSON.stringify(posten)}\n`, "utf8");
    },
    lies,
    async uebersicht(jetzt = new Date()) {
      // Für `seit` genügt ein Blick auf die Dateinamen; gelesen werden nur die sieben Tage.
      const posten = await lies(7, jetzt);
      const uebersicht = fasse(posten, jetzt);
      try {
        const aeltester = (await readdir(ordner)).filter((n) => n.endsWith(".jsonl")).sort()[0];
        if (aeltester) uebersicht.seit = aeltester.replace(/\.jsonl$/, "");
      } catch {
        // Kein Ordner heißt: noch nichts gebucht.
      }
      return uebersicht;
    },
  };
}
