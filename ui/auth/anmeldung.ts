/**
 * Die Anmeldung, Browserseite — ohne DOM, damit sie ohne Browser prüfbar ist.
 *
 * Der Gateway kennt seit 2026-09-20 einen Benutzer mit Passwort (`gateway/anmeldung.ts`). Was
 * zurückkommt, ist ein signiertes Sitzungsticket; die Oberfläche legt es an dieselbe Stelle,
 * an der bisher der Betreiber-Token lag (`kuronami.webToken`). Damit tragen alle bestehenden
 * Aufrufe — HTTP wie WebSocket — den neuen Ausweis, ohne dass eine einzige Ansicht davon weiß.
 *
 * `fetchImpl` ist austauschbar, dasselbe Muster wie in `ui/api/client.ts`.
 */

export interface AnmeldeLage {
  /** Verlangt dieser Gateway eine Anmeldung, oder bleibt es beim Token von Hand? */
  anmeldung: boolean;
  benutzer: string | null;
}

export type AnmeldeErgebnis =
  | { ok: true; token: string }
  | { ok: false; fehler: string; wartenMs?: number };

export async function holeLage(baseUrl: string, fetchImpl?: typeof fetch): Promise<AnmeldeLage> {
  const hole = fetchImpl ?? globalThis.fetch.bind(globalThis);
  try {
    const antwort = await hole(`${baseUrl}/auth/lage`);
    if (!antwort.ok) return { anmeldung: false, benutzer: null };
    const daten = (await antwort.json()) as { anmeldung?: unknown; benutzer?: unknown };
    return {
      anmeldung: daten.anmeldung === true,
      benutzer: typeof daten.benutzer === "string" ? daten.benutzer : null,
    };
  } catch {
    // Kein Gateway erreichbar: dann ist eine Anmeldemaske die falsche Auskunft — der Fehler
    // gehört an die Stelle, an der ohnehin jede Karte meldet, dass niemand antwortet.
    return { anmeldung: false, benutzer: null };
  }
}

export async function melde(
  baseUrl: string,
  benutzer: string,
  passwort: string,
  fetchImpl?: typeof fetch,
): Promise<AnmeldeErgebnis> {
  const hole = fetchImpl ?? globalThis.fetch.bind(globalThis);
  let antwort: Response;
  try {
    antwort = await hole(`${baseUrl}/auth/anmelden`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ benutzer, passwort }),
    });
  } catch {
    return { ok: false, fehler: "Der Gateway antwortet nicht." };
  }

  let daten: { token?: unknown; error?: unknown; wartenMs?: unknown } = {};
  try {
    daten = (await antwort.json()) as typeof daten;
  } catch {
    // Kein JSON — dann bleibt die Statuszeile die einzige Auskunft.
  }

  if (antwort.ok && typeof daten.token === "string" && daten.token.length > 0) {
    return { ok: true, token: daten.token };
  }
  const fehler =
    typeof daten.error === "string" && daten.error.length > 0
      ? daten.error
      : `Anmeldung fehlgeschlagen (${antwort.status}).`;
  return {
    ok: false,
    fehler,
    ...(typeof daten.wartenMs === "number" ? { wartenMs: daten.wartenMs } : {}),
  };
}
