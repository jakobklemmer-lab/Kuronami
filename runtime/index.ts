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
  const runtime = await startRuntime(pool, {
    threadId: process.env.KURONAMI_THREAD_ID ?? "thread_dev_local",
    channel: (process.env.KURONAMI_CHANNEL as SessionChannel | undefined) ?? "web",
  });

  console.log(
    `${runtime.created ? "Session angelegt" : "Session wiederaufgenommen"}: ${runtime.session.sessionId}`,
  );
  console.log(`Lauf ${runtime.runtimeId}, Prozess ${process.pid}. Beenden mit Strg+C.`);

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
