import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * **Die harte Regel aus Abschnitt 3, als Test:** "Die Surface-Schicht ist austauschbar. Die
 * Runtime darf niemals von ihr abhängen."
 *
 * Bis S16 war das eine Zusage, die sich von selbst hielt, weil es die Schicht noch nicht gab.
 * Ab S16 gibt es sie, und die Versuchung entsteht mit dem ersten Nachrichtenfeld, das die
 * Runtime "auch ganz praktisch" hätte. Ein Import ist schnell geschrieben und fällt in keinem
 * Testlauf auf — es funktioniert ja alles, bis jemand das Gateway austauschen will.
 *
 * Der Test liest die Quellen und ist damit die einzige Stelle, an der die Regel eine Prüfung
 * ist und nicht ein Satz in einer Datei. Dasselbe Muster wie `MAIL_WEBHOOKS` in S14: die
 * Zusage wird an ihrem Rand nachgewiesen, nicht per Quelltextlektüre versprochen.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

/**
 * Die Schichten, die die Surface-Schicht nicht kennen dürfen (Abschnitt 3). Bis 2026-09-20 war
 * `policy` die vierte; mit dem alten Motor ist sie gegangen, das eine noch benutzte Stück (die
 * Risikostufen) steht heute in `runtime/mcp/config-store.ts`.
 */
const INNER_LAYERS = ["runtime", "context", "tools"];

const IMPORT_PATTERN = /(?:^|\n)\s*(?:import|export)[^;\n]*?from\s+["']([^"']+)["']/g;
const DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(\s*["']([^"']+)["']/g;

async function sourceFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      found.push(...(await sourceFiles(full)));
      continue;
    }
    if (entry.name.endsWith(".ts")) found.push(full);
  }
  return found;
}

function specifiersOf(source: string): string[] {
  const found: string[] = [];
  for (const pattern of [IMPORT_PATTERN, DYNAMIC_IMPORT_PATTERN]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) found.push(match[1]);
  }
  return found;
}

/** Zeigt dieser Import auf `gateway/`? Relativ wie absolut aufgelöst. */
function pointsAtGateway(from: string, specifier: string): boolean {
  if (!specifier.startsWith(".")) return specifier.startsWith("gateway/");
  const resolved = path.resolve(path.dirname(from), specifier);
  return path.relative(ROOT, resolved).split(path.sep)[0] === "gateway";
}

describe("Schichtung", () => {
  it("hält runtime, context und tools frei von jedem Import aus gateway/", async () => {
    const offenders: string[] = [];

    for (const layer of INNER_LAYERS) {
      for (const file of await sourceFiles(path.join(ROOT, layer))) {
        const source = await readFile(file, "utf8");
        for (const specifier of specifiersOf(source)) {
          if (pointsAtGateway(file, specifier)) {
            offenders.push(`${path.relative(ROOT, file)} → ${specifier}`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("prüft dabei wirklich Dateien (Gegenprobe zum Test selbst)", async () => {
    // Ein Schichtungstest, der versehentlich null Dateien liest, ist immer grün. Deshalb steht
    // die Zahl hier fest genug, um das zu bemerken, und offen genug, um nicht bei jeder neuen
    // Datei zu reißen. Bis 2026-09-20 waren es über 50 Dateien; nach dem Ausbau des alten
    // Motors sind 44 übrig, und die Schwelle rutscht mit — sie soll ein leeres Verzeichnis
    // melden, nicht eine Aufräumarbeit.
    let count = 0;
    for (const layer of INNER_LAYERS) count += (await sourceFiles(path.join(ROOT, layer))).length;

    expect(count).toBeGreaterThan(30);
    // Und der Erkenner selbst muss anschlagen, sonst prüfte der Test oben nur sein eigenes
    // leeres Ergebnis.
    expect(pointsAtGateway(path.join(ROOT, "runtime", "index.ts"), "../gateway/core.js")).toBe(
      true,
    );
    expect(pointsAtGateway(path.join(ROOT, "runtime", "index.ts"), "gateway/core.js")).toBe(true);
    expect(pointsAtGateway(path.join(ROOT, "runtime", "index.ts"), "./db/pool.js")).toBe(false);
    expect(pointsAtGateway(path.join(ROOT, "gateway", "core.ts"), "../runtime/events/log.js")).toBe(
      false,
    );
  });

  it("erkennt Imports in der Form, in der sie im Baum wirklich vorkommen", () => {
    const source = [
      'import { a } from "./x.js";',
      'import type { B } from "../gateway/types.js";',
      'export { c } from "./y.js";',
      'const d = await import("./z.js");',
    ].join("\n");

    expect(specifiersOf(source)).toEqual(["./x.js", "../gateway/types.js", "./y.js", "./z.js"]);
  });
});
