import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  KONTEXT_GRENZE,
  RUHE_MS,
  createGespraechsarchiv,
  darfJetztArchivieren,
  istArchivZeit,
  istKontextVoll,
  leseUebergabe,
  leseVerlauf,
  nachTagen,
  sucheImArchiv,
  tagesMarkdown,
  werkzeugZeile,
} from "./gespraeche.js";

const z = (o: Record<string, unknown>) => JSON.stringify(o);
const jakob = (zeit: string, text: string, kanal = "voice") =>
  z({
    type: "user",
    timestamp: zeit,
    message: {
      role: "user",
      content: [{ type: "text", text: `[${kanal}, 22.9.2026, 15:36:35]\n${text}` }],
    },
  });
const kuro = (zeit: string, bloecke: unknown[]) =>
  z({ type: "assistant", timestamp: zeit, message: { role: "assistant", content: bloecke } });
const ergebnis = (zeit: string, id: string, text: string) =>
  z({
    type: "user",
    timestamp: zeit,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }],
    },
  });

// Nachgebildet aus der echten Sitzung vom 22.09. (Uhrzeiten UTC; Wien ist zwei Stunden weiter).
const VERLAUF = [
  jakob("2026-09-22T15:36:36Z", "Setz Deep Drive auf die Watchlist, die arbeiten mit BMW."),
  kuro("2026-09-22T15:36:40Z", [{ type: "thinking", thinking: "…" }]),
  kuro("2026-09-22T15:36:41Z", [
    { type: "tool_use", id: "t0", name: "ToolSearch", input: { query: "select:x" } },
  ]),
  kuro("2026-09-22T15:36:42Z", [
    {
      type: "tool_use",
      id: "t1",
      name: "mcp__haus__beauftrage",
      input: { wer: "journal", auftrag: "Deep Drive auf die Watchlist, Notiz BMW." },
    },
  ]),
  ergebnis(
    "2026-09-22T15:37:05Z",
    "t1",
    "journal arbeitet noch daran. Das dauert länger als ein Atemzug.",
  ),
  kuro("2026-09-22T15:37:06Z", [{ type: "text", text: "Sehr wohl, ich lasse es eintragen." }]),
  jakob(
    "2026-09-22T15:38:07Z",
    "[Der Bericht von journal ist eingetroffen. Trage ihn Jakob jetzt von dir aus vor — er hat zwischenzeitlich etwas anderes getan, also knüpfe kurz an den Auftrag an.]\n\nDeep Drive steht auf der Watchlist.",
  ),
  kuro("2026-09-22T15:38:09Z", [
    { type: "text", text: "Deep Drive steht jetzt auf der Watchlist." },
  ]),
  kuro("2026-09-22T15:38:10Z", [{ type: "text", text: "Den Ticker prüfe ich noch." }]),
  z({
    type: "user",
    isMeta: true,
    timestamp: "2026-09-26T17:27:09Z",
    message: { content: [{ type: "text", text: "Continue from where you left off." }] },
  }),
  kuro("2026-09-26T17:27:09Z", [{ type: "text", text: "No response requested." }]),
  kuro("2026-09-26T17:27:10Z", [
    { type: "text", text: "You've hit your session limit · resets 8:20pm (UTC)" },
  ]),
  z({
    type: "assistant",
    isSidechain: true,
    timestamp: "2026-09-26T17:28:00Z",
    message: { content: [{ type: "text", text: "Nebenlauf" }] },
  }),
  // 22:30 UTC ist in Wien schon der nächste Tag.
  jakob("2026-09-26T22:30:00Z", "Gute Nacht, Kuro.", "web"),
  kuro("2026-09-26T22:30:04Z", [{ type: "text", text: "Gute Nacht, Jakob." }]),
  "kaputte Zeile",
].join("\n");

