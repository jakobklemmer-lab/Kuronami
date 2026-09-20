import { randomUUID } from "node:crypto";
import express from "express";
import { BEDIENSTETE, HANDELSTISCH } from "../context/bedienstete.js";
import { originAllowed } from "../runtime/events/bus.js";
import type { RuntimeEventBus } from "../runtime/events/bus.js";
import { readEvents } from "../runtime/events/log.js";
import {
  McpServerConfigInputError,
  type McpServerRecord,
  RiskLevelError,
  deleteMcpServer,
  listMcpServers,
  upsertMcpServer,
} from "../runtime/mcp/config-store.js";
import { readSecretStatus, upsertSecrets } from "../runtime/secrets/env-file.js";
import { DEFAULT_SPEND_DAYS, listDailySpend } from "../runtime/session/costs.js";
import { getRunDetail, listRuns } from "../runtime/session/runs.js";
import type { MemoryStore } from "../tools/memory/store.js";
import type { N8nBridge } from "../tools/n8n/bridge.js";
import { handleSlackEvent } from "./channels/slack/channel.js";
import type { SlackChannelDeps } from "./channels/slack/channel.js";
import { isUrlVerification } from "./channels/slack/normalize.js";
import { handleUpdate } from "./channels/telegram/channel.js";
import type { TelegramChannelDeps } from "./channels/telegram/channel.js";
import type { VoiceChannel } from "./channels/voice/channel.js";
import type { WebChannel } from "./channels/web.js";
import { type GatewayDeps, openAskRoutes, receiveDecision, receiveMessage } from "./core.js";
import {
  type GatewayIdentity,
  authenticateVoice,
  authenticateWeb,
  bearerToken,
  verifySlackSignature,
} from "./identity.js";
import {
  displayNameOf,
  listArtifactFiles,
  listResearch,
  loadCalendar,
  notesAsFiles,
  summarizeNotes,
} from "./integrations/dashboard.js";
import {
  MarketDataError,
  type MarketsClient,
  defaultIntervalFor,
  isChartInterval,
  isChartRange,
  isValidSymbol,
} from "./integrations/markets.js";
import { type SystemSampler, formatBytesPerSecond } from "./integrations/system.js";
import { postfachVerbindenRouten } from "./postfach-verbinden.js";
import { konten, lies, listeGepuffert } from "./postfach.js";
import { deriveAskRoutes } from "./routing.js";
import type { InboundAttachment } from "./types.js";

/**
 * Der HTTP-Rand des Gateways. **Nur Rand** — er packt aus, authentifiziert, ruft den Kern und
 * packt wieder ein. Keine Session, kein Lauf, keine Entscheidung darüber, was ein Zug tut.
 *
 * Der Zuschnitt der Endpunkte folgt aus der Nachrichtenform und nicht aus der Runtime: es gibt
 * einen Weg für Nachrichten, einen für Entscheidungen und einen, um Zugestelltes abzuholen.
 * Ein Endpunkt "Session starten" oder "Schritt ausführen" fehlt bewusst — er wäre eine
 * Runtime-Oberfläche im Gateway und damit genau die Abhängigkeit, die Abschnitt 3 verbietet.
 */

/** Obergrenze des JSON-Körpers. Anhänge kommen im Web-Kanal als Base64 mit. */
export const MAX_REQUEST_BODY = "32mb";

export interface ServerDeps {
  gateway: GatewayDeps;
  identity: GatewayIdentity;
  web: WebChannel;
  /** Fehlt sie, gibt es keinen Telegram-Webhook — das Long-Polling braucht ihn nicht. */
  telegram?: TelegramChannelDeps;
  /** Fehlt sie, gibt es keine Slack-Route — der Kanal ist dann nicht konfiguriert. */
  slack?: SlackChannelDeps;
  /** Fehlt sie, gibt es keine Sprach-Routen (S30). Der Python-Prozess läuft dann ins Leere. */
  voice?: VoiceChannel;
  /** Fehlt sie, gibt es keine Schlüsselverwaltung (S32-Nachtrag) — `.env` bleibt dann nur von
   * Hand editierbar. */
  secrets?: SettingsSecretsDeps;
  /** Die n8n-Brücke, heute nur noch für den Kalender (`/integrations/calendar`). Die Post
   * läuft seit 2026-09-18 direkt über IMAP (`gateway/postfach.ts`). */
  n8nBridge?: N8nBridge;
  /** Das Langzeitgedächtnis — Quelle für `/integrations/notes` (Nachtrag 2026-09-16: die
   * Startseite zeigt echte Notizen statt eines Mock-Zitats). Fehlt es, antwortet die Route leer. */
  memory?: Pick<MemoryStore, "all">;
  /** Marktdaten (Yahoo Finance) für `/integrations/markets/*`; fehlt der Client, gibt es 404. */
  markets?: MarketsClient;
  /** Host-Messwerte für `/integrations/system`; ohne Sampler 404. */
  system?: SystemSampler;
  /** Fehlt sie, bleibt der Neustart-Knopf der Oberfläche tot (Nachtrag 2026-09-16) — dann gilt
   * eine Schlüsseländerung erst, wenn jemand die Dienste von Hand neu startet. */
  restart?: RestartDeps;
  /** Der Ereignisbus des Prozesses (Streaming, 2026-09-16): die Sprach-Routen hören darauf nach
   * `model.delta` und reichen die Textstücke als SSE weiter. Fehlt er, antworten sie wie bisher
   * mit einem Block. */
  bus?: Pick<RuntimeEventBus, "subscribe">;
}

/**
 * Die Dienste, die sich aus der Oberfläche heraus neu starten lassen (Nachtrag 2026-09-16).
 *
 * Eine **geschlossene** Aufzählung und kein Kommando aus dem Browser: der Aufrufer wählt aus
 * dreien, er formuliert nichts. Das ist der Unterschied zwischen einem Knopf und einer
 * Fernsteuerung für beliebige Shell-Befehle — und der Grund, warum diese Route trotz des
 * mächtigen Web-Tokens keine neue Angriffsfläche aufmacht.
 */
export const RESTART_SERVICES = ["gateway", "ui", "voice"] as const;
export type RestartService = (typeof RESTART_SERVICES)[number];

export function isRestartService(value: unknown): value is RestartService {
  return typeof value === "string" && (RESTART_SERVICES as readonly string[]).includes(value);
}

