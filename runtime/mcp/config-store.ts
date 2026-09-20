import type { Pool } from "pg";

/**
 * Die MCP-Server-Konfiguration (Nachtrag 2026-09-16, Migration 0011): Lesen und Schreiben von
 * `kuronami.mcp_servers`. Dieselbe Rolle wie `runtime/secrets/env-file.ts` (S33) für die
 * Provider-Schlüssel — eine Oberfläche schreibt, `gateway/index.ts` liest beim nächsten Start
 * —, nur strukturiert statt Zeilen einer `.env`, weil ein Server mehr als einen Skalarwert
 * mitbringt (Kommando, Argumente, Umgebungsvariablen).
 *
 * **Nur stdio-Server** (S27: kein zweiter Transport). `command`/`args`/`env` sind die Felder,
 * die das Agent-SDK für einen stdio-Server braucht; `gateway/index.ts` liest sie beim Start und
 * reicht sie als `mcpServers` in den Lauf.
 */

export class McpServerConfigInputError extends Error {}

/**
 * Die vier Risikostufen. Sie standen bis 2026-09-20 in `policy/risk.ts`, mitten in der
 * Governance-Schicht des alten Motors — die ist mit ihm gegangen. Geblieben ist die eine Stelle,
 * die sie wirklich braucht: ein MCP-Server entsteht aus JSON und kommt damit am Compiler vorbei.
 * Die Stufe wird hier geprüft, nicht vorausgesetzt.
 */
export const RISK_LEVELS = ["read", "soft_write", "hard_write", "destructive"] as const;

export type RiskLevel = (typeof RISK_LEVELS)[number];

/** Ein Server ohne (gültige) Risikostufe. */
export class RiskLevelError extends Error {}

/**
 * Auf eine fehlende Stufe antwortet diese Prüfung nicht mit einer Vorgabe: eine geratene Stufe
 * wäre schlimmer als keine, weil sie nach einer Entscheidung aussieht.
 */
export function assertRiskLevel(value: unknown, context: string): asserts value is RiskLevel {
  if (typeof value !== "string" || !(RISK_LEVELS as readonly string[]).includes(value)) {
    throw new RiskLevelError(
      `${context}: Risikostufe "${String(value)}" ist keine der vier (${RISK_LEVELS.join(", ")}). Ohne Zuordnung wird ein Server nicht aufgenommen.`,
    );
  }
}

const SERVER_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

