import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Abschnitt, Kennzahlen, Strategie } from "./backtest.js";
import { nullEingeschlossen } from "./konfidenz.js";
import type { Uebertragbarkeit } from "./universum.js";

/**
 * Das Strategie-Archiv.
 *
 * Der Unterschied zum Analysen-Archiv ist der Unterschied zwischen einem Einfall und einem
 * Verfahren. Jakob hat ihn selbst gezogen: „Trades, über die ich mit dem Team diskutiere, sind
 * Einzeltrades, die aufgrund von Nachrichten ansetzen und die kein repetitives Pattern dahinter
 * haben, welches in einer Strategie gehandhabt werden könnte." Eine Strategie ist das Gegenteil:
 * eine Regel, die sich wiederholt, also auch prüfen lässt — und deren Ergebnis nicht aus einer
 * Meinung besteht, sondern aus Kennzahlen mit Datum.
 *
 * Deshalb liegt hier **immer die Regel samt ihrem Prüfergebnis**, nie die Regel allein. Eine
 * Strategie ohne Backtest ist ein Vorschlag; sie kommt in den Status `entwurf` und bleibt dort.
 *
 * **Was es hier nicht gibt: einen Knopf, der Geld bewegt.** Das Fernziel ist ein Agent, der eine
 * geprüfte Strategie selbst live handelt. Bis dahin fehlt eine Anbindung an einen Broker, und
 * dieser Ablageort tut nicht so, als gäbe es sie: der höchste Status ist `kandidat` — geprüft,
 * ungesehen bestanden, wartet auf Jakobs Entscheidung.
 */

export type StrategieStatus = "entwurf" | "geprueft" | "kandidat" | "verworfen";

/**
 * Was die Prüfung über **viele Märkte** ergeben hat, beim Ablegen mitgerechnet.
 *
 * Er steht hier und nicht nur im Bericht, weil eine Einstufung, die niemand wiederfindet, keine
 * Prüfung ist, sondern eine Erinnerung. Vorbild ist `crvGerechnet` im Analysen-Archiv: eine Zahl,
 * auf die Geld gesetzt werden könnte, gehört ins Archiv und an den Rand — nicht in den Verlauf
 * eines Gesprächs.
 *
 * `undefined` heißt **nicht** „hat nicht getragen", sondern „ist nicht gerechnet worden", und
 * genau so wird es auch angezeigt.
 */
export interface UniversumVermerk {
  einstufung: Uebertragbarkeit;
  /** Wie viele Märkte gerechnet werden konnten. */
  maerkte: number;
  /** Alle Handel aller Märkte zusammen. */
  gesamtHandel: number;
  gemeinsamErwartungswertR: number;
  /** Der gerechnete Satz dazu, im Wortlaut. */
  begruendung: string;
}

/**
 * Das Urteil der letzten Gegenprobe des Prüfers (`gegenprobe.ts`), seit 2026-09-27 am Eintrag.
 * Vorher ging es nur als Text an den Prüfer zurück — und woraus niemand lesen kann, daraus lernt
 * auch der Stratege nichts (`lehren.ts`).
 */
export interface GegenprobeVermerk {
  am: string;
  einstufung: "robust" | "wackelig" | "fragil";
  tragfaehig: number;
  gepruefte: number;
  behaltenMedian?: number;
  /** Die weiteren Märkte, falls welche mitgerechnet wurden. */
  maerkte: string[];
  /** Die Tabelle aller Varianten, wie der Prüfer sie gelesen hat. */
  tabelle: string;
}

