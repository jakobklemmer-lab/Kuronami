/**
 * Einmalig am 28.09.2026: alle abgelegten Strategien nach der neuen Regel in `bewerte` neu
 * einstufen (Urteil erst ab 200 Handeln, `verworfen` nur mit Beleg). Gerechnet wird aus den
 * abgelegten Kennzahlen, ohne neuen Backtest. Jakobs eigene Markierung am DAX-Pullback bleibt.
 *
 *   npx tsx bau/neu-bewerten.ts            zeigt, was sich ändern würde
 *   npx tsx bau/neu-bewerten.ts --schreib  schreibt Status und eine Zeile in die Notiz
 */
import { bewerte, createStrategien } from "../gateway/strategien.js";

const NICHT_ANFASSEN = new Set(["6d6a4ccea65f"]); // Jakob, 27.09.: „Hat 60% Trefferquote, nochmal anschauen."
const schreib = process.argv.includes("--schreib");
const archiv = createStrategien({ workdir: "/opt/kuronami/workspace" });

for (const kopf of await archiv.liste(undefined, true)) {
  const e = await archiv.lies(kopf.id);
  if (!e) continue;
  const neu = bewerte(e.kennzahlen, e.outOfSample, e.warnungstexte, e.universum);
  if (neu === e.status) continue;
  const bleibt = NICHT_ANFASSEN.has(e.id);
  console.log(
    `${bleibt ? "bleibt " : ""}${e.status} → ${neu}  ${e.kennzahlen?.anzahl ?? 0} Handel  ${e.name}`,
  );
  if (!schreib || bleibt) continue;
  const zeile = `Status am 28.09.2026 neu gerechnet (Urteil erst ab 200 Handeln, verworfen nur mit Beleg): vorher „${e.status}", jetzt „${neu}".`;
  await archiv.aendere(e.id, { status: neu, notiz: e.notiz ? `${e.notiz}\n\n${zeile}` : zeile });
}
