import { holeLage, melde } from "./anmeldung.js";

/**
 * Die Anmeldemaske — die erste Fläche, die jemand sieht, der die Adresse kennt.
 *
 * Bewusst karg: Name, Passwort, ein Knopf. **Kein „Konto anlegen", kein „Passwort vergessen"**
 * — beides wären Türen, hinter denen niemand steht. Dieses Haus hat einen Nutzer; ein zweiter
 * Zugang entsteht auf dem Server, nicht in einem Formular.
 *
 * Die Maske sagt bei einem Fehlversuch nie, welcher Teil falsch war. Das ist nicht Höflichkeit,
 * sondern derselbe Grund wie im Gateway: „Benutzer unbekannt" verrät, welche Namen es gibt.
 *
 * **Den Namen trägt die Maske selbst ein** (2026-09-26). Er ist kein Geheimnis: `GET /auth/lage`
 * nennt ihn jedem, der fragt — die Maske braucht ihn ohnehin, um zu wissen, ob sie kommen soll.
 * Ihn den Bewohner abtippen zu lassen, verschenkt also nichts und kostet: ein Vertipper im Namen
 * sieht hinter derselben vagen Fehlerzeile genauso aus wie ein falsches Passwort.
 */

export interface AnmeldeMaskeOptionen {
  baseUrl: string;
  /** Wird mit dem frischen Sitzungsticket aufgerufen. Danach räumt sich die Maske selbst ab. */
  onAngemeldet(token: string): void;
  /** Warum die Maske kommt — z. B. nach einer abgelaufenen Sitzung. */
  grund?: string;
  fetchImpl?: typeof fetch;
}

export function zeigeAnmeldung(host: HTMLElement, optionen: AnmeldeMaskeOptionen): () => void {
  const wurzel = document.createElement("div");
  wurzel.className = "anmeldung";
  wurzel.innerHTML = `
    <form class="anmeldung__karte" autocomplete="on">
      <p class="anmeldung__marke">Kuronami</p>
      <h1 class="anmeldung__titel">Anmeldung</h1>
      <p class="anmeldung__zeile">${optionen.grund ?? "Dieses Haus hat einen Bewohner."}</p>
      <label class="anmeldung__feld">
        <span>Benutzer</span>
        <input name="benutzer" type="text" autocomplete="username" autocapitalize="none"
               autocorrect="off" spellcheck="false" required />
      </label>
      <label class="anmeldung__feld">
        <span>Passwort</span>
        <input name="passwort" type="password" autocomplete="current-password" required />
      </label>
      <button class="anmeldung__knopf" type="submit">Anmelden</button>
      <p class="anmeldung__fehler" role="alert" hidden></p>
    </form>
  `;
  host.appendChild(wurzel);

  const form = wurzel.querySelector("form") as HTMLFormElement;
  const benutzerEl = wurzel.querySelector('input[name="benutzer"]') as HTMLInputElement;
  const passwortEl = wurzel.querySelector('input[name="passwort"]') as HTMLInputElement;
  const knopfEl = wurzel.querySelector("button") as HTMLButtonElement;
  const fehlerEl = wurzel.querySelector(".anmeldung__fehler") as HTMLElement;

  const abraeumen = (): void => wurzel.remove();

  benutzerEl.focus();

  // Der Name kommt vom Gateway, nicht aus dem Gedächtnis. Getippt wird nur, was geheim ist.
  // Wer schon im Feld steht, wird nicht überrumpelt: nur ein leeres Feld wird gefüllt, und der
  // Sprung ins Passwortfeld geschieht nur, solange der Fokus noch unberührt beim Namen steht.
  void holeLage(optionen.baseUrl, optionen.fetchImpl).then((lage) => {
    if (lage.benutzer === null || benutzerEl.value !== "") return;
    benutzerEl.value = lage.benutzer;
    if (document.activeElement === benutzerEl) passwortEl.focus();
  });

  form.addEventListener("submit", (ereignis) => {
    ereignis.preventDefault();
    const benutzer = benutzerEl.value.trim();
    const passwort = passwortEl.value;
    if (benutzer === "" || passwort === "") return;

    knopfEl.disabled = true;
    knopfEl.textContent = "Einen Moment…";
    fehlerEl.hidden = true;

    void melde(optionen.baseUrl, benutzer, passwort, optionen.fetchImpl).then((ergebnis) => {
      if (ergebnis.ok) {
        optionen.onAngemeldet(ergebnis.token);
        abraeumen();
        return;
      }
      // Das Passwortfeld wird geleert, der Name bleibt stehen: wer sich vertippt hat, tippt
      // das Passwort neu — den Namen kennt er.
      passwortEl.value = "";
      passwortEl.focus();
      fehlerEl.textContent = ergebnis.fehler;
      fehlerEl.hidden = false;
      knopfEl.disabled = false;
      knopfEl.textContent = "Anmelden";
    });
  });

  return abraeumen;
}
