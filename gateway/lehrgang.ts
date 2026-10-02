import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { redactText } from "../runtime/redaction/redact.js";
import type { AboStand } from "./abo.js";
import { NACHT_ENDE, inDerNacht, nachtgrenzen, wocheZuBeginn } from "./nachtbudget.js";
import { ZONE, wienerZeit } from "./gespraeche.js";
import type { Transkript, Video, WissenAblage } from "./wissen.js";

/**
 * Der Lehrgang (N8, 2026-09-28): jedes TradingLab-Video wird durchgearbeitet.
 *
 * Seit dem 27.09. liegen die Transkripte da (`wissen.ts`), aber gelesen hat sie niemand: die
 * Agenten rechneten am 21.09. eine „MACD-Kreuzung" ohne die Bedingung „unter der Nulllinie", weil
 * sie das Video nie gesehen hatten. Hier wird aus jedem Video eine Notiz — Begriffe, Regeln mit
 * Parametern, vorgeführte Beispiele, Warnungen, die Zahlen des Videos als Behauptung, und was nur
 * im Bild zu sehen war —, je Aussage mit Zeitmarke, abgelegt als `notizen/<id>.md`. Daraus
 * entstehen später Lehrbuch und Setup-Karten (N11).
 *
 * **Wann.** Nachts zwischen eins und sechs, höchstens fünfzehn Videos je Nacht, und nur, solange
 * das Sitzungsfenster des Abos unter 70 % steht — der Rest bis zur Grenze des Nachtbaus (85 %)
 * gehört ihm, und was morgens übrig ist, gehört Jakob. Das Wochenfenster zählt auch: darüber hört
 * der Lehrgang bei derselben Grenze auf wie der Nachtbau. Die Kalibrierungsvideos kommen zuerst.
 *
 * **Wie.** Je Video ein Einmal-Lauf **ohne Werkzeuge** (`einmal.ts`): wer liest, soll nicht
 * nebenbei nachschlagen, und das Transkript ist alles, was er braucht. Die Antwort kommt in
 * Markierungen, nicht als JSON — ein einziges unmaskiertes Anführungszeichen in einem Zitat hat
 * am 27.09. eine ganze Übergabe unlesbar gemacht (`leseUebergabe`), und Notizen bestehen aus
 * Zitaten. Der Lauf reiht sich in Kuros Zugschlange: kommt nachts doch eine Nachricht, wartet sie
 * höchstens ein Video lang.
 *
 * Jeder Versuch steht in `lehrgang.json` neben den Notizen. Ein Video, das zweimal scheitert, wird
 * übersprungen und bleibt mit seinem Fehler auf der System-Seite sichtbar.
 */

/** Zwischen diesen Stunden (Wiener Zeit) wird gelernt. */
export const LEHRGANG_FENSTER: readonly [number, number] = [1, 6];
/** Höchstens so viele Versuche je Nacht — gescheiterte zählen mit, auch sie kosten. */
export const JE_NACHT = 15;
/** Ab diesem Stand des Sitzungsfensters (%) beginnt kein Video mehr. */
export const GRENZE_SITZUNG = 70;
/** Ab diesem Stand des Wochenfensters (%) auch nicht — dieselbe Grenze wie beim Nachtbau. */
export const GRENZE_WOCHE = 85;
/** So oft darf ein Video scheitern, bevor es übersprungen wird. */
export const FEHLVERSUCHE = 2;

/**
 * Fenster und Tagesmenge aus der Umgebung (29.09.): `KURO_LEHRGANG_FENSTER=0-24` lässt den
 * Lehrgang auch tagsüber lernen, `KURO_LEHRGANG_JE_NACHT=40` mehr am Stück — Jakob wollte, dass
 * nach dem Wochen-Reset am 02.10. sofort gelernt wird statt erst in der Nacht. Die Grenzen des Abos
 * (70 % Sitzung, 85 % Woche) gelten unverändert; eine Nachricht an Kuro wartet höchstens einen
 * Abschnitt lang.
 *
 * Seit dem 02.10. abends lernt er wieder nur nachts (`0-8`): Jakob rechnet den Lehrgang ins
 * Nachtbudget des Nachtbaus (`nachtbudget.ts`) — beide zusammen höchstens 10 Punkte der Woche je
 * Nacht. Nachts gelten deshalb dessen engere Grenzen.
 */
