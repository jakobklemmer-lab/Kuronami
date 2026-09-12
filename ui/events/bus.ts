/**
 * Der Ereignis-Client der Oberfläche (S21, Phase 6).
 *
 * Er verbindet sich mit dem Ereignisstrom der Runtime (`runtime/events/bus.ts`,
 * Vorgabe `ws://localhost:3000/events`), übersetzt Protokollereignisse in die sechs Signale,
 * die diese Oberfläche kennt, und verbindet sich nach einem Abriss von selbst wieder.
 *
 * **Warum eine eigene Übersetzung und nicht die rohen Ereignistypen:** das Protokoll hat über
 * vierzig Typen und wächst weiter (`runtime/events/types.ts`, "Ereignistypen nie umbenennen").
 * Die Oberfläche will davon genau sechs Dinge wissen — ob gerade gedacht, gesprochen, fertig
 * oder nichts wird, und ob eine Aufgabe dazukam oder fertig wurde. Die Zuordnung steht an
 * **einer** Stelle (`signalFor`) und ist eine reine Funktion: ein neuer Ereignistyp fällt
 * dadurch nicht in die falsche Schublade, sondern zunächst gar nicht auf — und das ist die
 * richtige Vorgabe für eine Anzeige.
 *
 * **Nur lesend.** Es gibt keine `send`-Methode. Der Strom ist serverseitig nur lesend
 * (ein Datenframe von der Oberfläche beendet dort die Verbindung), und eine Methode, die es
 * trotzdem versuchte, wäre ein Weg, der nur im Fehlerfall sichtbar würde.
 */

/** Die vier Zustände des Wassers plus die zwei Plansignale. */
export type UiSignal = "idle" | "processing" | "speaking" | "complete" | "task_added" | "task_done";

/** Die vier Zustände, die der Wassereffekt kennt. Teilmenge von `UiSignal`. */
export type UiState = "idle" | "processing" | "speaking" | "complete";

export const UI_STATES: readonly UiState[] = ["idle", "processing", "speaking", "complete"];

