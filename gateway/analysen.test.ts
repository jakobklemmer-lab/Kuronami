import { mkdtemp, readdir, writeFile } from "node:fs/promises";
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
