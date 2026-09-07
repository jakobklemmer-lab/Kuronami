import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPrompt } from "../../context/prompt.js";
import { writeArtifact } from "../artifacts/store.js";
import { createPool } from "../db/pool.js";
import { appendEvent, readEvents } from "../events/log.js";
import { createOrResumeSession } from "../session/manager.js";

/**
 * Der Nachweis für Abschnitt 4.7: ein Geheimnis erreicht "nie den Prompt, nie ein Artefakt,
 * nie das Ereignisprotokoll". Geprüft werden alle drei Schreibpfade mit demselben Wert, und
 * zwar nicht am Rückgabewert der jeweiligen Funktion, sondern an dem, was tatsächlich auf
 * der Platte, in der Datenbank und im zusammengesetzten Prompt steht.
 */

/** Erfundener Schlüssel in echter Form. Steht so in keinem Konto. */
const FAKE_KEY =
  "sk-ant-api03-Aa0Bb1Cc2Dd3Ee4Ff5Gg6Hh7Ii8Jj9Kk0Ll1Mm2Nn3Oo4Pp5Qq6Rr7Ss8Tt9-TESTONLY";

const pool = createPool();
const threadIds: string[] = [];
let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kuronami-redaction-"));
});

afterAll(async () => {
  if (threadIds.length > 0) {
    const sessions = "SELECT session_id FROM kuronami.sessions WHERE thread_id = ANY($1)";
    await pool.query(
      `DELETE FROM kuronami.artifacts WHERE (source ->> 'session_id') IN (${sessions})`,
      [threadIds],
    );
    await pool.query(`DELETE FROM kuronami.events WHERE session_id IN (${sessions})`, [threadIds]);
    await pool.query("DELETE FROM kuronami.sessions WHERE thread_id = ANY($1)", [threadIds]);
  }
  await pool.end();
  if (root) await rm(root, { recursive: true, force: true });
});

async function newSession(): Promise<string> {
  const threadId = `thread_test_${randomUUID()}`;
  threadIds.push(threadId);
  const { session } = await createOrResumeSession(pool, { threadId, channel: "web" });
  return session.sessionId;
}

/** Was wirklich in der Spalte steht, nicht was die Schreibfunktion zurückgab. */
async function rawEventPayloads(sessionId: string): Promise<string> {
  const rows = await pool.query<{ payload: string }>(
    "SELECT payload::text AS payload FROM kuronami.events WHERE session_id = $1 ORDER BY seq",
    [sessionId],
  );
  return rows.rows.map((row) => row.payload).join("\n");
}

async function rawArtifactRow(uri: string): Promise<string> {
  const rows = await pool.query<{ row: string }>(
    "SELECT (to_jsonb(a) #>> '{}') AS row FROM kuronami.artifacts a WHERE uri = $1",
    [uri],
  );
  return rows.rows.map((row) => row.row).join("\n");
}

