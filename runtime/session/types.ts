/**
 * Die Felder der Session aus Abschnitt 5. Seit S05 liegen sie in einer eigenen Datei:
 * `manager.ts` (Anlegen und Wiederfinden) und `lifecycle.ts` (Wiederaufnahme und Abbruch)
 * brauchen dieselben Typen, und der Manager ruft den Lebenszyklus auf. Lägen die Typen
 * weiter im Manager, zeigten die beiden Module aufeinander.
 */

/**
 * Die fünf Kanäle aus Abschnitt 5, dazu `gateway` seit S16 (Migration 0008) und `agent` seit
 * S19 (Migration 0009).
 *
 * `gateway` ist der Kanal einer Session, die **keiner einzelnen Oberfläche gehört**: das
 * Gateway führt Web und Telegram desselben Nutzers in einer Session zusammen, damit beide
 * dasselbe Gedächtnis haben. Der Kanal der einzelnen Nachricht steht dann nicht mehr hier,
 * sondern im `gateway.received`-Ereignis — er ändert sich je Nachricht, die Session nicht.
 *
 * `agent` ist der Kanal einer Session, die **keinem Menschen gehört**: der isolierte Kontext
 * eines delegierten Arbeiters (Abschnitt 14). Sie kommt aus keiner Oberfläche und hat kein
 * Gegenüber, das antwortet; wer sie einem der anderen Werte zuschlüge, behauptete eine
 * Herkunft, die es nicht gibt.
 */
export type SessionChannel =
  | "web"
  | "telegram"
  | "mail"
  | "heartbeat"
  | "voice"
  | "gateway"
  | "agent";
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
