import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MarketsClient } from "./integrations/markets.js";

/**
 * Preisalarme (2026-09-27): „sag mir, wenn der DAX 25.600 kreuzt".
 *
 * **Die Richtung steht beim Anlegen fest.** Liegt der Kurs darunter, löst der Alarm aus,
 * sobald er die Marke erreicht oder übersteigt — und umgekehrt. Das ist TradingViews
 * „Kreuzt", ohne dass jemand „über" oder „unter" wählen muss, und es verhindert den häufigsten
 * Fehlgriff: einen Alarm „über 25.600" bei einem Kurs von 25.700, der sofort auslöst.
 *
 * **Geprüft wird der letzte Kurs im Minutentakt**, nicht jeder Tick — Yahoo liefert ohnehin
 * verzögert (Xetra 15 Minuten). Eine Spitze, die zwischen zwei Prüfungen über die Marke und
 * wieder zurück läuft, sieht dieser Alarm nicht. Das steht auch in der Oberfläche.
 *
 * Ein Alarm löst einmal aus und bleibt dann als „ausgelöst" stehen, bis Jakob ihn neu scharf
 * stellt oder löscht. Ein Alarm, der bei jedem Wackeln um die Marke erneut piept, wird
 * abgeschaltet und ist damit keiner mehr.
 */

export interface Alarm {
  id: string;
  symbol: string;
  /** Der Klarname zur Anzeige, wie er beim Anlegen galt. */
  name: string;
  preis: number;
  /** Aus dem Kurs beim Anlegen: liegt er darunter, wartet der Alarm auf „über". */
  richtung: "ueber" | "unter";
  angelegt: string;
  kursBeimAnlegen: number;
  notiz?: string;
  status: "aktiv" | "ausgeloest";
  ausgeloestAm?: string;
  ausgeloestKurs?: number;
}

export class AlarmFehler extends Error {}

export interface AlarmeAblage {
  liste(): Promise<Alarm[]>;
  lege(eintrag: {
    symbol: string;
    name?: string;
    preis: number;
    kurs: number;
    notiz?: string;
  }): Promise<Alarm>;
  loesche(id: string): Promise<boolean>;
  /** Wieder scharf stellen — mit dem Kurs von jetzt als neuer Seite. */
  scharf(id: string, kurs: number): Promise<Alarm | null>;
  /** Ausgelöste markieren. Gibt nur die zurück, die in diesem Aufruf ausgelöst haben. */
  pruefe(kurse: ReadonlyMap<string, number>): Promise<Alarm[]>;
}

const MAX_ALARME = 200;

/** Reine Prüfung: hat der Kurs die Marke in der erwarteten Richtung erreicht? */
export function loestAus(alarm: Pick<Alarm, "richtung" | "preis">, kurs: number): boolean {
  return alarm.richtung === "ueber" ? kurs >= alarm.preis : kurs <= alarm.preis;
}

export function richtungFuer(preis: number, kurs: number): "ueber" | "unter" {
  if (preis === kurs) {
    throw new AlarmFehler("Der Kurs steht schon genau dort — ein Alarm darauf löste sofort aus.");
  }
  return preis > kurs ? "ueber" : "unter";
}

