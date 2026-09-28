/**
 * Ein Video durch den Lehrgang, von Hand (N8, 2026-09-28) — derselbe Weg wie nachts
 * (`gateway/lehrgang.ts`), nur ohne Fenster und Nachtgrenze und außerhalb von Kuros Zugschlange:
 * das Skript läuft neben dem Gateway, nicht in ihm.
 *
 *   npx tsx bau/lehrgang-probe.ts [video-id]    (Vorgabe: rf_EQvubKlk, BEST MACD)
 *
 * Schreibt, was der Lehrgang schreibt: die Notiz unter `wissen/tradinglab/notizen/`, den Versuch
 * in `lehrgang.json` und den Verbrauch ins Verbrauchsbuch. Beginnt nicht über den Grenzen des
 * Abos, die auch nachts gelten.
 */
import { createAboGrenzen } from "../gateway/abo.js";
import { schreibeEinmal } from "../gateway/einmal.js";
import { createLehrgang, warumNichtAbo } from "../gateway/lehrgang.js";
import { type Posten, createVerbrauch } from "../gateway/verbrauch.js";
import { createWissen } from "../gateway/wissen.js";

const workdir = process.env.KURO_WORKDIR?.trim() || "/opt/kuronami/workspace";
const id = process.argv[2] ?? "rf_EQvubKlk";

const abo = createAboGrenzen({ cwd: workdir });
const grund = warumNichtAbo(await abo.lies(true));
if (grund) {
  console.error(`Nicht begonnen: ${grund}`);
  process.exit(2);
}

const verbrauch = createVerbrauch({ workdir });
const posten: Posten[] = [];
const lehrgang = createLehrgang({
  workdir,
  wissen: createWissen({ workdir }),
  modell: "Sonnet",
  schreibe: (system, prompt) =>
    schreibeEinmal({
      wer: "kuro",
      wofuer: "lehrgang",
      system,
      prompt,
      model: "sonnet",
      cwd: workdir,
      onVerbrauch: (p) => {
        posten.push(p);
        void verbrauch.buche(p);
      },
    }),
  abo: () => abo.lies(true),
  schlange: (arbeit) => arbeit(),
});

const versuch = await lehrgang.lerne(id);
console.log(JSON.stringify({ versuch, verbrauch: posten }, null, 1));
process.exit(versuch.ok ? 0 : 1);
