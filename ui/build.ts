import { copyFile, cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { STATIC_DIRS, STATIC_FILES, UI_ROOT, transpileFile } from "./serve.js";

/**
 * Der Bau der Oberfläche (S21): `ui/**` nach `ui/dist/`, TypeScript übersetzt, sonst
 * unverändert kopiert. Kein Bundling, kein Minifizieren — die Seite besteht aus ES-Modulen,
 * die ein Browser selbst nachlädt, und das bleibt so, bis es einen messbaren Grund dagegen
 * gibt.
 */

const OUT_DIR = path.join(UI_ROOT, "dist");

/** Alle `.ts` unter `ui/`, ohne Tests und ohne die Node-Seite (Dev-Server, Bau, Helfer). */
const NODE_ONLY = new Set(["dev.ts", "build.ts", "serve.ts"]);

async function collectSources(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === "dist" || entry.name === "node_modules") continue;
      found.push(...(await collectSources(path.join(dir, entry.name), relative)));
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".test.ts")) continue;
    if (NODE_ONLY.has(relative)) continue;
    found.push(relative);
  }
  return found;
}

async function main(): Promise<void> {
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const sources = await collectSources(UI_ROOT);
  for (const relative of sources) {
    const target = path.join(OUT_DIR, relative.replace(/\.ts$/, ".js"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await transpileFile(relative), "utf8");
  }

  for (const relative of STATIC_FILES) {
    const target = path.join(OUT_DIR, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(UI_ROOT, relative), target);
  }

  for (const relative of STATIC_DIRS) {
    await cp(path.join(UI_ROOT, relative), path.join(OUT_DIR, relative), { recursive: true });
  }

  console.log(
    `[ui] ${sources.length} Module übersetzt, ${STATIC_FILES.length} Dateien und ${STATIC_DIRS.length} Ordner kopiert → ${path.relative(process.cwd(), OUT_DIR)}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
