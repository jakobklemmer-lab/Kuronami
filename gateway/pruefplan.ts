import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { type Strategie, pruefeStrategie } from "./backtest.js";
import type { Konfidenz } from "./konfidenz.js";
import { type MarktKerzen, ueberMaerkte } from "./universum.js";
import { strengeHuerde, zAusIntervall } from "./versuche.js";

/**
 * Der Prüfplan (29.09.2026): Regeln aus fremden Quellen **vor** dem Rechnen festschreiben, dann
 * jede genau einmal rechnen.
 *
 * Anlass: Jakob wollte nach den TradingLab-Videos und John Murphys Buch „alle Rechnungen, alle
 * Regeln löschen und alles nochmal anschauen". Löschen hätte die Hürde des Versuchsbuchs gesenkt,
 * ohne dass weniger probiert worden wäre — die rund 1.200 Versuche bis zum 28.09. stammen aber zum
 * großen Teil aus dem Herumprobieren des Handelstischs, und neue Regeln aus Büchern sollen nicht
 * dafür bestraft werden. Ein Prüfplan trennt beides sauber:
 *
 *  1. Die boerse schreibt alle rechenbaren Regeln aus den Quellen in eine Liste — mit Quelle,
 *     Märkten, Zeitrahmen und Beginn —, **bevor** eine davon gerechnet ist (`entwurf`).
 *  2. Jakob stimmt zu, die Liste wird **festgeschrieben**: Prüfsumme, Zeitpunkt, Git-Commit. Ab
 *     da ändert sich an ihr nichts mehr.
 *  3. Jede Regel wird genau einmal gerechnet, unverändert, bis zur Sperrgrenze (`sperre.ts`) —
 *     die gesperrten Jahre bleiben der Schlussprobe.
 *  4. Die Hürde ist Bonferroni **über diese Liste** (`strengeHuerde(regeln.length)`), nicht über
 *     das ganze Versuchsbuch. Gezählt wird trotzdem jede Regel dort; das Buch bleibt vollständig.
 *
 * Eine Familie mit eigener Fehlerkontrolle ist nur ehrlich, wenn sie vorher feststeht und nicht
 * nach unseren Ergebnissen ausgewählt wurde. Dafür stehen Prüfsumme und Commit.
 */

export const PLAN_INTERVALLE = ["1d", "1h", "30m", "15m", "5m", "1m"] as const;
export const MAX_REGELN = 400;
const TAG = /^\d{4}-\d{2}-\d{2}$/;

export interface PlanRegel {
  /** Laufende Nummer, vergibt der Plan selbst. */
  nr: number;
  /** Woher die Regel stammt, mit Stelle: „TradingLab g-PLctW8aU0 [2:24–3:21]", „Murphy, Kap. 9, S. 203". */
  quelle: string;
  strategie: Strategie;
  /** Die Märkte, vorher festgelegt. Der erste ist der Heimatmarkt der Ablage. */
  maerkte: string[];
  intervall: string;
  /** Beginn der Rechnung, YYYY-MM-DD. Das Ende ist die Sperrgrenze des Zeitrahmens. */
  von: string;
}

export interface PlanErgebnis {
  nr: number;
  name: string;
  anzahl: number;
  erwartungswertR: number;
  /** Dieselbe Regel ohne Gebühr und Schlupf — ob überhaupt eine Kante da ist. */
  ohneKostenR: number;
  trefferquote: number;
  konfidenz?: Konfidenz;
  z: number;
  /** z über der Hürde des Plans und Ø R über null. */
  haelt: boolean;
  einstufung?: string;
  /** Märkte, zu denen es keine Kerzen gab, oder warum die Regel nicht rechnete. */
  fehler?: string;
}

export interface Pruefplan {
  id: string;
  titel: string;
  angelegt: string;
  status: "entwurf" | "festgeschrieben" | "gerechnet";
  regeln: PlanRegel[];
  /** Was die Quellen lehren, sich aber nicht rechnen lässt — je mit Grund („Baustein fehlt: …"). */
  nichtPruefbar: string[];
  festgeschrieben?: {
    am: string;
    /** SHA-256 über die Regeln. Stimmt sie beim Rechnen nicht mehr, wird nicht gerechnet. */
    hash: string;
    huerde: number;
    /** Jakobs Zustimmung im Wortlaut. */
    freigabe: string;
    commit?: string;
  };
  gerechnet?: { am: string | null; ergebnisse: PlanErgebnis[] };
}

