/**
 * Das Gespräch der Welle als Datenmodell — ohne DOM, damit es ohne Browser prüfbar ist.
 *
 * Die Präsenz kannte eine einzige Antwort: das Panel über der Bubble, das jeder neue Zug leerte.
 * Die Welle führt einen Verlauf — Jakobs Fragen und Kuros Antworten untereinander, mit allem, was
 * zu einer Antwort gehört: die Tafeln, die Kuro dazu hinlegt (`ui.zeige`), und eine Rückfrage
 * mit ihren Antwortknöpfen. Eine Rückfrage lässt sich damit dort beantworten, wo sie steht; bis
 * heute stand in der Präsenz nur ihr Text, und antworten ging nur über die System-Ansicht.
 *
 * Eine Antwort kommt auf zwei Wegen herein, und beide müssen auf **denselben** Eintrag treffen:
 * als Wortstücke über den Ereignisstrom (`model.delta`, `turn.completed`, jeweils mit `turn_id`)
 * und als fertige Antwort im Rückgabewert von `POST /channels/web/messages`. Dazu kommen Züge,
 * die nicht von hier ausgingen — gesprochen, aus Telegram, ein Nachtrag im Postfach. Die Regeln,
 * welcher Weg welchen Eintrag trifft, stehen hier an einer Stelle.
 *
 * Alle Funktionen geben einen neuen Verlauf zurück und lassen den alten stehen.
 */

export const TAFELN = ["wetter", "kurse", "post", "kalender", "system"] as const;
export type Tafel = (typeof TAFELN)[number];

export interface Option {
  id: string;
  label: string;
}

export interface Rueckfrage {
  askId: string;
  frage: string;
  optionen: Option[];
  kanal: string;
  /** Die gewählte Antwort — oder `"anderswo"`, wenn die Frage verschwand, ohne dass hier
   * geantwortet wurde (in Telegram, in der System-Ansicht, per Stimme). */
  antwort: string | null;
}

export type Stand = "wartet" | "laeuft" | "fertig" | "fehler";

export interface Eintrag {
  id: string;
  von: "jakob" | "kuro";
  text: string;
  zeit: number;
  zugId: string | null;
  stand: Stand;
  tafeln: Tafel[];
  rueckfrage: Rueckfrage | null;
  /** Jakobs Eintrag kam aus dem Mikrofon, nicht von der Tastatur. Bei Kuros wartendem Eintrag:
   * die Frage davor — daran erkennt ein Zug, ob der Platz ihm gehört. */
  gesprochen: boolean;
  /** Woher ein Zug kam, der nicht hier gefragt wurde („über Telegram") — sonst null. */
  herkunft: string | null;
}

export interface Verlauf {
  eintraege: Eintrag[];
}

/** Uhr und Namensgeber — im Betrieb `Date.now` und ein Zähler, im Test fest. */
export interface Umgebung {
  jetzt: number;
  id(): string;
}

/** Wie viele Einträge der Verlauf behält. Genug für einen Abend, nicht genug, um den
 * Seitenspeicher zu füllen. */
export const HOECHSTENS = 60;

export function leer(): Verlauf {
  return { eintraege: [] };
}

function kuro(u: Umgebung, teil: Partial<Eintrag> = {}): Eintrag {
  return {
    id: u.id(),
    von: "kuro",
    text: "",
    zeit: u.jetzt,
    zugId: null,
    stand: "laeuft",
    tafeln: [],
    rueckfrage: null,
    gesprochen: false,
    herkunft: null,
    ...teil,
  };
}

function ersetze(v: Verlauf, index: number, neu: Eintrag): Verlauf {
  const eintraege = v.eintraege.slice();
  eintraege[index] = neu;
  return { eintraege };
}

function haenge(v: Verlauf, ...neu: Eintrag[]): Verlauf {
  return { eintraege: [...v.eintraege, ...neu].slice(-HOECHSTENS) };
}

/** Woher ein Zug kam, laut `turn.started` — entscheidet, welchen wartenden Platz er nehmen darf. */
export interface ZugQuelle {
  /** Der Kanal beim Gateway: `web`, `voice`, `telegram` … */
  kanal: string;
  /** Kuro trägt von sich aus einen Bericht nach (`nachtrag_…`) — darauf wartet hier keine Frage. */
  nachtrag: boolean;
}

