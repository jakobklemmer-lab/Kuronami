import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPolicyEngine } from "../../policy/engine.js";
import { createPool } from "../../runtime/db/pool.js";
import { readEvents } from "../../runtime/events/log.js";
import { createRunner } from "../../runtime/loop/api.js";
import { createScriptedModel } from "../../runtime/loop/scripted.js";
import type { ModelClient, ModelRequest, ModelResponse } from "../../runtime/model/types.js";
import { ToolRegistry } from "../registry.js";
import type { ToolCatalog } from "../types.js";
import { recallForTurn } from "./recall.js";
import { type MemoryStore, createMemoryStore, initMemoryRepo } from "./store.js";
import { NOTHING_MARKER, parseSummary, summarizeRun } from "./summary.js";
import { createMemoryTools } from "./tools.js";

/**
 * **Das Fertig-Kriterium von S18**, an der echten Schleife: eine Erkenntnis aus einem alten
 * Lauf wird bei einem neuen, thematisch verwandten Lauf automatisch gefunden — ohne dass das
 * Modell danach fragt und ohne dass die beiden Läufe etwas voneinander wissen.
 *
 * Die beiden Läufe sind bewusst **getrennte Sessions auf getrennten Fäden**. Alles, was sie
 * verbindet, ist das Gedächtnis auf der Platte; teilten sie eine Session, bewiese der Test nur,
 * dass eine Historie erhalten bleibt, und das ist seit S04 bekannt.
 */

const pool = createPool();
const threadIds: string[] = [];
let memoryRoot: string;
let artifactRoot: string;
let store: MemoryStore;
let catalog: ToolCatalog;

const CONVENTIONS = "Testkonventionen.";

/**
 * Für ein Drehbuch mit `steps: 0`. Es wird nie gerufen — und wirft statt still einen leeren
 * Schritt zu liefern, damit ein Drehbuch, das doch einen Aufruf verlangt, auffliegt statt
 * einen zu erfinden.
 */
function noSteps(): never {
  throw new Error("Dieses Drehbuch sieht keinen Werkzeugaufruf vor");
}

function policyEngine() {
  return createPolicyEngine({
    resolvePath: async () => {
      throw new Error("Dieser Katalog kennt keine Pfad-Tools");
    },
  });
}

/** Ein Modell, das die Anfragen mitschreibt, die es bekommt. */
function recordingModel(inner: ModelClient): {
  client: ModelClient;
  requests: ModelRequest[];
} {
  const requests: ModelRequest[] = [];
  return {
    requests,
    client: {
      model: inner.model,
      async complete(request: ModelRequest): Promise<ModelResponse> {
        requests.push(request);
        return await inner.complete(request);
      },
    },
  };
}

/** Der volle Text aller Nachrichten einer Anfrage — das, was das Modell wirklich liest. */
function promptText(request: ModelRequest): string {
  return JSON.stringify(request.messages);
}

async function newThread(): Promise<string> {
  const threadId = `thread_test_${randomUUID()}`;
  threadIds.push(threadId);
  return threadId;
}

beforeAll(async () => {
  memoryRoot = await mkdtemp(path.join(tmpdir(), "kuronami-recall-"));
  artifactRoot = await mkdtemp(path.join(tmpdir(), "kuronami-recall-art-"));
  await initMemoryRepo(memoryRoot, { git: false });
  store = await createMemoryStore({
    root: { root: memoryRoot },
    indexFile: ":memory:",
    git: false,
  });
  catalog = new ToolRegistry().registerAll(createMemoryTools({ store, pool })).freeze();
});