/** Startet einen der drei Dienste neu. Schnittstelle statt festem `execFile`, damit ein Test
 * prüfen kann, was angefordert wurde, ohne etwas neu zu starten — dasselbe Muster wie
 * `SettingsSecretsDeps`. */
export interface RestartDeps {
  restart(service: RestartService): Promise<void>;
}

/** Liest/schreibt den `.env`-Inhalt, aus dem `readSecretStatus`/`upsertSecrets` ihre Sicht
 * bauen. Eine Schnittstelle statt eines festen Dateizugriffs, damit ein Test ohne Platte prüfen
 * kann — dasselbe Muster wie `fetchImpl` in `ui/api/client.ts`. */
export interface SettingsSecretsDeps {
  read(): Promise<string>;
  write(contents: string): Promise<void>;
}

/** `express.json({verify})` legt hier die rohen Bytes ab — die Slack-Signatur läuft über genau
 * diese, nicht über den (möglicherweise anders serialisierten) geparsten Body. */
interface RequestWithRawBody extends express.Request {
  rawBody?: Buffer;
}

interface WebAttachmentBody {
  name?: unknown;
  mimeType?: unknown;
  contentBase64?: unknown;
}

/** Anhänge des Web-Kanals: Base64 im Körper. Alles andere wird benannt abgewiesen. */
function decodeAttachments(value: unknown): InboundAttachment[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("attachments muss eine Liste sein.");

  return value.map((entry, index) => {
    const attachment = entry as WebAttachmentBody;
    if (typeof attachment.name !== "string" || attachment.name.trim().length === 0) {
      throw new Error(`attachments[${index}].name fehlt.`);
    }
    if (typeof attachment.mimeType !== "string" || attachment.mimeType.trim().length === 0) {
      throw new Error(`attachments[${index}].mimeType fehlt.`);
    }
    if (typeof attachment.contentBase64 !== "string") {
      throw new Error(`attachments[${index}].contentBase64 fehlt.`);
    }
    return {
      name: attachment.name.trim(),
      mimeType: attachment.mimeType.trim(),
      bytes: new Uint8Array(Buffer.from(attachment.contentBase64, "base64")),
    };
  });
}

/** `mail-search.json` liefert je nach Anbieter ISO-Text, einen numerischen Epoch-Millis-String
 * (Gmails `internalDate`-Fallback) oder gar nichts — hier auf ein Format gebracht, das
 * `formatRelativeTime` in der Oberfläche sicher parst. Unbrauchbares fällt auf "jetzt" zurück,
 * statt ein "Invalid Date" bis in die Liste durchzureichen. */
