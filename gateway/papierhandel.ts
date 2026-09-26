import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Kennzahlen, type Strategie, atrAm, pruefeStrategie, signalAm } from "./backtest.js";
import { imFenster, minuteAus } from "./indikatoren.js";
import type { MarketCandle, MarketsClient } from "./integrations/markets.js";
import type { StrategienArchiv } from "./strategien.js";

/**
 * Der Papierhandel: eine geprüfte Strategie läuft gegen den **laufenden** Markt, mit
 * Buchgeld.
 *
 * **Warum das kein Agent ist.** Jakobs Ablauf sah eine dritte Partei vor, die geprüfte
 * Strategien ausführt. Ausführung gehört aber nicht in ein Sprachmodell: ein Modell entscheidet
 * nicht zweimal gleich, es liest Nachrichten (und damit auch untergeschobenen Text) und es kann
 * eine Ausführung erfinden, die es nicht gab. Was hier läuft, ist deshalb **Code, der die
 * gespeicherte Regel ausführt** — dieselbe Auswertung wie im Backtest (`signalAm`), Zeichen für
 * Zeichen. Der Handelstisch darf zusehen und berichten; entscheiden darf er nichts.
 *
 * **Warum es trotzdem gebraucht wird.** Ein Backtest ist ein Ausschlussverfahren, kein Beweis:
 * er sagt, was *nicht* funktioniert hätte. Erst der Lauf gegen einen Markt, den beim Bauen der
 * Regel niemand gesehen hat, liefert Zahlen, die niemand nachträglich beeinflussen konnte.
 *
 * **Die Bremse ist Teil des Motors.** Jedes Konto hat Grenzen — Rückschlag, Verlustserie,
 * Abweichung vom Erwartungswert des Backtests. Reißt eine, wird das Konto **gesperrt** und
 * handelt nicht weiter. Das ist kein Vorschlag an einen Aufseher, sondern ein Schalter: wer
 * eine Strategie abschalten will, während er über sie diskutiert, hat sie nicht abgeschaltet.
 */

export interface PapierPosition {
  richtung: "long" | "short";
  einstiegZeit: number;
  einstieg: number;
  stop: number;
  ziel: number | null;
  /** Kerzen seit dem Einstieg — für die Zeitgrenze der Strategie. */
  kerzen: number;
}

export interface PapierHandel {
  einstiegZeit: number;
  ausstiegZeit: number;
  einstieg: number;
  ausstieg: number;
  grund: "stop" | "ziel" | "regel" | "zeit" | "fenster";
  r: number;
  renditeProzent: number;
}

export interface PapierKonto {
  strategieId: string;
  name: string;
  symbol: string;
  intervall: string;
  /** Wann der Papierhandel begonnen hat. Alles davor ist Backtest, nicht Betrieb. */
  seit: string;
  /** Der Erwartungswert in R, den der Backtest versprochen hat — die Messlatte im Betrieb. */
  erwartetR: number;
  gebuehrProzent: number;
  schlupfProzent: number;
  offen: PapierPosition | null;
  /** Ein erkanntes Signal wartet auf die nächste Eröffnung — wie im Backtest. */
  wartetAufEinstieg: boolean;
  handel: PapierHandel[];
  /** Zeitstempel der letzten Kerze, die verarbeitet wurde. */
  standKerze: number | null;
  kapitalkurve: number[];
  gesperrt: boolean;
  sperrgrund?: string;
  zuletztGeprueft: string;
}

export interface PapierGrenzen {
  /** Rückschlag von der Spitze, in Prozent der Kapitalkurve. */
  maxRueckschlagProzent: number;
  maxVerlustserie: number;
  /** Ab so vielen Handeln wird der Erwartungswert mit dem des Backtests verglichen. */
  vergleichAb: number;
  /** Wie weit er darunter liegen darf, bevor gesperrt wird (Anteil, 0,5 = die Hälfte). */
  mindestAnteilErwartung: number;
}

export const VORGABE_GRENZEN: PapierGrenzen = {
  maxRueckschlagProzent: 20,
  maxVerlustserie: 6,
  vergleichAb: 15,
  mindestAnteilErwartung: 0.3,
};

export class PapierFehler extends Error {}

