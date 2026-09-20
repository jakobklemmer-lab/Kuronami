import { type ApiClient, ApiError } from "./api/client.js";
import type { BusMessage, EventBusClient } from "./events/bus.js";
import { icon } from "./icons.js";
import { escapeHtml } from "./views/html.js";

/**
 * Die Eingabezeile für einen neuen Auftrag — der „Neue Aufgabe"-Knopf der Startseite.
 *
 * **Das ist eine echte Funktion, kein Platzhalter:** sie schickt den Text an
 * `POST /channels/web/messages` am Gateway, also genau an denselben Kanal wie `pnpm say "…"`
 * (S16), und zeigt zurück, was der Lauf darauf zustellt (`deliveries`). Die Bildvorlage zeigt an
 * dieser Stelle „New Task"; ein Knopf, der nichts täte, wäre nach AGENTS.md eine vorgetäuschte
 * Funktion — diese Zeile ist der ehrliche Weg, ihn zu erfüllen.
 *
 * Fehler werden angezeigt, nicht geglättet (AGENTS.md): kein Token, abgelehnter Token und ein
 * nicht erreichbares Gateway sagen jeweils, was los ist.
 */

interface OutboundReply {
  kind: "reply";
  text: string;
}

interface OutboundApproval {
  kind: "approval";
  askId: string;
  question: string;
  options: { id: string; label: string }[];
}

interface Delivery {
  at: string;
  message: OutboundReply | OutboundApproval;
}

/** `gateway/core.ts`, `GatewayStatus`. `busy` heißt: es wartet eine Entscheidung, und die
 * Nachricht ist **nicht** in den Lauf gegangen — sie trotzdem mit „Angenommen." zu quittieren
 * wäre genau die Falschaussage, die den Nutzer ratlos zurücklässt. */
type GatewayStatus =
  | "answered"
  | "awaiting_user"
  | "busy"
  | "duplicate"
  | "rejected"
  | "canceled"
  | "failed";

interface MessageResponse {
  status?: GatewayStatus;
  deliveries?: Delivery[];
}

interface PendingAsk {
  askId: string;
  question: string;
  options: { id: string; label: string }[];
}

interface PendingResponse {
  pending?: PendingAsk[];
}

export interface Composer {
  open(): void;
  close(): void;
  destroy(): void;
}

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === "no_token") {
      return "Kein Verbindungs-Token hinterlegt — siehe Einstellungen › System.";
    }
    if (error.status === 401) return "Token abgelehnt — in den Einstellungen › System prüfen.";
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Was der Lauf gerade tut, in einer Zeile — aus dem Ereignisstrom, nicht aus der Antwort.
 *
 * `POST /channels/web/messages` und `/answers` kehren erst zurück, wenn der ganze Zug durch ist,
 * und ein Mail-Auftrag mit einem Dutzend Werkzeugaufrufen dauert Minuten. Ohne diese Zeile stand
 * so lange „Entscheidung geht in den Lauf …" da, und der Nutzer brach ab, weil er ein Hängen
 * von einem Arbeiten nicht unterscheiden konnte (2026-09-16). Der Bus liefert dieselben
 * Ereignisse, die auch die Läufe-Ansicht zeigt.
 */
function describeProgress(message: BusMessage): string | null {
  const payload = (message.data?.payload ?? {}) as Record<string, unknown>;
  switch (message.type) {
    case "turn.started":
      return "Lauf gestartet …";
    case "model.requested":
      return "Denkt nach …";
    case "tool.requested":
      return typeof payload.tool_name === "string"
        ? `Werkzeug: ${payload.tool_name} …`
        : "Werkzeug läuft …";
    case "tool.completed":
      return typeof payload.tool_name === "string"
        ? `${payload.tool_name} fertig, denkt weiter …`
        : "Werkzeug fertig, denkt weiter …";
    case "approval.requested":
      return "Wartet auf deine Entscheidung.";
    case "turn.completed":
      return "Zug abgeschlossen.";
    default:
      return null;
  }
}

