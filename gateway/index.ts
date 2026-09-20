import type { Server } from "node:http";
import { artifactRootFromEnv } from "../runtime/artifacts/store.js";
import { createPool } from "../runtime/db/pool.js";
import { attachEventSocket, eventBus } from "../runtime/events/bus.js";
import { startEventNotifyListener } from "../runtime/events/notify.js";
import { envFilePathFromEnv, readEnvFile, writeEnvFile } from "../runtime/secrets/env-file.js";
import { buildMemoryRoot, createMemoryStore } from "../tools/memory/store.js";
import { createN8nBridge } from "../tools/n8n/bridge.js";
import { KuroAgent } from "./agent.js";
import { SITZUNG_GUELTIG_MS, anmeldungAusUmgebung } from "./anmeldung.js";
import { createSlackChannel } from "./channels/slack/channel.js";
import type { SlackChannelDeps } from "./channels/slack/channel.js";
import { createSlackClient } from "./channels/slack/client.js";
import { createTelegramChannel, startTelegramPolling } from "./channels/telegram/channel.js";
import type { TelegramChannelDeps } from "./channels/telegram/channel.js";
import { createTelegramClient } from "./channels/telegram/client.js";
import { type VoiceChannel, createVoiceChannel } from "./channels/voice/channel.js";
import { createWebChannel } from "./channels/web.js";
import { type GatewayDeps, redeliverPending } from "./core.js";
import { configuredChannels, identityFromEnv } from "./identity.js";
import { createYahooMarkets } from "./integrations/markets.js";
import { createSystemSampler } from "./integrations/system.js";
import { haltePostfaecherWarm, konten } from "./postfach.js";
import { createSystemdRestart } from "./restart.js";
import { sandkastenLage } from "./sandkasten.js";
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

/**
 * Wie ein Zug abgerechnet wird.
 *
 * Ohne `ANTHROPIC_API_KEY` meldet sich Claude Code mit der Anmeldung aus
 * `~/.claude/.credentials.json` an — bei Jakob ein Pro-Abo. Das SDK rechnet die Token
 * trotzdem in Dollar um, aber diese Zahl ist dann eine **Schätzung des Verbrauchs** und keine
 * Rechnung. Sie so hinzuschreiben, als koste sie Geld, wäre irreführend: sie zählt gegen das
 * Nutzungslimit des Abos, nicht gegen ein Guthaben.
 */
