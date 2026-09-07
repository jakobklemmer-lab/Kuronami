import { ToolRegistry } from "../tools/registry.js";
import { createPool } from "./db/pool.js";
import { type SessionChannel, startRuntime } from "./session/manager.js";

const SIGNALS = ["SIGINT", "SIGTERM"] as const;

/**
 * Der Tool-Katalog dieses Prozesses. Vorerst leer: die Prüf-Tools aus `tools/dummies.ts`
 * gehören nicht in einen produktiven Katalog, und echte Tools gibt es ab S08. Er wird
 * trotzdem hier gebaut, weil die Version in die Session gehört (S07) — eine Session weiß
 * damit von Anfang an, unter welchem Tool-Vertrag sie eröffnet wurde.
 */
const CATALOG = new ToolRegistry().freeze();

/**
 * Das Skelett bedient eine Session und tut sonst nichts. Woher Faden und Kanal wirklich
 * kommen, entscheidet das Gateway (S16); bis dahin genügt die Umgebung mit festen Werten
 * für den Entwicklungsrechner.
 */
async function main(): Promise<void> {
  const pool = createPool();
  const runtime = await startRuntime(pool, {
    threadId: process.env.KURONAMI_THREAD_ID ?? "thread_dev_local",
    channel: (process.env.KURONAMI_CHANNEL as SessionChannel | undefined) ?? "web",
    defaults: { toolCatalogVersion: CATALOG.version },
  });

  console.log(
    `${runtime.created ? "Session angelegt" : "Session wiederaufgenommen"}: ${runtime.session.sessionId}`,
  );
  console.log(`Lauf ${runtime.runtimeId}, Prozess ${process.pid}. Beenden mit Strg+C.`);
  console.log(`Tool-Katalog ${CATALOG.version} mit ${CATALOG.tools.length} Tools.`);

  // Startwerte gelten nur bei der Neuanlage (S04). Eine ältere Session trägt deshalb weiter
  // ihre eigene Version, und dieser Prozess darf sie nicht bedienen. Das laut zu sagen ist
  // besser, als es beim ersten Tool-Aufruf als Ausnahme zu erfahren.
  if (runtime.session.toolCatalogVersion !== CATALOG.version) {
    console.warn(
      `Achtung: Session trägt Tool-Katalog ${runtime.session.toolCatalogVersion}, dieser Prozess hält ${CATALOG.version}. Tool-Aufrufe in dieser Session werden abgewiesen; für den neuen Toolsatz braucht es eine neue Session.`,
    );
  }

  // Es gibt noch keine Schleife, die den Prozess am Leben hielte. Ohne diesen Anker
  // schlösse der Pool nach seinem Leerlauf-Timeout die Verbindungen, der Prozess endete
  // von selbst und runtime.stopped bliebe ungeschrieben.
  const alive = setInterval(() => {}, 60_000);

  async function shutdown(signal: string): Promise<void> {
    clearInterval(alive);
    await runtime.stop(signal);
    await pool.end();
    console.log(`Runtime beendet (${signal}).`);
  }

  for (const signal of SIGNALS) {
    process.on(signal, () => {
      shutdown(signal).catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
