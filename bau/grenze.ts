/**
 * Wie voll ist das Abo, und wie weit darf die Nacht noch? Für den Nachtbau (`bau/nachtbau.sh`),
 * der vor und während jeder Aufgabe fragt, ob er weiterarbeiten darf.
 *
 * Dieselbe Quelle wie die System-Seite (`gateway/abo.ts`): ein Claude-Code-Prozess ohne Nachricht,
 * kein Token. Die Grenzen der Nacht rechnet `gateway/nachtbudget.ts` — dieselbe Rechnung, nach der
 * der Lehrgang aufhört. Ausgabe eine Zeile, damit die Shell sie ohne jq lesen kann:
 *
 *   ok <sitzung%> <woche%> <sitzung-zurück-ISO> <woche-zurück-ISO> <grenze-sitzung%> <grenze-woche%> <letztes|->
 *   aus <grund>
 *
 * `aus` heißt: keine Zahl bekommen. Der Nachtbau arbeitet dann **nicht** — er rechnet nicht mit
 * einer Zahl, die nicht kam. Die eigenen Grenzen (85/85) und das Ende der Nacht reicht er über
 * `NACHTBAU_GRENZE_SITZUNG`, `NACHTBAU_GRENZE_WOCHE`, `NACHTBAU_ENDE` herein.
 */
import { createAboGrenzen } from "../gateway/abo.js";
import { NACHT_ENDE, inDerNacht, nachtgrenzen, wocheZuBeginn } from "../gateway/nachtbudget.js";

const zahl = (name: string, vorgabe: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : vorgabe;
};

const stand = await createAboGrenzen({ cwd: process.cwd() }).lies();
if (!stand.verfuegbar) {
  console.log(`aus ${stand.grund.replace(/\s+/g, " ")}`);
} else {
  const sitzung = stand.fenster.find((f) => f.id === "sitzung");
  const woche = stand.fenster.find((f) => f.id === "woche");
  if (!sitzung || !woche) {
    console.log(`aus Fenster fehlen: ${stand.fenster.map((f) => f.id).join(",") || "keine"}`);
  } else {
    const jetzt = new Date();
    const ende = process.env.NACHTBAU_ENDE?.trim() || NACHT_ENDE;
    // Festgehalten wird nur nachts; ein Aufruf von Hand am Tag legt keinen Nachtbeginn an.
    const wocheStart = inDerNacht(jetzt, ende)
      ? await wocheZuBeginn(`${process.cwd()}/workspace`, jetzt, woche.prozent)
      : woche.prozent;
    // Eine von Jakob freigegebene Nacht (`NACHTBAU_FREI` in nachtbau.sh): ohne Nachtbudget.
    const frei = process.env.NACHTBAU_OHNE_BUDGET === "1";
    const normal = {
      sitzung: zahl("NACHTBAU_GRENZE_SITZUNG", 85),
      woche: zahl("NACHTBAU_GRENZE_WOCHE", 85),
    };
    const g = frei
      ? { ...normal, letztesFenster: false }
      : nachtgrenzen({
          fenster: stand.fenster,
          wocheStart,
          jetzt,
          ende,
          normal,
        });
    console.log(
      [
        "ok",
        Math.round(sitzung.prozent),
        Math.round(woche.prozent),
        sitzung.zurueck ?? "-",
        woche.zurueck ?? "-",
        g.sitzung,
        g.woche,
        g.letztesFenster ? "letztes" : "-",
      ].join(" "),
    );
  }
}
process.exit(0);