export interface McpServerRecord {
  serverId: string;
  command: string;
  args: string[];
  /** Nie im Klartext nach draußen (siehe `mcp-servers`-Route in `gateway/server.ts`) — dieselbe
   * Zurückhaltung wie bei den Provider-Schlüsseln (S33). */
  env: Record<string, string>;
  risk: RiskLevel;
  repeatable: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface McpServerRow {
  server_id: string;
  command: string;
  args: unknown;
  env: unknown;
  risk: RiskLevel;
  repeatable: boolean;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = "server_id, command, args, env, risk, repeatable, enabled, created_at, updated_at";

function toRecord(row: McpServerRow): McpServerRecord {
  return {
    serverId: row.server_id,
    command: row.command,
    args: Array.isArray(row.args) ? row.args.map(String) : [],
    env:
      row.env && typeof row.env === "object" && !Array.isArray(row.env)
        ? (row.env as Record<string, string>)
        : {},
    risk: row.risk,
    repeatable: row.repeatable,
    enabled: row.enabled,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export interface McpServerInput {
  serverId: string;
  command: string;
  args?: readonly string[];
  env?: Record<string, string>;
  risk: unknown;
  repeatable?: boolean;
  enabled?: boolean;
}

/**
 * Geprüft, bevor irgendetwas die Datenbank sieht — dieselbe Zweiteilung wie bei
 * `assertRiskLevel` selbst (AGENTS.md: Fehler nie verstecken, am Rand mit Begründung). Wirft
 * `McpServerConfigInputError`.
 */
function validate(input: McpServerInput): {
  serverId: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  risk: RiskLevel;
  repeatable: boolean;
  enabled: boolean;
} {
  if (!SERVER_ID_PATTERN.test(input.serverId)) {
    throw new McpServerConfigInputError(
      `server_id "${input.serverId}" passt nicht auf ${SERVER_ID_PATTERN} — wird Teil des lokalen Toolnamens (mcp.<id>__<...>).`,
    );
  }
  const command = input.command.trim();
  if (command === "") {
    throw new McpServerConfigInputError(`Server "${input.serverId}": Kommando fehlt.`);
  }
  assertRiskLevel(input.risk, `MCP-Server "${input.serverId}"`);
  return {
    serverId: input.serverId,
    command,
    args: (input.args ?? []).map(String),
    env: input.env ?? {},
    risk: input.risk,
    repeatable: input.repeatable ?? true,
    enabled: input.enabled ?? true,
  };
}

export async function listMcpServers(pool: Pool): Promise<McpServerRecord[]> {
  const result = await pool.query<McpServerRow>(
    `SELECT ${COLUMNS} FROM kuronami.mcp_servers ORDER BY server_id`,
  );
  return result.rows.map(toRecord);
}

/** Nur die aktivierten — der Lesepfad, den `gateway/index.ts` beim Start tatsächlich braucht. */
export async function listEnabledMcpServers(pool: Pool): Promise<McpServerRecord[]> {
  const result = await pool.query<McpServerRow>(
    `SELECT ${COLUMNS} FROM kuronami.mcp_servers WHERE enabled ORDER BY server_id`,
  );
  return result.rows.map(toRecord);
}

/**
 * Legt an oder ändert. `args`/`env`/`repeatable`/`enabled` sind beim Bearbeiten optional und
 * bleiben unverändert, wenn sie fehlen — vor allem für `env` wichtig: die Oberfläche bekommt
 * seine Werte nie zu sehen (siehe `McpServerRecord.env`), ein Bearbeiten des Kommandos darf sie
 * deshalb nicht stillschweigend leeren. Erst lesen, dann mit dem Eintrag mergen, dann schreiben
 * — zwei Anfragen statt einer `COALESCE`-Bedingung in der Query, weil ein NULL-Parameter dort
 * nicht zwischen "weglassen" und "auf leer setzen" unterscheiden könnte (jsonb-Spalten sind
 * `NOT NULL`). Ein Wettlauf zweier gleichzeitiger Bearbeitungen ist dieselbe Lage wie bei den
 * Provider-Schlüsseln (S33) — eine Oberfläche mit einem Bediener, kein verteiltes Problem.
 */
export async function upsertMcpServer(pool: Pool, input: McpServerInput): Promise<McpServerRecord> {
  const existing = await pool.query<McpServerRow>(
    `SELECT ${COLUMNS} FROM kuronami.mcp_servers WHERE server_id = $1`,
    [input.serverId],
  );
  const prior = existing.rows[0] ? toRecord(existing.rows[0]) : null;
  const merged: McpServerInput = {
    serverId: input.serverId,
    command: input.command,
    args: input.args ?? prior?.args,
    env: input.env ?? prior?.env,
    risk: input.risk,
    repeatable: input.repeatable ?? prior?.repeatable,
    enabled: input.enabled ?? prior?.enabled,
  };

  const v = validate(merged);
  const result = await pool.query<McpServerRow>(
    `
    INSERT INTO kuronami.mcp_servers (server_id, command, args, env, risk, repeatable, enabled)
    VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7)
    ON CONFLICT (server_id) DO UPDATE SET
      command = EXCLUDED.command,
      args = EXCLUDED.args,
      env = EXCLUDED.env,
      risk = EXCLUDED.risk,
      repeatable = EXCLUDED.repeatable,
      enabled = EXCLUDED.enabled,
      updated_at = now()
    RETURNING ${COLUMNS}
    `,
    [
      v.serverId,
      v.command,
      JSON.stringify(v.args),
      JSON.stringify(v.env),
      v.risk,
      v.repeatable,
      v.enabled,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("upsertMcpServer: keine Zeile zurückgegeben.");
  return toRecord(row);
}

/** `true`, wenn ein Server mit dieser Kennung gelöscht wurde. */
export async function deleteMcpServer(pool: Pool, serverId: string): Promise<boolean> {
  const result = await pool.query("DELETE FROM kuronami.mcp_servers WHERE server_id = $1", [
    serverId,
  ]);
  return (result.rowCount ?? 0) > 0;
}