/**
 * Darf dieser Zug den wartenden Platz nehmen? Nur ein Zug aus demselben Kanal wie die Frage.
 *
 * Am 2026-09-27 nahm sich Kuros nachgetragener Börsenbericht (Kanal `voice`, weil der Auftrag
 * gesprochen war) den jüngsten wartenden Platz — und das war einer, der zwischen Jakobs
 * Satzbruchstücken liegengeblieben war. Die Antwort war sauber, stand aber mitten in seiner
 * Nachricht. Ein Nachtrag und ein Zug aus Telegram beantworten keine Frage von hier.
 */
function nimmtPlatz(e: Eintrag, quelle: ZugQuelle | null): boolean {
  if (!quelle) return true;
  if (quelle.nachtrag) return false;
  if (quelle.kanal === "web") return !e.gesprochen;
  if (quelle.kanal === "voice") return e.gesprochen;
  return false;
}

/** Der Eintrag eines Zuges, sonst der jüngste passende, der noch auf seinen Zug wartet. */
function findeZug(v: Verlauf, zugId: string | null, quelle: ZugQuelle | null = null): number {
  if (zugId) {
    for (let i = v.eintraege.length - 1; i >= 0; i--) {
      if (v.eintraege[i].zugId === zugId) return i;
    }
  }
  for (let i = v.eintraege.length - 1; i >= 0; i--) {
    const e = v.eintraege[i];
    if (e.von === "kuro" && e.zugId === null && e.stand === "wartet" && nimmtPlatz(e, quelle))
      return i;
  }
  return -1;
}

/** Der jüngste Kuro-Eintrag, der noch nicht fertig ist. */
function findeLaufend(v: Verlauf): number {
  for (let i = v.eintraege.length - 1; i >= 0; i--) {
    const e = v.eintraege[i];
    if (e.von === "kuro" && (e.stand === "wartet" || e.stand === "laeuft")) return i;
  }
  return -1;
}

/** Jakob fragt. Darunter wartet schon Kuros Antwort — so steht das „denkt" an der richtigen
 * Stelle, bevor das erste Wort kommt. */
export function frage(v: Verlauf, text: string, u: Umgebung, gesprochen = false): Verlauf {
  const jakob: Eintrag = {
    id: u.id(),
    von: "jakob",
    text,
    zeit: u.jetzt,
    zugId: null,
    stand: "fertig",
    tafeln: [],
    rueckfrage: null,
    gesprochen,
    herkunft: null,
  };
  return haenge(v, jakob, kuro(u, { stand: "wartet", gesprochen }));
}

/** Ein Zug beginnt. Wartet eine eigene Frage aus seinem Kanal auf ihre Antwort, ist er deren
 * Antwort; sonst kam er von anderswo und bekommt einen eigenen Eintrag samt `herkunft`. */
export function zugBeginnt(
  v: Verlauf,
  zugId: string,
  u: Umgebung,
  herkunft: string | null = null,
  quelle: ZugQuelle | null = null,
): Verlauf {
  const i = findeZug(v, zugId, quelle);
  if (i >= 0) {
    const e = v.eintraege[i];
    return ersetze(v, i, { ...e, zugId, stand: e.stand === "fehler" ? e.stand : "laeuft" });
  }
  return haenge(v, kuro(u, { zugId, herkunft }));
}

export function stueck(v: Verlauf, zugId: string | null, text: string, u: Umgebung): Verlauf {
  if (!text) return v;
  let w = zugId ? zugBeginnt(v, zugId, u) : v;
  let i = zugId ? findeZug(w, zugId) : findeLaufend(w);
  if (i < 0) {
    w = haenge(w, kuro(u));
    i = w.eintraege.length - 1;
  }
  const e = w.eintraege[i];
  return ersetze(w, i, { ...e, text: e.text + text, stand: "laeuft" });
}

/** Der Zug ist fertig. Sein ganzer Text ersetzt die Summe der Stücke: er trägt die Absätze und
 * ist auch vollständig, wenn unterwegs ein Stück verloren ging. */
export function zugEndet(v: Verlauf, zugId: string, text: string, u: Umgebung): Verlauf {
  const i = findeZug(v, zugId);
  if (i < 0) return text ? haenge(v, kuro(u, { zugId, text, stand: "fertig" })) : v;
  const e = v.eintraege[i];
  return ersetze(v, i, {
    ...e,
    zugId,
    text: text || e.text,
    stand: e.stand === "fehler" ? "fehler" : "fertig",
  });
}

/** Die Antwort aus dem Rückgabewert des eigenen Aufrufs. Kam der Text schon über den Strom,
 * bleibt es bei einem Eintrag. */
