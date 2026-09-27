/**
 * Kerzengröße und Zeitraum — zwei Dinge, die bis 2026-09-27 ein Knopf waren.
 *
 * Jakob las „1T" als Tageskerze, wie jeder, der Charts kennt, und bekam 5-Minuten-Kerzen. Seitdem
 * ist die **Kerzengröße** die Wahl (oben, wie bei TradingView), und der **Zeitraum** ist nur
 * noch der Ausschnitt, den der Chart zeigt (unten). Passt die Kerzengröße nicht zum Zeitraum —
 * 5-Minuten-Kerzen über fünf Jahre gibt es bei Yahoo nicht —, wechselt sie auf die nächste, die
 * passt, und die Oberfläche sagt dazu einen Satz. Stillschweigend wechselt nichts.
 */

export type IntervallId = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d" | "1wk" | "1mo";

export interface Intervall {
  id: IntervallId;
  /** Aufschrift des Knopfs. Ausgeschrieben, damit „1M" nicht Minute und Monat zugleich ist. */
  knopf: string;
  /** Wie die Kerzen heißen, für Legende und Hinweise. */
  wort: string;
  sekunden: number;
  /** Wie weit Yahoo für diese Größe zurückreicht, in Tagen; `null` heißt: alles. */
  historieTage: number | null;
}

export const INTERVALLE: readonly Intervall[] = [
  { id: "1m", knopf: "1 Min", wort: "1-Minuten-Kerzen", sekunden: 60, historieTage: 7 },
  { id: "5m", knopf: "5 Min", wort: "5-Minuten-Kerzen", sekunden: 300, historieTage: 59 },
  { id: "15m", knopf: "15 Min", wort: "15-Minuten-Kerzen", sekunden: 900, historieTage: 59 },
  { id: "30m", knopf: "30 Min", wort: "30-Minuten-Kerzen", sekunden: 1800, historieTage: 59 },
  { id: "1h", knopf: "1 Std", wort: "Stundenkerzen", sekunden: 3600, historieTage: 729 },
  { id: "4h", knopf: "4 Std", wort: "4-Stunden-Kerzen", sekunden: 14_400, historieTage: 729 },
  { id: "1d", knopf: "Tag", wort: "Tageskerzen", sekunden: 86_400, historieTage: null },
  { id: "1wk", knopf: "Woche", wort: "Wochenkerzen", sekunden: 604_800, historieTage: null },
  { id: "1mo", knopf: "Monat", wort: "Monatskerzen", sekunden: 2_629_800, historieTage: null },
];

export function intervall(id: string): Intervall {
  return INTERVALLE.find((i) => i.id === id) ?? (INTERVALLE[6] as Intervall);
}

export function istIntervallId(wert: unknown): wert is IntervallId {
  return typeof wert === "string" && INTERVALLE.some((i) => i.id === wert);
}

export type ZeitraumId = "1T" | "5T" | "1M" | "3M" | "6M" | "YTD" | "1J" | "5J" | "Alles";

export interface Zeitraum {
  id: ZeitraumId;
  knopf: string;
  titel: string;
  /** Kalendertage; `null` bei „Alles", bei YTD aus dem Datum gerechnet. */
  tage: number | null;
}

export const ZEITRAEUME: readonly Zeitraum[] = [
  { id: "1T", knopf: "1 Tag", titel: "Den letzten Handelstag zeigen", tage: 1 },
  { id: "5T", knopf: "5 Tage", titel: "Die letzten fünf Tage zeigen", tage: 5 },
  { id: "1M", knopf: "1 Monat", titel: "Den letzten Monat zeigen", tage: 30 },
  { id: "3M", knopf: "3 Monate", titel: "Die letzten drei Monate zeigen", tage: 91 },
  { id: "6M", knopf: "6 Monate", titel: "Das letzte halbe Jahr zeigen", tage: 182 },
  { id: "YTD", knopf: "YTD", titel: "Seit Jahresbeginn zeigen", tage: null },
  { id: "1J", knopf: "1 Jahr", titel: "Das letzte Jahr zeigen", tage: 365 },
  { id: "5J", knopf: "5 Jahre", titel: "Die letzten fünf Jahre zeigen", tage: 1826 },
  { id: "Alles", knopf: "Alles", titel: "Die ganze Historie zeigen", tage: null },
];

