import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type Akte,
  type Benotung,
  type Prognose,
  type PrognoseStand,
  type Prognosenbuch,
  type Zutreffend,
  akte,
  formatiereAkte,
  formatiereBenotung,
} from "./prognosen.js";
import type { StrategieEintrag, StrategieKopf, StrategienArchiv } from "./strategien.js";

/**
 * Die Lernschleife des Handelstischs (2026-09-27) — Selbstverbesserung mit einem Tor davor.
 *
 * Jakob: „Wäre cool, wenn sich unsere Trading-Agenten selbst verbessern." Die Vorlage war Hermes
 * (Nous Research): ein Agent, der nach jeder Aufgabe seine eigenen Anleitungen umschreibt. Für
 * einen Handelstisch ist genau das die Gefahr — wer seine Regeln nach einem Dutzend Trades
 * umschreibt, lernt Rauschen, und keiner merkt es, weil die Anleitung danach klüger *klingt*.
 * Deshalb drei Dinge anders:
 *
 * 1. **Gelernt wird aus den Noten, nicht aus dem Ausgang.** Anlass ist eine aufgelöste Prognose
 *    (`prognosen.ts`); dem Analysten liegen die sechs gerechneten Noten vor — CRV, Auslöser,
 *    Stop, Ziel, Haltedauer, Baseline —, nicht bloß Gewinn oder Verlust. Trafen die Aussagen zu
 *    und nur der Markt war unfreundlich, ist „keine Lehre" die richtige Antwort.
 * 2. **Eine Lehre gilt erst, wenn Jakob sie freigibt.** Der Analyst schlägt vor; das Tor steht in
 *    der Oberfläche. Nur freigegebene Lehren kommen in seinen Prompt, höchstens `MAX_AKTIV`.
 * 3. **Ob sie wirkt, wird gerechnet.** Eine Lehre hängt an einer Behauptungsart. Seit ihrer
 *    Freigabe wird dieselbe Note weiter vergeben; `wirkung` vergleicht die Trefferquote davor und
 *    danach, mit Fehlerbalken — und sagt „noch keine Aussage", solange die Stückzahl nicht trägt.
 *    Dasselbe Muster wie beim CRV: nicht der Analyst beurteilt seine Lehre, die Rechnung tut es.
 *
 * Die Nachbetrachtung selbst schreibt ein Modell (`schreibe`); alles darum herum ist Code.
 *
 * **Zwei Quellen, derselbe Kreislauf.** Einzelideen lehren den Chefanalysten (`boerse`); die
 * Gegenprobe des Prüfers lehrt den Strategen (`stratege`) — eine Strategie, deren Varianten
 * zusammenfallen, ist an einen Zufall angepasst, und das ist eine Arbeitsanweisung für die
 * nächste. Seine Lehren hängen an der Note `gegenprobe`: robust oder nicht.
 */

/** Woran eine Lehre hängt: eine benotete Behauptungsart, oder `allgemein` — dann nicht messbar. */
export const LEHR_ARTEN = [
  "crv",
  "ausloeser",
  "stop",
  "ziel",
  "haltedauer",
  "baseline",
  "gegenprobe",
  "allgemein",
] as const;
export type LehrArt = (typeof LEHR_ARTEN)[number];

export const ART_NAME: Record<LehrArt, string> = {
  crv: "CRV",
  ausloeser: "Auslöser",
  stop: "Stop",
  ziel: "Ziel",
  haltedauer: "Haltedauer",
  baseline: "Baseline",
  gegenprobe: "Gegenprobe",
  allgemein: "allgemein",
};

/** Welche Arten wem offenstehen: der Analyst lernt an seinen Noten, der Stratege an der Gegenprobe. */
const ARTEN_FUER: Record<string, readonly LehrArt[]> = {
  stratege: ["gegenprobe", "allgemein"],
};
const ANALYST_ARTEN: readonly LehrArt[] = [
  "crv",
  "ausloeser",
  "stop",
  "ziel",
  "haltedauer",
  "baseline",
  "allgemein",
];
export const artenFuer = (an: string): readonly LehrArt[] => ARTEN_FUER[an] ?? ANALYST_ARTEN;

