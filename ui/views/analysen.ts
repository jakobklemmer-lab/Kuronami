import { icon } from "../icons.js";
import { merkeChartAbsicht } from "../markets/watchlist.js";
import { gruppiereNachTag } from "./format.js";
import { escapeHtml } from "./html.js";
import { mountLehren } from "./lehren.js";
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
  /** ISO-Zeitpunkt der Ablage ins Archiv, oder fehlt: nicht archiviert. */
  archiviert?: string;
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
      <div class="detail-view detail-view--archiv">
        <header class="detail-view__head">
          ${icon("analysen", { className: "detail-view__icon" })}
          <div>
            <h1 class="detail-view__title">Analysen</h1>
            <p class="detail-view__subtitle" data-role="subtitle">Lädt …</p>
          </div>
          <button type="button" class="konto-schalter detail-view__archiv-schalter"
                  data-role="archiv-schalter" aria-pressed="false" hidden></button>
        </header>
        <section class="lehren" aria-label="Lehren des Handelstischs" data-role="lehren"></section>
        <div class="analysen">
          <section class="analysen__liste glass" aria-label="Analysen" data-role="liste"></section>
          <section class="analysen__blatt glass" data-role="blatt">
            <p class="analysen__leer">Links eine Analyse wählen.</p>
          </section>
        </div>
      </div>
    `;

    const listeEl = container.querySelector<HTMLElement>('[data-role="liste"]');
    const blattEl = container.querySelector<HTMLElement>('[data-role="blatt"]');
    const untertitelEl = container.querySelector<HTMLElement>('[data-role="subtitle"]');
    const archivSchalterEl = container.querySelector<HTMLButtonElement>(
      '[data-role="archiv-schalter"]',
    );
    let koepfe: AnalyseKopf[] = [];
    let offen: string | null = null;
    let verworfen = false;
    // Der ruhige Schalter im Kopf (2026-09-28, N2): Standardansicht ohne Archiviertes, hier
    // umgeschaltet auf „nur das Archiv" — Jakob: „sonst müllt mir das die Website zu."
    let archivAnsicht = false;
    let archivAnzahl = 0;

    const zeichneListe = (): void => {
      if (!listeEl) return;
      if (koepfe.length === 0) {
        listeEl.innerHTML = archivAnsicht
          ? '<p class="analysen__leer">Das Archiv ist leer.</p>'
          : '<p class="analysen__leer">Noch nichts abgelegt. Sobald der Handelstisch oder die Recherche einen Bericht liefert, steht er hier.</p>';
        return;
      }
      const uhrzeit = (iso: string): string =>
        new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
      listeEl.innerHTML = gruppiereNachTag(koepfe, (k) => k.zeit)
        .map(
          (g) => `
            <h3 class="analysen__gruppe">${escapeHtml(g.titel)}</h3>
            <ul class="analysen__eintraege">
              ${g.eintraege
                .map(
                  (k) => `
                    <li${archivAnsicht ? ' class="analysen__archivzeile"' : ""}>
                      <button class="analysen__eintrag${k.id === offen ? " ist-aktiv" : ""}" data-id="${escapeHtml(k.id)}"
                              aria-pressed="${k.id === offen}">
                        <span class="analysen__titel">${escapeHtml(k.titel)}</span>
                        <span class="analysen__unter">
                          <span>${escapeHtml(uhrzeit(k.zeit))}${k.zuarbeit.length > 0 ? ` · mit ${escapeHtml(k.zuarbeit.join(", "))}` : ""}</span>
                          ${
                            k.crvGerechnet === undefined
                              ? ""
                              : k.crvGerechnet
                                ? '<span class="analysen__marke ist-gerechnet" title="Das Chance-Risiko-Verhältnis wurde gerechnet, nicht geschätzt.">CRV gerechnet</span>'
                                : '<span class="analysen__marke ist-geschaetzt" title="Der Bericht nennt ein Chance-Risiko-Verhältnis, ohne es zu rechnen.">CRV geschätzt</span>'
                          }
                          ${k.status !== "offen" ? `<span class="analysen__marke ist-${escapeHtml(k.status)}">${escapeHtml(STATUS_LABEL[k.status])}</span>` : ""}
                        </span>
                      </button>
                      ${
                        archivAnsicht
                          ? `<button type="button" class="field__button analysen__zurueckholen" data-zurueckholen="${escapeHtml(k.id)}">Zurückholen</button>`
                          : ""
                      }
                    </li>`,
                )
                .join("")}
            </ul>`,
        )
        .join("");
    };

    const zeichneBlatt = (a: Analyse): void => {
      if (!blattEl) return;
      blattEl.innerHTML = `
        <header class="analysen__kopf">
          ${a.hatIdee ? '<span class="analysen__status-marke ist-idee">Handelbare Idee</span>' : ""}
          <h2>${escapeHtml(a.titel)}</h2>
          <p class="analysen__meta">
            ${escapeHtml(new Date(a.zeit).toLocaleString("de-DE", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }))}
            · von ${escapeHtml(a.wer)}${a.zuarbeit.length > 0 ? ` mit ${escapeHtml(a.zuarbeit.join(", "))}` : ""}
            · ${escapeHtml(dauer(a.dauerMs))}
          </p>
          <div class="analysen__chart" data-role="chart-bezug"></div>
        </header>
        <details class="analysen__mehr analysen__auftrag">
          <summary>Der Auftrag</summary>
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
                       <details class="analysen__mehr">
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
          <h3>Ihre Entscheidung</h3>
          <div class="analysen__status" role="group" aria-label="Status">
            ${(["offen", "gehandelt", "verworfen"] as const)
              .map(
                (s) =>
                  `<button class="analysen__wahl${a.status === s ? " ist-aktiv" : ""}" data-status="${s}" aria-pressed="${a.status === s}">${STATUS_LABEL[s]}</button>`,
              )
              .join("")}
          </div>
          <label class="field">
            <span class="field__label">Notiz</span>
            <textarea class="field__input" rows="3" data-role="notiz"
              placeholder="Warum gehandelt, warum nicht — für später.">${escapeHtml(a.notiz ?? "")}</textarea>
          </label>
          <p class="field__hint" data-role="gemerkt"></p>
          <div class="strategie__knoepfe">
            ${
              a.archiviert
                ? `<span class="strategie__notiz">Archiviert am ${escapeHtml(new Date(a.archiviert).toLocaleDateString("de-AT"))}.</span>
                   <button type="button" class="field__button" data-role="archiv-zurueckholen">Zurückholen</button>`
                : `<button type="button" class="field__button" data-role="archiv-legen">Ins Archiv legen</button>`
            }
          </div>
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
            anderer.setAttribute("aria-pressed", String(anderer === knopf));
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

      blattEl
        .querySelector<HTMLButtonElement>('[data-role="archiv-legen"]')
        ?.addEventListener("click", (ereignis) => {
          const knopf = ereignis.currentTarget as HTMLButtonElement;
          knopf.disabled = true;
          void ctx.api
            .post<AnalyseKopf>(`/integrations/analysen/${a.id}/archiv`, {})
            .then(() => lade())
            .catch((fehler) => {
              knopf.disabled = false;
              sage(fehler instanceof Error ? fehler.message : String(fehler));
            });
        });

      blattEl
        .querySelector<HTMLButtonElement>('[data-role="archiv-zurueckholen"]')
        ?.addEventListener("click", (ereignis) => {
          const knopf = ereignis.currentTarget as HTMLButtonElement;
          knopf.disabled = true;
          void ctx.api
            .delete(`/integrations/analysen/${a.id}/archiv`)
            .then(() => lade())
            .catch((fehler) => {
              knopf.disabled = false;
              sage(fehler instanceof Error ? fehler.message : String(fehler));
            });
        });
    };

    /**
     * „Im Chart zeigen" (2026-09-27): nur, wenn der Lauf dieser Analyse etwas mit Symbol
     * abgelegt hat — eine Idee, eine Strategie — oder der Titel ein eindeutiges Kürzel trägt.
     * Geraten wird nicht; ohne Bezug gibt es den Knopf nicht.
     */
    const zeigeChartBezug = async (id: string): Promise<void> => {
      try {
        const bezug = await ctx.api.get<{
          symbol: string | null;
          prognosen: string[];
          strategien: string[];
        }>(`/integrations/analysen/${encodeURIComponent(id)}/bezug`);
        const ziel = blattEl?.querySelector<HTMLElement>('[data-role="chart-bezug"]');
        if (verworfen || offen !== id || !ziel || !bezug.symbol) return;
        const was = [
          bezug.prognosen.length > 0
            ? `${bezug.prognosen.length === 1 ? "die Idee" : `${bezug.prognosen.length} Ideen`}`
            : "",
          bezug.strategien.length > 0
            ? `${bezug.strategien.length === 1 ? "die Strategie" : `${bezug.strategien.length} Strategien`}`
            : "",
        ].filter(Boolean);
        ziel.innerHTML = `<button type="button" class="analysen__chart-knopf">${icon("trading")} Im Chart zeigen</button>
          <span class="analysen__chart-was">${escapeHtml(bezug.symbol)}${was.length > 0 ? ` · ${escapeHtml(was.join(" und "))} darauf` : ""}</span>`;
        ziel.querySelector("button")?.addEventListener("click", () => {
          merkeChartAbsicht({
            symbol: bezug.symbol as string,
            ...(bezug.strategien[0] ? { strategie: bezug.strategien[0] } : {}),
            ...(bezug.prognosen[0] ? { prognose: bezug.prognosen[0] } : {}),
          });
          ctx.navigate("trading");
        });
      } catch {
        // Kein Bezug abrufbar — dann eben kein Knopf.
      }
    };

    const oeffne = (id: string): void => {
      offen = id;
      zeichneListe();
      if (blattEl) blattEl.innerHTML = '<p class="analysen__leer">Lädt …</p>';
      void ctx.api
        .get<Analyse>(`/integrations/analysen/${id}`)
        .then((a) => {
          if (!verworfen && offen === id) {
            zeichneBlatt(a);
            void zeigeChartBezug(a.id);
          }
        })
        .catch((fehler) => {
          if (blattEl) {
            blattEl.innerHTML = `<p class="analysen__leer">${escapeHtml(
              fehler instanceof Error ? fehler.message : String(fehler),
            )}</p>`;
          }
        });
    };

    listeEl?.addEventListener("click", (ereignis) => {
      const zurueck = (ereignis.target as HTMLElement).closest<HTMLElement>("[data-zurueckholen]");
      if (zurueck?.dataset.zurueckholen) {
        const id = zurueck.dataset.zurueckholen;
        void ctx.api.delete(`/integrations/analysen/${id}/archiv`).then(() => lade());
        return;
      }
      const knopf = (ereignis.target as HTMLElement).closest<HTMLElement>("[data-id]");
      if (knopf?.dataset.id) oeffne(knopf.dataset.id);
    });

    archivSchalterEl?.addEventListener("click", () => {
      archivAnsicht = !archivAnsicht;
      offen = null;
      if (blattEl) blattEl.innerHTML = '<p class="analysen__leer">Lädt …</p>';
      lade();
    });

    const lade = (): void => {
      void ctx.api
        .get<{ analysen: AnalyseKopf[]; archiviert: number }>(
          `/integrations/analysen${archivAnsicht ? "?archiv=1" : ""}`,
        )
        .then((daten) => {
          if (verworfen) return;
          koepfe = daten.analysen;
          archivAnzahl = daten.archiviert;
          if (archivSchalterEl) {
            archivSchalterEl.hidden = archivAnzahl === 0 && !archivAnsicht;
            archivSchalterEl.textContent = `Archiv (${archivAnzahl})`;
            archivSchalterEl.setAttribute("aria-pressed", String(archivAnsicht));
          }
          if (untertitelEl) {
            const ideen = koepfe.filter((k) => k.hatIdee).length;
            untertitelEl.textContent = archivAnsicht
              ? `${koepfe.length} im Archiv`
              : koepfe.length === 0
                ? "Noch keine Analyse abgelegt"
                : `${koepfe.length} abgelegt, davon ${ideen} mit handelbarer Idee`;
          }
          zeichneListe();
          // Beim Aufschlagen gleich die jüngste zeigen — man kommt hierher, um zu lesen. Kommt
          // man aus den Märkten, die dort gewählte.
          let gewuenscht: string | null = null;
          try {
            gewuenscht = globalThis.sessionStorage?.getItem("kuronami.analysen.oeffne") ?? null;
            globalThis.sessionStorage?.removeItem("kuronami.analysen.oeffne");
          } catch {
            gewuenscht = null;
          }
          if (gewuenscht && koepfe.some((k) => k.id === gewuenscht)) oeffne(gewuenscht);
          else if (offen === null && koepfe.length > 0) oeffne(koepfe[0].id);
        })
        .catch((fehler) => {
          if (untertitelEl) {
            untertitelEl.textContent = fehler instanceof Error ? fehler.message : String(fehler);
          }
        });
    };

    lade();
    const lehrenEl = container.querySelector<HTMLElement>('[data-role="lehren"]');
    const lehrenWeg = lehrenEl ? mountLehren(lehrenEl, ctx) : () => undefined;

    // Kommt eine neue Analyse herein, während die Liste offen ist, erscheint sie von selbst.
    const abbestellen = ctx.bus.onMessage((rahmen) => {
      if (rahmen.type === "analyse.neu") lade();
    });

    return () => {
      verworfen = true;
      abbestellen();
      lehrenWeg();
    };
  },
};
