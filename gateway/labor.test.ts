import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BEDIENSTETE, HANDELSTISCH } from "../context/bedienstete.js";
import { LABOR_PRUEFEN, LABOR_TOOLS } from "./labor.js";

/**
 * Geprüft wird hier nicht, ob das Labor richtig rechnet — das tun die Tests der einzelnen
 * Module —, sondern ob seine Werkzeuge bei den Bediensteten **ankommen**.
 *
 * Der Anlass ist ein echter Fehlschlag vom 2026-09-21: `kerzen_laden` und `universum` waren am
 * Server angemeldet, in `LABOR_TOOLS` eingetragen und im Prompt des Strategen beschrieben —
 * aber nicht in seiner Freigabeliste in `bedienstete.ts`. Er konnte sie nicht aufrufen und
 * hätte es auch nicht gemerkt: ein nicht freigegebenes Werkzeug fehlt einfach im Katalog, ohne
 * Fehler und ohne Hinweis. Die Namen müssen zweimal stehen, weil `context/` nicht aus
 * `gateway/` importieren darf (siehe `layering.test.ts`) — also muss ein Test sie
 * gegeneinanderhalten.
 */

const HIER = path.dirname(fileURLToPath(import.meta.url));

/** Die Werkzeugnamen, wie sie in `labor.ts` wirklich angemeldet werden. */
async function angemeldeteWerkzeuge(): Promise<string[]> {
  const quelle = await readFile(path.join(HIER, "labor.ts"), "utf8");
  const namen = [...quelle.matchAll(/\btool\(\s*\n?\s*"([a-z_]+)"/g)].map((t) => t[1]);
  return [...new Set(namen)].map((n) => `mcp__labor__${n}`);
}

describe("Die Werkzeuge des Labors kommen an", () => {
  it("findet die Werkzeuge überhaupt (Gegenprobe zum Test selbst)", async () => {
    const angeboten = await angemeldeteWerkzeuge();
    expect(angeboten.length).toBeGreaterThan(10);
    expect(angeboten).toContain("mcp__labor__backtest");
  });

  it("nennt in LABOR_TOOLS genau das, was angemeldet ist", async () => {
    expect((await angemeldeteWerkzeuge()).sort()).toEqual([...LABOR_TOOLS].sort());
  });

  it("gibt jedes angemeldete Werkzeug mindestens einem Bediensteten frei", async () => {
    const freigegeben = new Set(
      [...Object.values(BEDIENSTETE), ...Object.values(HANDELSTISCH)].flatMap(
        (b) => (b.tools ?? []) as string[],
      ),
    );
    const angeboten = await angemeldeteWerkzeuge();
    // `papier_start` ist bewusst nur für einen da — deshalb wird hier auf „mindestens einer"
    // geprüft und nicht auf „alle".
    expect(angeboten.filter((name) => !freigegeben.has(name))).toEqual([]);
  });

  it("gibt dem Strategen die Werkzeuge, die sein Prompt ihm zuschreibt", () => {
    const stratege = HANDELSTISCH.stratege.tools ?? [];
    for (const name of [
      "mcp__labor__backtest",
      "mcp__labor__universum",
      "mcp__labor__kerzen_laden",
      "mcp__labor__strategie_ablegen",
    ]) {
      expect(stratege).toContain(name);
    }
  });

  it("gibt dem Prüfer die Gegenprobe, aber nicht das Ablegen", () => {
    const pruefer = HANDELSTISCH.pruefer.tools ?? [];
    expect(pruefer).toContain("mcp__labor__gegenprobe");
    expect(pruefer).toContain("mcp__labor__universum");
    expect(pruefer).not.toContain("mcp__labor__strategie_ablegen");
    expect(LABOR_PRUEFEN).not.toContain("mcp__labor__strategie_ablegen");
  });
});

describe("Die Schlussprobe hat nur der Prüfer", () => {
  it("gibt sie dem Prüfer und nicht dem Strategen, der die Regel entwickelt", () => {
    expect(HANDELSTISCH.pruefer.tools ?? []).toContain("mcp__labor__schlussprobe");
    expect(HANDELSTISCH.stratege.tools ?? []).not.toContain("mcp__labor__schlussprobe");
  });
});