/**
 * So viele Lehren gelten höchstens gleichzeitig. Jede steht in jedem Auftrag der Börse im Prompt;
 * zwölf sind ein halbe Seite. Wer eine dreizehnte will, legt vorher eine ab — sichtbar, nicht
 * still: die älteste fällt nicht von selbst heraus.
 */
export const MAX_AKTIV = 12;

/** Unter so vielen benoteten Fällen seit der Freigabe sagt die Wirkung nichts. */
export const WIRKUNG_AB = 5;

/** So oft wird eine gescheiterte Nachbetrachtung wiederholt, dann bleibt es beim Fehler. */
const MAX_VERSUCHE = 3;

/** So viele Nachbetrachtungen je Takt — ein Stau nach langer Pause kommt in Raten. */
const JE_TAKT = 3;

/** Aufgelöst heißt: es gibt nichts mehr abzuwarten. */
const AUFGELOEST: readonly PrognoseStand[] = ["ziel", "stop", "verfallen", "unaufgeloest"];

export type LehrStatus = "vorgeschlagen" | "aktiv" | "verworfen" | "abgelegt";

export interface Lehre {
  id: string;
  angelegt: string;
  /** Wem sie gilt: der Absender der Prognose (`boerse`) oder der Verfasser der Strategie (`stratege`). */
  an: string;
  art: LehrArt;
  text: string;
  /** Der Wortlaut des Analysten, falls Jakob ihn beim Freigeben geändert hat. */
  vorschlag?: string;
  begruendung: string;
  /**
   * Woraus sie stammt, mit den Noten zu dem Zeitpunkt: eine Prognose (`prognoseId`, `stand` ist
   * ihr Ausgang) oder eine Strategie (`strategieId`, `stand` ist die Einstufung der Gegenprobe).
   */
  quelle: {
    prognoseId?: string;
    strategieId?: string;
    /** Bei einer Strategie ihr Name. */
    name?: string;
    symbol: string;
    stand: string;
    r: number | null;
    noten: { art: string; zutreffend: Zutreffend }[];
  };
  status: LehrStatus;
  /** Wann Jakob zuletzt entschieden hat. */
  entschieden?: string;
  /** Seit wann sie gilt — ab hier zählt die Wirkung. */
  aktivSeit?: string;
  notiz?: string;
}

/** Was aus einer Nachbetrachtung wurde — damit keine Prognose zweimal betrachtet wird. */
export interface Nachbetrachtung {
  am: string;
  ergebnis: "lehre" | "keine" | "fehler";
  lehreId?: string;
  grund?: string;
  versuche: number;
}

export class LehrFehler extends Error {}

// ------------------------------------------------------------------------------ Auswahl

/** Welche Prognosen jetzt nachbetrachtet werden: aufgelöst, nicht von Jakob, noch nicht erledigt. */
export function faellige(
  benotungen: readonly Benotung[],
  protokoll: Readonly<Record<string, Nachbetrachtung>>,
): Benotung[] {
  return benotungen.filter((b) => {
    if (b.von === "jakob") return false;
    if (!AUFGELOEST.includes(b.verlauf.stand)) return false;
    const vorher = protokoll[b.prognoseId];
    if (!vorher) return true;
    return vorher.ergebnis === "fehler" && vorher.versuche < MAX_VERSUCHE;
  });
}

/** Der Protokollschlüssel einer Gegenprobe: jede neue Gegenprobe ist ein neuer Anlass. */
export const gegenprobeSchluessel = (k: StrategieKopf): string =>
  `strategie:${k.id}@${k.gegenprobe?.am ?? ""}`;

/** Welche Strategien jetzt nachbetrachtet werden: gegengeprüft und noch nicht erledigt. */
export function faelligeStrategien(
  koepfe: readonly StrategieKopf[],
  protokoll: Readonly<Record<string, Nachbetrachtung>>,
): StrategieKopf[] {
  return koepfe.filter((k) => {
    if (!k.gegenprobe) return false;
    const vorher = protokoll[gegenprobeSchluessel(k)];
    if (!vorher) return true;
    return vorher.ergebnis === "fehler" && vorher.versuche < MAX_VERSUCHE;
  });
}

