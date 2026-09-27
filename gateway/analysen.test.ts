import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { type AnalysenArchiv, createAnalysen } from "./analysen.js";

/**
 * Das Archiv ist die Grundlage einer Geldentscheidung: Jakob liest hier nach, bevor er einen
 * Trade startet. Zwei Dinge müssen deshalb stimmen — dass nichts verloren geht, und dass die
 * Markierung „hat eine Idee" nicht inflationär ist. Eine Liste, in der alles markiert ist,
 * markiert nichts.
 */

let archiv: AnalysenArchiv;
let ordner: string;

const bericht = {
  wer: "boerse",
  auftrag: "Einschätzung zu SOL/USD mit Einstieg, Ziel und Verlustbegrenzung.",
  bericht:
    "## SOL-USD — Ausbruch mit Vorbehalt\n\nEinstieg 107-109 USD, Stop unter 101, Ziel 114 / 120.",
  beitraege: [
    { wer: "technik", frage: "Wie liegt SOL?", antwort: "Ausbruch aus der Range 98-107." },
    { wer: "risiko", frage: "Trägt die Idee?", antwort: "CRV 0,86:1 auf Ziel 1 — zu dünn." },
  ],
  kostenUsd: 0.39,
  dauerMs: 594_200,
};

beforeEach(async () => {
  ordner = await mkdtemp(path.join(tmpdir(), "kuro-analysen-"));
  archiv = createAnalysen({ workdir: ordner });
});

describe("ablegen", () => {
  it("legt den Bericht samt Zuarbeit ab und findet ihn wieder", async () => {
    const kopf = await archiv.lege(bericht);
    expect(kopf).not.toBeNull();
    const gelesen = await archiv.lies(kopf?.id ?? "");
    expect(gelesen?.bericht).toContain("Einstieg 107-109 USD");
    expect(gelesen?.beitraege).toHaveLength(2);
    expect(gelesen?.beitraege[1].antwort).toContain("CRV 0,86:1");
    expect(gelesen?.zuarbeit).toEqual(["technik", "risiko"]);
    expect(gelesen?.status).toBe("offen");
  });

  it("legt Postfach-Sichtungen NICHT ab — das sind fremde Nachrichten, keine Analysen", async () => {
    expect(await archiv.lege({ ...bericht, wer: "korrespondenz" })).toBeNull();
    expect(await archiv.liste()).toHaveLength(0);
  });

  it("nimmt die erste taugliche Zeile als Titel, ohne Auszeichnung", async () => {
    const kopf = await archiv.lege(bericht);
    expect(kopf?.titel).toBe("SOL-USD — Ausbruch mit Vorbehalt");
  });

  it("fällt auf den Auftrag zurück, wenn der Bericht keine Überschrift hergibt", async () => {
    const kopf = await archiv.lege({ ...bericht, bericht: "nein." });
    expect(kopf?.titel).toContain("Einschätzung zu SOL/USD");
  });

  it("markiert eine Idee nur, wenn Einstieg UND Absicherung dastehen", async () => {
    expect((await archiv.lege(bericht))?.hatIdee).toBe(true);
    expect(
      (await archiv.lege({ ...bericht, bericht: "Heute keine Handelsidee, die Range hält." }))
        ?.hatIdee,
    ).toBe(false);
    expect(
      (await archiv.lege({ ...bericht, bericht: "Einstieg bei 107 sieht gut aus." }))?.hatIdee,
    ).toBe(false);
  });

  it("sortiert die Liste mit der jüngsten zuerst", async () => {
    await archiv.lege({ ...bericht, bericht: "# Erste\n\nEinstieg 1, Stop 0." });
    await new Promise((f) => setTimeout(f, 5));
    await archiv.lege({ ...bericht, bericht: "# Zweite\n\nEinstieg 2, Stop 1." });
    const liste = await archiv.liste();
    expect(liste.map((k) => k.titel)).toEqual(["Zweite", "Erste"]);
  });

  it("nimmt den Bericht selbst nicht in die Liste — die ist zum Überfliegen", async () => {
    await archiv.lege(bericht);
    const [kopf] = await archiv.liste();
    expect(kopf).not.toHaveProperty("bericht");
    expect(kopf).not.toHaveProperty("beitraege");
  });
});

describe("ändern", () => {
  it("merkt sich Status und Notiz", async () => {
    const kopf = await archiv.lege(bericht);
    const id = kopf?.id ?? "";
    await archiv.aendere(id, { status: "gehandelt" });
    const neu = await archiv.aendere(id, { notiz: "Kleine Position, halbes Risiko." });
    expect(neu?.status).toBe("gehandelt");
    expect(neu?.notiz).toBe("Kleine Position, halbes Risiko.");
    expect((await archiv.lies(id))?.bericht).toContain("Einstieg 107-109 USD");
  });

  it("gibt null zurück, wenn es die Analyse nicht gibt", async () => {
    expect(await archiv.aendere("0123456789ab", { status: "verworfen" })).toBeNull();
  });
});

