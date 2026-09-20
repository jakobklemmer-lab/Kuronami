import type { Richtung } from "./crv.js";
import type { MarketCandle } from "./integrations/markets.js";

/**
 * Was aus einer Einschätzung von damals geworden ist.
 *
 * Der Handelstisch legt Ideen vor: Einstieg, Stop, Ziel. Ob sie taugten, stand bisher nirgends
 * — die Idee verschwand im Archiv und niemand rechnete nach. Jakobs Anspruch: „dass sie sich an
 * vergangenen Punkten eine Analyse machen können, um dann das Ergebnis der Analyse zu
 * backtesten."
 *
 * Das hier ist die Auswertung **einer einzelnen** Idee gegen den tatsächlichen Verlauf. Es ist
 * ausdrücklich kein Strategie-Backtest (`backtest.ts`): eine nachrichtengetriebene Einzelidee
 * hat kein wiederkehrendes Muster, das man optimieren könnte. Sie hat aber ein Ergebnis, und das
 * gehört gemessen.
 *
 * **Die Annahmen stehen hier und nicht im Bericht, damit sie jeder nachlesen kann:**
 *  * Eingestiegen wird bei der ersten Kerze, deren Spanne den Einstiegskurs berührt. Wer nie
 *    berührt wurde, ist nie eingestiegen — eine Idee, die am Markt vorbeilief, war keine gute.
 *  * Liegen Stop und Ziel in derselben Kerze, zählt der Stop. Ohne Tickdaten weiß niemand, was
 *    zuerst kam, und die günstige Annahme schmeichelt.
 *  * MFE und MAE (der beste und der schlechteste Stand während des Handels, in R) stehen
 *    dabei: sie sagen, ob ein Stop knapp danebenlag oder die These nie trug.
 */

export interface Idee {
  richtung: Richtung;
  einstieg: number;
  stop: number;
  /** Ein bis drei Ziele in der Reihenfolge, in der sie erreicht würden. */
  ziele: readonly number[];
}

export type IdeeAusgang = "ziel" | "stop" | "offen" | "nie_eingestiegen";

export interface RueckblickErgebnis {
  ausgang: IdeeAusgang;
  einstiegZeit: number | null;
  ausstiegZeit: number | null;
  /** Welches Ziel erreicht wurde (1-basiert), sonst null. */
  zielNummer: number | null;
  /** Ergebnis in Vielfachen des Risikos; null, solange nichts abgeschlossen ist. */
  r: number | null;
  /** Der beste Stand während des Handels, in R. */
  mfeR: number | null;
  /** Der schlechteste Stand während des Handels, in R — wie nah der Stop wirklich war. */
  maeR: number | null;
  kerzenImMarkt: number;
  /** Stand am Ende des betrachteten Zeitraums. */
  letzterKurs: number;
  /** Was der Kurs im Zeitraum insgesamt tat, unabhängig von der Idee. */
  hoechster: number;
  tiefster: number;
}

export function werteIdeeAus(idee: Idee, kerzen: readonly MarketCandle[]): RueckblickErgebnis {
  const long = idee.richtung === "long";
  const risiko = Math.abs(idee.einstieg - idee.stop);
  const hoechster = kerzen.reduce((a, k) => Math.max(a, k.high), Number.NEGATIVE_INFINITY);
  const tiefster = kerzen.reduce((a, k) => Math.min(a, k.low), Number.POSITIVE_INFINITY);
  const letzterKurs = kerzen.length > 0 ? kerzen[kerzen.length - 1].close : Number.NaN;

  const leer: RueckblickErgebnis = {
    ausgang: "nie_eingestiegen",
    einstiegZeit: null,
    ausstiegZeit: null,
    zielNummer: null,
    r: null,
    mfeR: null,
    maeR: null,
    kerzenImMarkt: 0,
    letzterKurs,
    hoechster,
    tiefster,
  };
  if (kerzen.length === 0 || risiko === 0) return leer;

  const start = kerzen.findIndex((k) => k.low <= idee.einstieg && idee.einstieg <= k.high);
  if (start === -1) return leer;

  const ziele = [...idee.ziele].sort((a, b) => (long ? a - b : b - a));
  let mfe = 0;
  let mae = 0;

  for (let i = start; i < kerzen.length; i += 1) {
    const k = kerzen[i];
    const bester = long ? k.high - idee.einstieg : idee.einstieg - k.low;
    const schlechtester = long ? k.low - idee.einstieg : idee.einstieg - k.high;
    mfe = Math.max(mfe, bester / risiko);
    mae = Math.min(mae, schlechtester / risiko);

    const stopGetroffen = long ? k.low <= idee.stop : k.high >= idee.stop;
    if (stopGetroffen) {
      return {
        ausgang: "stop",
        einstiegZeit: kerzen[start].time,
        ausstiegZeit: k.time,
        zielNummer: null,
        r: -1,
        mfeR: mfe,
        maeR: mae,
        kerzenImMarkt: i - start,
        letzterKurs,
        hoechster,
        tiefster,
      };
    }
    for (let z = ziele.length - 1; z >= 0; z -= 1) {
      const ziel = ziele[z];
      const erreicht = long ? k.high >= ziel : k.low <= ziel;
      if (erreicht) {
        return {
          ausgang: "ziel",
          einstiegZeit: kerzen[start].time,
          ausstiegZeit: k.time,
          zielNummer: z + 1,
          r: Math.abs(ziel - idee.einstieg) / risiko,
          mfeR: mfe,
          maeR: mae,
          kerzenImMarkt: i - start,
          letzterKurs,
          hoechster,
          tiefster,
        };
      }
    }
  }

  const offenR = (long ? letzterKurs - idee.einstieg : idee.einstieg - letzterKurs) / risiko;
  return {
    ausgang: "offen",
    einstiegZeit: kerzen[start].time,
    ausstiegZeit: null,
    zielNummer: null,
    r: offenR,
    mfeR: mfe,
    maeR: mae,
    kerzenImMarkt: kerzen.length - 1 - start,
    letzterKurs,
    hoechster,
    tiefster,
  };
}

