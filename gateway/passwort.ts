import { hashePasswort } from "./anmeldung.js";

/**
 * `pnpm passwort <klartext>` — druckt den Hash für `WEB_LOGIN_HASH`.
 *
 * Ein eigener kleiner Einstiegspunkt, weil das Passwort **nirgends** im Quelltext oder in der
 * Historie stehen soll: es wird einmal auf dem Server gehasht, der Hash wandert in die `.env`,
 * der Klartext bleibt beim Nutzer. Der Aufruf steht danach allenfalls in der Shell-Historie —
 * wer das vermeiden will, ruft ihn mit führendem Leerzeichen auf.
 */

const klartext = process.argv[2];
if (klartext === undefined || klartext.length === 0) {
  console.error("Aufruf: pnpm passwort <klartext>");
  process.exit(1);
}
if (klartext.length < 8) {
  console.error("Zu kurz: mindestens acht Zeichen. Diese Tür steht im offenen Netz.");
  process.exit(1);
}
console.log(hashePasswort(klartext));
