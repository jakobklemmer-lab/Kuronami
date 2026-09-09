import { type CronExpr, parseCron } from "./schedule.js";

/**
 * Die Einstellungen des Heartbeat-Dienstes, aus der Umgebung gebaut. Fehlende Werte haben eine
 * Vorgabe; ein kaputter Cron-Ausdruck bricht den Start ab, statt später stumm nie zu feuern.
 */

export type HeartbeatChannelKind = "telegram" | "console";

export interface HeartbeatConfig {
  /** Wann der Morgen-Digest läuft. Vorgabe `0 7 * * *` (täglich 07:00, lokale Zeit). */
  digestCron: CronExpr;
  /** Obergrenze der Hintergrundläufe je Kalendertag (lokale Zeit). Vorgabe 8, Minimum 1. */
  maxRunsPerDay: number;
  /** Wie oft der Dienst nachsieht, ob der Digest fällig ist. Vorgabe 30 s. */
  pollSeconds: number;
  /** Port des HTTP-Rands (`POST /notify`, `GET /health`). Vorgabe 8789. */
  port: number;
  /**
   * Bearer-Token für `POST /notify`. Leer = der Endpunkt nimmt nichts an (der Dienst läuft
   * dann nur nach Zeitplan). Ein n8n-Workflow für "neue Mail" schickt ihn mit.
   */
  notifySecret: string;
  /** Über welchen Kanal der Digest zugestellt wird. */
  channel: HeartbeatChannelKind;
  /**
   * Wohin. Bei Telegram die Chat-Kennung (Vorgabe: die erste aus `TELEGRAM_ALLOWED_USER_IDS`,
   * denn im Einzelchat ist Nutzer- gleich Chat-Kennung). Bei `console` ohne Belang.
   */
  deliverTo: string;
}

function intFromEnv(raw: string | undefined, fallback: number, min: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) return fallback;
  return value;
}

export function heartbeatConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HeartbeatConfig {
  const telegramUserIds = (env.TELEGRAM_ALLOWED_USER_IDS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const deliverTo = env.HEARTBEAT_DELIVER_TO?.trim() || telegramUserIds[0] || "";

  // Telegram nur wählen, wenn er auch bedienbar wäre — sonst still auf Konsole zurückfallen,
  // damit ein halb konfigurierter Dienst nicht bei jedem Digest in einen Zustellfehler läuft.
  const telegramUsable = Boolean(env.TELEGRAM_BOT_TOKEN?.trim()) && deliverTo.length > 0;
  const wanted = env.HEARTBEAT_CHANNEL?.trim().toLowerCase();
  const channel: HeartbeatChannelKind =
    wanted === "console"
      ? "console"
      : wanted === "telegram" || telegramUsable
        ? "telegram"
        : "console";

  return {
    digestCron: parseCron(env.HEARTBEAT_DIGEST_CRON?.trim() || "0 7 * * *"),
    maxRunsPerDay: intFromEnv(env.HEARTBEAT_MAX_RUNS_PER_DAY, 8, 1),
    pollSeconds: intFromEnv(env.HEARTBEAT_POLL_SECONDS, 30, 5),
    port: intFromEnv(env.HEARTBEAT_PORT, 8789, 1),
    notifySecret: env.HEARTBEAT_NOTIFY_SECRET?.trim() ?? "",
    channel: channel === "telegram" && !telegramUsable ? "console" : channel,
    deliverTo,
  };
}
