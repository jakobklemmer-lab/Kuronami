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
 * Seit S16 ist das **nicht mehr der Nutzerweg.** Eine Nachricht kommt über das Gateway
 * (`pnpm gateway`, dann `pnpm say "…"`): dort wird sie authentifiziert, normalisiert und in
 * die Unterhaltung des Nutzers geführt — eine Session auf dem Kanal `gateway`, die Web und
 * Telegram teilen. Dieser Prozess hier bleibt daneben stehen und heißt jetzt, was er ist: ein
 * **Lauf ohne Kanal**, zum Prüfen. Er authentifiziert nichts, normalisiert nichts und arbeitet
 * auf einem eigenen Faden (`KURONAMI_THREAD_ID`, Vorgabe `thread_dev_local`) — also in einem
 * anderen Gedächtnis als die Unterhaltung.
 */
async function main(): Promise<void> {
  const input = process.argv.slice(2).join(" ").trim();
  const pool = createPool();
  const artifactRoot = artifactRootFromEnv();
  // Die Assistenz-Tools über n8n (`mail.*` S14, `cal.*` und `server.metrics` S15) kommen in
  // den Katalog, sobald eine n8n-Instanz hinterlegt ist — ohne sie liefen sie ohnehin nur in
  // eine `N8nUnavailableError`-Hülle. Die `notes.*`-Tools (S15) kommen dazu, sobald ein
  // Obsidian-Vault gesetzt ist. Ist beides leer, bleibt der ausgelieferte Katalog byteweise
  // derselbe wie in jedem anderen Prozess ohne diese beiden Felder (`fs.*`/`web.*`/`task.*`/
  // `user.*`, `memory.*` seit S18, `tool.load` seit S18b).
  const n8nBaseUrl = process.env.N8N_BASE_URL?.trim();
  const obsidianVault = process.env.OBSIDIAN_VAULT_PATH?.trim();
  // Das Langzeitgedächtnis (S18) ist **immer** dabei und hängt an keiner Umgebungsvariablen:
  // es ist kein Anschluss nach draußen wie n8n oder der Vault, sondern ein Teil des Systems,
  // und ein Assistent ohne Gedächtnis ist die schlechtere Vorgabe. `MEMORY_ROOT` verschiebt
  // nur den Ort. Der Ordner wird angelegt, wenn er fehlt — ein leeres Gedächtnis beim ersten
  // Start ist der Normalfall.
  // Skills (S18c) sind wie das Gedächtnis kein Anschluss nach draußen, sondern ein Teil des
  // Systems — `skills/` liegt im Repo und wird immer gescannt, auch wenn sie heute leer ist.
  const { catalog, policy, memory, skills } = await buildCatalog({
    pool,
    artifactRoot,
    n8n: n8nBaseUrl ? { mail: true, cal: true, server: true } : undefined,
    obsidian: obsidianVault ? {} : undefined,
    memory: {},
    skills: {},
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
    memory,
    skills,
  });

  console.log(
    `Direkter Lauf ohne Kanal (Faden ${runner.session.threadId}, Kanal ${runner.session.channel}) — keine Authentifizierung, keine Kanal-Normalisierung. Der Nutzerweg ist "pnpm gateway" plus "pnpm say".`,
  );
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
  // Die n8n- und Obsidian-Lage beim Start sichtbar sagen (S13/S14/S15): ob eine Instanz bzw.
  // ein Vault hinterlegt ist und welche Assistenz-Tools dadurch im Katalog stehen.
  const assistCount = (prefix: string): number =>
    catalog.tools.filter((tool) => tool.name.startsWith(prefix)).length;
  console.log(
    `n8n-Brücke: ${
      n8nBaseUrl
        ? `${n8nBaseUrl}${process.env.N8N_WEBHOOK_TOKEN?.trim() ? ", Token gesetzt" : ""}`
        : "nicht konfiguriert (N8N_BASE_URL leer)"
    }, ${assistCount("mail.")} Mail-, ${assistCount("cal.")} Kalender-, ${assistCount("server.")} Server-Tools im Katalog.`,
  );
  console.log(
    `Obsidian-Vault: ${obsidianVault ?? "nicht konfiguriert (OBSIDIAN_VAULT_PATH leer)"}, ${assistCount("notes.")} notes.*-Tools im Katalog.`,
  );
  console.log(
    `Langzeitgedächtnis: ${memory?.root ?? "—"}, ${memory?.count() ?? 0} Notizen, Git ${
      memory?.gitEnabled ? "an" : "aus (kein Repo)"
    }, ${assistCount("memory.")} memory.*-Tools im Katalog.`,
  );
  console.log(
    `Skills: ${skills?.root ?? "—"}, ${skills?.skills.length ?? 0} geladen, ${assistCount("skill.")} skill.*-Tools im Katalog.`,
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
    // Wer den Store geöffnet hat, schließt ihn — dasselbe Eigentumsmuster wie beim Pool (S03).
    memory?.close();
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
