import { setzePasswort } from "./passwort-setzen.js";

/**
 * `pnpm passwort-setzen` — fragt das neue Passwort verdeckt ab, trägt den Hash in die `.env`
 * und startet den Gateway neu. Warum es diesen Weg gibt, steht in `passwort-setzen.ts`.
 *
 * `--ohne-neustart` schreibt nur die Datei und nennt den Befehl, der noch fehlt.
 */

void setzePasswort();