export function antwort(v: Verlauf, text: string, u: Umgebung): Verlauf {
  const i = findeLaufend(v);
  if (i >= 0) {
    const e = v.eintraege[i];
    return ersetze(v, i, {
      ...e,
      text: text.length >= e.text.length ? text : e.text,
      stand: "fertig",
    });
  }
  return nachtrag(v, text, u);
}

/** Der eigene Aufruf ist zurück — was bis dahin nicht fertig war, ist es jetzt. */
export function abgeschlossen(v: Verlauf): Verlauf {
  const i = findeLaufend(v);
  if (i < 0) return v;
  const e = v.eintraege[i];
  // Ein Zug ohne ein einziges Wort (Kuro hat nur eine Tafel hingelegt oder nur gefragt) ist
  // trotzdem fertig; ein leerer, wartender Eintrag ohne alles fällt weg.
  if (!e.text && e.tafeln.length === 0 && e.rueckfrage === null) {
    return { eintraege: v.eintraege.filter((_, j) => j !== i) };
  }
  return ersetze(v, i, { ...e, stand: "fertig" });
}

/** Der Zug ist gescheitert. Die Meldung steht wörtlich da, wo die Antwort stehen sollte. */
export function scheitert(v: Verlauf, meldung: string, u: Umgebung): Verlauf {
  const i = findeLaufend(v);
  if (i < 0) return haenge(v, kuro(u, { text: meldung, stand: "fehler" }));
  const e = v.eintraege[i];
  const text = e.text ? `${e.text}\n\n${meldung}` : meldung;
  return ersetze(v, i, { ...e, text, stand: "fehler" });
}

/** Ein Nachtrag aus dem Postfach oder der Sprachschicht. Steht derselbe Text schon da, kam er
 * bereits über den Strom — dann bleibt es bei einem Eintrag. */
export function nachtrag(v: Verlauf, text: string, u: Umgebung): Verlauf {
  const knapp = text.trim();
  if (!knapp) return v;
  if (v.eintraege.some((e) => e.von === "kuro" && e.text.trim() === knapp)) return v;
  return haenge(v, kuro(u, { text, stand: "fertig" }));
}

/** Kuro legt eine Tafel hin — an die Antwort, die gerade entsteht, sonst an die letzte. */
export function tafel(v: Verlauf, t: Tafel, u: Umgebung): Verlauf {
  let i = findeLaufend(v);
  // Sonst an die letzte Antwort — aber nur, wenn sie der letzte Eintrag ist: nach Jakobs neuer
  // Frage gehört eine Tafel nicht mehr zur alten Antwort.
  if (i < 0 && v.eintraege.at(-1)?.von === "kuro") i = v.eintraege.length - 1;
  if (i < 0) return haenge(v, kuro(u, { tafeln: [t], stand: "fertig" }));
  const e = v.eintraege[i];
  if (e.tafeln.includes(t)) return v;
  return ersetze(v, i, { ...e, tafeln: [...e.tafeln, t] });
}

/** Kuro räumt die Tafeln weg (`ui.verberge`). Der Text bleibt. */
export function tafelnWeg(v: Verlauf): Verlauf {
  if (!v.eintraege.some((e) => e.tafeln.length > 0)) return v;
  return { eintraege: v.eintraege.map((e) => (e.tafeln.length ? { ...e, tafeln: [] } : e)) };
}

export interface OffeneFrage {
  askId: string;
  question: string;
  options: Option[];
  channel: string;
}

/**
 * Gleicht die offenen Rückfragen des Gateways mit dem Verlauf ab.
 *
 * Neue bekommen einen Platz — an der Antwort, die gerade entsteht, sonst einen eigenen. Eine, die
 * hier stand und beim Gateway nicht mehr offen ist, wurde anderswo beantwortet; sie bleibt mit
 * diesem Vermerk stehen, statt still zu verschwinden oder weiter Knöpfe anzubieten, die nichts
 * mehr bewirken.
 */