export function createComposer(
  host: HTMLElement,
  api: ApiClient,
  bus?: Pick<EventBusClient, "onMessage">,
): Composer {
  host.innerHTML = `
    <div class="composer glass" role="dialog" aria-modal="false" aria-label="Neue Aufgabe">
      <header class="composer__head">
        <span class="composer__title">Neue Aufgabe</span>
        <button class="composer__close" type="button" data-role="close" aria-label="Schließen">
          ${icon("close")}
        </button>
      </header>
      <textarea class="composer__input" data-role="input" rows="3"
        placeholder="Was soll Kuronami tun? (Strg/Cmd + Enter zum Senden)"></textarea>
      <div class="composer__row">
        <span class="composer__status" data-role="status"></span>
        <button class="composer__send" type="button" data-role="send">Senden</button>
      </div>
      <p class="composer__live" data-role="live" hidden></p>
      <div class="composer__replies" data-role="replies"></div>
    </div>
  `;
  host.hidden = true;

  const input = host.querySelector<HTMLTextAreaElement>('[data-role="input"]');
  const status = host.querySelector<HTMLElement>('[data-role="status"]');
  const replies = host.querySelector<HTMLElement>('[data-role="replies"]');
  const live = host.querySelector<HTMLElement>('[data-role="live"]');
  const sendButton = host.querySelector<HTMLButtonElement>('[data-role="send"]');

  function setStatus(text: string, kind: "info" | "error" = "info"): void {
    if (!status) return;
    status.textContent = text;
    status.dataset.kind = kind;
  }

  // Nur während ein eigener Aufruf offen ist: sonst schriebe jeder Heartbeat-Lauf im Hintergrund
  // in eine Statuszeile, die gerade nichts anzeigen will.
  let inFlight = false;
  const unsubscribe = bus?.onMessage((message) => {
    if (!inFlight) return;
    if (message.type === "model.delta") {
      // Der Text, während er entsteht (Streaming, 2026-09-16) — Wort für Wort, wie beim
      // Sprechen. Beim Eintreffen der fertigen Zustellung wird die Zeile durch die Antwort
      // ersetzt; ein neuer Modellaufruf im selben Zug hängt einfach an.
      // Der Motor schickt die Stücke flach (`data.text`), das alte Protokoll verpackt sie in
      // `data.payload`. Beide Formen lesen, sonst bleibt die Zeile hier stumm.
      const payload = (message.data?.payload ?? message.data ?? {}) as Record<string, unknown>;
      const delta = typeof payload.text === "string" ? payload.text : "";
      if (live && delta.length > 0) {
        live.hidden = false;
        live.textContent = `${live.textContent ?? ""}${delta}`;
      }
      return;
    }
    const text = describeProgress(message);
    if (text !== null) setStatus(text);
  });

  /**
   * Eine Rückfrage als **Knöpfe**, nicht als Fließtext.
   *
   * Vorher stand hier „… — beantworten unter System", und das war eine Sackgasse: eine
   * Entscheidung löst nur `POST /channels/web/answers` mit `askId` und `choiceId` auf, und den
   * Weg dorthin gab es nirgends in der Oberfläche. Wer die Antwort stattdessen tippte — auch
   * wortgleich mit einer Option — schickte eine Nachricht, und die prallt an der offenen
   * Entscheidung ab (`gateway/core.ts`, `status: "busy"`). Die Unterhaltung stand damit still,
   * ohne dass etwas kaputt war.
   */
  function askMarkup(ask: PendingAsk): string {
    const buttons = ask.options
      .map(
        (option) =>
          `<button class="composer__choice" type="button" data-role="answer" data-ask="${escapeHtml(ask.askId)}" data-choice="${escapeHtml(option.id)}">${escapeHtml(option.label)}</button>`,
      )
      .join("");
    return `<div class="composer__reply composer__reply--ask">
      <p class="composer__question">${escapeHtml(ask.question)}</p>
      <div class="composer__choices">${buttons}</div>
    </div>`;
  }

  function renderDeliveries(list: Delivery[]): void {
    if (live) {
      live.textContent = "";
      live.hidden = true;
    }
    if (!replies) return;
    replies.innerHTML = list
      .map((delivery) =>
        delivery.message.kind === "reply"
          ? `<p class="composer__reply">${escapeHtml(delivery.message.text)}</p>`
          : askMarkup(delivery.message),
      )
      .join("");
  }

  async function answer(askId: string, choiceId: string): Promise<void> {
    setStatus("Entscheidung geht in den Lauf …");
    inFlight = true;
    try {
      const response = await api.post<MessageResponse>("/channels/web/answers", {
        askId,
        choiceId,
      });
      setStatus(
        response.status === "awaiting_user"
          ? "Der Lauf hat eine weitere Frage."
          : "Beantwortet — der Lauf ist durch.",
      );
      renderDeliveries(response.deliveries ?? []);
    } catch (error) {
      setStatus(describeError(error), "error");
    } finally {
      inFlight = false;
    }
  }

  replies?.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      '[data-role="answer"]',
    );
    const askId = button?.dataset.ask;
    const choiceId = button?.dataset.choice;
    if (askId && choiceId) void answer(askId, choiceId);
  });

  /** Was offen ist, noch bevor jemand tippt. Sonst erfährt man von einer wartenden Entscheidung
   * erst, wenn die eigene Nachricht an ihr abgeprallt ist. */
  async function loadPending(): Promise<void> {
    try {
      const response = await api.get<PendingResponse>("/channels/web/pending");
      const open = response.pending ?? [];
      if (!replies) return;
      replies.innerHTML = open.map(askMarkup).join("");
      if (open.length > 0) setStatus("Es wartet eine Entscheidung — bitte wählen.");
    } catch {
      // Kein Gateway, kein Token: das sagt der erste Sendeversuch deutlich genug. Ein Fehler
      // beim bloßen Öffnen des Fensters wäre Lärm.
    }
  }

  async function send(): Promise<void> {
    const content = input?.value.trim() ?? "";
    if (content.length === 0) return;
    if (sendButton) sendButton.disabled = true;
    setStatus("Wird gesendet …");
    inFlight = true;
    try {
      const response = await api.post<MessageResponse>("/channels/web/messages", { content });
      if (response.status === "busy") {
        // Die Nachricht steht noch im Eingabefeld: sie ist nicht in den Lauf gegangen, und ein
        // geleertes Feld würde das Gegenteil behaupten. Statt der Absage aus `deliveries` kommen
        // die offenen Fragen selbst ins Fenster — als Knöpfe, die aus der Lage herausführen.
        await loadPending();
        setStatus("Zuerst die offene Entscheidung beantworten — deine Nachricht ist noch da.");
        return;
      }
      if (input) input.value = "";
      setStatus("Angenommen.");
      renderDeliveries(response.deliveries ?? []);
    } catch (error) {
      setStatus(describeError(error), "error");
    } finally {
      inFlight = false;
      if (sendButton) sendButton.disabled = false;
    }
  }

  sendButton?.addEventListener("click", () => void send());
  input?.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      void send();
    }
    if (event.key === "Escape") close();
  });

  function close(): void {
    host.hidden = true;
  }

  host.querySelector('[data-role="close"]')?.addEventListener("click", close);

  return {
    open(): void {
      host.hidden = false;
      setStatus("");
      input?.focus();
      void loadPending();
    },
    close,
    destroy(): void {
      unsubscribe?.();
      host.innerHTML = "";
    },
  };
}
