import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { type EventRecord, appendEventInTx, readEvents } from "../events/log.js";
import { redactText } from "../redaction/redact.js";
import {
  AGENT_COLUMNS,
  type AgentDraft,
  type AgentProfile,
  AgentProfileError,
  type AgentRow,
  type AgentStatus,
  toAgentProfile,
} from "./types.js";

/**
 * Die Agenten-Registry (S19): Lesen und Anlegen von `kuronami.agents`.
 *
 * ## Zwei Darstellungen, eine Transaktion — aber keine zweite Wahrheit
 *
 * Wie bei Artefakten (S06), Aufgaben (S10) und Freigaben (S11) entstehen Zeile und Ereignis
 * gemeinsam. Anders als beim **Plan** (`runtime/tasks/store.ts`) gibt es hier aber bewusst
 * **keine** Faltung "Registry aus dem Protokoll": das Protokoll ist je Session geführt, die
 * Registry gilt über alle Sessions. Ein Agent, der im April in einer Telegram-Session entstand,
 * ist im September in einer Heartbeat-Session derselbe — eine Faltung müsste dafür jedes
 * Protokoll der Datenbank lesen. Dieselbe Lage wie bei `kuronami.artifacts` (global, mit
 * `artifact.created` in der Session, die es erzeugt hat) und bei **dauerhaften** Freigaben
 * (S11: "der einzige Weg, an eine dauerhafte Freigabe zu kommen"). Die Zeile ist der Bestand,
 * das Ereignis die Herkunft.
 *
 * ## Kein Update, kein Löschen — in dieser Session
 *
 * S19 baut `agent.create` und `agent.delegate`. Ein `agent.update`/`agent.retire` wäre eine
 * eigene Entscheidung darüber, was mit laufenden Delegationen und mit einem Zeitplan passiert,
 * der gerade fällig ist; der Auftrag verlangt es nicht, und ein halb gebautes Ändern wäre
 * schlimmer als keins. `status` steht trotzdem schon in der Tabelle: der Heartbeat und
 * `agent.delegate` fragen ihn ab, damit ein späteres Pausieren nur noch eine Zeile schreiben
 * muss und nicht jede Leseseite nachziehen.
 */

const INSERT_AGENT_SQL = `
  INSERT INTO kuronami.agents
    (agent_id, name, role, purpose, system_prompt, model, tools, max_risk,
     max_steps, schedule, status, created_by, created_in_session)
  VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13)
  ON CONFLICT (name) DO NOTHING
  RETURNING ${AGENT_COLUMNS}
`;

const SELECT_BY_NAME_SQL = `SELECT ${AGENT_COLUMNS} FROM kuronami.agents WHERE name = $1`;

/** Ein Agent mit diesem Namen steht schon in der Registry. */
export class AgentNameTakenError extends Error {}

export interface InsertAgentOptions {
  /** Wer angelegt hat — der Auslöser aus Abschnitt 10. */
  createdBy: string;
  /** Die Aufrufkennung, unter der das geschah. Macht den Vorgang im Protokoll wiederfindbar. */
  callId?: string;
  status?: AgentStatus;
}

/**
 * Trägt ein geprüftes Profil ein und schreibt `agent.created` in derselben Transaktion.
 *
 * Der Redaction-Filter läuft hier, am einzigen Schreibtor in diese Tabelle (AGENTS.md): das
 * Profil ist Text, den ein Modell aus einem Nutzerauftrag gebaut hat, und ein Zugangsschlüssel
 * darin läge sonst dauerhaft in der Registry **und** in jedem System-Prompt, den ein Arbeiter
 * daraus bekommt. `name` wird dabei nicht ersetzt, sondern geprüft: er ist Identität (wie
 * `task_id` seit S10), und ein vom Filter veränderter Schlüssel taugt nicht mehr zum
 * Nachschlagen.
 */
