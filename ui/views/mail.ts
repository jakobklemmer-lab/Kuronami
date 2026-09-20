import { ApiError } from "../api/client.js";
import { icon } from "../icons.js";
import type { MailData, MailMessage } from "../integrations/types.js";
import { formatRelativeTime } from "./format.js";
import { escapeHtml } from "./html.js";
import type { View, ViewContext } from "./types.js";

/** Eine Nachricht im Volltext, wie `/integrations/mail/nachricht` sie liefert. */
interface MailVolltext {
  von: string;
  an: string;
  betreff: string;
  am: string;
  text: string;
}

/**
 * Feste Farbe je Postfach, nach der Reihenfolge in der Konfiguration.
 *
 * Dieselbe Zuteilung wie auf der Startseite — ein Konto, das dort blau ist, ist es hier auch.
 * Zwei verschiedene Farbschemata für dieselben drei Postfächer wären schlimmer als keins.
 */
const KONTO_FARBEN = ["#6BA8F5", "#E0A75F", "#7FC99B", "#C88BD6", "#E0857D"] as const;

function kontoFarbe(konto: string, alle: readonly string[]): string {
  const i = alle.indexOf(konto);
  return KONTO_FARBEN[(i < 0 ? 0 : i) % KONTO_FARBEN.length];
}

function describeMailError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === "no_token") return "Kein Token hinterlegt — siehe Einstellungen › System.";
    if (error.status === 401) return "Token abgelehnt — in den Einstellungen › System prüfen.";
    if (error.status === 404) {
      return "Kein Postfach verbunden. Unter /postfach/verbinden lässt sich eines hinzufügen.";
    }
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Die Mail-Ansicht.
 *
 * Vorher stand hier eine Liste aus Absender und Betreff, sonst nichts: der Vorschautext war
 * immer leer (Kopfzeilen tragen keinen), die Herkunft stand nirgends, und ein Klick tat nichts.
 * Drei Postfächer sahen aus wie eines.
 *
 * Jetzt steht das Postfach als **Name** an jeder Zeile statt nur als Punkt, eine Filterleiste
 * schaltet auf eines um, und ein Klick lädt den Volltext und klappt ihn auf — in der Zeile und
 * nicht in einer zweiten Spalte, weil die Ansicht auch in einem schmalen Fenster taugen muss.
 */