export function ausUmgebung(): { fenster: readonly [number, number]; jeNacht: number } {
  const f = /^(\d{1,2})-(\d{1,2})$/.exec(process.env.KURO_LEHRGANG_FENSTER?.trim() ?? "");
  const n = Number(process.env.KURO_LEHRGANG_JE_NACHT);
  return {
    fenster: f ? [Number(f[1]), Number(f[2])] : LEHRGANG_FENSTER,
    jeNacht: Number.isInteger(n) && n > 0 ? n : JE_NACHT,
  };
}

/** Ein Abschnitt aus einem Buch statt eines Videos? */
export const istBuch = (v: Video): boolean => v.seiten !== undefined;

// ------------------------------------------------------------------------------ Die Notiz

export const ABSCHNITTE = [
  "begriffe",
  "regeln",
  "beispiele",
  "warnungen",
  "behauptungen",
  "fehlt",
] as const;
export type Abschnitt = (typeof ABSCHNITTE)[number];
export type Pruefbar = "ja" | "teils" | "nein";

const UEBERSCHRIFT: Record<Abschnitt, string> = {
  begriffe: "Begriffe",
  regeln: "Regeln",
  beispiele: "Beispiele",
  warnungen: "Warnungen",
  behauptungen: "Behauptungen (nicht belegt)",
  fehlt: "Nur im Bild (fehlt im Transkript)",
};

export interface Notiz {
  abschnitte: Record<Abschnitt, string>;
  /** Je Regel, wie weit sie sich mechanisch prüfen lässt; `null`, wo das Modell es nicht sagt. */
  pruefbar: (Pruefbar | null)[];
  /** Markierungen, die in der Antwort gar nicht vorkamen — anders als ein leerer Abschnitt. */
  fehlend: Abschnitt[];
}

export class LehrgangFehler extends Error {}

/** Die Grenzmeldung des Abos, wie sie am 27.09. als Antworttext kam — kein Fehler des Videos. */
export class AboGrenzeFehler extends Error {}
const GRENZMELDUNG = /hit your (?:session |weekly |usage )?limit|usage limit reached|rate.?limit/i;

const LEER = /^(?:keine?|nichts|none|—|–|-)\.?$/i;

/**
 * Die Antwort des Laufs lesen. Ohne `<regeln>` ist es keine Notiz — die Regeln sind der Grund,
 * warum das Video durchgearbeitet wird. Fehlt ein anderer Abschnitt, bleibt er leer und steht im
 * Kopf der Notiz als „nicht geliefert"; eine Schlussmarke, die fehlt, endet am nächsten Abschnitt.
 */
export function leseNotiz(antwort: string): Notiz {
  if (GRENZMELDUNG.test(antwort.slice(0, 400)) && !/<regeln>/i.test(antwort)) {
    throw new AboGrenzeFehler(antwort.trim().slice(0, 200));
  }
  const alle = ABSCHNITTE.join("|");
  const abschnitte = {} as Record<Abschnitt, string>;
  const fehlend: Abschnitt[] = [];
  for (const name of ABSCHNITTE) {
    const m = new RegExp(`<${name}>([\\s\\S]*?)(?:</${name}>|(?=<(?:${alle})>)|$)`, "i").exec(
      antwort,
    );
    if (!m) fehlend.push(name);
    const text = (m?.[1] ?? "").trim();
    abschnitte[name] = LEER.test(text) ? "" : text;
  }
  if (fehlend.includes("regeln")) {
    throw new LehrgangFehler(
      fehlend.length === ABSCHNITTE.length
        ? `Die Notiz kam ohne ihre Markierungen: „${antwort.trim().slice(0, 120)}"`
        : "Die Notiz kam ohne <regeln>.",
    );
  }
  return { abschnitte, pruefbar: pruefbarkeit(abschnitte.regeln), fehlend };
}

const EINTRAG = /^(?:[-*]|\d+\.)\s+/;

/**
 * Die Regeln einzeln — eine beginnt mit Spiegelstrich oder Nummer am Zeilenanfang, eingerückte
 * Zeilen gehören zu ihr. `vorspann` ist, was davor steht.
 */
function regelEintraege(regeln: string): { vorspann: string[]; eintraege: string[] } {
  const teile = regeln.split(/\n(?=(?:[-*]|\d+\.)\s)/).map((e) => e.trim());
  return {
    vorspann: teile.filter((e) => e && !EINTRAG.test(e)),
    eintraege: teile.filter((e) => EINTRAG.test(e)),
  };
}

function pruefbarkeit(regeln: string): (Pruefbar | null)[] {
  return regelEintraege(regeln).eintraege.map((e) => {
    const m = /pr(?:ü|ue|u)fbar\**:?\**\s*(ja|teils|nein)\b/i.exec(e);
    return m ? ((m[1] as string).toLowerCase() as Pruefbar) : null;
  });
}

