import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * Was der Dev-Server (`ui/dev.ts`) und der Bau (`ui/build.ts`) gemeinsam brauchen.
 *
 * **Warum keine Bundler-Abhängigkeit:** die Oberfläche besteht aus ES-Modulen, und ein Browser
 * lädt die von sich aus. Zu übersetzen ist genau eines — TypeScript zu JavaScript —, und der
 * Übersetzer liegt ohnehin im Projekt (`typescript` als devDependency, seit S01). Ein Bundler
 * daneben wäre ein zweites Werkzeug für eine Aufgabe, die schon erledigt ist, und eine zweite
 * Stelle, an der Modulauflösung konfiguriert wird.
 *
 * Die Importe in `ui/**` sind auf `.js` geschrieben (NodeNext-Stil, wie im ganzen Projekt).
 * Das trifft sich: der Browser fragt danach `./events/bus.js`, und hier wird `events/bus.ts`
 * übersetzt. Es muss also nichts umgeschrieben werden.
 */

export const UI_ROOT = path.dirname(fileURLToPath(import.meta.url));

/** Die Einstiegspunkte, die im Bau landen. Alles Weitere zieht der Browser über Importe nach. */
export const ENTRY_POINTS = ["main.ts", "events/bus.ts"] as const;

export const STATIC_FILES = [
  "index.html",
  "styles/theme.css",
  "styles/layout.css",
  "assets/lake.jpg",
] as const;

const TRANSPILE: ts.TranspileOptions = {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    isolatedModules: true,
    verbatimModuleSyntax: true,
    inlineSourceMap: true,
    inlineSources: true,
  },
};

/** Übersetzt eine einzelne Datei. Typen werden dabei nur entfernt, nicht geprüft — das macht
 * `pnpm typecheck` über `ui/tsconfig.json`, und es soll beim Ausliefern nicht ein zweites Mal
 * (und dann langsamer) geschehen. */
export function transpile(source: string, fileName: string): string {
  const result = ts.transpileModule(source, { ...TRANSPILE, fileName });
  if (result.diagnostics !== undefined && result.diagnostics.length > 0) {
    // Ein Übersetzungsfehler geht als Fehler hinaus und nicht als halbe Datei (AGENTS.md:
    // Fehler nie verstecken). Eine still ausgelieferte Bruchstückdatei wäre im Browser ein
    // rätselhafter Syntaxfehler ohne Herkunft.
    const messages = result.diagnostics
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "))
      .join("; ");
    throw new Error(`${fileName}: ${messages}`);
  }
  return result.outputText;
}

/** Liest `<name>.ts` unter `ui/` und gibt das übersetzte JavaScript zurück. */
export async function transpileFile(relativeTsPath: string): Promise<string> {
  const absolute = path.join(UI_ROOT, relativeTsPath);
  return transpile(await readFile(absolute, "utf8"), absolute);
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".woff2": "font/woff2",
};

export function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Hält einen angefragten Pfad innerhalb von `ui/`. Dieselbe Haltung wie `resolvePath` für
 * `fs.*` (AGENTS.md): ein `..` im Pfad wird nicht toleriert, auch nicht in einem Dev-Server —
 * der läuft auf demselben Rechner wie alles andere.
 */
export function resolveInUi(urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const candidate = path.resolve(UI_ROOT, `.${path.posix.normalize(decoded)}`);
  const root = path.resolve(UI_ROOT);
  if (candidate !== root && !candidate.startsWith(root + path.sep)) return null;
  return candidate;
}
