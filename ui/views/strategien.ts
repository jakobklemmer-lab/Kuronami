import { icon } from "../icons.js";
import { anzeigeName } from "../markets/format.js";
import { merkeChartAbsicht } from "../markets/watchlist.js";
import { formatAnteil, formatR, formatTagKurz, formatZahl, kerzenName } from "./format.js";
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
 * Die Liste ist nach dem Status geteilt, den **die Rechnung** vergeben hat, nicht der Analyst:
 * Kandidaten oben, Verworfenes gedämpft unten. Jede Zeile nennt den Erwartungswert in R und
 * worauf er steht, dazu die Übertragbarkeit — auch wenn sie fehlt.
 *
 * Das Blatt (seit 2026-09-26 neu geordnet — Jakob fühlte sich „mit Informationen erschlagen"):
 * fünf Kennzahlen groß, die übrigen klein, **direkt darunter die Vorbehalte**, noch vor allem
 * anderen. Vorher standen die Vorbehalte als Kasten über den Zahlen, elf gleich große Kennzahlen
 * darunter und der Prüfbericht in Schreibmaschinenschrift aufgeklappt am Ende; jetzt liest man
 * erst, was gerechnet wurde, gleich danach, warum man ihm nicht trauen sollte. Regel und
 * Prüfbericht im Wortlaut sind zugeklappt — sie wiederholen, was darüber steht.
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

type Uebertragbarkeit = "uebertragbar" | "gemischt" | "einzelfall";

/** Was die Prüfung über viele Märkte ergeben hat. Fehlt, wenn sie nie gerechnet wurde. */
interface UniversumVermerk {
  einstufung: Uebertragbarkeit;
  maerkte: number;
  gesamtHandel: number;
  gemeinsamErwartungswertR: number;
  begruendung: string;
}

const UEBERTRAGBARKEIT_LABEL: Record<Uebertragbarkeit, string> = {
  uebertragbar: "übertragbar",
  gemischt: "gemischt",
  einzelfall: "Einzelfall",
};

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
  universum?: UniversumVermerk;
  /** ISO-Zeitpunkt der Ablage ins Archiv, oder fehlt: nicht archiviert. */
  archiviert?: string;
}

interface StrategieEintrag extends StrategieKopf {
  strategie: unknown;
  warnungstexte: string[];
  bericht: string;
  notiz?: string;
}

interface PapierKonto {
  strategieId: string;
  name: string;
  symbol: string;
  seit: string;
  erwartetR: number;
  offen: { richtung: string; einstieg: number; stop: number } | null;
  wartetAufEinstieg: boolean;
  handel: { r: number }[];
  gesperrt: boolean;
  sperrgrund?: string;
  zuletztGeprueft: string;
}

const STATUS_LABEL: Record<Status, string> = {
  entwurf: "Entwurf",
  geprueft: "Geprüft",
  kandidat: "Kandidat",
  verworfen: "Verworfen",
};

/** In dieser Reihenfolge stehen die Gruppen der Liste: was in Frage kommt, zuerst. */
export const STATUS_REIHE: readonly Status[] = ["kandidat", "geprueft", "entwurf", "verworfen"];

/** Die Reihenfolge der Wahl im Blatt: der Weg einer Strategie, vom Entwurf bis zum Urteil. */
const STATUS_WEG: readonly Status[] = ["entwurf", "geprueft", "kandidat", "verworfen"];

const GRUPPEN_TITEL: Record<Status, string> = {
  kandidat: "Kandidaten",
  geprueft: "Geprüft",
  entwurf: "Entwürfe",
  verworfen: "Verworfen",
};

/**
 * Die Liste nach Status geteilt, Kandidaten oben, Verworfenes unten. Innerhalb einer Gruppe
 * bleibt die Reihenfolge, in der das Archiv sie liefert. Leere Gruppen fallen weg.
 */
