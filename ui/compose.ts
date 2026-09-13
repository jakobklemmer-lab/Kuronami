import { type ApiClient, ApiError } from "./api/client.js";
import { icon } from "./icons.js";

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

interface MessageResponse {
  deliveries?: Delivery[];
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

export function createComposer(host: HTMLElement, api: ApiClient): Composer {
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
      <div class="composer__replies" data-role="replies"></div>
    </div>
  `;
  host.hidden = true;

  const input = host.querySelector<HTMLTextAreaElement>('[data-role="input"]');
  const status = host.querySelector<HTMLElement>('[data-role="status"]');
  const replies = host.querySelector<HTMLElement>('[data-role="replies"]');
  const sendButton = host.querySelector<HTMLButtonElement>('[data-role="send"]');

  function setStatus(text: string, kind: "info" | "error" = "info"): void {
    if (!status) return;
    status.textContent = text;
    status.dataset.kind = kind;
  }

  function renderDeliveries(list: Delivery[]): void {
    if (!replies) return;
    if (list.length === 0) {
      replies.innerHTML = "";
      return;
    }
    replies.innerHTML = list
      .map((delivery) => {
        if (delivery.message.kind === "reply") {
          return `<p class="composer__reply">${delivery.message.text}</p>`;
        }
        const options = delivery.message.options.map((option) => option.label).join(", ");
        return `<p class="composer__reply composer__reply--ask">Rückfrage: ${delivery.message.question} (${options}) — beantworten unter System.</p>`;
      })
      .join("");
  }

  async function send(): Promise<void> {
    const content = input?.value.trim() ?? "";
    if (content.length === 0) return;
    if (sendButton) sendButton.disabled = true;
    setStatus("Wird gesendet …");
    try {
      const response = await api.post<MessageResponse>("/channels/web/messages", { content });
      if (input) input.value = "";
      setStatus("Angenommen.");
      renderDeliveries(response.deliveries ?? []);
    } catch (error) {
      setStatus(describeError(error), "error");
    } finally {
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
    },
    close,
    destroy(): void {
      host.innerHTML = "";
    },
  };
}