describe("leseVerlauf", () => {
  const e = leseVerlauf(VERLAUF);

  it("macht aus der Rohdatei lesbare Wortmeldungen", () => {
    expect(e.map((x) => x.wer)).toEqual([
      "jakob",
      "kuro",
      "bericht",
      "kuro",
      "hinweis",
      "jakob",
      "kuro",
    ]);
    expect(e[0]).toMatchObject({
      kanal: "voice",
      text: "Setz Deep Drive auf die Watchlist, die arbeiten mit BMW.",
    });
  });

  it("hängt die Aufrufe an Kuros nächsten Satz und lässt Verwaltung und Zwischenstände weg", () => {
    expect(e[1]?.werkzeuge).toEqual([
      'beauftragt journal: „Deep Drive auf die Watchlist, Notiz BMW."',
    ]);
    expect(e.some((x) => x.text.includes("arbeitet noch daran"))).toBe(false);
  });

  it("erkennt einen nachgereichten Bericht als Bericht, nicht als Jakob", () => {
    expect(e[2]).toMatchObject({
      wer: "bericht",
      von: "journal",
      text: "Deep Drive steht auf der Watchlist.",
    });
  });

  it("fasst zwei Sätze desselben Zugs zusammen", () => {
    expect(e[3]?.text).toBe(
      "Deep Drive steht jetzt auf der Watchlist.\n\nDen Ticker prüfe ich noch.",
    );
  });

  it("teilt nach Wiener Tagen", () => {
    expect([...nachTagen(e).keys()]).toEqual(["2026-09-22", "2026-09-26", "2026-09-27"]);
  });

  it("schreibt den Tag als Markdown", () => {
    const md = tagesMarkdown(
      "2026-09-22",
      nachTagen(e).get("2026-09-22") ?? [],
      "abc",
      "Watchlist",
    );
    expect(md).toContain("# Gespräch vom Dienstag, 22. September 2026");
    expect(md).toContain("### 17:36 · Jakob · gesprochen");
    expect(md).toContain("> Deep Drive steht auf der Watchlist.");
    expect(md).toContain("**Worum es ging:** Watchlist");
  });
});

describe("werkzeugZeile", () => {
  it("sagt in einem Satz, was passiert ist", () => {
    expect(werkzeugZeile("WebFetch", { url: "https://api.open-meteo.com/v1/forecast?x=1" })).toBe(
      "ruft api.open-meteo.com ab",
    );
    expect(werkzeugZeile("mcp__buehne__zeige", { tafel: "wetter" })).toBe(
      'zeigt die Tafel „wetter"',
    );
    expect(werkzeugZeile("ToolSearch", {})).toBeNull();
  });
});

describe("leseUebergabe", () => {
  it("liest Übergabe und Themen, nur gültige Tage", () => {
    const u = leseUebergabe(
      'Bitte: {"uebergabe": "## Was offen ist\\nBTC-Auslöser 82.000 beobachten.", "themen": {"2026-09-22": "Watchlist", "gestern": "x"}}',
    );
    expect(u.uebergabe).toContain("82.000");
    expect(u.themen).toEqual({ "2026-09-22": "Watchlist" });
  });

  it("verweigert eine leere oder formlose Übergabe", () => {
    expect(() => leseUebergabe('{"uebergabe": ""}')).toThrow();
    expect(() => leseUebergabe("<uebergabe>\n\n</uebergabe>")).toThrow();
    expect(() => leseUebergabe("Hier ist die Übergabe …")).toThrow();
  });

  it("liest die Markierungen — Zitate darin brauchen keine Maske (der Fall vom 27.09.)", () => {
    const u = leseUebergabe(
      [
        "<uebergabe>",
        "## Was offen ist",
        'Die boerse sollte „Analysen und Strategien" zusammenfassen; Bericht steht aus.',
        "</uebergabe>",
        "<themen>",
        "2026-09-26: Watchlist, BTC-Idee",
        "- 2026-09-27: Wochenziel 100 Euro, Archiv",
        "gestern: x",
        "</themen>",
      ].join("\n"),
    );
    expect(u.uebergabe).toBe(
      '## Was offen ist\nDie boerse sollte „Analysen und Strategien" zusammenfassen; Bericht steht aus.',
    );
    expect(u.themen).toEqual({
      "2026-09-26": "Watchlist, BTC-Idee",
      "2026-09-27": "Wochenziel 100 Euro, Archiv",
    });
  });

  it("nimmt eine Übergabe, deren Schlussmarke fehlt, und sagt bei kaputtem JSON, was los ist", () => {
    expect(leseUebergabe("<uebergabe>\n## Was offen ist\nBTC-Auslöser beobachten.").uebergabe).toBe(
      "## Was offen ist\nBTC-Auslöser beobachten.",
    );
    expect(() => leseUebergabe('{"uebergabe": "Er sagte „so" und ging."}')).toThrow(
      /kaputtes JSON/,
    );
  });
});

describe("sucheImArchiv", () => {
  const dateien = [
    {
      pfad: "brain/Gespräche/2026/2026-09-22.md",
      inhalt:
        "# Tag\n\n### 17:36 · Jakob\n\nSiemens auf die Watchlist.\n\n### 17:40 · Kuro\n\nSehr wohl.",
    },
    {
      pfad: "brain/Gespräche/2026/2026-09-26.md",
      inhalt: "# Tag\n\n### 09:00 · Jakob\n\nWas macht die Siemens Watchlist?",
    },
  ];

  it("findet, wo alle Wörter stehen, neueste zuerst", () => {
    const f = sucheImArchiv(dateien, "siemens watchlist");
    expect(f.map((x) => `${x.tag} ${x.kopf}`)).toEqual([
      "2026-09-26 09:00 · Jakob",
      "2026-09-22 17:36 · Jakob",
    ]);
    expect(sucheImArchiv(dateien, "siemens bmw")).toEqual([]);
  });
});

