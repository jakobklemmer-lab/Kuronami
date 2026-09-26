import { melde } from "../auth/anmeldung.js";

/**
 * Die Tür der Welle.
 *
 * Man steht im Raum, bevor er aufgeht: das erste Bild des Films, abgedunkelt, und davor zwei
 * Felder. Nach dem Aufschließen hellt der Raum auf und die Welle öffnet sich darin.
 *
 * Die Anmeldung selbst ist dieselbe wie an der Tür der Präsenz (`ui/auth/anmeldung.ts`, gegen
 * `/auth/anmelden`): ein Benutzer, ein Passwort, ein Sitzungsticket an der üblichen Stelle.
 * Was der Gateway antwortet, steht wörtlich da; eine Sperre nach zu vielen Versuchen (429 mit
 * `wartenMs`) wird abgezählt, und so lange bleibt der Knopf aus.
 *
 * Die Klassen tragen das Präfix `tu-`: die Tür liegt im selben Dokument wie die Welle.
 */

export interface TuerOptionen {
  baseUrl: string;
  benutzer: string | null;
  /** Warum die Tür (wieder) da ist, etwa nach einer abgelaufenen Sitzung. */
  grund?: string;
  poster: string;
  onOffen(token: string): void;
}

export function zeigeTuer(root: HTMLElement, opt: TuerOptionen): () => void {
  const tuer = document.createElement("div");
  tuer.className = "tu-tuer";
  tuer.setAttribute("role", "dialog");
  tuer.setAttribute("aria-modal", "true");
  tuer.setAttribute("aria-labelledby", "tu-titel");
  tuer.style.setProperty("--tu-bild", `url("${opt.poster}")`);
  tuer.innerHTML = `
    <div class="tu-bild" aria-hidden="true"></div>
    <form class="tu-form" novalidate>
      <p class="tu-kanji" aria-hidden="true">黒波</p>
      <h1 class="tu-titel" id="tu-titel">Kuronami</h1>
      <p class="tu-grund" data-role="grund"${opt.grund ? "" : " hidden"}></p>
      <label class="tu-feld"><span>Name</span>
        <input name="benutzer" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
      <label class="tu-feld"><span>Passwort</span>
        <input name="passwort" type="password" autocomplete="current-password" required></label>
      <button type="submit" class="tu-knopf" data-role="knopf">Aufschließen</button>
      <p class="tu-stimme" data-role="stimme" role="status" aria-live="polite"></p>
    </form>`;
  root.append(tuer);

  const form = tuer.querySelector<HTMLFormElement>("form");
  const name = tuer.querySelector<HTMLInputElement>('input[name="benutzer"]');
  const passwort = tuer.querySelector<HTMLInputElement>('input[name="passwort"]');
  const knopf = tuer.querySelector<HTMLButtonElement>('[data-role="knopf"]');
  const stimme = tuer.querySelector<HTMLElement>('[data-role="stimme"]');
  const grund = tuer.querySelector<HTMLElement>('[data-role="grund"]');
  if (grund && opt.grund) grund.textContent = opt.grund;
  if (name && opt.benutzer) name.value = opt.benutzer;
  requestAnimationFrame(() => (opt.benutzer ? passwort : name)?.focus());

  let sperrUhr: ReturnType<typeof setInterval> | null = null;
  const sperre = (ms: number): void => {
    if (!knopf || !stimme) return;
    const bis = Date.now() + ms;
    knopf.disabled = true;
    const zeige = (): void => {
      const rest = Math.ceil((bis - Date.now()) / 1000);
      if (rest <= 0) {
        if (sperrUhr !== null) globalThis.clearInterval(sperrUhr);
        sperrUhr = null;
        knopf.disabled = false;
        stimme.textContent = "Du kannst es wieder versuchen.";
        return;
      }
      stimme.textContent = `Zu viele Versuche. Wieder möglich in ${rest} s.`;
    };
    zeige();
    sperrUhr = globalThis.setInterval(zeige, 1000);
  };

  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!name || !passwort || !knopf || !stimme || knopf.disabled) return;
    if (!name.value.trim() || !passwort.value) {
      stimme.textContent = "Name und Passwort, bitte beides.";
      (name.value.trim() ? passwort : name).focus();
      return;
    }
    knopf.disabled = true;
    tuer.classList.add("ist-pruefend");
    stimme.textContent = "Prüfe …";
    const ergebnis = await melde(opt.baseUrl, name.value.trim(), passwort.value);
    tuer.classList.remove("ist-pruefend");
    if (ergebnis.ok) {
      stimme.textContent = "Offen.";
      tuer.classList.add("ist-offen");
      // Erst nach dem Aufgehen weg — das Aufhellen ist der Übergang in die Welle.
      globalThis.setTimeout(() => tuer.remove(), 1100);
      opt.onOffen(ergebnis.token);
      return;
    }
    passwort.value = "";
    passwort.focus();
    tuer.classList.add("ist-abgewiesen");
    globalThis.setTimeout(() => tuer.classList.remove("ist-abgewiesen"), 500);
    if (ergebnis.wartenMs !== undefined && ergebnis.wartenMs > 0) {
      sperre(ergebnis.wartenMs);
    } else {
      knopf.disabled = false;
      stimme.textContent = ergebnis.fehler;
    }
  });

  return () => {
    if (sperrUhr !== null) globalThis.clearInterval(sperrUhr);
    tuer.remove();
  };
}