export class PruefplanFehler extends Error {}

export function planHash(regeln: readonly PlanRegel[]): string {
  return createHash("sha256").update(JSON.stringify(regeln)).digest("hex");
}

/** Die Regeln prüfen, bevor sie in einen Plan kommen — ein Tippfehler soll beim Anlegen auffallen. */
export function pruefeRegeln(regeln: readonly Omit<PlanRegel, "nr">[]): void {
  if (regeln.length > MAX_REGELN) {
    throw new PruefplanFehler(`Höchstens ${MAX_REGELN} Regeln je Plan.`);
  }
  regeln.forEach((r, i) => {
    const wo = `Regel ${i + 1} („${r.strategie?.name ?? "ohne Namen"}")`;
    if (!r.quelle?.trim()) throw new PruefplanFehler(`${wo}: ohne Quelle.`);
    if (!PLAN_INTERVALLE.includes(r.intervall as (typeof PLAN_INTERVALLE)[number])) {
      throw new PruefplanFehler(`${wo}: Zeitrahmen ${r.intervall} gibt es hier nicht.`);
    }
    if (!TAG.test(r.von)) throw new PruefplanFehler(`${wo}: Beginn „${r.von}" ist kein Datum.`);
    if (r.maerkte.length === 0 || r.maerkte.length > 12) {
      throw new PruefplanFehler(`${wo}: ein bis zwölf Märkte.`);
    }
    try {
      pruefeStrategie(r.strategie);
    } catch (error) {
      throw new PruefplanFehler(`${wo}: ${error instanceof Error ? error.message : error}`);
    }
  });
}

/** Eine Regel rechnen: über ihre Märkte, mit und ohne Kosten, gegen die Hürde des Plans. */
export function rechneRegel(
  regel: PlanRegel,
  maerkte: readonly MarktKerzen[],
  huerde: number,
): PlanErgebnis {
  const leer = {
    nr: regel.nr,
    name: regel.strategie.name,
    anzahl: 0,
    erwartungswertR: 0,
    ohneKostenR: 0,
    trefferquote: 0,
    z: 0,
    haelt: false,
  };
  if (maerkte.length === 0) return { ...leer, fehler: "zu keinem Markt Kerzen" };
  try {
    const mit = ueberMaerkte(regel.strategie, maerkte, { intervall: regel.intervall });
    const ohne = ueberMaerkte(
      { ...regel.strategie, gebuehrProzent: 0, schlupfProzent: 0 },
      maerkte,
      { intervall: regel.intervall },
    );
    const z = mit.gemeinsam ? zAusIntervall(mit.gemeinsamErwartungswertR, mit.gemeinsam) : 0;
    const treffer = mit.maerkte.reduce((s, e) => s + e.trefferquote * e.anzahl, 0);
    return {
      ...leer,
      anzahl: mit.gesamtHandel,
      erwartungswertR: mit.gemeinsamErwartungswertR,
      ohneKostenR: ohne.gemeinsamErwartungswertR,
      trefferquote: mit.gesamtHandel > 0 ? treffer / mit.gesamtHandel : 0,
      ...(mit.gemeinsam ? { konfidenz: mit.gemeinsam } : {}),
      z,
      haelt: z > huerde && mit.gemeinsamErwartungswertR > 0,
      einstufung: mit.einstufung,
    };
  } catch (error) {
    return { ...leer, fehler: error instanceof Error ? error.message : String(error) };
  }
}