// ------------------------------------------------------------------------------ Die Antwort

export type Vorschlag =
  | { lehre: { art: LehrArt; text: string; begruendung: string } }
  | { lehre: null; grund: string };

/**
 * Die Antwort des Analysten lesen. Verlangt ist reines JSON; ein Satz davor oder ein Codeblock
 * drumherum wird verziehen, eine unbekannte Art oder ein leerer Text nicht — eine Lehre, die an
 * keiner Note hängt, die es gibt, ließe sich nie messen.
 */
export function leseVorschlag(
  antwort: string,
  erlaubt: readonly LehrArt[] = LEHR_ARTEN,
): Vorschlag {
  const anfang = antwort.indexOf("{");
  const ende = antwort.lastIndexOf("}");
  if (anfang < 0 || ende <= anfang) throw new LehrFehler("Keine JSON-Antwort.");
  let roh: unknown;
  try {
    roh = JSON.parse(antwort.slice(anfang, ende + 1));
  } catch {
    throw new LehrFehler("Die Antwort ist kein gültiges JSON.");
  }
  const o = (roh ?? {}) as Record<string, unknown>;
  if (o.lehre === null || o.lehre === undefined) {
    const grund = typeof o.grund === "string" ? o.grund.trim() : "";
    return { lehre: null, grund: grund.slice(0, 800) || "ohne Begründung" };
  }
  const l = o.lehre as Record<string, unknown>;
  const art = String(l.art ?? "").trim() as LehrArt;
  if (!erlaubt.includes(art)) throw new LehrFehler(`Unbekannte Art „${String(l.art)}".`);
  const text = typeof l.text === "string" ? l.text.trim() : "";
  if (!text) throw new LehrFehler("Die Lehre hat keinen Text.");
  const begruendung = typeof l.begruendung === "string" ? l.begruendung.trim() : "";
  return { lehre: { art, text: text.slice(0, 500), begruendung: begruendung.slice(0, 1200) } };
}

// ------------------------------------------------------------------------------ Die Wirkung

export interface Quote {
  geprueft: number;
  zutreffend: number;
}

export type Urteil =
  | "nicht-messbar"
  | "noch-keine-aussage"
  | "ohne-vergleich"
  | "wirkt"
  | "schadet"
  | "nicht-unterscheidbar";

export interface Wirkung {
  urteil: Urteil;
  vorher: Quote;
  seitdem: Quote;
  /** 95-%-Spanne der Quote seit der Freigabe (Wilson), in Anteilen. */
  spanne: [number, number] | null;
}

/**
 * Die Wilson-Spanne einer Quote. Bei kleinen Zahlen ehrlicher als „Anteil ± 2 Standardfehler",
 * das bei 5 von 5 eine Spanne bis 100 % und darüber ergäbe.
 */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [0, 1];
  const p = k / n;
  const nenner = 1 + (z * z) / n;
  const mitte = (p + (z * z) / (2 * n)) / nenner;
  const halb = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / nenner;
  return [Math.max(0, mitte - halb), Math.min(1, mitte + halb)];
}

/** Eine benotete Aussage: wer, wann (Ablage der Idee oder Strategie), welche Note, zutreffend? */
export interface Beobachtung {
  von: string;
  zeit: string;
  art: string;
  zutreffend: Zutreffend;
}

export function ausBenotungen(
  benotungen: readonly Benotung[],
  angelegt: ReadonlyMap<string, string>,
): Beobachtung[] {
  return benotungen.flatMap((b) =>
    b.noten.map((n) => ({
      von: b.von,
      zeit: angelegt.get(b.prognoseId) ?? "",
      art: n.art,
      zutreffend: n.zutreffend,
    })),
  );
}

/** Eine Gegenprobe ist eine Note: robust oder nicht. Gezählt ab der Ablage der Strategie. */
export function ausGegenproben(koepfe: readonly StrategieKopf[]): Beobachtung[] {
  return koepfe
    .filter((k) => k.gegenprobe)
    .map((k) => ({
      von: k.wer,
      zeit: k.zeit,
      art: "gegenprobe",
      zutreffend: k.gegenprobe?.einstufung === "robust",
    }));
}

