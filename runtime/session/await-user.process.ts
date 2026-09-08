import { ToolRegistry } from "../../tools/registry.js";
import { type ToolRouterDeps, callTool } from "../../tools/router.js";
import { createUserTools } from "../../tools/user/tools.js";
import { createPool } from "../db/pool.js";
import { startRuntime } from "./manager.js";
import { UserInputRequiredError } from "./user-input.js";

/**
 * Ein echter, kurzer Lauf für den Neustart-Nachweis von S10: Runtime aufnehmen, `user.ask`
 * über den Router aufrufen, **sauber** anhalten (kein Absturz, kein offener Schritt,
 * `runtime.stopped` geschrieben) und den Prozess beenden. Ein zweiter Lauf mit `resume`
 * findet die Antwort und läuft durch.
 *
 * Aufruf:
 *   node --import tsx await-user.process.ts <threadId> <channel> <callId> <pause|resume>
 */
const [threadId, channel, callId, mode] = process.argv.slice(2);
if (!threadId || !channel || !callId || (mode !== "pause" && mode !== "resume")) {
  throw new Error("Aufruf: await-user.process.ts <threadId> <channel> <callId> <pause|resume>");
}

const pool = createPool();
const catalog = new ToolRegistry().registerAll(createUserTools({ pool })).freeze();

const runtime = await startRuntime(pool, {
  threadId,
  channel: channel as "web",
  defaults: { toolCatalogVersion: catalog.version },
});

const deps: ToolRouterDeps = {
  pool,
  artifactRoot: "/nicht/benutzt",
  catalog,
  signal: runtime.signal,
};
const call = {
  callId,
  name: "user.ask",
  input: {
    question: "Welche Variante nehmen wir?",
    options: [
      { id: "opt_a", label: "Variante A" },
      { id: "opt_b", label: "Variante B" },
    ],
  },
};

try {
  const result = await callTool(deps, runtime.session, call);
  if (mode === "pause") {
    // Sollte nicht passieren: im pause-Modus erwarten wir den Haltepunkt.
    console.log(`UNEXPECTED ${JSON.stringify(result)}`);
    await runtime.stop("unexpected");
    await pool.end();
    process.exit(1);
  }
  const structured = result.structured as Record<string, unknown>;
  console.log(`ANSWERED ${String(structured.choice)} ${result.status}`);
  await runtime.stop("done");
  await pool.end();
  process.exit(0);
} catch (error) {
  if (error instanceof UserInputRequiredError) {
    // Genau der saubere Haltepunkt: der Lauf ist nicht fehlgeschlagen, er wartet.
    console.log(`PAUSED ${error.askId}`);
    await runtime.stop("awaiting_user");
    await pool.end();
    process.exit(0);
  }
  console.error(error);
  await pool.end();
  process.exit(1);
}
