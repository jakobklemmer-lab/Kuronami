import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Richtung, rechneCrv } from "./crv.js";
import { messeHaltedauer } from "./haltedauer.js";
import type { MarketCandle } from "./integrations/markets.js";
import {
  type Wochenziel,
  euro,
  risikoEuro,
  wienerTag,
  wochenbeginn,
  wochenziel,
} from "./wochenziel.js";

/**
 * Das Prognosebuch: was ein Analyst behauptet hat, und was davon eingetreten ist.
 *
 * **Warum nicht einfach Gewinn und Verlust zählen.** Jakob handelt Einzelideen, keine
 * Strategien — ein Dutzend im Monat, wenn es viel ist. Bei der Stückzahl misst „hat der Trade
 * gewonnen" fast nur Zufall: im Archiv steht der Fall, in dem der gesamte Gewinn einer Regel an
 * **zwei Handeln von zwölf** hing. Wer einen Analysten daran misst, belohnt Glück und bestraft
 * Pech, und zwar jahrelang, bevor die Zahl etwas bedeutet.
 *
 * **Was bei kleiner Stückzahl trotzdem messbar ist, sind seine prüfbaren Aussagen.** Eine
 * Handelsidee behauptet mehr als „das geht gut aus": sie behauptet ein Chance-Risiko-Verhältnis
 * (reine Arithmetik — entweder gerechnet oder falsch), einen Auslöser, der eintreten soll, eine
 * Baseline, die nachrechenbar ist, eine Haltedauer, die gemessen werden kann, und einen Stop,
 * der halten soll. Das sind fünf bis sechs Noten je Idee statt einer, und keine davon hängt
 * daran, ob der Markt gerade freundlich war.
 *
 * **Verfolgt wird von Code, nicht von einem Agenten** — aus demselben Grund wie im
 * Papierhandel (`papierhandel.ts`): wer seine eigene Prognose benotet, benotet sie gut. Die
 * Zahlen kommen aus den Kerzen, der Analyst bekommt sie zu lesen.
 *
 * **Und es ist kein Papierhandel.** Der Papierhandel führt eine geprüfte Regel aus; hier wird
 * eine einzelne Behauptung nachgehalten. Diese Trennung ist Absicht: eine Einzelidee darf nie
 * wie ein geprüftes Verfahren aussehen, nur weil sie in einer Datei steht.
 */

/** Ab so vielen aufgelösten Prognosen wird das Ergebnis in R überhaupt genannt, ohne Vorbehalt. */
export const BELASTBAR_AB = 20;

/** Frist für den Auslöser, wenn die Prognose keine nennt. */
export const VORGABE_FRIST_TAGE = 30;

/** So lange wird eine offene Position verfolgt, bevor sie als unaufgelöst gilt. */
export const VORGABE_MAX_TAGE = 180;

/**
 * Über so viele Tage wird die Baseline nachgerechnet, wenn die Prognose kein Fenster nennt.
 *
 * **180 Tage ist kein runder Wert, sondern derselbe wie beim Werkzeug `crv`** — das holt
 * `chart(symbol, "6mo", "1d")` und misst die Baseline darüber. Wer hier ein anderes Fenster
 * einsetzt, benotet eine Aussage gegen eine Rechnung, die sie nie gemeint hat: zwei Jahre
 * BTC-Historie ergaben für dieselbe Geometrie 33,3 % statt der genannten 41 % — kein Fehler
 * des Analysten, ein anderer Ausschnitt. Genau so entsteht eine Note, die etwas anderes misst,
 * als sie behauptet.
 */
export const VORGABE_BASELINE_FENSTER_TAGE = 180;

export interface Prognose {
  id: string;
  /** ISO-Zeitpunkt der Ablage. Ab hier wird verfolgt — nie davor. */
  angelegt: string;
  /** Wer die Behauptung aufgestellt hat: `boerse`, ein Spezialist, oder `jakob`. */
  von: string;
  symbol: string;
  richtung: Richtung;
  /** Der Kurs, auf den gewartet wird. Ein Einstieg zum Marktpreis steht hier als jetziger Kurs. */
  ausloeser: number;
  /** In so vielen Tagen soll der Auslöser eintreten. Danach gilt die Idee als verfallen. */
  fristTage: number;
  stop: number;
  /** Ein bis drei Ziele, in der Reihenfolge, in der sie erreicht würden. Benotet wird das erste. */
  ziele: number[];