function zaehle(beobachtungen: readonly Beobachtung[], passt: (b: Beobachtung) => boolean): Quote {
  const q: Quote = { geprueft: 0, zutreffend: 0 };
  for (const b of beobachtungen) {
    if (!passt(b) || b.zutreffend === null) continue;
    q.geprueft += 1;
    if (b.zutreffend) q.zutreffend += 1;
  }
  return q;
}

/**
 * Wirkt die Lehre? Verglichen wird dieselbe Note desselben Analysten vor und nach der Freigabe.
 * „Wirkt" heißt: die Quote davor liegt unter der Spanne der Quote danach — nicht bloß, dass die
 * Zahl gestiegen ist. Bei fünf Fällen steigt sie auch durch Zufall.
 */
export function wirkung(lehre: Lehre, beobachtungen: readonly Beobachtung[]): Wirkung | null {
  if (!lehre.aktivSeit) return null;
  const leer: Quote = { geprueft: 0, zutreffend: 0 };
  if (lehre.art === "allgemein")
    return { urteil: "nicht-messbar", vorher: leer, seitdem: leer, spanne: null };
  const seit = lehre.aktivSeit;
  const passt = (b: Beobachtung) => b.von === lehre.an && b.art === lehre.art;
  const vorher = zaehle(beobachtungen, (b) => passt(b) && b.zeit < seit);
  const seitdem = zaehle(beobachtungen, (b) => passt(b) && b.zeit >= seit);
  if (seitdem.geprueft < WIRKUNG_AB)
    return { urteil: "noch-keine-aussage", vorher, seitdem, spanne: null };
  const spanne = wilson(seitdem.zutreffend, seitdem.geprueft);
  if (vorher.geprueft === 0) return { urteil: "ohne-vergleich", vorher, seitdem, spanne };
  const quoteVorher = vorher.zutreffend / vorher.geprueft;
  const urteil: Urteil =
    quoteVorher < spanne[0]
      ? "wirkt"
      : quoteVorher > spanne[1]
        ? "schadet"
        : "nicht-unterscheidbar";
  return { urteil, vorher, seitdem, spanne };
}

// ------------------------------------------------------------------------------ Die Texte

export const NACHBETRACHTUNG_SYSTEM = `Du bist der Chefanalyst am Handelstisch von Kuronami und schaust auf eine deiner eigenen Handelsideen zurück, die jetzt abgeschlossen ist. Die Noten hat Code aus den Kerzen gerechnet, nicht du — sie stehen fest.

Deine Aufgabe: höchstens EINE Lehre für deine künftigen Ideen. Eine Lehre ist eine Arbeitsanweisung an dich selbst:
- prüfbar: festgemacht an einer Behauptungsart, die künftig wieder benotet wird — crv, ausloeser, stop, ziel, haltedauer, baseline. Passt keine, nimm "allgemein"; dann lässt sich ihre Wirkung nicht messen.
- konkret: sagt, was du künftig anders machst („Auslöser höchstens 1 ATR vom Kurs, wenn die Frist unter zehn Tagen liegt"), nicht, was du bedauerst.
- kurz: ein bis zwei Sätze.

Keine Lehre aus Pech: trafen deine prüfbaren Aussagen zu und nur der Ausgang war schlecht, ist die richtige Antwort „keine Lehre". Ein Stop, der wie geplant hielt, ist kein Fehler. Ebenso keine Lehre aus Glück: ein erreichtes Ziel bestätigt keine falsche Aussage.
Keine Lehre, die eine geltende wiederholt oder ihr widerspricht — dann „keine Lehre" mit Verweis auf die geltende.
Ein Einzelfall ist dünn. Zeigt deine Akte dieselbe Schwäche öfter, sag das in der Begründung; stützt nur dieser Fall die Lehre, sag auch das.

Jakob liest die Lehre und gibt sie frei oder verwirft sie. Erst freigegeben steht sie in deinem Prompt.

Antworte ausschließlich mit JSON, ohne Text davor oder danach:
{"lehre": {"art": "ausloeser", "text": "…", "begruendung": "…"}}
oder
{"lehre": null, "grund": "…"}`;

