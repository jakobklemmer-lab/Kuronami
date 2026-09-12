import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { PolicyEngine } from "../policy/engine.js";
import { writeArtifact } from "../runtime/artifacts/store.js";
import { appendEvent, readEvents } from "../runtime/events/log.js";
import { type LoopOutcome, type Runner, createRunner } from "../runtime/loop/api.js";
import type { ModelClient } from "../runtime/model/types.js";
import type { ToolCatalog } from "../tools/types.js";
import type { DigestChannel } from "./delivery.js";

/**
 * Der Kern des Heartbeats: ein **Hintergrundlauf** ohne Nutzereingabe, sein Ergebnis als
 * Artefakt und über den bevorzugten Kanal zugestellt.
 *
 * Zwei Einstiege, ein Mechanismus:
 *
 *   * `runDigest` — der Morgen-Digest. Läuft nach Zeitplan (`service.ts`), fasst Mail,
 *     Kalender, News und Servermetriken zusammen, legt den Text als Artefakt ab und stellt
 *     ihn zu.
 *   * `handleNotification` — ein ereignisgesteuerter Lauf (neue Mail, Kalenderänderung,
 *     Server-Alarm). Sieht nach und meldet sich **nur, wenn es etwas zu melden gibt** — sonst
 *     ein `heartbeat.silent` und Ruhe.
 *
 * Beide teilen sich `runBackground`: Runner auf dem Kanal `heartbeat`, Modus `background`, der
 * eingeengte Katalog und der Regelsatz mit `BACKGROUND_RULES` (kein Schreiben in die
 * Quellzone, also auch nicht nach `memory/`). Die Tagesobergrenze wird aus dem Protokoll der
 * Diarium-Session gefaltet, damit sie einen Neustart überlebt.
 */

/**
 * Das eine Wort, mit dem ein Hintergrundlauf sagt: hier gibt es nichts zu melden. Steht seit
 * S17 im Prompt jedes ereignisgesteuerten Laufs und seit S19 auch im Auftrag eines Agenten mit
 * Zeitplan — "Wenn nichts gefunden wird: keine Meldung" gilt für beide gleich.
 */
export const SILENT_MARKER = "STILL";

export interface HeartbeatDeps {
  pool: Pool;
  artifactRoot: string;
  /**
   * Die Session, in der die Lebenslauf-Ereignisse des Dienstes stehen (`heartbeat.ran` usw.).
   * Getrennt von den eigentlichen Läufen, damit die Tagesobergrenze an einer festen Stelle
   * zählbar bleibt. `service.ts` legt sie einmal beim Start an.
   */
  diarySessionId: string;
  catalog: ToolCatalog;
  policy: PolicyEngine;
  model: ModelClient;
  /**
   * Das Modell zu einem Modellnamen aus der Agenten-Registry (S19, Abschnitt 11: "Modell pro
   * Agent bewusst wählen"). Ohne diese Fabrik läuft auch ein Agent mit Zeitplan auf `model`;
   * `heartbeat.ran` hält das dann fest, damit ein teurer Lauf nicht wie ein günstiger aussieht.
   */
  modelFor?: (model: string) => ModelClient;
  channel: DigestChannel;
  /** Läufe je Kalendertag (lokale Zeit). */
  maxRunsPerDay: number;
  /** Für Tests. Vorgabe: `() => new Date()`. */
  now?: () => Date;
  conventions?: string;
  /** Vorgabe 25 — ein Digest braucht keine 50 Schritte. */
  maxSteps?: number;
}

export type HeartbeatStatus = "delivered" | "silent" | "skipped" | "failed";

export interface HeartbeatRunResult {
  status: HeartbeatStatus;
  reason: string;
  /** Die Session des Hintergrundlaufs (nicht die Diarium-Session). */
  runSessionId?: string;
  artifactUri?: string;
  text?: string;
}

const TRIGGER_LABEL: Record<string, string> = {
  mail: "neue Mail",
  calendar: "Kalenderänderung",
  server: "Server-Alarm",
};

