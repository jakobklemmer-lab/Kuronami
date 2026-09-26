import type { ApiClient } from "../api/client.js";
import type { ResearchData } from "../integrations/types.js";
import { formatPercent } from "../markets/format.js";
import { formatRelativeTime } from "../views/format.js";
import { escapeHtml } from "../views/html.js";
import { kurzSymbol, strategieStand, wann, werName } from "./form.js";
import type { Gespraech } from "./gespraech.js";
import {
  fehlerHtml,
  hole,
  kalenderHtml,
  kurseHtml,
  postHtml,
  systemHtml,
  wetterHtml,
} from "./tafeln.js";
import { laufzeit } from "./zustand.js";

/**
 * „Dein Tag" — was unter Kuro liegt, wenn man weiterscrollt.
 *
 * Die Präsenz hatte rechts drei gedimmte Glaskarten; hier ist Platz für mehr, und er wird der
 * Reihe nach gelesen: was heute ansteht, was in der Post liegt, wie die Märkte stehen, wer im
 * Haus arbeitet, und was zuletzt fertig wurde. Während man liest, fährt der Film hinter der Seite
 * aus dem Raum hinaus auf die Terrasse — oben ist man bei Kuro, unten draußen bei den Laternen.
 *
 * Jeder Abschnitt sagt zuerst in einem Satz, was los ist, und zeigt darunter das Einzelne. Der
 * Satz ist das, was man beim Vorbeiscrollen mitnimmt.
 */

interface Analyse {
  id: string;
  zeit: string;
  wer: string;
  titel: string;
}
interface Strategie {
  id: string;
  zeit: string;
  name: string;
  symbol: string;
  status: string;
}

const ABSCHNITTE = [
  { id: "heute", titel: "Heute", ziel: "#/calendar", link: "Kalender öffnen" },
  { id: "post", titel: "Post", ziel: "#/mail", link: "Alle Briefe" },
  { id: "maerkte", titel: "Märkte", ziel: "#/trading", link: "Zu den Märkten" },
  { id: "haus", titel: "Im Haus", ziel: "#/system", link: "Läufe und Kosten" },
  { id: "zuletzt", titel: "Zuletzt", ziel: "#/analysen", link: "Alle Analysen" },
] as const;

type AbschnittId = (typeof ABSCHNITTE)[number]["id"];

