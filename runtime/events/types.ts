/**
 * Ereignis-Taxonomie. Namensform: namensraum.vergangenheitsform, kleingeschrieben, Punkt
 * als Trenner. Neue Typen werden hier ergänzt. Bestehende werden nie umbenannt und nie in
 * ihrer Bedeutung verändert.
 */
export const EVENT_TYPES = [
  // Abschnitt 4.4 der Architektur, wörtlich und in der dortigen Reihenfolge.
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

  // Seither dazugekommen (S04). Die Taxonomie kennt nur den Lebenslauf der Session, nicht
  // den des Prozesses, der sie bedient. Genau darin liegt aber das Ergebnis von S04: die
  // Session überlebt den Prozess. Ohne eigenen Namensraum wäre ein Neustart im Protokoll
  // nicht von einer neuen Session zu unterscheiden — die Folge session.resumed nach
  // runtime.stopped ist der Nachweis, dass beides getrennte Dinge sind.
  "runtime.started",
  "runtime.stopped",

  // Seither dazugekommen (S05). Kein neuer Namensraum: step.* steht seit Abschnitt 4.4,
  // nur der Ausgang "abgebrochen" fehlte darin. Das Datenmodell kennt ihn längst —
  // kuronami.step_status hat seit S02 den Wert 'canceled'. Ohne eigenes Ereignis wäre das
  // der einzige Zustand, den der Snapshot tragen kann und das Protokoll nicht, und damit
  // wäre der Snapshot nicht mehr aus dem Protokoll herleitbar (Abschnitt 4.4). step.failed
  // dafür zu benutzen, hieße einen bestehenden Typ umzudeuten.
  "step.canceled",

  // Seither dazugekommen (S11). Kein neuer Namensraum: policy.* steht seit Abschnitt 4.4 mit
  // allowed und denied, aber beide sagen nur, ob ausgeführt werden darf. Der Auftrag von S11
  // verlangt zusätzlich, den **Zugriff auf einen Geheimnisträger** zu protokollieren, und das
  // ist eine andere Aussage: sie gilt auch dann, wenn der Aufruf ganz normal erlaubt war.
  // Sie in policy.allowed als Feld zu führen hieße, "wer hat wann welche Zugangsdatei
  // angefasst" nur noch über einen Filter auf einem Payload beantworten zu können — genau die
  // Frage, die nach einem Vorfall als erste gestellt wird.
  "policy.secret_accessed",
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