export function gruppiereNachStatus<T extends { status: Status }>(
  koepfe: readonly T[],
): Array<{ status: Status; titel: string; eintraege: T[] }> {
  return STATUS_REIHE.map((status) => ({
    status,
    titel: GRUPPEN_TITEL[status],
    eintraege: koepfe.filter((k) => k.status === status),
  })).filter((g) => g.eintraege.length > 0);
}

/** Die Zeile unter dem Namen: der Erwartungswert und worauf er steht. Nie die Trefferquote
 * allein — sie ist bei Jakobs Ziel die gefährlichste Zahl. */
export function kurz(k: Kennzahlen | null): string {
  if (!k || k.anzahl === 0) return "ohne Prüfung";
  return `${formatR(k.erwartungswertR)} je Handel · ${k.anzahl} Handel`;
}

/** Der Markt, wie man ihn nennt („S&P 500"); unbekannte Kürzel bleiben Kürzel. */
function marktName(symbol: string): string {
  return anzeigeName(symbol, "");
}

export const strategienView: View = {
  mount(container, ctx: ViewContext) {
    container.innerHTML = `
      <div class="detail-view detail-view--archiv">
        <header class="detail-view__head">
          ${icon("strategien", { className: "detail-view__icon" })}
          <div>
            <h1 class="detail-view__title">Strategien</h1>
            <p class="detail-view__subtitle" data-role="subtitle">Lädt …</p>
          </div>
          <button type="button" class="konto-schalter detail-view__archiv-schalter"
                  data-role="archiv-schalter" aria-pressed="false" hidden></button>
        </header>
        <div class="analysen">
          <section class="analysen__liste glass" aria-label="Strategien" data-role="liste"></section>
          <section class="analysen__blatt glass" data-role="blatt">
            <p class="analysen__leer">Links eine Strategie wählen.</p>
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
    let koepfe: StrategieKopf[] = [];
    let konten: PapierKonto[] = [];
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
          : `
          <div class="analysen__leer">
            <p>Noch keine Strategie geprüft.</p>
            <p>Der Handelstisch legt hier ab, was er gerechnet hat — fragen Sie Kuro nach einer
            Strategie für einen Wert, den Sie handeln.</p>
          </div>`;
        return;
      }
      listeEl.innerHTML = gruppiereNachStatus(koepfe)
        .map(
          (g) => `
            <h3 class="analysen__gruppe">${g.titel}<span>${g.eintraege.length}</span></h3>
            <ul class="analysen__eintraege${g.status === "verworfen" ? " ist-verworfen" : ""}">
              ${g.eintraege
                .map(
                  (k) => `
                    <li${archivAnsicht ? ' class="analysen__archivzeile"' : ""}>
                      <button class="analysen__eintrag${k.id === offen ? " ist-aktiv" : ""}" data-id="${escapeHtml(k.id)}"
                              aria-pressed="${k.id === offen}">
                        <span class="analysen__titel">${escapeHtml(k.name)}</span>
                        <span class="analysen__unter">
                          <span>${escapeHtml(marktName(k.symbol))} · ${escapeHtml(kurz(k.kennzahlen))}</span>
                          ${uebertragbarkeitsMarke(k.symbol, k.universum)}
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

    /**
     * Die Kennzahlen in zwei Stufen: fünf, auf die es ankommt, groß — der Erwartungswert zuerst,
     * die Trefferquote nie ohne ihn —, der Rest klein darunter. Vorher standen alle elf gleich
     * groß in einem Raster, und man suchte.
     */
    const kennzahlen = (k: Kennzahlen): string => `
      <dl class="strategie__zahlen">
        <div class="ist-haupt"><dt>Erwartungswert</dt><dd>${formatR(k.erwartungswertR)}</dd></div>
        <div><dt>Trefferquote</dt><dd>${formatAnteil(k.trefferquote * 100)}</dd></div>
        <div><dt>Sharpe</dt><dd>${formatZahl(k.sharpe)}</dd></div>
        <div><dt>Max. Rückschlag</dt><dd>${formatAnteil(k.maxDrawdownProzent)}</dd></div>
        <div><dt>Handel</dt><dd>${k.anzahl}</dd></div>
      </dl>
      <dl class="strategie__nebenzahlen">
        <div><dt>Nettoergebnis</dt><dd>${formatAnteil(k.gesamtrenditeProzent)}</dd></div>
        <div><dt>Profitfaktor</dt><dd>${formatZahl(k.profitFaktor)}</dd></div>
        <div><dt>Sortino</dt><dd>${formatZahl(k.sortino)}</dd></div>
        <div><dt>Gewinn ⌀</dt><dd>${formatR(k.durchschnittGewinnR)}</dd></div>
        <div><dt>Verlust ⌀</dt><dd>${formatR(k.durchschnittVerlustR)}</dd></div>
        <div><dt>Längste Verlustserie</dt><dd>${k.laengsteVerlustserie}</dd></div>
      </dl>`;

    /**
     * Der Betrieb: läuft die Regel schon gegen den laufenden Markt?
     *
     * „Kandidat" heißt geprüft — der Schritt in den Papierhandel ist trotzdem eine eigene
     * Entscheidung, und zwar Jakobs. Solange eine Strategie kein Kandidat ist, reicht ein Satz;
     * vorher stand bei jeder derselbe Absatz.
     */
    const betriebsblock = (e: StrategieEintrag): string => {
      const konto = konten.find((k) => k.strategieId === e.id);
      if (!konto) {
        if (e.status !== "kandidat") {
          return `<p class="strategie__notiz">Papierhandel erst ab dem Status „Kandidat" — also
            wenn die Regel auch im ungesehenen Zeitraum getragen hat.</p>`;
        }
        return `
          <section class="strategie__abschnitt strategie__betrieb">
            <h3>Papierhandel</h3>
            <p>Noch nicht im Betrieb. Der Papierhandel führt die Regel als Code gegen den
            laufenden Markt aus — mit Buchgeld, ohne Broker. Er sperrt sich selbst bei 20 %
            Rückschlag, sechs Verlusten in Folge oder wenn er hinter dem Backtest zurückbleibt.</p>
            <div class="strategie__knoepfe">
              <button class="field__button field__button--haupt" type="button" data-role="papier-start">In den Papierhandel geben</button>
              <span class="field__status" data-role="papier-status"></span>
            </div>
          </section>`;
      }
      const summeR = konto.handel.reduce((a, h) => a + h.r, 0);
      const treffer = konto.handel.filter((h) => h.r > 0).length;
      const lage = konto.gesperrt
        ? `<strong>Gesperrt.</strong> ${escapeHtml(konto.sperrgrund ?? "")}`
        : konto.offen
          ? `Eine Position offen (${escapeHtml(konto.offen.richtung)} ab ${formatZahl(konto.offen.einstieg)}, Stop ${formatZahl(konto.offen.stop)}).`
          : konto.wartetAufEinstieg
            ? "Signal erkannt — Einstieg zur nächsten Eröffnung."
            : "Läuft, gerade ohne Position.";
      return `
        <section class="strategie__abschnitt strategie__betrieb${konto.gesperrt ? " ist-gesperrt" : ""}">
          <h3>Papierhandel seit ${escapeHtml(formatTagKurz(konto.seit.slice(0, 10)))}</h3>
          <p>${lage}</p>
          <p class="strategie__notiz">
            ${konto.handel.length} abgeschlossene Handel${
              konto.handel.length > 0
                ? ` · ${formatAnteil((treffer / konto.handel.length) * 100, 0)} Treffer · ${formatR(summeR / konto.handel.length)} je Handel
                   (Backtest: ${formatR(konto.erwartetR)})`
                : ""
            } · zuletzt geprüft ${escapeHtml(new Date(konto.zuletztGeprueft).toLocaleString("de-AT"))}
          </p>
          <div class="strategie__knoepfe">
            <button class="field__button" type="button" data-role="papier-sperre">
              ${konto.gesperrt ? "Wieder freigeben" : "Sperren"}
            </button>
            <button class="field__button" type="button" data-role="papier-ende">Beenden</button>
            <span class="field__status" data-role="papier-status"></span>
          </div>
        </section>`;
    };

    /**
     * Die Übertragbarkeit als Marke — **auch wenn sie fehlt**.
     *
     * Ein leeres Feld liest sich sonst wie ein bestandener Test. Dieselbe Unterscheidung wie
     * bei „gerechnet/geschätzt“ im Analysen-Archiv: nicht geprüft ist nicht dasselbe wie
     * geprüft und in Ordnung.
     */
    const uebertragbarkeitsMarke = (symbol: string, u?: UniversumVermerk): string => {
      if (u === undefined)
        return '<span class="analysen__marke ist-geschaetzt" title="Die Regel wurde nur an einem Markt gerechnet.">1 Markt</span>';
      // Beim Einzelfall steht der Markt **im** Text: „Einzelfall" allein sagt noch nicht,
      // worauf die Regel beschränkt ist, und genau das ist hier die Kennzeichnung.
      const text =
        u.einstufung === "einzelfall"
          ? `nur ${escapeHtml(marktName(symbol))}`
          : `${UEBERTRAGBARKEIT_LABEL[u.einstufung]} · ${u.maerkte} Märkte`;
      return `<span class="analysen__marke ist-${u.einstufung}" title="${escapeHtml(u.begruendung)}">${text}</span>`;
    };

    const uebertragbarkeit = (e: StrategieEintrag): string => {
      const u = e.universum;
      if (!u) {
        return `
          <section class="strategie__abschnitt strategie__universum ist-offen">
            <h3>Übertragbarkeit nicht gerechnet</h3>
            <p>Die Zahlen stammen aus genau einem Markt. Ob die Regel ein Mechanismus ist oder an
            diesen einen Verlauf angepasst, ist damit offen.</p>
          </section>`;
      }
      const titel =
        u.einstufung === "einzelfall"
          ? `Einzelfall — läuft nur in ${escapeHtml(marktName(e.symbol))}`
          : `Über ${u.maerkte} Märkte: ${UEBERTRAGBARKEIT_LABEL[u.einstufung]}`;
      return `
        <section class="strategie__abschnitt strategie__universum ist-${u.einstufung}">
          <h3>${titel}</h3>
          <p>${escapeHtml(u.begruendung)}${
            u.einstufung === "einzelfall"
              ? ` Das schließt sie nicht aus — sie ist dann eine Regel für ${escapeHtml(marktName(e.symbol))}, keine allgemeine.`
              : ""
          }</p>
        </section>`;
    };

    const zeichneBlatt = (e: StrategieEintrag): void => {
      if (!blattEl) return;
      const markt = marktName(e.symbol);
      blattEl.innerHTML = `
        <header class="analysen__kopf">
          <span class="analysen__status-marke ist-${escapeHtml(e.status)}">${STATUS_LABEL[e.status]}</span>
          <h2>${escapeHtml(e.name)}</h2>
          <p class="analysen__meta">
            ${escapeHtml(markt)}${markt !== e.symbol ? ` <span class="analysen__kuerzel">${escapeHtml(e.symbol)}</span>` : ""}
            · ${escapeHtml(kerzenName(e.intervall))}
            · ${escapeHtml(formatTagKurz(e.von))} bis ${escapeHtml(formatTagKurz(e.bis))}
            · geprüft von ${escapeHtml(e.wer)}
          </p>
          <div class="analysen__chart">
            <button type="button" class="analysen__chart-knopf" data-role="im-chart">${icon("trading")} Im Chart zeigen</button>
            <span class="analysen__chart-was">jeder Handel der Regel auf ${escapeHtml(markt)}, neu gerechnet — dazu, was seit der Ablage geschah</span>
          </div>
        </header>
        ${e.kennzahlen ? kennzahlen(e.kennzahlen) : ""}
        ${
          e.warnungstexte.length > 0
            ? `<section class="strategie__abschnitt strategie__vorbehalte">
                 <h3>${e.warnungstexte.length === 1 ? "Ein Vorbehalt" : `${e.warnungstexte.length} Vorbehalte`} aus der Rechnung</h3>
                 <ul>${e.warnungstexte.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>
               </section>`
            : '<p class="strategie__notiz">Keine Vorbehalte aus der Rechnung.</p>'
        }
        ${uebertragbarkeit(e)}
        ${betriebsblock(e)}
        <details class="analysen__mehr">
          <summary>Die Regel</summary>
          <pre class="strategie__regel">${escapeHtml(JSON.stringify(e.strategie, null, 2))}</pre>
        </details>
        <details class="analysen__mehr">
          <summary>Prüfbericht im Wortlaut</summary>
          <pre class="strategie__bericht">${escapeHtml(e.bericht)}</pre>
        </details>
        <footer class="analysen__fuss">
          <h3>Ihre Entscheidung</h3>
          <div class="analysen__status" role="group" aria-label="Status">
            ${STATUS_WEG.map(
              (s) =>
                `<button class="analysen__wahl${e.status === s ? " ist-aktiv" : ""}" data-status="${s}" aria-pressed="${e.status === s}">${STATUS_LABEL[s]}</button>`,
            ).join("")}
          </div>
          <p class="strategie__notiz">Den Status vergibt die Rechnung — hier überschreiben Sie ihn
            bewusst. Eine Anbindung an einen Broker gibt es nicht.</p>
          <label class="field">
            <span class="field__label">Notiz</span>
            <textarea class="field__input" rows="3" data-role="notiz"
              placeholder="Warum freigegeben, warum nicht.">${escapeHtml(e.notiz ?? "")}</textarea>
          </label>
          <p class="field__hint" data-role="gemerkt"></p>
          <div class="strategie__knoepfe">
            ${
              e.archiviert
                ? `<span class="strategie__notiz">Archiviert am ${escapeHtml(new Date(e.archiviert).toLocaleDateString("de-AT"))}.</span>
                   <button type="button" class="field__button" data-role="archiv-zurueckholen">Zurückholen</button>`
                : `<button type="button" class="field__button" data-role="archiv-legen">Ins Archiv legen</button>`
            }
          </div>
        </footer>
      `;

      blattEl.querySelector('[data-role="im-chart"]')?.addEventListener("click", () => {
        merkeChartAbsicht({ symbol: e.symbol, strategie: e.id });
        ctx.navigate("trading");
      });

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
            anderer.setAttribute("aria-pressed", String(anderer === knopf));
          }
          e.status = status as Status;
          sichere({ status });
        });
      }

      const papierStatus = blattEl.querySelector<HTMLElement>('[data-role="papier-status"]');
      const sagePapier = (t: string): void => {
        if (papierStatus) papierStatus.textContent = t;
      };
      const ladeKonten = (): Promise<void> =>
        ctx.api
          .get<{ konten: PapierKonto[] }>("/integrations/papierhandel")
          .then((daten) => {
            konten = daten.konten;
            if (!verworfen && offen === e.id) zeichneBlatt(e);
          })
          .catch(() => undefined);

      blattEl
        .querySelector<HTMLButtonElement>('[data-role="papier-start"]')
        ?.addEventListener("click", (ereignis) => {
          const knopf = ereignis.currentTarget as HTMLButtonElement;
          knopf.disabled = true;
          sagePapier("Wird gestartet …");
          void ctx.api
            .post<PapierKonto>(`/integrations/papierhandel/${e.id}`, {})
            .then(() => ladeKonten())
            .catch((fehler) => {
              knopf.disabled = false;
              sagePapier(fehler instanceof Error ? fehler.message : String(fehler));
            });
        });

      blattEl
        .querySelector<HTMLButtonElement>('[data-role="papier-sperre"]')
        ?.addEventListener("click", () => {
          const konto = konten.find((k) => k.strategieId === e.id);
          if (!konto) return;
          sagePapier("…");
          void ctx.api
            .patch<PapierKonto>(`/integrations/papierhandel/${e.id}`, {
              gesperrt: !konto.gesperrt,
              grund: konto.gesperrt ? undefined : "Von Jakob gesperrt.",
            })
            .then(() => ladeKonten())
            .catch((fehler) =>
              sagePapier(fehler instanceof Error ? fehler.message : String(fehler)),
            );
        });

      blattEl
        .querySelector<HTMLButtonElement>('[data-role="papier-ende"]')
        ?.addEventListener("click", () => {
          sagePapier("Wird beendet …");
          void ctx.api
            .delete<{ beendet: boolean; handel: number }>(`/integrations/papierhandel/${e.id}`)
            .then((antwort) => {
              sagePapier(`Beendet — ${antwort.handel} Handel liegen im Archiv.`);
              return ladeKonten();
            })
            .catch((fehler) =>
              sagePapier(fehler instanceof Error ? fehler.message : String(fehler)),
            );
        });

      const notizEl = blattEl.querySelector<HTMLTextAreaElement>('[data-role="notiz"]');
      notizEl?.addEventListener("blur", () => {
        if (notizEl.value === (e.notiz ?? "")) return;
        e.notiz = notizEl.value;
        sichere({ notiz: notizEl.value });
      });

      blattEl
        .querySelector<HTMLButtonElement>('[data-role="archiv-legen"]')
        ?.addEventListener("click", (ereignis) => {
          const knopf = ereignis.currentTarget as HTMLButtonElement;
          knopf.disabled = true;
          void ctx.api
            .post<StrategieKopf>(`/integrations/strategien/${e.id}/archiv`, {})
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
            .delete(`/integrations/strategien/${e.id}/archiv`)
            .then(() => lade())
            .catch((fehler) => {
              knopf.disabled = false;
              sage(fehler instanceof Error ? fehler.message : String(fehler));
            });
        });
    };

    const oeffne = (id: string): void => {
      offen = id;
      zeichneListe();
      if (blattEl) blattEl.innerHTML = '<p class="analysen__leer">Lädt …</p>';
      void ctx.api
        .get<StrategieEintrag>(`/integrations/strategien/${id}`)
        .then((e) => {
          if (!verworfen && offen === id) zeichneBlatt(e);
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
        void ctx.api.delete(`/integrations/strategien/${id}/archiv`).then(() => lade());
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

    function lade(): void {
      void Promise.all([
        ctx.api.get<{ strategien: StrategieKopf[]; archiviert: number }>(
          `/integrations/strategien${archivAnsicht ? "?archiv=1" : ""}`,
        ),
        ctx.api
          .get<{ konten: PapierKonto[] }>("/integrations/papierhandel")
          .catch(() => ({ konten: [] as PapierKonto[] })),
      ])
        .then(([daten, betrieb]) => {
          if (verworfen) return;
          koepfe = daten.strategien;
          konten = betrieb.konten;
          archivAnzahl = daten.archiviert;
          if (archivSchalterEl) {
            archivSchalterEl.hidden = archivAnzahl === 0 && !archivAnsicht;
            archivSchalterEl.textContent = `Archiv (${archivAnzahl})`;
            archivSchalterEl.setAttribute("aria-pressed", String(archivAnsicht));
          }
          if (untertitelEl) {
            const kandidaten = koepfe.filter((k) => k.status === "kandidat").length;
            untertitelEl.textContent = archivAnsicht
              ? `${koepfe.length} im Archiv`
              : koepfe.length === 0
                ? "Noch keine Strategie geprüft"
                : `${koepfe.length} abgelegt, davon ${kandidaten} Kandidat${kandidaten === 1 ? "" : "en"}`;
          }
          zeichneListe();
          // Aufgeschlagen wird, was oben in der Liste steht — nicht, was das Archiv zuerst liefert.
          const erste = gruppiereNachStatus(koepfe)[0]?.eintraege[0];
          if (offen === null && erste) oeffne(erste.id);
        })
        .catch((fehler) => {
          if (untertitelEl) {
            untertitelEl.textContent = fehler instanceof Error ? fehler.message : String(fehler);
          }
        });
    }
    lade();

    return () => {
      verworfen = true;
    };
  },
};