export async function insertAgent(
  pool: Pool,
  sessionId: string,
  draft: AgentDraft,
  options: InsertAgentOptions,
): Promise<AgentProfile> {
  if (redactText(draft.name) !== draft.name) {
    throw new AgentProfileError(
      `Der Name "${draft.name}" wird vom Redaction-Filter verändert und taugt damit nicht als stabiler Schlüssel.`,
    );
  }

  const agentId = `agent_${randomUUID()}`;
  const fields = {
    role: redactText(draft.role),
    purpose: redactText(draft.purpose),
    systemPrompt: redactText(draft.system_prompt),
    model: redactText(draft.model),
  };
  const status: AgentStatus = options.status ?? "active";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const inserted = await client.query<AgentRow>(INSERT_AGENT_SQL, [
      agentId,
      draft.name,
      fields.role,
      fields.purpose,
      fields.systemPrompt,
      fields.model,
      JSON.stringify(draft.tools),
      draft.max_risk,
      draft.max_steps,
      draft.schedule,
      status,
      options.createdBy,
      sessionId,
    ]);

    if (inserted.rowCount === 0) {
      // `ON CONFLICT DO NOTHING` statt eines vorgeschalteten SELECT, aus demselben Grund wie
      // bei `createOrResumeSession` (S04): ein Blick vorher wäre ein Blick auf einen Zustand,
      // der beim INSERT schon ein anderer sein kann. Wer den Namen hält, entscheidet der
      // UNIQUE-Index, nicht die Reihenfolge zweier Anfragen.
      await client.query("ROLLBACK");
      throw new AgentNameTakenError(
        `Es gibt bereits einen Agenten mit dem Namen "${draft.name}". Namen sind der Handgriff von agent.delegate und deshalb eindeutig — wähle einen anderen.`,
      );
    }

    const profile = toAgentProfile(inserted.rows[0]);

    await appendEventInTx(client, sessionId, "agent.created", {
      agent_id: profile.agentId,
      name: profile.name,
      role: profile.role,
      purpose: profile.purpose,
      model: profile.model,
      tools: profile.tools,
      max_risk: profile.maxRisk,
      max_steps: profile.maxSteps,
      schedule: profile.schedule,
      status: profile.status,
      created_by: profile.createdBy,
      call_id: options.callId ?? null,
      // Der System-Prompt steht bewusst **nicht** im Ereignis: er steht vollständig in der
      // Zeile, und die Rückfrage, mit der der Nutzer ihn bestätigt hat, trägt ihn ebenfalls
      // (`approval.requested`, `details.profile`). Ein drittes Mal wäre Doppelrauschen.
    });

    await client.query("COMMIT");
    return profile;
  } catch (error) {
    if (!(error instanceof AgentNameTakenError)) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Ein Agent nach Namen. `null`, wenn es ihn nicht gibt. */
export async function readAgent(pool: Pool, name: string): Promise<AgentProfile | null> {
  const found = await pool.query<AgentRow>(SELECT_BY_NAME_SQL, [name]);
  const row = found.rows[0];
  return row ? toAgentProfile(row) : null;
}

export interface ListAgentsOptions {
  /** Vorgabe: nur `active` — wer delegieren will, will keine pausierten Agenten sehen. */
  status?: AgentStatus | "any";
  /** Nur Agenten mit Zeitplan. Der Lesepfad des Heartbeat-Dienstes. */
  scheduledOnly?: boolean;
}

export async function listAgents(
  pool: Pool,
  options: ListAgentsOptions = {},
): Promise<AgentProfile[]> {
  const status = options.status ?? "active";
  const rows = await pool.query<AgentRow>(
    `
    SELECT ${AGENT_COLUMNS} FROM kuronami.agents
    WHERE ($1::text = 'any' OR status = $1::kuronami.agent_status)
      AND ($2::boolean = false OR schedule IS NOT NULL)
    ORDER BY name
    `,
    [status, options.scheduledOnly === true],
  );
  return rows.rows.map(toAgentProfile);
}

/**
 * Hat **dieser Aufruf** in dieser Session schon einen Agenten angelegt?
 *
 * Die Wiederaufnahme-Frage aus S05, für ein `execution: "runtime"`-Tool: `agent.create` läuft
 * ohne Ausführungshülle (es hält für einen Menschen an, und ein Schritt, der stundenlang auf
 * `running` steht, wäre eine Falschaussage), hat also keinen Idempotenzschlüssel. Seine
 * Idempotenz kommt stattdessen aus dem Protokoll — wie bei `user.ask` (S10) und bei der
 * Freigabe-Rückfrage (S11): ein zweiter Anlauf mit derselben `call_id` findet sein eigenes
 * `agent.created` wieder und legt keinen zweiten Agenten an.
 */
export function findAgentCreatedByCall(events: EventRecord[], callId: string): string | null {
  for (const event of events) {
    if (event.type !== "agent.created") continue;
    if (event.payload.call_id !== callId) continue;
    return typeof event.payload.name === "string" ? event.payload.name : null;
  }
  return null;
}

/** Dasselbe, aber liest das Protokoll selbst. */
export async function agentCreatedByCall(
  pool: Pool,
  sessionId: string,
  callId: string,
): Promise<AgentProfile | null> {
  const name = findAgentCreatedByCall(await readEvents(pool, sessionId), callId);
  return name ? await readAgent(pool, name) : null;
}