describe("Kennungen", () => {
  it("nimmt nichts an, was wie ein Pfad aussieht", async () => {
    await archiv.lege(bericht);
    expect(await archiv.lies("../../etc/passwd")).toBeNull();
    expect(await archiv.lies("..")).toBeNull();
    expect(await archiv.aendere("../x", { status: "gehandelt" })).toBeNull();
  });

  it("überspringt eine kaputte Datei, statt die ganze Liste zu verlieren", async () => {
    await archiv.lege(bericht);
    const ziel = path.join(ordner, "analysen");
    await writeFile(
      path.join(ziel, "2026-01-01T00-00-00-000Z-ffffffffffff.json"),
      "{kaputt",
      "utf8",
    );
    expect(await readdir(ziel)).toHaveLength(2);
    expect(await archiv.liste()).toHaveLength(1);
  });
});

describe("leeres Archiv", () => {
  it("ist eine leere Liste und kein Fehler", async () => {
    expect(await archiv.liste()).toEqual([]);
    expect(await archiv.lies("0123456789ab")).toBeNull();
  });
});

/**
 * Das Archiv-Feld (2026-09-28, N2): Jakob wollte Analysen aus der Liste räumen können, „sonst
 * müllt mir das die Website zu" — archiviert wird nicht gelöscht, `liste()` blendet es nur
 * standardmäßig aus, und Verworfenes räumt sich nach drei Tagen von selbst weg.
 */
describe("archivieren", () => {
  it("blendet Archiviertes standardmäßig aus, zeigt es aber auf Wunsch", async () => {
    const kopf = await archiv.lege(bericht);
    const id = kopf?.id ?? "";
    const archiviert = await archiv.archiviere(id);
    expect(archiviert?.archiviert).toBeDefined();
    expect(await archiv.liste(50, false)).toHaveLength(0);
    expect(await archiv.liste(50, true)).toHaveLength(1);
    // Alte Aufrufer lassen `mitArchiv` weg und wollen die volle Geschichte — die Vorgabe darf
    // das Verhalten also nicht ändern.
    expect(await archiv.liste()).toHaveLength(1);
  });

  it("holt aus dem Archiv zurück", async () => {
    const kopf = await archiv.lege(bericht);
    const id = kopf?.id ?? "";
    await archiv.archiviere(id);
    const zurueck = await archiv.zurueckhole(id);
    expect(zurueck?.archiviert).toBeUndefined();
    expect(await archiv.liste(50, false)).toHaveLength(1);
  });

  it("gibt null zurück, wenn es die Analyse nicht gibt", async () => {
    expect(await archiv.archiviere("0123456789ab")).toBeNull();
    expect(await archiv.zurueckhole("0123456789ab")).toBeNull();
  });

  it("legt verworfene Analysen erst nach drei Tagen automatisch ins Archiv", async () => {
    const frisch = await archiv.lege(bericht);
    const alt = await archiv.lege(bericht);
    const offen = await archiv.lege(bericht);
    const idFrisch = frisch?.id ?? "";
    const idAlt = alt?.id ?? "";
    const idOffen = offen?.id ?? "";
    await archiv.aendere(idFrisch, { status: "verworfen" });
    await archiv.aendere(idAlt, { status: "verworfen" });
    // `idOffen` bleibt „offen" — nur verworfene Analysen räumen sich automatisch weg.

    // `alt` künstlich auf vier Tage zurückdatieren — nur `lege()` selbst setzt `zeit`.
    const pfad = path.join(ordner, "analysen");
    const dateiname = (await readdir(pfad)).find((d) => d.endsWith(`-${idAlt}.json`));
    if (!dateiname) throw new Error("Datei nicht gefunden.");
    const roh = JSON.parse(await readFile(path.join(pfad, dateiname), "utf8"));
    roh.zeit = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
    await writeFile(path.join(pfad, dateiname), `${JSON.stringify(roh, null, 2)}\n`, "utf8");

    const anzahl = await archiv.archiviereAlte();
    expect(anzahl).toBe(1);
    expect((await archiv.lies(idAlt))?.archiviert).toBeDefined();
    expect((await archiv.lies(idFrisch))?.archiviert).toBeUndefined();
    expect((await archiv.lies(idOffen))?.archiviert).toBeUndefined();
  });
});