const vorz = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(2).replace(".", ",")}`;

export function formatierePlan(plan: Pruefplan, mitRegeln = true): string {
  const f = plan.festgeschrieben;
  const zeilen = [
    `## Prüfplan ${plan.id}: ${plan.titel}`,
    "",
    `Status **${plan.status}** · ${plan.regeln.length} Regeln · ${plan.nichtPruefbar.length} nicht prüfbar`,
    f
      ? `Festgeschrieben am ${f.am.slice(0, 16).replace("T", " ")} UTC, Hürde z > ${f.huerde.toFixed(2)} (Bonferroni über ${plan.regeln.length} Regeln), Prüfsumme ${f.hash.slice(0, 12)}${f.commit ? `, Commit ${f.commit}` : ""}. Freigabe: „${f.freigabe}"`
      : "Noch ein Entwurf — änderbar, bis Jakob zustimmt.",
  ];
  const ergebnisse = plan.gerechnet?.ergebnisse ?? [];
  if (ergebnisse.length > 0) {
    const sortiert = [...ergebnisse].sort((a, b) => b.z - a.z);
    zeilen.push(
      "",
      `### Ergebnisse (${ergebnisse.length} von ${plan.regeln.length} gerechnet${plan.status === "gerechnet" ? "" : " — `pruefplan_rechnen` macht weiter"})`,
      "",
      "| Nr | Regel | Handel | Ø R | ohne Kosten | 95 % (Blöcke) | z | hält |",
      "|---|---|---|---|---|---|---|---|",
      ...sortiert.map((e) =>
        e.fehler && e.anzahl === 0
          ? `| ${e.nr} | ${e.name} | — | — | — | — | — | ${e.fehler} |`
          : `| ${e.nr} | ${e.name} | ${e.anzahl} | ${vorz(e.erwartungswertR)} | ${vorz(e.ohneKostenR)} | ${e.konfidenz ? `${vorz(e.konfidenz.unten)} … ${vorz(e.konfidenz.oben)}` : "—"} | ${e.z.toFixed(2)} | ${e.haelt ? "**ja**" : "nein"} |`,
      ),
    );
    const haelt = sortiert.filter((e) => e.haelt);
    zeilen.push(
      "",
      haelt.length === 0
        ? "Keine Regel nimmt die Hürde des Plans."
        : `${haelt.length} Regel(n) nehmen die Hürde. Leg sie mit \`strategie_ablegen\` und \`pruefplan: { id: "${plan.id}", nr }\` ab — genau mit Märkten, Zeitrahmen und Beginn aus dem Plan —, dann Gegenprobe und Schlussprobe durch den Prüfer.`,
    );
  }
  if (mitRegeln) {
    zeilen.push(
      "",
      "### Regeln",
      "",
      ...plan.regeln.map(
        (r) =>
          `${r.nr}. **${r.strategie.name}** — ${r.quelle} · ${r.intervall} ab ${r.von} · ${r.maerkte.join(", ")}`,
      ),
    );
    if (plan.nichtPruefbar.length > 0) {
      zeilen.push("", "### Nicht prüfbar", "", ...plan.nichtPruefbar.map((n) => `- ${n}`));
    }
  }
  return zeilen.join("\n");
}

export interface Pruefplaene {
  entwurf(eingabe: {
    id?: string;
    titel: string;
    regeln: Omit<PlanRegel, "nr">[];
    nichtPruefbar?: string[];
    anhaengen?: boolean;
  }): Promise<Pruefplan>;
  festschreibe(id: string, freigabe: string): Promise<Pruefplan>;
  legeErgebnisse(id: string, ergebnisse: PlanErgebnis[]): Promise<Pruefplan>;
  lies(id: string): Promise<Pruefplan | null>;
  liste(): Promise<Pruefplan[]>;
}

const execFileAsync = promisify(execFile);

