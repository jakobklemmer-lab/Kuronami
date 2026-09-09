import { formatRunMetrics } from "../context/metrics.js";
import { artifactRootFromEnv } from "./artifacts/store.js";
import { createPool } from "./db/pool.js";
import { buildCatalog, createRunner } from "./loop/api.js";
import { MissingApiKeyError, createAnthropicClient } from "./model/anthropic.js";
import type { SessionChannel } from "./session/manager.js";

const SIGNALS = ["SIGINT", "SIGTERM"] as const;

/**
 * Der Runtime-Prozess. Seit S12 kann er zweierlei:
 *
 *   * **ohne Argument** — Session aufnehmen, Lage ausgeben, auf ein Signal warten. Das ist
 *     das Skelett aus S04 und weiterhin der Weg, eine Session zu eröffnen, an der dann von
 *     außen gearbeitet wird.
 *   * **mit einer Eingabe als Argument** — die Plan-Handeln-Prüfen-Schleife über genau diese
 *     Eingabe laufen lassen und mit dem Ergebnis enden. Das ist die "kleine API-Oberfläche,
 *     um Läufe ohne UI anzustoßen" (S12) in ihrer knappsten Form; die Verben selbst stehen in
 *     `loop/api.ts` und sind nicht an diesen Prozess gebunden.
 *
 * Woher Faden und Kanal wirklich kommen, entscheidet weiterhin das Gateway (S16).
 */
async function main(): Promise<void> {
  const input = process.argv.slice(2).join(" ").trim();
  const pool = createPool();
  const artifactRoot = artifactRootFromEnv();
  // Die Mail-Tools (S14) kommen in den Katalog, sobald eine n8n-Instanz hinterlegt ist —
  // ohne sie liefen sie ohnehin nur in eine `N8nUnavailableError`-Hülle. Ohne `N8N_BASE_URL`
  // bleibt der ausgelieferte Katalog byteweise der aus S12/S13 (`v1-53a18ba0cb4e49c8`).
  const n8nBaseUrl = process.env.N8N_BASE_URL?.trim();
  const { catalog, policy } = await buildCatalog({
    pool,
    artifactRoot,
    n8n: n8nBaseUrl ? { mail: true } : undefined,
  });

  // Ohne Eingabe wird kein Modell gebraucht, und ein fehlender Schlüssel darf das Skelett
  // nicht am Starten hindern: eine Session eröffnen, ihren Zustand ansehen oder eine
  // Rückfrage beantworten geht ohne Anbieter.
  const model = input
    ? createAnthropicClient()
    : (tryCreateModel() ?? {
        model: "kein Modell (ANTHROPIC_API_KEY fehlt)",
        complete: async () => {
          throw new MissingApiKeyError("ANTHROPIC_API_KEY ist nicht gesetzt.");
        },
      });

  const runner = await createRunner({
    pool,
    threadId: process.env.KURONAMI_THREAD_ID ?? "thread_dev_local",
    channel: (process.env.KURONAMI_CHANNEL as SessionChannel | undefined) ?? "web",
    artifactRoot,
    catalog,
    policy,
    model,
  });

  console.log(
    `Session ${runner.session.sessionId}, Lauf ${runner.runtimeId}, Prozess ${process.pid}.`,
  );
  console.log(
    `Tool-Katalog ${catalog.version} mit ${catalog.tools.length} Tools, Modell ${model.model}.`,
  );
  // Die Governance-Lage gehört beim Start sichtbar gesagt. Ein Betreiber, der nicht weiß, in
  // welchem Freigabemodus seine Session läuft und ob die Sandbox-Ausnahme greift, kann eine
  // Rückfrage später nicht einordnen — und ihr Ausbleiben schon gar nicht.
  console.log(
    `Policy: ${policy.rules.length} Regeln, ${policy.hooks.length} Hooks, Freigabemodus ${runner.session.approvalMode}, Sandbox ${
      policy.sandbox.active ? "nachgewiesen" : `nicht nachgewiesen (${policy.sandbox.reason})`
    }.`,
  );
  // Die n8n-Lage beim Start sichtbar sagen (S13/S14): ob eine Instanz hinterlegt ist und wie
  // viele Mail-Tools dadurch im Katalog stehen.
  const mailToolCount = catalog.tools.filter((tool) => tool.name.startsWith("mail.")).length;
  console.log(
    `n8n-Brücke: ${
      n8nBaseUrl
        ? `${n8nBaseUrl}${process.env.N8N_WEBHOOK_TOKEN?.trim() ? ", Token gesetzt" : ""}`
        : "nicht konfiguriert (N8N_BASE_URL leer)"
    }, ${mailToolCount} Mail-Tools im Katalog.`,
  );

  // Startwerte gelten nur bei der Neuanlage (S04). Eine ältere Session trägt deshalb weiter
  // ihre eigene Version, und dieser Prozess darf sie nicht bedienen.
  if (runner.session.toolCatalogVersion !== catalog.version) {
    console.warn(
      `Achtung: Session trägt Tool-Katalog ${runner.session.toolCatalogVersion}, dieser Prozess hält ${catalog.version}. Tool-Aufrufe in dieser Session werden abgewiesen; für den neuen Toolsatz braucht es eine neue Session.`,
    );
  }

  // Ohne diesen Anker schlösse der Pool nach seinem Leerlauf-Timeout die Verbindungen, der
  // Prozess endete von selbst und runtime.stopped bliebe ungeschrieben (S04). Er wird beim
  // Herunterfahren gelöscht — bliebe er stehen, hinge der Prozess nach einem sauberen Stop
  // ewig weiter, und das Skelett wäre nicht mehr zu beenden.
  const alive = setInterval(() => {}, 60_000);
  let stopped = false;
  async function shutdown(reason: string): Promise<void> {
    if (stopped) return;
    stopped = true;
    clearInterval(alive);
    await runner.stop(reason);
    await pool.end();
    console.log(`Runtime beendet (${reason}).`);
  }

  for (const signal of SIGNALS) {
    process.on(signal, () => {
      shutdown(signal).catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    });
  }

  if (!input) {
    console.log("Keine Eingabe übergeben. Beenden mit Strg+C.");
    return;
  }

  const result = await runner.run(input);
  console.log(`\n--- ${result.stop}: ${result.reason}`);
  if (result.text) console.log(result.text);
  for (const pending of result.pendingUserInput) {
    console.log(
      `Offen (${pending.askId}): ${pending.question} — ${pending.options.map((option) => `${option.id}=${option.label}`).join(", ")}`,
    );
  }
  console.log(formatRunMetrics(result.metrics));
  await shutdown(result.stop);
}

function tryCreateModel(): ReturnType<typeof createAnthropicClient> | undefined {
  try {
    return createAnthropicClient();
  } catch (error) {
    if (error instanceof MissingApiKeyError) return undefined;
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
