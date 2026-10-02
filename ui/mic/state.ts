/**
 * Die eine Zustandsquelle für den Mic-Button (S-Zwischenschub, Punkt 6): sechs Agentenzustände,
 * wie vom Nutzer vorgegeben. Jede Anzeige (Button-Form, Kopfzeilen-Abzeichen, die
 * Desktop-App) liest von hier — es gibt keinen zweiten Ort, an dem ein Zustand als
 * lokales Flag mitgeführt wird.
 *
 * **Vorerst ohne echte Spracherkennung** (die kommt erst mit S30/S31): `toggleListening` schaltet
 * zwischen `idle` und `listening` um, das ist die einzige heute "echte" Interaktion. `cycle` ist
 * ausdrücklich der Mock-Schalter aus dem Auftrag ("vorerst gegen Mock schaltbar, damit alle sechs
 * Zustände vorführbar sind") — verdrahtet in den Einstellungen (Abschnitt System), nicht im
 * normalen Bedienfluss.
 */

export const AGENT_STATES = [
  "idle",
  "listening",
  "thinking",
  "speaking",
  "executing",
  "complete",
] as const;

export type AgentState = (typeof AGENT_STATES)[number];

/** Die Beschriftung der Mic-Pille. Englisch wie die uebrige Navigation der Bildvorlage
 * („Listening …" steht dort woertlich), waehrend Hinweistexte und Fehlermeldungen deutsch
 * bleiben — dieselbe Aufteilung wie bei Home/Mail/Settings. */
export const AGENT_STATE_LABEL: Record<AgentState, string> = {
  idle: "Idle",
  listening: "Listening …",
  thinking: "Thinking …",
  speaking: "Speaking …",
  executing: "Working …",
  complete: "Done",
};

export interface MicStateStore {
  readonly state: AgentState;
  set(state: AgentState): void;
  subscribe(listener: (state: AgentState) => void): () => void;
  /** Für die Mock-Vorführung (Einstellungen › System): springt zum nächsten der sechs Zustände,
   * zyklisch. Gibt den neuen Zustand zurück. */
  cycle(): AgentState;
  /** Die einzige heute echte Interaktion: Klick auf den Mic-Button oder das Tastenkürzel.
   * `idle` → `listening`, jeder andere Zustand → `idle` (Zuhören beenden, gleich aus welchem
   * Zustand heraus abgebrochen wird). Gibt den neuen Zustand zurück. */
  toggleListening(): AgentState;
}

export function createMicStateStore(initial: AgentState = "idle"): MicStateStore {
  let state: AgentState = initial;
  const listeners = new Set<(state: AgentState) => void>();

  function set(next: AgentState): void {
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener(next);
  }

  return {
    get state() {
      return state;
    },
    set,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    cycle() {
      const index = AGENT_STATES.indexOf(state);
      const next = AGENT_STATES[(index + 1) % AGENT_STATES.length] as AgentState;
      set(next);
      return next;
    },
    toggleListening() {
      const next: AgentState =
        state === "listening" ? "idle" : state === "idle" ? "listening" : "idle";
      set(next);
      return next;
    },
  };
}
