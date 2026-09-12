import { createRippleRenderer } from "./canvas/ripples.js";
import { type BusMessage, type UiState, createEventBus } from "./events/bus.js";

/**
 * Die Verdrahtung (S21): Ereignisstrom → Zustand → Wasser und Anzeige.
 *
 * Bewusst die einzige Datei der Oberfläche, die das Dokument anfasst. `ripples.ts` und
 * `events/bus.ts` kennen weder `document` noch `window` — deshalb sind sie ohne Browser
 * prüfbar, und deshalb steht hier nichts, was eine Entscheidung trifft.
 */

const STATE_LABEL: Record<UiState, string> = {
  idle: "ruhig",
  processing: "arbeitet",
  speaking: "antwortet",
  complete: "fertig",
};

const STATUS_LABEL = {
  connecting: "verbindet",
  open: "verbunden",
  closed: "getrennt",
} as const;

/** Wie viele Zeilen der Ereignisstrom im Panel hält. Alles darüber ist Historie und gehört
 * in die Runs-Ansicht (S22), nicht in ein Panel, das mitwächst, bis der Tab steht. */
const STREAM_LIMIT = 40;

function element<T extends Element>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`Das Grundgerüst hat kein Element mit der id "${id}".`);
  return found as unknown as T;
}

function startClock(target: HTMLElement): void {
  const tick = (): void => {
    target.textContent = new Date().toLocaleTimeString("de-DE", { hour12: false });
  };
  tick();
  globalThis.setInterval(tick, 1000);
}

function main(): void {
  const canvas = element<HTMLCanvasElement>("ripples");
  const stateBadge = element<HTMLElement>("state-badge");
  const connection = element<HTMLElement>("connection");
  const stream = element<HTMLElement>("event-stream");
  const eventCount = element<HTMLElement>("event-count");
  const reconnectCount = element<HTMLElement>("reconnect-count");
  const tasksAdded = element<HTMLElement>("tasks-added");
  const tasksDone = element<HTMLElement>("tasks-done");
  const notificationCount = element<HTMLElement>("notification-count");

  startClock(element<HTMLElement>("clock"));

  const ripples = createRippleRenderer({ canvas });
  ripples.start();
  globalThis.addEventListener("resize", () => ripples.resize());

  // Der Port des Ereignisstroms lässt sich über `?events=3005` überschreiben — nützlich, wenn
  // Gateway und Runtime nebeneinander laufen und man sehen will, was welcher Prozess sendet.
  const params = new URLSearchParams(globalThis.location.search);
  const eventsPort = params.get("events") ?? "3000";
  const bus = createEventBus({
    url: `ws://${globalThis.location.hostname || "localhost"}:${eventsPort}/events`,
  });

  let seen = 0;
  let added = 0;
  let done = 0;
  let unread = 0;

  bus.onState((state) => {
    document.body.dataset.uiState = state;
    stateBadge.dataset.uiState = state;
    stateBadge.textContent = STATE_LABEL[state];
    ripples.setState(state);
  });

  bus.onStatus((status, attempts) => {
    connection.dataset.status = status;
    connection.textContent =
      status === "connecting" && attempts > 0
        ? `${STATUS_LABEL.connecting} (${attempts})`
        : STATUS_LABEL[status];
    reconnectCount.textContent = String(attempts);
  });

  bus.onMessage((message: BusMessage) => {
    seen += 1;
    eventCount.textContent = String(seen);

    const row = document.createElement("li");
    const stamp = document.createElement("time");
    stamp.dateTime = message.timestamp;
    stamp.textContent = new Date(message.timestamp).toLocaleTimeString("de-DE", { hour12: false });
    const label = document.createElement("span");
    label.textContent = message.type;
    row.append(stamp, label);
    stream.prepend(row);
    while (stream.childElementCount > STREAM_LIMIT) stream.lastElementChild?.remove();
  });

  bus.on("task_added", () => {
    added += 1;
    tasksAdded.textContent = String(added);
  });
  bus.on("task_done", () => {
    done += 1;
    tasksDone.textContent = String(done);
  });
  bus.on("speaking", () => {
    unread += 1;
    notificationCount.textContent = String(unread);
    notificationCount.hidden = false;
  });

  element<HTMLElement>("notifications").addEventListener("click", () => {
    unread = 0;
    notificationCount.hidden = true;
  });

  bus.connect();
}

main();