describe("Redaction-Filter · Schreibpfade", () => {
  it("hält ein Geheimnis aus dem Ereignisprotokoll fern, auch tief verschachtelt", async () => {
    const sessionId = await newSession();

    await appendEvent(pool, sessionId, "tool.completed", {
      tool_name: "web.fetch",
      // Erstens im Klartext mitten im Fließtext,
      note: `Aufruf mit ${FAKE_KEY} beantwortet`,
      // zweitens tief in einem verschachtelten Objekt in einem Array,
      structured: { runs: [{ request: { headers: { authorization: `Bearer ${FAKE_KEY}` } } }] },
      // drittens unter einem geheimen Feldnamen mit unauffälligem Wert.
      config: { api_key: "hunter2", database_url: "postgres://kuronami:hunter2@localhost/db" },
    });

    const stored = await rawEventPayloads(sessionId);
    expect(stored).not.toContain(FAKE_KEY);
    expect(stored).not.toContain("hunter2");
    expect(stored).toContain("[redacted:");

    // Auch der Lesepfad gibt nichts her — der Record kommt aus dem RETURNING der Einfügung.
    const events = await readEvents(pool, sessionId);
    expect(JSON.stringify(events)).not.toContain(FAKE_KEY);

    // Gegenprobe in dieselbe Richtung: das Unverdächtige steht noch da. Ein Filter, der
    // alles ersetzt, bestünde diesen Test auch — und wäre wertlos.
    expect(stored).toContain("web.fetch");
    expect(stored).toContain("Aufruf mit ");
  });

  it("hält ein Geheimnis aus den Artefaktmetadaten fern", async () => {
    const sessionId = await newSession();

    const meta = await writeArtifact(pool, root, {
      content: "unbedenklicher Rumpf",
      mimeType: "text/plain",
      summary: `Antwort der API, geholt mit ${FAKE_KEY}`,
      source: { tool: `web.fetch?token=${FAKE_KEY}`, sessionId, stepId: "step_probe" },
    });

    expect(meta.summary).not.toContain(FAKE_KEY);
    expect(meta.summary).toContain("[redacted:anthropic-api-key]");
    expect(meta.source.tool).not.toContain(FAKE_KEY);

    // Die Zeile selbst, vollständig als Text.
    expect(await rawArtifactRow(meta.uri)).not.toContain(FAKE_KEY);

    // Und das Ereignis artifact.created, das seit S06 summary und source mitträgt.
    expect(await rawEventPayloads(sessionId)).not.toContain(FAKE_KEY);

    // Das Handle bleibt heil: der Speicher findet sein eigenes Artefakt wieder.
    expect(meta.uri).toBe(`artifact://${sessionId}/${meta.artifactId}`);
  });

  it("hält ein Geheimnis aus dem zusammengesetzten Prompt fern", () => {
    const prompt = buildPrompt({
      systemPrompt: `Du bist Kuronami.\nANTHROPIC_API_KEY=${FAKE_KEY}`,
      toolStubs: [
        { name: "web.fetch", description: `Holt eine Seite, Bearer ${FAKE_KEY}`, risk: "read" },
      ],
      memory: [`Konvention: der Schlüssel lautet ${FAKE_KEY}`],
      sessionSummary: `Letzter Aufruf nutzte ${FAKE_KEY}`,
      recent: [
        { role: "user", content: `Nimm ${FAKE_KEY}` },
        { role: "tool", content: { status: "ok", structured: { api_key: "hunter2" } } },
      ],
      userInput: `Und noch einmal mit ${FAKE_KEY}`,
    });

    expect(prompt.text).not.toContain(FAKE_KEY);
    expect(prompt.text).not.toContain("hunter2");
    expect(prompt.cachePrefix).not.toContain(FAKE_KEY);
    // Nicht nur der zusammengefügte Text: wer die Abschnitte einzeln an die API gibt (als
    // Content-Blöcke), bekommt dieselben gefilterten Zeichenketten.
    for (const part of prompt.sections) {
      expect(part.text, part.id).not.toContain(FAKE_KEY);
    }

    // Reihenfolge und Vollständigkeit aus Abschnitt 7 stehen, auch nach dem Filter.
    expect(prompt.sections.map((part) => part.id)).toEqual([
      "system",
      "memory",
      "session_state",
      "recent",
      "user_input",
    ]);
    expect(prompt.text).toContain("Du bist Kuronami.");
    expect(prompt.text).toContain("web.fetch");
  });

  it("findet denselben Schlüssel nach einem vollen Durchlauf in keinem der drei Pfade", async () => {
    const sessionId = await newSession();

    // Ein Lauf, wie ihn ein Tool auslöst: Artefakt schreiben, Ergebnis protokollieren,
    // Ergebnis in den nächsten Prompt heben. Der Schlüssel steht überall dort, wo er
    // versehentlich landen könnte.
    const meta = await writeArtifact(pool, root, {
      content: "Rumpf der Antwort",
      mimeType: "application/json",
      summary: `Ergebnis von web.fetch (Authorization: Bearer ${FAKE_KEY})`,
      source: { tool: "web.fetch", sessionId, stepId: "step_full" },
    });

    await appendEvent(pool, sessionId, "step.completed", {
      step_id: "step_full",
      idempotency_key: "tool:call_full",
      attempt: 1,
      result: {
        status: "ok",
        summary: `geholt mit ${FAKE_KEY}`,
        artifact_refs: [meta.uri],
        structured: { credentials: { api_key: FAKE_KEY } },
      },
    });

    const events = await readEvents(pool, sessionId);
    const prompt = buildPrompt({
      systemPrompt: "Du bist Kuronami.",
      sessionSummary: `Artefakt ${meta.uri} — ${meta.summary}`,
      recent: events.map((event) => ({ role: "tool" as const, content: event.payload })),
      // Absichtlich roh und nicht aus dem Protokoll gezogen. Speiste sich der Prompt hier
      // ausschließlich aus `readEvents`, hinge dieser Test am Filter des Protokolls und der
      // Prompt-Pfad wäre nur scheinbar mitgeprüft — als Gegenprobe genau so beobachtet.
      userInput: `Fass zusammen, Schlüssel ist ${FAKE_KEY}.`,
    });

    const paths = {
      "Event-Payload": await rawEventPayloads(sessionId),
      "Artefakt-Metadaten": await rawArtifactRow(meta.uri),
      Prompt: prompt.text,
    };

    for (const [name, content] of Object.entries(paths)) {
      expect(content, `${name} enthält den Schlüssel im Klartext`).not.toContain(FAKE_KEY);
    }

    // Und der Beleg, dass die drei Pfade überhaupt Inhalt tragen: ein leerer Prompt und
    // eine leere Zeile bestünden den Test oben ebenfalls.
    expect(paths["Event-Payload"]).toContain("tool:call_full");
    expect(paths["Artefakt-Metadaten"]).toContain(meta.artifactId);
    expect(paths.Prompt).toContain(meta.uri);
  });
});