/** `83` → `1:23`, `3723` → `1:02:03`. */
export function zeitmarke(sekunden: number): string {
  const s = Math.max(0, Math.floor(sekunden));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${rest}` : `${m}:${rest}`;
}

function sekunden(marke: string): number {
  return marke.split(":").reduce((summe, teil) => summe * 60 + Number(teil), 0);
}

const MARKE = String.raw`\d{1,2}:\d{2}(?::\d{2})?`;
const SPANNE = String.raw`${MARKE}(?:\s*[–-]\s*${MARKE})?`;

/**
 * `[3:19]`, `[3:19–4:15]` und `[3:27, 4:06–4:16]` werden Links an die Stelle im Video — bei einer
 * Aufzählung jede Marke für sich. Was schon ein Link ist, bleibt, wie es ist.
 */
export function verlinkeZeitmarken(text: string, id: string): string {
  const muster = new RegExp(String.raw`\[(${SPANNE}(?:\s*[,;]\s*${SPANNE})*)\](?!\()`, "g");
  return text.replace(muster, (_, inhalt: string) =>
    inhalt
      .split(/\s*[,;]\s*/)
      .map((teil) => {
        const von = teil.split(/\s*[–-]\s*/)[0] as string;
        return `[${teil}](https://youtu.be/${id}?t=${sekunden(von)})`;
      })
      .join(", "),
  );
}

/** Nur Buchstaben und Ziffern: die automatischen Untertitel haben kaum Satzzeichen („It s"). */
const buchstaben = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * Zitate in geraden Anführungszeichen gegen Transkript und Titel prüfen (`heuhaufen`, schon durch
 * `buchstaben`). Was dort nicht Buchstabe für Buchstabe steht, bekommt ein „nicht wörtlich"
 * dahinter: Setup-Karten im Wortlaut (N11) bauen auf diesen Zitaten, und am 28.09. hatte schon die
 * erste Notiz eins, in das das Modell ein „only" hineingeschrieben hatte.
 */
export function pruefeZitate(
  text: string,
  heuhaufen: string,
): { text: string; zitate: number; woertlich: number } {
  let zitate = 0;
  let woertlich = 0;
  const geprueft = text.replace(/"([^"\n]+)"/g, (ganz, zitat: string) => {
    // Unter drei Wörtern ist es ein Begriff, kein Zitat.
    if (zitat.trim().split(/\s+/).length < 3) return ganz;
    zitate += 1;
    // Eine Auslassung („…") ist erlaubt, wenn jedes Stück für sich wörtlich dasteht.
    const stuecke = zitat
      .split(/\.{3}|…/)
      .map(buchstaben)
      .filter(Boolean);
    if (stuecke.every((stueck) => heuhaufen.includes(stueck))) {
      woertlich += 1;
      return ganz;
    }
    return `${ganz} *(nicht wörtlich)*`;
  });
  return { text: geprueft, zitate, woertlich };
}

/** Zeilen ohne Spiegelstrich bekommen einen — sonst liefen sie in der Ansicht zu einem Absatz zusammen. */
function stichpunkte(text: string): string {
  return text
    .split("\n")
    .map((z) => (z.trim() === "" || /^\s/.test(z) || EINTRAG.test(z) ? z : `- ${z}`))
    .join("\n");
}

/**
 * Jede Regel ein Block: die Regel selbst, darunter Wortlaut, Parameter und Prüfbarkeit als
 * Unterpunkte. Ohne erkennbare Einträge bleibt die Antwort, wie sie kam.
 */
function regelnMarkdown(regeln: string): string {
  const { vorspann, eintraege } = regelEintraege(regeln);
  if (eintraege.length === 0) return stichpunkte(regeln);
  const bloecke = eintraege.map((e, i) => {
    const [erste = "", ...rest] = e.split("\n");
    const unter = rest
      .map((z) => z.trim())
      .filter(Boolean)
      .map((z) => `  - ${z.replace(EINTRAG, "")}`);
    return [`- **Regel ${i + 1}:** ${erste.replace(EINTRAG, "")}`, ...unter].join("\n");
  });
  return [...vorspann, ...bloecke].join("\n\n");
}

/**
 * Das Transkript für den Lauf: Absätze von gut zwanzig Sekunden, jeder mit seiner Zeitmarke. Eine
 * Marke je Untertitelzeile kostete bei 500 Zeilen rund 2.000 Token und brächte nichts — auf die
 * Sekunde genau zitiert ohnehin niemand.
 */