export function zeitraum(id: string): Zeitraum | undefined {
  return ZEITRAEUME.find((z) => z.id === id);
}

/** Wie viele Tage ein Zeitraum am Tag `jetzt` umfasst. `null` heißt: alles. */
export function zeitraumTage(z: Zeitraum, jetzt: Date): number | null {
  if (z.id === "Alles") return null;
  if (z.id === "YTD") {
    const anfang = Date.UTC(jetzt.getUTCFullYear(), 0, 1);
    return Math.max(1, Math.ceil((jetzt.getTime() - anfang) / 86_400_000));
  }
  return z.tage;
}

/** Unter so vielen Kerzen ist ein Ausschnitt kein Chart mehr. */
export const MINDEST_KERZEN = 20;

/**
 * Wie viele Kerzen ein Zeitraum in einer Größe ergibt. Unter einem Tag zählt nur die
 * Handelszeit: der DAX handelt 8,5 von 24 Stunden, ein Tag in Stundenkerzen sind dort neun
 * Kerzen, nicht 24. Ab der Tageskerze zählt der Kalender.
 */
export function kerzenImZeitraum(tage: number, iv: Intervall, handelsanteil: number): number {
  if (iv.sekunden >= 86_400) return (tage * 86_400) / iv.sekunden;
  return (tage * 86_400 * handelsanteil) / iv.sekunden;
}

function taugt(tage: number | null, iv: Intervall, handelsanteil: number): boolean {
  if (tage === null) return iv.historieTage === null;
  if (iv.historieTage !== null && iv.historieTage < tage) return false;
  return kerzenImZeitraum(tage, iv, handelsanteil) >= MINDEST_KERZEN;
}

/**
 * Die Kerzengröße für einen Zeitraum: die jetzige, wenn sie taugt — sonst die ihr nächste, die
 * taugt. „Nächste" nach Stellung in der Reihe, damit der Sprung so klein wie möglich ist: von
 * Stundenkerzen auf fünf Jahre geht es zur Tageskerze, nicht zur Monatskerze.
 *
 * `handelsanteil` ist der Anteil des Tages, an dem gehandelt wird (DAX 0,35, Bitcoin 1).
 */
export function passendesIntervall(
  tage: number | null,
  aktuell: IntervallId,
  handelsanteil = 1,
): IntervallId {
  const jetzt = intervall(aktuell);
  if (taugt(tage, jetzt, handelsanteil)) return aktuell;
  const stelle = INTERVALLE.findIndex((i) => i.id === aktuell);
  let beste: Intervall | null = null;
  let abstand = Number.POSITIVE_INFINITY;
  INTERVALLE.forEach((iv, i) => {
    if (!taugt(tage, iv, handelsanteil)) return;
    const d = Math.abs(i - stelle);
    // Bei gleichem Abstand die gröbere: sie trägt den Zeitraum sicherer.
    if (d < abstand || (d === abstand && i > stelle)) {
      beste = iv;
      abstand = d;
    }
  });
  return (beste as Intervall | null)?.id ?? aktuell;
}

/**
 * Der Anteil des Tages, an dem gehandelt wird, aus der Sitzung des Kurskopfs. Ohne Sitzung
 * (oder bei Bitcoin, dessen Sitzung Yahoo als 00:00–23:59 führt) ist es der ganze Tag.
 */
export function handelsanteilAus(sitzung: { start: number; ende: number } | undefined): number {
  if (!sitzung) return 1;
  const dauer = sitzung.ende - sitzung.start;
  if (!(dauer > 0) || dauer >= 86_000) return 1;
  return Math.min(1, dauer / 86_400);
}

/**
 * Wo ein Zeitraum beginnt, gerechnet von der letzten Kerze aus; `null` heißt: alles.
 *
 * „1 Tag" ist der letzte Handelstag — ab Mitternacht (Ortszeit) des Tages der letzten Kerze —,
 * nicht die letzten 24 Stunden: am Wochenende zeigten die beim DAX den Freitag und dazu die
 * letzte Stunde vom Donnerstag. Was rund um die Uhr handelt (Anteil 1), behält die 24 Stunden,
 * sonst stünde Bitcoin am Sonntag um zehn Uhr mit zehn Stunden da.
 */