describe("istArchivZeit", () => {
  it("archiviert nachts, und nur, was vor heute begann", () => {
    const vier = new Date("2026-09-28T02:00:00Z"); // 04:00 in Wien
    expect(istArchivZeit(vier, "2026-09-22T15:36:36Z")).toBe(true);
    expect(istArchivZeit(vier, "2026-09-28T01:30:00Z")).toBe(false); // 03:30 heute begonnen
    expect(istArchivZeit(new Date("2026-09-28T10:00:00Z"), "2026-09-22T15:36:36Z")).toBe(false);
  });
});

describe("Archiv bei vollem Kontext", () => {
  it("ist voll ab der Grenze, nie ohne Messung", () => {
    expect(istKontextVoll(null, KONTEXT_GRENZE)).toBe(false);
    expect(istKontextVoll(KONTEXT_GRENZE - 1, KONTEXT_GRENZE)).toBe(false);
    expect(istKontextVoll(KONTEXT_GRENZE, KONTEXT_GRENZE)).toBe(true);
  });

  it("wartet zehn Minuten Ruhe ab", () => {
    const jetzt = new Date("2026-10-02T15:00:00Z");
    const vor = (ms: number) => new Date(jetzt.getTime() - ms);
    expect(darfJetztArchivieren(90_000, vor(RUHE_MS - 1), jetzt, KONTEXT_GRENZE)).toBe(false);
    expect(darfJetztArchivieren(90_000, vor(RUHE_MS), jetzt, KONTEXT_GRENZE)).toBe(true);
    expect(darfJetztArchivieren(50_000, vor(RUHE_MS * 6), jetzt, KONTEXT_GRENZE)).toBe(false);
  });
});

describe("das Archiv", () => {
  let ordner = "";
  afterEach(async () => {
    if (ordner) await rm(ordner, { recursive: true, force: true });
  });

  it("legt nach Tagen ab, schreibt Verzeichnis und Übergabe — und die Übergabe steht im Prompt", async () => {
    ordner = await mkdtemp(path.join(tmpdir(), "gespraeche-"));
    const roh = path.join(ordner, "s.jsonl");
    await writeFile(roh, VERLAUF, "utf8");
    const archiv = createGespraechsarchiv({
      workdir: ordner,
      schreibe: async () =>
        "<uebergabe>\n## Was offen ist\nDen Ticker von Deep Drive prüfen.\n</uebergabe>\n<themen>\n2026-09-22: Watchlist Deep Drive\n</themen>",
    });
    const r = await archiv.archiviere("abc", roh, "nachts");
    expect(r).toMatchObject({ tage: ["2026-09-22", "2026-09-26", "2026-09-27"], nachrichten: 2 });
    expect(await readdir(path.join(ordner, "brain/Gespräche/2026"))).toEqual([
      "2026-09-22.md",
      "2026-09-26.md",
      "2026-09-27.md",
    ]);
    const index = await readFile(path.join(ordner, "brain/Gespräche/INDEX.md"), "utf8");
    expect(index).toContain(
      "| [Dienstag, 22. September 2026](2026/2026-09-22.md) | 1 | Watchlist Deep Drive |",
    );
    expect(index).toContain(
      "- [Übergabe bis Sonntag, 27. September 2026](uebergaben/2026-09-27.md)",
    );
    expect(await archiv.uebergabeAbschnitt()).toContain("Den Ticker von Deep Drive prüfen.");
    expect(await archiv.uebergabeAbschnitt()).toContain("bis Sonntag, 27. September 2026");
    expect((await archiv.suche("ticker")).length).toBe(1);
  });

  it("schreibt nichts, wenn die Übergabe scheitert", async () => {
    ordner = await mkdtemp(path.join(tmpdir(), "gespraeche-"));
    const roh = path.join(ordner, "s.jsonl");
    await writeFile(roh, VERLAUF, "utf8");
    const archiv = createGespraechsarchiv({ workdir: ordner, schreibe: async () => "kein JSON" });
    await expect(archiv.archiviere("abc", roh, "nachts")).rejects.toThrow();
    expect(await readdir(ordner)).toEqual(["s.jsonl"]);
    expect(await archiv.uebergabeAbschnitt()).toBe("");
  });
});