  // --- was behauptet wurde. Jedes Feld ist freiwillig; was fehlt, wird nicht benotet.
  /** Das behauptete Chance-Risiko-Verhältnis je Ziel. */
  crvBehauptet?: number[];
  /** Behauptete mittlere Haltedauer in Tagen. */
  haltedauerMedianTage?: number;
  /** Behauptete mittlere Hälfte, in Tagen. */
  haltedauerSpanneTage?: [number, number];
  /** Behauptete Trefferquote derselben Geometrie ohne Einstiegsregel, in Prozent. */
  baselineBehauptet?: number;
  /**
   * Über wie viele Tage die Baseline genannt wurde. Vorgabe `VORGABE_BASELINE_FENSTER_TAGE` —
   * dasselbe Fenster wie `crv`. Steht hier eine andere Zahl, wird gegen die benotet.
   */
  baselineFensterTage?: number;
  /** Woran die Idee scheitert. Freitext — Jakob beurteilt ihn, keine Maschine. */
  widerlegtWenn?: string;
  these?: string;
  /** Der Bericht im Analysen-Archiv, aus dem die Idee stammt. */
  analyseId?: string;
  notiz?: string;
}

export type PrognoseStand =
  /** Der Auslöser ist noch nicht erreicht, die Frist läuft. */
  | "wartet"
  /** Eingestiegen, weder Stop noch Ziel. */
  | "offen"
  | "ziel"
  | "stop"
  /** Der Auslöser kam nicht binnen Frist — die Idee ist nie zustande gekommen. */
  | "verfallen"
  /** Eingestiegen, aber nach `maxTage` weder Stop noch Ziel. */
  | "unaufgeloest";

export interface Verlauf {
  stand: PrognoseStand;
  /** Zeitstempel der letzten Kerze, die gelesen wurde. */
  standKerze: number | null;
  ausloeserAm: number | null;
  /** Kalendertage von der Ablage bis zum Auslöser. */
  ausloeserNachTagen: number | null;
  /**
   * Der Kurs, zu dem eine Grenzorder am Auslöser wirklich bekommen hätte. Öffnet die Kerze
   * jenseits des Auslösers, ist das der Eröffnungskurs — eine ruhende Kauforder bekommt den
   * besseren Preis, und das gehört in die Rechnung, nicht weggeglättet.
   */
  einstieg: number | null;
  ausstiegAm: number | null;
  ausstieg: number | null;
  haltedauerTage: number | null;
  /**
   * Die Kerze eröffnete bereits jenseits des Stops — der Ausstieg kostete mehr als das
   * gerechnete Risiko. Genau die Zahl, die eine CRV-Rechnung nicht kennt.
   */
  stopUebersprungen: boolean;
  /**
   * Ergebnis in R. Der Nenner ist das **geplante** Risiko (Auslöser bis Stop), weil in dieser
   * Einheit die Prognose gestellt wurde; der Zähler ist, was wirklich passiert ist.
   */
  r: number | null;
}

/** `null` heißt: nicht prüfbar — noch nicht, oder grundsätzlich nicht. Nie „gut genug". */
export type Zutreffend = boolean | null;

export interface Note {
  /** Kennung der Behauptungsart, für die Akte: `crv`, `ausloeser`, `stop`, `ziel`, … */
  art: string;
  frage: string;
  behauptet: string;
  eingetreten: string;
  zutreffend: Zutreffend;
}

export interface Benotung {
  prognoseId: string;
  von: string;
  symbol: string;
  geprueftAm: string;
  verlauf: Verlauf;
  noten: Note[];
}

export class PrognoseFehler extends Error {}

function tage(vonUnix: number, bisUnix: number): number {
  return Math.round(((bisUnix - vonUnix) / 86400) * 10) / 10;
}

function zahl(wert: number, stellen = 2): string {
  return wert.toLocaleString("de-DE", {
    minimumFractionDigits: stellen,
    maximumFractionDigits: stellen,
  });
}