export function nachbetrachtungsPrompt(
  prognose: Prognose,
  benotung: Benotung,
  eigeneAkte: Akte,
  geltende: readonly Lehre[],
): string {
  const idee = [
    `Symbol ${prognose.symbol}, ${prognose.richtung === "long" ? "Long" : "Short"}, abgelegt am ${prognose.angelegt.slice(0, 10)}.`,
    `Auslöser ${prognose.ausloeser} binnen ${prognose.fristTage} Tagen, Stop ${prognose.stop}, Ziele ${prognose.ziele.join(" / ")}.`,
    prognose.these ? `These: ${prognose.these}` : "",
    prognose.widerlegtWenn ? `Widerlegt, wenn: ${prognose.widerlegtWenn}` : "",
  ].filter(Boolean);
  const lehren =
    geltende.length > 0 ? geltende.map((l) => `- [${l.art}] ${l.text}`).join("\n") : "(noch keine)";
  return [
    "## Die Idee",
    idee.join("\n"),
    "",
    "## Was eingetreten ist — gerechnet",
    formatiereBenotung(benotung),
    "",
    "## Deine Akte über alle Ideen",
    formatiereAkte(eigeneAkte),
    "",
    "## Deine geltenden Lehren",
    lehren,
  ].join("\n");
}

export const STRATEGE_SYSTEM = `Du bist der Stratege am Handelstisch von Kuronami. Der Prüfer hat eine deiner abgelegten Strategien gegengeprüft: dieselbe Regel mit verschobenen Perioden (±20 %), doppelten Kosten und gegebenenfalls an anderen Märkten. Die Einstufung — robust, wackelig, fragil — hat Code gerechnet, nicht du; sie steht fest.

Deine Aufgabe: höchstens EINE Lehre für deine künftigen Strategien. Eine Lehre ist eine Arbeitsanweisung an dich selbst, wie du Regeln baust, damit sie die Gegenprobe tragen:
- festgemacht an "gegenprobe" (ob künftige Strategien robust herauskommen — das wird gemessen) oder "allgemein", wenn sie das nicht trifft.
- konkret: was du beim Bauen anders machst („Parameter nur dort wählen, wo auch ±20 % tragen; bei einer Nadelspitze die Regel verwerfen statt ablegen"), nicht, was du bedauerst.
- kurz: ein bis zwei Sätze.

Keine Lehre aus einer robusten Gegenprobe, die nichts Neues zeigt. Keine Lehre, die eine geltende wiederholt oder ihr widerspricht — dann „keine Lehre" mit Verweis darauf. Stützt nur diese eine Strategie die Lehre, sag das in der Begründung; zeigt deine Bilanz dasselbe öfter, sag auch das.

Jakob liest die Lehre und gibt sie frei oder verwirft sie. Erst freigegeben steht sie in deinem Prompt.

Antworte ausschließlich mit JSON, ohne Text davor oder danach:
{"lehre": {"art": "gegenprobe", "text": "…", "begruendung": "…"}}
oder
{"lehre": null, "grund": "…"}`;

export function strategiePrompt(
  e: StrategieEintrag,
  alle: readonly StrategieKopf[],
  geltende: readonly Lehre[],
): string {
  const g = e.gegenprobe;
  const eigene = alle.filter((k) => k.wer === e.wer && k.gegenprobe);
  const zahl = (s: string) => eigene.filter((k) => k.gegenprobe?.einstufung === s).length;
  const lehren =
    geltende.length > 0 ? geltende.map((l) => `- [${l.art}] ${l.text}`).join("\n") : "(noch keine)";
  return [
    "## Die Strategie",
    `„${e.name}" auf ${e.symbol}, ${e.intervall}, geprüft ${e.von} bis ${e.bis}, Status ${e.status}.`,
    "```json",
    JSON.stringify(e.strategie, null, 1),
    "```",
    e.warnungstexte.length > 0 ? `Vorbehalte aus dem Backtest: ${e.warnungstexte.join(" · ")}` : "",
    e.universum ? `Übertragbarkeit: ${e.universum.einstufung} — ${e.universum.begruendung}` : "",
    "",
    "## Die Gegenprobe des Prüfers — gerechnet",
    g
      ? `${g.einstufung}: ${g.tragfaehig} von ${g.gepruefte} Varianten tragen.\n\n${g.tabelle}`
      : "(keine)",
    "",
    "## Deine Bilanz über alle gegengeprüften Strategien",
    `${eigene.length} gegengeprüft: ${zahl("robust")} robust, ${zahl("wackelig")} wackelig, ${zahl("fragil")} fragil.`,
    "",
    "## Deine geltenden Lehren",
    lehren,
  ]
    .filter((z) => z !== "")
    .join("\n");
}

