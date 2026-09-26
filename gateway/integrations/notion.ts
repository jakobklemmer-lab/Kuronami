/**
 * Der Zugang zu Jakobs Notion — genauer: zu seinem Trading Journal.
 *
 * **Warum ein eigener Client und kein MCP-Server von Notion.** Der Gateway soll genau drei
 * Dinge können: eine Zeile in eine Datenbank schreiben, eine Zeile ändern, und lesen, was
 * dort steht. Ein allgemeiner Notion-Server brächte dreißig Werkzeuge mit, von denen jedes in
 * jedem Modellaufruf Token kostet — und die Möglichkeit, in jeder Ecke des Arbeitsbereichs zu
 * schreiben. Hier ist der Zugriff auf das beschränkt, was das Journal braucht.
 *
 * **Der Zugang ist ein Integrationstoken** (`NOTION_TOKEN`), das Jakob einmal anlegt und mit
 * dem er die Seite „Trading Journal" teilt. Ohne Freigabe sieht die Integration nichts —
 * das ist Notions Modell und der Grund, warum ein vergessener Schritt hier als „nicht
 * verbunden" erscheint und nicht als leeres Journal.
 */

export class NotionFehler extends Error {}

export interface NotionClient {
  /** Eine neue Zeile in einer Datenbank. Gibt Kennung und URL der angelegten Seite zurück. */
  erstelle(
    datenbankId: string,
    eigenschaften: Record<string, unknown>,
  ): Promise<{ id: string; url: string }>;
  /** Eigenschaften einer bestehenden Zeile ändern. */
  aktualisiere(seitenId: string, eigenschaften: Record<string, unknown>): Promise<void>;
  /** Zeilen einer Datenbank abfragen. `filter` und `sorts` wie in der Notion-API. */
  frage(
    datenbankId: string,
    anfrage?: { filter?: unknown; sorts?: unknown; grenze?: number },
  ): Promise<NotionZeile[]>;
  /** Den Text einer Seite, Blöcke flach zusammengesetzt — für Regeln und Setups. */
  seitentext(seitenId: string): Promise<string>;
  /**
   * Die Wahlmöglichkeiten einer Auswahlspalte, wie sie in der Datenbank stehen.
   *
   * Notion legt eine **neue** Option an, wenn man in eine Auswahlspalte einen Namen schreibt,
   * den es dort nicht gibt — stillschweigend und ohne Fehler. Am 2026-09-21 entstand so aus
   * einem „Setup 1" eine zweite Option neben „Setup 1 Pullback EMA 20". Für Jakobs Journal ist
   * das kein Schönheitsfehler: seine Regel sagt „kein Trade, der nicht vollständig einem
   * meiner dokumentierten Setups entspricht", und eine Spalte, die jeden Namen annimmt, macht
   * aus dieser Regel eine Selbstauskunft. Wer schreibt, fragt vorher hier nach.
   */
  auswahlOptionen(datenbankId: string, eigenschaft: string): Promise<string[]>;
}

export interface NotionZeile {
  id: string;
  url: string;
  eigenschaften: Record<string, unknown>;
}

const BASIS = "https://api.notion.com/v1";
/** Feste Version: Notion ändert Antwortformen zwischen Versionen, und ein stiller Wechsel
 * wäre genau die Art Fehler, die man erst am falschen Journaleintrag bemerkt. */
const VERSION = "2022-06-28";

/** Wie tief `seitentext` in verschachtelte Blöcke hineinsieht, und wie viele Abrufe es dafür
 *  höchstens tut. Zwei Ebenen deckt Umschalter und Hinweise ab; alles darunter ist Gliederung,
 *  keine Regel. */
const MAX_TIEFE = 2;
const MAX_ABFRAGEN = 30;