afterAll(async () => {
  if (threadIds.length > 0) {
    const sessions = "SELECT session_id FROM kuronami.sessions WHERE thread_id = ANY($1)";
    await pool.query(
      `DELETE FROM kuronami.artifacts WHERE (source ->> 'session_id') IN (${sessions})`,
      [threadIds],
    );
    for (const table of ["approvals", "tasks", "steps", "events"]) {
      await pool.query(`DELETE FROM kuronami.${table} WHERE session_id IN (${sessions})`, [
        threadIds,
      ]);
    }
    await pool.query("DELETE FROM kuronami.sessions WHERE thread_id = ANY($1)", [threadIds]);
  }
  await pool.end();
  store.close();
  const opts = { recursive: true, force: true, maxRetries: 10, retryDelay: 50 } as const;
  await rm(memoryRoot, opts);
  await rm(artifactRoot, opts);
});

// ---------------------------------------------------------------------------
// Das Fertig-Kriterium
// ---------------------------------------------------------------------------

describe("S18 · Fertig-Kriterium: alte Notiz wird bei neuem Lauf automatisch gefunden", () => {
  it("legt im ersten Lauf eine Erkenntnis ab und findet sie im zweiten, ohne dass jemand sucht", async () => {
    // ---- Lauf 1: eine Erkenntnis entsteht und wird abgelegt. ----
    const erstesModell = createScriptedModel(
      {
        steps: 1,
        step: () => ({
          toolName: "memory.write",
          input: {
            content:
              "Der Kalender-Workflow liefert Termine ohne Wiederholungsregeln. Wer eine Serie sehen will, muss die Einzeltermine aus der Antwort zusammensetzen; die Brücke tut das nicht.",
            tags: ["kalender", "wiederholung", "n8n"],
            title: "Kalender-Workflow liefert keine Wiederholungsregeln",
          },
        }),
        finalText: "Notiz abgelegt.",
      },
      "modell-lauf-eins",
    );

    const ersterLauf = await createRunner({
      pool,
      threadId: await newThread(),
      channel: "web",
      artifactRoot,
      catalog,
      policy: policyEngine(),
      model: erstesModell,
      conventions: CONVENTIONS,
      memory: store,
      // Die Nachbereitung ist hier aus: dieser Test prüft den Recall, nicht die
      // Zusammenfassung. Die hat ihren eigenen Abschnitt weiter unten.
      summarizeToMemory: false,
    });

    const erstes = await ersterLauf.run("Was liefert der Kalender-Workflow eigentlich alles?");
    expect(erstes.stop).toBe("done");
    await ersterLauf.stop("test");

    const notiz = store.all().find((entry) => entry.tags.includes("wiederholung"));
    expect(notiz).toBeDefined();
    if (!notiz) throw new Error("Notiz fehlt");

    // ---- Lauf 2: **neue Session, neuer Faden**, thematisch verwandte Eingabe. ----
    const zweitesModell = recordingModel(
      createScriptedModel(
        { steps: 0, step: noSteps, finalText: "Ich weiß Bescheid." },
        "modell-lauf-zwei",
      ),
    );

    const zweiterLauf = await createRunner({
      pool,
      threadId: await newThread(),
      channel: "web",
      artifactRoot,
      catalog,
      policy: policyEngine(),
      model: zweitesModell.client,
      conventions: CONVENTIONS,
      memory: store,
      summarizeToMemory: false,
    });

    // Die Frage benutzt **nicht** die Worte der Notiz: dort steht „Wiederholungsregeln",
    // hier „Serientermine". Gemeinsam sind nur „Kalender" und der Wortstamm „wiederhol".
    const zweites = await zweiterLauf.run(
      "Kann ich mir für den Kalender die Serientermine der nächsten Woche anzeigen lassen?",
    );
    expect(zweites.stop).toBe("done");

    // 1. Das Protokoll hält fest, dass gesucht wurde und was gefunden wurde.
    const events = await readEvents(pool, zweiterLauf.session.sessionId);
    const recalled = events.find((event) => event.type === "memory.recalled");
    expect(recalled, "kein memory.recalled im zweiten Lauf").toBeDefined();
    const notes = recalled?.payload.notes as { id: string; why: string }[];
    expect(notes.map((entry) => entry.id)).toContain(notiz.id);
    expect(notes.find((entry) => entry.id === notiz.id)?.why).toBe("treffer");

    // 2. Der Recall steht **vor** dem Zugbeginn — erst nachgeschlagen, dann eröffnet.
    const typen = events.map((event) => event.type);
    expect(typen.indexOf("memory.recalled")).toBeLessThan(typen.indexOf("turn.started"));

    // 3. Die Notiz steht in der Eröffnungsnachricht des Zugs.
    const started = events.find((event) => event.type === "turn.started");
    expect(started?.payload.prompt).toContain("<memory>");
    expect(started?.payload.prompt).toContain(notiz.id);
    expect(started?.payload.prompt).toContain("Wiederholungsregeln");

    // 4. **Und sie ist wirklich beim Modell angekommen.** Das ist der eigentliche Nachweis:
    //    nicht „steht im Protokoll", sondern „ging hinaus". Ohne diese Zusicherung könnte der
    //    Recall vollständig im Ereignis stattfinden und im Prompt fehlen.
    expect(zweitesModell.requests).toHaveLength(1);
    const gesendet = promptText(zweitesModell.requests[0]);
    expect(gesendet).toContain("Wiederholungsregeln");
    expect(gesendet).toContain(notiz.id);

    // 5. Das Modell hat **nicht** danach gesucht: kein einziger Werkzeugaufruf im zweiten Lauf.
    //    Genau das ist der Punkt — wer nicht weiß, dass es eine Notiz gibt, sucht nicht danach.
    expect(zweites.toolCalls).toBe(0);
    expect(typen).not.toContain("tool.requested");

    await zweiterLauf.stop("test");
  });

  it("Gegenprobe: ohne Gedächtnis im Lauf steht nichts im Prompt", async () => {
    // Der Test oben hängt am Gedächtnis und nicht daran, dass irgendein Text im Prompt steht.
    const modell = recordingModel(
      createScriptedModel(
        { steps: 0, step: noSteps, finalText: "Fertig." },
        "modell-ohne-gedaechtnis",
      ),
    );
    const lauf = await createRunner({
      pool,
      threadId: await newThread(),
      channel: "web",
      artifactRoot,
      catalog,
      policy: policyEngine(),
      model: modell.client,
      conventions: CONVENTIONS,
      // kein `memory`
      summarizeToMemory: false,
    });

    await lauf.run("Kann ich mir für den Kalender die Serientermine anzeigen lassen?");
    const events = await readEvents(pool, lauf.session.sessionId);
    expect(events.some((event) => event.type === "memory.recalled")).toBe(false);
    expect(events.find((event) => event.type === "turn.started")?.payload.prompt).not.toContain(
      "<memory>",
    );
    expect(promptText(modell.requests[0])).not.toContain("Wiederholungsregeln");
    await lauf.stop("test");
  });

  it("Gegenprobe: eine thematisch fremde Frage lädt die Notiz nicht", async () => {
    // Ein Recall, der immer alles lädt, bestünde den Test oben ebenfalls — und wäre wertlos.
    const modell = recordingModel(
      createScriptedModel(
        { steps: 0, step: noSteps, finalText: "Fertig." },
        "modell-fremdes-thema",
      ),
    );
    const lauf = await createRunner({
      pool,
      threadId: await newThread(),
      channel: "web",
      artifactRoot,
      catalog,
      policy: policyEngine(),
      model: modell.client,
      conventions: CONVENTIONS,
      memory: store,
      summarizeToMemory: false,
    });

    await lauf.run("Wie hoch ist die Verschuldung von Uruguay?");
    const events = await readEvents(pool, lauf.session.sessionId);
    const recalled = events.find((event) => event.type === "memory.recalled");
    // Gesucht wurde, gefunden wurde nichts — und der Block fehlt ersatzlos.
    expect(recalled?.payload.found).toBe(0);
    expect(events.find((event) => event.type === "turn.started")?.payload.prompt).not.toContain(
      "<memory>",
    );
    await lauf.stop("test");
  });
});

