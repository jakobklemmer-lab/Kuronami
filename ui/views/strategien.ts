import { icon } from "../icons.js";
import { escapeHtml } from "./html.js";
import type { View, ViewContext } from "./types.js";

/**
 * Das Strategie-Archiv.
 *
 * Der Unterschied zu „Analysen" ist der Unterschied zwischen einem Einfall und einem Verfahren:
 * dort liegt eine Einschätzung zu einem Zeitpunkt, hier eine **Regel mit Kennzahlen**. Jakobs
 * Ziel steht dahinter — irgendwann soll eine geprüfte Strategie von selbst laufen, mit echtem
 * Geld. Bis dahin ist das hier die Stelle, an der er entscheidet, was dafür überhaupt in Frage
 * kommt.
 *
 * Deshalb zeigt die Liste zuerst die Zahlen, die eine Strategie tragen oder nicht tragen:
 * Anzahl Handel, Trefferquote, Erwartungswert in R, Sharpe — und den Status, den **die
 * Rechnung** vergeben hat, nicht der Analyst. Die Vorbehalte stehen oben im Blatt, nicht unten:
 * wer eine Strategie freigibt, soll sie gelesen haben.
 */

interface Kennzahlen {
  anzahl: number;
  trefferquote: number;
  erwartungswertR: number;
  profitFaktor: number;
  gesamtrenditeProzent: number;
  maxDrawdownProzent: number;
  sharpe: number;
  sortino: number;
  durchschnittGewinnR: number;
  durchschnittVerlustR: number;
  laengsteVerlustserie: number;
}

type Status = "entwurf" | "geprueft" | "kandidat" | "verworfen";

interface StrategieKopf {
  id: string;
  zeit: string;
  name: string;
  wer: string;
  symbol: string;
  intervall: string;
  von: string;
  bis: string;
  status: Status;
  kennzahlen: Kennzahlen | null;
  warnungen: number;
}

interface StrategieEintrag extends StrategieKopf {
  strategie: unknown;
  warnungstexte: string[];
  bericht: string;
  notiz?: string;
}

const STATUS_LABEL: Record<Status, string> = {
  entwurf: "Entwurf",
  geprueft: "Geprüft",
  kandidat: "Kandidat",
  verworfen: "Verworfen",
};

function prozent(wert: number): string {
  return `${wert.toFixed(1)} %`;
}

function kurz(k: Kennzahlen | null): string {
  if (!k || k.anzahl === 0) return "ohne Prüfung";
  return `${k.anzahl} Handel · ${(k.trefferquote * 100).toFixed(0)} % · ${k.erwartungswertR.toFixed(2)} R · Sharpe ${k.sharpe.toFixed(2)}`;
}