export function createAlarme(deps: { workdir: string; jetzt?: () => Date }): AlarmeAblage {
  const datei = path.join(deps.workdir, "alarme.json");
  const jetzt = deps.jetzt ?? (() => new Date());
  // Eine Schreibkette: der Takt und die Oberfläche schreiben dieselbe Datei.
  let kette: Promise<unknown> = Promise.resolve();

  async function lies(): Promise<Alarm[]> {
    try {
      const roh = JSON.parse(await readFile(datei, "utf8"));
      return Array.isArray(roh.alarme) ? (roh.alarme as Alarm[]) : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async function schreibe(alarme: Alarm[]): Promise<void> {
    await mkdir(path.dirname(datei), { recursive: true });
    await writeFile(`${datei}.neu`, JSON.stringify({ alarme }, null, 2), "utf8");
    await rename(`${datei}.neu`, datei);
  }

  function nacheinander<T>(arbeit: () => Promise<T>): Promise<T> {
    const lauf = kette.then(arbeit, arbeit);
    kette = lauf.catch(() => undefined);
    return lauf;
  }

  return {
    liste: () => lies(),

    lege(eintrag) {
      return nacheinander(async () => {
        if (!Number.isFinite(eintrag.preis) || eintrag.preis <= 0) {
          throw new AlarmFehler("Ein Alarm braucht einen Preis über null.");
        }
        const alarme = await lies();
        if (alarme.length >= MAX_ALARME) throw new AlarmFehler(`Höchstens ${MAX_ALARME} Alarme.`);
        const alarm: Alarm = {
          id: `al-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
          symbol: eintrag.symbol.toUpperCase(),
          name: eintrag.name?.trim() || eintrag.symbol.toUpperCase(),
          preis: eintrag.preis,
          richtung: richtungFuer(eintrag.preis, eintrag.kurs),
          angelegt: jetzt().toISOString(),
          kursBeimAnlegen: eintrag.kurs,
          ...(eintrag.notiz?.trim() ? { notiz: eintrag.notiz.trim().slice(0, 300) } : {}),
          status: "aktiv",
        };
        await schreibe([...alarme, alarm]);
        return alarm;
      });
    },

    loesche(id) {
      return nacheinander(async () => {
        const alarme = await lies();
        const rest = alarme.filter((a) => a.id !== id);
        if (rest.length === alarme.length) return false;
        await schreibe(rest);
        return true;
      });
    },

    scharf(id, kurs) {
      return nacheinander(async () => {
        const alarme = await lies();
        const alarm = alarme.find((a) => a.id === id);
        if (!alarm) return null;
        alarm.richtung = richtungFuer(alarm.preis, kurs);
        alarm.kursBeimAnlegen = kurs;
        alarm.status = "aktiv";
        alarm.ausgeloestAm = undefined;
        alarm.ausgeloestKurs = undefined;
        await schreibe(alarme);
        return alarm;
      });
    },

    pruefe(kurse) {
      return nacheinander(async () => {
        const alarme = await lies();
        const neu: Alarm[] = [];
        for (const alarm of alarme) {
          if (alarm.status !== "aktiv") continue;
          const kurs = kurse.get(alarm.symbol.toUpperCase());
          if (kurs === undefined || !loestAus(alarm, kurs)) continue;
          alarm.status = "ausgeloest";
          alarm.ausgeloestAm = jetzt().toISOString();
          alarm.ausgeloestKurs = kurs;
          neu.push(alarm);
        }
        if (neu.length > 0) await schreibe(alarme);
        return neu;
      });
    },
  };
}

export interface AlarmTakt {
  stop(): void;
  /** Einmal prüfen, sofort. Für Tests und für „nach dem Anlegen gleich schauen". */
  jetzt(): Promise<Alarm[]>;
}

/**
 * Der Minutentakt. Er fragt nur die Werte ab, auf denen ein aktiver Alarm liegt, und ohne
 * aktive Alarme gar nichts.
 */
export function starteAlarmTakt(deps: {
  alarme: AlarmeAblage;
  markets: MarketsClient;
  melde: (alarm: Alarm) => void;
  taktMs?: number;
}): AlarmTakt {
  let laeuft = false;
  async function runde(): Promise<Alarm[]> {
    if (laeuft) return [];
    laeuft = true;
    try {
      const aktiv = (await deps.alarme.liste()).filter((a) => a.status === "aktiv");
      if (aktiv.length === 0) return [];
      const symbole = [...new Set(aktiv.map((a) => a.symbol.toUpperCase()))];
      const { quotes } = await deps.markets.quotes(symbole);
      const kurse = new Map(quotes.map((q) => [q.symbol.toUpperCase(), q.price]));
      const ausgeloest = await deps.alarme.pruefe(kurse);
      for (const alarm of ausgeloest) deps.melde(alarm);
      return ausgeloest;
    } catch (error) {
      console.log(
        `[alarme] Prüfung fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    } finally {
      laeuft = false;
    }
  }
  const uhr = setInterval(() => void runde(), deps.taktMs ?? 60_000);
  uhr.unref?.();
  return {
    stop: () => clearInterval(uhr),
    jetzt: runde,
  };
}

/** Der Satz, der beim Auslösen erscheint. */
export function alarmText(alarm: Alarm): string {
  const zahl = (w: number) =>
    w.toLocaleString("de-DE", { maximumFractionDigits: w >= 100 ? 2 : 5 });
  const satz =
    alarm.richtung === "ueber"
      ? `${alarm.name} hat ${zahl(alarm.preis)} erreicht`
      : `${alarm.name} ist auf ${zahl(alarm.preis)} gefallen`;
  return `${satz} — Kurs ${zahl(alarm.ausgeloestKurs ?? alarm.preis)}${alarm.notiz ? ` · ${alarm.notiz}` : ""}`;
}