export function gleicheFragenAb(v: Verlauf, offen: readonly OffeneFrage[], u: Umgebung): Verlauf {
  const offeneIds = new Set(offen.map((f) => f.askId));
  let w: Verlauf = {
    eintraege: v.eintraege.map((e) =>
      e.rueckfrage && e.rueckfrage.antwort === null && !offeneIds.has(e.rueckfrage.askId)
        ? { ...e, rueckfrage: { ...e.rueckfrage, antwort: "anderswo" } }
        : e,
    ),
  };
  const bekannt = new Set(w.eintraege.flatMap((e) => (e.rueckfrage ? [e.rueckfrage.askId] : [])));
  for (const f of offen) {
    if (bekannt.has(f.askId)) continue;
    const rueckfrage: Rueckfrage = {
      askId: f.askId,
      frage: f.question,
      optionen: f.options,
      kanal: f.channel,
      antwort: null,
    };
    const i = findeLaufend(w);
    if (i >= 0 && w.eintraege[i].rueckfrage === null) {
      w = ersetze(w, i, { ...w.eintraege[i], rueckfrage });
    } else {
      w = haenge(w, kuro(u, { rueckfrage, stand: "fertig" }));
    }
  }
  return w;
}

export function beantwortet(v: Verlauf, askId: string, label: string): Verlauf {
  return {
    eintraege: v.eintraege.map((e) =>
      e.rueckfrage?.askId === askId ? { ...e, rueckfrage: { ...e.rueckfrage, antwort: label } } : e,
    ),
  };
}

/** Ob gerade eine Antwort entsteht. */
/**
 * Nur, was ab `ab` (ms) begann — und was noch wartet oder läuft. Jakob am 02.10.: „Chat
 * verschwindet nicht, auch wenn man das Gespräch archiviert." Nach dem Archivieren beginnt Kuro
 * frisch; was davor hier stand, steht im Archiv und nicht mehr auf der Startseite.
 */
export function abSeit(v: Verlauf, ab: number): Verlauf {
  const eintraege = v.eintraege.filter(
    (e) => e.zeit >= ab || e.stand === "wartet" || e.stand === "laeuft",
  );
  return eintraege.length === v.eintraege.length ? v : { eintraege };
}

export function laeuft(v: Verlauf): boolean {
  return findeLaufend(v) >= 0;
}

/** Ob eine Rückfrage auf Jakob wartet. */
export function wartetAufJakob(v: Verlauf): boolean {
  return v.eintraege.some((e) => e.rueckfrage !== null && e.rueckfrage.antwort === null);
}

/** Die jüngste Antwort von Kuro, für das Blatt über der Eingabe in den anderen Bereichen. */
export function letzteAntwort(v: Verlauf): Eintrag | null {
  for (let i = v.eintraege.length - 1; i >= 0; i--) {
    if (v.eintraege[i].von === "kuro") return v.eintraege[i];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Aufbewahren über ein Neuladen hinweg
// ---------------------------------------------------------------------------

export function speichere(v: Verlauf): string {
  return JSON.stringify({ fassung: 1, eintraege: v.eintraege.slice(-HOECHSTENS) });
}

function istEintrag(x: unknown): x is Eintrag {
  if (typeof x !== "object" || x === null) return false;
  const e = x as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    (e.von === "jakob" || e.von === "kuro") &&
    typeof e.text === "string" &&
    typeof e.zeit === "number" &&
    Array.isArray(e.tafeln)
  );
}

/**
 * Liest einen gespeicherten Verlauf. Was nicht passt, fällt weg — ein kaputter Seitenspeicher
 * ist kein Grund, die Oberfläche nicht zu öffnen.
 *
 * Ein Eintrag, der beim Schließen noch lief, gilt als fertig: ob sein Zug inzwischen zu Ende ist,
 * weiß nach dem Neuladen niemand. Kommt für ihn noch ein Stück, läuft er wieder.
 */
export function lade(json: string | null): Verlauf {
  if (!json) return leer();
  try {
    const roh = JSON.parse(json) as { fassung?: unknown; eintraege?: unknown };
    if (roh.fassung !== 1 || !Array.isArray(roh.eintraege)) return leer();
    const eintraege = roh.eintraege
      .filter(istEintrag)
      .map((e) => ({
        ...e,
        zugId: typeof e.zugId === "string" ? e.zugId : null,
        tafeln: e.tafeln.filter((t): t is Tafel => (TAFELN as readonly string[]).includes(t)),
        rueckfrage: e.rueckfrage ?? null,
        gesprochen: e.gesprochen === true,
        herkunft: typeof e.herkunft === "string" ? e.herkunft : null,
        stand: (e.stand === "wartet" || e.stand === "laeuft" ? "fertig" : e.stand) as Stand,
      }))
      .filter((e) => e.von === "jakob" || e.text || e.tafeln.length > 0 || e.rueckfrage);
    return { eintraege: eintraege.slice(-HOECHSTENS) };
  } catch {
    return leer();
  }
}