/**
 * Den Verlauf aus den Kerzen lesen.
 *
 * Zwei Festlegungen sind dieselben wie im Backtest und in `haltedauer.ts`, damit keine Rechnung
 * im Haus freundlicher ist als die andere:
 *
 *  * **Der Stop schlägt das Ziel**, wenn beide in derselben Kerze liegen. Aus einer Tageskerze
 *    ist nicht ablesbar, was zuerst kam.
 *  * Geprüft wird ab der Kerze, die den Auslöser berührt — sie selbst eingeschlossen. Eine
 *    Idee, die am Einstiegstag ausgestoppt wird, ist ausgestoppt und nicht „noch offen".
 */
export function verfolge(
  prognose: Prognose,
  kerzen: readonly MarketCandle[],
  maxTage = VORGABE_MAX_TAGE,
): Verlauf {
  const start = Math.floor(Date.parse(prognose.angelegt) / 1000);
  if (!Number.isFinite(start)) {
    throw new PrognoseFehler(`"${prognose.angelegt}" ist kein Zeitpunkt.`);
  }
  const long = prognose.richtung === "long";
  const ziel = prognose.ziele[0];
  const reihe = kerzen
    .filter((k) => k.time >= start)
    .slice()
    .sort((a, b) => a.time - b.time);

  const leer: Verlauf = {
    stand: "wartet",
    standKerze: reihe.length > 0 ? reihe[reihe.length - 1].time : null,
    ausloeserAm: null,
    ausloeserNachTagen: null,
    einstieg: null,
    ausstiegAm: null,
    ausstieg: null,
    haltedauerTage: null,
    stopUebersprungen: false,
    r: null,
  };

  const geplantesRisiko = Math.abs(prognose.ausloeser - prognose.stop);
  if (geplantesRisiko === 0) {
    throw new PrognoseFehler("Auslöser und Stop sind derselbe Kurs — daraus wird kein Risiko.");
  }

  let ausloeserAm: number | null = null;
  let einstieg: number | null = null;

  for (const k of reihe) {
    if (einstieg === null) {
      if (tage(start, k.time) > prognose.fristTage) {
        return { ...leer, stand: "verfallen", standKerze: k.time };
      }
      const beruehrt = long ? k.low <= prognose.ausloeser : k.high >= prognose.ausloeser;
      if (!beruehrt) continue;
      ausloeserAm = k.time;
      einstieg = long ? Math.min(k.open, prognose.ausloeser) : Math.max(k.open, prognose.ausloeser);
    }

    const offen: Verlauf = {
      ...leer,
      stand: "offen",
      standKerze: reihe[reihe.length - 1].time,
      ausloeserAm,
      ausloeserNachTagen: tage(start, ausloeserAm as number),
      einstieg,
    };

    const stopTrifft = long ? k.low <= prognose.stop : k.high >= prognose.stop;
    const zielTrifft = long ? k.high >= ziel : k.low <= ziel;

    if (stopTrifft) {
      const uebersprungen = long ? k.open < prognose.stop : k.open > prognose.stop;
      const ausstieg = uebersprungen ? k.open : prognose.stop;
      const roh = long ? ausstieg - einstieg : einstieg - ausstieg;
      return {
        ...offen,
        stand: "stop",
        ausstiegAm: k.time,
        ausstieg,
        haltedauerTage: tage(ausloeserAm as number, k.time),
        stopUebersprungen: uebersprungen,
        r: Math.round((roh / geplantesRisiko) * 100) / 100,
      };
    }
    if (zielTrifft) {
      const roh = long ? ziel - einstieg : einstieg - ziel;
      return {
        ...offen,
        stand: "ziel",
        ausstiegAm: k.time,
        ausstieg: ziel,
        haltedauerTage: tage(ausloeserAm as number, k.time),
        r: Math.round((roh / geplantesRisiko) * 100) / 100,
      };
    }
    if (tage(ausloeserAm as number, k.time) > maxTage) {
      return { ...offen, stand: "unaufgeloest" };
    }
  }

  if (einstieg === null) return leer;
  return {
    ...leer,
    stand: "offen",
    ausloeserAm,
    ausloeserNachTagen: tage(start, ausloeserAm as number),
    einstieg,
  };
}

/**
 * Die Behauptungen benoten.
 *
 * `kerzen` ist die **ganze** Reihe, nicht nur die seit der Ablage: die Baseline wird über die
 * Vergangenheit nachgerechnet, der Verlauf über die Zukunft. Beide brauchen verschiedene
 * Ausschnitte derselben Daten.
 */