function iso(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

/**
 * Die Grenzen prüfen. Gibt den Grund zurück, wenn eine gerissen ist — sonst `null`.
 *
 * Geprüft wird nach jedem abgeschlossenen Handel, nicht nach jeder Kerze: eine offene Position
 * schwankt, und eine Sperre mitten in einer laufenden Position würde sie ungedeckt stehen
 * lassen.
 */
export function grenzeGerissen(
  konto: PapierKonto,
  grenzen: PapierGrenzen = VORGABE_GRENZEN,
): string | null {
  const kurve = konto.kapitalkurve;
  if (kurve.length > 1) {
    let spitze = kurve[0];
    let rueckschlag = 0;
    for (const stand of kurve) {
      spitze = Math.max(spitze, stand);
      rueckschlag = Math.max(rueckschlag, (spitze - stand) / spitze);
    }
    if (rueckschlag * 100 > grenzen.maxRueckschlagProzent) {
      return `Rückschlag ${(rueckschlag * 100).toFixed(1)} % über der Grenze von ${grenzen.maxRueckschlagProzent} %.`;
    }
  }

  let serie = 0;
  for (const h of konto.handel) serie = h.r <= 0 ? serie + 1 : 0;
  if (serie >= grenzen.maxVerlustserie) {
    return `${serie} Verluste in Folge — die Grenze liegt bei ${grenzen.maxVerlustserie}.`;
  }

  if (konto.handel.length >= grenzen.vergleichAb && konto.erwartetR > 0) {
    const gelaufen = konto.handel.reduce((a, h) => a + h.r, 0) / Math.max(1, konto.handel.length);
    if (gelaufen < konto.erwartetR * grenzen.mindestAnteilErwartung) {
      return (
        `Im Betrieb ${gelaufen.toFixed(2)} R je Handel statt der ${konto.erwartetR.toFixed(2)} R aus dem Backtest ` +
        `(${konto.handel.length} Handel). Die Strategie hält im laufenden Markt nicht, was sie in der Vergangenheit versprach.`
      );
    }
  }
  return null;
}

/** Die Kennzahlen des Papierhandels — dieselben Namen wie im Backtest, damit man sie nebeneinanderlegen kann. */
export function papierKennzahlen(
  konto: PapierKonto,
): Pick<
  Kennzahlen,
  "anzahl" | "trefferquote" | "erwartungswertR" | "profitFaktor" | "maxDrawdownProzent"
> & { summeR: number } {
  const rs = konto.handel.map((h) => h.r);
  const gewinne = rs.filter((r) => r > 0);
  const verluste = rs.filter((r) => r <= 0);
  const summe = rs.reduce((a, b) => a + b, 0);
  let spitze = konto.kapitalkurve[0] ?? 1;
  let rueckschlag = 0;
  for (const stand of konto.kapitalkurve) {
    spitze = Math.max(spitze, stand);
    rueckschlag = Math.max(rueckschlag, (spitze - stand) / spitze);
  }
  return {
    anzahl: rs.length,
    trefferquote: rs.length > 0 ? gewinne.length / rs.length : 0,
    erwartungswertR: rs.length > 0 ? summe / rs.length : 0,
    profitFaktor:
      verluste.length > 0
        ? gewinne.reduce((a, b) => a + b, 0) / Math.abs(verluste.reduce((a, b) => a + b, 0))
        : gewinne.length > 0
          ? Number.POSITIVE_INFINITY
          : 0,
    maxDrawdownProzent: rueckschlag * 100,
    summeR: summe,
  };
}

/**
 * Ein Tick: neue Kerzen verarbeiten.
 *
 * Reine Funktion über Konto, Strategie und Kerzen — deshalb ohne Netz und ohne Platte prüfbar.
 * Sie verarbeitet **nur abgeschlossene** Kerzen: die letzte gelieferte Kerze ist bei laufendem
 * Handel noch in Bewegung und wird weggelassen. Ein Signal auf einer halben Kerze wäre ein
 * Signal, das es am Abend vielleicht nicht mehr gibt.
 */
export function verarbeite(
  konto: PapierKonto,
  strategie: Strategie,
  kerzen: readonly MarketCandle[],
  grenzen: PapierGrenzen = VORGABE_GRENZEN,
): { konto: PapierKonto; ereignisse: string[] } {
  const ereignisse: string[] = [];
  if (konto.gesperrt || kerzen.length < 30) return { konto, ereignisse };

  // Die letzte Kerze ist die laufende — sie zählt erst, wenn sie fertig ist.
  const abgeschlossen = kerzen.slice(0, -1);
  const long = strategie.richtung === "long";
  const gebuehr = (konto.gebuehrProzent ?? 0) / 100;
  const schlupf = (konto.schlupfProzent ?? 0) / 100;
  const start = konto.standKerze === null ? abgeschlossen.length - 1 : -1;

  const ersterNeuer =
    konto.standKerze === null
      ? Math.max(0, start)
      : abgeschlossen.findIndex((k) => k.time > (konto.standKerze as number));
  if (ersterNeuer === -1) return { konto, ereignisse };

  for (let i = ersterNeuer; i < abgeschlossen.length; i += 1) {
    const kerze = abgeschlossen[i];

    // 1. Ein wartendes Signal wird zur Eröffnung dieser Kerze zum Handel — genau wie im Backtest.
    if (konto.wartetAufEinstieg && konto.offen === null) {
      const roh = kerze.open;
      const kurs = long ? roh * (1 + schlupf) : roh * (1 - schlupf);
      let stop: number | null = null;
      if (strategie.stopAtr !== undefined) {
        const spanne = atrAm(abgeschlossen, i - 1);
        if (spanne !== undefined) {
          stop = long ? kurs - spanne * strategie.stopAtr : kurs + spanne * strategie.stopAtr;
        }
      } else if (strategie.stopProzent !== undefined) {
        const anteil = strategie.stopProzent / 100;
        stop = long ? kurs * (1 - anteil) : kurs * (1 + anteil);
      }
      konto.wartetAufEinstieg = false;
      if (stop === null) {
        ereignisse.push(
          `${konto.name}: Signal verfallen — der Stop ließ sich nicht bestimmen (zu wenige Kerzen für den ATR).`,
        );
      } else {
        const risiko = Math.abs(kurs - stop);
        let ziel: number | null = null;
        if (strategie.zielR !== undefined) {
          ziel = long ? kurs + risiko * strategie.zielR : kurs - risiko * strategie.zielR;
        } else if (strategie.zielProzent !== undefined) {
          const anteil = strategie.zielProzent / 100;
          ziel = long ? kurs * (1 + anteil) : kurs * (1 - anteil);
        }
        konto.offen = {
          richtung: strategie.richtung,
          einstiegZeit: kerze.time,
          einstieg: kurs,
          stop,
          ziel,
          kerzen: 0,
        };
        ereignisse.push(
          `${konto.name}: eingestiegen ${strategie.richtung} zu ${kurs.toFixed(4)} am ${iso(kerze.time)}, Stop ${stop.toFixed(4)}.`,
        );
      }
    }

    // 2. Eine offene Position gegen diese Kerze prüfen. Stop vor Ziel.
    if (konto.offen !== null && kerze.time > konto.offen.einstiegZeit) {
      const offen = konto.offen;
      offen.kerzen += 1;
      const stopTrifft = long ? kerze.low <= offen.stop : kerze.high >= offen.stop;
      const zielTrifft =
        offen.ziel !== null && (long ? kerze.high >= offen.ziel : kerze.low <= offen.ziel);
      let ausstieg: number | null = null;
      let grund: PapierHandel["grund"] | null = null;
      // Das Fenster zuerst — dieselbe Reihenfolge wie im Backtest (`backtest.ts`). Eine
      // Sitzungsstrategie, die im Betrieb über das Fensterende hinaus hält, handelt etwas
      // anderes als das, was geprüft wurde, und ihre Kennzahlen gelten dann nicht mehr.
      if (
        strategie.fenster !== undefined &&
        strategie.fenster.ausstiegAmEnde !== false &&
        !imFenster(
          kerze.time,
          strategie.zone ?? "UTC",
          minuteAus(strategie.fenster.von),
          minuteAus(strategie.fenster.bis),
        )
      ) {
        ausstieg = kerze.open;
        grund = "fenster";
      } else if (stopTrifft) {
        // Dieselbe Annahme wie im Backtest (dort steht die Begründung): eine Lücke über den
        // Stop hinweg wird zur Eröffnung bedient, nicht zum Wunschkurs.
        ausstieg = long ? Math.min(offen.stop, kerze.open) : Math.max(offen.stop, kerze.open);
        grund = "stop";
      } else if (zielTrifft && offen.ziel !== null) {
        ausstieg = offen.ziel;
        grund = "ziel";
      } else if (signalAm(strategie, abgeschlossen, i).ausstieg) {
        ausstieg = kerze.close;
        grund = "regel";
      } else if (strategie.maxKerzen !== undefined && offen.kerzen >= strategie.maxKerzen) {
        ausstieg = kerze.close;
        grund = "zeit";
      }

      if (ausstieg !== null && grund !== null) {
        const risiko = Math.abs(offen.einstieg - offen.stop);
        const brutto = long ? ausstieg - offen.einstieg : offen.einstieg - ausstieg;
        // **Der Schlupf zählt einmal je Seite, nicht anderthalbmal.** Der Einstiegskurs oben
        // ist bereits der verschlechterte (`roh * (1 + schlupf)`) — dort steckt der Schlupf der
        // Einstiegsseite schon drin. Ihn hier noch einmal auf den Einstieg zu rechnen hieß, ihn
        // doppelt zu bezahlen; bei einem Scalp, dessen Risiko nur ein Zehntelprozent des Kurses
        // beträgt, war das kein Rundungsfehler, sondern in einem gemessenen Fall 0,21 R je
        // Handel. Gefunden am 2026-09-21 beim Nachrechnen eines echten Laufs von Hand: Risiko
        // 77,55, ausgewiesene Kosten 97,53 — davon 16,26 Schlupf, die schon im Einstieg saßen.
        // Der Ausstiegskurs ist **nicht** verschlechtert, also trägt er beides.
        const kosten = offen.einstieg * gebuehr + ausstieg * (gebuehr + schlupf);
        const netto = brutto - kosten;
        const r = risiko > 0 ? netto / risiko : 0;
        konto.handel.push({
          einstiegZeit: offen.einstiegZeit,
          ausstiegZeit: kerze.time,
          einstieg: offen.einstieg,
          ausstieg,
          grund,
          r,
          renditeProzent: (netto / offen.einstieg) * 100,
        });
        const letzter = konto.kapitalkurve[konto.kapitalkurve.length - 1] ?? 1;
        konto.kapitalkurve.push(letzter * (1 + netto / offen.einstieg));
        konto.offen = null;
        ereignisse.push(
          `${konto.name}: ${grund} bei ${ausstieg.toFixed(4)} am ${iso(kerze.time)} — ${r >= 0 ? "+" : ""}${r.toFixed(2)} R.`,
        );

        const riss = grenzeGerissen(konto, grenzen);
        if (riss !== null) {
          konto.gesperrt = true;
          konto.sperrgrund = riss;
          ereignisse.push(`${konto.name}: **gesperrt** — ${riss}`);
          konto.standKerze = kerze.time;
          return { konto, ereignisse };
        }
      }
    }

    // 3. Ein neues Einstiegssignal auf dieser abgeschlossenen Kerze.
    if (konto.offen === null && !konto.wartetAufEinstieg) {
      if (signalAm(strategie, abgeschlossen, i).einstieg) {
        konto.wartetAufEinstieg = true;
        ereignisse.push(
          `${konto.name}: Signal am ${iso(kerze.time)} — Einstieg zur nächsten Eröffnung.`,
        );
      }
    }

    konto.standKerze = kerze.time;
  }

  konto.zuletztGeprueft = new Date().toISOString();
  return { konto, ereignisse };
}

export interface PapierhandelDeps {
  workdir: string;
  markets: MarketsClient;
  strategien: StrategienArchiv;
  grenzen?: PapierGrenzen;
  /** Wie viele Tage Kursgeschichte je Tick geladen werden — genug für lange Durchschnitte. */
  historieTage?: number;
  onEreignis?(text: string): void;
}

export interface Papierhandel {
  /** Ein Konto für eine abgelegte Strategie eröffnen. Nur für geprüfte Kandidaten. */
  starte(strategieId: string): Promise<PapierKonto>;
  /** Alle Konten. */
  liste(): Promise<PapierKonto[]>;
  lies(strategieId: string): Promise<PapierKonto | null>;
  /** Alle Konten auf den neuesten Stand bringen. Gibt zurück, was dabei passiert ist. */
  tick(): Promise<string[]>;
  /** Von Hand sperren oder wieder freigeben — Jakobs Schalter. */
  setzeSperre(strategieId: string, gesperrt: boolean, grund?: string): Promise<PapierKonto | null>;
  /**
   * Den Papierhandel beenden und das Konto ins Archiv legen.
   *
   * Nicht löschen: die Zahlen eines Laufs sind das Einzige, was über eine Strategie im echten
   * Markt je bekannt war. Sie verschwinden zu lassen, weil der Lauf vorbei ist, hieße, beim
   * nächsten Mal wieder bei null anzufangen.
   */
  beende(strategieId: string): Promise<PapierKonto | null>;
}

export function createPapierhandel(deps: PapierhandelDeps): Papierhandel {
  const ordner = path.join(deps.workdir, "papierhandel");
  const grenzen = deps.grenzen ?? VORGABE_GRENZEN;
  const historieTage = deps.historieTage ?? 500;

  async function schreibe(konto: PapierKonto): Promise<void> {
    await mkdir(ordner, { recursive: true });
    await writeFile(
      path.join(ordner, `${konto.strategieId}.json`),
      `${JSON.stringify(konto, null, 2)}\n`,
      "utf8",
    );
  }

  async function lies(strategieId: string): Promise<PapierKonto | null> {
    if (!/^[0-9a-f]{12}$/.test(strategieId)) return null;
    try {
      return JSON.parse(
        await readFile(path.join(ordner, `${strategieId}.json`), "utf8"),
      ) as PapierKonto;
    } catch {
      return null;
    }
  }

  async function alle(): Promise<PapierKonto[]> {
    try {
      // `beendet/` ist ein Unterordner, keine Datei — `withFileTypes` wäre hier dasselbe in
      // teuer; die Endung genügt.
      const dateien = (await readdir(ordner)).filter((d) => d.endsWith(".json"));
      const konten = await Promise.all(
        dateien.map(async (d) => {
          try {
            return JSON.parse(await readFile(path.join(ordner, d), "utf8")) as PapierKonto;
          } catch {
            return null;
          }
        }),
      );
      return konten.filter((k): k is PapierKonto => k !== null);
    } catch {
      return [];
    }
  }

  return {
    async starte(strategieId) {
      const eintrag = await deps.strategien.lies(strategieId);
      if (!eintrag) throw new PapierFehler(`Keine Strategie mit der Kennung ${strategieId}.`);
      if (eintrag.status !== "kandidat") {
        throw new PapierFehler(
          `Status "${eintrag.status}": in den Papierhandel geht nur, was die Prüfung als Kandidat ausgewiesen hat. Das ist der Sinn der Stufe — sonst läuft hier ein Entwurf.`,
        );
      }
      pruefeStrategie(eintrag.strategie);
      const vorhanden = await lies(strategieId);
      if (vorhanden) return vorhanden;

      const konto: PapierKonto = {
        strategieId,
        name: eintrag.name,
        symbol: eintrag.symbol,
        intervall: eintrag.intervall,
        seit: new Date().toISOString(),
        erwartetR: eintrag.kennzahlen?.erwartungswertR ?? 0,
        gebuehrProzent: eintrag.strategie.gebuehrProzent ?? 0.1,
        schlupfProzent: eintrag.strategie.schlupfProzent ?? 0.05,
        offen: null,
        wartetAufEinstieg: false,
        handel: [],
        standKerze: null,
        kapitalkurve: [1],
        gesperrt: false,
        zuletztGeprueft: new Date().toISOString(),
      };
      await schreibe(konto);
      return konto;
    },

    liste: alle,
    lies,

    async tick() {
      const ereignisse: string[] = [];
      for (const konto of await alle()) {
        if (konto.gesperrt) continue;
        const eintrag = await deps.strategien.lies(konto.strategieId);
        if (!eintrag) {
          ereignisse.push(`${konto.name}: Strategie nicht mehr im Archiv — übersprungen.`);
          continue;
        }
        try {
          const bis = Math.floor(Date.now() / 1000);
          const chart = await deps.markets.zeitraum(
            konto.symbol,
            bis - historieTage * 86_400,
            bis,
            "1d",
          );
          const { ereignisse: neue } = verarbeite(konto, eintrag.strategie, chart.candles, grenzen);
          if (neue.length > 0) {
            ereignisse.push(...neue);
            for (const zeile of neue) deps.onEreignis?.(zeile);
          }
          await schreibe(konto);
        } catch (error) {
          ereignisse.push(
            `${konto.name}: Kursabruf fehlgeschlagen — ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return ereignisse;
    },

    async beende(strategieId) {
      const konto = await lies(strategieId);
      if (!konto) return null;
      const archiv = path.join(ordner, "beendet");
      await mkdir(archiv, { recursive: true });
      await writeFile(
        path.join(archiv, `${new Date().toISOString().replace(/[:.]/g, "-")}-${strategieId}.json`),
        `${JSON.stringify({ ...konto, beendet: new Date().toISOString() }, null, 2)}\n`,
        "utf8",
      );
      await rm(path.join(ordner, `${strategieId}.json`), { force: true });
      return konto;
    },

    async setzeSperre(strategieId, gesperrt, grund) {
      const konto = await lies(strategieId);
      if (!konto) return null;
      konto.gesperrt = gesperrt;
      if (gesperrt) konto.sperrgrund = grund ?? "Von Hand gesperrt.";
      else konto.sperrgrund = undefined;
      await schreibe(konto);
      return konto;
    },
  };
}
