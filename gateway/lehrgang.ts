import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { redactText } from "../runtime/redaction/redact.js";
import type { AboStand } from "./abo.js";
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

/** Eine Regel beginnt mit einem Spiegelstrich oder einer Nummer am Zeilenanfang. */
function pruefbarkeit(regeln: string): (Pruefbar | null)[] {
  const eintraege = regeln
    .split(/\n(?=(?:[-*]|\d+\.)\s)/)
    .filter((e) => /^(?:[-*]|\d+\.)\s/.test(e.trim()));
  return eintraege.map((e) => {
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

/**
 * `[3:19]` und `[3:19–4:15]` werden Links an die Stelle im Video. Was schon ein Link ist, bleibt,
 * wie es ist.
 */
export function verlinkeZeitmarken(text: string, id: string): string {
  const muster = new RegExp(String.raw`\[(${MARKE})(\s*[–-]\s*${MARKE})?\](?!\()`, "g");
  return text.replace(
    muster,
    (_, von: string, bis: string | undefined) =>
      `[${von}${bis ?? ""}](https://youtu.be/${id}?t=${sekunden(von)})`,
  );
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
…
</begriffe>
<regeln>
…
</regeln>
<beispiele>
…
</beispiele>
<warnungen>
…
</warnungen>
<behauptungen>
…
</behauptungen>
<fehlt>
…
</fehlt>`;

export function lehrgangPrompt(video: Video, t: Transkript): string {
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
  const { tag, uhr } = wienerZeit(opt.zeit.toISOString());
  const kopf = [
    `# ${video.titel}`,
    "",
    `- **Video:** [youtube.com/watch?v=${video.id}](https://www.youtube.com/watch?v=${video.id}) · ${zeitmarke(video.dauer)}${video.kalibrierung ? " · Kalibrierungsvideo" : ""}`,
    `- **Transkript:** ${t.art === "manuell" ? "vom Kanal" : "automatisch erkannt"} (${t.sprache}), ${t.segmente.length} Zeilen`,
    `- **Durchgearbeitet:** ${tag.split("-").reverse().join(".")} ${uhr} (Wien), ${opt.modell}, ohne Werkzeuge`,
    `- **Regeln:** ${zaehle(notiz.pruefbar)}`,
    ...(notiz.fehlend.length > 0
      ? [`- **Nicht geliefert:** ${notiz.fehlend.map((a) => UEBERSCHRIFT[a]).join(", ")}`]
      : []),
    "",
    "> Aus dem gesprochenen Text. Die Zeitmarken führen an die Stelle im Video. Zahlen unter „Behauptungen“ sind Angaben des Videos, keine Belege.",
  ];
  const rumpf = ABSCHNITTE.map(
    (a) =>
      `## ${UEBERSCHRIFT[a]}\n\n${notiz.abschnitte[a] ? verlinkeZeitmarken(notiz.abschnitte[a], video.id) : "_keine_"}`,
  );
  return `${[...kopf, "", ...rumpf].join("\n")}\n`;
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
function inDieserNacht(v: Versuch, jetzt: Date): boolean {
  const heute = wienerZeit(jetzt.toISOString(), ZONE).tag;
  const w = wienerZeit(v.zeit, ZONE);
  return w.tag === heute && w.stunde >= LEHRGANG_FENSTER[0] && w.stunde < LEHRGANG_FENSTER[1];
}

/**
 * Darf jetzt ein Video beginnen — nach Uhr und Nachtgrenze? `null` heißt ja, sonst der Grund in
 * einem Satz; der steht auf der System-Seite.
 */
export function warumNichtJetzt(jetzt: Date, versuche: readonly Versuch[]): string | null {
  const { stunde } = wienerZeit(jetzt.toISOString(), ZONE);
  const [von, bis] = LEHRGANG_FENSTER;
  if (stunde < von || stunde >= bis) return `ruht bis ${von}:00 Uhr`;
  const heute = versuche.filter((v) => inDieserNacht(v, jetzt)).length;
  if (heute >= JE_NACHT) return `${JE_NACHT} Videos in dieser Nacht — genug`;
  return null;
}

/**
 * Und nach dem Abo? Ohne lesbaren Stand wird nicht gelernt: eine Grenze, die man nicht sieht, ist
 * keine, an die man sich halten kann.
 */
export function warumNichtAbo(abo: AboStand): string | null {
  if (!abo.verfuegbar) return `Abo-Stand nicht lesbar (${abo.grund})`;
  const sitzung = abo.fenster.find((f) => f.id === "sitzung");
  if (!sitzung) return "Abo-Stand ohne Sitzungsfenster";
  if (sitzung.prozent >= GRENZE_SITZUNG)
    return `Sitzungsfenster bei ${Math.round(sitzung.prozent)} % (Grenze ${GRENZE_SITZUNG} %)`;
  const woche = abo.fenster.find((f) => f.id === "woche");
  if (woche && woche.prozent >= GRENZE_WOCHE)
    return `Wochenfenster bei ${Math.round(woche.prozent)} % (Grenze ${GRENZE_WOCHE} %)`;
  return null;
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
        deps.schreibe(LEHRGANG_SYSTEM, lehrgangPrompt(video, t)),
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
          const grund = warumNichtJetzt(jetzt(), bisher) ?? warumNichtAbo(await deps.abo());
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
      const nacht = bisher.filter((v) => inDieserNacht(v, n));
      const zuOft = inventar.filter((v) => fehlversuche(v.id, bisher) >= FEHLVERSUCHE);
      return {
        fenster: LEHRGANG_FENSTER,
        jeNacht: JE_NACHT,
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
