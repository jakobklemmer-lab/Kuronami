import { icon } from "../icons.js";
import { formatRelativeTime } from "./format.js";
import { escapeHtml } from "./html.js";
import { renderMarkdown } from "./markdown.js";
import type { View, ViewContext } from "./types.js";

/**
 * Das Analysen-Archiv.
 *
 * Eine Handelsidee wird einmal vorgetragen und ist dann weg — im Gespräch verschüttet, bei
 * Sprachbedienung restlos. Jakob will sie vor dem Einstieg noch einmal lesen können, und zwar
 * samt der Gegenprüfung: die liefert regelmäßig den Einwand, der in der vorgetragenen
 * Kurzfassung untergeht (am 20.9.2026 etwa, dass Solana trotz des Ausbruchs 55 % unter dem
 * Jahreshoch stand und das Chance-Risiko-Verhältnis auf das erste Ziel nur 0,86:1 betrug).
 *
 * Deshalb ein eigener Bereich und keine Karte in Markets: das hier ist Lesestoff, kein Blick.
 * Links die Liste, rechts der Bericht im Wortlaut, darunter aufklappbar, was jeder Spezialist
 * gesagt hat. Der Status ist Jakobs Haken an der eigenen Entscheidung — offen, gehandelt,
 * verworfen —, die Notiz sein Platz für das Warum.
 */

interface AnalyseKopf {
  id: string;
  zeit: string;
  wer: string;
  titel: string;
  auftrag: string;
  hatIdee: boolean;
  /** Ob ein genanntes Chance-Risiko-Verhältnis gerechnet wurde. Fehlt: keine Kennzahl im Bericht. */
  crvGerechnet?: boolean;
  zuarbeit: string[];
  status: "offen" | "gehandelt" | "verworfen";
  kostenUsd: number;
  dauerMs: number;
}

interface Analyse extends AnalyseKopf {
  bericht: string;
  beitraege: Array<{ wer: string; frage: string; antwort: string }>;
  notiz?: string;
}

const STATUS_LABEL: Record<AnalyseKopf["status"], string> = {
  offen: "Offen",
  gehandelt: "Gehandelt",
  verworfen: "Verworfen",
};

function dauer(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
}

/**
 * Der Titel steht schon über dem Blatt — wenn der Bericht mit derselben Überschrift anfängt,
 * stünde sie zweimal untereinander.
 */
