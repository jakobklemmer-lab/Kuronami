import type { Server } from "node:http";
import { createTelegramClient } from "../gateway/channels/telegram/client.js";
import { artifactRootFromEnv } from "../runtime/artifacts/store.js";
import { createPool } from "../runtime/db/pool.js";
import { buildCatalog } from "../runtime/loop/api.js";
import { createAnthropicClient } from "../runtime/model/anthropic.js";
import { heartbeatConfigFromEnv } from "./config.js";
import { consoleDigestChannel, telegramDigestChannel } from "./delivery.js";
import type { DigestChannel } from "./delivery.js";
import { createHeartbeatServer } from "./server.js";
import { createHeartbeat } from "./service.js";

/**
 * Der Heartbeat-Prozess (S17).
 *
 * Eigener Prozess, eigener Einstiegspunkt, eigenes `pnpm heartbeat` — wie das Gateway. Er
 * benutzt die Runtime als Bibliothek und wird von ihr nie importiert (`layering.test.ts`).
 *
 * Was er baut: einen **Hintergrundkatalog** (`profile: "background"` — engere Whitelist,
 * `BACKGROUND_RULES` in der Policy), einen Kanal für die Zustellung und den Dienst mit
 * Zeitplan. Was er nicht tut: selbst ausführen. Das macht der Loop, in einer Session auf dem
 * Kanal `heartbeat`.
 */

const SIGNALS = ["SIGINT", "SIGTERM"] as const;

async function main(): Promise<void> {
  const config = heartbeatConfigFromEnv();
  const pool = createPool();
  const artifactRoot = artifactRootFromEnv();

  const n8nBaseUrl = process.env.N8N_BASE_URL?.trim();
  const obsidianVault = process.env.OBSIDIAN_VAULT_PATH?.trim();
  const { catalog, policy } = await buildCatalog({
    pool,
    artifactRoot,
    profile: "background",
    n8n: n8nBaseUrl ? { mail: true, cal: true, server: true } : undefined,
    obsidian: obsidianVault ? {} : undefined,
  });

  // Ohne Modell kann der Heartbeat keinen Digest schreiben — ein Start ohne Anbieter ist
  // sinnlos, genau wie beim Gateway.
  const model = createAnthropicClient();

  let channel: DigestChannel;
  if (config.channel === "telegram") {
    const client = createTelegramClient({ token: process.env.TELEGRAM_BOT_TOKEN?.trim() });
    channel = telegramDigestChannel({ client, chatId: config.deliverTo });
  } else {
    channel = consoleDigestChannel();
  }

  const heartbeat = await createHeartbeat({
    pool,
    artifactRoot,
    catalog,
    policy,
    model,
    channel,
    maxRunsPerDay: config.maxRunsPerDay,
    digestCron: config.digestCron,
    pollMs: config.pollSeconds * 1000,
  });

  const app = createHeartbeatServer({
    heartbeat,
    notifySecret: config.notifySecret,
    nextDigest: () => heartbeat.nextDigest(),
  });
  const server: Server = app.listen(config.port, () => {
    console.log(`[heartbeat] http://localhost:${config.port}`);
  });

  const next = heartbeat.nextDigest();
  console.log(
    `Digest-Zeitplan "${config.digestCron.source}", nächster Lauf ${next ? next.toISOString() : "—"}.`,
  );
  console.log(
    `Kanal ${channel.id}${channel.id === "telegram" ? ` → ${config.deliverTo}` : ""}, Tagesobergrenze ${config.maxRunsPerDay}.`,
  );
  console.log(
    `Hintergrundkatalog ${catalog.version} mit ${catalog.tools.length} Tools, Policy ${policy.rules.length} Regeln, Modell ${model.model}.`,
  );
  console.log(
    `POST /notify ${config.notifySecret ? "aktiv" : "aus (HEARTBEAT_NOTIFY_SECRET leer)"}, Diarium-Session ${heartbeat.diarySessionId}.`,
  );

  heartbeat.start();

  let stopped = false;
  async function shutdown(reason: string): Promise<void> {
    if (stopped) return;
    stopped = true;
    console.log(`\n[heartbeat] ${reason} — herunterfahren.`);
    heartbeat.stop();
    server.close();
    await pool.end().catch(() => undefined);
    console.log("[heartbeat] beendet.");
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