/** Der Abschnitt im Prompt des Analysten. Leer, solange nichts gilt. */
export function lehrenAnhang(geltende: readonly Lehre[]): string {
  if (geltende.length === 0) return "";
  return [
    "",
    "",
    "## Deine Lehren — von Jakob freigegeben",
    "",
    "Das hast du aus deinen eigenen, benoteten Ideen gelernt, und Jakob hat es bestätigt. Halte",
    "dich daran. Weichst du bei einer Idee bewusst ab, nenne im Bericht die Lehre und den Grund.",
    "",
    ...geltende.map(
      (l, i) =>
        `${i + 1}. **${ART_NAME[l.art]}:** ${l.text} _(gilt seit ${(l.aktivSeit ?? l.angelegt).slice(0, 10)})_`,
    ),
  ].join("\n");
}

// ------------------------------------------------------------------------------ Die Ablage

export interface LehrenDeps {
  workdir: string;
  prognosen: Prognosenbuch;
  /** Das Strategie-Archiv — ohne es lernt der Stratege nicht mit. */
  strategien?: StrategienArchiv;
  /** Ein Modellaufruf: System und Aufgabe hinein, Text heraus — `wer` schreibt (`boerse`, `stratege`). */
  schreibe(system: string, prompt: string, wer: string): Promise<string>;
  jetzt?(): Date;
}

export interface LehreMitWirkung extends Lehre {
  wirkung: Wirkung | null;
}

export interface Lehrbuch {
  liste(): Promise<Lehre[]>;
  /** Mit der gerechneten Wirkung — holt Kerzen, also nicht für jeden Auftrag. */
  listeMitWirkung(): Promise<LehreMitWirkung[]>;
  geltende(an: string): Promise<Lehre[]>;
  /** Der Prompt-Abschnitt für einen Analysten; liest nur Dateien. */
  anhang(an: string): Promise<string>;
  /**
   * Jakobs Entscheidung. Erlaubt: vorgeschlagen → aktiv/verworfen, aktiv → abgelegt,
   * abgelegt/verworfen → aktiv. Den Wortlaut ändern nur beim Freigeben eines Vorschlags.
   */
  entscheide(
    id: string,
    was: { status: LehrStatus; text?: string; notiz?: string },
  ): Promise<Lehre | null>;
  /** Der Takt: aufgelöste Prognosen nachbetrachten. Gibt die neuen Vorschläge zurück. */
  nachbetrachte(): Promise<Lehre[]>;
  protokoll(): Promise<Record<string, Nachbetrachtung>>;
}

