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

  // Seither dazugekommen (S16). Ein vierzehnter Namensraum, und der einzige, der nicht von
  // der Runtime geschrieben wird — das Gateway schreibt ihn. Die Liste ist trotzdem der
  // richtige Ort: sie ist das Vokabular des Protokolls und keine Abhängigkeit. Ein
  // Ereignistyp, der in der Taxonomie nicht vorkommt, ist genau der Fall, den
  // `assertEventType` seit S03 verhindern soll — er zerfiele still in zwei Schreibweisen,
  // weil niemand nachschlagen kann, wie er heißt. Code aus `gateway/` wird hier nirgends
  // importiert; die harte Regel aus Abschnitt 3 ("die Runtime darf niemals von der
  // Surface-Schicht abhängen") bleibt unberührt und wird in `gateway/layering.test.ts`
  // geprüft.
  //
  // Warum überhaupt eigene Ereignisse: der Kanal einer Nachricht ist seit S16 kein Feld der
  // Session mehr (die läuft auf `gateway`, damit Web und Telegram **ein** Gedächtnis teilen),
  // sondern ein Feld der Nachricht. Er muss also irgendwo stehen, und "irgendwo" ist in
  // diesem System das Protokoll: nur dann weiß ein frisch gestarteter Gateway-Prozess noch,
  // an welchen Kanal eine offene Freigabeanfrage gehört. Läge die Zuordnung in einer Map im
  // Speicher, ginge sie beim Neustart verloren — und die Rückfrage käme nie an.
  "gateway.received",
  "gateway.delivered",

  // Seither dazugekommen (S17). Ein fünfzehnter Namensraum, und der zweite, den nicht die
  // Runtime schreibt — der Heartbeat-Dienst schreibt ihn. Die Begründung ist dieselbe wie bei
  // `gateway.*`: die Liste ist das Vokabular des Protokolls und keine Abhängigkeit, `assertEventType`
  // soll genau die stille Aufspaltung in zwei Schreibweisen verhindern, und `heartbeat/` wird
  // in `runtime/`, `context/`, `tools/` und `policy/` nirgends importiert (geprüft in
  // `heartbeat/layering.test.ts`).
  //
  // Warum eigene Ereignisse: der Heartbeat läuft **ohne Nutzereingabe** und trifft trotzdem
  // Entscheidungen, die nachvollziehbar bleiben müssen — hat er heute schon zu oft gelaufen
  // (Tagesobergrenze), hat er einen Digest erzeugt und zugestellt, hat ein ereignisgesteuerter
  // Lauf bewusst **nichts** gemeldet ("keine Meldung, wenn nichts gefunden wird"). Diese
  // Buchführung liegt in einer eigenen Diarium-Session (`thread_heartbeat`), damit die
  // Tagesobergrenze aus dem Protokoll gefaltet werden kann und nicht aus einem Zähler im
  // Prozess, der einen Neustart nicht überlebt.
  //
  //   * `heartbeat.ran`       — ein Hintergrundlauf ist gelaufen (Digest oder Auslöser), mit
  //                             Ausgang und ob etwas zugestellt wurde. Zählt gegen die
  //                             Tagesobergrenze.
  //   * `heartbeat.skipped`   — ein fälliger Lauf wurde **nicht** gestartet (Tagesobergrenze
  //                             erreicht). Steht im Protokoll, damit ein ausbleibender Digest
  //                             nicht wie ein Fehler aussieht.
  //   * `heartbeat.delivered` — was an welchen Kanal hinausging (Digest-Text plus Artefakt-Handle).
  //   * `heartbeat.silent`    — ein ereignisgesteuerter Lauf hat geprüft und entschieden, dass
  //                             es nichts zu melden gibt. Der Normalfall, nicht die Ausnahme.
  "heartbeat.ran",
  "heartbeat.skipped",
  "heartbeat.delivered",
  "heartbeat.silent",
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
