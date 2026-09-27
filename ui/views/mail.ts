import { ApiError } from "../api/client.js";
import { icon } from "../icons.js";
import type { MailData, MailMessage } from "../integrations/types.js";
import { gruppiereNachTag } from "./format.js";
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

const BENANNT: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  zwnj: "",
  zwj: "",
  shy: "",
};

/**
 * Der Textteil zum Lesen. Newsletter bringen dort ganze Stapel von Leerzeilen mit (die Reste
 * ihrer HTML-Tabellen), manche auch rohe HTML-Kürzel als Füllstoff für die Vorschauzeile
 * („&#8199; &zwnj; &#8199; &zwnj; …"). Die Kürzel werden aufgelöst, unsichtbare Füllzeichen fallen
 * weg, mehr als eine Leerzeile in Folge wird zu einer. Am Wortlaut ändert das nichts; die Anzeige
 * maskiert danach wie immer (`escapeHtml`).
 */
export function lesbarerText(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (ganz, name: string) => BENANNT[name.toLowerCase()] ?? ganz)
    .replace(/\u00ad|\u034f|[\u200b-\u200d]|\u2060|\ufeff/g, "")
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/^[ \t]+(?=\S)/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Der Text als Markup, Adressen als Links. Newsletter hängen an jedes Wort eine Tracking-Adresse
 * von drei Zeilen Länge; als Link steht nur noch der Name des Hosts da, die volle Adresse im
 * Tooltip. Nur `http(s)`, alles andere bleibt Text; alles wird maskiert.
 */
export function textMitLinks(text: string): string {
  const teile: string[] = [];
  let rest = 0;
  for (const treffer of text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) {
    const url = treffer[0].replace(/[.,;:!?]+$/, "");
    const start = treffer.index ?? 0;
    teile.push(escapeHtml(text.slice(rest, start)));
    let host = url;
    try {
      host = new URL(url).host;
    } catch {
      // Unlesbar: dann steht die Adresse eben ausgeschrieben da.
    }
    teile.push(
      `<a class="leser__link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(url)}">${escapeHtml(host)}</a>`,
    );
    rest = start + url.length;
  }
  teile.push(escapeHtml(text.slice(rest)));
  return teile.join("");
}

