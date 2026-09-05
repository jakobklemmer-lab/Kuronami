import { createPool } from "../db/pool.js";
import { beginStep } from "../steps/hull.js";

/**
 * Ein Prozess, der einen Schritt beginnt und dann darauf wartet, abgeschossen zu werden.
 *
 * Er existiert, weil ein abgestürzter Lauf sich innerhalb eines Testprozesses nicht ehrlich
 * nachstellen lässt: dort liefe immer noch ein `finally`, ein Signalbehandler oder wenigstens
 * die Möglichkeit dazu. Hier läuft nichts mehr. Nach `beginStep` hat der Checkpoint vor dem
 * Seiteneffekt stattgefunden, der danach nie — genau die Lücke, die die Wiederaufnahme
 * auflösen muss.
 *
 * Aufruf: node --import tsx crash-mid-step.process.ts <session_id> <key> <repeatable>
 */
const [sessionId, idempotencyKey, repeatable] = process.argv.slice(2);
if (!sessionId || !idempotencyKey) {
  throw new Error("Aufruf: crash-mid-step.process.ts <session_id> <idempotency_key> <repeatable>");
}

const pool = createPool();
const claim = await beginStep(pool, {
  sessionId,
  idempotencyKey,
  kind: "tool_call",
  toolName: "dummy.effect",
  repeatable: repeatable === "true",
});

// Das Stichwort, auf das der Test wartet: ab hier ist der Schritt offen.
console.log(`BEGUN ${claim.step.stepId}`);

// Kein Signalbehandler, kein Aufräumen, kein pool.end(). Der Prozess hält sich nur am
// Leben, bis er von außen beendet wird.
setInterval(() => {}, 1_000);
