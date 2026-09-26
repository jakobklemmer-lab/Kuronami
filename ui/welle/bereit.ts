import type { ApiClient } from "../api/client.js";

/**
 * Wann ein Bereich fertig genug ist, um sich zu zeigen.
 *
 * Jeder Bereich (Post, Märkte, System …) baut sich zuerst mit „Lädt …" und leeren Listen auf und
 * füllt sich, sobald der Gateway antwortet. Bis zum 2026-09-26 blendete die Welle ihn sofort ein —
 * man sah die Platzhalter hereinkommen und dann Karten, Tabellen und Diagramme nacheinander auf
 * ihre echte Größe springen, mitten in der Blende. Jakob: „die einzige Seite, die sauber und
 * angenehm reinlädt, ist die Startseite, alles andere fühlt sich katastrophal an." Die Startseite
 * hat ein festes Gerüst; die Bereiche nicht.
 *
 * Deshalb zählt dieser Wächter die Anfragen, die ein Bereich beim Aufbau stellt, und meldet
 * „bereit", wenn keine mehr läuft und eine kurze Ruhe lang keine neue kam (manche Bereiche holen
 * nach der ersten Antwort gleich die nächste — die Märkte erst die Kurse, dann die Kerzen). Wird
 * es zu lang, zeigt sich der Bereich trotzdem: lieber ein Platzhalter als eine leere Fläche.
 */

export interface Verfolgt {
  /** Der Client, den der Bereich bekommt — derselbe, nur mitgezählt. */
  api: ApiClient;
  /**
   * Löst auf, wenn `ruheMs` lang keine Anfrage mehr lief, spätestens nach `hoechstensMs`.
   * Die Ruhe beginnt frühestens nach einem Durchlauf der Ereignisschleife — so hat eine Antwort,
   * die gerade ankam, Zeit, in die Seite geschrieben zu werden.
   */
  bereit(opt?: { ruheMs?: number; hoechstensMs?: number }): Promise<void>;
}

export function verfolge(api: ApiClient): Verfolgt {
  let offen = 0;
  let wecke: (() => void) | null = null;

  const zaehle = <T>(anfrage: Promise<T>): Promise<T> => {
    offen += 1;
    // Eine neue Anfrage unterbricht eine laufende Ruhe — sonst zeigte sich der Bereich, während
    // die zweite noch unterwegs ist.
    wecke?.();
    const fertig = (): void => {
      offen -= 1;
      wecke?.();
    };
    anfrage.then(fertig, fertig);
    return anfrage;
  };

  return {
    api: {
      get: (pfad) => zaehle(api.get(pfad)),
      post: (pfad, koerper) => zaehle(api.post(pfad, koerper)),
      patch: (pfad, koerper) => zaehle(api.patch(pfad, koerper)),
      delete: (pfad) => zaehle(api.delete(pfad)),
    },
    bereit({ ruheMs = 60, hoechstensMs = 700 } = {}) {
      return new Promise<void>((los) => {
        let erledigt = false;
        let ruhe: ReturnType<typeof setTimeout> | null = null;
        const ende = (): void => {
          if (erledigt) return;
          erledigt = true;
          wecke = null;
          if (ruhe !== null) clearTimeout(ruhe);
          clearTimeout(grenze);
          los();
        };
        const grenze = setTimeout(ende, hoechstensMs);
        // Bei jeder Änderung neu prüfen: läuft nichts mehr, beginnt die Ruhe von vorn.
        const pruefe = (): void => {
          if (ruhe !== null) clearTimeout(ruhe);
          ruhe = offen === 0 ? setTimeout(ende, ruheMs) : null;
        };
        wecke = pruefe;
        setTimeout(pruefe, 0);
      });
    },
  };
}