/** Ein Rahmen, wie ihn der Bus schickt: `{type, timestamp, data}`. */
export interface BusMessage {
  type: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

export type ConnectionStatus = "connecting" | "open" | "closed";

/**
 * Das Stück `WebSocket`, das dieser Client tatsächlich benutzt. Kein Nachbau der ganzen
 * Schnittstelle — nur so viel, dass ein Test einen Draht ohne Netz einsetzen kann.
 */
export interface SocketLike {
  readyState: number;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface EventBusOptions {
  /** Vorgabe: `ws://<host des Dokuments>:3000/events`, im Test frei zu setzen. */
  url?: string;
  /** Vorgabe: ein echter `WebSocket`. Der Test reicht einen Draht ohne Netz herein. */
  socketFactory?: (url: string) => SocketLike;
  /** Vorgabe: `setTimeout`/`clearTimeout`. Der Test steuert die Zeit selbst. */
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
  /** Erster Wartewert der Wiederverbindung. */
  baseBackoffMs?: number;
  /** Obergrenze der Wiederverbindung. */
  maxBackoffMs?: number;
  /**
   * Wie lange `complete` steht, bevor der Zustand von selbst nach `idle` zurückfällt.
   * 0 schaltet den Rückfall ab (dann bleibt das Wasser auslaufend stehen).
   */
  idleAfterMs?: number;
}

export const DEFAULT_BASE_BACKOFF_MS = 500;
export const DEFAULT_MAX_BACKOFF_MS = 10_000;
export const DEFAULT_IDLE_AFTER_MS = 4_000;

/**
 * Exponentieller Backoff mit Deckel, ohne Jitter.
 *
 * Kein Jitter, weil es hier genau **einen** Client gibt, der sich mit genau einem lokalen
 * Prozess verbindet: Jitter verhindert, dass viele Clients nach einem Serverausfall im
 * Gleichschritt zurückkommen, und dieser Fall existiert hier nicht. Er würde die
 * Wartezeit dafür unvorhersagbar machen — auch für den Test.
 *
 * `attempt` zählt ab 1 für den ersten Wiederverbindungsversuch.
 */
export function backoffDelay(
  attempt: number,
  base = DEFAULT_BASE_BACKOFF_MS,
  max = DEFAULT_MAX_BACKOFF_MS,
): number {
  if (attempt <= 1) return Math.min(base, max);
  return Math.min(base * 2 ** (attempt - 1), max);
}

/**
 * Protokollereignis → Signal der Oberfläche. Reine Funktion, damit die Zuordnung prüfbar ist,
 * ohne einen Draht aufzubauen.
 *
 * `null` heißt: dieses Ereignis ändert an der Anzeige nichts. Das ist der Normalfall — die
 * meisten der über vierzig Typen sind Buchführung, keine Bühne.
 */
export function signalFor(message: BusMessage): UiSignal | null {
  const { type } = message;

  // Ein Rahmen, der schon ein Signal **ist**, geht durch. So lässt sich der Strom auch von
  // einem Demolauf oder einem Prüfwerkzeug treiben, ohne Protokollereignisse zu erfinden.
  if (
    (
      ["idle", "processing", "speaking", "complete", "task_added", "task_done"] as string[]
    ).includes(type)
  ) {
    return type as UiSignal;
  }

  switch (type) {
    // Es wird gedacht oder gehandelt: ein Zug läuft, ein Schritt läuft, ein Werkzeug wurde
    // angefordert, das Modell wurde gefragt.
    case "turn.started":
    case "step.started":
    case "tool.requested":
    case "model.requested":
    case "agent.delegated":
      return "processing";

    // Es kommt etwas zurück, das für den Nutzer bestimmt ist.
    case "model.responded":
    case "gateway.delivered":
    case "heartbeat.delivered":
    case "approval.requested":
      return "speaking";

    // Etwas ist zu Ende — der Kreis läuft aus.
    case "turn.completed":
    case "session.completed":
    case "agent.returned":
    case "heartbeat.silent":
      return "complete";

    // Ruhe. `bus.connected` gehört dazu: gerade verbunden heißt, es ist nichts im Gange, das
    // diese Oberfläche gesehen hätte.
    case "bus.connected":
    case "session.created":
    case "runtime.started":
      return "idle";

    case "task.created":
      return "task_added";

    case "task.updated":
      return message.data?.status === "done" ? "task_done" : null;

    default:
      return null;
  }
}

/** Liest einen Rahmen aus dem Draht. Wirft nicht — kaputte Rahmen geben `null`. */
export function parseMessage(raw: unknown): BusMessage | null {
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Partial<BusMessage>;
  if (typeof candidate.type !== "string" || candidate.type.length === 0) return null;
  return {
    type: candidate.type,
    timestamp:
      typeof candidate.timestamp === "string" ? candidate.timestamp : new Date().toISOString(),
    data: typeof candidate.data === "object" && candidate.data !== null ? candidate.data : {},
  };
}

type SignalListener = (message: BusMessage) => void;
type StateListener = (state: UiState, message: BusMessage) => void;
type StatusListener = (status: ConnectionStatus, attempt: number) => void;
type MessageListener = (message: BusMessage) => void;

export interface EventBusClient {
  /** Baut die Verbindung auf. Mehrfach aufgerufen passiert nichts Zweites. */
  connect(): void;
  /** Schließt endgültig — ohne Wiederverbindung. */
  close(): void;
  /** Ein Signal abonnieren. Gibt die Abmeldung zurück. */
  on(signal: UiSignal, listener: SignalListener): () => void;
  /** Jeden Zustandswechsel des Wassers abonnieren. */
  onState(listener: StateListener): () => void;
  /** Den Verbindungsstand abonnieren. */
  onStatus(listener: StatusListener): () => void;
  /** Jeden Rahmen abonnieren, auch die ohne Signal. */
  onMessage(listener: MessageListener): () => void;
  /** Einen Rahmen einspeisen, als käme er vom Draht. Der Weg für Tests und Demoläufe. */
  handle(message: BusMessage): void;
  readonly state: UiState;
  readonly status: ConnectionStatus;
  /** Zahl der bisherigen Wiederverbindungsversuche seit der letzten offenen Verbindung. */
  readonly attempts: number;
}

function defaultUrl(): string {
  // `location` gibt es im Browser; im Test wird `url` ohnehin übergeben.
  const host =
    typeof globalThis.location === "object" && globalThis.location !== null
      ? globalThis.location.hostname || "localhost"
      : "localhost";
  return `ws://${host}:3000/events`;
}

export function createEventBus(options: EventBusOptions = {}): EventBusClient {
  const url = options.url ?? defaultUrl();
  const socketFactory =
    options.socketFactory ??
    ((target: string) =>
      // Der einzige Ort, an dem die Oberfläche den echten `WebSocket` anfasst. Die Umdeutung
      // ist nötig, weil `SocketLike` bewusst schmaler ist als die Browser-Schnittstelle.
      new WebSocket(target) as unknown as SocketLike);
  const setTimer =
    options.setTimer ??
    ((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms) as unknown as number);
  const clearTimer = options.clearTimer ?? ((id: number) => globalThis.clearTimeout(id));
  const baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const idleAfterMs = options.idleAfterMs ?? DEFAULT_IDLE_AFTER_MS;

  const signalListeners = new Map<UiSignal, Set<SignalListener>>();
  const stateListeners = new Set<StateListener>();
  const statusListeners = new Set<StatusListener>();
  const messageListeners = new Set<MessageListener>();

  let socket: SocketLike | null = null;
  let state: UiState = "idle";
  let status: ConnectionStatus = "closed";
  let attempts = 0;
  let reconnectTimer: number | null = null;
  let idleTimer: number | null = null;
  let closedByUs = false;

  function setStatus(next: ConnectionStatus): void {
    status = next;
    for (const listener of statusListeners) listener(next, attempts);
  }

  function setState(next: UiState, message: BusMessage): void {
    if (idleTimer !== null) {
      clearTimer(idleTimer);
      idleTimer = null;
    }
    if (next !== state) {
      state = next;
      for (const listener of stateListeners) listener(next, message);
    }
    // Nach dem Auslaufen kehrt das Wasser von selbst zur Ruhe zurück — sonst bliebe die
    // Anzeige nach dem letzten Zug auf "gerade fertig geworden" stehen, was nach zwei
    // Minuten eine Falschaussage ist.
    if (next === "complete" && idleAfterMs > 0) {
      idleTimer = setTimer(() => {
        idleTimer = null;
        setState("idle", { type: "idle", timestamp: new Date().toISOString(), data: {} });
      }, idleAfterMs);
    }
  }

  function handle(message: BusMessage): void {
    for (const listener of messageListeners) listener(message);
    const signal = signalFor(message);
    if (signal === null) return;
    for (const listener of signalListeners.get(signal) ?? []) listener(message);
    if ((UI_STATES as readonly string[]).includes(signal)) setState(signal as UiState, message);
  }

  function scheduleReconnect(): void {
    if (closedByUs || reconnectTimer !== null) return;
    attempts += 1;
    const delay = backoffDelay(attempts, baseBackoffMs, maxBackoffMs);
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      open();
    }, delay);
  }