export function transkriptText(t: Transkript, absatzSekunden = 20): string {
  const absaetze: string[] = [];
  let beginn = Number.NEGATIVE_INFINITY;
  let aktuell: string[] = [];
  for (const s of t.segmente) {
    if (s.start - beginn >= absatzSekunden && aktuell.length > 0) {
      absaetze.push(`[${zeitmarke(beginn)}] ${aktuell.join(" ")}`);
      aktuell = [];
    }
    if (aktuell.length === 0) beginn = s.start;
    aktuell.push(s.text);
  }
  if (aktuell.length > 0) absaetze.push(`[${zeitmarke(beginn)}] ${aktuell.join(" ")}`);
  return absaetze.join("\n");
}

export const LEHRGANG_SYSTEM = `Du arbeitest ein Lehrvideo über Trading durch, für Kuro und seine Börsenabteilung. Du bekommst den gesprochenen Text mit Zeitmarken [m:ss]; das Bild siehst du nicht.

Schreib auf Deutsch, knapp, in Stichpunkten. Halte dich an den Text: nichts ergänzen, was nicht gesagt wird, nichts aus eigenem Wissen richtigstellen. Jeder Punkt trägt die Zeitmarke seiner Stelle: [3:19] oder [3:19–4:15].

<begriffe>: Fachbegriffe, wie das Video sie benutzt, je ein Satz.
<regeln>: jede Handelsregel als eigener Punkt, mit allen Bedingungen, die gesagt werden:
- Was die Regel verlangt. [m:ss]
  Wortlaut: "kurzes Originalzitat"
  Parameter: Indikator und Einstellung, Zeitrahmen, Markt, Stop, Ziel — was nicht gesagt wird: „nicht genannt".
  mechanisch prüfbar: ja | teils | nein — warum (ja = aus Kursdaten ohne Urteil rechenbar).
Richtig: „Long nur, wenn die MACD-Linie die Signallinie unter der Nulllinie nach oben kreuzt. [2:24]"
Falsch: „MACD-Kreuzung als Kaufsignal." — die Bedingung „unter der Nulllinie" fehlt, und genau daran hängt die Regel.
<beispiele>: vorgeführte Trades: [m:ss] Markt, Zeitrahmen, was geschah, wie es ausging.
<warnungen>: wovor das Video warnt, was es ausschließt.
<behauptungen>: Zahlen und Versprechen („86% win rate") mit Zeitmarke und der Grundlage, die das Video nennt, sonst „keine Grundlage genannt". Behauptungen, keine Belege.
<fehlt>: Stellen, an denen etwas nur gezeigt wird („as you can see here"), mit Zeitmarke und was dort vermutlich zu sehen ist.

Ein Abschnitt ohne Inhalt enthält nur „keine". Antworte ohne Text davor oder danach, in genau dieser Form:
<begriffe>
- …
</begriffe>
<regeln>
- …
  Wortlaut: "…"
  Parameter: …
  mechanisch prüfbar: …
</regeln>
<beispiele>
- …
</beispiele>
<warnungen>
- …
</warnungen>
<behauptungen>
- …
</behauptungen>
<fehlt>
- …
</fehlt>`;

export const LEHRGANG_SYSTEM_BUCH = LEHRGANG_SYSTEM.replace(
  "Du arbeitest ein Lehrvideo über Trading durch, für Kuro und seine Börsenabteilung. Du bekommst den gesprochenen Text mit Zeitmarken [m:ss]; das Bild siehst du nicht.",
  "Du arbeitest einen Abschnitt eines Lehrbuchs über technische Analyse durch, für Kuro und seine Börsenabteilung. Du bekommst den Text, Seite für Seite mit [S. n]; Abbildungen und Charts siehst du nicht.",
)
  .replace(
    "Jeder Punkt trägt die Zeitmarke seiner Stelle: [3:19] oder [3:19–4:15].",
    "Jeder Punkt trägt die Seite seiner Stelle: [S. 123] oder [S. 123–125].",
  )
  .replaceAll("[m:ss]", "[S. n]")
  .replace("Fachbegriffe, wie das Video sie benutzt", "Fachbegriffe, wie das Buch sie benutzt")
  .replace("vorgeführte Trades:", "besprochene Beispiele:")
  .replace("wovor das Video warnt", "wovor das Buch warnt")
  .replace(
    "mit Zeitmarke und der Grundlage, die das Video nennt",
    "mit Seite und der Grundlage, die das Buch nennt",
  )
  .replace(
    '<fehlt>: Stellen, an denen etwas nur gezeigt wird („as you can see here"), mit Zeitmarke und was dort vermutlich zu sehen ist.',
    "<fehlt>: Stellen, die sich auf eine Abbildung stützen („Figure 4.2“), mit Seite und was dort vermutlich zu sehen ist.",
  );

