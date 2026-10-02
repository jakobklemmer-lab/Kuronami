/**
 * „Im Haus" — wer gerade woran arbeitet, als reine Ableitung aus den Ereignissen des Gesprächs
 * (`bediensteter` beginnt/stand/fertig, `gespraech.arbeit` beim Öffnen). Ohne DOM.
 * Nichts wird erfunden: kein Fortschritt in Prozent, nur Zeit und die echten Stände.
 */

export interface Lauf {
  wer: string;
  name: string;
  farbe: string;
  auftrag: string | null;
  seit: number;
  /** Die letzten Stände, neuester zuletzt. */
  staende: string[];
  fertigUm: number | null;
}

export interface ImHaus {
  laeufe: Lauf[];
  zuletzt: Lauf[];
}

export const STAENDE = 3;
export const ZULETZT = 5;
/** So lange bleibt ein fertiger Auftrag oben stehen, bevor er nach „Zuletzt" wandert. */
export const FERTIG_STEHT_MS = 20_000;

export function leer(): ImHaus {
  return { laeufe: [], zuletzt: [] };
}

export function beginnt(
  h: ImHaus,
  a: { wer: string; name: string; farbe: string; auftrag: string | null; jetzt: number },
): ImHaus {
  const ohne = h.laeufe.filter((l) => l.wer !== a.wer);
  return {
    ...h,
    laeufe: [
      ...ohne,
      {
        wer: a.wer,
        name: a.name,
        farbe: a.farbe,
        auftrag: a.auftrag,
        seit: a.jetzt,
        staende: [],
        fertigUm: null,
      },
    ],
  };
}

export function stand(h: ImHaus, wer: string, text: string): ImHaus {
  const sauber = text.trim();
  if (!sauber) return h;
  return {
    ...h,
    laeufe: h.laeufe.map((l) =>
      l.wer !== wer || l.staende.at(-1) === sauber
        ? l
        : { ...l, staende: [...l.staende, sauber].slice(-STAENDE) },
    ),
  };
}

export function fertig(h: ImHaus, wer: string, jetzt: number): ImHaus {
  return {
    ...h,
    laeufe: h.laeufe.map((l) =>
      l.wer === wer && l.fertigUm === null ? { ...l, fertigUm: jetzt } : l,
    ),
  };
}

/** Fertige Aufträge nach `FERTIG_STEHT_MS` aus der Liste nach „Zuletzt", höchstens fünf. */
export function raeumeAuf(h: ImHaus, jetzt: number): ImHaus {
  const alt = h.laeufe.filter((l) => l.fertigUm !== null && jetzt - l.fertigUm >= FERTIG_STEHT_MS);
  if (alt.length === 0) return h;
  return {
    laeufe: h.laeufe.filter((l) => !alt.includes(l)),
    zuletzt: [...alt.reverse(), ...h.zuletzt].slice(0, ZULETZT),
  };
}

/** Beim Öffnen: was laut Gespräch schon läuft, aber hier noch fehlt. */
export function abgleichen(
  h: ImHaus,
  arbeit: ReadonlyMap<string, { seit: number; stand: string; auftrag: string | null }>,
  benenne: (wer: string) => { name: string; farbe: string },
): ImHaus {
  let neu = h;
  for (const [wer, a] of arbeit) {
    if (neu.laeufe.some((l) => l.wer === wer)) continue;
    neu = beginnt(neu, { wer, ...benenne(wer), auftrag: a.auftrag, jetzt: a.seit });
    neu = stand(neu, wer, a.stand);
  }
  return neu;
}

/** Laufzeit wie auf einer Uhr: „0:07", „4:12", „1:02:03". */
export function dauer(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}
