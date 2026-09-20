import { signalFor } from "../events/bus.js";
import { icon } from "../icons.js";
import { escapeHtml } from "../views/html.js";
import type { View, ViewContext } from "../views/types.js";
import { meldeStatus } from "./huelle.js";
import { type Karte, renderActivity, renderMarkets, renderSystem, renderWetter } from "./karten.js";
import { type Sphaere, type Zustand, mountSphaere } from "./sphaere.js";

/**
 * Die Präsenz — nach Jakobs Bild.
 *
 * Ein Raum bei Dämmerung, und darin steht Kuronami: eine Glassphäre mit einem Lichtband auf
 * einem Tresen. Oben die Uhr und ein Gruß, rechts drei Karten aus Glas, unten die eine Bubble
 * mit fünf Vorschlägen. Die Leiste links gehört zur Hülle (`huelle.ts`), nicht zu dieser Ansicht. Unter der Sphäre sein Name — und darunter
 * das, was er gerade sagt. In Ruhe steht dort sein Motto; sobald er spricht, spricht er.
 *
 * Zwei Dinge aus dem Text-Prompt liegen über dem Bild: die Karten ruhen gedimmt und treten
 * nur hervor, wenn Kuro sie zeigt oder Jakob fragt; und im Fokus bleibt nichts als Sphäre, Uhr
 * und Bubble.
 */

interface MessageResponse {
  status: string;
  delivered?: Array<{ kind: string; text?: string; question?: string }>;
}
interface PendingResponse {
  pending?: Array<{ askId: string; question: string }>;
}
interface OutboxResponse {
  deliveries?: Array<{ message: { kind: string; text?: string } }>;
}

const MOTTO = "Always here. Always working.";
const NAME = "Jakob";

const CHIPS: Array<{ label: string; ikon: Parameters<typeof icon>[0]; text: string }> = [
  { label: "Check my emails", ikon: "mail", text: "Kuro, was ist an Mails reingekommen?" },
  { label: "Show me the markets", ikon: "trading", text: "Kuro, wie stehen die Märkte?" },
  { label: "What's on my calendar?", ikon: "calendar", text: "Kuro, was steht heute im Kalender?" },
  { label: "Check my server", ikon: "system", text: "Kuro, wie geht es dem Rechner?" },
  { label: "Research something", ikon: "research", text: "Kuro, recherchiere für mich: " },
];

/** Welche Karte eine Tafel der Bühne hervorhebt. */
const TAFEL_ZU_KARTE: Record<string, Karte | "wetter"> = {
  wetter: "wetter",
  kurse: "markets",
  post: "activity",
  kalender: "activity",
  system: "system",
};

const HERVOR_MS = 45_000;

const SEND_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12l16-8-6 16-3-6-7-2z"/></svg>`;

function gruss(d = new Date()): string {
  const h = d.getHours();
  const tageszeit =
    h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  return `${tageszeit}, ${NAME}.`;
}