export function lehrgangPrompt(video: Video, t: Transkript): string {
  if (istBuch(video)) {
    return [
      `Buch: ${video.buch ?? "ohne Titel"}`,
      `Abschnitt: ${video.titel} (PDF-Seiten ${video.seiten?.[0]}–${video.seiten?.[1]})`,
      "",
      ...t.segmente.map((s) => `[S. ${s.start}] ${s.text}`),
    ].join("\n");
  }
  return [
    `Video: ${video.titel} (${zeitmarke(video.dauer)})`,
    `Transkript: ${t.art === "manuell" ? "vom Kanal" : "automatisch erkannt"}, Sprache ${t.sprache}`,
    "",
    transkriptText(t),
  ].join("\n");
}

function zaehle(pruefbar: Notiz["pruefbar"]): string {
  const n = (w: Pruefbar) => pruefbar.filter((p) => p === w).length;
  const ohne = pruefbar.filter((p) => p === null).length;
  const teile = [`${n("ja")} ja`, `${n("teils")} teils`, `${n("nein")} nein`];
  if (ohne > 0) teile.push(`${ohne} ohne Angabe`);
  return `${pruefbar.length} — mechanisch prüfbar: ${teile.join(" · ")}`;
}

/** Die Notiz als Datei: ein Kopf, der sagt, woher sie kommt, dann die sechs Abschnitte. */
export function notizMarkdown(opt: {
  video: Video;
  transkript: Transkript;
  notiz: Notiz;
  modell: string;
  zeit: Date;
}): string {
  const { video, transkript: t, notiz } = opt;
  const buch = istBuch(video);
  const { tag, uhr } = wienerZeit(opt.zeit.toISOString());
  const heuhaufen = buchstaben(`${video.titel} ${t.segmente.map((s) => s.text).join(" ")}`);
  let zitate = 0;
  let woertlich = 0;
  const rumpf = ABSCHNITTE.map((a) => {
    const ueberschrift = buch && a === "fehlt" ? "Nur in Abbildungen" : UEBERSCHRIFT[a];
    if (!notiz.abschnitte[a]) return `## ${ueberschrift}\n\n*keine*`;
    const geprueft = pruefeZitate(notiz.abschnitte[a], heuhaufen);
    zitate += geprueft.zitate;
    woertlich += geprueft.woertlich;
    const gegliedert = a === "regeln" ? regelnMarkdown(geprueft.text) : stichpunkte(geprueft.text);
    return `## ${ueberschrift}\n\n${buch ? gegliedert : verlinkeZeitmarken(gegliedert, video.id)}`;
  });
  const kopf = buch
    ? [
        `# ${video.titel}`,
        "",
        `- **Buch:** ${video.buch ?? "ohne Titel"}, PDF-Seiten ${video.seiten?.[0]}–${video.seiten?.[1]}`,
        `- **Durchgearbeitet:** ${tag.split("-").reverse().join(".")} ${uhr} (Wien), ${opt.modell}, ohne Werkzeuge`,
        `- **Regeln:** ${zaehle(notiz.pruefbar)}`,
        ...(zitate > 0 ? [`- **Zitate:** ${zitate}, davon ${woertlich} wörtlich im Text`] : []),
        "",
        "*Aus dem Text der PDF; [S. n] ist die PDF-Seite, nicht die gedruckte. Abbildungen fehlen. Zahlen unter „Behauptungen“ sind Angaben des Buchs, keine Belege.*",
      ]
    : [
        `# ${video.titel}`,
        "",
        `- **Video:** [youtube.com/watch?v=${video.id}](https://www.youtube.com/watch?v=${video.id}) · ${zeitmarke(video.dauer)}${video.kalibrierung ? " · Kalibrierungsvideo" : ""}`,
        `- **Transkript:** ${t.art === "manuell" ? "vom Kanal" : "automatisch erkannt"} (${t.sprache}), ${t.segmente.length} Zeilen`,
        `- **Durchgearbeitet:** ${tag.split("-").reverse().join(".")} ${uhr} (Wien), ${opt.modell}, ohne Werkzeuge`,
        `- **Regeln:** ${zaehle(notiz.pruefbar)}`,
        ...(zitate > 0
          ? [`- **Zitate:** ${zitate}, davon ${woertlich} wörtlich in Transkript oder Titel`]
          : []),
        ...(notiz.fehlend.length > 0
          ? [`- **Nicht geliefert:** ${notiz.fehlend.map((a) => UEBERSCHRIFT[a]).join(", ")}`]
          : []),
        "",
        "*Aus dem gesprochenen Text. Die Zeitmarken führen an die Stelle im Video. Zahlen unter „Behauptungen“ sind Angaben des Videos, keine Belege.*",
      ];
  return `${kopf.join("\n")}\n\n${rumpf.join("\n\n")}\n`;
}