export function benote(prognose: Prognose, kerzen: readonly MarketCandle[]): Benotung {
  const verlauf = verfolge(prognose, kerzen);
  const noten: Note[] = [];
  const ziel = prognose.ziele[0];

  // --- 1. Das Chance-Risiko-Verhältnis. Reine Arithmetik, prüfbar am Tag der Ablage.
  const gerechnet = rechneCrv({
    richtung: prognose.richtung,
    einstieg: prognose.ausloeser,
    stop: prognose.stop,
    ziele: prognose.ziele,
  });
  const istCrv = gerechnet.ziele.map((z) => Math.round(z.crv * 100) / 100);
  if (prognose.crvBehauptet && prognose.crvBehauptet.length > 0) {
    const behauptet = prognose.crvBehauptet;
    const passt = behauptet.every(
      (wert, i) => i < istCrv.length && Math.abs(wert - istCrv[i]) <= 0.05,
    );
    noten.push({
      art: "crv",
      frage: "Stimmt das genannte Chance-Risiko-Verhältnis mit der eigenen Geometrie überein?",
      behauptet: behauptet.map((w) => `${zahl(w)}:1`).join(" / "),
      eingetreten: istCrv.map((w) => `${zahl(w)}:1`).join(" / "),
      zutreffend: passt,
    });
  } else {
    noten.push({
      art: "crv",
      frage: "Stimmt das genannte Chance-Risiko-Verhältnis mit der eigenen Geometrie überein?",
      behauptet: "nichts genannt",
      eingetreten: istCrv.map((w) => `${zahl(w)}:1`).join(" / "),
      zutreffend: null,
    });
  }

  // --- 2. Der Auslöser. Die häufigste stille Fehlprognose: die Idee kommt nie zustande.
  if (verlauf.ausloeserAm !== null) {
    noten.push({
      art: "ausloeser",
      frage: `Wird ${zahl(prognose.ausloeser)} binnen ${prognose.fristTage} Tagen erreicht?`,
      behauptet: `Einstieg bei ${zahl(prognose.ausloeser)}`,
      eingetreten:
        verlauf.einstieg !== null && verlauf.einstieg !== prognose.ausloeser
          ? `erreicht nach ${verlauf.ausloeserNachTagen} Tagen, gefüllt zu ${zahl(verlauf.einstieg)} (Kerze eröffnete jenseits)`
          : `erreicht nach ${verlauf.ausloeserNachTagen} Tagen`,
      zutreffend: true,
    });
  } else if (verlauf.stand === "verfallen") {
    noten.push({
      art: "ausloeser",
      frage: `Wird ${zahl(prognose.ausloeser)} binnen ${prognose.fristTage} Tagen erreicht?`,
      behauptet: `Einstieg bei ${zahl(prognose.ausloeser)}`,
      eingetreten: `in ${prognose.fristTage} Tagen nicht erreicht — die Idee kam nie zustande`,
      zutreffend: false,
    });
  } else {
    const seit =
      verlauf.standKerze !== null
        ? tage(Math.floor(Date.parse(prognose.angelegt) / 1000), verlauf.standKerze)
        : 0;
    noten.push({
      art: "ausloeser",
      frage: `Wird ${zahl(prognose.ausloeser)} binnen ${prognose.fristTage} Tagen erreicht?`,
      behauptet: `Einstieg bei ${zahl(prognose.ausloeser)}`,
      eingetreten: `wartet seit ${seit} von ${prognose.fristTage} Tagen`,
      zutreffend: null,
    });
  }

  // --- 3. Hält der Stop, was er verspricht? Nur prüfbar, wenn er überhaupt gegriffen hat.
  if (verlauf.stand === "stop") {
    noten.push({
      art: "stop",
      frage: "Begrenzt der Stop den Verlust auf das gerechnete Risiko?",
      behauptet: `Verlust begrenzt bei ${zahl(prognose.stop)} (−1,00 R)`,
      eingetreten: verlauf.stopUebersprungen
        ? `übersprungen — Ausstieg zu ${zahl(verlauf.ausstieg as number)}, ${zahl(Math.abs(verlauf.r as number))} R statt 1,00 R`
        : `gehalten — Ausstieg zu ${zahl(prognose.stop)}`,
      zutreffend: !verlauf.stopUebersprungen,
    });
  } else {
    noten.push({
      art: "stop",
      frage: "Begrenzt der Stop den Verlust auf das gerechnete Risiko?",
      behauptet: `Verlust begrenzt bei ${zahl(prognose.stop)}`,
      eingetreten: "noch nicht eingetreten",
      zutreffend: null,
    });
  }

  // --- 4. Das Ziel vor dem Stop.
  if (verlauf.stand === "ziel" || verlauf.stand === "stop") {
    noten.push({
      art: "ziel",
      frage: `Kommt ${zahl(ziel)} vor ${zahl(prognose.stop)}?`,
      behauptet: `Ziel ${zahl(ziel)}`,
      eingetreten:
        verlauf.stand === "ziel"
          ? `erreicht nach ${verlauf.haltedauerTage} Tagen, ${zahl(verlauf.r as number)} R`
          : `Stop zuerst, ${zahl(verlauf.r as number)} R`,
      zutreffend: verlauf.stand === "ziel",
    });
  } else {
    noten.push({
      art: "ziel",
      frage: `Kommt ${zahl(ziel)} vor ${zahl(prognose.stop)}?`,
      behauptet: `Ziel ${zahl(ziel)}`,
      eingetreten: verlauf.stand === "verfallen" ? "kein Einstieg" : "noch offen",
      zutreffend: null,
    });
  }

  // --- 5. Die Haltedauer.
  const dauerBehauptet =
    prognose.haltedauerSpanneTage ??
    (prognose.haltedauerMedianTage !== undefined
      ? ([prognose.haltedauerMedianTage / 2, prognose.haltedauerMedianTage * 2] as [number, number])
      : undefined);
  if (dauerBehauptet && verlauf.haltedauerTage !== null) {
    const [unten, oben] = dauerBehauptet;
    noten.push({
      art: "haltedauer",
      frage: "Löst sich die Idee in der genannten Zeit auf?",
      behauptet: prognose.haltedauerSpanneTage
        ? `${unten}–${oben} Tage`
        : `Median ${prognose.haltedauerMedianTage} Tage (geprüft wird die doppelte Spanne)`,
      eingetreten: `${verlauf.haltedauerTage} Tage`,
      zutreffend: verlauf.haltedauerTage >= unten && verlauf.haltedauerTage <= oben,
    });
  } else {
    noten.push({
      art: "haltedauer",
      frage: "Löst sich die Idee in der genannten Zeit auf?",
      behauptet: dauerBehauptet
        ? `${dauerBehauptet[0]}–${dauerBehauptet[1]} Tage`
        : "nichts genannt",
      eingetreten:
        verlauf.haltedauerTage === null ? "noch nicht aufgelöst" : `${verlauf.haltedauerTage} Tage`,
      zutreffend: null,
    });
  }

  // --- 6. Die Baseline. Nachrechenbar am Tag der Ablage — und genau deshalb wichtig: sie ist
  //        die Zahl, gegen die sich das Setup beweisen muss, und wird gern zu niedrig genannt.
  if (prognose.baselineBehauptet !== undefined) {
    const start = Math.floor(Date.parse(prognose.angelegt) / 1000);
    const fenster = prognose.baselineFensterTage ?? VORGABE_BASELINE_FENSTER_TAGE;
    const ab = start - fenster * 86_400;
    const vergangen = kerzen.filter((k) => k.time >= ab && k.time < start);
    if (vergangen.length >= 60) {
      try {
        const dauer = messeHaltedauer({
          kerzen: vergangen,
          richtung: prognose.richtung,
          einstieg: prognose.ausloeser,
          stop: prognose.stop,
          ziel,
        });
        const ist = Math.round(dauer.nullpunktTrefferquote * 1000) / 10;
        noten.push({
          art: "baseline",
          frage: "Stimmt die genannte Trefferquote derselben Geometrie ohne Einstiegsregel?",
          behauptet: `${zahl(prognose.baselineBehauptet, 1)} %`,
          eingetreten: `${zahl(ist, 1)} % über ${fenster} Tage (${dauer.faelle} Fälle)`,
          zutreffend: Math.abs(ist - prognose.baselineBehauptet) <= 5,
        });
      } catch {
        noten.push({
          art: "baseline",
          frage: "Stimmt die genannte Trefferquote derselben Geometrie ohne Einstiegsregel?",
          behauptet: `${zahl(prognose.baselineBehauptet, 1)} %`,
          eingetreten: "nicht nachrechenbar — die Kursgeschichte gibt die Geometrie nicht her",
          zutreffend: null,
        });
      }
    } else {
      noten.push({
        art: "baseline",
        frage: "Stimmt die genannte Trefferquote derselben Geometrie ohne Einstiegsregel?",
        behauptet: `${zahl(prognose.baselineBehauptet, 1)} %`,
        eingetreten: `nicht nachrechenbar — nur ${vergangen.length} Kerzen in den ${fenster} Tagen vor der Ablage`,
        zutreffend: null,
      });
    }
  }

  // --- 7. Das Widerlegungskriterium. Steht hier, weil es der Teil ist, den ein Analyst am
  //        leichtesten schwammig formuliert — und den nur ein Mensch beurteilen kann.
  if (prognose.widerlegtWenn) {
    noten.push({
      art: "widerlegt-wenn",
      frage: "Ist eingetreten, was die Idee widerlegen sollte?",
      behauptet: prognose.widerlegtWenn,
      eingetreten: "nicht maschinell prüfbar — Jakob beurteilt das",
      zutreffend: null,
    });
  }

  return {
    prognoseId: prognose.id,
    von: prognose.von,
    symbol: prognose.symbol,
    geprueftAm: new Date().toISOString(),
    verlauf,
    noten,
  };
}