  function open(): void {
    if (socket !== null) return;
    setStatus("connecting");
    const next = socketFactory(url);
    socket = next;

    next.onopen = () => {
      attempts = 0;
      setStatus("open");
    };
    next.onmessage = (event) => {
      const message = parseMessage(event.data);
      if (message === null) return;
      handle(message);
    };
    next.onclose = () => {
      socket = null;
      setStatus("closed");
      scheduleReconnect();
    };
    next.onerror = () => {
      // `onerror` wird im Browser vor `onclose` gemeldet und trägt keinen brauchbaren Grund.
      // Die Wiederverbindung hängt deshalb an `onclose` — hier gibt es nichts zu tun, was
      // dort nicht schon geschieht.
    };
  }

  return {
    connect: open,
    close(): void {
      closedByUs = true;
      if (reconnectTimer !== null) {
        clearTimer(reconnectTimer);
        reconnectTimer = null;
      }
      if (idleTimer !== null) {
        clearTimer(idleTimer);
        idleTimer = null;
      }
      const open = socket;
      socket = null;
      open?.close(1000, "Oberfläche geschlossen.");
      setStatus("closed");
    },
    on(signal, listener): () => void {
      const set = signalListeners.get(signal) ?? new Set<SignalListener>();
      set.add(listener);
      signalListeners.set(signal, set);
      return () => set.delete(listener);
    },
    onState(listener): () => void {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    onStatus(listener): () => void {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    onMessage(listener): () => void {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    handle,
    get state(): UiState {
      return state;
    },
    get status(): ConnectionStatus {
      return status;
    },
    get attempts(): number {
      return attempts;
    },
  };
}
