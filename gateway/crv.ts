import { DauerFehler, formatiereHaltedauer, messeHaltedauer } from "./haltedauer.js";
import type { MarketCandle, MarketChart } from "./integrations/markets.js";

/**
 * Das Chance-Risiko-Verhältnis, gerechnet statt geschätzt.
 *
 * **Warum das ein eigenes Modul ist.** Am 2026-09-20 stand in einem Bericht des Handelstischs
 * „CRV 0,86:1" — eine Zahl, die kein Rechner ausgegeben hat, sondern ein Sprachmodell im Kopf.
 * Der Prompt der Gegenprüfung verlangte ausdrücklich, das CRV „mit Bash (python3) selbst
 * auszurechnen"; Bash trägt auf diesem Rechner aber nicht (verschachtelte Namensräume sind
 * gesperrt, siehe `sandkasten.ts`), und so blieb von der Vorschrift nur eine Schätzung mit zwei
 * Nachkommastellen. Jakobs Satz dazu: „Chance-Risiko-Verhältnis ist fürs Trading unfassbar
 * wichtig, das darf nicht geschätzt werden."
 *
 * Hier rechnet Code. Kein Modell, keine Shell, keine Umrechnung im Kopf — und bei einer Eingabe,
 * die keinen Sinn ergibt (Stop auf der falschen Seite des Einstiegs), kommt ein Fehler mit
 * Begründung zurück und **keine** Zahl. Eine falsche Kennzahl ist schlimmer als keine: sie sieht
 * aus wie ein Befund.
 */

export type Richtung = "long" | "short";

export interface CrvEingabe {
  richtung: Richtung;
  einstieg: number;
  stop: number;
  /** Ein bis drei Kursziele, in der Reihenfolge, in der sie erreicht würden. */
  ziele: readonly number[];
  /** Für die Positionsgröße: das eingesetzte Gesamtkapital. */
  kapital?: number;
  /** Für die Positionsgröße: wie viel Prozent davon dieser Handel riskieren darf. */
  risikoProzent?: number;
}

export interface CrvZiel {
  ziel: number;
  /** Gewinn je Einheit, wenn das Ziel erreicht wird. */
  chance: number;
  /** Chance geteilt durch Risiko. 2 heißt: zwei Euro Gewinn je Euro Risiko. */
  crv: number;
  abstandProzent: number;
  /**
   * Ab welcher Trefferquote dieser Handel auf Dauer trägt: `1 / (1 + CRV)`. Reine Arithmetik,
   * kein Urteil — bei einem CRV von 1 sind es 50 %, bei 0,86 schon 53,8 %.
   */
  breakevenTrefferquote: number;
}

export interface CrvPosition {
  kapital: number;
  risikoProzent: number;
  risikoBetrag: number;
  /** Stückzahl, kaufmännisch nicht gerundet — bei Aktien rundet der Leser selbst ab. */
  stueck: number;
  positionswert: number;
  /** Anteil des Kapitals, den die Position bindet. Über 100 % heißt: nur mit Hebel. */
  positionsanteilProzent: number;
}

export interface CrvErgebnis {
  richtung: Richtung;
  einstieg: number;
  stop: number;
  /** Verlust je Einheit, wenn der Stop greift. Immer positiv. */
  risikoJeEinheit: number;
  stopAbstandProzent: number;
  ziele: CrvZiel[];
  position?: CrvPosition;
}

/** Eine Eingabe, die keinen Handel beschreibt. Wird nie mit einer Zahl beantwortet. */
export class CrvEingabeFehler extends Error {}

function pruefeZahl(wert: number, name: string): void {
  if (!Number.isFinite(wert)) {
    throw new CrvEingabeFehler(`${name} ist keine Zahl.`);
  }
  if (wert <= 0) {
    throw new CrvEingabeFehler(
      `${name} ist ${wert}. Kurse, Stops und Ziele sind positiv — kommt hier eine 0 an, fehlt die Zahl, und eine fehlende Zahl wird nicht ersetzt.`,
    );
  }
}

/**
 * Rechnet, was rechenbar ist, und weist ab, was keinen Handel beschreibt.
 *
 * Die Seitenprüfung ist der eigentliche Wert dieser Funktion: ein Stop **über** dem Einstieg
 * ergibt bei einer Long-Idee ein negatives Risiko, und daraus wird ohne Prüfung ein hübsches,
 * völlig falsches CRV. Genau so entsteht eine Zahl, der niemand ansieht, dass sie Unsinn ist.
 */
