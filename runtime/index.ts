import { buildFsZones } from "../tools/fs/paths.js";
import { createFsTools } from "../tools/fs/tools.js";
import { ToolRegistry } from "../tools/registry.js";
import { buildEgressPolicy } from "../tools/web/egress.js";
import { createWebTools } from "../tools/web/tools.js";
import { artifactRootFromEnv } from "./artifacts/store.js";
import { createPool } from "./db/pool.js";
import { type SessionChannel, startRuntime } from "./session/manager.js";

const SIGNALS = ["SIGINT", "SIGTERM"] as const;

/**
 * Das Skelett bedient eine Session und tut sonst nichts. Woher Faden und Kanal wirklich
 * kommen, entscheidet das Gateway (S16); bis dahin genügt die Umgebung mit festen Werten
 * für den Entwicklungsrechner.
 */
async function main(): Promise<void> {
  const pool = createPool();
  const artifactRoot = artifactRootFromEnv();

  // Der Tool-Katalog dieses Prozesses. Seit S08 trägt er die fünf `fs.*`-Kern-Primitive, seit
  // S09 dazu `web.search` und `web.fetch`. Die Version geht als Startwert in die Session
  // (S07) — eine Session weiß damit von Anfang an, unter welchem Tool-Vertrag sie eröffnet
  // wurde.
  // Zwei Zonen: die Quellzone ist der Arbeitsordner des Prozesses, die Artefaktzone der
  // ARTIFACT_ROOT. Ein `fs.*`-Pfad außerhalb beider wird abgewiesen (S08, Abschnitt 4.7).
  const zones = await buildFsZones({ sourceRoot: process.cwd(), artifactRoot });

  // Egress ist deny-by-default: ohne freigegebene Hosts in WEB_EGRESS_ALLOWLIST ruft
  // `web.fetch`/`web.search` nichts ab (S09, Abschnitt 4.7). Ein Suchanbieter ist noch
  // nicht verdrahtet — `web.search` meldet bis dahin eine Fehlerhülle (n8n-Bridge, S13).
  const egress = buildEgressPolicy({
    allowlist: (process.env.WEB_EGRESS_ALLOWLIST ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  });

  const catalog = new ToolRegistry()
    .registerAll(createFsTools({ pool, artifactRoot, zones }))
    .registerAll(createWebTools({ pool, artifactRoot, egress }))
    .freeze();

  const runtime = await startRuntime(pool, {
    threadId: process.env.KURONAMI_THREAD_ID ?? "thread_dev_local",
    channel: (process.env.KURONAMI_CHANNEL as SessionChannel | undefined) ?? "web",
    defaults: { toolCatalogVersion: catalog.version },
  });

  console.log(
    `${runtime.created ? "Session angelegt" : "Session wiederaufgenommen"}: ${runtime.session.sessionId}`,
  );
  console.log(`Lauf ${runtime.runtimeId}, Prozess ${process.pid}. Beenden mit Strg+C.`);
  console.log(`Tool-Katalog ${catalog.version} mit ${catalog.tools.length} Tools.`);

  // Startwerte gelten nur bei der Neuanlage (S04). Eine ältere Session trägt deshalb weiter
  // ihre eigene Version, und dieser Prozess darf sie nicht bedienen. Das laut zu sagen ist
  // besser, als es beim ersten Tool-Aufruf als Ausnahme zu erfahren.
  if (runtime.session.toolCatalogVersion !== catalog.version) {
    console.warn(
      `Achtung: Session trägt Tool-Katalog ${runtime.session.toolCatalogVersion}, dieser Prozess hält ${catalog.version}. Tool-Aufrufe in dieser Session werden abgewiesen; für den neuen Toolsatz braucht es eine neue Session.`,
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
