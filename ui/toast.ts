/**
 * Ein knapper, unaufdringlicher Hinweis (Punkt 4: "Wenn window.open vom Browser blockiert wird,
 * zeige einen kurzen, unaufdringlichen Hinweis statt still zu scheitern"). Ein Element, eine
 * Zeitschaltung — keine Warteschlange, kein Stapel: ein neuer Hinweis ersetzt den alten.
 */
export interface Toast {
  show(message: string): void;
}

const VISIBLE_MS = 4000;

export function createToast(el: HTMLElement): Toast {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    show(message: string): void {
      el.textContent = message;
      el.hidden = false;
      if (timer !== null) globalThis.clearTimeout(timer);
      timer = globalThis.setTimeout(() => {
        timer = null;
        el.hidden = true;
      }, VISIBLE_MS);
    },
  };
}