export interface StrategieKopf {
  id: string;
  /** ISO-Zeitpunkt der Ablage. */
  zeit: string;
  name: string;
  wer: string;
  symbol: string;
  intervall: string;
  von: string;
  bis: string;
  status: StrategieStatus;
  kennzahlen: Kennzahlen | null;
  /** Wie viele Vorbehalte das Prüfergebnis trägt. Null heißt: keiner ist aufgefallen. */
  warnungen: number;
  /** Siehe `UniversumVermerk`: fehlt, wenn beim Ablegen kein weiterer Markt genannt wurde. */
  universum?: UniversumVermerk;
  /** Die letzte Gegenprobe; fehlt, solange keine lief. */
  gegenprobe?: GegenprobeVermerk;
  /**
   * ISO-Zeitpunkt der Ablage ins Archiv, oder fehlt: nicht archiviert.
   *
   * Jakob: „wir brauchen Archive für Strategien und Analysen, sonst müllt mir das die Website
   * zu" (2026-09-27). Archiviert wird nicht gelöscht — die Zeilen bleiben lesbar, `liste()`
   * blendet sie nur standardmäßig aus.
   */
  archiviert?: string;
}

export interface StrategieEintrag extends StrategieKopf {
  /** Die Regel selbst — vollständig, damit ein späterer Lauf sie wiederholen kann. */
  strategie: Strategie;
  inSample: Abschnitt | null;
  outOfSample: Abschnitt | null;
  warnungstexte: string[];
  /** Das Prüfergebnis im Wortlaut, wie es der Handelstisch gelesen hat. */
  bericht: string;
  notiz?: string;
}

export interface StrategienArchiv {
  lege(eintrag: {
    name: string;
    wer: string;
    symbol: string;
    intervall: string;
    von: string;
    bis: string;
    strategie: Strategie;
    kennzahlen: Kennzahlen | null;
    inSample: Abschnitt | null;
    outOfSample: Abschnitt | null;
    warnungstexte: string[];
    bericht: string;
    status?: StrategieStatus;
    universum?: UniversumVermerk;
  }): Promise<StrategieKopf>;
  /**
   * `mitArchiv` (Vorgabe `true`) entscheidet, ob Archiviertes mitgezählt wird — die alten
   * Aufrufer (Lernschleife, Chart) wollen die volle Geschichte, die Oberfläche ruft mit `false`.
   */
  liste(grenze?: number, mitArchiv?: boolean): Promise<StrategieKopf[]>;
  lies(id: string): Promise<StrategieEintrag | null>;
  aendere(
    id: string,
    felder: { status?: StrategieStatus; notiz?: string; gegenprobe?: GegenprobeVermerk },
  ): Promise<StrategieEintrag | null>;
  /** Ins Archiv legen. `null`, wenn es die Strategie nicht gibt. */
  archiviere(id: string): Promise<StrategieKopf | null>;
  /** Aus dem Archiv zurückholen. `null`, wenn es die Strategie nicht gibt. */
  zurueckhole(id: string): Promise<StrategieKopf | null>;
  /**
   * Legt `verworfen`e Strategien automatisch ins Archiv, sobald sie älter als `grenzeTage`
   * sind (Vorgabe 3). Gibt zurück, wie viele es waren.
   */
  archiviereAlte(grenzeTage?: number): Promise<number>;
}

export interface StrategienDeps {
  workdir: string;
  /** Unterordner. Vorgabe `strategien`. */
  ordner?: string;
}

/** Sortierbar und im Dateinamen lesbar. */
function dateiZeit(d: Date): string {
  return d.toISOString().replace(/:/g, "-").replace(/\./g, "-");
}

/**
 * Bestanden oder nicht — und zwar nach einer Regel, die vor dem Ergebnis feststeht.
 *
 * Ein Backtest, der erst nach dem Blick auf die Zahlen bewertet wird, bewertet sich selbst.
 * Deshalb steht die Schwelle hier im Code: genug Handel, positiver Erwartungswert, und der
 * ungesehene Teil muss den geschraubten tragen. Wer sie ändern will, ändert eine versionierte
 * Datei — nicht seine Meinung.
 */
