import { type SDKControlGetUsageResponse, query } from "@anthropic-ai/claude-agent-sdk";
import { nurEigeneServer } from "./abschottung.js";

/**
 * Die Grenzen des Abos, über das Kuro läuft (2026-09-26).
 *
 * Seit dem 18.09. zahlt kein API-Schlüssel mehr, Kuro läuft über Jakobs Claude-Abo. Was dort
 * zählt, ist kein Betrag, sondern zwei Fenster: das der Sitzung (fünf Stunden) und das der
 * Woche. Ist eines voll, antwortet Kuro nicht mehr — es gibt keinen Rückfall auf die API
 * (`kuronami-haushalt`). Genau das soll die System-Seite zeigen, bevor es passiert.
 *
 * Die Zahlen kommen aus derselben Quelle wie `/usage` in Claude Code: dem SDK, das sie beim
 * Nutzungsendpunkt von claude.ai erfragt. Dafür startet es einen Claude-Code-Prozess **ohne**
 * Nachricht — kein Modellaufruf, kein Token, gemessen rund zwei Sekunden. Deshalb wird die
 * Antwort eine Minute lang gehalten, und zwei Fragen in dieser Zeit teilen sich eine Abfrage. Ist
 * sie älter, geht trotzdem sofort der letzte Stand hinaus und die frische Abfrage läuft dahinter.
 *
 * Wichtig für jeden, der die Zahl vorliest: **sie gilt für das ganze Abo**, nicht nur für Kuro.
 * Wenn Jakob nebenbei in Claude Code arbeitet oder chattet, steigt sie auch. Kuros eigener
 * Anteil steht im Verbrauchsbuch (`verbrauch.ts`).
 *
 * Die Methode im SDK heißt ausdrücklich `…_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`.
 * Fällt sie weg oder ändert ihre Form, zeigt die Seite „nicht verfügbar" samt Grund — sie
 * rechnet nicht mit einer Zahl, die nicht kam.
 */

export interface Fenster {
  /** `sitzung`, `woche` oder eine Modellgruppe (`woche:Sonnet`). */
  id: string;
  name: string;
  /** Verbrauchter Anteil in Prozent, 0 bis 100. */
  prozent: number;
  /** ISO-Zeitpunkt, an dem das Fenster zurückgesetzt wird. */
  zurueck: string | null;
  /** Sagt der Anbieter, dass es knapp wird? */
  warnung: boolean;
}

export type AboStand =
  | {
      verfuegbar: true;
      /** `pro`, `max` … wie das SDK es nennt. */
      plan: string | null;
      fenster: Fenster[];
      /** Wofür das Wochenfenster verbraucht wurde (Claude Code, Chats …), wenn der Anbieter es sagt. */
      aufteilung: Array<{ name: string; prozent: number }>;
      /** Kann über die Grenze hinaus nachgekauft werden? */
      zusatz: boolean;
      stand: string;
    }
  | { verfuegbar: false; grund: string; stand: string };

type Rohdaten = Pick<SDKControlGetUsageResponse, "subscription_type" | "rate_limits_available"> & {
  rate_limits: Record<string, unknown> | null;
};

interface Grenze {
  kind?: string;
  group?: string;
  percent?: number;
  severity?: string;
  resets_at?: string | null;
  scope?: string | null;
}

const zahl = (x: unknown): number | null =>
  typeof x === "number" && Number.isFinite(x) ? x : null;
const text = (x: unknown): string | null => (typeof x === "string" && x !== "" ? x : null);

/**
 * Aus der Antwort des SDK die Fenster, die für Jakob zählen.
 *
 * Bevorzugt wird die Liste `limits`, die der Anbieter selbst ordnet und die auch sagt, ob es
 * knapp wird. Fehlt sie (ältere Antwort), stehen die beiden festen Felder `five_hour` und
 * `seven_day` dafür ein, dazu die Modellgruppen, falls das Abo welche hat.
 */
