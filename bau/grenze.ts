/**
 * Wie voll ist das Abo? Für den Nachtbau (`bau/nachtbau.sh`), der vor und während jeder Aufgabe
 * fragt, ob er weiterarbeiten darf.
 *
 * Dieselbe Quelle wie die System-Seite (`gateway/abo.ts`): ein Claude-Code-Prozess ohne Nachricht,
 * kein Token. Ausgabe eine Zeile, damit die Shell sie ohne jq lesen kann:
 *
 *   ok <sitzung%> <woche%> <sitzung-zurück-ISO> <woche-zurück-ISO>
 *   aus <grund>
 *
 * `aus` heißt: keine Zahl bekommen. Der Nachtbau arbeitet dann **nicht** — er rechnet nicht mit
 * einer Zahl, die nicht kam.
 */
import { createAboGrenzen } from "../gateway/abo.js";

const stand = await createAboGrenzen({ cwd: process.cwd() }).lies();
if (!stand.verfuegbar) {
  console.log(`aus ${stand.grund.replace(/\s+/g, " ")}`);
} else {
  const sitzung = stand.fenster.find((f) => f.id === "sitzung");
  const woche = stand.fenster.find((f) => f.id === "woche");
  if (!sitzung || !woche) {
    console.log(`aus Fenster fehlen: ${stand.fenster.map((f) => f.id).join(",") || "keine"}`);
  } else {
    console.log(
      `ok ${Math.round(sitzung.prozent)} ${Math.round(woche.prozent)} ${sitzung.zurueck ?? "-"} ${woche.zurueck ?? "-"}`,
    );
  }
}
process.exit(0);