// ---------------------------------------------------------------------------------- Die Akte

export interface AkteZeile {
  art: string;
  /** Wie oft diese Behauptungsart überhaupt entscheidbar war. */
  geprueft: number;
  zutreffend: number;
}

export interface Akte {
  von: string;
  prognosen: number;
  /** Prognosen, die Stop oder Ziel erreicht haben. */
  aufgeloest: number;
  /** Auslöser nie erreicht — die Idee kam nicht zustande. */
  verfallen: number;
  /** Wartet noch auf den Auslöser oder läuft. */
  laeuft: number;
  zeilen: AkteZeile[];
  rSumme: number | null;
  rMittel: number | null;
  /**
   * Reicht die Stückzahl, um aus dem Ergebnis in R etwas zu schließen? Unter `BELASTBAR_AB`
   * ist die Antwort nein, und die Zahl wird trotzdem genannt — mit diesem Vermerk daneben.
   */
  belastbar: boolean;
  /**
   * Die laufende Woche (ab Montag, Wien): was in ihr aufgelöst wurde, in R und in Euro nach
   * Jakobs Ein-Prozent-Regel. Das Wochenziel steht daneben als Beobachtung (`wochenziel.ts`).
   */
  woche: { ab: string; aufgeloest: number; rSumme: number; euro: number; zielEuro: number };
}