// ------------------------------------------------------------------------------ Wann und was

export interface Versuch {
  id: string;
  zeit: string;
  ok: boolean;
  grund?: string;
  /** Scheiterte an der Grenze des Abos, nicht am Video — zählt nicht als Fehlversuch. */
  grenze?: boolean;
}

/** Ist das ein Versuch aus der Nacht, zu der `jetzt` gehört? */
function inDieserNacht(
  v: Versuch,
  jetzt: Date,
  fenster: readonly [number, number] = LEHRGANG_FENSTER,
): boolean {
  const heute = wienerZeit(jetzt.toISOString(), ZONE).tag;
  const w = wienerZeit(v.zeit, ZONE);
  return w.tag === heute && w.stunde >= fenster[0] && w.stunde < fenster[1];
}

/**
 * Darf jetzt ein Video beginnen — nach Uhr und Nachtgrenze? `null` heißt ja, sonst der Grund in
 * einem Satz; der steht auf der System-Seite.
 */
export function warumNichtJetzt(
  jetzt: Date,
  versuche: readonly Versuch[],
  fenster: readonly [number, number] = LEHRGANG_FENSTER,
  jeNacht: number = JE_NACHT,
): string | null {
  const { stunde } = wienerZeit(jetzt.toISOString(), ZONE);
  const [von, bis] = fenster;
  if (stunde < von || stunde >= bis) return `ruht bis ${von}:00 Uhr`;
  const heute = versuche.filter((v) => inDieserNacht(v, jetzt, fenster)).length;
  if (heute >= jeNacht) return `${jeNacht} Videos in dieser Nacht — genug`;
  return null;
}

/**
 * Und nach dem Abo? Ohne lesbaren Stand wird nicht gelernt: eine Grenze, die man nicht sieht, ist
 * keine, an die man sich halten kann.
 */
export function warumNichtAbo(
  abo: AboStand,
  grenzen: { sitzung: number; woche: number } = { sitzung: GRENZE_SITZUNG, woche: GRENZE_WOCHE },
): string | null {
  if (!abo.verfuegbar) return `Abo-Stand nicht lesbar (${abo.grund})`;
  const sitzung = abo.fenster.find((f) => f.id === "sitzung");
  if (!sitzung) return "Abo-Stand ohne Sitzungsfenster";
  if (sitzung.prozent >= grenzen.sitzung)
    return `Sitzungsfenster bei ${Math.round(sitzung.prozent)} % (Grenze ${grenzen.sitzung} %)`;
  const woche = abo.fenster.find((f) => f.id === "woche");
  if (woche && woche.prozent >= grenzen.woche)
    return `Wochenfenster bei ${Math.round(woche.prozent)} % (Grenze ${grenzen.woche} %)`;
  return null;
}

/**
 * Die Grenzen für diesen Augenblick: nachts die des gemeinsamen Nachtbudgets (`nachtbudget.ts`),
 * tagsüber die eigenen. Ohne lesbaren Stand bleiben die eigenen — `warumNichtAbo` hält dann ohnehin.
 */
export async function grenzenJetzt(
  abo: AboStand,
  workdir: string,
  jetzt: Date,
  ende = process.env.NACHTBAU_ENDE?.trim() || NACHT_ENDE,
): Promise<{ sitzung: number; woche: number }> {
  const normal = { sitzung: GRENZE_SITZUNG, woche: GRENZE_WOCHE };
  if (!abo.verfuegbar || !inDerNacht(jetzt, ende)) return normal;
  const woche = abo.fenster.find((f) => f.id === "woche");
  if (!woche) return normal;
  const wocheStart = await wocheZuBeginn(workdir, jetzt, woche.prozent);
  const g = nachtgrenzen({ fenster: abo.fenster, wocheStart, jetzt, ende, normal });
  return { sitzung: g.sitzung, woche: g.woche };
}

/** Wie oft ein Video seit seiner letzten gelungenen Notiz gescheitert ist. */
export function fehlversuche(id: string, versuche: readonly Versuch[]): number {
  let n = 0;
  for (const v of versuche) {
    if (v.id !== id) continue;
    if (v.ok) n = 0;
    else if (!v.grenze) n += 1;
  }
  return n;
}

