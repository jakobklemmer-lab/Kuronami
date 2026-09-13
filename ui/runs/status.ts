/**
 * Die acht Run-Zustände (S22, `runtime/session/run-status.ts`) für die Anzeige.
 *
 * Eine eigene, gleichlautende Kopie des Typs statt eines Imports aus `runtime/`: die
 * Oberfläche wird als eigenständige ES-Module ausgeliefert (`ui/build.ts`, "kein Bundler") und
 * ein Browser kann ohnehin nichts außerhalb von `ui/` nachladen — dieselbe Haltung wie
 * `UiSignal` in `ui/events/bus.ts`, das die Ereignis-Taxonomie auch nicht importiert, sondern
 * in eigenen Worten übersetzt.
 */
export type RunStatus =
  | "queued"
  | "ready"
  | "running"
  | "blocked"
  | "awaiting_user"
  | "completed"
  | "failed"
  | "canceled";

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  queued: "wartet",
  ready: "bereit",
  running: "läuft",
  blocked: "blockiert",
  awaiting_user: "Rückfrage offen",
  completed: "fertig",
  failed: "fehlgeschlagen",
  canceled: "abgebrochen",
};

/** `null` heißt: dieser Run ließ sich nicht aus dem Protokoll falten (`foldError`, siehe
 * `runtime/session/runs.ts`) — sichtbar als eigenes, benanntes Abzeichen statt als Lücke. */
export function runStatusLabel(status: RunStatus | null): string {
  return status === null ? "Status unklar" : RUN_STATUS_LABEL[status];
}

/** Der CSS-Klassenname für das Status-Abzeichen, eine Klasse je Zustand plus ein
 * Sammelzustand für `null`. */
export function runStatusClass(status: RunStatus | null): string {
  const suffix = status === null ? "unknown" : status.replace(/_/g, "-");
  return `run-status run-status--${suffix}`;
}
