/**
 * Einmalig am 28.09.2026: ins neue Versuchsbuch (`gateway/versuche.ts`) nachtragen, was vor ihm
 * schon gerechnet wurde. Ohne das finge die Hürde bei null an, und die erste Regel nach dem
 * Suchlauf dieses Tages sähe aus wie ein erster Versuch.
 *
 * Nachgetragen wird, was sich belegen lässt:
 *  - jede Strategie im Archiv (18 am 28.09.), mit demselben Schlüssel, den die Ablage heute
 *    vergäbe — legt jemand dieselbe Regel noch einmal ab, zählt sie nicht doppelt;
 *  - die vier Nachrechnungen vom 28.09. mittags, mit dem Schlüssel, den `rechneNach` vergibt, und
 *    der Zahl der Varianten mit Urteil aus ihren Berichten (MACD 155, Bollinger 155, Scalping 156,
 *    SuperTrend 78) — die Neuauflage mit Sperrfrist zählt damit nicht noch einmal;
 *  - dieselben vier ohne Kosten (544 Varianten) und die Kostenstufen für Scalping und SuperTrend
 *    (74), beides am Abend von Claude Code gerechnet, um die Kosten von der Kante zu trennen.
 *
 * **Nicht nachgetragen**, weil nirgends festgehalten: die einzelnen Backtests der Bediensteten
 * vor dem 28.09., die nicht im Archiv landeten (allein am 27.09. 22 Konstruktionen an einem
 * Nachmittag). Die wahre Zahl liegt also höher als die, die das Buch nennt.
 *
 *   npx tsx bau/versuche-nachtragen.ts            zeigt, was nachgetragen würde
 *   npx tsx bau/versuche-nachtragen.ts --schreib  schreibt es ins Versuchsbuch
 */
import * as k from "../gateway/kalibrierung.js";
import { laufSchluessel } from "../gateway/nachrechnung.js";
import { createStrategien } from "../gateway/strategien.js";
import { createVersuchsbuch, regelSchluessel } from "../gateway/versuche.js";

const WORKDIR = "/opt/kuronami/workspace";
const schreib = process.argv.includes("--schreib");
const buch = createVersuchsbuch({ workdir: WORKDIR });
const archiv = createStrategien({ workdir: WORKDIR });

const zeilen: { schluessel: string; name: string; varianten: number; werkzeug: string }[] = [];

for (const kopf of await archiv.liste(1000, true)) {
  const e = await archiv.lies(kopf.id);
  if (!e) continue;
  zeilen.push({
    schluessel: regelSchluessel(e.strategie, [e.symbol], e.intervall),
    name: `Archiv ${e.id}: ${e.name}`,
    varianten: 1,
    werkzeug: "nachtrag",
  });
}

const laeufe: [string, k.Quellregel[], number][] = [
  [
    "macd",
    [
      k.MACD_VIDEO,
      {
        ...k.MACD_VIDEO,
        titel: `${k.MACD_VIDEO.titel} — Gegenprobe SMA 200`,
        teile: k.MACD_MIT_SMA,
      },
    ],
    155,
  ],
  [
    "bollinger",
    [
      k.BOLLINGER_VIDEO,
      {
        ...k.BOLLINGER_VIDEO,
        titel: `${k.BOLLINGER_VIDEO.titel} — Gegenprobe Stop am Swing`,
        teile: k.BOLLINGER_MIT_SWINGSTOP,
      },
    ],
    155,
  ],
  ["scalping", [k.SCALPING_VIDEO, k.BEST_SCALPING_VIDEO], 156],
  ["supertrend", [k.SUPERTREND_VIDEO], 78],
];
for (const [name, regeln, varianten] of laeufe) {
  zeilen.push({
    schluessel: laufSchluessel({ regeln }),
    name: `Nachrechnung ${name} vom 28.09. mittags`,
    varianten,
    werkzeug: "nachtrag",
  });
}
zeilen.push(
  {
    schluessel: "nachtrag:ohne-kosten-2026-09-28",
    name: "Die vier Nachrechnungen ohne Kosten (28.09. abends)",
    varianten: 544,
    werkzeug: "nachtrag",
  },
  {
    schluessel: "nachtrag:kostenstufen-2026-09-28",
    name: "Kostenstufen Scalping und SuperTrend nach Marktgruppe (28.09. abends)",
    varianten: 74,
    werkzeug: "nachtrag",
  },
);

for (const z of zeilen) console.log(`${String(z.varianten).padStart(4)}  ${z.name}`);
if (schreib) {
  let stand = await buch.stand();
  for (const z of zeilen) stand = await buch.zaehle({ wer: "nachtrag", ...z });
  console.log(`\nIm Versuchsbuch: ${stand.versuche} Versuche, Hürde ${stand.huerde.toFixed(2)}.`);
} else {
  console.log(
    `\nZusammen ${zeilen.reduce((a, z) => a + z.varianten, 0)} — mit --schreib eintragen.`,
  );
}
