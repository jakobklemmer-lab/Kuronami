import { describe, expect, it } from "vitest";
import {
  NotionFehler,
  auswahl,
  blockText,
  createNotionClient,
  datum,
  istNotionId,
  lies,
  mehrfach,
  status,
  text,
  titel,
  zahl,
} from "./notion.js";

/**
 * Warum es diese Tests gibt: was hier schiefgeht, fällt nicht beim Aufruf auf, sondern Wochen
 * später an einer Auswertung, die niemand mehr nachrechnet. Eine Regelseite, die still nach
 * hundert Blöcken endet, sieht vollständig aus; eine fehlende Freigabe sieht aus wie ein
 * leeres Journal. Beides wird hier festgenagelt.
 */

interface Aufruf {
  url: string;
  init: RequestInit;
}

/** Ein Fetch, der vorbereitete Antworten der Reihe nach herausgibt und die Aufrufe mitschreibt. */
function fetchMit(antworten: Array<{ daten: unknown; status?: number }>) {
  const aufrufe: Aufruf[] = [];
  const impl = (async (url: string | URL, init: RequestInit = {}) => {
    aufrufe.push({ url: String(url), init });
    const naechste = antworten.shift() ?? { daten: {}, status: 200 };
    const code = naechste.status ?? 200;
    return {
      ok: code >= 200 && code < 300,
      status: code,
      text: async () =>
        typeof naechste.daten === "string" ? naechste.daten : JSON.stringify(naechste.daten),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, aufrufe };
}

function client(antworten: Array<{ daten: unknown; status?: number }>) {
  const { impl, aufrufe } = fetchMit(antworten);
  return { notion: createNotionClient({ token: "geheim", fetchImpl: impl }), aufrufe };
}

const DB = "<notion_trades_db>";

function absatz(inhalt: string, extra: Record<string, unknown> = {}) {
  return {
    type: "paragraph",
    paragraph: { rich_text: [{ plain_text: inhalt }] },
    ...extra,
  };
}

describe("istNotionId", () => {
  it("nimmt Kennungen mit und ohne Bindestriche", () => {
    expect(istNotionId(DB)).toBe(true);
    expect(istNotionId(DB.replaceAll("-", ""))).toBe(true);
  });

  it("weist alles andere ab — auch das, was fast passt", () => {
    expect(istNotionId("Trading Journal")).toBe(false);
    expect(istNotionId("")).toBe(false);
    expect(istNotionId(`${DB}x`)).toBe(false);
  });
});

describe("blockText", () => {
  it("übersetzt die Blockarten, die auf Jakobs Regelseite vorkommen", () => {
    expect(
      blockText({ type: "heading_2", heading_2: { rich_text: [{ plain_text: "Kapital" }] } }),
    ).toBe("## Kapital");
    expect(
      blockText({
        type: "numbered_list_item",
        numbered_list_item: { rich_text: [{ plain_text: "Maximal 1 % Risiko" }] },
      }),
    ).toBe("1. Maximal 1 % Risiko");
    expect(
      blockText(
        {
          type: "numbered_list_item",
          numbered_list_item: { rich_text: [{ plain_text: "Maximal 3 offene Positionen" }] },
        },
        2,
      ),
    ).toBe("2. Maximal 3 offene Positionen");
    expect(
      blockText({ type: "to_do", to_do: { rich_text: [{ plain_text: "Kurs über EMA 50" }] } }),
    ).toBe("- [ ] Kurs über EMA 50");
    expect(
      blockText({ type: "callout", callout: { rich_text: [{ plain_text: "Gilt immer." }] } }),
    ).toBe("! Gilt immer.");
  });

  it("setzt mehrteiligen Text wieder zusammen", () => {
    expect(
      blockText({
        type: "paragraph",
        paragraph: { rich_text: [{ plain_text: "Stop " }, { plain_text: "nie gegen mich." }] },
      }),
    ).toBe("Stop nie gegen mich.");
  });

  it("lässt fallen, was keinen Text hat, statt [object Object] zu liefern", () => {
    expect(blockText({ type: "divider", divider: {} })).toBe("");
    expect(blockText({ type: "image", image: { file: { url: "…" } } })).toBe("");
    expect(blockText(null)).toBe("");
    expect(blockText("kein Block")).toBe("");
  });
});

describe("lies", () => {
  it("liest die Eigenschaftsarten der Trades-Datenbank", () => {
    expect(lies({ type: "title", title: [{ plain_text: "AAPL 2026-09-21" }] })).toBe(
      "AAPL 2026-09-21",
    );
    expect(lies({ type: "number", number: 227.48 })).toBe(227.48);
    expect(lies({ type: "select", select: { name: "Offen" } })).toBe("Offen");
    expect(lies({ type: "status", status: { name: "Nicht begonnen" } })).toBe("Nicht begonnen");
    expect(lies({ type: "date", date: { start: "2026-09-21" } })).toBe("2026-09-21");
    expect(
      lies({ type: "multi_select", multi_select: [{ name: "Pullback" }, { name: "Trend" }] }),
    ).toBe("Pullback, Trend");
    expect(lies({ type: "formula", formula: { type: "number", number: -42 } })).toBe(-42);
  });

  it("gibt null zurück, wo nichts steht — nicht 0 und nicht ''", () => {
    expect(lies({ type: "number", number: null })).toBeNull();
    expect(lies({ type: "select", select: null })).toBeNull();
    expect(lies({ type: "people", people: [] })).toBeNull();
    expect(lies(undefined)).toBeNull();
  });
});

describe("Eigenschaften schreiben", () => {
  it("baut die Formen, die die Notion-API erwartet", () => {
    expect(titel("AAPL")).toEqual({ title: [{ text: { content: "AAPL" } }] });
    expect(text("These")).toEqual({ rich_text: [{ text: { content: "These" } }] });
    expect(zahl(0.01)).toEqual({ number: 0.01 });
    expect(auswahl("Long")).toEqual({ select: { name: "Long" } });
    expect(status("Nicht begonnen")).toEqual({ status: { name: "Nicht begonnen" } });
    expect(mehrfach(["a", "b"])).toEqual({ multi_select: [{ name: "a" }, { name: "b" }] });
    expect(datum("2026-09-21")).toEqual({ date: { start: "2026-09-21" } });
  });

  it("kürzt auf Notions Grenze von 2000 Zeichen, statt am Server zu scheitern", () => {
    const lang = "x".repeat(2500);
    expect(
      (titel(lang).title as Array<{ text: { content: string } }>)[0].text.content,
    ).toHaveLength(2000);
    expect(
      (text(lang).rich_text as Array<{ text: { content: string } }>)[0].text.content,
    ).toHaveLength(2000);
  });
});

describe("erstelle", () => {
  it("schickt Datenbank und Eigenschaften und gibt Kennung und URL zurück", async () => {
    const { notion, aufrufe } = client([
      { daten: { id: "seite-1", url: "https://notion.so/seite-1" } },
    ]);

    const seite = await notion.erstelle(DB, { Instrument: text("AAPL") });

    expect(seite).toEqual({ id: "seite-1", url: "https://notion.so/seite-1" });
    expect(aufrufe[0].url).toBe("https://api.notion.com/v1/pages");
    expect(JSON.parse(String(aufrufe[0].init.body))).toEqual({
      parent: { database_id: DB },
      properties: { Instrument: text("AAPL") },
    });
    const kopf = aufrufe[0].init.headers as Record<string, string>;
    expect(kopf.authorization).toBe("Bearer geheim");
    expect(kopf["notion-version"]).toBe("2022-06-28");
  });

  it("fragt gar nicht erst nach, wenn die Kennung keine ist", async () => {
    const { notion, aufrufe } = client([]);
    await expect(notion.erstelle("Trading Journal", {})).rejects.toBeInstanceOf(NotionFehler);
    expect(aufrufe).toHaveLength(0);
  });
});

describe("Fehler", () => {
  it("nennt bei 404 die fehlende Freigabe — die häufigste Ursache steht nicht in Notions Meldung", async () => {
    const { notion } = client([{ daten: { message: "Could not find database" }, status: 404 }]);
    await expect(notion.frage(DB)).rejects.toThrow(/nicht mit der Integration geteilt/);
  });

  it("nennt bei 401 das Token", async () => {
    const { notion } = client([{ daten: { message: "API token is invalid" }, status: 401 }]);
    await expect(notion.frage(DB)).rejects.toThrow(/Token stimmt nicht/);
  });

  it("macht aus einem Netzfehler eine NotionFehler-Meldung, keine rohe Ausnahme", async () => {
    const impl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const notion = createNotionClient({ token: "geheim", fetchImpl: impl });
    await expect(notion.frage(DB)).rejects.toThrow(/Notion nicht erreichbar: ECONNREFUSED/);
  });

  it("überlebt eine Antwort, die kein JSON ist", async () => {
    const { notion } = client([{ daten: "<html>502</html>", status: 502 }]);
    await expect(notion.frage(DB)).rejects.toThrow(/HTTP 502/);
  });
});

describe("frage", () => {
  it("hält die Seitengröße in Notions Grenzen", async () => {
    const { notion, aufrufe } = client([{ daten: { results: [] } }, { daten: { results: [] } }]);
    await notion.frage(DB, { grenze: 500 });
    await notion.frage(DB, { grenze: 0 });
    expect(JSON.parse(String(aufrufe[0].init.body)).page_size).toBe(100);
    expect(JSON.parse(String(aufrufe[1].init.body)).page_size).toBe(1);
  });

  it("gibt Zeilen mit Kennung, URL und Eigenschaften zurück", async () => {
    const { notion } = client([
      {
        daten: {
          results: [{ id: "z1", url: "https://notion.so/z1", properties: { Status: {} } }],
        },
      },
    ]);
    const zeilen = await notion.frage(DB);
    expect(zeilen).toEqual([
      { id: "z1", url: "https://notion.so/z1", eigenschaften: { Status: {} } },
    ]);
  });
});

describe("auswahlOptionen", () => {
  it("liest die Namen einer Auswahlspalte", async () => {
    const { notion, aufrufe } = client([
      {
        daten: {
          properties: {
            Setup: {
              type: "select",
              select: { options: [{ name: "Setup 1 Pullback EMA 20" }, { name: "Setup 2" }] },
            },
          },
        },
      },
    ]);

    expect(await notion.auswahlOptionen(DB, "Setup")).toEqual([
      "Setup 1 Pullback EMA 20",
      "Setup 2",
    ]);
    expect(aufrufe[0].url).toBe(`https://api.notion.com/v1/databases/${DB}`);
  });

  it("kommt auch mit Status- und Mehrfachauswahl zurecht", async () => {
    const { notion } = client([
      {
        daten: { properties: { S: { type: "status", status: { options: [{ name: "Offen" }] } } } },
      },
      {
        daten: {
          properties: { T: { type: "multi_select", multi_select: { options: [{ name: "a" }] } } },
        },
      },
    ]);
    expect(await notion.auswahlOptionen(DB, "S")).toEqual(["Offen"]);
    expect(await notion.auswahlOptionen(DB, "T")).toEqual(["a"]);
  });

  it("sagt es, wenn die Spalte nicht existiert — statt eine leere Liste zu liefern", async () => {
    const { notion } = client([{ daten: { properties: { Setup: { type: "select" } } } }]);
    await expect(notion.auswahlOptionen(DB, "Setups")).rejects.toThrow(/gibt es in dieser/);
  });

  it("gibt eine leere Liste für eine Spalte ohne Optionen", async () => {
    const { notion } = client([
      { daten: { properties: { Notizen: { type: "rich_text", rich_text: {} } } } },
    ]);
    expect(await notion.auswahlOptionen(DB, "Notizen")).toEqual([]);
  });
});

describe("seitentext", () => {
  it("holt alle Seiten, nicht nur die ersten hundert Blöcke", async () => {
    const { notion, aufrufe } = client([
      {
        daten: {
          results: [absatz("Kapital und Risiko")],
          has_more: true,
          next_cursor: "cursor-2",
        },
      },
      { daten: { results: [absatz("Psychologie")], has_more: false, next_cursor: null } },
    ]);

    const text = await notion.seitentext(DB);

    expect(text).toBe("Kapital und Risiko\nPsychologie");
    expect(aufrufe).toHaveLength(2);
    expect(aufrufe[1].url).toContain("start_cursor=cursor-2");
  });

  it("sieht in verschachtelte Blöcke hinein und rückt sie ein", async () => {
    const { notion } = client([
      { daten: { results: [absatz("Unterschrift", { id: "block-1", has_children: true })] } },
      { daten: { results: [absatz("Startkapital: 10.000 €")] } },
    ]);

    expect(await notion.seitentext(DB)).toBe("Unterschrift\n  Startkapital: 10.000 €");
  });

  it("nummeriert die Aufzählung durch und beginnt bei jeder Überschrift neu", async () => {
    const regel = (inhalt: string) => ({
      type: "numbered_list_item",
      numbered_list_item: { rich_text: [{ plain_text: inhalt }] },
    });
    const ueberschrift = (inhalt: string) => ({
      type: "heading_2",
      heading_2: { rich_text: [{ plain_text: inhalt }] },
    });
    const { notion } = client([
      {
        daten: {
          results: [
            ueberschrift("Kapital und Risiko"),
            regel("Maximal 1 % Risiko pro Trade"),
            regel("Maximal 3 offene Positionen"),
            regel("Maximal 3 % kumuliertes Risiko"),
            ueberschrift("Ausführung"),
            regel("Kein Trade ohne Stop-Loss"),
          ],
        },
      },
    ]);

    // Jakobs Regeln werden über ihre Nummer angesprochen — „Kapitalregel 2" muss die zweite
    // sein und nicht die dritte Eins in einer Liste aus Einsen.
    expect(await notion.seitentext(DB)).toBe(
      [
        "## Kapital und Risiko",
        "1. Maximal 1 % Risiko pro Trade",
        "2. Maximal 3 offene Positionen",
        "3. Maximal 3 % kumuliertes Risiko",
        "## Ausführung",
        "1. Kein Trade ohne Stop-Loss",
      ].join("\n"),
    );
  });

  it("hört nach zwei Ebenen auf — tiefer ist Gliederung, keine Regel", async () => {
    const tief = (inhalt: string, id: string) => absatz(inhalt, { id, has_children: true });
    const { notion, aufrufe } = client([
      { daten: { results: [tief("eins", "b1")] } },
      { daten: { results: [tief("zwei", "b2")] } },
      { daten: { results: [tief("drei", "b3")] } },
      { daten: { results: [absatz("vier")] } },
    ]);

    const text = await notion.seitentext(DB);

    expect(text).toBe("eins\n  zwei\n    drei");
    expect(aufrufe).toHaveLength(3);
  });
});