/**
 * Die Reihenfolge der Arbeit: Kalibrierungsvideos zuerst, sonst die der Liste. Übersprungen wird,
 * was schon eine Notiz hat oder zu oft gescheitert ist; ob ein Transkript da ist, prüft der Takt
 * beim Laden.
 */
export function reihenfolge(
  inventar: readonly Video[],
  notiert: ReadonlySet<string>,
  versuche: readonly Versuch[],
): Video[] {
  const offen = inventar.filter(
    (v) => !notiert.has(v.id) && fehlversuche(v.id, versuche) < FEHLVERSUCHE,
  );
  return [...offen.filter((v) => v.kalibrierung), ...offen.filter((v) => !v.kalibrierung)];
}

// ------------------------------------------------------------------------------ Der Lehrgang

export interface LehrgangStand {
  fenster: readonly [number, number];
  jeNacht: number;
  grenzen: { sitzung: number; woche: number };
  aus: boolean;
  /** Was der letzte Takt gesagt hat, falls seit dem Start einer lief. */
  zuletzt: { zeit: string; halt: string } | null;
  dieseNacht: { versuche: number; fertig: number };
  /** Die jüngsten Versuche, neuester zuerst, mit Titel. */
  letzte: (Versuch & { titel: string })[];
  /** Videos, die zu oft gescheitert sind, mit dem letzten Grund. */
  uebersprungen: { id: string; titel: string; grund: string }[];
}

export interface LehrgangDeps {
  workdir: string;
  wissen: WissenAblage;
  /** Ein Einmal-Lauf ohne Werkzeuge; bucht seinen Verbrauch selbst. */
  schreibe(system: string, prompt: string): Promise<string>;
  /** Wie das Modell im Kopf der Notiz heißt. */
  modell: string;
  abo(): Promise<AboStand>;
  /** Kuros Zugschlange: ein Video beginnt erst, wenn kein Zug läuft. */
  schlange<T>(arbeit: () => Promise<T>): Promise<T>;
  kanal?: string;
  aus?(): boolean;
  jetzt?(): Date;
}

export interface Lehrgang {
  /** Welcher Kanal durchgearbeitet wird. */
  readonly kanal: string;
  /**
   * Ein Takt: arbeitet Video um Video ab, solange Fenster, Nachtgrenze und Abo es erlauben, und
   * sagt, warum er aufgehört hat. Läuft schon einer, kehrt der zweite sofort zurück.
   */
  takt(): Promise<{ gelernt: Versuch[]; halt: string }>;
  /** Ein Video durcharbeiten — ohne Fenster und Nachtgrenze, für den Probelauf von Hand. */
  lerne(id: string): Promise<Versuch>;
  stand(): Promise<LehrgangStand>;
}

