/**
 * Die Felder der Session aus Abschnitt 5. Seit S05 liegen sie in einer eigenen Datei:
 * `manager.ts` (Anlegen und Wiederfinden) und `lifecycle.ts` (Wiederaufnahme und Abbruch)
 * brauchen dieselben Typen, und der Manager ruft den Lebenszyklus auf. Lägen die Typen
 * weiter im Manager, zeigten die beiden Module aufeinander.
 */

export type SessionChannel = "web" | "telegram" | "mail" | "heartbeat" | "voice";
export type ApprovalMode = "ask" | "accept_edits" | "bypass_in_sandbox";

/** Eine Zeile aus `kuronami.sessions`. */
export interface SessionRecord {
  sessionId: string;
  threadId: string;
  channel: SessionChannel;
  mode: string;
  modelProfile: string;
  toolCatalogVersion: string;
  approvalMode: ApprovalMode;
  contextState: Record<string, unknown>;
  createdAt: Date;
}

export interface SessionRow {
  session_id: string;
  thread_id: string;
  channel: SessionChannel;
  mode: string;
  model_profile: string;
  tool_catalog_version: string;
  approval_mode: ApprovalMode;
  context_state: Record<string, unknown>;
  created_at: Date;
}

export const SESSION_COLUMNS = `
  session_id, thread_id, channel, mode, model_profile,
  tool_catalog_version, approval_mode, context_state, created_at
`;

export function toSessionRecord(row: SessionRow): SessionRecord {
  return {
    sessionId: row.session_id,
    threadId: row.thread_id,
    channel: row.channel,
    mode: row.mode,
    modelProfile: row.model_profile,
    toolCatalogVersion: row.tool_catalog_version,
    approvalMode: row.approval_mode,
    contextState: row.context_state,
    createdAt: row.created_at,
  };
}
