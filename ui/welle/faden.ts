import type { ApiClient } from "../api/client.js";
import { escapeHtml } from "../views/html.js";
import { renderMarkdown } from "../views/markdown.js";
import type { Gespraech } from "./gespraech.js";
import { tafelHtml } from "./tafeln.js";
import type { Eintrag } from "./verlauf.js";
import { ZUSTAND_SATZ } from "./zustand.js";

/**
 * Der Faden — das Gespräch, gezeichnet.
 *
 * Zwei Stimmen, zwei Lichter: Jakobs Zeilen tragen das warme der Laterne und stehen rechts,
 * Kuros das kühle seines Zustands und stehen links, in voller Breite, weil sie gelesen werden.
 * Solange Kuro schreibt, leuchtet am Ende seiner Zeile ein Punkt in seiner Farbe.
 *
 * Gezeichnet wird nur, was sich geändert hat: ein Eintrag trägt einen Fingerabdruck, und ein
 * Wortstück ersetzt nur seinen eigenen Text — nicht den ganzen Faden, und nicht die Tafeln, die
 * sonst bei jedem Wort neu geladen würden.
 */

export interface FadenOptionen {
  api: ApiClient;
  gespraech: Gespraech;
  /** Nur Kuros letzte Antwort — für das Blatt über der Eingabe in den anderen Bereichen. */
  nurLetzte?: boolean;
  /** Ein leerer Faden zeigt nichts; das Blatt schließt sich selbst. */
  beiLeere?: (leer: boolean) => void;
}

function fingerabdruck(e: Eintrag, stand: string): string {
  return [
    e.stand,
    e.text.length,
    e.tafeln.join(","),
    e.rueckfrage ? `${e.rueckfrage.askId}:${e.rueckfrage.antwort ?? ""}` : "",
    e.stand === "laeuft" || e.stand === "wartet" ? stand : "",
  ].join("|");
}

function frageHtml(e: Eintrag): string {
  const f = e.rueckfrage;
  if (!f) return "";
  const kanal =
    f.kanal && f.kanal !== "web" ? ` <small>(gestellt über ${escapeHtml(f.kanal)})</small>` : "";
  const unten =
    f.antwort === null
      ? `<div class="f-frage__wahl">${f.optionen
          .map(
            (o) =>
              `<button type="button" class="f-wahl" data-ask="${escapeHtml(f.askId)}" data-option="${escapeHtml(o.id)}">${escapeHtml(o.label)}</button>`,
          )
          .join("")}</div>`
      : f.antwort === "anderswo"
        ? `<p class="f-frage__erledigt">Anderswo beantwortet.</p>`
        : `<p class="f-frage__erledigt">Du hast geantwortet: ${escapeHtml(f.antwort)}</p>`;
  return `<div class="f-frage${f.antwort === null ? " ist-offen" : ""}"><p class="f-frage__text">${escapeHtml(f.frage)}${kanal}</p>${unten}</div>`;
}

