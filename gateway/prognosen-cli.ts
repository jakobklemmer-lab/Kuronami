/**
 * `pnpm prognosen` — der Blick ins Prognosebuch, ohne den Umweg über Kuro.
 *
 * Es ist bewusst nur ein Leser: abgelegt wird von dem, der die Idee vorlegt (der Chefanalyst
 * über `prognose_anlegen`), benotet wird aus den Kerzen. Ein zweiter Eingang zum Ablegen wäre
 * ein zweiter Absender, und die Akte lebt davon, dass jede Behauptung einen hat.
 */

import { createKerzenquelle } from "./kerzen.js";
import { createPrognosen, formatiereAkte, formatiereBenotung } from "./prognosen.js";

const WORKDIR = process.env.KURO_WORKDIR?.trim() || "/opt/kuronami/workspace";

async function main(): Promise<void> {
  const id = process.argv[2];
  if (id === "--hilfe" || id === "-h") {
    console.log(
      [
        "Aufruf:",
        "  pnpm prognosen           — alle Einzelideen benoten, dazu die Akten",
        "  pnpm prognosen <id>      — eine einzelne Idee benoten",
        "",
        "Umgebung: KURO_WORKDIR (Vorgabe /opt/kuronami/workspace).",
      ].join("\n"),
    );
    return;
  }

  const quelle = createKerzenquelle({ workdir: WORKDIR });
  const buch = createPrognosen({
    workdir: WORKDIR,
    kerzen: async (symbol, vonUnix, bisUnix) =>
      (await quelle.hole({ symbol, intervall: "1d", vonUnix, bisUnix })).kerzen,
  });

  if (id) {
    const eine = await buch.pruefe(id);
    if (!eine) {
      console.error(`Keine Prognose zu „${id}".`);
      process.exitCode = 1;
      return;
    }
    console.log(formatiereBenotung(eine));
    return;
  }

  const alle = await buch.pruefeAlle();
  if (alle.length === 0) {
    console.log("Im Prognosebuch steht noch nichts.");
    return;
  }
  for (const b of alle) console.log(`${formatiereBenotung(b)}\n`);

  console.log("—".repeat(60));
  for (const von of [...new Set(alle.map((b) => b.von))].sort()) {
    console.log(`\n${formatiereAkte(await buch.akteVon(von))}`);
  }
}

main().catch((fehler) => {
  console.error(fehler instanceof Error ? fehler.message : fehler);
  process.exitCode = 1;
});