export function bewerte(
  kennzahlen: Kennzahlen | null,
  outOfSample: Abschnitt | null,
  warnungen: readonly string[],
  universum?: UniversumVermerk,
): StrategieStatus {
  if (kennzahlen === null || kennzahlen.anzahl === 0) return "entwurf";
  if (kennzahlen.anzahl < 30) return "geprueft";
  if (kennzahlen.erwartungswertR <= 0) return "verworfen";
  const draussen = outOfSample?.kennzahlen;
  if (!draussen || draussen.anzahl < 5) return "geprueft";
  if (draussen.erwartungswertR <= 0) return "verworfen";
  // **Der Erwartungswert muss belegt sein, nicht nur positiv.** Schließt das 95-%-Intervall
  // die Null ein, war die Stichprobe eben so ausgefallen — das ist keine Kante, auf die Geld
  // gehört. Das macht `kandidat` deutlich schwerer erreichbar, und genau das ist die Absicht:
  // eine Strategie mit +0,2 R je Handel braucht über hundert Handel, bevor sich das von Zufall
  // unterscheiden lässt. Die Zahl steht als `noetigeHandel` im Bericht, damit aus der Hürde
  // ein Weg wird statt einer Wand.
  if (kennzahlen.konfidenz !== undefined && nullEingeschlossen(kennzahlen.konfidenz)) {
    return "geprueft";
  }
  // **Ein Einzelfall darf Kandidat werden — er muss nur als einer zu erkennen sein.** Kurz
  // stand hier eine Sperre: „Einzelfall" hieß, nie `kandidat`. Jakob hat das am 2026-09-21
  // umgedreht: „Es ist auch okay, wenn eine Strategie nur in einem Produkt läuft, muss dann
  // halt so gekennzeichnet sein." Das ist auch die ehrlichere Trennung — ob eine Kante nur im
  // DAX lebt, ist eine **Eigenschaft** der Regel und kein Mangel an ihrer Prüfung. Eine
  // Sperre hätte genau die Strategien aussortiert, auf die sein eigenes Regelwerk zielt.
  //
  // Die Kennzeichnung ist deshalb kein Beiwerk, sondern die Bedingung dafür, dass diese Zeile
  // so aussehen darf: der Vermerk steht am Kopf des Eintrags, als Marke in der Liste, als
  // Block im Blatt und im Wortlaut des Berichts — und fehlt er, steht auch das da.
  if (warnungen.length === 0 && kennzahlen.sharpe >= 1) return "kandidat";
  return "geprueft";
}

