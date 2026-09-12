import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../db/pool.js";
import { readEvents } from "../events/log.js";
import type { BuiltCatalog } from "../loop/api.js";
import { buildCatalog } from "../loop/api.js";
import { createOrResumeSession } from "../session/manager.js";
import { FIRST_CASTING, castingDraft, seedFirstCasting } from "./besetzung.js";
import { checkAgentDraft } from "./types.js";

/**
 * Die erste Besetzung (S20) — sieben Rollen, geprüft gegen den echten Katalog.
 *
 * Der Zweck dieser Datei ist derselbe wie der von `skills/skills.test.ts` (S18d): sie prüft den
 * **echten Bestand** und keine Fixtur. Ein Tippfehler in einem Toolnamen der Besetzung fällt
 * hier auf und nicht erst nachts in einem Lauf nach Zeitplan.
 */

const pool = createPool();
const sessionIds: string[] = [];
/** Nur, was **dieser** Test angelegt hat. Eine echte Besetzung in der Datenbank bleibt stehen. */
const createdHere: string[] = [];
let sourceRoot: string;
let built: BuiltCatalog;
let sessionId: string;

beforeAll(async () => {
  sourceRoot = await mkdtemp(path.join(tmpdir(), "kuronami-besetzung-"));
  const artifactRoot = path.join(sourceRoot, "artifacts");
  await mkdir(artifactRoot, { recursive: true });

  // Der größtmögliche Katalog, wie in `pnpm agents:seed`: die Registry ist prozessunabhängig,
  // und die Assistenz-Tools stehen im Katalog, ob ihre n8n-Instanz antwortet oder nicht.
  built = await buildCatalog({
    pool,
    artifactRoot,
    sourceRoot,
    n8n: { mail: true, cal: true, server: true },
    memory: { root: path.join(sourceRoot, "memory"), indexFile: ":memory:", git: false },
    skills: { root: path.join(sourceRoot, "skills") },
  });

  const { session } = await createOrResumeSession(pool, {
    threadId: `thread_besetzung_test_${randomUUID()}`,
    channel: "web",
  });
  sessionId = session.sessionId;
  sessionIds.push(sessionId);
});

afterAll(async () => {
  built?.memory?.close();
  if (createdHere.length > 0) {
    await pool.query("DELETE FROM kuronami.agents WHERE name = ANY($1)", [createdHere]);
  }
  if (sessionIds.length > 0) {
    await pool.query("DELETE FROM kuronami.events WHERE session_id = ANY($1)", [sessionIds]);
    await pool.query("DELETE FROM kuronami.sessions WHERE session_id = ANY($1)", [sessionIds]);
  }
  await pool.end();
  if (sourceRoot) await rm(sourceRoot, { recursive: true, force: true });
});

describe("Erste Besetzung · die sieben Rollen aus Abschnitt 14", () => {
  it("nennt genau die sieben Rollen, die die Architektur nennt", () => {
    expect(FIRST_CASTING.map((entry) => entry.name)).toEqual([
      "coder",
      "visualizer",
      "ui-designer",
      "lore-writer",
      "trading-agent",
      "backtest-agent",
      "mail-agent",
    ]);
  });

  it("hält jedes Profil gegen den echten Katalog", () => {
    for (const entry of FIRST_CASTING) {
      const draft = checkAgentDraft(castingDraft(entry), { catalog: built.catalog });
      expect(draft.name).toBe(entry.name);
      // Jede Rolle hat eine abschließende Werkzeugliste, ein Schrittbudget und ein
      // Token-Budget — die drei Obergrenzen aus Abschnitt 14.
      expect(draft.tools.length).toBeGreaterThan(0);
      expect(draft.max_steps).toBeGreaterThan(0);
      expect(draft.token_budget).not.toBeNull();
      for (const tool of draft.tools) expect(built.catalog.get(tool)).toBeDefined();
    }
  });

  it("gibt keinem Agenten ein Werkzeug über seiner Risiko-Obergrenze", () => {
    for (const entry of FIRST_CASTING) {
      const draft = checkAgentDraft(castingDraft(entry), { catalog: built.catalog });
      for (const name of draft.tools) {
        const tool = built.catalog.get(name);
        expect(tool).toBeDefined();
        // `checkAgentDraft` wirft bei einem Verstoß; diese Zusicherung hält fest, dass keine
        // der sieben Rollen die Zusatzbestätigung aus S19 nötig hätte.
        expect(["read", "soft_write"]).toContain(tool?.risk);
      }
      expect(draft.max_risk).toBe("soft_write");
    }
  });

  it("gibt keinem Agenten agent.*, user.ask oder irgendein Versandwerkzeug", () => {
    for (const entry of FIRST_CASTING) {
      for (const tool of entry.tools) {
        expect(tool.startsWith("agent.")).toBe(false);
        expect(tool).not.toBe("user.ask");
        expect(tool.endsWith(".send")).toBe(false);
      }
    }
    // Der Mail-Agent im Besonderen: entwerfen ja, versenden nein — und `mail.send` gibt es im
    // ganzen Katalog nicht (S14, "Senden ist technisch unmöglich").
    const mail = FIRST_CASTING.find((entry) => entry.name === "mail-agent");
    expect(mail?.tools).toEqual(["mail.search", "mail.read", "mail.draft"]);
    expect(built.catalog.get("mail.send")).toBeUndefined();
  });

  it("wählt für den Mail-Agenten das günstige Modell (Abschnitt 14)", () => {
    const mail = FIRST_CASTING.find((entry) => entry.name === "mail-agent");
    expect(mail?.model_class).toBe("routine");
    // Und der Coder, der plant und formuliert, bekommt das starke (Abschnitt 11).
    expect(FIRST_CASTING.find((entry) => entry.name === "coder")?.model_class).toBe("thinking");
  });

  it("legt die fehlenden Rollen an und meldet beim zweiten Lauf nur noch Vorhandenes", async () => {
    const first = await seedFirstCasting(pool, sessionId, { catalog: built.catalog });
    createdHere.push(...first.created.map((profile) => profile.name));
    expect(first.skipped).toEqual([]);

    // Nach dem Lauf stehen alle sieben in der Registry — egal, ob dieser Lauf sie angelegt hat
    // oder ein früherer.
    expect(first.created.length + first.existing.length).toBe(FIRST_CASTING.length);
    for (const profile of first.created) {
      expect(profile.status).toBe("active");
      expect(profile.createdBy).toBe("besetzung");
      expect(profile.tokenBudget).not.toBeNull();
    }

    // Idempotent: der zweite Lauf schreibt nichts.
    const second = await seedFirstCasting(pool, sessionId, { catalog: built.catalog });
    expect(second.created).toEqual([]);
    expect(second.existing.sort()).toEqual(FIRST_CASTING.map((entry) => entry.name).sort());

    // Und jede angelegte Rolle hat ihre Herkunft im Protokoll.
    const events = await readEvents(pool, sessionId);
    for (const profile of first.created) {
      expect(
        events.filter(
          (event) => event.type === "agent.created" && event.payload.name === profile.name,
        ),
      ).toHaveLength(1);
    }
  });
});
