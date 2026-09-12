import { artifactRootFromEnv } from "../artifacts/store.js";
import { createPool } from "../db/pool.js";
import { buildCatalog } from "../loop/api.js";
import { createOrResumeSession } from "../session/manager.js";
import { FIRST_CASTING, seedFirstCasting } from "./besetzung.js";

/**
 * `pnpm agents:seed` — legt die erste Besetzung an (S20).
 *
 * Ein eigener Einstiegspunkt und keine Migration: die sieben Profile werden gegen den echten
 * Tool-Katalog geprüft, bevor sie in die Registry gehen (siehe `besetzung.ts`). Der Lauf ist
 * idempotent; `--dry-run` prüft nur.
 *
 * **Der Katalog hier ist der größtmögliche**, nicht der eines bestimmten Betriebsmodus: die
 * Registry ist prozessunabhängig, und ob ein konkreter Prozess einen Agenten wirklich laufen
 * lassen kann, entscheidet sich erst beim Lauf (`runWorker` sagt dann, welches Werkzeug ihm
 * fehlt). Die Assistenz-Tools über n8n kommen deshalb auch ohne erreichbare Instanz in den
 * Katalog — ob der Webhook antwortet, ist eine Frage der Laufzeit und keine der Registrierung.
 * `notes.*` bleibt draußen, weil `buildCatalog` dafür einen vorhandenen Vault verlangt; kein
 * Profil der Besetzung nennt es.
 */

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const pool = createPool();
  const artifactRoot = artifactRootFromEnv();

  try {
    const { catalog } = await buildCatalog({
      pool,
      artifactRoot,
      n8n: { mail: true, cal: true, server: true },
      memory: {},
      skills: {},
    });

    // Die Buchführungs-Session der Besetzung: hier stehen die `agent.created`-Ereignisse, also
    // die Herkunft jeder Zeile. Ein fester Faden, damit ein zweiter Lauf dieselbe Session
    // wiederfindet und die Historie zusammenbleibt.
    const { session } = await createOrResumeSession(pool, {
      threadId: "thread_agents_besetzung",
      channel: "web",
      defaults: { mode: "seed", toolCatalogVersion: catalog.version },
    });

    const report = await seedFirstCasting(pool, session.sessionId, { catalog, dryRun });

    console.log(
      `Besetzung (${FIRST_CASTING.length} Rollen) gegen Katalog ${catalog.version} mit ${catalog.tools.length} Tools${dryRun ? " — Probelauf, nichts geschrieben" : ""}.`,
    );
    for (const profile of report.created) {
      console.log(
        `  angelegt   ${profile.name.padEnd(16)} ${profile.model}, ${profile.tools.length} Werkzeuge, ${profile.maxRisk}, ${profile.maxSteps} Schritte, ${profile.tokenBudget ?? "kein"} Token`,
      );
    }
    if (dryRun) {
      for (const name of report.validated) console.log(`  geprüft    ${name}`);
    }
    for (const name of report.existing) console.log(`  vorhanden  ${name}`);
    for (const skipped of report.skipped) {
      console.log(`  ausgelassen ${skipped.name}: ${skipped.reason}`);
    }
    if (report.skipped.length > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
