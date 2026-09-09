import { timingSafeEqual } from "node:crypto";
import express from "express";
import { bearerToken } from "../gateway/identity.js";
import type { Notification } from "./digest.js";
import type { Heartbeat } from "./service.js";

/**
 * Der HTTP-Rand des Heartbeats. **Nur Rand** — er authentifiziert und reicht durch.
 *
 * Ein einziger nützlicher Endpunkt: `POST /notify`. Das ist der **ereignisgesteuerte
 * Auslöser** aus dem Auftrag — ein n8n-Workflow für neue Mail, ein Monitoring-Hook für einen
 * Server-Alarm oder ein Kalender-Webhook ruft ihn und der Dienst startet einen
 * Hintergrundlauf. Genauso wie der Telegram-Webhook des Gateways ist das Verdrahtung nach
 * außen und keine Codeänderung, wenn eine neue Quelle dazukommt.
 */

export const MAX_REQUEST_BODY = "256kb";

const TRIGGER_KINDS = new Set(["mail", "calendar", "server"]);

function secretEquals(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface HeartbeatServerDeps {
  heartbeat: Heartbeat;
  /** Bearer-Token für `/notify`. Leer = der Endpunkt lehnt jeden Aufruf ab. */
  notifySecret: string;
  nextDigest: () => Date | null;
}

export function createHeartbeatServer(deps: HeartbeatServerDeps): express.Express {
  const app = express();
  app.use(express.json({ limit: MAX_REQUEST_BODY }));

  app.get("/health", (_req, res) => {
    const next = deps.nextDigest();
    res.json({
      ok: true,
      diarySession: deps.heartbeat.diarySessionId,
      nextDigest: next ? next.toISOString() : null,
      notify: deps.notifySecret.length > 0,
    });
  });

  app.post("/notify", async (req, res, next) => {
    try {
      if (deps.notifySecret.length === 0) {
        res
          .status(403)
          .json({ error: "POST /notify ist ohne HEARTBEAT_NOTIFY_SECRET nicht aktiv." });
        return;
      }
      const token = bearerToken(req.header("authorization"));
      if (token === null || !secretEquals(token, deps.notifySecret)) {
        // Kein Hinweis, was fehlt: eine Fehlermeldung an einen Unbefugten sagt ihm, dass hier
        // etwas läuft. Dieselbe Haltung wie beim Gateway.
        res.status(401).json({ error: "unauthorized" });
        return;
      }

      const kind = req.body?.kind;
      if (typeof kind !== "string" || !TRIGGER_KINDS.has(kind)) {
        res
          .status(400)
          .json({ error: `kind muss eines von ${[...TRIGGER_KINDS].join(", ")} sein.` });
        return;
      }
      const detail = typeof req.body?.detail === "string" ? req.body.detail : "";

      const result = await deps.heartbeat.notify({ kind, detail } as Notification);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ): void => {
      // Fehlertext unverändert hinaus (AGENTS.md). Der Dienst läuft auf Loopback.
      console.error("[heartbeat]", error);
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    },
  );

  return app;
}