export function rechneCrv(eingabe: CrvEingabe): CrvErgebnis {
  const { richtung, einstieg, stop } = eingabe;
  pruefeZahl(einstieg, "Der Einstieg");
  pruefeZahl(stop, "Der Stop");
  if (eingabe.ziele.length === 0) {
    throw new CrvEingabeFehler("Ohne Kursziel gibt es keine Chance zu rechnen.");
  }
  for (const ziel of eingabe.ziele) pruefeZahl(ziel, "Ein Kursziel");

  const long = richtung === "long";
  if (long && stop >= einstieg) {
    throw new CrvEingabeFehler(
      `Long mit Stop ${stop} über oder auf dem Einstieg ${einstieg}: der Stop liegt auf der falschen Seite. Entweder ist die Richtung short, oder eine der beiden Zahlen ist vertauscht.`,
    );
  }
  if (!long && stop <= einstieg) {
    throw new CrvEingabeFehler(
      `Short mit Stop ${stop} unter oder auf dem Einstieg ${einstieg}: der Stop liegt auf der falschen Seite. Entweder ist die Richtung long, oder eine der beiden Zahlen ist vertauscht.`,
    );
  }
  for (const ziel of eingabe.ziele) {
    if (long && ziel <= einstieg) {
      throw new CrvEingabeFehler(
        `Long mit Ziel ${ziel} unter oder auf dem Einstieg ${einstieg}: das ist kein Gewinnziel.`,
      );
    }
    if (!long && ziel >= einstieg) {
      throw new CrvEingabeFehler(
        `Short mit Ziel ${ziel} über oder auf dem Einstieg ${einstieg}: das ist kein Gewinnziel.`,
      );
    }
  }

  const risikoJeEinheit = Math.abs(einstieg - stop);
  const ziele = [...eingabe.ziele]
    .sort((a, b) => (long ? a - b : b - a))
    .map((ziel) => {
      const chance = Math.abs(ziel - einstieg);
      const crv = chance / risikoJeEinheit;
      return {
        ziel,
        chance,
        crv,
        abstandProzent: (chance / einstieg) * 100,
        breakevenTrefferquote: 1 / (1 + crv),
      };
    });

  const ergebnis: CrvErgebnis = {
    richtung,
    einstieg,
    stop,
    risikoJeEinheit,
    stopAbstandProzent: (risikoJeEinheit / einstieg) * 100,
    ziele,
  };

  const { kapital, risikoProzent } = eingabe;
  if (kapital !== undefined || risikoProzent !== undefined) {
    if (kapital === undefined || risikoProzent === undefined) {
      throw new CrvEingabeFehler(
        "Für die Positionsgröße braucht es beides: Kapital und den Prozentsatz, den dieser " +
          "Handel davon riskieren darf. Eins von beidem zu raten ist genau das, was hier nicht passiert.",
      );
    }
    pruefeZahl(kapital, "Das Kapital");
    if (!Number.isFinite(risikoProzent) || risikoProzent <= 0 || risikoProzent > 100) {
      throw new CrvEingabeFehler(
        `Der Risikoanteil ist ${risikoProzent} %. Erlaubt ist mehr als 0 und höchstens 100.`,
      );
    }
    const risikoBetrag = (kapital * risikoProzent) / 100;
    const stueck = risikoBetrag / risikoJeEinheit;
    const positionswert = stueck * einstieg;
    ergebnis.position = {
      kapital,
      risikoProzent,
      risikoBetrag,
      stueck,
      positionswert,
      positionsanteilProzent: (positionswert / kapital) * 100,
    };
  }

  return ergebnis;
}

/**
 * Die durchschnittliche wahre Tagesspanne (ATR) über `periode` Kerzen.
 *
 * Einfacher Mittelwert der True Ranges, nicht Wilders geglättete Fassung: der Unterschied ist
 * für die Frage „ist der Stop enger als ein gewöhnlicher Tag" bedeutungslos, und ein Mittelwert
 * lässt sich aus der Kerzentabelle nachrechnen, die im selben Bericht steht.
 *
 * Die erste Kerze hat keinen Vorschluss und fällt heraus. Kommen weniger Kerzen als `periode`,
 * gibt es **kein** Ergebnis statt eines aus drei Tagen gemittelten Zufallswerts.
 */
export function atr(candles: readonly MarketCandle[], periode = 14): number | undefined {
  if (candles.length < periode + 1) return undefined;
  const spannen: number[] = [];
  for (let i = 1; i < candles.length; i += 1) {
    const k = candles[i];
    const vorher = candles[i - 1].close;
    spannen.push(Math.max(k.high - k.low, Math.abs(k.high - vorher), Math.abs(k.low - vorher)));
  }
  const letzte = spannen.slice(-periode);
  if (letzte.length < periode) return undefined;
  return letzte.reduce((a, b) => a + b, 0) / periode;
}

function zahl(wert: number): string {
  const betrag = Math.abs(wert);
  const stellen = betrag >= 1000 ? 2 : betrag >= 1 ? 3 : 6;
  return wert.toFixed(stellen);
}

