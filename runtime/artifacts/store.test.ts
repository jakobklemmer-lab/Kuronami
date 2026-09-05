import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../db/pool.js";
import { readEvents } from "../events/log.js";
import { createOrResumeSession } from "../session/manager.js";
import {
  ArtifactFileMissingError,
  ArtifactInputError,
  ArtifactIntegrityError,
  ArtifactNotFoundError,
  ArtifactUriError,
  headArtifact,
  readArtifact,
  writeArtifact,
} from "./store.js";
import type { ArtifactSource, WriteArtifactInput } from "./types.js";

const pool = createPool();
const threadIds: string[] = [];
let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kuronami-artifacts-"));
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

function input(sessionId: string, overrides: Partial<WriteArtifactInput> = {}): WriteArtifactInput {
  const source: ArtifactSource = {
    tool: "web.fetch",
    sessionId,
    stepId: `step_${randomUUID()}`,
    ...overrides.source,
  };
  return {
    content: "hallo welt",
    mimeType: "text/plain",
    summary: "kurzer Testinhalt",
    ...overrides,
    source,
  };
}

describe("Artefaktspeicher", () => {
  it("schreibt 5 MB und gibt ein Handle unter 100 Zeichen zurück", async () => {
    const sessionId = await newSession();
    const content = Buffer.alloc(5 * 1024 * 1024, 0x61);
    const expectedSha = createHash("sha256").update(content).digest("hex");

    const meta = await writeArtifact(pool, root, {
      content,
      mimeType: "application/octet-stream",
      summary: "5-MB-Blob aus dem S06-Test",
      source: { tool: "exec.run", sessionId, stepId: "step_blob" },
    });

    // Das Handle ist eine kompakte Referenz, kein Transport für den Inhalt.
    expect(meta.uri.startsWith("artifact://")).toBe(true);
    expect(meta.uri.length).toBeLessThan(100);

    expect(meta.sizeBytes).toBe(5 * 1024 * 1024);
    expect(meta.sha256).toBe(expectedSha);

    // Die Datei liegt am Pfad, auf den die URI abbildet, und ist vollständig.
    const onDisk = await stat(path.join(root, sessionId, meta.artifactId));
    expect(onDisk.size).toBe(5 * 1024 * 1024);

    // Kein .tmp bleibt zurück: der Rename hat stattgefunden.
    expect(await readdir(path.join(root, sessionId))).toEqual([meta.artifactId]);
  });

  it("liefert mit head() die Metadaten, ohne die Datei zu lesen", async () => {
    const sessionId = await newSession();
    const meta = await writeArtifact(pool, root, input(sessionId, { summary: "head-Probe" }));

    // Die Datei verschwindet — head() darf das nicht bemerken.
    await rm(path.join(root, sessionId, meta.artifactId));

    const head = await headArtifact(pool, meta.uri);
    expect(head).toEqual(meta);
    expect(head.summary).toBe("head-Probe");
    expect(head.sizeBytes).toBe(Buffer.byteLength("hallo welt", "utf8"));

    // Gegenprobe: read() braucht die Datei wirklich und sagt es, statt still etwas zu liefern.
    await expect(readArtifact(pool, root, meta.uri)).rejects.toThrow(ArtifactFileMissingError);
  });

  it("liest exakt die geschriebenen Bytes zurück", async () => {
    const sessionId = await newSession();
    const content = Buffer.from([0, 1, 2, 0, 255, 254, 10, 13, 0, 42]);

    const meta = await writeArtifact(pool, root, {
      content,
      mimeType: "application/octet-stream",
      summary: "Binärinhalt mit Nullbytes",
      source: { tool: "fs.read", sessionId, stepId: null },
    });

    const read = await readArtifact(pool, root, meta.uri);
    expect(read.bytes.equals(content)).toBe(true);
    expect(read.mimeType).toBe("application/octet-stream");
    expect(read.summary).toBe("Binärinhalt mit Nullbytes");
    expect(read.sha256).toBe(meta.sha256);
  });

  it("schreibt Metadatenzeile und Ereignis artifact.created in einer Transaktion", async () => {
    const sessionId = await newSession();
    const meta = await writeArtifact(pool, root, input(sessionId));

    const rows = await pool.query(
      "SELECT artifact_id, uri, mime_type, summary, sha256, size_bytes, source FROM kuronami.artifacts WHERE uri = $1",
      [meta.uri],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].artifact_id).toBe(meta.artifactId);
    expect(Number(rows.rows[0].size_bytes)).toBe(meta.sizeBytes);

    const events = await readEvents(pool, sessionId);
    const last = events.at(-1);
    expect(last?.type).toBe("artifact.created");
    expect(last?.payload).toMatchObject({
      artifact_id: meta.artifactId,
      uri: meta.uri,
      sha256: meta.sha256,
      size_bytes: meta.sizeBytes,
      mime_type: "text/plain",
      summary: "kurzer Testinhalt",
    });
  });

  it("speichert die Herkunft vollständig", async () => {
    const sessionId = await newSession();
    const meta = await writeArtifact(pool, root, {
      content: "x",
      mimeType: "text/plain",
      summary: "Herkunftsprobe",
      source: { tool: "web.fetch", sessionId, stepId: "step_abc123" },
    });

    const head = await headArtifact(pool, meta.uri);
    expect(head.source).toEqual({ tool: "web.fetch", sessionId, stepId: "step_abc123" });

    // Der Ausdrucksindex aus 0001 ist befüllt: nach Session gefiltert findet die Zeile sich.
    const bySession = await pool.query(
      "SELECT 1 FROM kuronami.artifacts WHERE (source ->> 'session_id') = $1 AND uri = $2",
      [sessionId, meta.uri],
    );
    expect(bySession.rowCount).toBe(1);
  });

  it("nimmt einen schrittlosen Ursprung an (step_id null)", async () => {
    const sessionId = await newSession();
    const meta = await writeArtifact(pool, root, {
      content: "ohne Schritt",
      mimeType: "text/plain",
      summary: "vor jedem Schritt entstanden",
      source: { tool: "agent.delegate", sessionId, stepId: null },
    });

    const head = await headArtifact(pool, meta.uri);
    expect(head.source.stepId).toBeNull();

    // Die Einfügung ist durch: der CHECK `source ? 'step_id'` trägt auch bei JSON-null,
    // weil er die Präsenz des Schlüssels prüft, nicht den Wert.
    const row = await pool.query(
      "SELECT source ? 'step_id' AS has_key, source ->> 'step_id' AS value FROM kuronami.artifacts WHERE uri = $1",
      [meta.uri],
    );
    expect(row.rows[0].has_key).toBe(true);
    expect(row.rows[0].value).toBeNull();
  });

  it("weist ein leeres summary ab, ohne etwas zu hinterlassen", async () => {
    const sessionId = await newSession();

    await expect(writeArtifact(pool, root, input(sessionId, { summary: "   " }))).rejects.toThrow(
      ArtifactInputError,
    );

    // Keine Datei, kein Verzeichnis, kein Ereignis über session.created hinaus.
    expect(existsSync(path.join(root, sessionId))).toBe(false);
    const events = await readEvents(pool, sessionId);
    expect(events.map((event) => event.type)).toEqual(["session.created"]);

    // Gegenprobe: mit echter Zusammenfassung geht derselbe Aufruf durch.
    const meta = await writeArtifact(pool, root, input(sessionId, { summary: "jetzt gültig" }));
    expect(meta.summary).toBe("jetzt gültig");
  });

  it("gibt jedem Schreibvorgang eine eigene Kennung, auch bei gleichem Inhalt", async () => {
    const sessionId = await newSession();
    const same = input(sessionId, {
      content: "identischer Inhalt",
      summary: "zweimal geschrieben",
      source: { tool: "web.fetch", sessionId, stepId: "step_dup" },
    });

    const first = await writeArtifact(pool, root, same);
    const second = await writeArtifact(pool, root, same);

    expect(first.artifactId).not.toBe(second.artifactId);
    expect(first.uri).not.toBe(second.uri);
    expect(first.sha256).toBe(second.sha256);

    // Beide liegen unabhängig und lesbar da: nichts wurde überschrieben (Unveränderlichkeit).
    expect((await readArtifact(pool, root, first.uri)).bytes.toString("utf8")).toBe(
      "identischer Inhalt",
    );
    expect((await readArtifact(pool, root, second.uri)).bytes.toString("utf8")).toBe(
      "identischer Inhalt",
    );
  });

  it("erkennt eine nachträglich veränderte Datei beim Lesen", async () => {
    const sessionId = await newSession();
    const meta = await writeArtifact(pool, root, input(sessionId, { content: "unverfälscht" }));

    // Ein Byte kippen, Länge gleich lassen: nur die Prüfsumme kann das noch fangen.
    const filePath = path.join(root, sessionId, meta.artifactId);
    const bytes = await readFile(filePath);
    bytes[0] ^= 0xff;
    await writeFile(filePath, bytes);

    await expect(readArtifact(pool, root, meta.uri)).rejects.toThrow(ArtifactIntegrityError);
    await expect(readArtifact(pool, root, meta.uri)).rejects.toThrow(/SHA-256/);

    // head() bleibt unberührt: es liest die Datei nicht.
    expect((await headArtifact(pool, meta.uri)).sha256).toBe(meta.sha256);
  });

  it("wirft bei einer wohlgeformten, aber unbekannten URI", async () => {
    const sessionId = await newSession();
    const unknown = `artifact://${sessionId}/artifact_${randomUUID()}`;

    await expect(headArtifact(pool, unknown)).rejects.toThrow(ArtifactNotFoundError);
    await expect(readArtifact(pool, root, unknown)).rejects.toThrow(ArtifactNotFoundError);
  });

  it("weist kaputte URIs an der Grenze ab", async () => {
    const broken = [
      "http://example.test/x",
      "artifact://",
      "artifact://nurateil",
      "artifact://a/b/c",
      "artifact://../etc/passwd",
      "artifact://sess x/artifact y",
      "artifact://sess/../artifact",
    ];
    for (const uri of broken) {
      await expect(headArtifact(pool, uri)).rejects.toThrow(ArtifactUriError);
    }
  });

  it("weist ein Artefakt zu einer unbekannten Session ab, ohne eine Datei zu hinterlassen", async () => {
    const ghost = `sess_${randomUUID()}`;

    await expect(
      writeArtifact(pool, root, {
        content: "verwaist",
        mimeType: "text/plain",
        summary: "sollte nie geschrieben werden",
        source: { tool: "web.fetch", sessionId: ghost, stepId: null },
      }),
    ).rejects.toThrow(/existiert nicht/);

    expect(existsSync(path.join(root, ghost))).toBe(false);
  });
});
