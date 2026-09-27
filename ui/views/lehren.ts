import { escapeHtml } from "./html.js";
import type { ViewContext } from "./types.js";

/**
 * Das Tor der Lernschleife (2026-09-27), oben in den Analysen.
 *
 * Der Handelstisch schaut nach jeder aufgelösten Idee auf die gerechneten Noten zurück und schlägt
 * höchstens eine Lehre vor (`gateway/lehren.ts`). Gelten tut sie erst, wenn Jakob sie hier
 * freigibt — den Wortlaut darf er dabei ändern. Geltende Lehren stehen zugeklappt darunter, jede
 * mit ihrer gerechneten Wirkung; wer eine ablegt, nimmt sie aus dem Prompt des Analysten.
 *
 * Ein Vorschlag steht offen da, alles andere ist zu: das Band soll nur auffallen, wenn es etwas
 * zu entscheiden gibt.
 */

type LehrArt =
  | "crv"
  | "ausloeser"
  | "stop"
  | "ziel"
  | "haltedauer"
  | "baseline"
  | "gegenprobe"
  | "allgemein";
type Urteil =
  | "nicht-messbar"
  | "noch-keine-aussage"
  | "ohne-vergleich"
  | "wirkt"
  | "schadet"
  | "nicht-unterscheidbar";

interface Quote {
  geprueft: number;
  zutreffend: number;
}

export interface LehreSicht {
  id: string;
  angelegt: string;
  an: string;
  art: LehrArt;
  text: string;
  vorschlag?: string;
  begruendung: string;
  quelle: {
    prognoseId?: string;
    strategieId?: string;
    name?: string;
    symbol: string;
    stand: string;
    r: number | null;
    noten: { art: string; zutreffend: boolean | null }[];
  };
  status: "vorgeschlagen" | "aktiv" | "verworfen" | "abgelegt";
  aktivSeit?: string;
  wirkung: {
    urteil: Urteil;
    vorher: Quote;
    seitdem: Quote;
    spanne: [number, number] | null;
  } | null;
}

const ART_NAME: Record<LehrArt, string> = {
  crv: "CRV",
  ausloeser: "Auslöser",
  stop: "Stop",
  ziel: "Ziel",
  haltedauer: "Haltedauer",
  baseline: "Baseline",
  gegenprobe: "Gegenprobe",
  allgemein: "Allgemein",
};

const FUER: Record<string, string> = { boerse: "Chefanalyst", stratege: "Stratege" };

const STAND_WORT: Record<string, string> = {
  ziel: "Ziel erreicht",
  stop: "ausgestoppt",
  verfallen: "verfallen",
  unaufgeloest: "unaufgelöst",
};

const prozent = (anteil: number): string => `${Math.round(anteil * 100).toLocaleString("de-DE")} %`;
const quote = (q: Quote): string =>
  q.geprueft === 0
    ? "nie benotet"
    : `${q.zutreffend} von ${q.geprueft} (${prozent(q.zutreffend / q.geprueft)})`;
const tag = (iso: string): string =>
  new Date(iso).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });

/** Die Wirkung in einem Satz — dieselben Wörter wie im Gateway, keine eigene Deutung. */
export function wirkungText(w: LehreSicht["wirkung"], art: LehrArt): string {
  if (!w) return "";
  const note = ART_NAME[art];
  switch (w.urteil) {
    case "nicht-messbar":
      return "Hängt an keiner Note — ihre Wirkung lässt sich nicht messen.";
    case "noch-keine-aussage":
      return `${note} seitdem ${quote(w.seitdem)} — eine Aussage gibt es ab fünf Fällen.`;
    case "ohne-vergleich":
      return `${note} seitdem ${quote(w.seitdem)} — vorher nie benotet, also kein Vergleich.`;
    default: {
      const spanne = w.spanne ? `, Spanne ${prozent(w.spanne[0])}–${prozent(w.spanne[1])}` : "";
      const schluss =
        w.urteil === "wirkt"
          ? "wirkt"
          : w.urteil === "schadet"
            ? "schadet"
            : "vom Zufall nicht zu unterscheiden";
      return `${note} vorher ${quote(w.vorher)}, seitdem ${quote(w.seitdem)}${spanne} — ${schluss}.`;
    }
  }
}

function herkunft(l: LehreSicht): string {
  if (l.quelle.strategieId)
    return `Aus der Strategie „${l.quelle.name ?? l.quelle.strategieId}" (${l.quelle.symbol}): Gegenprobe ${l.quelle.stand}`;
  const noten = l.quelle.noten
    .filter((n) => n.zutreffend !== null)
    .map((n) => `${ART_NAME[n.art as LehrArt] ?? n.art} ${n.zutreffend ? "✓" : "✗"}`)
    .join(" · ");
  return `Aus ${l.quelle.symbol} vom ${tag((l.quelle.prognoseId ?? l.angelegt).slice(0, 10))}: ${STAND_WORT[l.quelle.stand] ?? l.quelle.stand}${noten ? ` — ${noten}` : ""}`;
}

