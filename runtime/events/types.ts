/**
 * Ereignis-Taxonomie aus Abschnitt 4.4 der Architektur, zwölf Namensräume.
 * Namensform: namensraum.vergangenheitsform, kleingeschrieben, Punkt als Trenner.
 * Neue Typen werden hier ergänzt. Bestehende werden nie umbenannt und nie umgedeutet.
 */
export const EVENT_TYPES = [
  "session.created",
  "session.resumed",
  "session.completed",
  "session.failed",
  "session.canceled",
  "turn.started",
  "turn.completed",
  "step.started",
  "step.completed",
  "step.failed",
  "model.requested",
  "model.responded",
  "tool.requested",
  "tool.completed",
  "tool.failed",
  "policy.allowed",
  "policy.denied",
  "approval.requested",
  "approval.granted",
  "approval.denied",
  "artifact.created",
  "context.compacted",
  "task.created",
  "task.updated",
  "agent.delegated",
  "agent.returned",
  "error.raised",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9]*\.[a-z0-9_]+$/;

/**
 * Die Spalte `type` ist absichtlich offen (text), damit neue Typen ohne Migration
 * dazukommen. Offen heißt nicht formlos: die Namensform wird am einzigen Schreibtor
 * geprüft, sonst zerfällt das Protokoll still in zwei Schreibweisen desselben Ereignisses.
 */
export function assertEventType(type: string): void {
  if (!EVENT_TYPE_PATTERN.test(type)) {
    throw new Error(
      `Ungültiger Ereignistyp "${type}": erwartet wird namensraum.vergangenheitsform, kleingeschrieben, ein Punkt als Trenner`,
    );
  }
}