const TRIGGER_HINT: Record<string, string> = {
  mail: "mail.search nach neu eingegangenen Nachrichten, bei Bedarf mail.read",
  calendar: "cal.list nach neuen, verschobenen oder abgesagten Terminen",
  server: "server.metrics nach Alarmen und Ausreißern",
};

function nowFrom(deps: HeartbeatDeps): Date {
  return deps.now?.() ?? new Date();
}

function startOfLocalDay(when: Date): Date {
  const copy = new Date(when.getTime());
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function describeError(error: unknown): { message: string; stack: string | null } {
  return {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? (error.stack ?? null) : null,
  };
}

/** Wie viele `heartbeat.ran` heute (lokale Zeit) schon im Diarium stehen. */
export async function countRunsToday(
  pool: Pool,
  diarySessionId: string,
  when: Date,
): Promise<number> {
  const dayStart = startOfLocalDay(when);
  const events = await readEvents(pool, diarySessionId);
  return events.filter(
    (event) => event.type === "heartbeat.ran" && event.createdAt.getTime() >= dayStart.getTime(),
  ).length;
}

interface BackgroundRun {
  outcome: LoopOutcome;
  runSessionId: string;
}

async function runBackground(
  deps: HeartbeatDeps,
  threadPrefix: string,
  prompt: string,
): Promise<BackgroundRun> {
  const runner: Runner = await createRunner({
    pool: deps.pool,
    threadId: `${threadPrefix}_${randomUUID()}`,
    channel: "heartbeat",
    sessionMode: "background",
    artifactRoot: deps.artifactRoot,
    catalog: deps.catalog,
    policy: deps.policy,
    model: deps.model,
    conventions: deps.conventions,
    maxSteps: deps.maxSteps ?? 25,
    // Ein Hintergrundlauf **ist** ein abgeschlossener Auftrag: er hat kein Gegenüber, das
    // weiterschreibt. `session.completed`/`session.failed` gehören deshalb ins Protokoll.
    completeOnDone: true,
  });

  try {
    const outcome = await runner.run(prompt);
    if (outcome.stop === "awaiting_user") {
      // Sollte nicht vorkommen — `BACKGROUND_RULES` macht aus jedem `ask` ein `deny`, und
      // `user.ask` ist nicht im Katalog. Falls doch: abbrechen, damit kein offener Zug
      // liegenbleibt, den nie jemand fortsetzt.
      await runner.cancel("heartbeat: kein Nutzer, der eine Rückfrage beantwortet").catch(() => {});
    }
    return { outcome, runSessionId: runner.session.sessionId };
  } finally {
    await runner.stop("heartbeat-lauf-fertig").catch(() => {});
  }
}

function digestPrompt(when: Date, channelId: string): string {
  const weekday = when.toLocaleDateString("de-DE", { weekday: "long" });
  return [
    `Es ist ${when.toISOString()} (${weekday}). Erstelle den Morgen-Digest für den Nutzer.`,
    "",
    "Sieh der Reihe nach nach und fasse knapp zusammen, was heute wichtig ist:",
    "- Mail: ungelesene und heute eingegangene Nachrichten (mail.search, bei Bedarf mail.read). Absender und Betreff, keine Volltexte.",
    "- Kalender: die Termine der nächsten 24 bis 48 Stunden (cal.list).",
    "- News: drei bis fünf Schlagzeilen zu den Interessen des Nutzers (web.search). Darf web.* nichts abrufen, lass den Abschnitt weg.",
    "- Server: auffällige Werte aus server.metrics. Ist alles im grünen Bereich, ein Satz dazu.",
    "",
    `Halte dich kurz — der Digest geht über ${channelId} raus. Markdown, eine Überschrift je Abschnitt.`,
    "",
    'Du läufst im Hintergrund, ohne Nutzer am anderen Ende: du kannst nicht ins Langzeitgedächtnis (memory/) und nicht in den Quelltext schreiben, und niemand beantwortet Rückfragen. Fällt dir etwas auf, das der Nutzer sich merken sollte, schreib es unter eine Überschrift "## Vorschläge" — aufnehmen tut er es selbst.',
    "",
    "Antworte am Ende ohne Werkzeugaufruf mit dem fertigen Digest-Text und sonst nichts.",
  ].join("\n");
}

function notifyPrompt(when: Date, kind: string, detail: string): string {
  return [
    `Auslöser (${when.toISOString()}): ${TRIGGER_LABEL[kind] ?? kind}. Zusatzangabe: ${detail.trim() || "keine"}.`,
    "",
    `Sieh mit den lesenden Werkzeugen nach, ob hier etwas ist, das der Nutzer jetzt wissen muss (${TRIGGER_HINT[kind] ?? "die passenden lesenden Werkzeuge"}).`,
    "",
    "Du läufst im Hintergrund: kein Schreiben ins Langzeitgedächtnis oder in den Quelltext, keine Rückfragen.",
    "",
    `- Gibt es nichts Meldenswertes, antworte mit genau dem einen Wort ${SILENT_MARKER} und sonst nichts.`,
    "- Sonst antworte mit ein bis drei Sätzen: was ist los, was ist zu tun.",
  ].join("\n");
}

/**
 * Ist die Tagesobergrenze erreicht? Dann steht der ausgefallene Lauf als `heartbeat.skipped`
 * im Diarium — ein ausbleibender Lauf soll nicht wie ein Fehler aussehen.
 *
 * Seit S19 exportiert, weil die Agenten mit Zeitplan (`agents.ts`) an **derselben** Grenze
 * hängen wie Digest und Meldung: Cron-Agenten sind der eigentliche Kostentreiber (Abschnitt 11),
 * und eine zweite Obergrenze daneben wäre eine, die man vergisst mitzuziehen.
 */
export async function overDailyCap(
  deps: HeartbeatDeps,
  when: Date,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const ran = await countRunsToday(deps.pool, deps.diarySessionId, when);
  if (ran < deps.maxRunsPerDay) return false;
  await appendEvent(deps.pool, deps.diarySessionId, "heartbeat.skipped", {
    reason: "daily_cap",
    cap: deps.maxRunsPerDay,
    ran,
    at: when.toISOString(),
    ...payload,
  });
  return true;
}

/**
 * Der Morgen-Digest. Kein Argument von außen — der Auslöser ist der Zeitplan.
 *
 * Fertig-Kriterium von S17: "Digest läuft ohne manuellen Anstoß." Genau diese Funktion ist,
 * was der Zeitplan aufruft.
 */
export async function runDigest(
  deps: HeartbeatDeps,
  options: { fire?: Date } = {},
): Promise<HeartbeatRunResult> {
  const when = nowFrom(deps);
  // Kennzeichnet den Zeitplan-Anlass, gegen den `service.ts` doppelte Läufe erkennt. Bei
  // einem manuellen Aufruf (Test) fehlt er und wird zu `null`.
  const fire = options.fire?.toISOString() ?? null;

  if (await overDailyCap(deps, when, { kind: "digest", fire })) {
    return {
      status: "skipped",
      reason: `Tagesobergrenze ${deps.maxRunsPerDay} erreicht.`,
    };
  }

  const { outcome, runSessionId } = await runBackground(
    deps,
    "thread_heartbeat_digest",
    digestPrompt(when, deps.channel.id),
  );

  if (outcome.stop !== "done") {
    await appendEvent(deps.pool, deps.diarySessionId, "heartbeat.ran", {
      kind: "digest",
      fire,
      run_session: runSessionId,
      ok: false,
      delivered: false,
      stop: outcome.stop,
      reason: outcome.reason,
    });
    // Fehler nicht verstecken (AGENTS.md): ein kurzer Hinweis geht raus, kein stilles Schweigen.
    await deps.channel
      .deliver(`Morgen-Digest konnte nicht erstellt werden (${outcome.stop}): ${outcome.reason}`)
      .catch(() => {});
    return { status: "failed", reason: outcome.reason, runSessionId };
  }

  const body = outcome.text.trim().length > 0 ? outcome.text.trim() : outcome.reason;
  const dateLabel = when.toISOString().slice(0, 10);

  const meta = await writeArtifact(deps.pool, deps.artifactRoot, {
    content: body,
    mimeType: "text/markdown",
    summary: `Morgen-Digest ${dateLabel}`,
    source: { tool: "heartbeat.digest", sessionId: runSessionId, stepId: null },
  });

  let delivered = true;
  try {
    await deps.channel.deliver(`${body}\n\n(${meta.uri})`);
  } catch (error) {
    delivered = false;
    await appendEvent(deps.pool, deps.diarySessionId, "error.raised", {
      where: "heartbeat.deliver",
      ...describeError(error),
    });
  }

  if (delivered) {
    await appendEvent(deps.pool, deps.diarySessionId, "heartbeat.delivered", {
      kind: "digest",
      channel: deps.channel.id,
      artifact_uri: meta.uri,
      run_session: runSessionId,
    });
  }

  await appendEvent(deps.pool, deps.diarySessionId, "heartbeat.ran", {
    kind: "digest",
    fire,
    run_session: runSessionId,
    ok: true,
    delivered,
    artifact_uri: meta.uri,
    tool_calls: outcome.toolCalls,
  });

  return {
    status: delivered ? "delivered" : "failed",
    reason: delivered ? `Digest zugestellt über ${deps.channel.id}.` : "Zustellung fehlgeschlagen.",
    runSessionId,
    artifactUri: meta.uri,
    text: body,
  };
}

export interface Notification {
  kind: "mail" | "calendar" | "server";
  /** Was der Auslöser mitgibt (Absender, Terminname, Alarmtext). Darf leer sein. */
  detail: string;
}

/**
 * Ein ereignisgesteuerter Lauf. Meldet sich **nur**, wenn der Lauf etwas Meldenswertes findet
 * — "Wenn nichts gefunden wird: keine Meldung" aus dem Auftrag.
 */
export async function handleNotification(
  deps: HeartbeatDeps,
  notification: Notification,
): Promise<HeartbeatRunResult> {
  const when = nowFrom(deps);
  const kind = notification.kind;

  if (await overDailyCap(deps, when, { kind: "notify", trigger: kind })) {
    return { status: "skipped", reason: `Tagesobergrenze ${deps.maxRunsPerDay} erreicht.` };
  }

  const { outcome, runSessionId } = await runBackground(
    deps,
    "thread_heartbeat_notify",
    notifyPrompt(when, kind, notification.detail),
  );

  if (outcome.stop !== "done") {
    await appendEvent(deps.pool, deps.diarySessionId, "heartbeat.ran", {
      kind: "notify",
      trigger: kind,
      run_session: runSessionId,
      ok: false,
      delivered: false,
      stop: outcome.stop,
      reason: outcome.reason,
    });
    return { status: "failed", reason: outcome.reason, runSessionId };
  }

  const text = outcome.text.trim();
  const silent = text.length === 0 || text.toUpperCase().startsWith(SILENT_MARKER);

  if (silent) {
    await appendEvent(deps.pool, deps.diarySessionId, "heartbeat.silent", {
      trigger: kind,
      detail: notification.detail,
      run_session: runSessionId,
    });
    await appendEvent(deps.pool, deps.diarySessionId, "heartbeat.ran", {
      kind: "notify",
      trigger: kind,
      run_session: runSessionId,
      ok: true,
      delivered: false,
    });
    return { status: "silent", reason: "Nichts Meldenswertes.", runSessionId };
  }

  let delivered = true;
  try {
    await deps.channel.deliver(text);
  } catch (error) {
    delivered = false;
    await appendEvent(deps.pool, deps.diarySessionId, "error.raised", {
      where: "heartbeat.deliver",
      ...describeError(error),
    });
  }

  if (delivered) {
    await appendEvent(deps.pool, deps.diarySessionId, "heartbeat.delivered", {
      kind: "notify",
      trigger: kind,
      channel: deps.channel.id,
      run_session: runSessionId,
    });
  }

  await appendEvent(deps.pool, deps.diarySessionId, "heartbeat.ran", {
    kind: "notify",
    trigger: kind,
    run_session: runSessionId,
    ok: true,
    delivered,
  });

  return {
    status: delivered ? "delivered" : "failed",
    reason: delivered
      ? `Meldung zugestellt über ${deps.channel.id}.`
      : "Zustellung fehlgeschlagen.",
    runSessionId,
    text,
  };
}