export const praesenzView: View = {
  mount(container, ctx: ViewContext) {
    container.innerHTML = `
      <div class="praesenz">
        <header class="p-wetter" data-role="wetter" data-karte="wetter"></header>

        <main class="p-mitte">
          <p class="p-datum" data-role="datum"></p>
          <time class="p-uhr" data-role="uhr"></time>
          <p class="p-gruss" data-role="gruss"></p>
          <button type="button" class="p-sphaere-knopf" data-role="sphaere-knopf" aria-label="Kuro zuhören lassen">
            <div class="p-orb" data-role="sphaere" role="img" aria-label="Kuronami"></div>
          </button>
          <p class="p-name">Kuronami</p>
          <p class="p-worte">${MOTTO}</p>
        </main>

        <aside class="p-karten">
          <section class="karte" data-karte="activity">
            <header class="karte__kopf"><span class="karte__titel">${icon("bell")} Recent Activity</span></header>
            <div class="karte__inhalt" data-role="activity"><div class="k-leer">…</div></div>
          </section>
          <section class="karte" data-karte="system">
            <header class="karte__kopf"><span class="karte__titel">${icon("system")} System Overview</span><a class="karte__link" href="#/system">View</a></header>
            <div class="karte__inhalt" data-role="system"><div class="k-leer">…</div></div>
          </section>
          <section class="karte" data-karte="markets">
            <header class="karte__kopf"><span class="karte__titel">${icon("trading")} Markets</span><a class="karte__link" href="#/trading">View all</a></header>
            <div class="karte__inhalt" data-role="markets"><div class="k-leer">…</div></div>
          </section>
        </aside>

        <footer class="p-fuss">
          <!--
            Die Arbeitsleiste. Sie steht **über** dem Antwortpanel und lebt unabhängig vom Zug:
            ein Auftrag an den Handelstisch läuft weiter, lange nachdem Kuro „ich melde mich"
            gesagt hat — am 20.9.2026 im längsten Fall 594 Sekunden. Solange stand hier nichts,
            und Jakob fragte viermal nach, was denn los sei. Jetzt steht hier, wer arbeitet
            und woran.
          -->
          <section class="p-arbeit" data-role="arbeit" hidden aria-live="polite"></section>
          <section class="p-antwort" data-role="antwort" hidden aria-live="polite">
            <header class="p-antwort__kopf">
              <span class="p-antwort__frage" data-role="antwort-frage"></span>
              <button type="button" class="p-antwort__zu" data-role="antwort-zu" aria-label="Close">×</button>
            </header>
            <div class="p-antwort__text" data-role="antwort-text"></div>
            <div class="p-antwort__stand" data-role="antwort-stand"></div>
          </section>
          <form class="p-bubble" data-role="bubble">
            <button type="button" class="p-bubble__mic" data-role="mic" aria-label="Talk to Kuro">${icon("mic")}</button>
            <textarea class="p-bubble__eingabe" data-role="eingabe" rows="1"
                      placeholder="Tell me what you need..." aria-label="Tell Kuro what you need"
                      autocomplete="off"></textarea>
            <button type="submit" class="p-bubble__senden" data-role="senden" aria-label="Send">${SEND_SVG}</button>
          </form>
          <div class="p-chips">
            ${CHIPS.map(
              (c, i) =>
                `<button type="button" class="p-chip" data-chip="${i}">${icon(c.ikon)}<span>${escapeHtml(c.label)}</span></button>`,
            ).join("")}
          </div>
          <button type="button" class="p-fokus" data-role="fokus" title="Focus (Esc to leave)">${icon("focus")}</button>
        </footer>
      </div>
    `;

    const q = <T extends Element>(role: string): T | null =>
      container.querySelector<T>(`[data-role="${role}"]`);
    const orbHost = q<HTMLElement>("sphaere");
    const eingabe = q<HTMLTextAreaElement>("eingabe");
    const bubble = q<HTMLFormElement>("bubble");
    const antwortEl = q<HTMLElement>("antwort");
    const antwortText = q<HTMLElement>("antwort-text");
    const antwortFrage = q<HTMLElement>("antwort-frage");
    const antwortStand = q<HTMLElement>("antwort-stand");
    const arbeitEl = q<HTMLElement>("arbeit");
    const uhrEl = q<HTMLElement>("uhr");
    const datumEl = q<HTMLElement>("datum");
    const grussEl = q<HTMLElement>("gruss");
    const micKnopf = q<HTMLButtonElement>("mic");
    const sphaereKnopf = q<HTMLButtonElement>("sphaere-knopf");
    if (!orbHost || !eingabe || !bubble || !antwortEl || !antwortText || !antwortFrage)
      return () => {};

    const ruhig = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const sphaere: Sphaere = mountSphaere(orbHost, { reducedMotion: ruhig });

    // ------------------------------------------------------------------ Uhr
    const zeigeZeit = (): void => {
      const d = new Date();
      if (uhrEl)
        uhrEl.textContent = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
      if (datumEl) {
        datumEl.textContent = d.toLocaleDateString("en-GB", {
          weekday: "long",
          day: "numeric",
          month: "long",
          year: "numeric",
        });
      }
      if (grussEl) grussEl.textContent = gruss(d);
    };
    zeigeZeit();
    const uhrTimer = globalThis.setInterval(zeigeZeit, 1000);

    // --------------------------------------------------------------- Karten
    const nochmal = new Set<string>();
    const lade = (role: string, html: Promise<string>, erneut?: () => Promise<string>): void => {
      void html.then((h) => {
        const el = q<HTMLElement>(role);
        if (!el || entladen) return;
        el.innerHTML = h;
        // Beim allerersten Laden kann der Token gerade erst gesetzt sein; dann steht hier
        // für eine Minute eine Fehlermeldung. Ein einziger zweiter Versuch räumt das weg.
        if (
          erneut &&
          /k-leer|Not connected|unavailable|Nicht abrufbar/.test(h) &&
          !nochmal.has(role)
        ) {
          nochmal.add(role);
          globalThis.setTimeout(() => lade(role, erneut()), 4000);
        }
      });
    };
    let entladen = false;
    const ladeKarten = (): void => {
      lade("wetter", renderWetter(), renderWetter);
      lade("activity", renderActivity(ctx.api), () => renderActivity(ctx.api));
      lade("system", renderSystem(ctx.api), () => renderSystem(ctx.api));
      lade("markets", renderMarkets(ctx.api), () => renderMarkets(ctx.api));
    };
    ladeKarten();
    const kartenTimer = globalThis.setInterval(ladeKarten, 60_000);

    const hervorTimer = new Map<string, ReturnType<typeof setTimeout>>();
    const hebeHervor = (karte: string): void => {
      const el = container.querySelector<HTMLElement>(`[data-karte="${karte}"]`);
      if (!el) return;
      el.classList.add("ist-aktiv");
      const alt = hervorTimer.get(karte);
      if (alt) globalThis.clearTimeout(alt);
      hervorTimer.set(
        karte,
        globalThis.setTimeout(() => el.classList.remove("ist-aktiv"), HERVOR_MS),
      );
      // Frische Zahlen, wenn Kuro darauf zeigt.
      if (karte === "markets") lade("markets", renderMarkets(ctx.api));
      if (karte === "system") lade("system", renderSystem(ctx.api));
      if (karte === "activity") lade("activity", renderActivity(ctx.api));
      if (karte === "wetter") lade("wetter", renderWetter());
    };
    const alleZurueck = (): void => {
      for (const el of container.querySelectorAll(".ist-aktiv")) el.classList.remove("ist-aktiv");
      for (const t of hervorTimer.values()) globalThis.clearTimeout(t);
      hervorTimer.clear();
    };

    // ------------------------------------------------------------- Zustand
    let inFlight = false;
    const arbeitende = new Set<string>();

    const zustandNeu = (hinweis?: Zustand): void => {
      if (hinweis) {
        sphaere.setZustand(hinweis);
        return;
      }
      if (arbeitende.size > 0) sphaere.setZustand("arbeiten");
      else if (inFlight) sphaere.setZustand("denken");
      else if (ctx.mic.state === "listening") sphaere.setZustand("zuhoeren");
      else sphaere.setZustand("ruhe");
      meldeStatus(
        arbeitende.size > 0
          ? `Working · ${[...arbeitende].join(", ")}`
          : inFlight
            ? "Thinking"
            : ctx.mic.state === "listening"
              ? "Listening"
              : "Online",
      );
    };

    /**
     * Die Antwort steht im Panel über der Bubble — linksbündig, lesbar, bleibt stehen.
     *
     * Zuerst stand sie zentriert unter der Sphäre, auf drei Zeilen gekappt. Das war als Bild
     * hübsch und als Text unbenutzbar: Fließtext gehört nah an die Eingabe, an eine Kante,
     * in ein begrenztes Feld. Das Motto unter der Sphäre bleibt; gesprochen wird hier.
     */
    const zeigeAntwort = (
      text: string,
      opts: { frage?: string; rueckfrage?: boolean } = {},
    ): void => {
      // Ein leeres Panel ist kein Panel: sichtbar wird es erst mit einer eigenen Frage oder
      // mit Text. Ein fremder Zug, der nur leert, öffnet nichts.
      if (text || opts.frage) antwortEl.hidden = false;
      antwortEl.classList.toggle("ist-frage", opts.rueckfrage === true);
      if (opts.frage !== undefined) antwortFrage.textContent = opts.frage;
      antwortText.textContent = text;
      antwortText.scrollTop = antwortText.scrollHeight;
    };
    const haengeAn = (stueck: string): void => {
      antwortEl.hidden = false;
      antwortEl.classList.remove("ist-frage");
      antwortText.textContent = `${antwortText.textContent ?? ""}${stueck}`;
      antwortText.scrollTop = antwortText.scrollHeight;
    };
    /** Was gerade passiert — die stummen Sekunden vor dem ersten Wort bekommen eine Stimme. */
    const setStand = (text: string): void => {
      if (antwortStand) antwortStand.textContent = text;
    };

    /**
     * Die Arbeitsleiste: wer arbeitet, seit wann, woran.
     *
     * Getrennt vom Antwortpanel, weil der Auftrag den Zug überlebt. Die Laufzeit tickt
     * mit — „seit 4 min" beantwortet die Frage, die Jakob sonst stellt, bevor er sie stellt.
     */
    const arbeit = new Map<string, { seit: number; stand: string }>();
    const zeichneArbeit = (): void => {
      if (!arbeitEl) return;
      if (arbeit.size === 0) {
        arbeitEl.hidden = true;
        arbeitEl.innerHTML = "";
        return;
      }
      arbeitEl.hidden = false;
      arbeitEl.innerHTML = [...arbeit.entries()]
        .map(([wer, a]) => {
          const s = Math.round((Date.now() - a.seit) / 1000);
          const seit = s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
          return `<div class="p-arbeit__zeile">
              <span class="p-arbeit__punkt"></span>
              <span class="p-arbeit__wer">${escapeHtml(wer)}</span>
              <span class="p-arbeit__stand">${escapeHtml(a.stand)}</span>
              <span class="p-arbeit__zeit">seit ${seit}</span>
            </div>`;
        })
        .join("");
    };
    // Einmal pro Sekunde, damit die Laufzeit sichtbar läuft. Ohne Arbeit kostet das nichts.
    const arbeitUhr = globalThis.setInterval(() => {
      if (arbeit.size > 0) zeichneArbeit();
    }, 1000);
    const WERKZEUG_STAND: Record<string, string> = {
      WebFetch: "Schlägt nach …",
      WebSearch: "Sucht …",
      Read: "Liest nach …",
      Write: "Notiert …",
      mcp__haus__beauftrage: "Gibt weiter …",
      mcp__haus__stand: "Sieht nach, wie weit es ist …",
      mcp__haus__abbrechen: "Zieht den Auftrag zurück …",
      mcp__buehne__zeige: "Legt eine Tafel hin …",
      mcp__versand__sende: "Verschickt …",
    };
    const schliesseAntwort = (): void => {
      antwortEl.hidden = true;
      antwortText.textContent = "";
      antwortFrage.textContent = "";
    };
    q<HTMLButtonElement>("antwort-zu")?.addEventListener("click", schliesseAntwort);

    // -------------------------------------------------------------- Senden
    const wachsen = (): void => {
      eingabe.style.height = "auto";
      eingabe.style.height = `${Math.min(eingabe.scrollHeight, 132)}px`;
      bubble.classList.toggle("ist-mehrzeilig", eingabe.scrollHeight > 44);
    };

    const sende = async (textVorgabe?: string): Promise<void> => {
      const text = (textVorgabe ?? eingabe.value).trim();
      if (!text || inFlight) return;
      eingabe.value = "";
      wachsen();
      zeigeAntwort("", { frage: text });
      setStand("Denkt …");
      inFlight = true;
      zustandNeu("denken");

      const pendingTimer = globalThis.setInterval(async () => {
        try {
          const p = await ctx.api.get<PendingResponse>("/channels/web/pending");
          const offen = p.pending?.[0];
          if (offen && !antwortEl.classList.contains("ist-frage")) {
            zeigeAntwort(offen.question, { rueckfrage: true });
            zustandNeu("zuhoeren");
          }
        } catch {
          // kein Grund für Aufregung
        }
      }, 1500);

      try {
        const antwort = await ctx.api.post<MessageResponse>("/channels/web/messages", {
          content: text,
        });
        const reply = antwort.delivered?.find((d) => d.kind === "reply")?.text;
        if (reply) zeigeAntwort(reply);
      } catch (error) {
        zeigeAntwort(error instanceof Error ? error.message : String(error));
      } finally {
        globalThis.clearInterval(pendingTimer);
        setStand("");
        inFlight = false;
        sphaere.fertig();
        globalThis.setTimeout(() => zustandNeu(), 900);
      }
    };

    bubble.addEventListener("submit", (e) => {
      e.preventDefault();
      void sende();
    });
    eingabe.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void sende();
      }
    });
    eingabe.addEventListener("input", wachsen);
    eingabe.addEventListener("focus", () => {
      if (!inFlight && arbeitende.size === 0) sphaere.setZustand("zuhoeren");
    });
    eingabe.addEventListener("blur", () => {
      if (!inFlight) zustandNeu();
    });

    for (const knopf of container.querySelectorAll<HTMLButtonElement>(".p-chip")) {
      knopf.addEventListener("click", () => {
        const chip = CHIPS[Number(knopf.dataset.chip)];
        if (!chip) return;
        // Ein offener Vorschlag („recherchiere für mich: ") wartet auf die Ergänzung, ein
        // fertiger geht sofort.
        if (chip.text.endsWith(": ")) {
          eingabe.value = chip.text;
          eingabe.focus();
          eingabe.setSelectionRange(chip.text.length, chip.text.length);
          wachsen();
        } else {
          void sende(chip.text);
        }
      });
    }

    // ------------------------------------------------------------- Stimme
    const zuhoerenUmschalten = (): void => {
      if (ctx.voice) ctx.voice.toggle();
      else ctx.mic.toggleListening();
    };
    micKnopf?.addEventListener("click", zuhoerenUmschalten);
    sphaereKnopf?.addEventListener("click", zuhoerenUmschalten);
    const micAbo = ctx.mic.subscribe((state) => {
      micKnopf?.classList.toggle("ist-an", state === "listening");
      sphaereKnopf?.setAttribute("aria-pressed", String(state === "listening"));
      if (!inFlight) zustandNeu();
    });

    // ------------------------------------------------------ Ereignisstrom
    // Der Ereignis-Socket spielt beim Verbinden die letzten Ereignisse nach — darunter die
    // Textstücke früherer Züge. Ohne diese Grenze hingen sie sich ans Panel, mitten im Wort
    // beginnend, als kämen sie gerade erst. Was vor dem Öffnen dieser Ansicht geschah, geht
    // sie nichts an.
    const geoeffnetUm = Date.now() - 1500;

    /**
     * Welcher Zug gerade im Panel steht.
     *
     * Das ist die Grenze, die am 2026-09-20 gefehlt hat. Der Motor schickt die Textstücke
     * aller Züge über dieselbe Leitung; ohne eine Kennung daran hängte diese Ansicht sie
     * einfach aneinander, und nach vier gesprochenen Fragen stand hier ein einziger Absatz
     * aus vier Antworten. Eine Antwort je Zug — der Wechsel der Kennung räumt die vorige weg.
     */
    let gezeigterZug: string | null = null;
    const neuerZug = (zugId: string): void => {
      gezeigterZug = zugId;
      antwortEl.classList.remove("ist-frage");
      antwortText.textContent = "";
      // Ein fremder Zug (Sprachschicht, zweites Fenster, ein Nachtrag) bringt seine Frage
      // nicht mit. Die alte darüber stehen zu lassen wäre eine falsche Zuordnung; den
      // eigenen Zug hat `sende` schon beschriftet.
      if (!inFlight) antwortFrage.textContent = "";
    };

    const busAbo = ctx.bus.onMessage((message) => {
      const wann = Date.parse(message.timestamp);
      if (Number.isFinite(wann) && wann < geoeffnetUm) return;
      const data = (message.data ?? {}) as Record<string, unknown>;

      if (message.type === "turn.started") {
        const zugId = typeof data.turn_id === "string" ? data.turn_id : "";
        if (zugId && zugId !== gezeigterZug) neuerZug(zugId);
        if (!inFlight) {
          antwortEl.hidden = false;
          setStand("Denkt …");
          sphaere.setZustand("denken");
        }
        return;
      }

      if (message.type === "turn.completed") {
        const zugId = typeof data.turn_id === "string" ? data.turn_id : "";
        // Der fertige Text statt der Summe der Stücke: er trägt die Absätze zwischen zwei
        // Wortmeldungen und ist auch dann vollständig, wenn ein Stück unterwegs verloren ging.
        const fertig = typeof data.text === "string" ? data.text : "";
        if (zugId && zugId === gezeigterZug && fertig) zeigeAntwort(fertig);
        setStand("");
        sphaere.fertig();
        if (!inFlight) globalThis.setTimeout(() => zustandNeu(), 900);
        return;
      }

      if (message.type === "model.delta") {
        const payload = (data.payload ?? data) as Record<string, unknown>;
        const stueck = typeof payload.text === "string" ? payload.text : "";
        if (!stueck) return;
        // Auch ohne `turn.started` (ein Ereignis kann ausfallen, ein Fenster kann mitten im
        // Zug aufgehen) reicht die Kennung am Stück selbst, um die Grenze zu ziehen.
        const zugId = typeof payload.turn_id === "string" ? payload.turn_id : "";
        if (zugId && zugId !== gezeigterZug) neuerZug(zugId);
        if (antwortEl.classList.contains("ist-frage")) {
          antwortEl.classList.remove("ist-frage");
          antwortText.textContent = "";
        }
        haengeAn(stueck);
        setStand("");
        sphaere.setZustand("sprechen");
        sphaere.impuls(Math.min(1, stueck.length / 14));
        return;
      }
      if (message.type === "kuro.werkzeug" && typeof data.name === "string") {
        if (!antwortText.textContent) setStand(WERKZEUG_STAND[data.name] ?? "Arbeitet …");
        return;
      }
      if (message.type === "haus.arbeitet" && typeof data.wer === "string") {
        if (!antwortText.textContent) setStand(`${data.wer} arbeitet …`);
        arbeitende.add(data.wer);
        arbeit.set(data.wer, { seit: Date.now(), stand: "übernimmt" });
        zeichneArbeit();
        sphaere.setArbeitende([...arbeitende]);
        zustandNeu();
        return;
      }
      if (message.type === "haus.fortschritt" && typeof data.wer === "string") {
        const vorher = arbeit.get(data.wer);
        const text = typeof data.text === "string" ? data.text : "";
        const wobei = typeof data.wobei === "string" ? data.wobei : "";
        arbeit.set(data.wer, {
          seit: vorher?.seit ?? Date.now(),
          stand: wobei ? `${wobei} — ${text}` : text,
        });
        zeichneArbeit();
        if (!antwortText.textContent) setStand(`${data.wer}: ${text}`);
        return;
      }
      if (message.type === "haus.fertig" && typeof data.wer === "string") {
        arbeitende.delete(data.wer);
        arbeit.delete(data.wer);
        zeichneArbeit();
        sphaere.setArbeitende([...arbeitende]);
        zustandNeu();
        return;
      }
      if (message.type === "ui.zeige") {
        const karte = typeof data.tafel === "string" ? TAFEL_ZU_KARTE[data.tafel] : undefined;
        if (karte) hebeHervor(karte);
        return;
      }
      if (message.type === "ui.verberge") {
        alleZurueck();
        return;
      }
      if (inFlight) return;
      const signal = signalFor(message);
      if (signal === "processing") sphaere.setZustand("denken");
      else if (signal === "speaking") sphaere.setZustand("sprechen");
      else if (signal === "complete") sphaere.fertig();
      else if (signal === "idle") zustandNeu();
    });

    // Beim Öffnen liegen im Postfach des Web-Kanals oft Reste aus früheren Sitzungen. Die
    // werden einmal abgeholt und **verworfen** — sonst stünde beim ersten Blick eine fremde,
    // alte Antwort im Panel. Erst was danach eintrifft, ist ein Nachtrag für diese Sitzung.
    void ctx.api.get<OutboxResponse>("/channels/web/outbox").catch(() => undefined);
    const outboxTimer = globalThis.setInterval(async () => {
      if (inFlight) return;
      try {
        const o = await ctx.api.get<OutboxResponse>("/channels/web/outbox");
        const letzte = o.deliveries?.filter((d) => d.message.kind === "reply").pop();
        if (letzte?.message.text) {
          zeigeAntwort(letzte.message.text, { frage: "" });
          sphaere.fertig();
        }
      } catch {
        // kein Gateway — nichts zu sagen
      }
    }, 4000);

    q<HTMLButtonElement>("fokus")?.addEventListener("click", () => ctx.toggleFocus());

    zustandNeu();

    // Ein Fenster, das mitten in einem Auftrag aufgeht, soll ihn sehen. Die Ereignisse davor
    // hat es verpasst — der Gateway weiß trotzdem, wer gerade arbeitet.
    void ctx.api
      .get<{ laufende: Array<{ wer: string; stand: string; begonnen: number }> }>(
        "/integrations/haus",
      )
      .then(({ laufende }) => {
        if (entladen) return;
        for (const l of laufende) {
          arbeit.set(l.wer, { seit: l.begonnen, stand: l.stand });
          arbeitende.add(l.wer);
        }
        if (laufende.length > 0) {
          zeichneArbeit();
          sphaere.setArbeitende([...arbeitende]);
          zustandNeu();
        }
      })
      .catch(() => {
        // Kein Grund, die Präsenz daran scheitern zu lassen.
      });

    return () => {
      entladen = true;
      globalThis.clearInterval(uhrTimer);
      globalThis.clearInterval(kartenTimer);
      globalThis.clearInterval(outboxTimer);
      globalThis.clearInterval(arbeitUhr);
      alleZurueck();
      micAbo();
      busAbo();
      sphaere.destroy();
    };
  },
};
