import { KuronamiOrb, type OrbState } from "../vendor/kuronami-orb.mjs";

/**
 * Der Orb — Kuronami als Wesen aus Licht, nach Jakobs Entwurf (S47, 2026-09-26).
 *
 * Gerendert wird er von `ui/vendor/kuronami-orb.mjs`: eine dunkle Glaskugel voller Partikel,
 * in WebGL, transparent über dem Raum. Diese Datei ist nur die Übersetzung von Kuros Welt in
 * seine: welcher Zustand welcher ist, und wie aus einem Bediensteten ein Satellit wird.
 *
 *   * **Ruhe**      — atmet langsam, in der Statuszeile steht das Motto.
 *   * **Zuhören**   — das Mikrofon ist offen. Tippen zeigt der Orb selbst (`bindeEingabe`).
 *   * **Denken**    — violett, Gedankenströme im Inneren.
 *   * **Sprechen**  — jedes Wortstück ist ein Impuls.
 *   * **Arbeiten**  — Kuro benutzt selbst ein Werkzeug; türkis, mit Ringen, das Werkzeug steht
 *                     in der Statuszeile.
 *   * **Rückfrage** — Kuro wartet auf eine Antwort; bernstein, er ruft mit Pulsen.
 *   * **Fehler**    — der Zug ist gescheitert; rot, für ein paar Sekunden.
 *   * **Offline**   — der Ereignisstrom zum Gateway ist weg; der Orb zieht sich zusammen.
 *
 * Ein Bediensteter, der einen Auftrag übernimmt, löst sich als Satellit aus der Kugel, trägt
 * seinen Stand am Namensschild und fließt zurück, wenn er fertig ist. Läuft er über Kuros Zug
 * hinaus, bleibt er sichtbar — der Orb selbst ruht dann, und die Statuszeile sagt, wie viele
 * im Hintergrund arbeiten.
 *
 * **Ohne WebGL2** (three r170 kennt kein WebGL1 mehr; betroffen sind etwa Rechner ohne
 * Grafikbeschleunigung oder ein WebView, der sie abschaltet) steht auf der Bühne, warum kein Orb
 * steht — mit der Meldung des Browsers. Einen zweiten, einfacheren Orb gibt es nicht mehr: der
 * Video-Loop vom 2026-09-18 liegt seit S47 im Archiv (`archiv/alte-oberflaeche`). Der Rest der
 * Präsenz arbeitet ohne Orb weiter; er ist Anzeige, kein Weg.
 */

export type Zustand =
  | "ruhe"
  | "zuhoeren"
  | "denken"
  | "sprechen"
  | "arbeiten"
  | "rueckfrage"
  | "fehler"
  | "offline";

export interface Sphaere {
  readonly zustand: Zustand;
  /** `detail` erscheint in der Statuszeile, solange Kuro arbeitet, nachfragt oder scheitert. */
  setZustand(z: Zustand, detail?: string): void;
  impuls(staerke?: number): void;
  fertig(): void;
  bediensteterBeginnt(wer: string, auftrag?: string): void;
  bediensteterStand(wer: string, text: string): void;
  bediensteterFertig(wer: string): void;
  /** Tippen im Eingabefeld: der Orb hört sichtbar zu, ohne dass sich Kuros Zustand ändert. */
  bindeEingabe(el: HTMLElement): () => void;
  beimAntippen(fn: () => void): void;
  destroy(): void;
}

export const ORB_ZUSTAND: Readonly<Record<Zustand, OrbState>> = {
  ruhe: "idle",
  zuhoeren: "listening",
  denken: "thinking",
  sprechen: "speaking",
  arbeiten: "working",
  rueckfrage: "attention",
  fehler: "error",
  offline: "offline",
};

/** Die Statuszeile ist eine Zeile. Der volle Text steht dort, wo er gelesen wird — im Panel. */
export function statuszeile(text: string | undefined, max = 80): string | undefined {
  if (text === undefined) return undefined;
  const zeile = text.split("\n").find((z) => z.trim() !== "") ?? "";
  const knapp = zeile.replace(/\s+/g, " ").trim();
  return knapp.length > max ? `${knapp.slice(0, max - 1)}…` : knapp;
}