/** Die Datei committen — nur sie, egal was sonst im Index liegt. Scheitert Git, bleibt die Prüfsumme. */
async function gitCommit(datei: string, nachricht: string): Promise<string | undefined> {
  try {
    const ordner = path.dirname(datei);
    await execFileAsync("git", ["-C", ordner, "add", "--", datei]);
    await execFileAsync("git", ["-C", ordner, "commit", "-q", "-m", nachricht, "--", datei]);
    const { stdout } = await execFileAsync("git", ["-C", ordner, "rev-parse", "--short", "HEAD"]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function createPruefplaene(deps: {
  workdir: string;
  jetzt?: () => Date;
  commit?: (datei: string, nachricht: string) => Promise<string | undefined>;
}): Pruefplaene {
  const ordner = path.join(deps.workdir, "pruefplaene");
  const jetzt = deps.jetzt ?? (() => new Date());
  const commit = deps.commit ?? gitCommit;
  const datei = (id: string) => path.join(ordner, `${id}.json`);

  async function lies(id: string): Promise<Pruefplan | null> {
    if (!/^[0-9]{8}-[0-9a-f]{6}$/.test(id)) return null;
    try {
      return JSON.parse(await readFile(datei(id), "utf8")) as Pruefplan;
    } catch {
      return null;
    }
  }

  async function schreibe(plan: Pruefplan): Promise<void> {
    await mkdir(ordner, { recursive: true });
    await writeFile(`${datei(plan.id)}.neu`, `${JSON.stringify(plan, null, 1)}\n`);
    await rename(`${datei(plan.id)}.neu`, datei(plan.id));
  }

  async function mussSein(id: string): Promise<Pruefplan> {
    const plan = await lies(id);
    if (!plan) throw new PruefplanFehler(`Keinen Prüfplan ${id}.`);
    return plan;
  }

  return {
    lies,

    async liste() {
      try {
        const dateien = (await readdir(ordner)).filter((d) => d.endsWith(".json")).sort();
        const plaene = await Promise.all(dateien.map((d) => lies(d.slice(0, -5))));
        return plaene.filter((p): p is Pruefplan => p !== null);
      } catch {
        return [];
      }
    },

    async entwurf({ id, titel, regeln, nichtPruefbar = [], anhaengen = false }) {
      pruefeRegeln(regeln);
      let plan: Pruefplan;
      if (id) {
        plan = await mussSein(id);
        if (plan.status !== "entwurf") {
          throw new PruefplanFehler(
            `Plan ${id} ist ${plan.status} — daran ändert sich nichts mehr. Neue Regeln gehören in einen neuen Plan.`,
          );
        }
      } else {
        const tag = jetzt().toISOString().slice(0, 10).replaceAll("-", "");
        plan = {
          id: `${tag}-${randomBytes(3).toString("hex")}`,
          titel,
          angelegt: jetzt().toISOString(),
          status: "entwurf",
          regeln: [],
          nichtPruefbar: [],
        };
      }
      const bisher = anhaengen ? plan.regeln : [];
      const neu = regeln.map((r, i) => ({ ...r, nr: bisher.length + i + 1 }));
      plan = {
        ...plan,
        titel,
        regeln: [...bisher, ...neu],
        nichtPruefbar: anhaengen ? [...plan.nichtPruefbar, ...nichtPruefbar] : nichtPruefbar,
      };
      if (plan.regeln.length > MAX_REGELN) {
        throw new PruefplanFehler(`Höchstens ${MAX_REGELN} Regeln je Plan.`);
      }
      await schreibe(plan);
      return plan;
    },

    async festschreibe(id, freigabe) {
      const plan = await mussSein(id);
      if (plan.status !== "entwurf")
        throw new PruefplanFehler(`Plan ${id} ist schon ${plan.status}.`);
      if (plan.regeln.length === 0) throw new PruefplanFehler("Ein leerer Plan prüft nichts.");
      if (!freigabe.trim())
        throw new PruefplanFehler("Ohne Jakobs Zustimmung wird nicht festgeschrieben.");
      const fest: Pruefplan = {
        ...plan,
        status: "festgeschrieben",
        festgeschrieben: {
          am: jetzt().toISOString(),
          hash: planHash(plan.regeln),
          huerde: strengeHuerde(plan.regeln.length),
          freigabe: freigabe.trim(),
        },
      };
      await schreibe(fest);
      const hash = await commit(
        datei(id),
        `Prüfplan ${id} festgeschrieben: ${plan.titel} (${plan.regeln.length} Regeln)`,
      );
      if (hash && fest.festgeschrieben) {
        fest.festgeschrieben.commit = hash;
        await schreibe(fest);
      }
      return fest;
    },

    async legeErgebnisse(id, ergebnisse) {
      const plan = await mussSein(id);
      if (plan.status === "entwurf" || !plan.festgeschrieben) {
        throw new PruefplanFehler(
          `Plan ${id} ist nicht festgeschrieben — gerechnet wird erst danach.`,
        );
      }
      if (planHash(plan.regeln) !== plan.festgeschrieben.hash) {
        throw new PruefplanFehler(
          `Die Regeln von Plan ${id} stimmen nicht mehr mit der Prüfsumme überein — jemand hat sie nach dem Festschreiben geändert. Es wird nicht gerechnet.`,
        );
      }
      const bisher = plan.gerechnet?.ergebnisse ?? [];
      const schon = new Set(bisher.map((e) => e.nr));
      const alle = [...bisher, ...ergebnisse.filter((e) => !schon.has(e.nr))].sort(
        (a, b) => a.nr - b.nr,
      );
      const fertig = alle.length >= plan.regeln.length;
      const neu: Pruefplan = {
        ...plan,
        status: fertig ? "gerechnet" : "festgeschrieben",
        gerechnet: { am: fertig ? jetzt().toISOString() : null, ergebnisse: alle },
      };
      await schreibe(neu);
      return neu;
    },
  };
}