function toIsoDate(value: unknown): string {
  if (typeof value === "string" && value.trim() !== "") {
    if (/^\d+$/.test(value)) {
      const ms = Number(value);
      if (Number.isFinite(ms)) return new Date(ms).toISOString();
    }
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

export function createServer(deps: ServerDeps): express.Express {
  const app = express();

  /**
   * CORS für die Oberfläche (S22). Die Oberfläche läuft im Dev-Betrieb auf einem eigenen
   * Ursprung (`ui/dev.ts`, Port 3001) und ruft dieses Gateway auf einem anderen (8788) —
   * anders als der Ereignisstrom (`bus.ts`, ein WebSocket, kennt keine Same-Origin-Regel des
   * Browsers) blockiert der Browser ein `fetch()` über Ursprünge hinweg ohne diese Kopfzeilen,
   * insbesondere weil der `Authorization`-Header einen Preflight (`OPTIONS`) auslöst. Dieselbe
   * Herkunftsprüfung wie am Ereignisstrom (`originAllowed`, Vorgabe nur localhost) — eine
   * zweite, abweichende Liste vertrauenswürdiger Ursprünge wäre eine zweite Wahrheit über
   * dieselbe Frage. Ein Aufruf ganz ohne `Origin` (curl, der Telegram-Webhook) bleibt
   * unberührt: für ihn gibt es kein Browser-CORS, das etwas verböte.
   */
  app.use((req, res, next) => {
    const origin = req.header("origin");
    if (origin && originAllowed(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
      // DELETE seit den MCP-Server-Routen (Nachtrag 2026-09-16, /settings/mcp-servers/:id) —
      // vorher genügten GET/POST für jede bestehende Route.
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    }
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.use(
    express.json({
      limit: MAX_REQUEST_BODY,
      // Nötig für die Slack-Signaturprüfung (`/channels/slack/events`): sie läuft über die
      // rohen Bytes des Anfragekörpers, die `express.json()` sonst restlos verbraucht. Für
      // jede andere Route ist das Feld ungenutzt, kostet aber nur eine zusätzliche Referenz auf
      // denselben Puffer, den Express ohnehin schon einliest.
      verify: (req, _res, buf) => {
        (req as RequestWithRawBody).rawBody = Buffer.from(buf);
      },
    }),
  );

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      channels: [
        deps.web.id,
        ...(deps.telegram ? ["telegram"] : []),
        ...(deps.slack ? ["slack"] : []),
        ...(deps.voice ? ["voice"] : []),
      ],
      user: deps.identity.userId,
    });
  });

  /**
   * Authentifiziert einen Web-Aufruf. Gibt bei Misserfolg selbst die Antwort und `null`
   * zurück — damit gibt es in den Handlern keinen Weg, den Rückgabewert zu ignorieren und
   * trotzdem weiterzumachen.
   */
  function webPrincipal(req: express.Request, res: express.Response) {
    const auth = authenticateWeb(deps.identity, {
      token: bearerToken(req.header("authorization")),
      displayName: typeof req.body?.displayName === "string" ? req.body.displayName : undefined,
      replyTo:
        typeof req.body?.replyTo === "string"
          ? req.body.replyTo
          : (req.query.replyTo as string | undefined),
    });
    if (!auth.ok) {
      // 401 für "kein oder falscher Ausweis", 403 für "der Kanal ist gar nicht eingerichtet".
      // Der Unterschied zählt beim Einrichten: das eine ist ein falscher Token, das andere
      // ein fehlendes GATEWAY_WEB_TOKEN auf der Serverseite.
      const status = auth.reason === "channel_not_configured" ? 403 : 401;
      res.status(status).json({ error: auth.message, reason: auth.reason });
      return null;
    }
    return auth.principal;
  }

  app.post("/channels/web/messages", async (req, res, next) => {
    try {
      const principal = webPrincipal(req, res);
      if (!principal) return;

      const content = req.body?.content;
      if (typeof content !== "string") {
        res.status(400).json({ error: "content (string) ist erforderlich." });
        return;
      }

      let attachments: InboundAttachment[];
      try {
        attachments = decodeAttachments(req.body?.attachments);
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
        return;
      }

      const outcome = await receiveMessage(deps.gateway, principal, {
        channel: "web",
        sender: principal.sender,
        content,
        attachments,
        receivedAt: new Date(),
        // Der Web-Kanal hat keine kanaleigene Nachrichtenkennung. Wer eine mitschickt, bekommt
        // die Doppel-Erkennung aus `hasReceived` — ein Wiederholungsversuch nach einem
        // Verbindungsabbruch löst dann keinen zweiten Zug aus.
        externalId:
          typeof req.body?.externalId === "string" && req.body.externalId.length > 0
            ? `web:${req.body.externalId}`
            : `web:${randomUUID()}`,
      });

      res.status(200).json({
        ...outcome,
        deliveries: deps.web.drain(principal.sender.replyTo),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/channels/web/answers", async (req, res, next) => {
    try {
      const principal = webPrincipal(req, res);
      if (!principal) return;

      const { askId, choiceId } = req.body ?? {};
      if (typeof askId !== "string" || typeof choiceId !== "string") {
        res.status(400).json({ error: "askId und choiceId (beide string) sind erforderlich." });
        return;
      }

      const outcome = await receiveDecision(deps.gateway, principal, {
        channel: "web",
        sender: principal.sender,
        askId,
        choiceId,
        receivedAt: new Date(),
        externalId:
          typeof req.body?.externalId === "string" && req.body.externalId.length > 0
            ? `web:${req.body.externalId}`
            : `web:${randomUUID()}`,
      });

      res.status(200).json({
        ...outcome,
        deliveries: deps.web.drain(principal.sender.replyTo),
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Was die Oberfläche braucht, um die Sprachschicht zu öffnen (Nachtrag 2026-09-16).
   *
   * Vorher standen Adresse und Sitzungsgeheimnis als zwei Handeingabe-Felder in den
   * Einstellungen — auf jedem Gerät neu, obwohl der Gateway beide Werte längst aus `.env`
   * kennt. Die Adresse leitet die Oberfläche selbst ab (`ui/backend-origin.ts`, dasselbe
   * Muster wie beim Gateway-Host), das Geheimnis kommt von hier.
   *
   * `configured: false` statt eines leeren Tokens: der Unterschied zwischen "keine
   * Sprachschicht eingerichtet" und "eingerichtet, aber gerade nicht erreichbar" gehört dem
   * Aufrufer, nicht dem Zufall eines leeren Strings.
   */
  app.get("/channels/web/voice", (req, res) => {
    const principal = webPrincipal(req, res);
    if (!principal) return;
    const sessionToken = deps.identity.voiceSessionToken;
    res.json(
      sessionToken.length > 0
        ? { configured: true, sessionToken }
        : { configured: false, sessionToken: null },
    );
  });

  /** Holt ab, was außerhalb eines Aufrufs zugestellt wurde. Leert dabei das Postfach. */
  app.get("/channels/web/outbox", (req, res) => {
    const principal = webPrincipal(req, res);
    if (!principal) return;
    res.json({ deliveries: deps.web.drain(principal.sender.replyTo) });
  });

  /**
   * Was gerade offen ist — aus dem **Protokoll** gefaltet, nicht aus dem Postfach. Das ist der
   * Weg, der einen Neustart übersteht: das Postfach ist dann leer, die Frage aber noch offen.
   */
  app.get("/channels/web/pending", async (req, res, next) => {
    try {
      const principal = webPrincipal(req, res);
      if (!principal) return;

      const sessionId = deps.gateway.agent.sessionId ?? "";
      const routes = openAskRoutes(deps.gateway);
      res.json({
        sessionId,
        pending: routes.map((route) => ({
          askId: route.askId,
          kind: route.kind,
          question: route.question,
          options: route.options,
          channel: route.to.channel,
          delivered: route.delivered,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Die Runs-Übersicht (S22): alle Sessions des Systems, gefaltet aus dem Protokoll
   * (`runtime/session/runs.ts`) — anders als `/channels/web/pending` nicht nur die
   * Unterhaltung des Aufrufers, sondern auch Hintergrundläufe (Heartbeat, delegierte
   * Arbeiter). Hinter demselben Bearer-Token wie jeder andere Lesepfad dieses Randes: die
   * Zeilen tragen Kanal, Werkzeugnamen und Artefakt-Zusammenfassungen, dieselbe
   * Vertraulichkeit wie `/channels/web/pending`.
   */
  app.get("/runs", async (req, res, next) => {
    try {
      const principal = webPrincipal(req, res);
      if (!principal) return;
      const { runs, metrics } = await listRuns(deps.gateway.pool);
      res.json({ runs, metrics });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Tagesausgaben je Agent (S28, `runtime/session/costs.ts`). Hinter demselben Bearer-Token wie
   * `/runs`: die Zeilen nennen Agentennamen und Verbrauch, also dieselbe Vertraulichkeit.
   *
   * `?days=` begrenzt das Fenster; ein unlesbarer Wert fällt auf die Vorgabe zurück, statt eine
   * 400 für eine Anzeige zu werfen, die auch mit der Vorgabe brauchbar ist.
   */
  app.get("/costs", async (req, res, next) => {
    try {
      const principal = webPrincipal(req, res);
      if (!principal) return;
      const requested = Number.parseInt(String(req.query.days ?? ""), 10);
      const days = Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_SPEND_DAYS;
      res.json(await listDailySpend(deps.gateway.pool, days));
    } catch (error) {
      next(error);
    }
  });

  /** Der Schritt-für-Schritt-Verlauf eines einzelnen Runs, samt aufgelöster Artefakte. */
  app.get("/runs/:id", async (req, res, next) => {
    try {
      const principal = webPrincipal(req, res);
      if (!principal) return;
      const detail = await getRunDetail(deps.gateway.pool, req.params.id);
      if (!detail) {
        res.status(404).json({ error: `Run ${req.params.id} ist unbekannt.` });
        return;
      }
      res.json(detail);
    } catch (error) {
      next(error);
    }
  });

  /**
   * Verwaltung der Provider-Schlüssel aus der Oberfläche heraus (S32-Nachtrag, `ui/settings/
   * view.ts`, Abschnitt "API-Keys"): dieselbe Handvoll Werte, die bisher nur von Hand in `.env`
   * landete. Hinter demselben Bearer-Token wie `/runs` — wer diesen Token hat, darf ohnehin
   * schon die Runtime steuern, ein Provider-Schlüssel ist keine höhere Vertraulichkeit.
   *
   * Der Klartext geht nie zurück zum Browser — `readSecretStatus` liefert nur, ob ein Schlüssel
   * gesetzt ist und seine letzten vier Zeichen zur Wiedererkennung. Und: eine Änderung gilt erst
   * nach einem Neustart des betroffenen Dienstes (`runtime/secrets/env-file.ts` erklärt, warum).
   */
  app.get("/settings/api-keys", async (req, res, next) => {
    try {
      const principal = webPrincipal(req, res);
      if (!principal) return;
      if (!deps.secrets) {
        res
          .status(404)
          .json({ error: "Schlüsselverwaltung ist auf diesem Gateway nicht eingerichtet." });
        return;
      }
      const contents = await deps.secrets.read();
      res.json({ keys: readSecretStatus(contents) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/settings/api-keys", async (req, res, next) => {
    try {
      const principal = webPrincipal(req, res);
      if (!principal) return;
      if (!deps.secrets) {
        res
          .status(404)
          .json({ error: "Schlüsselverwaltung ist auf diesem Gateway nicht eingerichtet." });
        return;
      }

      const updates = req.body?.keys;
      if (typeof updates !== "object" || updates === null || Array.isArray(updates)) {
        res.status(400).json({ error: "keys (Objekt aus Schlüssel auf Wert) ist erforderlich." });
        return;
      }
      for (const [key, value] of Object.entries(updates)) {
        if (typeof value !== "string") {
          res.status(400).json({ error: `keys.${key} muss ein String sein.` });
          return;
        }
      }

      let nextContents: string;
      try {
        const current = await deps.secrets.read();
        nextContents = upsertSecrets(current, updates as Record<string, string>);
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
        return;
      }
      await deps.secrets.write(nextContents);
      res.json({ keys: readSecretStatus(nextContents) });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Neustart eines der drei Dienste (Nachtrag 2026-09-16) — der Knopf, den
   * `ui/settings/view.ts` bis hierher deaktiviert zeigte ("Kein Fernsteuerungs-Endpunkt").
   *
   * Ohne ihn war die Schlüsselverwaltung eine halbe Sache: `.env` wurde geschrieben, aber nichts
   * las sie neu, und die Oberfläche verlangte einen Neustart, für den sie keinen Weg anbot.
   *
   * Der Gateway startet hier **sich selbst** mit: die Antwort geht deshalb zuerst raus und der
   * Neustart erst, wenn sie auf der Leitung ist (`res.on("finish")`). Andernfalls stürbe der
   * Prozess mitten im Schreiben, und der Aufrufer sähe einen Verbindungsabbruch statt einer
   * Zusage — er wüsste nicht, ob sein Neustart überhaupt angefangen hat.
   */
  app.post("/settings/restart", (req, res) => {
    const principal = webPrincipal(req, res);
    if (!principal) return;
    if (!deps.restart) {
      res.status(404).json({ error: "Neustarts sind auf diesem Gateway nicht eingerichtet." });
      return;
    }

    const service = req.body?.service;
    if (!isRestartService(service)) {
      res
        .status(400)
        .json({ error: `service muss einer von ${RESTART_SERVICES.join(", ")} sein.` });
      return;
    }

    const runner = deps.restart;
    res.on("finish", () => {
      void runner.restart(service).catch((error) => {
        console.error(
          `[gateway] Neustart von ${service} fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    });
    res.json({ service, started: true });
  });

  /**
   * Verwaltung der MCP-Server aus der Oberfläche heraus (Nachtrag 2026-09-16,
   * `runtime/mcp/config-store.ts`, Migration 0011). Dieselbe Vertrauensgrenze wie
   * `/settings/api-keys`: hinter demselben Bearer-Token wie `/runs`. Eine Änderung gilt wie
   * dort erst nach einem Neustart des Gateways (S27: Entdeckung läuft genau einmal beim
   * Katalogbau) — dieser Rand liest/schreibt nur die Tabelle, nicht den laufenden Katalog.
   *
   * `env`-Werte gehen nie zurück zum Browser (`toPublicServer` unten) — dieselbe Zurückhaltung
   * wie bei den Provider-Schlüsseln, nur ohne Vorschau der letzten vier Zeichen: ein MCP-Server
   * kann mehrere Variablen tragen, eine einzelne Vorschau je Schlüssel wäre hier mehr Aufwand
   * als der Fall (ein Betreiber, eine Handvoll Server) rechtfertigt.
   */
  function toPublicServer(server: McpServerRecord) {
    return {
      serverId: server.serverId,
      command: server.command,
      args: server.args,
      envKeys: Object.keys(server.env).sort(),
      risk: server.risk,
      repeatable: server.repeatable,
      enabled: server.enabled,
      createdAt: server.createdAt,
      updatedAt: server.updatedAt,
    };
  }

  app.get("/settings/mcp-servers", async (req, res, next) => {
    try {
      const principal = webPrincipal(req, res);
      if (!principal) return;
      const servers = await listMcpServers(deps.gateway.pool);
      res.json({ servers: servers.map(toPublicServer) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/settings/mcp-servers", async (req, res, next) => {
    try {
      const principal = webPrincipal(req, res);
      if (!principal) return;

      const body = req.body ?? {};
      if (typeof body.serverId !== "string" || body.serverId.trim() === "") {
        res.status(400).json({ error: "serverId ist erforderlich." });
        return;
      }
      if (typeof body.command !== "string" || body.command.trim() === "") {
        res.status(400).json({ error: "command ist erforderlich." });
        return;
      }
      if (body.args !== undefined) {
        if (!Array.isArray(body.args) || body.args.some((a: unknown) => typeof a !== "string")) {
          res.status(400).json({ error: "args muss eine Liste aus Strings sein." });
          return;
        }
      }
      if (body.env !== undefined) {
        if (
          typeof body.env !== "object" ||
          body.env === null ||
          Array.isArray(body.env) ||
          Object.values(body.env).some((v) => typeof v !== "string")
        ) {
          res.status(400).json({ error: "env muss ein Objekt aus String auf String sein." });
          return;
        }
      }

      let server: McpServerRecord;
      try {
        server = await upsertMcpServer(deps.gateway.pool, {
          serverId: body.serverId,
          command: body.command,
          args: body.args,
          env: body.env,
          risk: body.risk,
          repeatable: typeof body.repeatable === "boolean" ? body.repeatable : undefined,
          enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
        });
      } catch (error) {
        if (error instanceof McpServerConfigInputError || error instanceof RiskLevelError) {
          res.status(400).json({ error: error.message });
          return;
        }
        throw error;
      }
      res.json({ server: toPublicServer(server) });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/settings/mcp-servers/:serverId", async (req, res, next) => {
    try {
      const principal = webPrincipal(req, res);
      if (!principal) return;
      const deleted = await deleteMcpServer(deps.gateway.pool, req.params.serverId);
      if (!deleted) {
        res
          .status(404)
          .json({ error: `Kein MCP-Server mit der Kennung "${req.params.serverId}".` });
        return;
      }
      res.json({ deleted: true });
    } catch (error) {
      next(error);
    }
  });

  // Ein Postfach im Browser verbinden (Nachtrag 2026-09-18). Steht bewusst ohne Web-Token:
  // Jakob ruft die Seite in einem gewöhnlichen Tab auf, in dem keiner liegt, und Google leitet
  // ihn ebenso dorthin zurück. Die Seite selbst gibt nichts preis, was nicht ohnehin bei
  // Google steht — den Schlüssel bekommt nur, wer sich dort erfolgreich angemeldet hat.
  postfachVerbindenRouten(app);

  /**
   * Der Ist-Zustand des Hauses (Nachtrag 2026-09-18).
   *
   * Ersetzt die Felder in den Einstellungen, die auf Module zeigten, die es nicht mehr gibt:
   * ein Modell-Router, eine Policy-Engine, ein Kompaktierungsknopf. Alles drei war beim
   * Motorwechsel weggefallen, die Felder standen aber weiter da — deaktiviert, mit einem
   * Hinweis auf eine Datei, die niemand mehr öffnet. Ein Schalter ohne Wirkung ist schlimmer
   * als kein Schalter; er behauptet eine Möglichkeit.
   */
  app.get("/integrations/haushalt", (req, res, next) => {
    try {
      const principal = webPrincipal(req, res);
      if (!principal) return;

      const perAbo = !process.env.ANTHROPIC_API_KEY?.trim();
      res.json({
        modell: process.env.KURO_MODEL?.trim() || "(Vorgabe des SDK)",
        abrechnung: perAbo ? "abo" : "api",
        arbeitsbereich: deps.gateway.agent.workdir,
        sitzung: deps.gateway.agent.sessionId,
        postfaecher: konten().map((k) => ({ name: k.name, adresse: k.user })),
        bedienstete: Object.entries(BEDIENSTETE).map(([name, p]) => ({
          name,
          modell: p.model ?? "(geerbt)",
          beschreibung: p.description,
        })),
        handelstisch: Object.entries(HANDELSTISCH).map(([name, p]) => ({
          name,
          modell: p.model ?? "(geerbt)",
          beschreibung: p.description,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Eine einzelne Nachricht im Volltext (Nachtrag 2026-09-18).
   *
   * Vorher zeigte die Mail-Ansicht nur Absender und Betreff — den Inhalt gab es nirgends,
   * weil `preview` aus der Übersicht leer bleibt (Kopfzeilen tragen keinen Text). Ohne diese
   * Route war die Liste eine Sackgasse: anklickbar sah sie aus, passiert ist nichts.
   *
   * Nicht gepuffert: eine Nachricht wird einmal geöffnet und gelesen, ein zweiter Abruf ist
   * die Ausnahme. Dafür lohnt kein Speicher, der Stand vortäuscht.
   */
  app.get("/integrations/mail/nachricht", async (req, res, next) => {
    try {
      const principal = webPrincipal(req, res);
      if (!principal) return;

      const alle = konten();
      const konto = typeof req.query.konto === "string" ? req.query.konto : "";
      const uid = Number(req.query.uid);
      if (!konto || !Number.isFinite(uid)) {
        res.status(400).json({ error: "konto und uid müssen angegeben sein." });
        return;
      }
      if (alle.length === 0) {
        res.status(404).json({ error: "Es ist noch kein Postfach verbunden." });
        return;
      }

      res.json(await lies(alle, konto, uid));
    } catch (error) {
      next(error);
    }
  });

  /**
   * Nachtrag 2026-09-16: die Oberfläche liest hier direkt, ohne den Agenten-Loop zu bemühen —
   * dieselbe Haltung wie beim Trading-Chart (direkter Abruf, kein Modellaufruf). `mail.search`
   * als Werkzeug bleibt für den Assistenten daneben bestehen (Artefakt, Redaction, Kontext-
   * Kürzung); dieser Rand hier ist nur die Kurzfassung fürs Dashboard, dieselbe n8n-Brücke,
   * ohne die Tool-/Policy-/Artefakt-Schicht dazwischen.
   */
  app.get("/integrations/mail", async (req, res, next) => {
    try {
      const principal = webPrincipal(req, res);
      if (!principal) return;

      const alle = konten();
      if (alle.length === 0) {
        res.status(404).json({ error: "Es ist noch kein Postfach verbunden." });
        return;
      }

      // Gefiltert auf ein Konto, wenn die Oberfläche eines nennt — sonst alle, nach Zeit
      // gemischt. `liste()` sortiert über die Postfächer hinweg.
      const nur = typeof req.query.konto === "string" ? req.query.konto : undefined;
      // Gepuffert: ohne das baut jeder Seitenaufruf drei IMAP-Verbindungen neu auf, und die
      // Oberfläche lädt schon beim Wechsel zwischen den Ansichten neu.
      const koepfe = await listeGepuffert(alle, { konto: nur, anzahl: 30 });

      const messages = koepfe.map((k) => ({
        id: `${k.konto}#${k.uid}`,
        konto: k.konto,
        from: displayNameOf(k.von),
        subject: k.betreff,
        preview: k.anriss,
        receivedAt: k.am,
        unread: k.ungelesen,
      }));
      res.json({
        messages,
        unreadCount: messages.filter((m) => m.unread).length,
        // Damit die Oberfläche die Umschalter bauen kann, ohne selbst zu wissen, welche
        // Postfächer eingerichtet sind.
        konten: alle.map((k) => k.name),
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Die übrigen Dashboard-Quellen (Nachtrag 2026-09-16, Ablösung von `ui/mock/data.ts`): jede
   * Route liest genau eine echte Quelle und formt sie für die Oberfläche. Was nicht angeschlossen
   * ist, antwortet mit einem benannten Zustand (`connected: false` beim Kalender, 404 mit Text
   * bei fehlender Abhängigkeit) — die Oberfläche zeigt den Grund, nie einen erfundenen Wert.
   */

  app.get("/integrations/calendar", async (req, res, next) => {
    try {
      const principal = webPrincipal(req, res);
      if (!principal) return;
      const controller = new AbortController();
      req.on("close", () => controller.abort());
      res.json(await loadCalendar(deps.n8nBridge, controller.signal));
    } catch (error) {
      next(error);
    }
  });

  app.get("/integrations/notes", async (req, res, next) => {
    try {
      const principal = webPrincipal(req, res);
      if (!principal) return;
      if (!deps.memory) {
        res
          .status(404)
          .json({ error: "Das Gedächtnis ist auf diesem Gateway nicht eingerichtet." });
        return;
      }
      res.json({ notes: summarizeNotes(await deps.memory.all()) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/integrations/files", async (req, res, next) => {
    try {
      const principal = webPrincipal(req, res);
      if (!principal) return;
      const artifacts = await listArtifactFiles(deps.gateway.pool);
      const notes = deps.memory ? notesAsFiles(summarizeNotes(await deps.memory.all())) : [];
      const files = [...artifacts, ...notes].sort((a, b) =>
        b.modifiedAt.localeCompare(a.modifiedAt),
      );
      res.json({ files });
    } catch (error) {
      next(error);
    }
  });

  app.get("/integrations/research", async (req, res, next) => {
    try {
      const principal = webPrincipal(req, res);
      if (!principal) return;
      res.json({ findings: await listResearch(deps.gateway.pool) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/integrations/system", async (req, res, next) => {
    try {
      const principal = webPrincipal(req, res);
      if (!principal) return;
      if (!deps.system) {
        res.status(404).json({ error: "Systemwerte sind auf diesem Gateway nicht verfügbar." });
        return;
      }
      const snapshot = await deps.system.snapshot();
      const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)}`;
      // Netz als Anteil einer 100-Mbit-Leitung (12,5 MB/s) — eine Skala für den Ring, kein
      // Messwert; der Zahlenwert daneben ist der echte.
      const NET_FULL_SCALE = 12.5 * 1024 * 1024;
      const net = snapshot.netBytesPerSecond;
      res.json({
        snapshot,
        gauges: [
          {
            id: "cpu",
            label: "CPU",
            percent: snapshot.cpuPercent,
            readout: `${snapshot.cpuPercent}`,
            readoutSub: "%",
          },
          {
            id: "ram",
            label: "RAM",
            percent: snapshot.ramPercent,
            readout: gib(snapshot.ramUsedBytes),
            readoutSub: `/${gib(snapshot.ramTotalBytes)} GB`,
          },
          {
            id: "disk",
            label: "Disk",
            percent: snapshot.diskPercent,
            readout: `${snapshot.diskPercent}`,
            readoutSub: "%",
          },
          {
            id: "net",
            label: "Netz",
            percent: net === null ? 0 : Math.min(100, Math.round((net / NET_FULL_SCALE) * 100)),
            readout: net === null ? "—" : formatBytesPerSecond(net),
            readoutSub: net === null ? "misst" : null,
          },
        ],
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Marktdaten: Suche, Kurse einer Beobachtungsliste, Chart eines Symbols. Yahoo-Fehler kommen
   * als 502 mit Text zurück — nicht als 500, denn die Ursache liegt beim fremden Dienst.
   */
  const marketsMissing = (res: express.Response): boolean => {
    if (deps.markets) return false;
    res.status(404).json({ error: "Marktdaten sind auf diesem Gateway nicht eingerichtet." });
    return true;
  };
  const marketError = (error: unknown, res: express.Response, next: express.NextFunction) => {
    if (error instanceof MarketDataError) {
      res.status(502).json({ error: error.message });
      return;
    }
    next(error);
  };

  app.get("/integrations/markets/search", async (req, res, next) => {
    try {
      const principal = webPrincipal(req, res);
      if (!principal || marketsMissing(res) || !deps.markets) return;
      const q = typeof req.query.q === "string" ? req.query.q : "";
      res.json({ hits: await deps.markets.search(q) });
    } catch (error) {
      marketError(error, res, next);
    }
  });

  app.get("/integrations/markets/quotes", async (req, res, next) => {
    try {
      const principal = webPrincipal(req, res);
      if (!principal || marketsMissing(res) || !deps.markets) return;
      const raw = typeof req.query.symbols === "string" ? req.query.symbols : "";
      const symbols = raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "");
      const invalid = symbols.filter((s) => !isValidSymbol(s));
      if (invalid.length > 0) {
        res.status(400).json({ error: `Ungültige Symbole: ${invalid.join(", ")}` });
        return;
      }
      if (symbols.length > 30) {
        res.status(400).json({ error: "Höchstens 30 Symbole je Anfrage." });
        return;
      }
      res.json(await deps.markets.quotes(symbols));
    } catch (error) {
      marketError(error, res, next);
    }
  });

  app.get("/integrations/markets/chart", async (req, res, next) => {
    try {
      const principal = webPrincipal(req, res);
      if (!principal || marketsMissing(res) || !deps.markets) return;
      const symbol = typeof req.query.symbol === "string" ? req.query.symbol : "";
      const range = typeof req.query.range === "string" ? req.query.range : "1d";
      if (!isValidSymbol(symbol)) {
        res.status(400).json({ error: `Ungültiges Symbol "${symbol}".` });
        return;
      }
      if (!isChartRange(range)) {
        res.status(400).json({ error: `Unbekannter Zeitraum "${range}".` });
        return;
      }
      const intervalRaw = typeof req.query.interval === "string" ? req.query.interval : "";
      const interval = isChartInterval(intervalRaw) ? intervalRaw : defaultIntervalFor(range);
      res.json(await deps.markets.chart(symbol, range, interval));
    } catch (error) {
      marketError(error, res, next);
    }
  });

  /**
   * Das Analysen-Archiv.
   *
   * Eine Handelsidee wird einmal vorgetragen und ist dann weg — bei Sprachbedienung restlos.
   * Vor einem Einstieg mit echtem Geld will man sie aber noch einmal in Ruhe lesen, samt dem,
   * was die Gegenprüfung eingewandt hat. Geschrieben wird hier nichts: der Ablageort ist
   * `analysen.ts`, gefüllt wird er, wenn ein Bericht fertig ist.
   */
  app.get("/integrations/analysen", async (req, res, next) => {
    try {
      const principal = webPrincipal(req, res);
      if (!principal) return;
      const grenzeRoh = Number(req.query.grenze);
      const grenze = Number.isFinite(grenzeRoh) ? Math.min(Math.max(grenzeRoh, 1), 200) : 50;
      res.json({ analysen: await deps.gateway.agent.analysen.liste(grenze) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/integrations/analysen/:id", async (req, res, next) => {
    try {
      const principal = webPrincipal(req, res);
      if (!principal) return;
      const analyse = await deps.gateway.agent.analysen.lies(req.params.id);
      if (!analyse) {
        res.status(404).json({ error: "Diese Analyse gibt es nicht." });
        return;
      }
      res.json(analyse);
    } catch (error) {
      next(error);
    }
  });

  app.patch("/integrations/analysen/:id", async (req, res, next) => {
    try {
      const principal = webPrincipal(req, res);
      if (!principal) return;
      const status = req.body?.status;
      const notiz = req.body?.notiz;
      if (status !== undefined && !["offen", "gehandelt", "verworfen"].includes(status)) {
        res.status(400).json({ error: `Unbekannter Status "${status}".` });
        return;
      }
      if (notiz !== undefined && typeof notiz !== "string") {
        res.status(400).json({ error: "notiz muss Text sein." });
        return;
      }
      const analyse = await deps.gateway.agent.analysen.aendere(req.params.id, {
        ...(status ? { status } : {}),
        ...(notiz !== undefined ? { notiz: notiz.slice(0, 4000) } : {}),
      });
      if (!analyse) {
        res.status(404).json({ error: "Diese Analyse gibt es nicht." });
        return;
      }
      res.json(analyse);
    } catch (error) {
      next(error);
    }
  });

  /** Was die Bediensteten gerade tun — die Oberfläche fragt danach, wenn sie neu aufgeht. */
  app.get("/integrations/haus", (req, res) => {
    const principal = webPrincipal(req, res);
    if (!principal) return;
    res.json({ laufende: deps.gateway.agent.laufendeAuftraege });
  });

  /**
   * Der Sprach-Kanal (S30/S31). Drei Routen, dieselbe Form wie beim Web-Kanal: Nachrichten,
   * Entscheidungen, Postfach.
   *
   * **Bewusst neben den Web-Routen und nicht mit ihnen verschmolzen.** Die Versuchung ist da —
   * die Rümpfe gleichen sich bis auf den Kanalnamen. Dagegen steht, dass die Tests der
   * Web-Routen seit S21 nicht mehr automatisch laufen (`vitest.config.ts`): eine Änderung dort
   * wäre eine Änderung am Herzstück der Außengrenze ohne laufendes Netz darunter. Sechzig
   * Zeilen Wiederholung sind der billigere Preis. Wenn die alten Tests wieder laufen, gehört
   * das hier zusammengelegt — bis dahin steht der Grund in dieser Zeile.
   */
  function voicePrincipal(req: express.Request, res: express.Response) {
    if (!deps.voice) {
      res.status(404).json({ error: "Der Sprach-Kanal ist in diesem Gateway nicht aktiv." });
      return null;
    }
    const auth = authenticateVoice(deps.identity, {
      token: bearerToken(req.header("authorization")),
      displayName: typeof req.body?.displayName === "string" ? req.body.displayName : undefined,
      replyTo:
        typeof req.body?.replyTo === "string"
          ? req.body.replyTo
          : (req.query.replyTo as string | undefined),
    });
    if (!auth.ok) {
      const status = auth.reason === "channel_not_configured" ? 403 : 401;
      res.status(status).json({ error: auth.message, reason: auth.reason });
      return null;
    }
    return auth.principal;
  }

  /**
   * Antwortet einen Sprachzug — als Block oder als Ereignisstrom (Streaming, 2026-09-16).
   *
   * Verlangt der Aufrufer `Accept: text/event-stream`, kommen die Textstücke des Modells als
   * `delta`-Ereignisse, sobald der Bus sie ansagt, und am Ende als `done` genau die Antwort,
   * die sonst der ganze Block gewesen wäre. Die Brücke spricht damit den ersten Satz, während
   * der Zug noch Werkzeuge ruft — statt eine Minute zu schweigen und dann alles vorzulesen.
   *
   * **Gefiltert wird nach dem Zug, nicht nach der Sitzung.** Das war bis 2026-09-20 anders, und
   * es ging schief, sobald Jakob zweimal kurz hintereinander sprach: Züge stehen im Motor
   * Schlange (`agent.ts`, `#laufend`), also wartet der zweite Aufruf mit **offenem** Strom,
   * während der erste noch redet — und bekam dessen Worte. Gesprochen wurden dann zwei
   * Antworten in einem Satz („…sobald der Bericht da ist.Wie meinen Sie das, Jakob…"), während
   * die eigene Antwort in einem Strom landete, den längst niemand mehr hörte.
   *
   * Die Zuordnung läuft über die `externalId`, die dieser Aufruf selbst vergeben hat: der Motor
   * sagt seinen Zug mit ihr an (`turn.started`), und ab da ist bekannt, welche `turn_id` diesem
   * Strom gehört.
   */
  async function respondVoiceTurn(
    req: express.Request,
    res: express.Response,
    principal: NonNullable<ReturnType<typeof voicePrincipal>>,
    voice: VoiceChannel,
    externalId: string,
    run: () => ReturnType<typeof receiveMessage>,
  ): Promise<void> {
    const bus = deps.bus;
    const wantsStream =
      bus !== undefined && (req.header("accept") ?? "").includes("text/event-stream");
    if (!wantsStream) {
      const outcome = await run();
      res.status(200).json({ ...outcome, deliveries: voice.drain(principal.sender.replyTo) });
      return;
    }

    res.status(200);
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    res.flushHeaders();
    const write = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    // Bis der eigene Zug anfängt, gehört kein einziges Stück in diesen Strom.
    let meinZug: string | null = null;
    const unsubscribe = bus.subscribe((event) => {
      if (event.type === "turn.started" && event.data.external_id === externalId) {
        meinZug = typeof event.data.turn_id === "string" ? event.data.turn_id : null;
        return;
      }
      if (event.type !== "model.delta" || meinZug === null) return;
      if (event.data.turn_id !== meinZug) return;
      write("delta", { text: event.data.text });
    });
    try {
      const outcome = await run();
      write("done", { ...outcome, deliveries: voice.drain(principal.sender.replyTo) });
    } catch (error) {
      // Die Kopfzeilen sind draußen, ein `next(error)` käme zu spät — der Fehler geht als
      // Ereignis, mit Wortlaut, wie überall sonst.
      write("error", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      unsubscribe();
      res.end();
    }
  }

  app.post("/channels/voice/messages", async (req, res, next) => {
    try {
      const principal = voicePrincipal(req, res);
      if (!principal || !deps.voice) return;

      const content = req.body?.content;
      if (typeof content !== "string") {
        res.status(400).json({ error: "content (string) ist erforderlich." });
        return;
      }

      const externalId =
        typeof req.body?.externalId === "string" && req.body.externalId.length > 0
          ? `voice:${req.body.externalId}`
          : `voice:${randomUUID()}`;
      await respondVoiceTurn(req, res, principal, deps.voice, externalId, () =>
        receiveMessage(deps.gateway, principal, {
          channel: "voice",
          sender: principal.sender,
          content,
          // Anhänge gibt es hier nicht: ein Mikrofon liefert Ton, und der Ton ist beim
          // Eintreffen schon zu Text geworden (S30). Eine Aufnahme mitzuliefern wäre eine
          // eigene Entscheidung über Aufbewahrung und Datenschutz und gehört nicht nebenbei
          // in diese Zeile.
          attachments: [],
          receivedAt: new Date(),
          externalId,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  app.post("/channels/voice/answers", async (req, res, next) => {
    try {
      const principal = voicePrincipal(req, res);
      if (!principal || !deps.voice) return;

      const { askId, choiceId } = req.body ?? {};
      if (typeof askId !== "string" || typeof choiceId !== "string") {
        res.status(400).json({ error: "askId und choiceId (beide string) sind erforderlich." });
        return;
      }

      const externalId =
        typeof req.body?.externalId === "string" && req.body.externalId.length > 0
          ? `voice:${req.body.externalId}`
          : `voice:${randomUUID()}`;
      await respondVoiceTurn(req, res, principal, deps.voice, externalId, () =>
        receiveDecision(deps.gateway, principal, {
          channel: "voice",
          sender: principal.sender,
          askId,
          choiceId,
          receivedAt: new Date(),
          externalId,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  /** Holt ab, was außerhalb eines Sprachzugs zugestellt wurde (der Heartbeat etwa). */
  app.get("/channels/voice/outbox", (req, res) => {
    const principal = voicePrincipal(req, res);
    if (!principal || !deps.voice) return;
    res.json({ deliveries: deps.voice.drain(principal.sender.replyTo) });
  });

  app.post("/channels/telegram/webhook", async (req, res, next) => {
    try {
      if (!deps.telegram) {
        res.status(404).json({ error: "Der Telegram-Kanal ist in diesem Gateway nicht aktiv." });
        return;
      }

      const result = await handleUpdate(deps.telegram, req.body ?? {}, {
        transport: "webhook",
        secretHeader: req.header("x-telegram-bot-api-secret-token") ?? null,
      });

      if (result.kind === "rejected") {
        // Telegram gegenüber ist ein abgewiesenes Update **erledigt**: mit einem 4xx würde es
        // erneut zugestellt, und ein unbefugter Absender könnte den Webhook in eine
        // Dauerschleife schicken. Was passiert ist, steht in der Antwort und in der
        // Prozessausgabe, nicht in einem Wiederholungsversuch.
        console.warn(`[gateway] Telegram-Update abgewiesen: ${result.reason}`);
      }
      res.status(200).json({ ok: true, kind: result.kind });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Slacks Events API, ein Endpunkt für zwei Formen (Auftrag S26): einmalig die
   * `url_verification`-Herausforderung beim Einrichten, sonst laufende Zustellungen
   * (`event_callback`).
   *
   * **Die 3-Sekunden-Frist.** Slack verlangt eine HTTP-Antwort innerhalb von drei Sekunden,
   * sonst wird dieselbe Zustellung wiederholt — anders als beim Telegram-Webhook oben, der
   * `handleUpdate` komplett awaitet, bevor er antwortet. Ein voller Gateway-Zug (Modellaufruf,
   * Werkzeugaufrufe) kann das Vielfache davon dauern. Deshalb antwortet diese Route **sofort**
   * mit `200 {ok:true}` und lässt `handleSlackEvent` danach unabhängig davon weiterlaufen
   * (fire-and-forget) — eine trotzdem eintreffende Wiederholung fängt die bestehende
   * `externalId`/`hasReceived`-Idempotenz aus `gateway/core.ts` sauber ab, wie bei Telegram.
   */
  app.post("/channels/slack/events", (req, res) => {
    if (!deps.slack) {
      res.status(404).json({ error: "Der Slack-Kanal ist in diesem Gateway nicht aktiv." });
      return;
    }

    const rawBody = (req as RequestWithRawBody).rawBody?.toString("utf8") ?? "";
    const timestamp = req.header("x-slack-request-timestamp") ?? null;
    const signature = req.header("x-slack-signature") ?? null;

    if (isUrlVerification(req.body)) {
      // Die Signatur gilt auch für diese Anfrage — ohne Prüfung könnte jeder Dritte die
      // Request-URL "bestätigen".
      if (
        !timestamp ||
        !signature ||
        !verifySlackSignature(deps.identity.slackSigningSecret, timestamp, rawBody, signature)
      ) {
        res.status(401).json({ error: "Slack-Signatur fehlt oder stimmt nicht." });
        return;
      }
      res.status(200).json({ challenge: req.body.challenge });
      return;
    }

    res.status(200).json({ ok: true });
    handleSlackEvent(deps.slack, req.body, { timestamp, signature, rawBody }).catch((error) => {
      console.error("[gateway] Slack-Event:", error);
    });
  });

  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ): void => {
      // Der Fehlertext geht unverändert hinaus (AGENTS.md: nie glätten). Das Gateway läuft auf
      // localhost bzw. hinter der Authentifizierung; wird es je öffentlich, ist das die Zeile,
      // die zuerst überdacht gehört.
      console.error("[gateway]", error);
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    },
  );

  return app;
}
