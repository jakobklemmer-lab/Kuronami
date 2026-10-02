import { icon } from "../icons.js";
import type { Gespraech } from "../welle/gespraech.js";

/** Die Eingabe an Kuro — auf dem Desktop groß, in Kuros Platz neben einem Raum schmal. */

const SENDEN = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg>`;

export function eingabeHtml(rolle: string, klasse = ""): string {
  return `
    <form class="o-eingabe${klasse ? ` ${klasse}` : ""}" data-role="${rolle}">
      <textarea rows="1" name="text" placeholder="Kuro fragen" aria-label="Nachricht an Kuro"></textarea>
      <button type="button" class="o-eingabe__mikro" data-role="mikro" aria-label="Mikrofon an oder aus">${icon("mic")}</button>
      <button type="submit" class="o-eingabe__senden" aria-label="Senden">${SENDEN}</button>
    </form>`;
}

export function verdrahteEingabe(
  f: HTMLFormElement,
  opt: { gespraech: Gespraech; voice: { toggle(): void }; toast(text: string): void },
): HTMLTextAreaElement {
  const t = f.querySelector("textarea") as HTMLTextAreaElement;
  const sende = async () => {
    const text = t.value.trim();
    if (!text) return;
    t.value = "";
    t.style.height = "";
    try {
      await opt.gespraech.sende(text);
    } catch (error) {
      opt.toast(error instanceof Error ? error.message : String(error));
    }
  };
  f.addEventListener("submit", (e) => {
    e.preventDefault();
    void sende();
  });
  t.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void sende();
    }
  });
  t.addEventListener("input", () => {
    t.style.height = "";
    t.style.height = `${Math.min(t.scrollHeight, 200)}px`;
  });
  f.querySelector<HTMLButtonElement>('[data-role="mikro"]')?.addEventListener("click", (e) => {
    opt.voice.toggle();
    (e.currentTarget as HTMLElement).blur();
  });
  return t;
}
