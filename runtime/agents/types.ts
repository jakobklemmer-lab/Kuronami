import { type RiskLevel, assertRiskLevel, riskRank } from "../../policy/risk.js";
import type { ToolCatalog } from "../../tools/types.js";
import { parseCron } from "../schedule/cron.js";

/**
 * Was ein Agent ist (S19) — die Felder aus `kuronami.agents` und die Prüfungen, die ein
 * Profil bestehen muss, bevor es in die Registry darf.
 *
 * Die Prüfungen stehen **hier** und nicht im Tool: `agent.create` ist nicht der einzige Weg in
 * die Tabelle (S20 legt die erste Besetzung an, ein Betreiber kann eine Zeile schreiben), und
 * eine Prüfung, die nur an einem von mehreren Wegen hängt, ist keine. Dieselbe Zweitorigkeit
 * wie bei der Risikostufe seit S11: Registry **und** Engine prüfen, weil TypeScript nur den
 * Weg absichert, der im Repo steht.
 */

/** Entspricht `kuronami.agent_status` aus Migration 0009. */
export const AGENT_STATUSES = ["active", "paused", "retired"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** Ein Profil passt nicht: fehlendes Feld, unbekanntes Tool, Stufe über der Obergrenze, … */
export class AgentProfileError extends Error {}

/**
 * Die Form eines Agentennamens: kleingeschrieben, Bindestriche als Trenner — wie ein
 * Skill-Verzeichnis (S18c) und aus demselben Grund geprüft wie ein Toolname (S07): zwei
 * Schreibweisen desselben Agenten wären zwei Agenten, und `agent.delegate` fände mal den
 * einen, mal den anderen. Die Datenbank prüft dieselbe Form (`agents_name_form`).
 */
const AGENT_NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 40;

/** Obergrenze für `max_steps`, gespiegelt aus `agents_max_steps_range` (Migration 0009). */
export const MAX_AGENT_STEPS = 200;

/**
 * Untergrenze für ein gesetztes `token_budget` (S20). Unterhalb eines einzigen Modellaufrufs
 * ist ein Budget kein Budget: der Lauf endete, bevor der Arbeiter das erste Mal gefragt hat.
 * `DEFAULT_MAX_TOKENS` (16k) ist allein die Antwortseite eines Aufrufs — 20k ist die knappste
 * Zahl, bei der ein einzelner Zug überhaupt stattfinden kann.
 */
export const MIN_TOKEN_BUDGET = 20_000;

export function assertAgentName(value: unknown): asserts value is string {
  if (typeof value !== "string" || !AGENT_NAME_PATTERN.test(value)) {
    throw new AgentProfileError(
      `Agentenname "${String(value)}" passt nicht zur Form: kleingeschrieben, Ziffern und Bindestriche, beginnend mit einem Buchstaben (z. B. "mail-waechter").`,
    );
  }
  if (value.length > MAX_NAME_LENGTH) {
    throw new AgentProfileError(
      `Agentenname "${value}" ist länger als ${MAX_NAME_LENGTH} Zeichen.`,
    );
  }
}

/** Ein Agent, wie er in der Registry steht. */
export interface AgentProfile {
  agentId: string;
  name: string;
  role: string;
  purpose: string;
  systemPrompt: string;
  model: string;
  /** Die vollständige Liste der Toolnamen, die dieser Agent aufrufen darf. Obergrenze. */
  tools: string[];
  /** Die Risikostufe (Abschnitt 10), bis zu der dieser Agent gehen darf. */
  maxRisk: RiskLevel;
  /** Werkzeugaufrufe je Lauf — wie oft dieser Agent handeln darf (Abschnitt 14). */
  maxSteps: number;
  /**
   * Token-Budget je Lauf (S20, Abschnitt 14) oder `null` für keins. Begrenzt, was ein Lauf
   * **kostet**, während `maxSteps` begrenzt, wie oft er handelt — zwei verschiedene Aussagen:
   * fünf Schritte mit einem großen Anhang im Kontext kosten mehr als vierzig kleine.
   */
  tokenBudget: number | null;
  /** Cron-Ausdruck oder `null`. Gesetzt heißt: der Heartbeat lässt ihn nach Zeitplan laufen. */
  schedule: string | null;
  status: AgentStatus;
  createdBy: string;
  createdInSession: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Ein Profil, wie es aus einem Entwurf kommt — vom Modell (`agent.create`, S19) oder aus der
 * Hand (S20). Feldnamen in snake_case, weil das hier kein internes TypeScript-Objekt ist,
 * sondern ein Übertragungsformat: genau diese Form entwirft das Modell als JSON, und genau so
 * steht sie in der Rückfrage im Protokoll.
 */
export interface AgentDraft {
  name: string;
  role: string;
  purpose: string;
  system_prompt: string;
  model: string;
  tools: string[];
  max_risk: RiskLevel;
  max_steps: number;
  token_budget: number | null;
  schedule: string | null;
}

export interface AgentRow {
  agent_id: string;
  name: string;
  role: string;
  purpose: string;
  system_prompt: string;
  model: string;
  tools: string[];
  max_risk: RiskLevel;
  max_steps: number;
  token_budget: number | null;
  schedule: string | null;
  status: AgentStatus;
  created_by: string;
  created_in_session: string | null;
  created_at: Date;
  updated_at: Date;
}

export const AGENT_COLUMNS = `
  agent_id, name, role, purpose, system_prompt, model, tools, max_risk,
  max_steps, token_budget, schedule, status, created_by, created_in_session,
  created_at, updated_at
`;

export function toAgentProfile(row: AgentRow): AgentProfile {
  return {
    agentId: row.agent_id,
    name: row.name,
    role: row.role,
    purpose: row.purpose,
    systemPrompt: row.system_prompt,
    model: row.model,
    tools: [...row.tools],
    maxRisk: row.max_risk,
    maxSteps: row.max_steps,
    tokenBudget: row.token_budget,
    schedule: row.schedule,
    status: row.status,
    createdBy: row.created_by,
    createdInSession: row.created_in_session,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Der Entwurf eines bereits eingetragenen Agenten — für `agent.delegate` und Tests. */
export function draftOf(profile: AgentProfile): AgentDraft {
  return {
    name: profile.name,
    role: profile.role,
    purpose: profile.purpose,
    system_prompt: profile.systemPrompt,
    model: profile.model,
    tools: [...profile.tools],
    max_risk: profile.maxRisk,
    max_steps: profile.maxSteps,
    token_budget: profile.tokenBudget,
    schedule: profile.schedule,
  };
}

function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AgentProfileError(`Profilfeld "${field}" fehlt oder ist leer.`);
  }
  const text = value.trim();
  if (text.length > max) {
    throw new AgentProfileError(
      `Profilfeld "${field}" ist ${text.length} Zeichen lang, erlaubt sind ${max}.`,
    );
  }
  return text;
}

export interface DraftCheck {
  /** Der Katalog des Prozesses. Jedes Tool des Profils muss darin stehen. */
  catalog: ToolCatalog;
  /**
   * Tools, die ein Agent nie bekommt, auch wenn sie im Katalog stehen. In der Verdrahtung sind
   * das die `agent.*`-Tools selbst (keine rekursiven Subagenten, Abschnitt 14) und `user.ask`
   * (ein Arbeiter hat kein Gegenüber, das antwortet — den Vertrag mit dem Nutzer hält der
   * Hauptagent).
   */
  forbiddenTools?: readonly string[];
}

/**
 * Prüft einen Entwurf und gibt ihn in aufgeräumter Form zurück. Wirft bei allem, was ein
 * Profil unbrauchbar macht — und zwar mit einem Satz, der sagt, **was** nicht stimmt: der
 * Fehler landet als Tool-Hülle im Kontext, und das Modell soll den Entwurf in einem Zug
 * reparieren können, nicht in fünf (dieselbe Haltung wie `validateToolInput`, S07).
 *
 * Die inhaltlich wichtigste Prüfung ist die letzte: **ein Tool über der Obergrenze des Profils
 * ist ein Widerspruch, kein Detail.** Ein Agent mit `max_risk: read` und `notes.write` in der
 * Liste sähe aus wie ein Agent, der schreiben darf, und liefe bei jedem Versuch in eine
 * Ablehnung — oder, schlimmer, jemand hebt später die Obergrenze an und bekommt stillschweigend
 * mehr, als er beim Anlegen bestätigt hat.
 */
export function checkAgentDraft(draft: unknown, check: DraftCheck): AgentDraft {
  if (typeof draft !== "object" || draft === null || Array.isArray(draft)) {
    throw new AgentProfileError("Das Profil muss ein Objekt sein.");
  }
  const raw = draft as Record<string, unknown>;

  const name = requireText(raw.name, "name", MAX_NAME_LENGTH);
  assertAgentName(name);

  const role = requireText(raw.role, "role", 80);
  const purpose = requireText(raw.purpose, "purpose", 500);
  const systemPrompt = requireText(raw.system_prompt, "system_prompt", 4_000);
  const model = requireText(raw.model, "model", 120);

  if (!Array.isArray(raw.tools) || raw.tools.length === 0) {
    throw new AgentProfileError(
      'Profilfeld "tools" muss mindestens ein Tool nennen: Werkzeug-Zugriff ist rollenspezifisch, nie pauschal (Abschnitt 14). Ein Agent ohne Werkzeuge kann nichts tun.',
    );
  }

  const forbidden = new Set(check.forbiddenTools ?? []);
  const tools: string[] = [];
  for (const entry of raw.tools) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new AgentProfileError('Profilfeld "tools" enthält einen Eintrag, der kein Name ist.');
    }
    const toolName = entry.trim();
    if (tools.includes(toolName)) continue;
    if (forbidden.has(toolName)) {
      throw new AgentProfileError(
        `Tool "${toolName}" bekommt kein Agent: ${
          toolName.startsWith("agent.")
            ? "es gibt keine rekursiven Subagenten (Abschnitt 14)"
            : "ein Arbeiter hat kein Gegenüber, das eine Rückfrage beantwortet"
        }.`,
      );
    }
    if (!check.catalog.get(toolName)) {
      throw new AgentProfileError(
        `Tool "${toolName}" steht nicht im Katalog dieses Prozesses (${check.catalog.version}). Bekannt sind: ${check.catalog.tools
          .map((tool) => tool.name)
          .filter((tool) => !forbidden.has(tool))
          .join(", ")}.`,
      );
    }
    tools.push(toolName);
  }

  assertRiskLevel(raw.max_risk, `Profil "${name}"`);
  const maxRisk = raw.max_risk;

  const maxSteps = raw.max_steps ?? 25;
  if (
    !Number.isInteger(maxSteps) ||
    (maxSteps as number) < 1 ||
    (maxSteps as number) > MAX_AGENT_STEPS
  ) {
    throw new AgentProfileError(
      `Profilfeld "max_steps" muss eine ganze Zahl zwischen 1 und ${MAX_AGENT_STEPS} sein (war: ${String(raw.max_steps)}).`,
    );
  }

  // Das Token-Budget (S20). `null`/fehlend heißt ausdrücklich "kein Budget" — eine geratene
  // Vorgabe sähe aus wie eine entschiedene, und ein zu knapp geratenes Budget bräche jeden Lauf
  // dieses Agenten ab, ohne dass jemand es entschieden hätte.
  let tokenBudget: number | null = null;
  if (raw.token_budget !== undefined && raw.token_budget !== null) {
    const value = raw.token_budget;
    if (!Number.isInteger(value) || (value as number) < MIN_TOKEN_BUDGET) {
      throw new AgentProfileError(
        `Profilfeld "token_budget" muss eine ganze Zahl ab ${MIN_TOKEN_BUDGET} sein oder fehlen (war: ${String(value)}). Ein Budget unterhalb eines einzigen Modellaufrufs ist kein Budget, sondern ein Agent, der nie etwas tut.`,
      );
    }
    tokenBudget = value as number;
  }

  let schedule: string | null = null;
  if (raw.schedule !== undefined && raw.schedule !== null && String(raw.schedule).trim() !== "") {
    schedule = String(raw.schedule).trim();
    // Wirft `CronParseError` bei allem, was nicht der Form entspricht. Der Ausdruck wird
    // **beim Anlegen** geprüft und nicht erst beim ersten fälligen Lauf: ein Zeitplan, der
    // stumm nie feuert, sieht aus wie ein Agent, der nichts zu melden hat.
    parseCron(schedule);
  }

  for (const toolName of tools) {
    const tool = check.catalog.get(toolName);
    if (tool && riskRank(tool.risk) > riskRank(maxRisk)) {
      throw new AgentProfileError(
        `Tool "${toolName}" ist "${tool.risk}", die Obergrenze des Profils ist "${maxRisk}". Entweder die Obergrenze anheben (dann braucht das Anlegen eine Zusatzbestätigung) oder das Tool weglassen.`,
      );
    }
  }

  return {
    name,
    role,
    purpose,
    system_prompt: systemPrompt,
    model,
    tools,
    max_risk: maxRisk,
    max_steps: maxSteps as number,
    token_budget: tokenBudget,
    schedule,
  };
}

/**
 * Verlangt ein Profil eine **Zusatzbestätigung**? Ja, sobald seine Obergrenze hartes Schreiben
 * oder Zerstörendes zulässt (Abschnitt 10: "Freigabe nötig" bzw. "immer Freigabe").
 *
 * Der Unterschied zu einem einzelnen Tool-Aufruf ist der Grund, warum es diese zweite Frage
 * überhaupt gibt: eine Freigabe deckt **einen** Aufruf, ein Profil deckt **jeden künftigen**
 * Aufruf dieses Agenten — auch die, die nach Zeitplan laufen, während niemand zusieht. Was
 * hier bestätigt wird, ist deshalb keine Aktion, sondern eine stehende Erlaubnis.
 */
export function needsExtraConfirmation(maxRisk: RiskLevel): boolean {
  return riskRank(maxRisk) >= riskRank("hard_write");
}