export function mountSphaere(host: HTMLElement, motto: string): Sphaere {
  try {
    return mountOrb(host, motto);
  } catch (error) {
    // Der Orb hängt seine Wurzel an, bevor er den Kontext öffnet; die halbe Hülle muss weg.
    host.innerHTML = "";
    host.classList.add("ist-ohne-orb");
    const meldung = document.createElement("p");
    meldung.className = "p-orb-fehler";
    meldung.textContent = `Der Orb braucht WebGL2 und konnte nicht starten: ${
      error instanceof Error ? error.message : String(error)
    }`;
    host.append(meldung);
    console.error("[praesenz] Der Orb konnte nicht starten.", error);
    return ohneOrb();
  }
}

function mountOrb(host: HTMLElement, motto: string): Sphaere {
  const orb = new KuronamiOrb(host, {
    tagline: motto,
    // Die Liste der Arbeitenden steht schon in der Arbeitsleiste über der Antwort, mit
    // Laufzeit. Am Orb reichen die Satelliten und ihre Namensschilder.
    agentList: false,
    // Größer als die Vorgabe (0,34): die Bühne ist breiter als hoch, der Kern soll ungefähr so
    // groß stehen wie vorher die Glaskugel.
    size: 0.46,
  });
  let zustand: Zustand = "ruhe";
  const bedienstete = new Set<string>();
  // Die Desktop-App meldet, wenn ihr Fenster minimiert ist; dann ruht der Orb ganz.
  const beimFenster = (e: Event) => {
    if ((e as CustomEvent<{ sichtbar: boolean }>).detail?.sichtbar === false) orb.pause();
    else orb.resume();
  };
  globalThis.addEventListener("kuro:fenster", beimFenster);

  return {
    get zustand() {
      return zustand;
    },
    setZustand(z, detail) {
      zustand = z;
      orb.setState(ORB_ZUSTAND[z], { detail: statuszeile(detail) });
    },
    impuls(staerke = 0.5) {
      orb.pulse(staerke);
    },
    fertig() {
      zustand = "ruhe";
      orb.flash(null, 0.4);
      orb.pulse(0.5);
      orb.setState("idle");
    },
    bediensteterBeginnt(wer, auftrag) {
      bedienstete.add(wer);
      // `type` bestimmt die Farbe (ein fester Hash des Namens) — derselbe Bedienstete trägt
      // also bei jedem Auftrag dieselbe.
      orb.addAgent({ id: wer, type: wer, name: wer, description: auftrag ?? "" });
    },
    bediensteterStand(wer, text) {
      // Ein Stand ohne Beginn (die Ansicht ging mitten im Auftrag auf) legt keinen Satelliten
      // an: den Beginn liefert `/integrations/haus` nach, und ein Satellit, dessen Ende vor dem
      // Nachladen kam, flösse nie zurück.
      if (!bedienstete.has(wer)) return;
      orb.updateAgent(wer, { activity: text });
    },
    bediensteterFertig(wer) {
      bedienstete.delete(wer);
      orb.completeAgent(wer, { status: "done" });
    },
    bindeEingabe(el) {
      return orb.bindInput(el);
    },
    beimAntippen(fn) {
      orb.addEventListener("orbclick", fn);
    },
    destroy() {
      globalThis.removeEventListener("kuro:fenster", beimFenster);
      orb.dispose();
      // `dispose` gibt Puffer und Shader frei, nicht den Kontext. Ein Browser hält nur eine
      // Handvoll WebGL-Kontexte offen; wer oft zwischen den Ansichten wechselt, verlöre sonst
      // irgendwann den ältesten.
      orb.renderer.forceContextLoss();
    },
  };
}

/** Die Präsenz ohne Orb: jeder Aufruf bleibt gültig und bewirkt nichts Sichtbares. */
function ohneOrb(): Sphaere {
  let zustand: Zustand = "ruhe";
  return {
    get zustand() {
      return zustand;
    },
    setZustand(z) {
      zustand = z;
    },
    impuls() {},
    fertig() {
      zustand = "ruhe";
    },
    bediensteterBeginnt() {},
    bediensteterStand() {},
    bediensteterFertig() {},
    bindeEingabe() {
      return () => undefined;
    },
    beimAntippen() {},
    destroy() {},
  };
}