export function createStrategien(deps: StrategienDeps): StrategienArchiv {
  const ordner = path.join(deps.workdir, deps.ordner ?? "strategien");

  async function pfadeAlle(): Promise<string[]> {
    try {
      const dateien = await readdir(ordner);
      return dateien.filter((d) => d.endsWith(".json")).sort((a, b) => b.localeCompare(a));
    } catch {
      return [];
    }
  }

  async function leseDatei(datei: string): Promise<StrategieEintrag | null> {
    try {
      return JSON.parse(await readFile(path.join(ordner, datei), "utf8")) as StrategieEintrag;
    } catch {
      return null;
    }
  }

  async function dateiZu(id: string): Promise<string | null> {
    if (!/^[0-9a-f]{12}$/.test(id)) return null;
    return (await pfadeAlle()).find((d) => d.endsWith(`-${id}.json`)) ?? null;
  }

  function kopfVon(e: StrategieEintrag): StrategieKopf {
    const {
      strategie: _s,
      inSample: _i,
      outOfSample: _o,
      warnungstexte: _w,
      bericht: _b,
      notiz: _n,
      ...kopf
    } = e;
    return kopf;
  }

  return {
    async lege(eintrag) {
      const jetzt = new Date();
      const id = Array.from(
        { length: 12 },
        () => "0123456789abcdef"[Math.floor(Math.random() * 16)],
      ).join("");
      const voll: StrategieEintrag = {
        id,
        zeit: jetzt.toISOString(),
        name: eintrag.name,
        wer: eintrag.wer,
        symbol: eintrag.symbol,
        intervall: eintrag.intervall,
        von: eintrag.von,
        bis: eintrag.bis,
        status:
          eintrag.status ??
          bewerte(
            eintrag.kennzahlen,
            eintrag.outOfSample,
            eintrag.warnungstexte,
            eintrag.universum,
          ),
        kennzahlen: eintrag.kennzahlen,
        warnungen: eintrag.warnungstexte.length,
        ...(eintrag.universum === undefined ? {} : { universum: eintrag.universum }),
        strategie: eintrag.strategie,
        inSample: eintrag.inSample,
        outOfSample: eintrag.outOfSample,
        warnungstexte: eintrag.warnungstexte,
        bericht: eintrag.bericht,
      };
      await mkdir(ordner, { recursive: true });
      await writeFile(
        path.join(ordner, `${dateiZeit(jetzt)}-${id}.json`),
        `${JSON.stringify(voll, null, 2)}\n`,
        "utf8",
      );
      return kopfVon(voll);
    },

    async liste(grenze = 50, mitArchiv = true) {
      // Archiviertes steht zwischen dem übrigen Bestand, nicht am Ende — deshalb erst lesen und
      // filtern, dann auf die Grenze kürzen. Sonst würde eine alte archivierte Zeile einer
      // frischen, nicht archivierten den Platz in der Liste wegnehmen.
      const dateien = await pfadeAlle();
      const alle = await Promise.all(dateien.map(leseDatei));
      return alle
        .filter((e): e is StrategieEintrag => e !== null)
        .filter((e) => mitArchiv || !e.archiviert)
        .slice(0, grenze)
        .map(kopfVon);
    },

    async lies(id) {
      const datei = await dateiZu(id);
      return datei ? leseDatei(datei) : null;
    },

    async aendere(id, felder) {
      const datei = await dateiZu(id);
      if (!datei) return null;
      const alt = await leseDatei(datei);
      if (!alt) return null;
      const neu: StrategieEintrag = {
        ...alt,
        ...(felder.status ? { status: felder.status } : {}),
        ...(felder.notiz !== undefined ? { notiz: felder.notiz } : {}),
        ...(felder.gegenprobe ? { gegenprobe: felder.gegenprobe } : {}),
      };
      await writeFile(path.join(ordner, datei), `${JSON.stringify(neu, null, 2)}\n`, "utf8");
      return neu;
    },

    async archiviere(id) {
      const datei = await dateiZu(id);
      if (!datei) return null;
      const alt = await leseDatei(datei);
      if (!alt) return null;
      const neu: StrategieEintrag = { ...alt, archiviert: new Date().toISOString() };
      await writeFile(path.join(ordner, datei), `${JSON.stringify(neu, null, 2)}\n`, "utf8");
      return kopfVon(neu);
    },

    async zurueckhole(id) {
      const datei = await dateiZu(id);
      if (!datei) return null;
      const alt = await leseDatei(datei);
      if (!alt) return null;
      const { archiviert: _archiviert, ...neu } = alt;
      await writeFile(path.join(ordner, datei), `${JSON.stringify(neu, null, 2)}\n`, "utf8");
      return kopfVon(neu as StrategieEintrag);
    },

    async archiviereAlte(grenzeTage = 3) {
      const schwelle = Date.now() - grenzeTage * 24 * 60 * 60 * 1000;
      const dateien = await pfadeAlle();
      let anzahl = 0;
      for (const datei of dateien) {
        const eintrag = await leseDatei(datei);
        if (!eintrag || eintrag.archiviert || eintrag.status !== "verworfen") continue;
        if (new Date(eintrag.zeit).getTime() > schwelle) continue;
        const neu: StrategieEintrag = { ...eintrag, archiviert: new Date().toISOString() };
        await writeFile(path.join(ordner, datei), `${JSON.stringify(neu, null, 2)}\n`, "utf8");
        anzahl++;
      }
      return anzahl;
    },
  };
}