function tag(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

function zahl(wert: number): string {
  const betrag = Math.abs(wert);
  return wert.toFixed(betrag >= 1000 ? 2 : betrag >= 1 ? 3 : 6);
}

export function formatiereRueckblick(
  idee: Idee,
  ergebnis: RueckblickErgebnis,
  umfeld: { symbol?: string; von?: string; bis?: string } = {},
): string {
  const kopf = `${umfeld.symbol ?? "Idee"} · ${idee.richtung === "long" ? "Long" : "Short"} · Einstieg ${zahl(idee.einstieg)}, Stop ${zahl(idee.stop)}, Ziele ${idee.ziele.map(zahl).join(" / ")}`;
  const zeilen = [kopf];
  if (umfeld.von || umfeld.bis) {
    zeilen.push(`Geprüft von ${umfeld.von ?? "?"} bis ${umfeld.bis ?? "?"}`);
  }
  zeilen.push("");

  switch (ergebnis.ausgang) {
    case "nie_eingestiegen":
      zeilen.push(
        "**Nie eingestiegen.** Der Kurs hat den Einstiegsbereich in diesem Zeitraum nicht berührt.",
        `Er lief zwischen ${zahl(ergebnis.tiefster)} und ${zahl(ergebnis.hoechster)}.`,
      );
      break;
    case "stop":
      zeilen.push(
        `**Ausgestoppt** am ${tag(ergebnis.ausstiegZeit as number)}, ${ergebnis.kerzenImMarkt} Kerzen nach dem Einstieg (${tag(ergebnis.einstiegZeit as number)}).`,
        `Ergebnis −1,00 R. Bester Stand zwischendurch: ${(ergebnis.mfeR ?? 0).toFixed(2)} R.`,
      );
      if ((ergebnis.mfeR ?? 0) >= 1) {
        zeilen.push(
          "Die Idee lag zwischendurch mindestens 1 R vorn und drehte dann — nicht die These war falsch, sondern das Ausstiegsmanagement fehlte.",
        );
      }
      break;
    case "ziel":
      zeilen.push(
        `**Ziel ${ergebnis.zielNummer} erreicht** am ${tag(ergebnis.ausstiegZeit as number)}, ${ergebnis.kerzenImMarkt} Kerzen nach dem Einstieg (${tag(ergebnis.einstiegZeit as number)}).`,
        `Ergebnis +${(ergebnis.r ?? 0).toFixed(2)} R. Schlechtester Stand zwischendurch: ${(ergebnis.maeR ?? 0).toFixed(2)} R.`,
      );
      if ((ergebnis.maeR ?? 0) <= -0.8) {
        zeilen.push(
          "Der Stop war nur knapp nicht getroffen — bei etwas weniger Glück wäre dieselbe Idee ein Verlust gewesen.",
        );
      }
      break;
    default:
      zeilen.push(
        `**Noch offen** seit ${tag(ergebnis.einstiegZeit as number)}, ${ergebnis.kerzenImMarkt} Kerzen im Markt.`,
        `Aktueller Stand ${(ergebnis.r ?? 0).toFixed(2)} R bei ${zahl(ergebnis.letzterKurs)}; zwischendurch zwischen ${(ergebnis.maeR ?? 0).toFixed(2)} und ${(ergebnis.mfeR ?? 0).toFixed(2)} R.`,
      );
  }

  zeilen.push(
    "",
    "Gerechnet gegen den tatsächlichen Verlauf. Eingestiegen bei der ersten Kerze, die den",
    "Einstiegskurs berührt; liegen Stop und Ziel in derselben Kerze, zählt der Stop.",
  );
  return zeilen.join("\n");
}