function abrechnung(usd: number): string {
  return process.env.ANTHROPIC_API_KEY?.trim()
    ? `$${usd.toFixed(4)}`
    : `~$${usd.toFixed(4)} (Abo, nicht berechnet)`;
}

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
  // Ohne Modell kann das Gateway keine Nachricht beantworten. Anders als beim Runtime-Skelett
  // (das auch ohne Schlüssel eine Session eröffnen können soll) ist ein Start ohne Anbieter
  // hier sinnlos — er endete bei der ersten Nachricht in einem Fehler statt beim Start.
  // Der Client steht seit S19 **vor** `buildCatalog`: `agent.create` entwirft sein Profil mit
  // einem Modellaufruf, und der Katalogbau bekommt den Client übergeben, statt einen zu bauen.
  const web = createWebChannel();
  const channels = new Map<ChannelId, ChannelPort>([["web", web]]);

  // Der Motor (Motorwechsel 2026-09-18): Claude Code als Bibliothek statt der selbstgebauten
  // Agentenschleife. Was hier vorher stand — Modell-Client, MCP-Entdeckung, `buildCatalog` mit
  // Werkzeugkatalog und Policy, `createConversations` mit Kompaktierungs- und Offload-Schwellen
  // — bringt das Agent-SDK mit, und zwar samt Kontextkompaktierung und funktionierendem
  // Prompt-Caching. Die alte Fassung steht in `archiv/eigener-motor`.
  const agent = new KuroAgent({
    channels,
    // Streaming an die Oberfläche: dieselben flüchtigen `model.delta`-Ereignisse wie zuvor,
    // damit die Ansicht ohne Änderung live mitschreibt.
    onDelta: (text, turnId) =>
      eventBus.publish({
        type: "model.delta",
        timestamp: new Date().toISOString(),
        // `turn_id` stand hier bis 2026-09-20 leer. Wer mitliest, konnte damit nicht sehen,
        // wo ein Zug aufhört und der nächste anfängt — und hängte alles aneinander.
        data: { session_id: agent.sessionId ?? "", turn_id: turnId, text },
      }),
    // Kosten pro Zug, sichtbar statt geschätzt. Das war der Anlass für den Wechsel.
    // Ereignisse für die Präsenz-Oberfläche — dieselbe Leitung wie die Textstücke.
    publish: (type, data) => eventBus.publish({ type, timestamp: new Date().toISOString(), data }),
    onUsage: (u) =>
      console.log(
        `[gateway] Zug: ${(u.dauerMs / 1000).toFixed(1)}s, ${u.zuege} Schritte, ` +
          `${u.eingabe} neu + ${u.cacheGelesen} gelesen + ${u.cacheGeschrieben} geschrieben, ` +
          `${u.ausgabe} raus, ${abrechnung(u.kostenUsd)}`,
      ),
  });
  await agent.start();

  // Das Langzeitgedächtnis hängt **nicht** am Motor: die Oberfläche liest es für die Notiz-
  // und Dateikarten (`/integrations/notes`, `/integrations/files`). Vorher kam es aus
  // `buildCatalog`, jetzt direkt — derselbe Bestand, ein Verbraucher weniger.
  const memory = await createMemoryStore({ root: await buildMemoryRoot(undefined) });

  const gateway: GatewayDeps = { pool, artifactRoot, agent, channels };

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

  const slackToken = process.env.SLACK_BOT_TOKEN?.trim();
  let slack: SlackChannelDeps | undefined;
  if (available.includes("slack")) {
    if (!slackToken) {
      throw new Error(
        "SLACK_ALLOWED_USER_IDS ist gesetzt, aber SLACK_BOT_TOKEN fehlt — der Kanal könnte annehmen, aber nichts zustellen.",
      );
    }
    if (!identity.slackSigningSecret) {
      throw new Error(
        "SLACK_ALLOWED_USER_IDS ist gesetzt, aber SLACK_SIGNING_SECRET fehlt — ohne Signaturprüfung nimmt der Kanal nichts an.",
      );
    }
    const client = createSlackClient({ token: slackToken });
    slack = { client, identity, gateway, pendingByTs: new Map() };
    channels.set("slack", createSlackChannel(slack));
  }

  // Der Sprach-Kanal (S30). Er braucht keinen Client nach draußen — die Gegenstelle ruft **uns**
  // an (`voice/pipeline/gateway.py`), und was hinausgeht, liegt solange im Postfach. Deshalb
  // reicht hier der Token als Schalter; ein fehlender Sprachprozess ist kein Startfehler,
  // sondern nur ein Postfach, das niemand leert.
  let voice: VoiceChannel | undefined;
  if (available.includes("voice")) {
    voice = createVoiceChannel();
    channels.set("voice", voice);
  }

  // Schlüsselverwaltung aus der Oberfläche heraus (S32-Nachtrag): liest/schreibt dieselbe
  // `.env`, aus der dieser Prozess selbst gestartet wurde. Setzt voraus, dass der Gateway-
  // Prozess Dateizugriff auf sie hat — im Docker-Betrieb (`env_file:` in docker-compose.yml)
  // ist das ohne einen Bind-Mount **nicht** der Fall; das ist eine spätere Entscheidung, keine
  // stillschweigende Annahme hier.
  const envFilePath = envFilePathFromEnv();
  const secrets = {
    read: () => readEnvFile(envFilePath),
    write: (contents: string) => writeEnvFile(envFilePath, contents),
  };

  // Dieselbe Brücke wie die mail.*/cal.*-Tools (S14/S15), hier ohne Tool-/Policy-/
  // Artefaktschicht — Nachtrag 2026-09-16 für `/integrations/mail`, das Dashboard-Widget der
  // Oberfläche. `undefined`, wenn keine n8n-Instanz hinterlegt ist (`configured` bleibt dann
  // `false`, die Route antwortet mit 404 statt einem Fehler ohne Ursache).
  const n8nBridge = n8nBaseUrl
    ? createN8nBridge({ baseUrl: n8nBaseUrl, token: process.env.N8N_WEBHOOK_TOKEN?.trim() })
    : undefined;

  // Die Postfächer warm halten (2026-09-20). Ohne das traf jeder Neuaufbau der Oberfläche auf
  // einen kalten Speicher und wartete auf drei IMAP-Runden — sichtbar als „Lädt …" über
  // Sekunden, bei jedem Neuladen. Der erste Abruf läuft hier sofort, damit schon der erste
  // Blick nach einem Neustart auf etwas Fertiges trifft.
  const postfachWarm = haltePostfaecherWarm(konten, { anzahl: 30 });

  const port = Number(process.env.GATEWAY_PORT ?? 8788);
  // Die Anmeldung der Oberfläche. Fehlt sie in der `.env`, bleibt es beim Betreiber-Token —
  // dann steht die Oberfläche jedem offen, der den Token hat, und die Startmeldung sagt das.
  const anmeldung = anmeldungAusUmgebung();
  console.log(
    anmeldung
      ? `Anmeldung: Benutzer ${anmeldung.benutzer}, Sitzung ${Math.round(SITZUNG_GUELTIG_MS / 86_400_000)} Tage gültig.`
      : "Anmeldung: keine (WEB_LOGIN_USER/WEB_LOGIN_HASH fehlen) — die Oberfläche verlangt weiter den Betreiber-Token von Hand.",
  );

  const app = createServer({
    gateway,
    identity,
    anmeldung: anmeldung ?? undefined,
    web,
    telegram,
    slack,
    voice,
    secrets,
    n8nBridge,
    memory,
    markets: createYahooMarkets(),
    system: createSystemSampler(),
    restart: createSystemdRestart(),
    bus: eventBus,
  });
  const server: Server = app.listen(port, () => {
    console.log(`[gateway] http://localhost:${port} — Kanäle: ${[...channels.keys()].join(", ")}`);
  });

  // Der Ereignisstrom (S21) hängt am **bestehenden** Server des Gateways, nicht an einem
  // zweiten Port: dieser Prozess führt die Unterhaltung des Nutzers, also fallen hier die
  // Ereignisse an, die eine Oberfläche live sehen will. Ein Upgrade ist kein Request, den
  // Express je zu sehen bekäme — deshalb am Server und nicht als Route (siehe `bus.ts`).
  const events = attachEventSocket(server);
  console.log(`[gateway] Ereignisstrom: ws://localhost:${port}/events (nur lesend).`);
  // Die lauschende Seite von `pg_notify` (S21-Nachtrag): ohne sie hinge der Socket oben, ohne
  // dass ihn je etwas füllte — `log.ts` sagt seit dem Nachtrag nur noch per NOTIFY an.
  const eventNotify = await startEventNotifyListener(pool);

  console.log(
    `Nutzer ${identity.userId}, Motor: Claude Code (Agent-SDK), Arbeitsbereich ${agent.workdir}.`,
  );
  // Ob das Personal rechnen darf, ist eine Eigenschaft dieses Rechners — und sie gehört in
  // die Startmeldung, nicht in eine stille Verzweigung. Trägt der Sandkasten nicht, arbeiten
  // die Bediensteten ohne Bash weiter (siehe `sandkasten.ts`).
  const lage = sandkastenLage();
  console.log(
    lage.ok
      ? "Sandkasten: trägt — die Bediensteten dürfen rechnen (Bash, kein Netz, keine Schlüssel)."
      : `Sandkasten: trägt nicht (${lage.grund}) — die Bediensteten bekommen kein Bash.`,
  );

  // Was beim letzten Lauf offen blieb und nie hinausging, geht jetzt hinaus. Ohne diesen
  // Schritt wartete ein Lauf, dessen Freigabeanfrage beim Herunterfahren zwischen Protokoll
  // und Zustellung stand, für immer auf eine Antwort, die niemand geben kann.
  console.log(
    agent.sessionId
      ? `Unterhaltung: Sitzung ${agent.sessionId} wird fortgesetzt.`
      : "Unterhaltung: neue Sitzung bei der ersten Nachricht.",
  );
  const pending = await redeliverPending(gateway);
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
  if (slack) console.log("Slack: Events API (POST /channels/slack/events).");
  if (voice) {
    console.log(
      "Sprache: POST /channels/voice/messages und /answers. Der Sprachprozess läuft eigenständig (voice/, Python).",
    );
  }

  let stopped = false;
  async function shutdown(reason: string): Promise<void> {
    if (stopped) return;
    stopped = true;
    console.log(`\n[gateway] ${reason} — herunterfahren.`);
    polling?.stop();
    postfachWarm.stop();
    await polling?.done.catch(() => undefined);
    await events.close().catch(() => undefined);
    await eventNotify.close().catch(() => undefined);
    server.close();
    // Der Motor hält keinen Prozesszustand, den man herunterfahren müsste: ein laufender Zug
    // bricht mit dem Prozess ab, die Sitzung liegt auf der Platte und wird beim nächsten Start
    // fortgesetzt. Genau das war beim selbstgebauten Läufer die Fehlerquelle (`runtime.started`
    // ohne Gegenstück).
    // Wer den Store geöffnet hat, schließt ihn — dasselbe Eigentumsmuster wie beim Pool (S03),
    // wie in `runtime/index.ts`.
    memory?.close();
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
