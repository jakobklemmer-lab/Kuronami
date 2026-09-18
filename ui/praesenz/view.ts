import { emblemMarkup } from "../emblem.js";
import { signalFor } from "../events/bus.js";
import { escapeHtml } from "../views/html.js";
import type { View, ViewContext } from "../views/types.js";
import { TAFEL_TITEL, type TafelName, renderTafel } from "./tafeln.js";
import { type Welle, type WellenZustand, mountWelle } from "./welle.js";

/**
 * Die Präsenz — Kuronami als Gegenüber, nicht als Dashboard.
 *
 * Drei Dinge sind immer da: das Wasser in der Mitte, die Uhr, die Bubble unten. Alles andere
 * — Kuros Worte, die Tafeln, die Marke, die zwei Knöpfe — ist entweder Antwort auf etwas oder
 * verschwindet im Fokus ganz. Die Oberfläche soll sich anfühlen, als stünde jemand vor einem:
 * er hört zu, während man spricht, denkt sichtbar, antwortet, und legt etwas auf den Tisch,
 * wenn es dazugehört.
 *
 * Alles reagiert **sofort und lokal**: das Feld bekommt Fokus → das Wasser hört zu. Senden →
 * es denkt. Das erste Textstück kommt an → es spricht, und jedes weitere Stück ist ein Ring.
 * Ein Bediensteter fängt an → eine Quelle am Ufer. Nichts davon wartet auf eine Antwort vom
 * Server; die Antwort bestätigt nur, was das Wasser schon zeigt.
 */

interface MessageResponse {
  status: string;
  delivered?: Array<{ kind: string; text?: string; question?: string }>;
}
interface PendingResponse {
  pending?: Array<{ askId: string; question: string }>;
}
interface OutboxResponse {
  deliveries?: Array<{ message: { kind: string; text?: string; question?: string } }>;
}

