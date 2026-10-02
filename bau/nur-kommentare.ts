/**
 * Hat sich seit <basis> nur an Kommentaren etwas geändert? Für die Nachtaufgaben, die Kommentare
 * kürzen: der Code muss danach Zeichen für Zeichen derselbe sein.
 *
 *   npx tsx bau/nur-kommentare.ts <basis>      (Vorgabe: HEAD~1)
 *
 * Vergleicht je geänderter .ts-Datei den Quelltext ohne Kommentare, so wie ihn der
 * TypeScript-Drucker ausgibt — Formatierung zählt also nicht. Erlaubt außerdem Änderungen unter
 * `bau/` (Plan, Bericht). Alles andere — neue, gelöschte oder andere Dateien — ist ein Fehler.
 * Ausgabe: `ok <n Dateien>` und Code 0, sonst die Abweichungen und Code 1.
 */
import { execFileSync } from "node:child_process";
import ts from "typescript";

const basis = process.argv[2] ?? "HEAD~1";
const git = (...args: string[]): string =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const drucker = ts.createPrinter({ removeComments: true });
const ohneKommentare = (name: string, text: string): string =>
  drucker.printFile(ts.createSourceFile(name, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS));

const fehler: string[] = [];
let geprueft = 0;
for (const zeile of git("diff", "--name-status", basis).split("\n").filter(Boolean)) {
  const [art, datei] = zeile.split("\t");
  if (!datei || datei.startsWith("bau/")) continue;
  if (art !== "M") {
    fehler.push(`${datei}: ${art === "A" ? "neu" : art === "D" ? "gelöscht" : art}`);
    continue;
  }
  if (!datei.endsWith(".ts")) {
    fehler.push(`${datei}: keine .ts-Datei`);
    continue;
  }
  const vorher = ohneKommentare(datei, git("show", `${basis}:${datei}`));
  const nachher = ohneKommentare(datei, git("show", `HEAD:${datei}`));
  geprueft += 1;
  if (vorher !== nachher) fehler.push(`${datei}: Code geändert`);
}

if (fehler.length > 0) {
  console.log(fehler.join("\n"));
  process.exit(1);
}
console.log(`ok ${geprueft} Dateien`);