function prozent(wert: number): string {
  return `${wert.toFixed(2)} %`;
}

export interface CrvUmfeld {
  /** Der Verlauf desselben Wertes — für ATR, aktuellen Kurs und 52-Wochen-Spanne. */
  chart?: MarketChart;
}

/**
 * Das Ergebnis als Text für den Bericht.
 *
 * Die Zeilen sind bewusst so geschrieben, dass sie wörtlich in einen Bericht dürfen: wer sie
 * abschreibt, schreibt gerechnete Zahlen ab. Urteile stehen nicht darin — ob eine Idee tragfähig
 * ist, entscheidet die Gegenprüfung, nicht der Taschenrechner. Ausnahme sind die zwei Sätze, die
 * selbst Arithmetik sind: der Abstand des Stops in ATR-Einheiten und die Trefferquote, ab der
 * sich ein Handel rechnet.
 */
export function formatiereCrv(ergebnis: CrvErgebnis, umfeld: CrvUmfeld = {}): string {
  const { chart } = umfeld;
  const kopf = chart ? `${chart.symbol} — ${chart.name}` : "Chance-Risiko-Rechnung";
  const zeilen: string[] = [
    `${kopf} · ${ergebnis.richtung === "long" ? "Long" : "Short"}`,
    "",
    `Einstieg ${zahl(ergebnis.einstieg)}, Stop ${zahl(ergebnis.stop)}`,
    `Risiko je Einheit ${zahl(ergebnis.risikoJeEinheit)} (${prozent(ergebnis.stopAbstandProzent)} vom Einstieg)`,
    "",
    "Ziel  Gewinn/Einheit  Abstand  CRV  ab Trefferquote",
  ];
  for (const z of ergebnis.ziele) {
    zeilen.push(
      [
        zahl(z.ziel),
        zahl(z.chance),
        prozent(z.abstandProzent),
        `${z.crv.toFixed(2)}:1`,
        prozent(z.breakevenTrefferquote * 100),
      ].join("  "),
    );
  }

  if (ergebnis.ziele.length > 0) {
    const erstes = ergebnis.ziele[0];
    zeilen.push(
      "",
      `Auf das erste Ziel gerechnet: ${erstes.crv.toFixed(2)}:1. Dieser Handel trägt ab einer Trefferquote von ${prozent(erstes.breakevenTrefferquote * 100)} — darunter verliert er auf Dauer Geld, auch wenn er einzeln aufgeht.`,
    );
  }

  if (chart) {
    const tagesspanne = atr(chart.candles);
    if (tagesspanne !== undefined && tagesspanne > 0) {
      const inAtr = ergebnis.risikoJeEinheit / tagesspanne;
      // Die Benennung folgt dem Intervall. „Tagesspanne" über Fünfminutenkerzen wäre schlicht
      // falsch — und zwar auf die teure Art: der Leser hielte einen Stop für weit, der eine
      // Viertelstunde übersteht.
      const spannenName =
        chart.interval === "1d" ? "Tagesspanne" : `Spanne je ${chart.interval}-Kerze`;
      const spannenNameMehrzahl =
        chart.interval === "1d" ? "Tagesspannen" : `Spannen je ${chart.interval}-Kerze`;
      zeilen.push(
        "",
        `Durchschnittliche ${spannenName} (ATR 14, ${chart.range}/${chart.interval}): ${zahl(tagesspanne)}`,
        `Der Stop liegt ${inAtr.toFixed(2)} ${spannenNameMehrzahl} vom Einstieg entfernt.${inAtr < 1 ? " Das ist weniger als eine gewöhnliche Kerze — gewöhnliches Rauschen nimmt ihn mit, ohne dass die These falsch war." : ""}`,
      );
    } else {
      zeilen.push(
        "",
        "Keine Tagesspanne gerechnet: der übergebene Verlauf hat zu wenige Kerzen (mindestens 15).",
      );
    }

    zeilen.push(`Kurs jetzt: ${zahl(chart.price)}`);
    const long = ergebnis.richtung === "long";
    const durchlaufen = long ? chart.price > ergebnis.einstieg : chart.price < ergebnis.einstieg;
    const ausgestoppt = long ? chart.price <= ergebnis.stop : chart.price >= ergebnis.stop;
    if (ausgestoppt) {
      zeilen.push(
        "**Der Kurs steht bereits jenseits des Stops.** Diese Idee ist keine Idee mehr, sondern eine Nachbetrachtung.",
      );
    } else if (durchlaufen) {
      zeilen.push(
        `Der Kurs hat den Einstieg schon durchlaufen (${prozent((Math.abs(chart.price - ergebnis.einstieg) / ergebnis.einstieg) * 100)} darüber hinaus). Gerechnet ist oben der genannte Einstieg, nicht der aktuelle Kurs.`,
      );
    }
    if (chart.weekHigh52 !== undefined && chart.weekLow52 !== undefined) {
      const spanne = chart.weekHigh52 - chart.weekLow52;
      const lage = spanne > 0 ? ((chart.price - chart.weekLow52) / spanne) * 100 : 0;
      zeilen.push(
        `52 Wochen: Tief ${zahl(chart.weekLow52)}, Hoch ${zahl(chart.weekHigh52)} — der Kurs steht bei ${prozent(lage)} dieser Spanne.`,
      );
    }
  }

  // Die Zeitachse. Ohne sie sind Einstieg, Stop und Ziel drei Kurse ohne Angabe, worauf sich
  // der Leser einlässt — dieselbe Geometrie ist auf Tageskerzen ein Handel über Wochen und auf
  // Fünfminutenkerzen einer über eine halbe Stunde. Siehe `haltedauer.ts`.
  if (chart && ergebnis.ziele.length > 0) {
    try {
      const dauer = messeHaltedauer({
        kerzen: chart.candles,
        richtung: ergebnis.richtung,
        einstieg: ergebnis.einstieg,
        stop: ergebnis.stop,
        ziel: ergebnis.ziele[0].ziel,
      });
      zeilen.push("", formatiereHaltedauer(dauer, chart.interval));
    } catch (fehler) {
      // Eine fehlende Haltedauer ist kein Grund, die gerechneten Kennzahlen zurückzuhalten —
      // aber der Grund wird genannt, statt die Zeile stillschweigend wegzulassen.
      if (fehler instanceof DauerFehler) {
        zeilen.push("", `Keine Haltedauer gerechnet: ${fehler.message}`);
      } else {
        throw fehler;
      }
    }
  }

  if (ergebnis.position) {
    const p = ergebnis.position;
    zeilen.push(
      "",
      `Positionsgröße bei ${zahl(p.kapital)} Kapital und ${prozent(p.risikoProzent)} Risiko:`,
      `Einsatz im Verlustfall ${zahl(p.risikoBetrag)} → ${zahl(p.stueck)} Einheiten, Positionswert ${zahl(p.positionswert)} (${prozent(p.positionsanteilProzent)} des Kapitals)${p.positionsanteilProzent > 100 ? " — das geht nur mit Hebel." : ""}`,
    );
  }

  zeilen.push("", "Gerechnet, nicht geschätzt (gateway/crv.ts).");
  return zeilen.join("\n");
}