const MIC_SVG = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>`;
const RASTER_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></svg>`;
const FOKUS_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="12" cy="12" r="7"/></svg>`;

/** Wie lange eine Tafel steht, wenn niemand sie anfasst. */
const TAFEL_STEHT_MS = 45_000;

export const praesenzView: View = {
  mount(container, ctx: ViewContext) {
    container.innerHTML = `
      <div class="praesenz" data-role="praesenz">
        <header class="praesenz__kopf">
          <a class="praesenz__marke" href="#/home" title="Zum Dashboard">${emblemMarkup("praesenz__emblem")}</a>
          <time class="praesenz__uhr" data-role="uhr" aria-live="off"></time>
        </header>

        <div class="praesenz__mitte">
          <aside class="praesenz__tafeln" data-role="tafeln" aria-live="polite"></aside>

          <div class="praesenz__wesen">
            <button type="button" class="praesenz__welle-knopf" data-role="welle-knopf"
                    aria-label="Kuro zuhören lassen">
              <canvas class="praesenz__welle" data-role="welle" role="img" aria-label="Kuronami"></canvas>
            </button>
            <div class="praesenz__worte" data-role="worte">
              <p class="praesenz__frage" data-role="frage"></p>
              <p class="praesenz__antwort" data-role="antwort"></p>
            </div>
          </div>
        </div>

        <footer class="praesenz__fuss">
          <form class="praesenz__bubble" data-role="bubble">
            <textarea class="praesenz__eingabe" data-role="eingabe" rows="1"
                      placeholder="Kuro …" aria-label="An Kuro" autocomplete="off"></textarea>
            <button type="button" class="praesenz__mic" data-role="mic" aria-label="Zuhören">${MIC_SVG}</button>
          </form>
          <div class="praesenz__leiste">
            <button type="button" class="praesenz__leise-knopf" data-role="dashboard" title="Dashboard">${RASTER_SVG}</button>
            <button type="button" class="praesenz__leise-knopf" data-role="fokus" title="Fokus (Esc beendet)">${FOKUS_SVG}</button>
          </div>
        </footer>
      </div>
    `;

    const q = <T extends Element>(role: string): T | null =>
      container.querySelector<T>(`[data-role="${role}"]`);
    const canvas = q<HTMLCanvasElement>("welle");
    const uhrEl = q<HTMLElement>("uhr");
    const frageEl = q<HTMLElement>("frage");
    const antwortEl = q<HTMLElement>("antwort");
    const tafelnEl = q<HTMLElement>("tafeln");
    const eingabe = q<HTMLTextAreaElement>("eingabe");
    const bubble = q<HTMLFormElement>("bubble");
    const micKnopf = q<HTMLButtonElement>("mic");
    const welleKnopf = q<HTMLButtonElement>("welle-knopf");
    if (!canvas || !eingabe || !bubble) return () => {};

    const ruhigerModus = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const welle: Welle = mountWelle(canvas, { reducedMotion: ruhigerModus });

    // ------------------------------------------------------------------ Uhr
    const zeigeUhr = (): void => {
      if (uhrEl) {
        uhrEl.textContent = new Date().toLocaleTimeString("de-AT", { hour: "2-digit", minute: "2-digit" });
      }
    };
    zeigeUhr();
    const uhrTimer = globalThis.setInterval(zeigeUhr, 1000);

    // ------------------------------------------------------------ Zustand
    let inFlight = false;
    const arbeitende = new Set<string>();
    let verblassTimer: ReturnType<typeof setTimeout> | null = null;

    /** Der Zustand des Wassers aus allem, was gerade gilt — eine Stelle, nicht viele Flags. */
    const zustandNeu = (hinweis?: WellenZustand): void => {
      if (hinweis) {
        welle.setZustand(hinweis);
        return;
      }
      if (arbeitende.size > 0) welle.setZustand("arbeiten");
      else if (inFlight) welle.setZustand("denken");
      else if (ctx.mic.state === "listening") welle.setZustand("zuhoeren");
      else welle.setZustand("ruhe");
    };

    const setAntwort = (text: string, frage = false): void => {
      if (!antwortEl) return;
      antwortEl.textContent = text;
      antwortEl.classList.toggle("ist-frage", frage);
      antwortEl.classList.remove("ist-verblasst");
      if (verblassTimer) globalThis.clearTimeout(verblassTimer);
      verblassTimer = globalThis.setTimeout(() => antwortEl.classList.add("ist-verblasst"), 24_000);
    };

    // ------------------------------------------------------------- Tafeln
    const offeneTafeln = new Map<TafelName, { el: HTMLElement; timer: ReturnType<typeof setTimeout> }>();

    const entferneTafel = (name: TafelName): void => {
      const t = offeneTafeln.get(name);
      if (!t) return;
      globalThis.clearTimeout(t.timer);
      t.el.classList.add("ist-weg");
      globalThis.setTimeout(() => t.el.remove(), 260);
      offeneTafeln.delete(name);
    };

    const zeigeTafel = async (name: TafelName, hinweis?: string): Promise<void> => {
      if (!tafelnEl) return;
      entferneTafel(name);
      // Höchstens zwei zugleich — die älteste geht, wenn eine dritte kommt.
      if (offeneTafeln.size >= 2) {
        const aelteste = offeneTafeln.keys().next().value;
        if (aelteste) entferneTafel(aelteste);
      }
      const el = document.createElement("section");
      el.className = "tafel";
      el.innerHTML = `
        <header class="tafel__kopf">
          <span class="tafel__titel">${escapeHtml(TAFEL_TITEL[name])}</span>
          <button type="button" class="tafel__zu" aria-label="Tafel wegnehmen">×</button>
        </header>
        ${hinweis ? `<p class="tafel__hinweis">${escapeHtml(hinweis)}</p>` : ""}
        <div class="tafel__inhalt"><div class="tafel__leise">…</div></div>`;
      tafelnEl.prepend(el);
      const timer = globalThis.setTimeout(() => entferneTafel(name), TAFEL_STEHT_MS);
      offeneTafeln.set(name, { el, timer });
      el.querySelector(".tafel__zu")?.addEventListener("click", () => entferneTafel(name));
      // Solange die Hand darauf liegt, bleibt sie.
      el.addEventListener("mouseenter", () => {
        const t = offeneTafeln.get(name);
        if (t) globalThis.clearTimeout(t.timer);
      });
      el.addEventListener("mouseleave", () => {
        const t = offeneTafeln.get(name);
        if (t) t.timer = globalThis.setTimeout(() => entferneTafel(name), TAFEL_STEHT_MS);
      });
      const inhalt = el.querySelector<HTMLElement>(".tafel__inhalt");
      if (inhalt) inhalt.innerHTML = await renderTafel(name, ctx.api);
    };

    const alleTafelnWeg = (): void => {
      for (const name of [...offeneTafeln.keys()]) entferneTafel(name);
    };

    // -------------------------------------------------------------- Senden
    const wachsen = (): void => {
      eingabe.style.height = "auto";
      eingabe.style.height = `${Math.min(eingabe.scrollHeight, 140)}px`;
      bubble.classList.toggle("ist-mehrzeilig", eingabe.scrollHeight > 44);
    };

    const sende = async (): Promise<void> => {
      const text = eingabe.value.trim();
      if (!text || inFlight) return;
      eingabe.value = "";
      wachsen();
      if (frageEl) frageEl.textContent = text;
      setAntwort("");
      inFlight = true;
      zustandNeu("denken");

      const pendingTimer = globalThis.setInterval(async () => {
        try {
          const p = await ctx.api.get<PendingResponse>("/channels/web/pending");
          const offen = p.pending?.[0];
          if (offen && antwortEl && !antwortEl.classList.contains("ist-frage")) {
            setAntwort(offen.question, true);
            zustandNeu("zuhoeren");
          }
        } catch {
          // Ein fehlgeschlagener Blick auf die offenen Fragen ist kein Grund für Aufregung.
        }
      }, 1500);

      try {
        const antwort = await ctx.api.post<MessageResponse>("/channels/web/messages", { content: text });
        const reply = antwort.delivered?.find((d) => d.kind === "reply")?.text;
        if (reply) setAntwort(reply);
      } catch (error) {
        setAntwort(error instanceof Error ? error.message : String(error));
      } finally {
        globalThis.clearInterval(pendingTimer);
        inFlight = false;
        welle.fertig();
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
    // Aufmerksamkeit: sobald man zu schreiben ansetzt, hört das Wasser zu.
    eingabe.addEventListener("focus", () => {
      if (!inFlight && arbeitende.size === 0) welle.setZustand("zuhoeren");
    });
    eingabe.addEventListener("blur", () => {
      if (!inFlight) zustandNeu();
    });

    // ------------------------------------------------------------- Stimme
    const zuhoerenUmschalten = (): void => {
      if (ctx.voice) ctx.voice.toggle();
      else ctx.mic.toggleListening();
    };
    micKnopf?.addEventListener("click", zuhoerenUmschalten);
    welleKnopf?.addEventListener("click", zuhoerenUmschalten);
    const micAbo = ctx.mic.subscribe((state) => {
      micKnopf?.classList.toggle("ist-an", state === "listening");
      welleKnopf?.setAttribute("aria-pressed", String(state === "listening"));
      canvas.setAttribute(
        "aria-label",
        state === "listening" ? "Kuronami hört zu" : inFlight ? "Kuronami arbeitet" : "Kuronami",
      );
      if (!inFlight) zustandNeu();
    });

    // ------------------------------------------------------ Ereignisstrom
    const busAbo = ctx.bus.onMessage((message) => {
      const data = (message.data ?? {}) as Record<string, unknown>;

      if (message.type === "model.delta") {
        const payload = (data.payload ?? data) as Record<string, unknown>;
        const stueck = typeof payload.text === "string" ? payload.text : "";
        if (!stueck) return;
        if (antwortEl) {
          if (antwortEl.classList.contains("ist-frage")) setAntwort("");
          antwortEl.textContent = `${antwortEl.textContent ?? ""}${stueck}`;
          antwortEl.classList.remove("ist-verblasst");
        }
        welle.setZustand("sprechen");
        welle.impuls(Math.min(1, stueck.length / 14));
        return;
      }
      if (message.type === "haus.arbeitet" && typeof data.wer === "string") {
        arbeitende.add(data.wer);
        welle.setArbeitende([...arbeitende]);
        zustandNeu();
        return;
      }
      if (message.type === "haus.fertig" && typeof data.wer === "string") {
        arbeitende.delete(data.wer);
        welle.setArbeitende([...arbeitende]);
        zustandNeu();
        return;
      }
      if (message.type === "ui.zeige") {
        const tafel = data.tafel;
        if (typeof tafel === "string" && tafel in TAFEL_TITEL) {
          void zeigeTafel(tafel as TafelName, typeof data.hinweis === "string" ? data.hinweis : undefined);
        }
        return;
      }
      if (message.type === "ui.verberge") {
        alleTafelnWeg();
        return;
      }

      // Alles Übrige nur, wenn hier gerade kein eigener Zug läuft — ein Nachtrag eines
      // Bediensteten oder ein Heartbeat soll sich im Wasser zeigen, aber nicht eine laufende
      // Antwort überschreiben.
      if (inFlight) return;
      const signal = signalFor(message);
      if (signal === "processing") welle.setZustand("denken");
      else if (signal === "speaking") welle.setZustand("sprechen");
      else if (signal === "complete") welle.fertig();
      else if (signal === "idle") zustandNeu();
    });

    // Nachträge (ein Bediensteter kam später zurück) liegen im Postfach des Web-Kanals.
    const outboxTimer = globalThis.setInterval(async () => {
      if (inFlight) return;
      try {
        const o = await ctx.api.get<OutboxResponse>("/channels/web/outbox");
        const letzte = o.deliveries?.filter((d) => d.message.kind === "reply").pop();
        if (letzte?.message.text) {
          if (frageEl) frageEl.textContent = "";
          setAntwort(letzte.message.text);
          welle.fertig();
        }
      } catch {
        // Kein Gateway erreichbar — das Wasser bleibt ruhig, mehr gibt es hier nicht zu sagen.
      }
    }, 4000);

    // ---------------------------------------------------------------- Knöpfe
    q<HTMLButtonElement>("dashboard")?.addEventListener("click", () => ctx.navigate("home"));
    q<HTMLButtonElement>("fokus")?.addEventListener("click", () => ctx.toggleFocus());
    antwortEl?.addEventListener("click", () => antwortEl.classList.toggle("ist-offen"));

    zustandNeu();
    eingabe.focus({ preventScroll: true });

    return () => {
      globalThis.clearInterval(uhrTimer);
      globalThis.clearInterval(outboxTimer);
      if (verblassTimer) globalThis.clearTimeout(verblassTimer);
      for (const t of offeneTafeln.values()) globalThis.clearTimeout(t.timer);
      micAbo();
      busAbo();
      welle.destroy();
    };
  },
};
