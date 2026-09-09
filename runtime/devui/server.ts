import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import express from "express";
import { deriveLoopState } from "../../context/transcript.js";
import { createPool } from "../db/pool.js";
import { readEvents } from "../events/log.js";
import { type BuiltCatalog, type Runner, buildCatalog, createRunner } from "../loop/api.js";
import { type ScriptedStep, type ScriptedTask, createScriptedModel } from "../loop/scripted.js";
import type { ModelClient } from "../model/types.js";
import { deriveSessionState } from "../session/state.js";
import type { SessionChannel } from "../session/types.js";

/**
 * Eine minimale Dev-Oberfläche für den Loop (S12b, außerplanmäßig).
 *
 * **Prüf-Werkzeug, kein produktiver Teil** — dieselbe Rolle wie `tools/dummies.ts` und
 * `runtime/loop/scripted.ts`. Es liegt bewusst unter `runtime/devui/` und nicht in einer
 * eigenen Schicht: die Surface-Schicht nach Abschnitt 3 ist austauschbar, und diese hier ist
 * ein Wegwerf-Fenster, um den restlichen Plan zu testen — kein Kanal, keine Auth, kein Design.
 *
 * Die drei Endpunkte sind **read-mostly**: `/sessions` und `/sessions/:id/events` lesen nur
 * das Protokoll und falten es (`deriveSessionState` aus S05, `deriveLoopState` aus S12).
 * `/sessions/:id/answer` ist der einzige Schreibpfad — er ruft `Runner.answer()` aus der
 * S12-API und stößt den offenen Zug wieder an, damit der Lauf weiterläuft. Kein neuer
 * Zustand in der Datenbank, keine neue Tabelle.
 *
 * Das Modell ist das Drehbuch aus S12 (`createScriptedModel`), kein Anbieter — die Oberfläche
 * soll ohne `ANTHROPIC_API_KEY` und ohne Netz einen echten Lauf zeigen, samt Freigabestelle.
 */

const PORT = Number(process.env.DEVUI_PORT ?? 8787);
const STEP_DELAY_MS = Number(process.env.DEVUI_STEP_DELAY_MS ?? 1200);
const RUN_DEMO = process.env.DEVUI_NO_DEMO !== "1";
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Die Aufgabe des Drehbuchs: Plan setzen, in den Artefaktbereich schreiben, einmal in die
 * Quellzone (das ist die Freigabestelle), wieder lesen. Sechs Werkzeugaufrufe. */
const DEMO_TASK: ScriptedTask = {
  steps: 6,
  finalText:
    "Fertig: Plan gesetzt, drei Notizen und ein Bericht geschrieben, eine Notiz gegengelesen.",
  step(index): ScriptedStep {
    if (index === 1) {
      return {
        toolName: "task.set",
        input: {
          tasks: [
            { id: "notizen", title: "Notizen schreiben", status: "in_progress" },
            { id: "bericht", title: "Bericht schreiben", status: "queued" },
            { id: "gegenlesen", title: "Eine Notiz gegenlesen", status: "queued" },
          ],
        },
      };
    }
    if (index === 4) {
      // Quellzone statt Artefaktbereich: hartes Schreiben, braucht nach Abschnitt 10 eine
      // Freigabe. Genau hier hält der Lauf an und wartet auf einen Klick in der Oberfläche.
      return {
        toolName: "fs.write",
        input: { path: "bericht.txt", content: "Bericht aus dem DevUI-Demolauf.\n" },
      };
    }
    if (index === 6) {
      return { toolName: "fs.read", input: { path: "artifacts/notiz-1.txt" } };
    }
    const n = index < 4 ? index - 1 : index - 2;
    return {
      toolName: "fs.write",
      input: { path: `artifacts/notiz-${n}.txt`, content: `Notiz ${n} aus dem Demolauf.\n` },
    };
  },
};

/** Ein Drehbuch-Modell mit einer Pause je Zug, damit die Oberfläche den Fortschritt zeigt. */
function pacedModel(): ModelClient {
  const inner = createScriptedModel(DEMO_TASK, "modell-nach-drehbuch (devui)");
  return {
    model: inner.model,
    async complete(request) {
      if (STEP_DELAY_MS > 0) await sleep(STEP_DELAY_MS);
      return inner.complete(request);
    },
  };
}

const pool = createPool();
let scratchRoot = "";
let artifactRoot = "";
let built: BuiltCatalog;
/** Läufe, die dieser Prozess selbst gestartet hat. Rein flüchtig — kein Zustand, den
 * irgendwer wiederfinden müsste; ein Neustart lässt sie liegen und `resumeRunner` baut bei
 * Bedarf einen neuen. */
const liveRunners = new Map<string, Runner>();

/** Treibt einen offenen Zug bis zu seinem nächsten Halt (fertig, Freigabe nötig, Grenze). */
async function drive(runner: Runner, input?: string): Promise<void> {
  try {
    const outcome = input === undefined ? await runner.run() : await runner.run(input);
    console.log(
      `[devui] Lauf ${runner.session.sessionId.slice(0, 16)}…: ${outcome.stop} — ${outcome.reason}`,
    );
  } catch (error) {
    console.error(`[devui] Lauf ${runner.session.sessionId} abgebrochen:`, error);
  }
}

/** Baut einen Läufer für eine bestehende Session (nach Prozess-Neustart oder für Fremdläufe). */
async function resumeRunner(sessionId: string): Promise<Runner> {
  const row = await pool.query<{ thread_id: string; channel: SessionChannel }>(
    "SELECT thread_id, channel FROM kuronami.sessions WHERE session_id = $1",
    [sessionId],
  );
  if (row.rowCount === 0) throw new Error(`Session ${sessionId} ist unbekannt.`);
  return createRunner({
    pool,
    threadId: row.rows[0].thread_id,
    channel: row.rows[0].channel,
    artifactRoot,
    catalog: built.catalog,
    policy: built.policy,
    model: pacedModel(),
    conventions: "Kein ORM. Fehler nie verstecken.",
  });
}