export const mailView: View = {
  mount(container, ctx: ViewContext) {
    container.innerHTML = `
      <div class="detail-view">
        <header class="detail-view__head">
          ${icon("mail", { className: "detail-view__icon" })}
          <div>
            <h1 class="detail-view__title">Mail</h1>
            <p class="detail-view__subtitle" data-role="subtitle">Lädt …</p>
          </div>
        </header>
        <div class="konten-leiste" data-role="konten" hidden></div>
        <section class="detail-panel glass">
          <ul class="mail-liste" data-role="list"></ul>
        </section>
      </div>
    `;

    const listEl = container.querySelector<HTMLElement>('[data-role="list"]');
    const kontenEl = container.querySelector<HTMLElement>('[data-role="konten"]');
    const subtitleEl = container.querySelector<HTMLElement>('[data-role="subtitle"]');

    let nurKonto: string | null = null;
    let offen: string | null = null;
    let daten: MailData | null = null;
    let entladen = false;
    const volltexte = new Map<string, MailVolltext | string>();

    const ladeVolltext = async (id: string): Promise<void> => {
      const trenner = id.lastIndexOf("#");
      const konto = id.slice(0, trenner);
      const uid = id.slice(trenner + 1);
      try {
        volltexte.set(
          id,
          await ctx.api.get<MailVolltext>(
            `/integrations/mail/nachricht?konto=${encodeURIComponent(konto)}&uid=${encodeURIComponent(uid)}`,
          ),
        );
      } catch (error) {
        volltexte.set(id, describeMailError(error));
      }
      zeichne();
    };

    const zeile = (m: MailMessage, konten: readonly string[]): string => {
      const auf = offen === m.id;
      const inhalt = volltexte.get(m.id);
      const koerper = !auf
        ? ""
        : inhalt === undefined
          ? '<div class="mail-text mail-text--laedt">Wird geladen …</div>'
          : typeof inhalt === "string"
            ? `<div class="mail-text mail-text--fehler">${escapeHtml(inhalt)}</div>`
            : `<div class="mail-text">
                 <div class="mail-text__kopf">An: ${escapeHtml(inhalt.an || "—")}</div>
                 <pre class="mail-text__koerper">${escapeHtml(inhalt.text.trim() || "(kein Textteil)")}</pre>
               </div>`;

      return `
        <li class="mail-eintrag${m.unread ? " ist-ungelesen" : ""}${auf ? " ist-offen" : ""}"
            style="--konto-farbe:${kontoFarbe(m.konto, konten)}">
          <div class="mail-zeile" data-id="${escapeHtml(m.id)}" role="button" tabindex="0"
               aria-expanded="${auf}">
            <span class="mail-konto">${escapeHtml(m.konto)}</span>
            <span class="mail-von">${escapeHtml(m.from)}</span>
            <span class="mail-zeit">${escapeHtml(formatRelativeTime(m.receivedAt))}</span>
            <span class="mail-betreff">${escapeHtml(m.subject)}</span>
          </div>
          ${koerper}
        </li>`;
    };

    const zeichne = (): void => {
      if (!listEl || !daten || entladen) return;
      const konten = daten.konten;

      const sichtbar = nurKonto
        ? daten.messages.filter((m) => m.konto === nurKonto)
        : daten.messages;

      if (subtitleEl) {
        const ungelesen = sichtbar.filter((m) => m.unread).length;
        const woher = nurKonto ? `nur ${nurKonto}` : `${konten.length} Postfächer`;
        subtitleEl.textContent = `${sichtbar.length} Nachrichten · ${ungelesen} ungelesen · ${woher}`;
      }

      if (kontenEl) {
        kontenEl.hidden = konten.length < 2;
        kontenEl.innerHTML = konten
          .map(
            (k) => `
              <button type="button" class="konto-schalter" data-konto="${escapeHtml(k)}"
                      aria-pressed="${nurKonto === k}"
                      style="--konto-farbe:${kontoFarbe(k, konten)}">
                <span class="konto-schalter__punkt"></span>${escapeHtml(k)}
              </button>`,
          )
          .join("");
        for (const knopf of kontenEl.querySelectorAll<HTMLButtonElement>(".konto-schalter")) {
          knopf.addEventListener("click", () => {
            nurKonto = nurKonto === knopf.dataset.konto ? null : (knopf.dataset.konto ?? null);
            zeichne();
          });
        }
      }

      listEl.innerHTML =
        sichtbar.length === 0
          ? '<li class="field__hint">Keine Nachrichten.</li>'
          : sichtbar.map((m) => zeile(m, konten)).join("");

      for (const el of listEl.querySelectorAll<HTMLElement>(".mail-zeile")) {
        const umschalten = (): void => {
          const id = el.dataset.id ?? "";
          offen = offen === id ? null : id;
          if (offen && !volltexte.has(offen)) void ladeVolltext(offen);
          zeichne();
        };
        el.addEventListener("click", umschalten);
        // Mit der Tastatur bedienbar: die Zeile ist ein Knopf, also muss sie sich auch
        // wie einer verhalten.
        el.addEventListener("keydown", (ereignis) => {
          if (ereignis.key === "Enter" || ereignis.key === " ") {
            ereignis.preventDefault();
            umschalten();
          }
        });
      }
    };

    void ctx.api
      .get<MailData>("/integrations/mail")
      .then((d) => {
        daten = d;
        zeichne();
      })
      .catch((error) => {
        if (entladen) return;
        if (subtitleEl) subtitleEl.textContent = describeMailError(error);
        if (listEl) listEl.innerHTML = "";
      });

    return () => {
      entladen = true;
    };
  },
};