export function mountTag(el: HTMLElement, opt: { api: ApiClient; gespraech: Gespraech }) {
  const { api, gespraech } = opt;
  el.innerHTML = ABSCHNITTE.map(
    (a) => `
      <section class="d-abschnitt d-abschnitt--${a.id}" data-abschnitt="${a.id}">
        <header class="d-kopf">
          <h2 class="d-titel">${a.titel}</h2>
          <p class="d-satz" data-role="satz"></p>
          <a class="d-link" href="${a.ziel}">${a.link}</a>
        </header>
        <div class="d-inhalt" data-role="inhalt"><div class="d-laedt" aria-label="Lädt"></div></div>
      </section>`,
  ).join("");

  let weg = false;
  const setze = (id: AbschnittId, satz: string, inhalt: string): void => {
    if (weg) return;
    const ab = el.querySelector<HTMLElement>(`[data-abschnitt="${id}"]`);
    const s = ab?.querySelector<HTMLElement>('[data-role="satz"]');
    const i = ab?.querySelector<HTMLElement>('[data-role="inhalt"]');
    if (s) s.textContent = satz;
    if (i) i.innerHTML = inhalt;
  };

  // ------------------------------------------------------------- Heute
  const heute = async (): Promise<void> => {
    const [wetter, kalender] = await Promise.allSettled([hole.wetter(), hole.kalender(api)]);
    const teile: string[] = [];
    let satz = "";
    if (wetter.status === "fulfilled") {
      satz = `${wetter.value.description}, ${Math.round(wetter.value.temperature)}° in ${wetter.value.place}.`;
      teile.push(wetterHtml(wetter.value));
    } else {
      teile.push(fehlerHtml(wetter.reason));
    }
    if (kalender.status === "fulfilled") {
      const k = kalender.value;
      satz += !k.connected
        ? " Der Kalender ist nicht verbunden."
        : k.events.length === 0
          ? " Kein Termin."
          : k.events.length === 1
            ? " Ein Termin."
            : ` ${k.events.length} Termine.`;
      teile.push(kalenderHtml(k));
    } else {
      teile.push(fehlerHtml(kalender.reason));
    }
    setze("heute", satz.trim(), `<div class="d-zwei">${teile.join("")}</div>`);
  };

  // -------------------------------------------------------------- Post
  const post = async (): Promise<void> => {
    try {
      const m = await hole.post(api);
      const neueste = m.messages[0];
      // „vor 3 Std." bringt seinen Punkt schon mit, „gerade eben" nicht.
      const zeit = neueste ? formatRelativeTime(neueste.receivedAt) : "";
      const zuletzt = zeit ? ` Der neueste kam ${zeit}${zeit.endsWith(".") ? "" : "."}` : "";
      const satz =
        m.unreadCount === 0 ? `Alles gelesen.${zuletzt}` : `${m.unreadCount} ungelesen.${zuletzt}`;
      setze("post", satz, postHtml(m, 5, false));
    } catch (error) {
      setze("post", "Die Post ist gerade nicht abrufbar.", fehlerHtml(error));
    }
  };

  // ------------------------------------------------------------ Märkte
  const maerkte = async (): Promise<void> => {
    try {
      const d = await hole.kurse(api);
      const rauf = d.quotes.filter((q) => q.changePct >= 0).length;
      const groesster = [...d.quotes].sort(
        (a, b) => Math.abs(b.changePct) - Math.abs(a.changePct),
      )[0];
      const satz =
        d.quotes.length === 0
          ? "Nichts auf der Beobachtungsliste."
          : `${rauf} von ${d.quotes.length} im Plus${groesster ? `, am meisten bewegt ${kurzSymbol(groesster.symbol)} mit ${formatPercent(groesster.changePct)}` : ""}.`;
      setze("maerkte", satz, kurseHtml(d));
    } catch (error) {
      setze("maerkte", "Die Kurse sind gerade nicht abrufbar.", fehlerHtml(error));
    }
  };

  // ----------------------------------------------------------- Im Haus
  let rechner = "";
  const haus = (): void => {
    const jetzt = Date.now();
    const arbeit = [...gespraech.arbeit.entries()];
    const satz =
      arbeit.length === 0
        ? "Gerade arbeitet niemand."
        : arbeit.length === 1
          ? `${werName(arbeit[0][0])} arbeitet seit ${laufzeit(arbeit[0][1].seit, jetzt)}.`
          : `${arbeit.length} arbeiten gerade.`;
    const laufend = arbeit
      .map(
        ([wer, a]) => `
          <li class="d-auftrag">
            <span class="d-auftrag__licht" aria-hidden="true"></span>
            <span class="d-auftrag__wer">${escapeHtml(werName(wer))}</span>
            <span class="d-auftrag__stand">${escapeHtml(a.stand)}</span>
            <span class="d-auftrag__zeit t-zahl">${laufzeit(a.seit, jetzt)}</span>
          </li>`,
      )
      .join("");
    const chronik = gespraech.chronik
      .slice(0, 6)
      .map(
        (c) => `
          <li class="d-chronik__eintrag"><span class="t-zahl">${escapeHtml(new Date(c.zeit).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }))}</span>
            <span><strong>${escapeHtml(werName(c.wer))}</strong> ${escapeHtml(c.text)}</span></li>`,
      )
      .join("");
    setze(
      "haus",
      satz,
      `<div class="d-zwei">
        <div>
          ${laufend ? `<ul class="d-auftraege">${laufend}</ul>` : ""}
          ${chronik ? `<ol class="d-chronik">${chronik}</ol>` : laufend ? "" : `<p class="t-leer">Seit du hier bist, ist im Haus nichts geschehen. Aufträge an die Bediensteten erscheinen hier, sobald Kuro sie vergibt.</p>`}
        </div>
        <div>${rechner}</div>
      </div>`,
    );
  };
  const holeRechner = async (): Promise<void> => {
    try {
      rechner = systemHtml(await hole.system(api));
    } catch (error) {
      rechner = fehlerHtml(error);
    }
    haus();
  };

  // ----------------------------------------------------------- Zuletzt
  const zuletzt = async (): Promise<void> => {
    const [analysen, strategien, recherche] = await Promise.allSettled([
      api.get<{ analysen: Analyse[] }>("/integrations/analysen"),
      api.get<{ strategien: Strategie[] }>("/integrations/strategien"),
      api.get<ResearchData>("/integrations/research"),
    ]);
    const zeilen: Array<{ zeit: string; html: string }> = [];
    if (analysen.status === "fulfilled") {
      for (const a of analysen.value.analysen.slice(0, 4)) {
        zeilen.push({
          zeit: a.zeit,
          html: `<a class="d-werk" href="#/analysen"><span class="d-werk__art">Analyse</span><span class="d-werk__titel">${escapeHtml(a.titel)}</span><span class="d-werk__zeit">${escapeHtml(werName(a.wer))}, ${escapeHtml(wann(a.zeit))}</span></a>`,
        });
      }
    }
    if (strategien.status === "fulfilled") {
      for (const s of strategien.value.strategien.slice(0, 3)) {
        zeilen.push({
          zeit: s.zeit,
          html: `<a class="d-werk" href="#/strategien"><span class="d-werk__art">Strategie, ${escapeHtml(strategieStand(s.status))}</span><span class="d-werk__titel">${escapeHtml(s.name)} <small>${escapeHtml(kurzSymbol(s.symbol))}</small></span><span class="d-werk__zeit">${escapeHtml(wann(s.zeit))}</span></a>`,
        });
      }
    }
    if (recherche.status === "fulfilled") {
      for (const f of recherche.value.findings.slice(0, 3)) {
        zeilen.push({
          zeit: f.savedAt,
          html: `<a class="d-werk" href="#/research"><span class="d-werk__art">Recherche</span><span class="d-werk__titel">${escapeHtml(f.summary.slice(0, 140))}</span><span class="d-werk__zeit">${escapeHtml(wann(f.savedAt))}</span></a>`,
        });
      }
    }
    zeilen.sort((a, b) => Date.parse(b.zeit) - Date.parse(a.zeit));
    const fehler = [analysen, strategien, recherche]
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => fehlerHtml(r.reason))
      .join("");
    const juengste = zeilen[0];
    setze(
      "zuletzt",
      juengste ? `Zuletzt fertig geworden: ${wann(juengste.zeit)}.` : "Noch nichts abgelegt.",
      `<div class="d-werke">${zeilen
        .slice(0, 7)
        .map((z) => z.html)
        .join("")}</div>${fehler}`,
    );
  };

  const alles = (): void => {
    void heute();
    void post();
    void maerkte();
    void holeRechner();
    void zuletzt();
  };
  alles();
  const uhr = globalThis.setInterval(alles, 60_000);
  // Die Laufzeiten im Haus ticken sichtbar mit, solange jemand arbeitet.
  const sekunde = globalThis.setInterval(() => {
    if (gespraech.arbeit.size > 0) haus();
  }, 1000);
  const abo = gespraech.abonniere((s) => {
    if (s.art === "arbeit") haus();
  });

  return () => {
    weg = true;
    globalThis.clearInterval(uhr);
    globalThis.clearInterval(sekunde);
    abo();
  };
}
