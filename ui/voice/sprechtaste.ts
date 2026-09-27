/**
 * Sprechen mit der Leertaste (2026-09-27).
 *
 * Jakob: „Space als Hotkey … dann soll er mir nur zuhören, wenn ich Space drücke, das macht es
 * einfacher, wenn ich nebenbei Videos laufen habe." Die Sprachschicht hörte bis dahin alles, was
 * das Mikrofon aufnahm; ein Video im Hintergrund war für das VAD ein Sprecher, und Kuro antwortete
 * ihm — oder unterbrach sich selbst.
 *
 * Solange die Taste nicht gedrückt ist, gehen **Nullen statt Ton** hinaus, nicht nichts: der Strom
 * zu Deepgram bleibt so offen (ohne Ton schlösse er nach Sekunden), und nach dem Loslassen hört das
 * VAD Stille und schließt den Satz wie sonst nach einer Sprechpause.
 *
 * Die Leertaste gehört dem Sprechen nur, wenn kein Textfeld den Fokus hat — sonst könnte man in
 * der Befehlsleiste keine Leerzeichen mehr tippen. Und `keyup` wird ebenfalls abgefangen: auf einem
 * fokussierten Knopf löst die Leertaste beim Loslassen einen Klick aus, und der Knopf mit Fokus ist
 * oft gerade der Mikrofonknopf — das Loslassen hätte die Sprachschicht beendet.
 */

export interface Sprechtaste {
  /** Darf der Ton gerade hinaus? */
  readonly offen: boolean;
  /** Ersetzt den Block durch Stille, wenn die Taste nicht gedrückt ist. */
  filtere(pcm: ArrayBuffer): ArrayBuffer;
  beende(): void;
}

export interface SprechtastenOptionen {
  /** Gilt die Sprechtaste gerade (Einstellung + Tastatur)? Bei jedem Block neu gefragt. */
  aktiv: () => boolean;
  /** Taste gedrückt / losgelassen — für die Anzeige. */
  onWechsel?: (offen: boolean) => void;
  ziel?: Pick<Window, "addEventListener" | "removeEventListener">;
}

/** Ist gerade ein Feld fokussiert, in das man schreibt? Dann gehört die Leertaste dem Text. */
export function schreibtGerade(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const typ = (el as HTMLInputElement).type;
    return !["checkbox", "radio", "button", "submit", "range", "color", "file"].includes(typ);
  }
  return (el as HTMLElement).isContentEditable === true;
}

/** Hat das Gerät eine Tastatur mit feinem Zeiger? Auf dem Telefon gibt es keine Leertaste. */
export function hatTastatur(): boolean {
  return globalThis.matchMedia?.("(pointer: fine)").matches ?? true;
}

export function createSprechtaste(o: SprechtastenOptionen): Sprechtaste {
  const ziel = o.ziel ?? globalThis.window;
  let gedrueckt = false;
  const setze = (an: boolean) => {
    if (an === gedrueckt) return;
    gedrueckt = an;
    o.onWechsel?.(an);
  };
  const runter = (e: KeyboardEvent) => {
    if (e.code !== "Space" || !o.aktiv() || schreibtGerade(document.activeElement)) return;
    e.preventDefault();
    if (!e.repeat) setze(true);
  };
  const hoch = (e: KeyboardEvent) => {
    if (e.code !== "Space" || !gedrueckt) return;
    e.preventDefault();
    setze(false);
  };
  // Fenster verlassen, während die Taste unten ist: kein `keyup` kommt je an.
  const weg = () => setze(false);
  ziel.addEventListener("keydown", runter as EventListener, true);
  ziel.addEventListener("keyup", hoch as EventListener, true);
  ziel.addEventListener("blur", weg);

  return {
    get offen() {
      return !o.aktiv() || gedrueckt;
    },
    filtere(pcm) {
      return !o.aktiv() || gedrueckt ? pcm : new ArrayBuffer(pcm.byteLength);
    },
    beende() {
      ziel.removeEventListener("keydown", runter as EventListener, true);
      ziel.removeEventListener("keyup", hoch as EventListener, true);
      ziel.removeEventListener("blur", weg);
      setze(false);
    },
  };
}
