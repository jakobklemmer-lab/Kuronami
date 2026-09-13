import { icon } from "../icons.js";
import { AGENT_STATE_LABEL, type MicStateStore } from "./state.js";

/**
 * Der Mic-Schalter (Punkt 6) — in der Bildvorlage eine Pille am unteren Ende der Seitenleiste
 * („Listening …" mit Wellenbalken links und rundem Mikrofonknopf rechts), nicht ein schwebender
 * Knopf in der Bildschirmecke wie in der vorherigen Fassung.
 *
 * Die sechs Zustände kommen weiterhin aus genau einer Quelle (`ui/mic/state.ts`). Sichtbar
 * gemacht werden sie über `data-agent-state` auf der **Seitenleiste** (nicht auf der Pille), weil
 * die CSS-Regeln in `ui/styles/layout.css` sowohl die Wellenbalken als auch den Ring des Knopfes
 * ansprechen — beides Teile derselben Zeile.
 */

export interface MicButtonHandle {
  el: HTMLElement;
}

const WAVE_BARS = 5;

export function mountMicButton(
  host: HTMLElement,
  mic: MicStateStore,
  stateTarget: HTMLElement = host,
): MicButtonHandle {
  host.innerHTML = `
    <div class="mic-dock">
      <span class="mic-dock__wave" aria-hidden="true">
        ${Array.from({ length: WAVE_BARS }, () => "<span></span>").join("")}
      </span>
      <span class="mic-dock__label" data-role="mic-label">${AGENT_STATE_LABEL[mic.state]}</span>
      <button type="button" class="mic-button" data-role="mic-toggle"
        title="Zuhören starten/beenden (Strg/Cmd+M)">
        <span class="mic-button__ring" aria-hidden="true"></span>
        ${icon("mic")}
      </button>
    </div>
  `;

  const button = host.querySelector<HTMLElement>('[data-role="mic-toggle"]');
  const label = host.querySelector<HTMLElement>('[data-role="mic-label"]');

  function render(): void {
    stateTarget.dataset.agentState = mic.state;
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
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "m") {
      event.preventDefault();
      mic.toggleListening();
    }
  });

  return { el: host };
}