export function mountFaden(el: HTMLElement, opt: FadenOptionen): () => void {
  const { gespraech } = opt;
  const knoten = new Map<string, { el: HTMLElement; abdruck: string }>();
  const tafelLaedt = new Set<string>();

  const standSatz = (): string =>
    gespraech.zustand === "arbeiten" && gespraech.detail
      ? `Kuro ${gespraech.detail}`
      : gespraech.zustand === "ruhe" || gespraech.zustand === "offline"
        ? "Kuro denkt nach"
        : ZUSTAND_SATZ[gespraech.zustand];

  const baue = (e: Eintrag): HTMLElement => {
    const art = document.createElement("article");
    art.className = `f-eintrag f-eintrag--${e.von}`;
    art.dataset.id = e.id;
    if (e.von === "kuro") {
      art.innerHTML = `
        <p class="f-herkunft" hidden></p>
        <div class="f-text"></div>
        <p class="f-stand" aria-live="off"></p>
        <div class="f-tafeln"></div>
        <div class="f-frage-ort"></div>`;
    } else {
      art.innerHTML = `<p class="f-text"></p>`;
    }
    return art;
  };

  const fuelle = (art: HTMLElement, e: Eintrag): void => {
    const laeuft = e.stand === "laeuft" || e.stand === "wartet";
    art.classList.toggle("ist-laeuft", laeuft);
    art.classList.toggle("ist-fehler", e.stand === "fehler");
    art.classList.toggle("ist-leer", !e.text);
    const text = art.querySelector<HTMLElement>(".f-text");
    if (e.von === "jakob") {
      if (text) {
        text.textContent = e.text;
        if (e.gesprochen) text.title = "Gesprochen";
      }
      return;
    }
    const herkunft = art.querySelector<HTMLElement>(".f-herkunft");
    if (herkunft) {
      herkunft.hidden = !e.herkunft;
      herkunft.textContent = e.herkunft ?? "";
    }
    if (text) text.innerHTML = e.text ? renderMarkdown(e.text) : "";
    const stand = art.querySelector<HTMLElement>(".f-stand");
    if (stand) {
      stand.hidden = !laeuft || e.text.length > 0;
      stand.textContent = `${standSatz()} …`;
    }
    const tafeln = art.querySelector<HTMLElement>(".f-tafeln");
    if (tafeln) {
      for (const alt of tafeln.querySelectorAll<HTMLElement>("[data-tafel]")) {
        if (!e.tafeln.includes(alt.dataset.tafel as Eintrag["tafeln"][number])) alt.remove();
      }
      for (const t of e.tafeln) {
        if (tafeln.querySelector(`[data-tafel="${t}"]`)) continue;
        const ort = document.createElement("div");
        ort.dataset.tafel = t;
        ort.className = "f-tafel ist-laedt";
        tafeln.append(ort);
        const schluessel = `${e.id}:${t}`;
        if (tafelLaedt.has(schluessel)) continue;
        tafelLaedt.add(schluessel);
        void tafelHtml(t, opt.api).then((html) => {
          ort.innerHTML = html;
          ort.classList.remove("ist-laedt");
          tafelLaedt.delete(schluessel);
        });
      }
    }
    const frageOrt = art.querySelector<HTMLElement>(".f-frage-ort");
    if (frageOrt) frageOrt.innerHTML = frageHtml(e);
  };

  const zeichne = (): void => {
    const alle = gespraech.verlauf.eintraege;
    const zeigen = opt.nurLetzte ? alle.filter((e) => e.von === "kuro").slice(-1) : alle;
    opt.beiLeere?.(zeigen.length === 0);
    const unten = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    const ids = new Set(zeigen.map((e) => e.id));
    for (const [id, k] of knoten) {
      if (!ids.has(id)) {
        k.el.remove();
        knoten.delete(id);
      }
    }
    const stand = standSatz();
    let vorher: HTMLElement | null = null;
    for (const e of zeigen) {
      let k = knoten.get(e.id);
      if (!k) {
        k = { el: baue(e), abdruck: "" };
        knoten.set(e.id, k);
        k.el.classList.add("ist-neu");
        const neu = k.el;
        requestAnimationFrame(() => requestAnimationFrame(() => neu.classList.remove("ist-neu")));
      }
      const abdruck = fingerabdruck(e, stand);
      if (abdruck !== k.abdruck) {
        fuelle(k.el, e);
        k.abdruck = abdruck;
      }
      // Reihenfolge herstellen, ohne Knoten unnötig zu bewegen.
      const soll: ChildNode | null = vorher ? vorher.nextSibling : el.firstChild;
      if (soll !== k.el) el.insertBefore(k.el, soll);
      vorher = k.el;
    }
    // Wer unten war, bleibt unten; wer hochgescrollt hat, um nachzulesen, wird nicht gezogen.
    if (unten) el.scrollTop = el.scrollHeight;
  };

  const beiKlick = (ev: MouseEvent): void => {
    const knopf = (ev.target as Element | null)?.closest<HTMLButtonElement>(".f-wahl");
    if (!knopf) return;
    const askId = knopf.dataset.ask ?? "";
    const optionId = knopf.dataset.option ?? "";
    const eintrag = gespraech.verlauf.eintraege.find((e) => e.rueckfrage?.askId === askId);
    const option = eintrag?.rueckfrage?.optionen.find((o) => o.id === optionId);
    if (option) void gespraech.antworte(askId, option);
  };
  el.addEventListener("click", beiKlick);

  zeichne();
  const abo = gespraech.abonniere((s) => {
    if (s.art === "verlauf" || s.art === "zustand") zeichne();
  });
  return () => {
    abo();
    el.removeEventListener("click", beiKlick);
    el.innerHTML = "";
    knoten.clear();
  };
}