async function startDemoRun(): Promise<void> {
  const runner = await createRunner({
    pool,
    threadId: `thread_devui_${Date.now()}`,
    channel: "web",
    artifactRoot,
    catalog: built.catalog,
    policy: built.policy,
    model: pacedModel(),
    conventions: "Kein ORM. Fehler nie verstecken.",
  });
  liveRunners.set(runner.session.sessionId, runner);
  console.log(`[devui] Demolauf gestartet: Session ${runner.session.sessionId}`);
  void drive(
    runner,
    "Lege einen Plan an, schreibe drei Notizen und einen Bericht und lies eine Notiz wieder ein.",
  );
}

const app = express();
app.use(express.json());

app.get("/", (_req, res) => {
  res.sendFile(path.join(HERE, "index.html"));
});

/** Alle Sessions mit ihrem gefalteten Zustand. Reiner Leser auf `kuronami.sessions` plus
 * `deriveSessionState` je Zeile (S05). */
app.get("/sessions", async (_req, res, next) => {
  try {
    const rows = await pool.query<{
      session_id: string;
      thread_id: string;
      channel: string;
      created_at: Date;
    }>(
      "SELECT session_id, thread_id, channel, created_at FROM kuronami.sessions ORDER BY created_at DESC LIMIT 50",
    );
    const sessions = await Promise.all(
      rows.rows.map(async (row) => {
        const state = deriveSessionState(row.session_id, await readEvents(pool, row.session_id));
        return {
          sessionId: row.session_id,
          threadId: row.thread_id,
          channel: row.channel,
          createdAt: row.created_at,
          status: state.status,
          steps: state.steps.length,
          awaiting: state.pendingUserInput.length,
          live: liveRunners.has(row.session_id),
        };
      }),
    );
    res.json({ sessions });
  } catch (error) {
    next(error);
  }
});

/** Die gefaltete Historie einer Session: Zustand (S05) und Loop-Stand (S12) aus demselben
 * Protokoll, dazu die rohe Ereignisliste als dünner Zeitstrahl für die Anzeige. */
app.get("/sessions/:id/events", async (req, res, next) => {
  try {
    const sessionId = req.params.id;
    const events = await readEvents(pool, sessionId);
    if (events.length === 0) {
      const exists = await pool.query("SELECT 1 FROM kuronami.sessions WHERE session_id = $1", [
        sessionId,
      ]);
      if (exists.rowCount === 0) {
        res.status(404).json({ error: `Session ${sessionId} ist unbekannt.` });
        return;
      }
    }
    const loop = deriveLoopState(events);
    const session = deriveSessionState(sessionId, events);
    res.json({
      sessionId,
      live: liveRunners.has(sessionId),
      session: {
        status: session.status,
        pendingUserInput: session.pendingUserInput,
        steps: session.steps.map((step) => ({
          stepId: step.stepId,
          toolName: step.toolName,
          status: step.status,
          attempt: step.attempt,
        })),
      },
      loop: {
        turnId: loop.turnId,
        toolCalls: loop.toolCalls,
        consecutiveErrors: loop.consecutiveErrors,
        offloadedResults: loop.offloadedResults,
        messages: loop.messages,
      },
      events: events.map((event) => ({
        seq: event.seq,
        type: event.type,
        createdAt: event.createdAt,
      })),
    });
  } catch (error) {
    next(error);
  }
});

/** Der einzige Schreibpfad: eine offene Rückfrage beantworten und den Zug wieder anstoßen.
 * `askId` trägt sein Präfix (`policy:` / `ask:`), `Runner.answer` unterscheidet daran. */
app.post("/sessions/:id/answer", async (req, res, next) => {
  try {
    const sessionId = req.params.id;
    const { askId, choiceId } = req.body ?? {};
    if (typeof askId !== "string" || typeof choiceId !== "string") {
      res.status(400).json({ error: "askId und choiceId (beide string) sind erforderlich." });
      return;
    }

    const known = liveRunners.get(sessionId);
    const runner = known ?? (await resumeRunner(sessionId));
    await runner.answer(askId, choiceId);

    void (async () => {
      await drive(runner);
      if (!known) await runner.stop("devui-answer").catch(() => {});
    })().catch((error) => console.error("[devui] Fortsetzen nach Antwort fehlgeschlagen:", error));

    res.status(202).json({ ok: true, askId, choiceId });
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
    console.error("[devui]", error);
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  },
);

async function main(): Promise<void> {
  scratchRoot = await mkdtemp(path.join(tmpdir(), "kuronami-devui-"));
  artifactRoot = path.join(scratchRoot, "artifacts");
  built = await buildCatalog({ pool, artifactRoot, sourceRoot: scratchRoot });

  const server = app.listen(PORT, () => {
    console.log(`[devui] http://localhost:${PORT}  (Katalog ${built.catalog.version})`);
  });

  if (RUN_DEMO) {
    await startDemoRun().catch((error) => console.error("[devui] Demolauf fehlgeschlagen:", error));
  }

  let stopped = false;
  async function shutdown(signal: string): Promise<void> {
    if (stopped) return;
    stopped = true;
    console.log(`\n[devui] ${signal} — herunterfahren.`);
    server.close();
    for (const runner of liveRunners.values()) await runner.stop(signal).catch(() => {});
    await pool.end().catch(() => {});
    if (scratchRoot) await rm(scratchRoot, { recursive: true, force: true }).catch(() => {});
    process.exit(0);
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => void shutdown(signal));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
