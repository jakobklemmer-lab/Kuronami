import { randomUUID } from "node:crypto";
import express from "express";
import { originAllowed } from "../runtime/events/bus.js";
import { readEvents } from "../runtime/events/log.js";
import { getRunDetail, listRuns } from "../runtime/session/runs.js";
import { handleSlackEvent } from "./channels/slack/channel.js";
import type { SlackChannelDeps } from "./channels/slack/channel.js";
import { isUrlVerification } from "./channels/slack/normalize.js";
import { handleUpdate } from "./channels/telegram/channel.js";
import type { TelegramChannelDeps } from "./channels/telegram/channel.js";
import type { WebChannel } from "./channels/web.js";
import { type GatewayDeps, receiveDecision, receiveMessage } from "./core.js";
import {
  type GatewayIdentity,
  authenticateWeb,
  bearerToken,
  verifySlackSignature,
} from "./identity.js";
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
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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

      const conversation = await deps.gateway.conversations.of(principal.userId);
      const sessionId = conversation.runner.session.sessionId;
      const routes = deriveAskRoutes(await readEvents(deps.gateway.pool, sessionId));
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
