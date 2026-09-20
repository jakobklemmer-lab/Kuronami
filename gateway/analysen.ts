import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Das Analysen-Archiv.
 *
 * Eine Handelsidee wird vorgetragen und ist danach weg — sie steht im Gesprächsverlauf, den
 * niemand durchblättert, und bei Sprachbedienung nicht einmal dort. Jakob will sie aber vor
 * dem Trade noch einmal in Ruhe lesen können: „damit ich sie später nochmal überprüfen kann
 * und mir durchlesen kann, bevor ich den trade tatsächlich starte."
 *
 * Also wird jeder Bericht, der eine Einschätzung ist, hier abgelegt — mitsamt dem, was die
 * Spezialisten zugearbeitet haben. Gerade das ist der Teil, der sonst verschwindet: am
 * 2026-09-20 hat die Risikoprüfung den entscheidenden Einwand geliefert (SOL steht 55 % unter
 * dem Jahreshoch, das CRV auf das erste Ziel ist 0,86:1), und davon kam bei Jakob nur die
 * zusammengefasste Fassung an. Vor einem Einstieg mit echtem Geld will man das Original.
 *
 * Bewusst **nicht** archiviert: die Postfach-Sichtungen. Das sind fremde Nachrichten, keine
 * Analysen, und sie gehören nicht in einen zweiten Ablageort, der nie wieder aufgeräumt wird.
 */

/** Wer Analysen schreibt. Alle anderen Berichte sind Alltag und werden nicht abgelegt. */
const ARCHIVWUERDIG = new Set(["boerse", "recherche", "werkstatt"]);

export type AnalyseStatus = "offen" | "gehandelt" | "verworfen";

export interface AnalyseBeitrag {
  wer: string;
  frage: string;
  antwort: string;
}

export interface AnalyseKopf {
  id: string;
  /** ISO-Zeitpunkt der Ablage. */
  zeit: string;
  wer: string;
  titel: string;
  /** Der Auftrag, wie er an den Bediensteten ging. */
  auftrag: string;
  /** Steht im Bericht eine handelbare Idee — Einstieg, Stop, Ziel? */
  hatIdee: boolean;
  /** Welche Spezialisten zugearbeitet haben. */
  zuarbeit: string[];
  status: AnalyseStatus;
  kostenUsd: number;
  dauerMs: number;
}

export interface Analyse extends AnalyseKopf {
  bericht: string;
  beitraege: AnalyseBeitrag[];
  /** Was Jakob sich dazu notiert hat. */
  notiz?: string;
}

export interface AnalysenArchiv {
  lege(eintrag: {
    wer: string;
    auftrag: string;
    bericht: string;
    beitraege: AnalyseBeitrag[];
    kostenUsd: number;
    dauerMs: number;
  }): Promise<AnalyseKopf | null>;
  liste(grenze?: number): Promise<AnalyseKopf[]>;
  lies(id: string): Promise<Analyse | null>;
  /** Status oder Notiz ändern. Gibt den neuen Stand zurück, oder `null`, wenn es sie nicht gibt. */
  aendere(id: string, felder: { status?: AnalyseStatus; notiz?: string }): Promise<Analyse | null>;
}

export interface AnalysenDeps {
  workdir: string;
  /** Unterordner. Vorgabe `analysen`. */
  ordner?: string;
}

/**
 * Hat der Bericht eine Idee, die man handeln könnte?
 *
 * Absichtlich streng: erst wenn **Einstieg und Verlustbegrenzung** dastehen, ist es eine
 * Idee. „Bitcoin sieht stark aus" ist keine, und in einer Liste, in der alles markiert ist,
 * bedeutet die Markierung nichts.
 */
function erkenneIdee(bericht: string): boolean {
  const text = bericht.toLowerCase();
  const einstieg = /einstieg|entry|long bei|short bei/.test(text);
  const absicherung = /stop|verlustbegrenzung|sl /.test(text);
  return einstieg && absicherung;
}