export function mountLehren(ziel: HTMLElement, ctx: ViewContext): () => void {
  let lehren: LehreSicht[] = [];
  let maxAktiv = 12;
  let nachbetrachtet = 0;
  let fehler = "";
  let verworfen = false;

  const zeichne = (): void => {
    const vorschlaege = lehren.filter((l) => l.status === "vorgeschlagen");
    const geltende = lehren.filter((l) => l.status === "aktiv");
    const ruhende = lehren.filter((l) => l.status === "abgelegt" || l.status === "verworfen");

    const vorschlag = (l: LehreSicht): string => `
      <article class="lehre lehre--vorschlag" data-lehre="${escapeHtml(l.id)}">
        <p class="lehre__kopf"><span class="lehre__art">${escapeHtml(ART_NAME[l.art])}</span> Der ${escapeHtml(FUER[l.an] ?? l.an)} schlägt eine Lehre für sich vor</p>
        <textarea class="lehre__text" rows="${Math.min(6, Math.max(2, Math.ceil(l.text.length / 38)))}" data-role="text" aria-label="Wortlaut der Lehre">${escapeHtml(l.text)}</textarea>
        ${l.begruendung ? `<p class="lehre__warum">${escapeHtml(l.begruendung)}</p>` : ""}
        <p class="lehre__herkunft">${escapeHtml(herkunft(l))}</p>
        <div class="lehre__tat">
          <button type="button" class="lehre__knopf lehre__knopf--ja" data-tat="aktiv">Freigeben</button>
          <button type="button" class="lehre__knopf" data-tat="verworfen">Verwerfen</button>
        </div>
      </article>`;

    const geltend = (l: LehreSicht): string => `
      <li class="lehre" data-lehre="${escapeHtml(l.id)}">
        <p class="lehre__zeile"><span class="lehre__art">${escapeHtml(ART_NAME[l.art])}</span>${escapeHtml(l.text)}</p>
        <p class="lehre__wirkung ist-${escapeHtml(l.wirkung?.urteil ?? "")}">${escapeHtml(wirkungText(l.wirkung, l.art))}</p>
        <p class="lehre__herkunft">${escapeHtml(`${FUER[l.an] ?? l.an} · gilt seit ${tag(l.aktivSeit ?? l.angelegt)}`)} · ${escapeHtml(herkunft(l))}</p>
        <button type="button" class="lehre__knopf lehre__knopf--leise" data-tat="abgelegt">Ablegen</button>
      </li>`;

    const ruhend = (l: LehreSicht): string => `
      <li class="lehre lehre--ruhend" data-lehre="${escapeHtml(l.id)}">
        <p class="lehre__zeile"><span class="lehre__art">${escapeHtml(ART_NAME[l.art])}</span>${escapeHtml(l.text)}</p>
        <p class="lehre__herkunft">${l.status === "verworfen" ? "Verworfen" : "Abgelegt"} · ${escapeHtml(herkunft(l))}</p>
        <button type="button" class="lehre__knopf lehre__knopf--leise" data-tat="aktiv">Wieder gelten lassen</button>
      </li>`;

    const zusammenfassung =
      lehren.length === 0
        ? `noch keine — ${nachbetrachtet === 0 ? "sobald eine Idee aufgelöst oder eine Strategie gegengeprüft ist, schaut der Handelstisch zurück" : `${nachbetrachtet} nachbetrachtet, keine Lehre daraus`}`
        : `${geltende.length} von ${maxAktiv} gelten${vorschlaege.length > 0 ? ` · ${vorschlaege.length} zur Entscheidung` : ""}`;

    ziel.innerHTML = `
      ${fehler ? `<p class="lehren__fehler" role="alert">${escapeHtml(fehler)}</p>` : ""}
      ${vorschlaege.map(vorschlag).join("")}
      <details class="lehren__alle">
        <summary><span class="lehren__titel">Lehren des Handelstischs</span> <span class="lehren__zahl">${escapeHtml(zusammenfassung)}</span></summary>
        <p class="lehren__erklaerung">Nach jeder aufgelösten Idee schaut der Chefanalyst auf seine gerechneten Noten zurück, nach jeder Gegenprobe der Stratege auf ihr Urteil; jeder schlägt höchstens eine Lehre vor — aus Pech keine. Gelten tut sie erst nach deiner Freigabe; dann steht sie im Prompt, und ihre Wirkung wird an derselben Note gemessen.</p>
        ${geltende.length > 0 ? `<ul class="lehren__liste">${geltende.map(geltend).join("")}</ul>` : ""}
        ${ruhende.length > 0 ? `<h4 class="lehren__untertitel">Abgelegt und verworfen</h4><ul class="lehren__liste">${ruhende.map(ruhend).join("")}</ul>` : ""}
      </details>`;
  };

  const lade = async (): Promise<void> => {
    try {
      const d = await ctx.api.get<{
        lehren: LehreSicht[];
        maxAktiv: number;
        nachbetrachtet: number;
      }>("/integrations/lehren");
      if (verworfen) return;
      lehren = d.lehren;
      maxAktiv = d.maxAktiv;
      nachbetrachtet = d.nachbetrachtet;
      fehler = "";
    } catch (e) {
      fehler = e instanceof Error ? e.message : String(e);
    }
    if (!verworfen) zeichne();
  };

  ziel.addEventListener("click", (e) => {
    const knopf = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-tat]");
    const karte = knopf?.closest<HTMLElement>("[data-lehre]");
    if (!knopf || !karte?.dataset.lehre) return;
    const status = knopf.dataset.tat;
    const feld = karte.querySelector<HTMLTextAreaElement>('[data-role="text"]');
    knopf.disabled = true;
    void ctx.api
      .patch(`/integrations/lehren/${encodeURIComponent(karte.dataset.lehre)}`, {
        status,
        ...(feld && status === "aktiv" ? { text: feld.value } : {}),
      })
      .then(
        () => lade(),
        (err) => {
          fehler = err instanceof Error ? err.message : String(err);
          zeichne();
        },
      );
  });

  void lade();
  const abbestellen = ctx.bus.onMessage((rahmen) => {
    if (rahmen.type === "lehre.neu") void lade();
  });
  return () => {
    verworfen = true;
    abbestellen();
  };
}