/**
 * Behauptet dieser Text ein Chance-Risiko-Verhältnis?
 *
 * Absichtlich eng: gesucht wird der Begriff **und** eine Zahl in seiner Nähe. „Das
 * Chance-Risiko-Verhältnis ist dünn" ist eine Einschätzung und bleibt unbeanstandet; „CRV
 * 0,86:1" ist eine Kennzahl und gehört gerechnet. Ein Fehlalarm wäre hier teurer als eine
 * übersehene Stelle — er würde einen sauberen Bericht mit einem Warnhinweis entwerten.
 */
export function behauptetCrv(text: string): boolean {
  const muster =
    /(crv|chance[-/ ]?risiko(?:[- ]verh[äa]ltnis)?|chance[-/ ]?risiko[-/ ]?lage|risk[ -]?reward|\brrr?\b)[^\n]{0,40}?\d/i;
  return muster.test(text);
}

/** Der Vermerk, der an einen Bericht kommt, dessen CRV niemand gerechnet hat. */
export const CRV_VERMERK =
  "⚠ **Diese CRV-Angabe ist nicht gerechnet.** Im Lauf wurde das Werkzeug `crv` nicht " +
  "aufgerufen — die Zahl stammt aus dem Modell, nicht aus einer Rechnung. Jakobs Regel für " +
  "den Handelstisch: das Chance-Risiko-Verhältnis wird gerechnet, nicht geschätzt.";

/**
 * Hängt den Vermerk an, wenn eine Kennzahl behauptet, aber nicht gerechnet wurde.
 *
 * Kein Abweisen des ganzen Berichts: ein Lauf des Handelstischs dauert Minuten und kostet
 * Geld, und der Rest der Arbeit ist deshalb nicht falsch. Aber die Zahl bekommt ihr Etikett,
 * und zwar dort, wo sie gelesen wird — im Bericht selbst, nicht in einem Protokoll, das
 * niemand aufschlägt.
 */
export function crvVermerk(bericht: string, gerechnet: boolean): string {
  if (gerechnet || !behauptetCrv(bericht)) return bericht;
  return `${bericht}\n\n${CRV_VERMERK}`;
}