export const strategienView: View = {
  mount(container, ctx: ViewContext) {
    container.innerHTML = `
      <div class="detail-view">
        <header class="detail-view__head">
          ${icon("strategien", { className: "detail-view__icon" })}
          <div>
            <h1 class="detail-view__title">Strategien</h1>
            <p class="detail-view__subtitle" data-role="subtitle">Lädt …</p>
          </div>
        </header>
        <div class="analysen">
          <section class="analysen__liste glass">
            <ul class="detail-list" data-role="liste"></ul>
          </section>
          <section class="analysen__blatt glass" data-role="blatt">
            <p class="field__hint">Links eine Strategie wählen.</p>
          </section>
        </div>
      </div>
    `;

    const listeEl = container.querySelector<HTMLElement>('[data-role="liste"]');
    const blattEl = container.querySelector<HTMLElement>('[data-role="blatt"]');
    const untertitelEl = container.querySelector<HTMLElement>('[data-role="subtitle"]');
    let koepfe: StrategieKopf[] = [];
    let offen: string | null = null;
    let verworfen = false;

    const zeichneListe = (): void => {
      if (!listeEl) return;
      if (koepfe.length === 0) {
        listeEl.innerHTML = `
          <li class="detail-list__leer">
            <p>Noch keine Strategie geprüft.</p>
            <p class="field__hint">Der Handelstisch legt hier ab, was er gerechnet hat —
            fragen Sie Kuro nach einer Strategie für einen Wert, den Sie handeln.</p>
          </li>`;
        return;
      }
      listeEl.innerHTML = koepfe
        .map(
          (k) => `
            <li>
              <button class="analysen__eintrag${k.id === offen ? " ist-aktiv" : ""}" data-id="${escapeHtml(k.id)}">
                <div class="detail-list__head">
                  <p class="detail-list__title">${escapeHtml(k.name)}</p>
                  <span class="detail-list__meta">${escapeHtml(k.symbol)}</span>
                </div>
                <p class="detail-list__body">
                  ${escapeHtml(kurz(k.kennzahlen))}
                  <span class="analysen__marke ist-${escapeHtml(k.status)}">${STATUS_LABEL[k.status]}</span>
                  ${k.warnungen > 0 ? `<span class="analysen__marke ist-geschaetzt">${k.warnungen} Vorbehalt${k.warnungen === 1 ? "" : "e"}</span>` : ""}
                </p>
              </button>
            </li>
          `,
        )
        .join("");
    };

    const kennzahlenTabelle = (k: Kennzahlen): string =>
      `
      <dl class="strategie__zahlen">
        <div><dt>Nettoergebnis</dt><dd>${prozent(k.gesamtrenditeProzent)}</dd></div>
        <div><dt>Handel</dt><dd>${k.anzahl}</dd></div>
        <div><dt>Trefferquote</dt><dd>${prozent(k.trefferquote * 100)}</dd></div>
        <div><dt>Erwartungswert</dt><dd>${k.erwartungswertR.toFixed(2)} R</dd></div>
        <div><dt>Profitfaktor</dt><dd>${Number.isFinite(k.profitFaktor) ? k.profitFaktor.toFixed(2) : "∞"}</dd></div>
        <div><dt>Max. Rückschlag</dt><dd>${prozent(k.maxDrawdownProzent)}</dd></div>
        <div><dt>Sharpe</dt><dd>${k.sharpe.toFixed(2)}</dd></div>
        <div><dt>Sortino</dt><dd>${k.sortino.toFixed(2)}</dd></div>
        <div><dt>Gewinn ⌀</dt><dd>${k.durchschnittGewinnR.toFixed(2)} R</dd></div>
        <div><dt>Verlust ⌀</dt><dd>${k.durchschnittVerlustR.toFixed(2)} R</dd></div>
        <div><dt>Verlustserie</dt><dd>${k.laengsteVerlustserie}</dd></div>
      </dl>`;

    const zeichneBlatt = (e: StrategieEintrag): void => {
      if (!blattEl) return;
      blattEl.innerHTML = `
        <header class="analysen__kopf">
          <h2>${escapeHtml(e.name)}</h2>
          <p class="detail-list__meta">
            ${escapeHtml(e.symbol)} · ${escapeHtml(e.intervall)} · ${escapeHtml(e.von)} bis ${escapeHtml(e.bis)} ·
            geprüft von ${escapeHtml(e.wer)}
          </p>
        </header>
        ${
          e.warnungstexte.length > 0
            ? `<div class="strategie__vorbehalte">
                 <h3>Vorbehalte</h3>
                 <ul>${e.warnungstexte.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>
               </div>`
            : '<p class="field__hint">Keine Vorbehalte aus der Rechnung.</p>'
        }
        ${e.kennzahlen ? kennzahlenTabelle(e.kennzahlen) : ""}
        <details class="analysen__auftrag">
          <summary>Die Regel</summary>
          <pre class="strategie__regel">${escapeHtml(JSON.stringify(e.strategie, null, 2))}</pre>
        </details>
        <details class="analysen__auftrag" open>
          <summary>Prüfbericht</summary>
          <pre class="strategie__bericht">${escapeHtml(e.bericht)}</pre>
        </details>
        <footer class="analysen__fuss">
          <div class="analysen__status" role="group" aria-label="Status">
            ${(["entwurf", "geprueft", "kandidat", "verworfen"] as const)
              .map(
                (s) =>
                  `<button class="analysen__wahl${e.status === s ? " ist-aktiv" : ""}" data-status="${s}">${STATUS_LABEL[s]}</button>`,
              )
              .join("")}
          </div>
          <p class="field__hint">
            Den Status vergibt die Rechnung; hier überschreiben Sie ihn bewusst. „Kandidat“
            heißt geprüft und im ungesehenen Zeitraum bestanden — nicht, dass etwas läuft.
            Eine Anbindung an einen Broker gibt es nicht.
          </p>
          <label class="field">
            <span class="field__label">Notiz</span>
            <textarea class="field__input" rows="3" data-role="notiz"
              placeholder="Warum freigegeben, warum nicht.">${escapeHtml(e.notiz ?? "")}</textarea>
          </label>
          <p class="field__hint" data-role="gemerkt"></p>
        </footer>
      `;

      const gemerkt = blattEl.querySelector<HTMLElement>('[data-role="gemerkt"]');
      const sage = (t: string): void => {
        if (gemerkt) gemerkt.textContent = t;
      };

      const sichere = (felder: { status?: string; notiz?: string }): void => {
        void ctx.api
          .patch<StrategieEintrag>(`/integrations/strategien/${e.id}`, felder)
          .then((neu) => {
            if (verworfen) return;
            const i = koepfe.findIndex((k) => k.id === neu.id);
            if (i >= 0) koepfe[i] = { ...koepfe[i], status: neu.status };
            zeichneListe();
            sage("Gemerkt.");
          })
          .catch((fehler) => sage(fehler instanceof Error ? fehler.message : String(fehler)));
      };

      for (const knopf of blattEl.querySelectorAll<HTMLButtonElement>(".analysen__wahl")) {
        knopf.addEventListener("click", () => {
          const status = knopf.dataset.status;
          if (!status) return;
          for (const anderer of blattEl.querySelectorAll(".analysen__wahl")) {
            anderer.classList.toggle("ist-aktiv", anderer === knopf);
          }
          e.status = status as Status;
          sichere({ status });
        });
      }

      const notizEl = blattEl.querySelector<HTMLTextAreaElement>('[data-role="notiz"]');
      notizEl?.addEventListener("blur", () => {
        if (notizEl.value === (e.notiz ?? "")) return;
        e.notiz = notizEl.value;
        sichere({ notiz: notizEl.value });
      });
    };

    const oeffne = (id: string): void => {
      offen = id;
      zeichneListe();
      if (blattEl) blattEl.innerHTML = '<p class="field__hint">Lädt …</p>';
      void ctx.api
        .get<StrategieEintrag>(`/integrations/strategien/${id}`)
        .then((e) => {
          if (!verworfen && offen === id) zeichneBlatt(e);
        })
        .catch((fehler) => {
          if (blattEl) {
            blattEl.innerHTML = `<p class="field__hint">${escapeHtml(
              fehler instanceof Error ? fehler.message : String(fehler),
            )}</p>`;
          }
        });
    };

    listeEl?.addEventListener("click", (ereignis) => {
      const knopf = (ereignis.target as HTMLElement).closest<HTMLElement>("[data-id]");
      if (knopf?.dataset.id) oeffne(knopf.dataset.id);
    });

    void ctx.api
      .get<{ strategien: StrategieKopf[] }>("/integrations/strategien")
      .then((daten) => {
        if (verworfen) return;
        koepfe = daten.strategien;
        if (untertitelEl) {
          const kandidaten = koepfe.filter((k) => k.status === "kandidat").length;
          untertitelEl.textContent =
            koepfe.length === 0
              ? "Noch keine Strategie geprüft"
              : `${koepfe.length} abgelegt, davon ${kandidaten} Kandidat${kandidaten === 1 ? "" : "en"}`;
        }
        zeichneListe();
        if (offen === null && koepfe.length > 0) oeffne(koepfe[0].id);
      })
      .catch((fehler) => {
        if (untertitelEl) {
          untertitelEl.textContent = fehler instanceof Error ? fehler.message : String(fehler);
        }
      });

    return () => {
      verworfen = true;
    };
  },
};
