import path from "node:path";
import { createPool } from "../runtime/db/pool.js";
import { startRuntime } from "../runtime/session/manager.js";
import { buildFsZones, policyResolver } from "../tools/fs/paths.js";
import { createFsTools } from "../tools/fs/tools.js";
import { ToolRegistry } from "../tools/registry.js";
import { type ToolRouterDeps, callTool } from "../tools/router.js";
import { ApprovalRequiredError } from "./approvals.js";
import { createPolicyEngine } from "./engine.js";

/**
 * Ein echter, kurzer Lauf für den Nachweis, dass eine **sessiongebundene Freigabe** einen
 * Prozessneustart überlebt (Abschnitt 10: "Freigaben der Form 'für diese Session erlauben'
 * werden gespeichert und bei Wiederaufnahme wiederhergestellt").
 *
 * Der Punkt ist der eigene Betriebssystem-Prozess, nicht ein zweiter Testlauf im selben
 * Modul: nur so lässt sich ausschließen, dass die Freigabe aus einem Speicher im Prozess
 * kommt. Dieser Prozess kennt beim Start nichts als Faden, Kanal und Pfad — alles Weitere
 * liest er aus der Datenbank. Dasselbe Vorgehen wie `crash-mid-step.process.ts` (S05) und
 * `await-user.process.ts` (S10).
 *
 * Aufruf:
 *   node --import tsx policy/policy-resume.process.ts <threadId> <channel> <callId> <sourceRoot> <relPfad>
 *
 * Ausgabe: `PAUSED <askId>` (Freigabe fehlt) oder `WROTE <pfad>` (Freigabe gefunden).
 */
const [threadId, channel, callId, sourceRoot, relPath] = process.argv.slice(2);
if (!threadId || !channel || !callId || !sourceRoot || !relPath) {
  throw new Error(
    "Aufruf: policy-resume.process.ts <threadId> <channel> <callId> <sourceRoot> <relPfad>",
  );
}

const pool = createPool();
const artifactRoot = path.join(sourceRoot, "artifacts");
const zones = await buildFsZones({ sourceRoot, artifactRoot });
const catalog = new ToolRegistry()
  .registerAll(createFsTools({ pool, artifactRoot, zones }))
  .freeze();

const runtime = await startRuntime(pool, {
  threadId,
  channel: channel as "web",
  defaults: { toolCatalogVersion: catalog.version },
});

const deps: ToolRouterDeps = {
  pool,
  artifactRoot,
  catalog,
  policy: createPolicyEngine({ resolvePath: policyResolver(zones) }),
  signal: runtime.signal,
};

try {
  const result = await callTool(deps, runtime.session, {
    callId,
    name: "fs.write",
    origin: "direct",
    input: { path: relPath, content: `geschrieben von pid ${process.pid}` },
  });
  console.log(`WROTE ${result.status} ${relPath}`);
  await runtime.stop("done");
  await pool.end();
  process.exit(0);
} catch (error) {
  if (error instanceof ApprovalRequiredError) {
    // Der saubere Haltepunkt: nicht fehlgeschlagen, sondern wartend.
    console.log(`PAUSED ${error.askId}`);
    await runtime.stop("awaiting_approval");
    await pool.end();
    process.exit(0);
  }
  console.error(error);
  await pool.end();
  process.exit(1);
}
