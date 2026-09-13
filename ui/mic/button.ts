import { icon } from "../icons.js";
import { AGENT_STATE_LABEL, type MicStateStore } from "./state.js";

/**
 * Der Mic-Button (S-Zwischenschub, Punkt 6) — fest platziert ausserhalb jeder gerouteten
 * Ansicht, deshalb von ueberall erreichbar. Die sechs Zustaende unterscheiden sich nur durch
 * Form, Bewegungsruhe und Deckkraft (CSS in `ui/styles/shell.css`, `[data-agent-state]`) — keine
 * Farbwechsel, kein Leuchten. Die Zustandsquelle ist `ctx.mic` (`ui/mic/state.ts`); dieses Modul
 * liest nur davon und ruft `toggleListening()`/`cycle()` auf, es haelt kein eigenes Flag.
 */

export interface MicButtonHandle {
  el: HTMLElement;
}

export function mountMicButton(root: HTMLElement, mic: MicStateStore): MicButtonHandle {
  root.innerHTML = `
    <button type="button" class="mic-button" data-role="mic-toggle" title="Zuhören starten/beenden (Strg/Cmd+M)">
      <span class="mic-button__ring" data-role="mic-ring" aria-hidden="true"></span>
      ${icon("mic", { className: "mic-button__icon" })}
    </button>
    <span class="mic-button__label" data-role="mic-label">${AGENT_STATE_LABEL[mic.state]}</span>
  `;

  const button = root.querySelector<HTMLElement>('[data-role="mic-toggle"]');
  const label = root.querySelector<HTMLElement>('[data-role="mic-label"]');

  function render(): void {
    root.dataset.agentState = mic.state;
    if (label) label.textContent = AGENT_STATE_LABEL[mic.state];
    button?.setAttribute(
      "aria-label",
      mic.state === "listening" ? "Zuhören beenden" : "Zuhören starten",
    );
  }
  render();
  mic.subscribe(render);

  button?.addEventListener("click", () => mic.toggleListening());

  document.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === "m") {
      event.preventDefault();
      mic.toggleListening();
    }
  });

  return { el: root };
}