export function createLehrgang(deps: LehrgangDeps): Lehrgang {
  const kanal = deps.kanal ?? "tradinglab";
  const jetzt = deps.jetzt ?? (() => new Date());
  const aus = deps.aus ?? (() => process.env.KURO_LEHRGANG?.trim() === "aus");
  const buchDatei = path.join(deps.workdir, "wissen", kanal, "lehrgang.json");
  let laeuft = false;
  let zuletzt: LehrgangStand["zuletzt"] = null;
  const { fenster, jeNacht } = ausUmgebung();

  async function versuche(): Promise<Versuch[]> {
    try {
      const roh = JSON.parse(await readFile(buchDatei, "utf8")) as { versuche?: Versuch[] };
      return Array.isArray(roh.versuche) ? roh.versuche : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async function bucheVersuch(v: Versuch): Promise<void> {
    // Die letzten 500 reichen für jede Anzeige; das Buch soll nicht mit dem Kanal wachsen.
    const alle = [...(await versuche()), v].slice(-500);
    await mkdir(path.dirname(buchDatei), { recursive: true });
    await writeFile(`${buchDatei}.neu`, `${JSON.stringify({ versuche: alle }, null, 1)}\n`);
    await rename(`${buchDatei}.neu`, buchDatei);
  }

  async function arbeite(video: Video, t: Transkript): Promise<Versuch> {
    const beginn = jetzt();
    try {
      const antwort = await deps.schlange(() =>
        deps.schreibe(
          istBuch(video) ? LEHRGANG_SYSTEM_BUCH : LEHRGANG_SYSTEM,
          lehrgangPrompt(video, t),
        ),
      );
      const notiz = leseNotiz(antwort);
      // Fremder Text, von einem Modell umgeschrieben, auf die Platte und später wieder in einen
      // Modellkontext (Lehrbuch, N11): derselbe Filter wie für jeden solchen Weg.
      const text = redactText(
        notizMarkdown({ video, transkript: t, notiz, modell: deps.modell, zeit: beginn }),
      );
      await deps.wissen.legeNotiz(kanal, video.id, text);
      const v: Versuch = { id: video.id, zeit: beginn.toISOString(), ok: true };
      await bucheVersuch(v);
      return v;
    } catch (error) {
      const grund = error instanceof Error ? error.message : String(error);
      const grenze = error instanceof AboGrenzeFehler || GRENZMELDUNG.test(grund);
      const v: Versuch = {
        id: video.id,
        zeit: beginn.toISOString(),
        ok: false,
        grund: grund.slice(0, 300),
        ...(grenze ? { grenze: true } : {}),
      };
      await bucheVersuch(v);
      return v;
    }
  }

  async function transkriptMitText(id: string): Promise<Transkript | null> {
    const t = await deps.wissen.transkript(kanal, id);
    return t && t.art !== "ohne" && t.segmente.length > 0 ? t : null;
  }

  return {
    kanal,

    async takt() {
      if (laeuft) return { gelernt: [], halt: "läuft schon" };
      laeuft = true;
      const gelernt: Versuch[] = [];
      let halt = "";
      try {
        if (aus()) {
          halt = "abgeschaltet (KURO_LEHRGANG=aus)";
          return { gelernt, halt };
        }
        for (;;) {
          const bisher = await versuche();
          // Erst Uhr und Nachtgrenze, dann der Anbieter: tagsüber wird das Abo nicht gefragt.
          let grund = warumNichtJetzt(jetzt(), bisher, fenster, jeNacht);
          if (!grund) {
            const abo = await deps.abo();
            grund = warumNichtAbo(abo, await grenzenJetzt(abo, deps.workdir, jetzt()));
          }
          if (grund) {
            halt = grund;
            break;
          }
          const [inventar, notiert] = await Promise.all([
            deps.wissen.inventar(kanal),
            deps.wissen.notizen(kanal),
          ]);
          let naechstes: { video: Video; t: Transkript } | null = null;
          for (const video of reihenfolge(inventar, new Set(notiert.keys()), bisher)) {
            const t = await transkriptMitText(video.id);
            if (t) {
              naechstes = { video, t };
              break;
            }
          }
          if (!naechstes) {
            halt = "nichts offen — jedes Video mit Transkript hat eine Notiz";
            break;
          }
          const v = await arbeite(naechstes.video, naechstes.t);
          gelernt.push(v);
          if (!v.ok) {
            // Nach einem Fehlschlag nicht gleich das nächste: scheitert der Lauf selbst, schiene
            // er sonst fünfzehnmal hintereinander. Der nächste Takt versucht es wieder.
            halt = v.grenze ? `Abo-Grenze: ${v.grund}` : `gescheitert an ${v.id}: ${v.grund}`;
            break;
          }
        }
        return { gelernt, halt };
      } finally {
        zuletzt = { zeit: jetzt().toISOString(), halt };
        laeuft = false;
      }
    },

    async lerne(id) {
      const video = (await deps.wissen.inventar(kanal)).find((v) => v.id === id);
      if (!video) throw new LehrgangFehler(`${id} steht nicht in der Liste.`);
      const t = await transkriptMitText(id);
      if (!t) throw new LehrgangFehler(`Zu ${id} liegt kein Transkript mit Text.`);
      return arbeite(video, t);
    },

    async stand() {
      const [bisher, inventar] = await Promise.all([versuche(), deps.wissen.inventar(kanal)]);
      const titel = new Map(inventar.map((v) => [v.id, v.titel]));
      const n = jetzt();
      const nacht = bisher.filter((v) => inDieserNacht(v, n, fenster));
      const zuOft = inventar.filter((v) => fehlversuche(v.id, bisher) >= FEHLVERSUCHE);
      return {
        fenster,
        jeNacht,
        grenzen: { sitzung: GRENZE_SITZUNG, woche: GRENZE_WOCHE },
        aus: aus(),
        zuletzt,
        dieseNacht: { versuche: nacht.length, fertig: nacht.filter((v) => v.ok).length },
        letzte: bisher
          .slice(-8)
          .reverse()
          .map((v) => ({ ...v, titel: titel.get(v.id) ?? v.id })),
        uebersprungen: zuOft.map((v) => ({
          id: v.id,
          titel: v.titel,
          grund: [...bisher].reverse().find((x) => x.id === v.id && !x.ok)?.grund ?? "",
        })),
      };
    },
  };
}