export interface NotionOptionen {
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Notion-Kennungen sind UUIDs, mit oder ohne Bindestriche. Alles andere gerät nicht in eine URL. */
export function istNotionId(wert: string): boolean {
  return /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(wert);
}

export function createNotionClient(optionen: NotionOptionen): NotionClient {
  const fetchImpl = optionen.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = optionen.timeoutMs ?? 15_000;

  async function ruf(pfad: string, init: RequestInit = {}): Promise<unknown> {
    const controller = new AbortController();
    const uhr = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const antwort = await fetchImpl(`${BASIS}${pfad}`, {
        ...init,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${optionen.token}`,
          "notion-version": VERSION,
          "content-type": "application/json",
          ...(init.headers ?? {}),
        },
      });
      const text = await antwort.text();
      let daten: unknown = null;
      try {
        daten = text === "" ? null : JSON.parse(text);
      } catch {
        // Kein JSON — dann trägt die Statuszeile die Auskunft.
      }
      if (!antwort.ok) {
        const grund =
          daten !== null && typeof daten === "object" && "message" in daten
            ? String((daten as { message?: unknown }).message)
            : `HTTP ${antwort.status}`;
        // Die häufigste Ursache ist kein Fehler im Aufruf, sondern eine fehlende Freigabe —
        // und das steht in Notions Meldung nicht drin.
        const zusatz =
          antwort.status === 404
            ? " (Meist heißt das: die Seite ist nicht mit der Integration geteilt — in Notion über „…“ → Verbindungen.)"
            : antwort.status === 401
              ? " (Das Token stimmt nicht oder wurde zurückgezogen.)"
              : "";
        throw new NotionFehler(`Notion: ${grund}${zusatz}`);
      }
      return daten;
    } catch (fehler) {
      if (fehler instanceof NotionFehler) throw fehler;
      throw new NotionFehler(
        `Notion nicht erreichbar: ${fehler instanceof Error ? fehler.message : String(fehler)}`,
      );
    } finally {
      clearTimeout(uhr);
    }
  }

  /**
   * Die Blöcke einer Seite als Zeilen — über alle Seiten der Abfrage hinweg und in
   * verschachtelte Blöcke hinein.
   *
   * Beides ist keine Bequemlichkeit, sondern Vollständigkeit. Notion gibt höchstens hundert
   * Blöcke am Stück heraus, und was in einem Umschalter oder einem Hinweis steht, ist ein
   * eigenes Kind. Jakobs Setup-Seite hat heute knapp siebzig Blöcke, und beide Seiten wachsen
   * — er passt sie am Monatsende an. Eine Regelseite, die hinter Block hundert weitergeht,
   * käme sonst stillschweigend abgeschnitten zurück, und eine abgeschnittene Regel ist
   * schlimmer als eine fehlende: sie sieht vollständig aus.
   *
   * `budget` begrenzt die Zahl der Abrufe. Ohne diese Grenze könnte eine Seite mit vielen
   * verschachtelten Blöcken beliebig viele Anfragen auslösen, und das im laufenden Bericht.
   */
  async function blockZeilen(
    id: string,
    tiefe: number,
    budget: { rest: number },
  ): Promise<string[]> {
    const zeilen: string[] = [];
    let cursor: string | null = null;
    let nummer = 0;
    while (budget.rest > 0) {
      budget.rest -= 1;
      const antwort = (await ruf(
        `/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`,
      )) as { results?: unknown[]; has_more?: boolean; next_cursor?: string | null };
      for (const block of antwort.results ?? []) {
        // Die Aufzählung läuft, solange nichts anderes dazwischenkommt; eine Überschrift
        // beginnt eine neue — genau so, wie Notion es auf der Seite anzeigt.
        const istAufzaehlung =
          typeof block === "object" &&
          block !== null &&
          (block as { type?: unknown }).type === "numbered_list_item";
        nummer = istAufzaehlung ? nummer + 1 : 0;
        const zeile = blockText(block, nummer);
        if (zeile !== "") zeilen.push(`${"  ".repeat(tiefe)}${zeile}`);
        const knoten = block as { id?: unknown; has_children?: unknown };
        if (knoten.has_children === true && tiefe < MAX_TIEFE && typeof knoten.id === "string") {
          zeilen.push(...(await blockZeilen(knoten.id, tiefe + 1, budget)));
        }
      }
      if (antwort.has_more !== true || typeof antwort.next_cursor !== "string") break;
      cursor = antwort.next_cursor;
    }
    return zeilen;
  }

  return {
    async erstelle(datenbankId, eigenschaften) {
      if (!istNotionId(datenbankId)) {
        throw new NotionFehler(`"${datenbankId}" ist keine Notion-Kennung.`);
      }
      const antwort = (await ruf("/pages", {
        method: "POST",
        body: JSON.stringify({
          parent: { database_id: datenbankId },
          properties: eigenschaften,
        }),
      })) as { id?: string; url?: string };
      return { id: String(antwort.id ?? ""), url: String(antwort.url ?? "") };
    },

    async aktualisiere(seitenId, eigenschaften) {
      if (!istNotionId(seitenId)) throw new NotionFehler(`"${seitenId}" ist keine Notion-Kennung.`);
      await ruf(`/pages/${seitenId}`, {
        method: "PATCH",
        body: JSON.stringify({ properties: eigenschaften }),
      });
    },

    async frage(datenbankId, anfrage = {}) {
      if (!istNotionId(datenbankId)) {
        throw new NotionFehler(`"${datenbankId}" ist keine Notion-Kennung.`);
      }
      const antwort = (await ruf(`/databases/${datenbankId}/query`, {
        method: "POST",
        body: JSON.stringify({
          ...(anfrage.filter ? { filter: anfrage.filter } : {}),
          ...(anfrage.sorts ? { sorts: anfrage.sorts } : {}),
          page_size: Math.min(Math.max(anfrage.grenze ?? 25, 1), 100),
        }),
      })) as { results?: Array<{ id?: string; url?: string; properties?: unknown }> };
      return (antwort.results ?? []).map((zeile) => ({
        id: String(zeile.id ?? ""),
        url: String(zeile.url ?? ""),
        eigenschaften: (zeile.properties ?? {}) as Record<string, unknown>,
      }));
    },

    async auswahlOptionen(datenbankId, eigenschaft) {
      if (!istNotionId(datenbankId)) {
        throw new NotionFehler(`"${datenbankId}" ist keine Notion-Kennung.`);
      }
      const antwort = (await ruf(`/databases/${datenbankId}`)) as {
        properties?: Record<string, unknown>;
      };
      const spalte = antwort.properties?.[eigenschaft];
      if (typeof spalte !== "object" || spalte === null) {
        throw new NotionFehler(`Die Spalte „${eigenschaft}" gibt es in dieser Datenbank nicht.`);
      }
      const art = (spalte as { type?: unknown }).type;
      const inhalt = typeof art === "string" ? (spalte as Record<string, unknown>)[art] : null;
      const optionen =
        typeof inhalt === "object" && inhalt !== null
          ? (inhalt as { options?: unknown }).options
          : null;
      if (!Array.isArray(optionen)) return [];
      return optionen
        .map((o) =>
          typeof o === "object" && o !== null ? String((o as { name?: unknown }).name ?? "") : "",
        )
        .filter((name) => name !== "");
    },

    async seitentext(seitenId) {
      if (!istNotionId(seitenId)) throw new NotionFehler(`"${seitenId}" ist keine Notion-Kennung.`);
      const zeilen = await blockZeilen(seitenId, 0, { rest: MAX_ABFRAGEN });
      return zeilen.join("\n");
    },
  };
}

/**
 * Ein Block als Zeile Text. Unbekannte Blockarten fallen weg statt als `[object Object]` zu
 * enden.
 *
 * `nummer` ist die Stelle in einer laufenden Aufzählung. Ohne sie hieße jede Regel „1." —
 * und Jakobs Regelseite verweist auf ihre Nummern („Kapitalregel 2"), genauso wie die
 * Verstoßmeldungen des Journals. Eine Liste, in der alles die Eins ist, macht aus einem
 * Verweis ein Ratespiel.
 */
export function blockText(block: unknown, nummer = 1): string {
  if (typeof block !== "object" || block === null) return "";
  const b = block as Record<string, unknown>;
  const typ = typeof b.type === "string" ? b.type : "";
  const inhalt = b[typ];
  if (typeof inhalt !== "object" || inhalt === null) return "";
  const reich = (inhalt as { rich_text?: unknown }).rich_text;
  const text = Array.isArray(reich)
    ? reich
        .map((stueck) =>
          typeof stueck === "object" && stueck !== null
            ? String((stueck as { plain_text?: unknown }).plain_text ?? "")
            : "",
        )
        .join("")
    : "";
  if (text === "") return "";
  switch (typ) {
    case "heading_1":
      return `# ${text}`;
    case "heading_2":
      return `## ${text}`;
    case "heading_3":
      return `### ${text}`;
    case "bulleted_list_item":
      return `- ${text}`;
    case "numbered_list_item":
      return `${nummer}. ${text}`;
    case "to_do":
      return `- [ ] ${text}`;
    case "callout":
      return `! ${text}`;
    case "quote":
      return `> ${text}`;
    default:
      return text;
  }
}

// ---------------------------------------------------------------- Eigenschaften lesen/schreiben

export function titel(wert: string): Record<string, unknown> {
  return { title: [{ text: { content: wert.slice(0, 2000) } }] };
}

export function text(wert: string): Record<string, unknown> {
  return { rich_text: [{ text: { content: wert.slice(0, 2000) } }] };
}

export function zahl(wert: number): Record<string, unknown> {
  return { number: wert };
}

export function auswahl(wert: string): Record<string, unknown> {
  return { select: { name: wert } };
}

export function mehrfach(werte: readonly string[]): Record<string, unknown> {
  return { multi_select: werte.map((name) => ({ name })) };
}

export function datum(iso: string): Record<string, unknown> {
  return { date: { start: iso } };
}

export function status(wert: string): Record<string, unknown> {
  return { status: { name: wert } };
}

/** Den lesbaren Wert einer Eigenschaft — für Listen und Prüfungen, nicht für die Anzeige. */
export function lies(eigenschaft: unknown): string | number | null {
  if (typeof eigenschaft !== "object" || eigenschaft === null) return null;
  const e = eigenschaft as Record<string, unknown>;
  switch (e.type) {
    case "title":
    case "rich_text": {
      const stuecke = e[e.type as string];
      return Array.isArray(stuecke)
        ? stuecke
            .map((s) =>
              typeof s === "object" && s !== null
                ? String((s as { plain_text?: unknown }).plain_text ?? "")
                : "",
            )
            .join("")
        : "";
    }
    case "number":
      return typeof e.number === "number" ? e.number : null;
    case "select": {
      const auswahlWert = e.select;
      return typeof auswahlWert === "object" && auswahlWert !== null
        ? String((auswahlWert as { name?: unknown }).name ?? "")
        : null;
    }
    case "status": {
      const statusWert = e.status;
      return typeof statusWert === "object" && statusWert !== null
        ? String((statusWert as { name?: unknown }).name ?? "")
        : null;
    }
    case "multi_select":
      return Array.isArray(e.multi_select)
        ? e.multi_select
            .map((s) =>
              typeof s === "object" && s !== null
                ? String((s as { name?: unknown }).name ?? "")
                : "",
            )
            .join(", ")
        : "";
    case "date": {
      const datumWert = e.date;
      return typeof datumWert === "object" && datumWert !== null
        ? String((datumWert as { start?: unknown }).start ?? "")
        : null;
    }
    case "formula": {
      const formel = e.formula as Record<string, unknown> | undefined;
      if (!formel) return null;
      if (typeof formel.number === "number") return formel.number;
      if (typeof formel.string === "string") return formel.string;
      return null;
    }
    default:
      return null;
  }
}