// ---------------------------------------------------------------------------
// Widersprüche im Recall
// ---------------------------------------------------------------------------

describe("Recall · Widersprüche", () => {
  it("lädt die neuere Gegennotiz mit, auch wenn nur die alte getroffen hat", async () => {
    // Sonst wäre die Suche der Ort, an dem ein Widerspruch doch still verschwindet: das
    // Modell läse die alte Fassung und wüsste nichts von der Korrektur.
    const alt = await store.write({
      content: "Die Egress-Liste wird beim Prozessstart aus der Umgebungsvariablen gelesen.",
      tags: ["egress"],
      title: "Egress kommt aus der Umgebung",
      today: new Date(2026, 8, 1),
    });
    const neu = await store.write({
      content:
        "Richtigstellung: sie kommt aus der Katalogkonfiguration und nur ersatzweise von dort.",
      tags: ["egress"],
      title: "Egress kommt aus dem Katalog",
      supersedes: [alt.note.id],
      today: new Date(2026, 8, 9),
    });

    const result = recallForTurn(store, "Woher stammt die Egress-Liste?");
    const ids = result.notes.map((entry) => entry.id);
    expect(ids).toContain(alt.note.id);
    expect(ids).toContain(neu.note.id);
    expect(result.block).toContain("ACHTUNG");
    expect(result.block).toContain(neu.note.id);
  });

  it("holt die Gegennotiz auch dann, wenn das Limit schon voll ist", async () => {
    // Eine Korrektur zu unterschlagen, weil die Liste voll ist, wäre genau der stille Verlust,
    // den S18 ausschließt.
    const alt = await store.write({
      content: "Die Mail-Brücke stellt Anhänge bis zur Postfachgrenze immer als Datei zu.",
      tags: ["anhaenge"],
      title: "Anhänge immer als Datei",
      today: new Date(2026, 8, 1),
    });
    const neu = await store.write({
      content: "Berichtigt: sehr große Anhänge kommen als Verweis, nicht als Datei.",
      tags: ["anhaenge"],
      title: "Große Anhänge als Verweis",
      supersedes: [alt.note.id],
      today: new Date(2026, 8, 9),
    });

    // Gesucht wird mit einem Wort, das **nur** in der alten Notiz steht. Sie ist damit der
    // einzige Treffer, und das Limit ist mit ihr ausgeschöpft — die Korrektur kommt trotzdem
    // mit, ohne gegen das Limit zu zählen.
    const result = recallForTurn(store, "Postfachgrenze", 1);
    const treffer = result.notes.filter((entry) => entry.why === "treffer");
    expect(treffer.map((entry) => entry.id)).toEqual([alt.note.id]);
    expect(result.notes.find((entry) => entry.id === neu.note.id)?.why).toBe("widerspruch");
    expect(result.block).toContain(neu.note.id);
  });

  it("sagt im Block, dass Notizen Erinnerung und keine Anweisung sind", () => {
    const result = recallForTurn(store, "Egress-Liste");
    expect(result.block).toContain("keine Anweisung");
    expect(result.block).toContain("Konventionen");
  });
});