export function zeitraumVon(
  z: Zeitraum,
  letzte: number,
  jetzt: Date,
  handelsanteil = 1,
): number | null {
  const tage = zeitraumTage(z, jetzt);
  if (tage === null) return null;
  if (z.id === "1T" && handelsanteil < 1) {
    const d = new Date(letzte * 1000);
    d.setHours(0, 0, 0, 0);
    return d.getTime() / 1000;
  }
  return letzte - tage * 86_400;
}

// ------------------------------------------------------------------------------ Telefon

/**
 * Auf dem Telefon gibt es nur den Zeitraum (Jakob, 2026-09-27: „am Handy ist das zu viel
 * Information"). Die Kerzengröße folgt ihm fest, wie in der Aktien-App, und steht klein im
 * Kopf der Ansicht — auch hier wechselt nichts stillschweigend. Gewählt für rund 60 bis 250
 * Kerzen je Zeitraum: mehr sind auf 400 Pixeln nur noch Striche.
 */
export interface HandyZeitraum {
  id: ZeitraumId;
  kerze: IntervallId;
  /** Wie die Änderung über den Zeitraum heißt: „+3 % in 3 Monaten". */
  seit: string;
  /**
   * Die Kachel der Wertentwicklung mit derselben Spanne. Gibt es sie, steht im Kopf **ihre**
   * Zahl: selbst gerechnet ab der letzten Kerze stand am Sonntag „+1,66 % in 3 Monaten" über
   * einer Kachel „3M +2,99 %" — zwei Tage Versatz, zwei Zahlen für dasselbe.
   */
  kachel?: string;
}

export const HANDY_ZEITRAEUME: readonly HandyZeitraum[] = [
  { id: "1T", kerze: "5m", seit: "am letzten Handelstag" },
  { id: "5T", kerze: "30m", seit: "in 5 Tagen" },
  { id: "1M", kerze: "4h", seit: "in einem Monat", kachel: "1M" },
  { id: "3M", kerze: "1d", seit: "in 3 Monaten", kachel: "3M" },
  { id: "1J", kerze: "1d", seit: "in einem Jahr", kachel: "1J" },
  { id: "5J", kerze: "1wk", seit: "in 5 Jahren", kachel: "5J" },
];

export function handyZeitraum(id: string): HandyZeitraum | undefined {
  return HANDY_ZEITRAEUME.find((z) => z.id === id);
}

/**
 * Die Kerzengröße eines Telefon-Zeitraums. Die Tabelle ist der Wunsch; trägt er nicht (ein
 * Markt mit kurzer Sitzung, zu wenig Historie), entscheidet dieselbe Regel wie am Schreibtisch.
 */
export function handyIntervall(z: HandyZeitraum, jetzt: Date, handelsanteil = 1): IntervallId {
  const zr = zeitraum(z.id);
  return zr ? passendesIntervall(zeitraumTage(zr, jetzt), z.kerze, handelsanteil) : z.kerze;
}

// ------------------------------------------------------------------------------ Ortszeit

/**
 * Der Chart rechnet in UTC. Ohne Verschiebung stünde der DAX-Handelsbeginn bei 07:00 statt
 * 09:00 — so zeigte es die alte Ansicht, zwei Stunden daneben. Die Kerzen werden deshalb für
 * die Anzeige um den Abstand der Ortszeit verschoben, Stempel für Stempel (Sommerzeit!), und
 * zurückgerechnet, wo ein Klick im Chart zu einer echten Zeit werden muss.
 */
export function anzeigeZeit(unix: number): number {
  return unix - new Date(unix * 1000).getTimezoneOffset() * 60;
}

export function echteZeit(anzeige: number): number {
  // Erst mit dem Abstand an der Anzeigestelle, dann mit dem am Ergebnis — trägt über die
  // Umstellung der Sommerzeit hinweg.
  const erst = anzeige + new Date(anzeige * 1000).getTimezoneOffset() * 60;
  return anzeige + new Date(erst * 1000).getTimezoneOffset() * 60;
}

/** Die Zeitzone des Browsers als kurzes Kürzel, für die Uhr unten rechts. */
export function zonenKuerzel(datum: Date): string {
  try {
    const teil = new Intl.DateTimeFormat("de-DE", { timeZoneName: "short" })
      .formatToParts(datum)
      .find((t) => t.type === "timeZoneName");
    return teil?.value ?? "";
  } catch {
    return "";
  }
}
