import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * **Die harte Regel aus Abschnitt 3, für den Heartbeat:** die Surface-Schicht ist
 * austauschbar, die Runtime darf nie von ihr abhängen. `heartbeat/` ist ein zweites
 * Surface-Modul neben `gateway/` — dieselbe Prüfung, dasselbe Muster wie `gateway/layering.test.ts`.
 *
 * `heartbeat/` darf auf `runtime/`, `context/`, `tools/`, `policy/` und `gateway/` (denselben
 * SDK-freien Telegram-Client) zeigen. Umgekehrt nie.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const INNER_LAYERS = ["runtime", "context", "tools", "policy"];

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

function pointsAtHeartbeat(from: string, specifier: string): boolean {
  if (!specifier.startsWith(".")) return specifier.startsWith("heartbeat/");
  const resolved = path.resolve(path.dirname(from), specifier);
  return path.relative(ROOT, resolved).split(path.sep)[0] === "heartbeat";
}

describe("Schichtung · heartbeat", () => {
  it("hält runtime, context, tools und policy frei von jedem Import aus heartbeat/", async () => {
    const offenders: string[] = [];
    for (const layer of INNER_LAYERS) {
      for (const file of await sourceFiles(path.join(ROOT, layer))) {
        const source = await readFile(file, "utf8");
        for (const specifier of specifiersOf(source)) {
          if (pointsAtHeartbeat(file, specifier)) {
            offenders.push(`${path.relative(ROOT, file)} → ${specifier}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("prüft dabei wirklich Dateien und der Erkenner schlägt an", async () => {
    let count = 0;
    for (const layer of INNER_LAYERS) count += (await sourceFiles(path.join(ROOT, layer))).length;
    expect(count).toBeGreaterThan(50);

    expect(
      pointsAtHeartbeat(path.join(ROOT, "runtime", "index.ts"), "../heartbeat/digest.js"),
    ).toBe(true);
    expect(pointsAtHeartbeat(path.join(ROOT, "runtime", "index.ts"), "heartbeat/digest.js")).toBe(
      true,
    );
    expect(pointsAtHeartbeat(path.join(ROOT, "runtime", "index.ts"), "./db/pool.js")).toBe(false);
  });
});