/** Die erste Zeile, die als Überschrift taugt — ohne Auszeichnung, auf Länge gebracht. */
function titelAus(bericht: string, auftrag: string): string {
  for (const zeile of bericht.split("\n")) {
    const blank = zeile
      .replace(/[#*_`>]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (blank === "") continue;
    // Eine Überschrift ist eine Überschrift, auch eine kurze. Ohne Auszeichnung dagegen
    // wollen wir keine Zeile wie „Kurz:" oder „Fazit" als Titel — da steht die Aussage
    // erst darunter.
    const istUeberschrift = zeile.trimStart().startsWith("#");
    if (istUeberschrift || blank.length >= 8) {
      return blank.length > 90 ? `${blank.slice(0, 87)}…` : blank;
    }
  }
  const ersatz = auftrag.replace(/\s+/g, " ").trim();
  return ersatz.length > 90 ? `${ersatz.slice(0, 87)}…` : ersatz;
}

/** Sortierbar und im Dateinamen lesbar: 2026-09-20T16-13-36-123Z. */
function dateiZeit(d: Date): string {
  return d.toISOString().replace(/:/g, "-").replace(/\./g, "-");
}

export function createAnalysen(deps: AnalysenDeps): AnalysenArchiv {
  const ordner = path.join(deps.workdir, deps.ordner ?? "analysen");

  async function pfadeAlle(): Promise<string[]> {
    try {
      const dateien = await readdir(ordner);
      // Der Dateiname beginnt mit dem Zeitstempel, also sortiert der Name chronologisch.
      return dateien.filter((d) => d.endsWith(".json")).sort((a, b) => b.localeCompare(a));
    } catch {
      return [];
    }
  }

  async function leseDatei(datei: string): Promise<Analyse | null> {
    try {
      const roh = await readFile(path.join(ordner, datei), "utf8");
      return JSON.parse(roh) as Analyse;
    } catch {
      return null;
    }
  }

  async function dateiZu(id: string): Promise<string | null> {
    // Die Kennung steht am Ende des Dateinamens; nichts aus der Anfrage gerät in einen Pfad.
    if (!/^[0-9a-f]{12}$/.test(id)) return null;
    const alle = await pfadeAlle();
    return alle.find((d) => d.endsWith(`-${id}.json`)) ?? null;
  }

  function kopfVon(a: Analyse): AnalyseKopf {
    const { bericht: _bericht, beitraege: _beitraege, notiz: _notiz, ...kopf } = a;
    return kopf;
  }

  return {
    async lege(eintrag) {
      if (!ARCHIVWUERDIG.has(eintrag.wer)) return null;
      const jetzt = new Date();
      const id = Array.from(
        { length: 12 },
        () => "0123456789abcdef"[Math.floor(Math.random() * 16)],
      ).join("");
      const analyse: Analyse = {
        id,
        zeit: jetzt.toISOString(),
        wer: eintrag.wer,
        titel: titelAus(eintrag.bericht, eintrag.auftrag),
        auftrag: eintrag.auftrag,
        hatIdee: erkenneIdee(eintrag.bericht),
        zuarbeit: [...new Set(eintrag.beitraege.map((b) => b.wer))],
        status: "offen",
        kostenUsd: eintrag.kostenUsd,
        dauerMs: eintrag.dauerMs,
        bericht: eintrag.bericht,
        beitraege: eintrag.beitraege,
      };
      await mkdir(ordner, { recursive: true });
      await writeFile(
        path.join(ordner, `${dateiZeit(jetzt)}-${id}.json`),
        `${JSON.stringify(analyse, null, 2)}\n`,
        "utf8",
      );
      return kopfVon(analyse);
    },

    async liste(grenze = 50) {
      const dateien = (await pfadeAlle()).slice(0, grenze);
      const alle = await Promise.all(dateien.map(leseDatei));
      return alle.filter((a): a is Analyse => a !== null).map(kopfVon);
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
      const neu: Analyse = {
        ...alt,
        ...(felder.status ? { status: felder.status } : {}),
        ...(felder.notiz !== undefined ? { notiz: felder.notiz } : {}),
      };
      await writeFile(path.join(ordner, datei), `${JSON.stringify(neu, null, 2)}\n`, "utf8");
      return neu;
    },
  };
}