export function createLehren(deps: LehrenDeps): Lehrbuch {
  const ordner = path.join(deps.workdir, "lehren");
  const protokollDatei = path.join(ordner, "nachbetrachtungen.json");
  const jetzt = deps.jetzt ?? (() => new Date());
  let laeuft: Promise<Lehre[]> | null = null;

  async function liste(): Promise<Lehre[]> {
    let namen: string[] = [];
    try {
      namen = (await readdir(ordner)).filter(
        (n) => n.endsWith(".json") && n !== "nachbetrachtungen.json",
      );
    } catch {
      return [];
    }
    const alle: Lehre[] = [];
    for (const name of namen) {
      try {
        alle.push(JSON.parse(await readFile(path.join(ordner, name), "utf8")) as Lehre);
      } catch {
        // Eine kaputte Datei nimmt nicht das ganze Buch mit.
      }
    }
    return alle.sort((a, b) => b.angelegt.localeCompare(a.angelegt));
  }

  async function speichere(l: Lehre): Promise<void> {
    await mkdir(ordner, { recursive: true });
    await writeFile(path.join(ordner, `${l.id}.json`), JSON.stringify(l, null, 2), "utf8");
  }

  async function protokoll(): Promise<Record<string, Nachbetrachtung>> {
    try {
      return JSON.parse(await readFile(protokollDatei, "utf8")) as Record<string, Nachbetrachtung>;
    } catch {
      return {};
    }
  }

  async function geltende(an: string): Promise<Lehre[]> {
    return (await liste())
      .filter((l) => l.an === an && l.status === "aktiv")
      .sort((a, b) => (a.aktivSeit ?? "").localeCompare(b.aktivSeit ?? ""));
  }

  async function betrachte(): Promise<Lehre[]> {
    const [prognosen, benotungen, buch] = await Promise.all([
      deps.prognosen.liste(),
      deps.prognosen.pruefeAlle(),
      protokoll(),
    ]);
    const neue: Lehre[] = [];
    for (const b of faellige(benotungen, buch).slice(0, JE_TAKT)) {
      const prognose = prognosen.find((p) => p.id === b.prognoseId);
      if (!prognose) continue;
      const versuche = (buch[b.prognoseId]?.versuche ?? 0) + 1;
      const am = jetzt().toISOString();
      try {
        const antwort = await deps.schreibe(
          NACHBETRACHTUNG_SYSTEM,
          nachbetrachtungsPrompt(prognose, b, akte(b.von, benotungen), await geltende(b.von)),
          b.von,
        );
        const v = leseVorschlag(antwort, artenFuer(b.von));
        if (v.lehre === null) {
          buch[b.prognoseId] = { am, ergebnis: "keine", grund: v.grund, versuche };
          continue;
        }
        const lehre: Lehre = {
          id: `${am.slice(0, 10)}-${v.lehre.art}-${Math.random().toString(16).slice(2, 8)}`,
          angelegt: am,
          an: b.von,
          art: v.lehre.art,
          text: v.lehre.text,
          begruendung: v.lehre.begruendung,
          quelle: {
            prognoseId: b.prognoseId,
            symbol: b.symbol,
            stand: b.verlauf.stand,
            r: b.verlauf.r,
            noten: b.noten.map((n) => ({ art: n.art, zutreffend: n.zutreffend })),
          },
          status: "vorgeschlagen",
        };
        await speichere(lehre);
        neue.push(lehre);
        buch[b.prognoseId] = { am, ergebnis: "lehre", lehreId: lehre.id, versuche };
      } catch (fehler) {
        const grund = fehler instanceof Error ? fehler.message : String(fehler);
        buch[b.prognoseId] = { am, ergebnis: "fehler", grund: grund.slice(0, 300), versuche };
      }
    }
    // Die zweite Quelle: gegengeprüfte Strategien, im selben Takt und aus demselben Kontingent.
    const koepfe = deps.strategien ? await deps.strategien.liste(500) : [];
    const rest = Math.max(0, JE_TAKT - neue.length);
    for (const k of faelligeStrategien(koepfe, buch).slice(0, rest)) {
      const schluessel = gegenprobeSchluessel(k);
      const versuche = (buch[schluessel]?.versuche ?? 0) + 1;
      const am = jetzt().toISOString();
      try {
        const eintrag = await deps.strategien?.lies(k.id);
        if (!eintrag?.gegenprobe) continue;
        const antwort = await deps.schreibe(
          STRATEGE_SYSTEM,
          strategiePrompt(eintrag, koepfe, await geltende(k.wer)),
          k.wer,
        );
        const v = leseVorschlag(antwort, artenFuer(k.wer));
        if (v.lehre === null) {
          buch[schluessel] = { am, ergebnis: "keine", grund: v.grund, versuche };
          continue;
        }
        const lehre: Lehre = {
          id: `${am.slice(0, 10)}-${v.lehre.art}-${Math.random().toString(16).slice(2, 8)}`,
          angelegt: am,
          an: k.wer,
          art: v.lehre.art,
          text: v.lehre.text,
          begruendung: v.lehre.begruendung,
          quelle: {
            strategieId: k.id,
            name: k.name,
            symbol: k.symbol,
            stand: eintrag.gegenprobe.einstufung,
            r: k.kennzahlen?.erwartungswertR ?? null,
            noten: [{ art: "gegenprobe", zutreffend: eintrag.gegenprobe.einstufung === "robust" }],
          },
          status: "vorgeschlagen",
        };
        await speichere(lehre);
        neue.push(lehre);
        buch[schluessel] = { am, ergebnis: "lehre", lehreId: lehre.id, versuche };
      } catch (fehler) {
        const grund = fehler instanceof Error ? fehler.message : String(fehler);
        buch[schluessel] = { am, ergebnis: "fehler", grund: grund.slice(0, 300), versuche };
      }
    }
    await mkdir(ordner, { recursive: true });
    await writeFile(protokollDatei, JSON.stringify(buch, null, 2), "utf8");
    return neue;
  }

  return {
    liste,
    geltende,
    protokoll,

    async listeMitWirkung() {
      const alle = await liste();
      const gemessen = alle.filter((l) => l.aktivSeit && l.art !== "allgemein");
      const beobachtungen: Beobachtung[] = [];
      // Kerzen holen nur, wenn eine Lehre an einer Note der Einzelideen hängt.
      if (gemessen.some((l) => l.art !== "gegenprobe")) {
        const [prognosen, benotungen] = await Promise.all([
          deps.prognosen.liste(),
          deps.prognosen.pruefeAlle(),
        ]);
        beobachtungen.push(
          ...ausBenotungen(benotungen, new Map(prognosen.map((p) => [p.id, p.angelegt]))),
        );
      }
      if (gemessen.some((l) => l.art === "gegenprobe") && deps.strategien)
        beobachtungen.push(...ausGegenproben(await deps.strategien.liste(500)));
      return alle.map((l) => ({ ...l, wirkung: wirkung(l, beobachtungen) }));
    },

    async anhang(an) {
      try {
        return lehrenAnhang(await geltende(an));
      } catch {
        // Ein Fehler im Lehrbuch darf keinen Auftrag verhindern.
        return "";
      }
    },

    async entscheide(id, was) {
      const l = (await liste()).find((x) => x.id === id);
      if (!l) return null;
      const erlaubt: Record<LehrStatus, LehrStatus[]> = {
        vorgeschlagen: ["aktiv", "verworfen"],
        aktiv: ["abgelegt"],
        abgelegt: ["aktiv"],
        verworfen: ["aktiv"],
      };
      const am = jetzt().toISOString();
      let freigegeben = false;
      if (was.status !== l.status) {
        if (!erlaubt[l.status].includes(was.status))
          throw new LehrFehler(`Von „${l.status}" geht es nicht nach „${was.status}".`);
        if (was.status === "aktiv") {
          const zahl = (await geltende(l.an)).length;
          if (zahl >= MAX_AKTIV)
            throw new LehrFehler(
              `Es gelten schon ${MAX_AKTIV} Lehren. Leg zuerst eine ab — sonst wird der Prompt zur Liste, die niemand mehr liest.`,
            );
          l.aktivSeit = am;
          freigegeben = l.status === "vorgeschlagen";
        }
        l.status = was.status;
        l.entschieden = am;
      }
      if (was.text !== undefined) {
        const neu = was.text.trim().slice(0, 500);
        if (!neu) throw new LehrFehler("Eine Lehre ohne Text gibt es nicht.");
        if (neu !== l.text) {
          if (!freigegeben) throw new LehrFehler("Den Wortlaut ändern geht nur beim Freigeben.");
          l.vorschlag ??= l.text;
          l.text = neu;
        }
      }
      if (was.notiz !== undefined) l.notiz = was.notiz.trim().slice(0, 2000) || undefined;
      await speichere(l);
      return l;
    },

    nachbetrachte() {
      // Zwei Takte gleichzeitig hießen zwei Lehren aus derselben Prognose.
      if (!laeuft) {
        laeuft = betrachte().finally(() => {
          laeuft = null;
        });
      }
      return laeuft;
    },
  };
}
