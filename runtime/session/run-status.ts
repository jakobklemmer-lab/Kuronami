import type { EventRecord } from "../events/log.js";
import type { SessionState, SessionStatus } from "./state.js";

/**
 * Der Status eines "Runs" für die Oberfläche (S22), eine Verfeinerung von `SessionStatus`
 * (S05) um zwei Dinge, die `deriveSessionState` bewusst nicht unterscheidet, weil kein
 * Aufrufer vor S22 danach gefragt hat: ob ein Prozess die Session überhaupt schon
 * aufgenommen hat (`queued`/`ready`) und ob sie gerade auf einen delegierten Arbeiter wartet
 * statt auf einen Menschen (`blocked`). Acht Werte, wie `kuronami.task_status` (Abschnitt 5) —
 * dieselbe Reichweite eines allgemeinen Lebenslaufs, hier für Sessions statt Aufgaben.
 *
 * Eine eigene Datei statt einer Erweiterung von `SessionStatus` selbst: `deriveSessionState`
 * ist seit S05 fest getestet (u. a. "ein `session.created` allein ist `running`"), und die
 * zusätzliche Auflösung braucht ein zweites Feld (offene Delegationen), das dort niemanden
 * etwas anginge. Dasselbe Muster wie `deriveLoopState` (S12) neben `deriveSessionState`: zwei
 * Fragen an dasselbe Protokoll, zwei Funktionen.
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

const TERMINAL: ReadonlySet<SessionStatus> = new Set(["completed", "failed", "canceled"]);

/**
 * Faltet Runtime-Anhang, Zugbeginn und offene Delegationen aus dem Protokoll, zusätzlich zu
 * `session.status` (der bereits gefaltete Wert aus `deriveSessionState`, hier nicht neu
 * hergeleitet, um keine zweite, womöglich abweichende Fassung zu erzeugen).
 *
 * Reihenfolge: ein Terminalzustand gewinnt immer (wie in S05), danach eine offene
 * Nutzerrückfrage, danach eine offene Delegation, danach "noch nicht begonnen" — erst dann
 * bleibt `running`.
 */
export function deriveRunStatus(events: EventRecord[], session: SessionState): RunStatus {
  if (TERMINAL.has(session.status)) return session.status as RunStatus;
  if (session.status === "awaiting_user") return "awaiting_user";

  let runtimeStarted = false;
  let turnStarted = false;
  const openDelegations = new Set<string>();

  for (const event of events) {
    switch (event.type) {
      case "runtime.started":
        runtimeStarted = true;
        break;
      case "turn.started":
        turnStarted = true;
        break;
      case "agent.delegated":
        openDelegations.add(String(event.payload.call_id));
        break;
      case "agent.returned":
        openDelegations.delete(String(event.payload.call_id));
        break;
      default:
        break;
    }
  }

  if (openDelegations.size > 0) return "blocked";
  if (!turnStarted) return runtimeStarted ? "ready" : "queued";
  return "running";
}