/**
 * Die Akte eines Analysten: nicht, wie viel er verdient hat, sondern wie oft er recht hatte.
 *
 * Die Trennung nach Behauptungsart ist der Punkt. „Sieben von neun" sagt nichts; „CRV 7/7
 * richtig gerechnet, Auslöser 2/6 erreicht" sagt, wo er gut ist und wo nicht — und das Zweite
 * ist eine Arbeitsanweisung, das Erste ein Stimmungsbild.
 */
export function akte(
  von: string,
  benotungen: readonly Benotung[],
  jetzt: Date = new Date(),
  ziel: Wochenziel = wochenziel(),
): Akte {
  const meine = benotungen.filter((b) => b.von === von);
  const nachArt = new Map<string, AkteZeile>();
  for (const b of meine) {
    for (const n of b.noten) {
      if (n.zutreffend === null) continue;
      const zeile = nachArt.get(n.art) ?? { art: n.art, geprueft: 0, zutreffend: 0 };
      zeile.geprueft += 1;
      if (n.zutreffend) zeile.zutreffend += 1;
      nachArt.set(n.art, zeile);
    }
  }
  const aufgeloest = meine.filter((b) => b.verlauf.stand === "ziel" || b.verlauf.stand === "stop");
  const rWerte = aufgeloest.map((b) => b.verlauf.r).filter((r): r is number => r !== null);
  const summe = rWerte.reduce((a, b) => a + b, 0);
  const ab = wochenbeginn(jetzt);
  const dieseWoche = aufgeloest.filter(
    (b) => b.verlauf.ausstiegAm !== null && wienerTag(b.verlauf.ausstiegAm) >= ab,
  );
  const wocheR = dieseWoche.reduce((a, b) => a + (b.verlauf.r ?? 0), 0);
  return {
    von,
    prognosen: meine.length,
    aufgeloest: aufgeloest.length,
    verfallen: meine.filter((b) => b.verlauf.stand === "verfallen").length,
    laeuft: meine.filter((b) => b.verlauf.stand === "wartet" || b.verlauf.stand === "offen").length,
    zeilen: [...nachArt.values()].sort((a, b) => a.art.localeCompare(b.art)),
    rSumme: rWerte.length > 0 ? Math.round(summe * 100) / 100 : null,
    rMittel: rWerte.length > 0 ? Math.round((summe / rWerte.length) * 100) / 100 : null,
    belastbar: rWerte.length >= BELASTBAR_AB,
    woche: {
      ab,
      aufgeloest: dieseWoche.length,
      rSumme: Math.round(wocheR * 100) / 100,
      euro: Math.round(wocheR * risikoEuro(ziel) * 100) / 100,
      zielEuro: ziel.zielEuro,
    },
  };
}