// ---------------------------------------------------------------------------
// Die Zusammenfassung nach dem Lauf
// ---------------------------------------------------------------------------

describe("Zusammenfassung · Auswahl", () => {
  it("liest NICHTS als bewusste Auswahl, nicht als Fehlschlag", () => {
    expect(parseSummary(NOTHING_MARKER)).toBeNull();
    expect(parseSummary("  nichts  ")).toBeNull();
    expect(parseSummary("")).toBeNull();
  });

  it("zerlegt eine vollständige Antwort", () => {
    const parsed = parseSummary(
      [
        "TITEL: Der Workflow kennt keine Serien",
        "TAGS: kalender, n8n",
        "ERSETZT: 2026-09-01-alte-notiz",
        "---",
        "Der Kalender-Workflow liefert Einzeltermine.",
      ].join("\n"),
    );
    expect(parsed?.title).toBe("Der Workflow kennt keine Serien");
    expect(parsed?.tags).toEqual(["kalender", "n8n"]);
    expect(parsed?.supersedes).toEqual(["2026-09-01-alte-notiz"]);
    expect(parsed?.body).toBe("Der Kalender-Workflow liefert Einzeltermine.");
  });

  it("wirft bei einer halb erkannten Notiz, statt sie stumm zu verwerfen", () => {
    // Ein stiller Verlust sähe aus wie eine bewusste Auswahl — und genau das darf er nicht.
    expect(() => parseSummary("TITEL: Ohne Trennlinie und ohne Tags")).toThrow(/Trennlinie/);
    expect(() => parseSummary("TITEL: Da\n---\nText ohne Tags")).toThrow(/unvollständig/);
    expect(() => parseSummary("TAGS: a, b\n---\nText ohne Titel")).toThrow(/unvollständig/);
  });

  it("schreibt memory.skipped, wenn der Lauf nichts hinterlässt", async () => {
    const threadId = await newThread();
    const runner = await createRunner({
      pool,
      threadId,
      channel: "web",
      artifactRoot,
      catalog,
      policy: policyEngine(),
      model: createScriptedModel(
        { steps: 0, step: noSteps, finalText: "Erledigt." },
        "modell-leer",
      ),
      conventions: CONVENTIONS,
      memory: store,
      summarizeToMemory: false,
    });

    const outcome = await runner.run("Wie spät ist es?");
    const before = store.count();

    await summarizeRun({
      pool,
      model: {
        model: "modell-nichts",
        complete: async () => ({
          model: "modell-nichts",
          stopReason: "end_turn",
          text: NOTHING_MARKER,
          toolCalls: [],
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
          content: [{ type: "text", text: NOTHING_MARKER }],
        }),
      },
      catalog,
      policy: policyEngine(),
      artifactRoot,
      store,
      session: runner.session,
      turnId: outcome.turnId,
      input: "Wie spät ist es?",
      outcomeText: outcome.text,
      steps: [],
    });

    expect(store.count()).toBe(before);
    const events = await readEvents(pool, runner.session.sessionId);
    const skipped = events.find((event) => event.type === "memory.skipped");
    expect(skipped).toBeDefined();
    expect(skipped?.payload.decided_by).toBe("model");
    await runner.stop("test");
  });

  it("legt die Notiz über den Router ab, wenn der Lauf etwas hinterlässt", async () => {
    // Der Schreibweg führt durch Katalog, Policy und Ausführungshülle — nicht daran vorbei.
    // Nur deshalb greift die Schreibgrenze für Hintergrundläufe auch hier.
    const threadId = await newThread();
    const runner = await createRunner({
      pool,
      threadId,
      channel: "web",
      artifactRoot,
      catalog,
      policy: policyEngine(),
      model: createScriptedModel(
        { steps: 0, step: noSteps, finalText: "Erledigt." },
        "modell-lauf",
      ),
      conventions: CONVENTIONS,
      memory: store,
      summarizeToMemory: false,
    });

    const outcome = await runner.run("Prüf mal den Mail-Anbieter.");
    const antwort = [
      "TITEL: Der Mail-Anbieter drosselt ab fünfzig Abrufen je Stunde",
      "TAGS: mail, drosselung",
      "---",
      "Ab etwa fünfzig Abrufen in der Stunde antwortet der Anbieter mit 429 und einer",
      "Wartezeit von fünf Minuten. Für Stapelabrufe lohnt sich eine Pause dazwischen.",
    ].join("\n");

    const result = await summarizeRun({
      pool,
      model: {
        model: "modell-fasst-zusammen",
        complete: async () => ({
          model: "modell-fasst-zusammen",
          stopReason: "end_turn",
          text: antwort,
          toolCalls: [],
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
          content: [{ type: "text", text: antwort }],
        }),
      },
      catalog,
      policy: policyEngine(),
      artifactRoot,
      store,
      session: runner.session,
      turnId: outcome.turnId,
      input: "Prüf mal den Mail-Anbieter.",
      outcomeText: outcome.text,
      steps: ["- mail.search (ok): 3 Treffer"],
    });

    expect(result.noteId).not.toBeNull();
    const abgelegt = store.get(result.noteId as string);
    expect(abgelegt?.tags).toEqual(["mail", "drosselung"]);
    expect(abgelegt?.body).toContain("429");

    // Der Aufruf steht im Protokoll wie jeder andere, mit seiner Herkunft.
    const events = await readEvents(pool, runner.session.sessionId);
    const requested = events.find(
      (event) => event.type === "tool.requested" && event.payload.tool_name === "memory.write",
    );
    expect(requested?.payload.origin).toBe("run_summary");
    expect(events.some((event) => event.type === "policy.allowed")).toBe(true);
    await runner.stop("test");
  });

  it("überlebt eine Zusammenfassung, die scheitert, ohne den Lauf zu beschädigen", async () => {
    // Ein Lauf, der erfolgreich war, ist nicht nachträglich fehlgeschlagen, weil seine
    // Nachbereitung es war. Der Fehler landet im Protokoll, nicht im Ergebnis.
    const threadId = await newThread();
    const runner = await createRunner({
      pool,
      threadId,
      channel: "web",
      artifactRoot,
      catalog,
      policy: policyEngine(),
      model: createScriptedModel(
        { steps: 0, step: noSteps, finalText: "Erledigt." },
        "modell-lauf",
      ),
      conventions: CONVENTIONS,
      memory: store,
      summarizeToMemory: false,
    });

    const outcome = await runner.run("Irgendeine Aufgabe.");
    const result = await summarizeRun({
      pool,
      model: {
        model: "modell-kaputt",
        complete: async () => {
          throw new Error("Anbieter nicht erreichbar");
        },
      },
      catalog,
      policy: policyEngine(),
      artifactRoot,
      store,
      session: runner.session,
      turnId: outcome.turnId,
      input: "Irgendeine Aufgabe.",
      outcomeText: outcome.text,
      steps: [],
    });

    expect(result.noteId).toBeNull();
    expect(result.reason).toContain("Anbieter nicht erreichbar");
    const events = await readEvents(pool, runner.session.sessionId);
    const raised = events.find((event) => event.type === "error.raised");
    expect(raised?.payload.where).toBe("memory.summary");
    await runner.stop("test");
  });

  it("schreibt nichts, wenn der Katalog kein memory.write kennt", async () => {
    // Der Fall des Hintergrundlaufs: die Whitelist lässt `memory.write` gar nicht erst zu.
    // Der Katalog ist die Obergrenze, die Policy-Regel die Zusage — beide greifen.
    const nurSuche = new ToolRegistry()
      .registerAll(createMemoryTools({ store, pool }).filter((t) => t.name === "memory.search"))
      .freeze();
    const threadId = await newThread();
    const runner = await createRunner({
      pool,
      threadId,
      channel: "web",
      artifactRoot,
      catalog: nurSuche,
      policy: policyEngine(),
      model: createScriptedModel(
        { steps: 0, step: noSteps, finalText: "Erledigt." },
        "modell-lauf",
      ),
      conventions: CONVENTIONS,
      memory: store,
      summarizeToMemory: false,
    });

    const outcome = await runner.run("Eine Hintergrundaufgabe.");
    const before = store.count();
    const result = await summarizeRun({
      pool,
      model: {
        model: "sollte-nie-gefragt-werden",
        complete: async () => {
          throw new Error("Das Modell darf hier gar nicht erst gefragt werden");
        },
      },
      catalog: nurSuche,
      policy: policyEngine(),
      artifactRoot,
      store,
      session: runner.session,
      turnId: outcome.turnId,
      input: "Eine Hintergrundaufgabe.",
      outcomeText: outcome.text,
      steps: [],
    });

    expect(result.noteId).toBeNull();
    expect(store.count()).toBe(before);
    const skipped = (await readEvents(pool, runner.session.sessionId)).find(
      (event) => event.type === "memory.skipped",
    );
    expect(skipped?.payload.decided_by).toBe("runtime");
    await runner.stop("test");
  });
});