/** Uhrzeit für die Zeile; der Tag steht schon in der Abschnittsüberschrift darüber. */
function uhrzeit(iso: string): string {
  return new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

function langesDatum(iso: string): string {
  return new Date(iso).toLocaleString("de-DE", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Die Mail-Ansicht.
 *
 * Bis 2026-09-26 stand hier eine einzige lange Liste: dreißig Zeilen, jede mit dem Postfachnamen
 * vorneweg, und ein Klick klappte den Text mitten in der Liste auf, sodass alles darunter
 * wegrutschte. Jakob schaute „einfach nicht gern rein".
 *
 * Jetzt:
 *  - Die Liste ist in **Tage** geteilt (Heute, Gestern, Mittwoch …) — dreißig Zeilen werden zu
 *    drei, vier Abschnitten, die man überblickt.
 *  - Das Postfach trägt der **Punkt** (Farbe = Herkunft, voll = ungelesen, wie auf der
 *    Startseite); der Name steht in der Filterleiste darüber, mit der Zahl der ungelesenen, und
 *    im Kopf der geöffneten Nachricht.
 *  - Geöffnet wird **daneben**, in einem Lesebereich; die Liste bleibt stehen. Auf schmalen
 *    Schirmen (Telefon) nimmt die Nachricht die ganze Breite ein, mit einem Weg zurück.
 */
export const mailView: View = {
  mount(container, ctx: ViewContext) {
    container.innerHTML = `
      <div class="detail-view post">
        <header class="detail-view__head">
          ${icon("mail", { className: "detail-view__icon" })}
          <div>
            <h1 class="detail-view__title">Mail</h1>
            <p class="detail-view__subtitle" data-role="subtitle">Lädt …</p>
          </div>
        </header>
        <div class="post__filter" data-role="konten" role="group" aria-label="Postfach" hidden></div>
        <div class="post__flaeche">
          <section class="post__liste glass" aria-label="Nachrichten">
            <div data-role="list"></div>
          </section>
          <section class="post__leser glass" data-role="leser" aria-live="polite">
            <p class="post__leer">Eine Nachricht wählen, um sie hier zu lesen.</p>
          </section>
        </div>
      </div>
    `;

    const wurzel = container.querySelector<HTMLElement>(".post");
    const listEl = container.querySelector<HTMLElement>('[data-role="list"]');
    const leserEl = container.querySelector<HTMLElement>('[data-role="leser"]');
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
      if (offen === id) zeichneLeser();
    };

    const zeile = (m: MailMessage, konten: readonly string[]): string => `
      <li class="brief${m.unread ? " ist-ungelesen" : ""}${offen === m.id ? " ist-offen" : ""}"
          style="--konto-farbe:${kontoFarbe(m.konto, konten)}">
        <button type="button" class="brief__knopf" data-id="${escapeHtml(m.id)}"
                aria-pressed="${offen === m.id}">
          <span class="brief__punkt" title="${escapeHtml(m.konto)}${m.unread ? " · ungelesen" : ""}"></span>
          <span class="brief__von">${escapeHtml(m.from)}</span>
          <time class="brief__zeit" datetime="${escapeHtml(m.receivedAt)}">${escapeHtml(uhrzeit(m.receivedAt))}</time>
          <span class="brief__betreff">${escapeHtml(m.subject || "(ohne Betreff)")}</span>
        </button>
      </li>`;

    const zeichneLeser = (): void => {
      if (!leserEl || !daten || entladen) return;
      wurzel?.classList.toggle("ist-lesend", offen !== null);
      const m = offen ? daten.messages.find((n) => n.id === offen) : undefined;
      if (!m) {
        leserEl.innerHTML =
          '<p class="post__leer">Eine Nachricht wählen, um sie hier zu lesen.</p>';
        return;
      }
      const inhalt = volltexte.get(m.id);
      const koerper =
        inhalt === undefined
          ? '<p class="leser__text leser__text--leise">Wird geladen …</p>'
          : typeof inhalt === "string"
            ? `<p class="leser__text leser__text--fehler">${escapeHtml(inhalt)}</p>`
            : `<div class="leser__text">${textMitLinks(lesbarerText(inhalt.text)) || "(Diese Nachricht hat keinen Textteil.)"}</div>`;
      const an = typeof inhalt === "object" && inhalt.an ? inhalt.an : "";
      leserEl.innerHTML = `
        <article class="leser" style="--konto-farbe:${kontoFarbe(m.konto, daten.konten)}">
          <button type="button" class="leser__zurueck" data-role="zurueck">
            ${icon("back")}<span>Alle Nachrichten</span>
          </button>
          <header class="leser__kopf">
            <h2 class="leser__betreff">${escapeHtml(m.subject || "(ohne Betreff)")}</h2>
            <p class="leser__von"><strong>${escapeHtml(m.from)}</strong></p>
            <p class="leser__meta">
              <span class="leser__konto"><span class="brief__punkt"></span>${escapeHtml(m.konto)}</span>
              <span>${escapeHtml(langesDatum(m.receivedAt))}</span>
              ${an ? `<span class="leser__an">an ${escapeHtml(an)}</span>` : ""}
            </p>
          </header>
          ${koerper}
        </article>`;
      leserEl.scrollTop = 0;
      leserEl.querySelector('[data-role="zurueck"]')?.addEventListener("click", () => {
        const war = offen;
        offen = null;
        zeichne();
        listEl?.querySelector<HTMLElement>(`[data-id="${CSS.escape(war ?? "")}"]`)?.focus();
      });
    };

    const zeichne = (): void => {
      if (!listEl || !daten || entladen) return;
      const konten = daten.konten;

      const sichtbar = nurKonto
        ? daten.messages.filter((m) => m.konto === nurKonto)
        : daten.messages;

      if (subtitleEl) {
        const ungelesen = sichtbar.filter((m) => m.unread).length;
        const woher = nurKonto
          ? `in ${nurKonto}`
          : konten.length === 1
            ? ""
            : `in ${konten.length} Postfächern`;
        subtitleEl.textContent = `${ungelesen} ungelesen von ${sichtbar.length} ${woher}`.trim();
      }

      if (kontenEl) {
        kontenEl.hidden = konten.length < 2;
        const schalter = (k: string | null, text: string, anzahl: number): string => `
          <button type="button" class="konto-schalter" data-konto="${escapeHtml(k ?? "")}"
                  aria-pressed="${nurKonto === k}"
                  ${k ? `style="--konto-farbe:${kontoFarbe(k, konten)}"` : ""}>
            ${k ? '<span class="konto-schalter__punkt"></span>' : ""}${escapeHtml(text)}
            <span class="konto-schalter__zahl">${anzahl}</span>
          </button>`;
        const ungelesenIn = (k: string): number =>
          daten?.messages.filter((m) => m.konto === k && m.unread).length ?? 0;
        kontenEl.innerHTML =
          schalter(null, "Alle", daten.messages.filter((m) => m.unread).length) +
          konten.map((k) => schalter(k, k, ungelesenIn(k))).join("");
        for (const knopf of kontenEl.querySelectorAll<HTMLButtonElement>(".konto-schalter")) {
          knopf.addEventListener("click", () => {
            nurKonto = knopf.dataset.konto ? knopf.dataset.konto : null;
            zeichne();
          });
        }
      }

      listEl.innerHTML =
        sichtbar.length === 0
          ? '<p class="post__leer">Keine Nachrichten.</p>'
          : gruppiereNachTag(sichtbar, (m) => m.receivedAt)
              .map(
                (g) => `
                  <h3 class="post__tag">${escapeHtml(g.titel)}</h3>
                  <ul class="post__briefe">${g.eintraege.map((m) => zeile(m, konten)).join("")}</ul>`,
              )
              .join("");

      zeichneLeser();
    };

    listEl?.addEventListener("click", (ereignis) => {
      const knopf = (ereignis.target as HTMLElement).closest<HTMLElement>("[data-id]");
      const id = knopf?.dataset.id;
      if (!id) return;
      offen = id;
      if (offen && !volltexte.has(offen)) void ladeVolltext(offen);
      zeichne();
    });

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
