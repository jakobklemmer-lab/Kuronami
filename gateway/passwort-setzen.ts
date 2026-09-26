import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hashePasswort } from "./anmeldung.js";

/**
 * Hinter `pnpm passwort-setzen`: das Passwort der Oberfläche neu setzen und den Gateway starten.
 * Der Einstiegspunkt daneben ist `passwort-setzen-cli.ts` — hier steht nur, was auch prüfbar ist.
 *
 * **Warum es das gibt.** Die Maske kennt kein „Passwort vergessen" und soll es auch nicht kennen
 * (`gateway/anmeldung.ts`): ein zweiter Weg hinein ist ein zweiter Weg hinein. Der vorgesehene
 * Weg zurück führt über den Server — er bestand aber aus drei Handgriffen (`pnpm passwort`, die
 * Zeile in die `.env` tragen, Dienst neu starten), und der erste davon hat eine Falle: ein
 * Passwort mit `$`, `!` oder Leerzeichen wird von der Shell verändert, bevor es gehasht wird.
 * Gesetzt ist dann ein anderes Passwort als das eingegebene — und die Maske sagt beide Male nur
 * „stimmt nicht".
 *
 * Hier wird das Passwort deshalb **verdeckt vom Terminal gelesen** — keine Shell, keine
 * Expansion, keine Historie — und zur Sicherheit ein zweites Mal abgefragt, weil ein Vertipper
 * sonst erst beim Aussperren auffällt.
 *
 * `pnpm passwort <klartext>` bleibt daneben bestehen: es druckt nur den Hash und rührt nichts an.
 */

const ENV_PFAD = join(dirname(new URL(import.meta.url).pathname), "..", ".env");
const DIENST = "kuronami-gateway";

const ZEILENENDE = "\n";
const STRG_C = "\u0003";
const RUECKTASTE = "\u007f";

/**
 * Ersetzt die `WEB_LOGIN_HASH`-Zeile und lässt jede andere Zeile **byte-genau** stehen.
 *
 * In dieser Datei stehen alle Schlüssel des Hauses. Sie neu zu schreiben, weil ein Wert sich
 * ändert, wäre die teuerste Art, einen Tippfehler zu machen — also wird genau eine Zeile
 * angefasst, und wenn die Datei nicht so aussieht wie erwartet, wird gar nichts angefasst.
 */
export function ersetzeHashZeile(inhalt: string, hash: string): string {
  const zeilen = inhalt.split(ZEILENENDE);
  const treffer = zeilen
    .map((zeile, i) => ({ zeile, i }))
    .filter(({ zeile }) => /^WEB_LOGIN_HASH\s*=/.test(zeile));
  if (treffer.length === 0) {
    throw new Error(
      "In der .env steht keine Zeile WEB_LOGIN_HASH= — bitte einmal von Hand anlegen.",
    );
  }
  if (treffer.length > 1) {
    const zeilennummern = treffer.map(({ i }) => i + 1).join(", ");
    const wo = `WEB_LOGIN_HASH steht mehrfach in der .env (Zeilen ${zeilennummern}).`;
    throw new Error(`${wo} Welche davon gilt, entscheidet nicht dieses Werkzeug.`);
  }
  zeilen[treffer[0].i] = `WEB_LOGIN_HASH=${hash}`;
  return zeilen.join(ZEILENENDE);
}

/** Schreibt über eine Nachbardatei und benennt um: ein Abbruch mittendrin lässt die alte .env heil. */
function schreibeAtomar(pfad: string, inhalt: string): void {
  const modus = statSync(pfad).mode & 0o777;
  const vorlaeufig = `${pfad}.neu`;
  writeFileSync(vorlaeufig, inhalt, { mode: modus });
  chmodSync(vorlaeufig, modus);
  renameSync(vorlaeufig, pfad);
}

/**
 * Woher die beiden Eingaben kommen.
 *
 * Am Terminal: verdeckt getippt. Ohne Terminal (`printf '%s\n%s\n' "$pw" "$pw" | pnpm
 * passwort-setzen`): **einmal** alles von stdin lesen und dann Zeile für Zeile herausgeben — ein
 * zweites `read` auf dieselbe Pipe fände nichts mehr und machte aus zwei gleichen Eingaben zwei
 * verschiedene.
 */
export function erzeugeEingabe(): (frage: string) => Promise<string> {
  if (process.stdin.isTTY) return frageVerdeckt;
  let zeilen: string[];
  try {
    zeilen = readFileSync(0, "utf8")
      .split(ZEILENENDE)
      .map((zeile) => zeile.replace(/\r$/, ""));
  } catch {
    console.error(
      "Kein Terminal und nichts auf stdin. Entweder in einer Shell aufrufen oder das Passwort " +
        "zweimal hineinleiten.",
    );
    process.exit(1);
  }
  let naechste = 0;
  return async () => zeilen[naechste++] ?? "";
}

/** Liest eine Zeile vom Terminal, ohne sie anzuzeigen. */
async function frageVerdeckt(frage: string): Promise<string> {
  process.stdout.write(frage);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return await new Promise<string>((fertig) => {
    let eingabe = "";
    const beiZeichen = (stueck: Buffer): void => {
      for (const zeichen of stueck.toString("utf8")) {
        if (zeichen === ZEILENENDE || zeichen === "\r") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", beiZeichen);
          process.stdout.write(ZEILENENDE);
          fertig(eingabe);
          return;
        }
        if (zeichen === STRG_C) {
          // Abbruch: nichts gehasht, nichts geschrieben, nichts neu gestartet.
          process.stdin.setRawMode(false);
          process.stdout.write(`${ZEILENENDE}Abgebrochen.${ZEILENENDE}`);
          process.exit(130);
        }
        if (zeichen === RUECKTASTE) {
          eingabe = eingabe.slice(0, -1);
          continue;
        }
        eingabe += zeichen;
      }
    };
    process.stdin.on("data", beiZeichen);
  });
}

/** Der ganze Weg: fragen, hashen, die eine Zeile tauschen, den Dienst neu starten. */
export async function setzePasswort(optionen: { envPfad?: string } = {}): Promise<void> {
  const envPfad = optionen.envPfad ?? ENV_PFAD;
  const ohneNeustart = process.argv.includes("--ohne-neustart");
  const frageVerdeckt = erzeugeEingabe();

  const passwort = await frageVerdeckt("Neues Passwort: ");
  if (passwort.length < 8) {
    console.error("Zu kurz: mindestens acht Zeichen. Diese Tür steht im offenen Netz.");
    process.exit(1);
  }
  const wiederholung = await frageVerdeckt("Noch einmal:    ");
  if (passwort !== wiederholung) {
    console.error("Die beiden Eingaben sind nicht gleich — es wurde nichts geändert.");
    process.exit(1);
  }

  const vorher = readFileSync(envPfad, "utf8");
  const nachher = ersetzeHashZeile(vorher, hashePasswort(passwort));
  schreibeAtomar(envPfad, nachher);
  console.log(`Neuer Hash steht in ${envPfad}.`);

  if (ohneNeustart) {
    console.log(`Der Gateway liest die .env beim Start: systemctl restart ${DIENST}`);
    return;
  }
  // Feste Argumentliste, kein String durch die Shell — dieselbe Regel wie in `gateway/restart.ts`.
  execFileSync("systemctl", ["restart", DIENST], { stdio: "inherit" });
  console.log(
    `${DIENST} neu gestartet. Das Passwort gilt ab sofort; ausgestellte Sitzungen bleiben gültig.`,
  );
}