const STAND_TEXT: Record<PrognoseStand, string> = {
  wartet: "wartet auf den Auslöser",
  offen: "läuft",
  ziel: "Ziel erreicht",
  stop: "ausgestoppt",
  verfallen: "verfallen — Auslöser kam nicht",
  unaufgeloest: "unaufgelöst — weder Stop noch Ziel",
};

const ZEICHEN: Record<string, string> = { true: "ja", false: "nein", null: "offen" };

export function formatiereBenotung(b: Benotung): string {
  const zeilen = [
    `**${b.symbol}** · ${b.prognoseId} · von ${b.von} — ${STAND_TEXT[b.verlauf.stand]}`,
    "",
    "| Behauptung | gesagt | eingetreten | trifft zu |",
    "|---|---|---|---|",
  ];
  for (const n of b.noten) {
    zeilen.push(
      `| ${n.art} | ${n.behauptet} | ${n.eingetreten} | ${ZEICHEN[String(n.zutreffend)]} |`,
    );
  }
  if (b.verlauf.r !== null) {
    zeilen.push("", `Ergebnis: **${zahl(b.verlauf.r)} R** (geplantes Risiko als Einheit).`);
  }
  return zeilen.join("\n");
}

export function formatiereAkte(a: Akte): string {
  const zeilen = [
    `**Akte ${a.von}** — ${a.prognosen} Prognosen: ${a.aufgeloest} aufgelöst, ${a.verfallen} verfallen, ${a.laeuft} laufen.`,
    "",
    `Diese Woche (ab ${a.woche.ab.split("-").reverse().join(".")}): ${a.woche.aufgeloest} aufgelöst, ${zahl(a.woche.rSumme)} R = ${euro(a.woche.euro, true)} bei Jakobs Ein-Prozent-Regel. Sein Wochenziel von ${euro(a.woche.zielEuro)} ist eine Beobachtung, keine Vorgabe für die Positionsgröße.`,
    "",
  ];
  if (a.zeilen.length === 0) {
    zeilen.push("Noch nichts entscheidbar.");
    return zeilen.join("\n");
  }
  zeilen.push("| Behauptung | trifft zu | geprüft |", "|---|---|---|");
  for (const z of a.zeilen) {
    const quote = z.geprueft > 0 ? ` (${Math.round((z.zutreffend / z.geprueft) * 100)} %)` : "";
    zeilen.push(`| ${z.art} | ${z.zutreffend}${quote} | ${z.geprueft} |`);
  }
  if (a.rMittel !== null) {
    zeilen.push(
      "",
      a.belastbar
        ? `Ergebnis: **${zahl(a.rMittel)} R je Idee** über ${a.aufgeloest} aufgelöste.`
        : `Ergebnis: ${zahl(a.rMittel)} R je Idee über ${a.aufgeloest} aufgelöste — **das ist noch keine Aussage**, dafür braucht es ${BELASTBAR_AB}. Die Spalten darüber tragen schon jetzt.`,
    );
  }
  return zeilen.join("\n");
}

// -------------------------------------------------------------------------------- Die Ablage