function ohneDoppelteUeberschrift(bericht: string, titel: string): string {
  const zeilen = bericht.split("\n");
  const erste = (zeilen[0] ?? "")
    .replace(/[#*_`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (erste !== "" && erste === titel) return zeilen.slice(1).join("\n").trimStart();
  return bericht;
}

export const analysenView: View = {
  mount(container, ctx: ViewContext) {
    container.innerHTML = `
      <div class="detail-view">
        <header class="detail-view__head">
          ${icon("analysen", { className: "detail-view__icon" })}
          <div>
            <h1 class="detail-view__title">Analysen</h1>
            <p class="detail-view__subtitle" data-role="subtitle">Lädt …</p>
          </div>
        </header>
        <div class="analysen">
          <section class="analysen__liste glass">
            <ul class="detail-list" data-role="liste"></ul>
          </section>
          <section class="analysen__blatt glass" data-role="blatt">
            <p class="field__hint">Links eine Analyse wählen.</p>
          </section>
        </div>
      </div>
    `;

    const listeEl = container.querySelector<HTMLElement>('[data-role="liste"]');
    const blattEl = container.querySelector<HTMLElement>('[data-role="blatt"]');
    const untertitelEl = container.querySelector<HTMLElement>('[data-role="subtitle"]');
    let koepfe: AnalyseKopf[] = [];
    let offen: string | null = null;
    let verworfen = false;

    const zeichneListe = (): void => {
      if (!listeEl) return;
      if (koepfe.length === 0) {
        listeEl.innerHTML =
          '<li class="field__hint">Noch nichts abgelegt. Sobald der Handelstisch oder die Recherche einen Bericht liefert, steht er hier.</li>';
        return;
      }
      listeEl.innerHTML = koepfe
        .map(
          (k) => `
            <li>
              <button class="analysen__eintrag${k.id === offen ? " ist-aktiv" : ""}" data-id="${escapeHtml(k.id)}">
                <div class="detail-list__head">
                  <p class="detail-list__title">${escapeHtml(k.titel)}</p>
                  <span class="detail-list__meta">${escapeHtml(formatRelativeTime(k.zeit))}</span>
                </div>
                <p class="detail-list__body">
                  ${escapeHtml(k.wer)}${k.zuarbeit.length > 0 ? ` · ${escapeHtml(k.zuarbeit.join(", "))}` : ""}
                  ${k.hatIdee ? '<span class="analysen__marke">Idee</span>' : ""}
                  ${
                    k.crvGerechnet === undefined
                      ? ""
                      : k.crvGerechnet
                        ? '<span class="analysen__marke ist-gerechnet" title="Das Chance-Risiko-Verhältnis wurde gerechnet, nicht geschätzt.">CRV gerechnet</span>'
                        : '<span class="analysen__marke ist-geschaetzt" title="Der Bericht nennt ein Chance-Risiko-Verhältnis, ohne es zu rechnen.">CRV geschätzt</span>'
                  }
                  ${k.status !== "offen" ? `<span class="analysen__marke ist-${escapeHtml(k.status)}">${escapeHtml(STATUS_LABEL[k.status])}</span>` : ""}
                </p>
              </button>
            </li>
          `,
        )
        .join("");
    };

    const zeichneBlatt = (a: Analyse): void => {
      if (!blattEl) return;
      blattEl.innerHTML = `
        <header class="analysen__kopf">
          <h2>${escapeHtml(a.titel)}</h2>
          <p class="detail-list__meta">
            ${escapeHtml(a.wer)} · ${escapeHtml(new Date(a.zeit).toLocaleString("de-AT"))} ·
            ${escapeHtml(dauer(a.dauerMs))}${a.zuarbeit.length > 0 ? ` · zugearbeitet: ${escapeHtml(a.zuarbeit.join(", "))}` : ""}
          </p>
        </header>
        <details class="analysen__auftrag">
          <summary>Auftrag</summary>
          <p>${escapeHtml(a.auftrag)}</p>
        </details>
        <article class="analysen__bericht markdown">${renderMarkdown(ohneDoppelteUeberschrift(a.bericht, a.titel))}</article>
        ${
          a.beitraege.length > 0
            ? `<div class="analysen__zuarbeit">
                 <h3>Zuarbeit im Wortlaut</h3>
                 ${a.beitraege
                   .map(
                     (b) => `
                       <details>
                         <summary>${escapeHtml(b.wer)}</summary>
                         <p class="analysen__frage">${escapeHtml(b.frage)}</p>
                         <div class="markdown">${renderMarkdown(b.antwort)}</div>
                       </details>
                     `,
                   )
                   .join("")}
               </div>`
            : ""
        }
        <footer class="analysen__fuss">
          <div class="analysen__status" role="group" aria-label="Status">
            ${(["offen", "gehandelt", "verworfen"] as const)
              .map(
                (s) =>
                  `<button class="analysen__wahl${a.status === s ? " ist-aktiv" : ""}" data-status="${s}">${STATUS_LABEL[s]}</button>`,
              )
              .join("")}
          </div>
          <label class="field">
            <span class="field__label">Notiz</span>
            <textarea class="field__input" rows="3" data-role="notiz"
              placeholder="Warum gehandelt, warum nicht — für später.">${escapeHtml(a.notiz ?? "")}</textarea>
          </label>
          <p class="field__hint" data-role="gemerkt"></p>
        </footer>
      `;

      const gemerkt = blattEl.querySelector<HTMLElement>('[data-role="gemerkt"]');
      const sage = (text: string): void => {
        if (gemerkt) gemerkt.textContent = text;
      };

      const sichere = (felder: { status?: string; notiz?: string }): void => {
        void ctx.api
          .patch<Analyse>(`/integrations/analysen/${a.id}`, felder)
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
          a.status = status as Analyse["status"];
          sichere({ status });
        });
      }

      // Die Notiz wird beim Verlassen des Feldes gesichert, nicht bei jedem Tastendruck —
      // ein Schreibvorgang je Zeichen wäre für eine Datei auf der Platte unsinnig.
      const notizEl = blattEl.querySelector<HTMLTextAreaElement>('[data-role="notiz"]');
      notizEl?.addEventListener("blur", () => {
        if (notizEl.value === (a.notiz ?? "")) return;
        // Gleich mitführen, sonst schreibt jedes weitere Verlassen des Feldes dieselbe Notiz
        // noch einmal auf die Platte.
        a.notiz = notizEl.value;
        sichere({ notiz: notizEl.value });
      });
    };

    const oeffne = (id: string): void => {
      offen = id;
      zeichneListe();
      if (blattEl) blattEl.innerHTML = '<p class="field__hint">Lädt …</p>';
      void ctx.api
        .get<Analyse>(`/integrations/analysen/${id}`)
        .then((a) => {
          if (!verworfen && offen === id) zeichneBlatt(a);
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

    const lade = (): void => {
      void ctx.api
        .get<{ analysen: AnalyseKopf[] }>("/integrations/analysen")
        .then((daten) => {
          if (verworfen) return;
          koepfe = daten.analysen;
          if (untertitelEl) {
            const ideen = koepfe.filter((k) => k.hatIdee).length;
            untertitelEl.textContent =
              koepfe.length === 0
                ? "Noch keine Analyse abgelegt"
                : `${koepfe.length} abgelegt, davon ${ideen} mit handelbarer Idee`;
          }
          zeichneListe();
          // Beim Aufschlagen gleich die jüngste zeigen — man kommt hierher, um zu lesen.
          if (offen === null && koepfe.length > 0) oeffne(koepfe[0].id);
        })
        .catch((fehler) => {
          if (untertitelEl) {
            untertitelEl.textContent = fehler instanceof Error ? fehler.message : String(fehler);
          }
        });
    };

    lade();

    // Kommt eine neue Analyse herein, während die Liste offen ist, erscheint sie von selbst.
    const abbestellen = ctx.bus.onMessage((rahmen) => {
      if (rahmen.type === "analyse.neu") lade();
    });

    return () => {
      verworfen = true;
      abbestellen();
    };
  },
};