export function leseAbo(roh: Rohdaten, jetzt = new Date()): AboStand {
  const stand = jetzt.toISOString();
  if (!roh.rate_limits_available || !roh.rate_limits) {
    return {
      verfuegbar: false,
      grund: roh.subscription_type
        ? "Der Anbieter hat keine Grenzen gemeldet."
        : "Kuro läuft über einen API-Schlüssel — für ihn gelten keine Abo-Grenzen.",
      stand,
    };
  }
  const rl = roh.rate_limits;
  const fenster: Fenster[] = [];

  const liste = Array.isArray(rl.limits) ? (rl.limits as Grenze[]) : [];
  for (const g of liste) {
    const prozent = zahl(g.percent);
    if (prozent === null) continue;
    const warnung = g.severity !== undefined && g.severity !== "normal";
    if (g.group === "session") {
      fenster.push({
        id: "sitzung",
        name: "Sitzung",
        prozent,
        zurueck: text(g.resets_at),
        warnung,
      });
    } else if (g.kind === "weekly_all") {
      fenster.push({ id: "woche", name: "Woche", prozent, zurueck: text(g.resets_at), warnung });
    } else if (g.group === "weekly") {
      const wofuer = text(g.scope) ?? text(g.kind)?.replace(/^weekly_/, "") ?? "Modell";
      fenster.push({
        id: `woche:${wofuer}`,
        name: `Woche · ${wofuer}`,
        prozent,
        zurueck: text(g.resets_at),
        warnung,
      });
    }
  }

  if (fenster.length === 0) {
    const feld = (schluessel: string, id: string, name: string): void => {
      const f = rl[schluessel] as { utilization?: unknown; resets_at?: unknown } | null | undefined;
      const prozent = zahl(f?.utilization);
      if (prozent === null) return;
      fenster.push({ id, name, prozent, zurueck: text(f?.resets_at), warnung: prozent >= 80 });
    };
    feld("five_hour", "sitzung", "Sitzung");
    feld("seven_day", "woche", "Woche");
    feld("seven_day_sonnet", "woche:Sonnet", "Woche · Sonnet");
    feld("seven_day_opus", "woche:Opus", "Woche · Opus");
  }
  for (const m of Array.isArray(rl.model_scoped) ? rl.model_scoped : []) {
    const eintrag = m as { display_name?: unknown; utilization?: unknown; resets_at?: unknown };
    const name = text(eintrag.display_name);
    const prozent = zahl(eintrag.utilization);
    if (!name || prozent === null || fenster.some((f) => f.id === `woche:${name}`)) continue;
    fenster.push({
      id: `woche:${name}`,
      name: `Woche · ${name}`,
      prozent,
      zurueck: text(eintrag.resets_at),
      warnung: prozent >= 80,
    });
  }

  const zeilen = (rl.seven_day_breakdown as { rows?: unknown } | undefined)?.rows;
  const aufteilung = (Array.isArray(zeilen) ? zeilen : [])
    .map((z) => {
      const r = z as { display_name?: unknown; percent?: unknown };
      return { name: text(r.display_name) ?? "?", prozent: zahl(r.percent) ?? 0 };
    })
    .filter((z) => z.prozent > 0);

  const extra = rl.extra_usage as { is_enabled?: unknown } | null | undefined;

  return {
    verfuegbar: true,
    plan: roh.subscription_type ?? null,
    fenster,
    aufteilung,
    zusatz: extra?.is_enabled === true,
    stand,
  };
}

/** Eine Abfrage beim SDK: ein Prozess ohne Nachricht, der nur `/usage` beantwortet. */
async function frageSdk(cwd: string): Promise<Rohdaten> {
  let loese: () => void = () => {};
  // Der Prompt wartet für immer — der Prozess soll nichts ans Modell schicken, nur antworten.
  const stumm = (async function* () {
    await new Promise<void>((r) => {
      loese = r;
    });
  })();
  const q = query({
    prompt: stumm as never,
    options: { cwd, settingSources: [], ...nurEigeneServer() },
  });
  try {
    const antwort = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
      skipBehaviors: true,
    });
    return antwort as unknown as Rohdaten;
  } finally {
    loese();
    q.close();
  }
}

export interface AboGrenzen {
  /**
   * `frisch`: auf die Abfrage warten statt den letzten Stand zu nehmen, wenn der abgelaufen ist.
   * Für einen Takt, der danach entscheidet, ob er arbeitet (`lehrgang.ts`): der letzte Stand
   * kann Stunden alt sein, wenn die System-Seite seither niemand geöffnet hat.
   */
  lies(frisch?: boolean): Promise<AboStand>;
}

export function createAboGrenzen(opt: {
  cwd: string;
  /** Wie lange eine Antwort gilt. Vorgabe: eine Minute. */
  haltbarMs?: number;
  /** Für Tests: statt des SDK. */
  frage?: () => Promise<Rohdaten>;
}): AboGrenzen {
  const haltbar = opt.haltbarMs ?? 60_000;
  const frage = opt.frage ?? (() => frageSdk(opt.cwd));
  let letzte: { stand: AboStand; um: number } | null = null;
  let laufend: Promise<AboStand> | null = null;

  return {
    lies(frisch = false) {
      if (letzte && Date.now() - letzte.um < haltbar) return Promise.resolve(letzte.stand);
      laufend ??= (async () => {
        try {
          const stand = leseAbo(await frage());
          letzte = { stand, um: Date.now() };
          return stand;
        } catch (error) {
          const grund = error instanceof Error ? error.message : String(error);
          // Ein Fehler wird nicht gehalten: die nächste Frage versucht es wieder.
          return { verfuegbar: false as const, grund, stand: new Date().toISOString() };
        } finally {
          laufend = null;
        }
      })();
      const neu = laufend;
      // Ein älterer Stand geht sofort hinaus, die frische Abfrage läuft dahinter. Sonst wartete die
      // System-Seite bei jedem Besuch nach einer Minute Pause zwei Sekunden auf den Anbieter — und
      // die Karte sprang, wenn die Antwort kam. Der Stand trägt seine Uhrzeit, die Seite zeigt sie.
      return letzte && !frisch ? Promise.resolve(letzte.stand) : neu;
    },
  };
}