export interface PrognosenDeps {
  workdir: string;
  /** Unterordner. Vorgabe `prognosen`. */
  ordner?: string;
  /** Die Kerzen für ein Symbol holen — von `angelegt` minus Vorlauf bis heute. */
  kerzen(symbol: string, vonUnix: number, bisUnix: number): Promise<MarketCandle[]>;
  jetzt?(): Date;
}

export interface Prognosenbuch {
  /** `fristTage` darf fehlen — dann gilt `VORGABE_FRIST_TAGE`. */
  lege(
    eintrag: Omit<Prognose, "id" | "angelegt" | "fristTage"> & {
      angelegt?: string;
      fristTage?: number;
    },
  ): Promise<Prognose>;
  liste(): Promise<Prognose[]>;
  lies(id: string): Promise<Prognose | null>;
  /** Eine Prognose gegen die Kerzen benoten. `null`, wenn es sie nicht gibt. */
  pruefe(id: string): Promise<Benotung | null>;
  /** Alle benoten — der Takt ruft das. */
  pruefeAlle(): Promise<Benotung[]>;
  akteVon(von: string): Promise<Akte>;
}

/** Die Baseline braucht Vergangenheit. Zwei Jahre Tageskerzen sind genug und kosten nichts. */
const VORLAUF_TAGE = 730;

export function createPrognosen(deps: PrognosenDeps): Prognosenbuch {
  const ordner = path.join(deps.workdir, deps.ordner ?? "prognosen");
  const jetzt = deps.jetzt ?? (() => new Date());

  async function alleDateien(): Promise<string[]> {
    try {
      const namen = await readdir(ordner);
      return namen.filter((n) => n.endsWith(".json")).sort();
    } catch {
      return [];
    }
  }

  async function lies(id: string): Promise<Prognose | null> {
    for (const name of await alleDateien()) {
      if (!name.includes(id)) continue;
      try {
        return JSON.parse(await readFile(path.join(ordner, name), "utf8")) as Prognose;
      } catch {
        return null;
      }
    }
    return null;
  }

  async function benoteEine(p: Prognose): Promise<Benotung> {
    const start = Math.floor(Date.parse(p.angelegt) / 1000);
    const kerzen = await deps.kerzen(
      p.symbol,
      start - VORLAUF_TAGE * 86400,
      Math.floor(jetzt().getTime() / 1000),
    );
    return benote(p, kerzen);
  }

  return {
    async lege(eintrag) {
      await mkdir(ordner, { recursive: true });
      const angelegt = eintrag.angelegt ?? jetzt().toISOString();
      const id = `${angelegt.slice(0, 10)}-${eintrag.symbol.replace(/[^A-Za-z0-9]/g, "")}-${Math.random()
        .toString(16)
        .slice(2, 8)}`;
      const prognose: Prognose = {
        ...eintrag,
        id,
        angelegt,
        fristTage: eintrag.fristTage || VORGABE_FRIST_TAGE,
      };
      // Die Geometrie wird beim Ablegen geprüft, nicht erst beim Benoten: ein Stop auf der
      // falschen Seite ergibt ein hübsches, falsches CRV, und wer das erst Wochen später
      // merkt, hat wochenlang eine Zahl geglaubt, die nie eine war.
      rechneCrv({
        richtung: prognose.richtung,
        einstieg: prognose.ausloeser,
        stop: prognose.stop,
        ziele: prognose.ziele,
      });
      await writeFile(path.join(ordner, `${id}.json`), JSON.stringify(prognose, null, 2), "utf8");
      return prognose;
    },

    async liste() {
      const alle: Prognose[] = [];
      for (const name of await alleDateien()) {
        try {
          alle.push(JSON.parse(await readFile(path.join(ordner, name), "utf8")) as Prognose);
        } catch {
          // Eine kaputte Datei nimmt nicht das ganze Buch mit.
        }
      }
      return alle.sort((a, b) => b.angelegt.localeCompare(a.angelegt));
    },

    lies,

    async pruefe(id) {
      const p = await lies(id);
      return p ? await benoteEine(p) : null;
    },

    async pruefeAlle() {
      const alle: Benotung[] = [];
      for (const p of await this.liste()) {
        try {
          alle.push(await benoteEine(p));
        } catch {
          // Ein Symbol ohne Kurse blockiert die anderen nicht.
        }
      }
      return alle;
    },

    async akteVon(von) {
      return akte(von, await this.pruefeAlle(), jetzt());
    },
  };
}
