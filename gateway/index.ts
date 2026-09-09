import type { Server } from "node:http";
import { artifactRootFromEnv } from "../runtime/artifacts/store.js";
import { createPool } from "../runtime/db/pool.js";
import { buildCatalog } from "../runtime/loop/api.js";
import { createAnthropicClient } from "../runtime/model/anthropic.js";
import { createTelegramChannel, startTelegramPolling } from "./channels/telegram/channel.js";
import type { TelegramChannelDeps } from "./channels/telegram/channel.js";
import { createTelegramClient } from "./channels/telegram/client.js";
import { createWebChannel } from "./channels/web.js";
import { createConversations } from "./conversation.js";
import { type GatewayDeps, redeliverPending } from "./core.js";
import { configuredChannels, identityFromEnv } from "./identity.js";
import { createServer } from "./server.js";
import type { ChannelId, ChannelPort } from "./types.js";

/**
 * Der Gateway-Prozess (S16).
 *
 * **Ein eigener Prozess, nicht in die Runtime eingebaut** — das ist der erste Punkt des
 * Auftrags, und er meint zweierlei:
 *
 *   * `runtime/index.ts` weiß nichts von dieser Datei. Es gibt keinen Import aus `gateway/`
 *     in `runtime/`, `context/`, `tools/` oder `policy/`, und `gateway/layering.test.ts`
 *     prüft das über den ganzen Quellbaum. Die harte Regel aus Abschnitt 3 ("die Runtime darf
 *     niemals von der Surface-Schicht abhängen") ist damit nicht eine Zusage, sondern ein Test.
 *   * Dieser Prozess hat einen eigenen Lebenslauf: eigener Einstiegspunkt, eigener Port,
 *     eigenes `pnpm gateway`. Er lässt sich beenden, ohne dass an der Runtime etwas fehlt, und
 *     die Runtime lässt sich ohne ihn betreiben (`pnpm run:task`).
 *
 * Dass er die Runtime **als Bibliothek** benutzt, ist kein Widerspruch, sondern die Richtung,
 * die Abschnitt 3 vorschreibt: Surface zeigt auf Runtime, nie umgekehrt. Was das Gateway
 * gerade nicht tut, ist selbst ausführen: es hält keinen Zustand über einen Lauf, kennt keine
 * Schritte und keine Freigaberegeln. Es normalisiert, authentifiziert, ordnet zu.
 */

const SIGNALS = ["SIGINT", "SIGTERM"] as const;

async function main(): Promise<void> {
  const identity = identityFromEnv();
  const available = configuredChannels(identity);
  if (available.length === 0) {
    // Ein Gateway ohne bedienbaren Kanal ist ein Port, der auf nichts hört. Lieber hier
    // abbrechen als später schweigen: die Ursache steht dann in der ersten Zeile und nicht in
    // der Frage, warum eine Nachricht nie ankommt.
    throw new Error(
      "Kein Kanal ist eingerichtet. Setze GATEWAY_WEB_TOKEN (Web) und/oder TELEGRAM_ALLOWED_USER_IDS plus TELEGRAM_BOT_TOKEN (Telegram).",
    );
  }

  const pool = createPool();
  const artifactRoot = artifactRootFromEnv();
  const n8nBaseUrl = process.env.N8N_BASE_URL?.trim();
  const obsidianVault = process.env.OBSIDIAN_VAULT_PATH?.trim();
  const { catalog, policy } = await buildCatalog({
    pool,
    artifactRoot,
    n8n: n8nBaseUrl ? { mail: true, cal: true, server: true } : undefined,
    obsidian: obsidianVault ? {} : undefined,
  });

  // Ohne Modell kann das Gateway keine Nachricht beantworten. Anders als beim Runtime-Skelett
  // (das auch ohne Schlüssel eine Session eröffnen können soll) ist ein Start ohne Anbieter
  // hier sinnlos — er endete bei der ersten Nachricht in einem Fehler statt beim Start.
  const model = createAnthropicClient();

  const conversations = createConversations({ pool, artifactRoot, catalog, policy, model });
  const web = createWebChannel();
  const channels = new Map<ChannelId, ChannelPort>([["web", web]]);

  const gateway: GatewayDeps = { pool, artifactRoot, conversations, channels };

  const telegramToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  let telegram: TelegramChannelDeps | undefined;
  if (available.includes("telegram")) {
    if (!telegramToken) {
      throw new Error(
        "TELEGRAM_ALLOWED_USER_IDS ist gesetzt, aber TELEGRAM_BOT_TOKEN fehlt — der Kanal könnte annehmen, aber nichts zustellen.",
      );
    }
    const client = createTelegramClient({ token: telegramToken });
    telegram = { client, identity, gateway };
    channels.set("telegram", createTelegramChannel(telegram));
  }

  const port = Number(process.env.GATEWAY_PORT ?? 8788);
  const app = createServer({ gateway, identity, web, telegram });
  const server: Server = app.listen(port, () => {
    console.log(`[gateway] http://localhost:${port} — Kanäle: ${[...channels.keys()].join(", ")}`);
  });

  console.log(
    `Nutzer ${identity.userId}, Tool-Katalog ${catalog.version} mit ${catalog.tools.length} Tools, Modell ${model.model}.`,
  );
  console.log(
    `Policy: ${policy.rules.length} Regeln, ${policy.hooks.length} Hooks, Sandbox ${
      policy.sandbox.active ? "nachgewiesen" : `nicht nachgewiesen (${policy.sandbox.reason})`
    }.`,
  );

  // Was beim letzten Lauf offen blieb und nie hinausging, geht jetzt hinaus. Ohne diesen
  // Schritt wartete ein Lauf, dessen Freigabeanfrage beim Herunterfahren zwischen Protokoll
  // und Zustellung stand, für immer auf eine Antwort, die niemand geben kann.
  const conversation = await conversations.of(identity.userId);
  console.log(`Unterhaltung: Session ${conversation.runner.session.sessionId}.`);
  const pending = await redeliverPending(gateway, conversation);
  if (pending.length > 0) {
    console.log(`${pending.length} offene Rückfrage(n) nachgestellt.`);
  }

  const polling =
    telegram && process.env.TELEGRAM_MODE?.trim() !== "webhook"
      ? startTelegramPolling(telegram, {
          onResult: (result) => {
            if (result.kind !== "handled") {
              console.log(`[gateway] Telegram-Update ${result.kind}: ${result.reason}`);
              return;
            }
            console.log(`[gateway] Telegram: ${result.outcome.status} — ${result.outcome.reason}`);
          },
          onError: (error) => console.error("[gateway] Telegram-Polling:", error),
        })
      : undefined;
  if (polling) console.log("Telegram: Long-Polling läuft.");
  else if (telegram) console.log("Telegram: Webhook-Betrieb (POST /channels/telegram/webhook).");

  let stopped = false;
  async function shutdown(reason: string): Promise<void> {
    if (stopped) return;
    stopped = true;
    console.log(`\n[gateway] ${reason} — herunterfahren.`);
    polling?.stop();
    await polling?.done.catch(() => undefined);
    server.close();
    // `stopAll` schreibt je Läufer ein `runtime.stopped`. Ein übersehener Läufer hinterlässt
    // ein `runtime.started` ohne Gegenstück — seit S04 das Kennzeichen eines Absturzes.
    await conversations.stopAll(reason);
    await pool.end().catch(() => undefined);
    console.log("[gateway] beendet.");
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
