import { describe, expect, it } from "vitest";
import { type IndexedNote, buildMatchQuery, openIndex } from "./index-db.js";

/**
 * Der SQLite-Volltextindex, ohne Postgres und ohne Dateisystem (`:memory:`). Hier steht der
 * Nachweis, dass die Suche **ohne Vektordatenbank** das leistet, was S18 verlangt: eine
 * thematisch verwandte Notiz finden, auch wenn die Frage nicht ihre Worte benutzt.
 */

let counter = 0;

function note(partial: Partial<IndexedNote> & { title: string; body: string }): IndexedNote {
  counter += 1;
  return {
    id: partial.id ?? `2026-09-0${(counter % 9) + 1}-note-${counter}`,
    path: `notizen/${partial.id ?? `note-${counter}`}.md`,
    date: partial.date ?? "2026-09-01",
    title: partial.title,
    kind: partial.kind ?? "erkenntnis",
    tags: partial.tags ?? [],
    body: partial.body,
    supersedes: partial.supersedes ?? [],
    supersededBy: partial.supersededBy ?? [],
    mtimeMs: partial.mtimeMs ?? 1_000,
    sizeBytes: partial.sizeBytes ?? partial.body.length,
  };
}

describe("Suchanfrage · Aufbereitung", () => {
  it("wirft Füllwörter weg und sucht den Rest mit Präfix", () => {
    expect(buildMatchQuery("Wie war das nochmal mit der Zeitzone im Kalender?")).toBe(
      '"zeitzone"* OR "kalender"*',
    );
  });

  it("entschärft FTS5-Syntax, statt an ihr zu scheitern", () => {
    // Ohne Aufbereitung wäre das entweder ein Syntaxfehler oder — schlimmer — eine stille
    // andere Anfrage: `AND`, `NOT`, `-` und `:` sind in FTS5 Operatoren.
    const query = buildMatchQuery('cal.list AND NOT "foo" -bar: (baz)');
    expect(query).toBe('"cal"* OR "list"* OR "and"* OR "not"* OR "foo"* OR "bar"* OR "baz"*');
    const index = openIndex(":memory:");
    index.put(note({ title: "cal.list", body: "Der Kalender läuft über die Brücke." }));
    expect(() => index.search('cal.list AND NOT "foo" -bar: (baz)', 5)).not.toThrow();
    index.close();
  });

  it("gibt null zurück, wenn nach dem Filtern nichts übrig bleibt", () => {
    expect(buildMatchQuery("wie war das mit dem und der")).toBeNull();
    expect(buildMatchQuery("???")).toBeNull();
    expect(buildMatchQuery("")).toBeNull();
  });

  it("nimmt jeden Term nur einmal — Wiederholung soll das Ranking nicht verschieben", () => {
    expect(buildMatchQuery("kalender kalender kalender zeitzone")).toBe(
      '"kalender"* OR "zeitzone"*',
    );
  });
});

describe("Volltextindex · finden", () => {
  it("findet eine Notiz über ein Wort aus ihrem Rumpf", () => {
    const index = openIndex(":memory:");
    index.put(
      note({
        title: "Kalenderfenster",
        body: "Das Vorgabefenster von cal.list rechnet in der Zeitzone des Läufers.",
        tags: ["cal"],
      }),
    );
    const hits = index.search("Zeitzone", 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].note.title).toBe("Kalenderfenster");
    expect(hits[0].snippet).toContain("«");
    index.close();
  });

  it("faltet Umlaute: „offentlich“ findet „öffentlich“", () => {
    const index = openIndex(":memory:");
    index.put(note({ title: "Port", body: "Der Postgres-Port ist öffentlich erreichbar." }));
    expect(index.search("offentlich", 5)).toHaveLength(1);
    expect(index.search("öffentlich", 5)).toHaveLength(1);
    index.close();
  });

  it("findet über den Wortanfang: „zeitzonen“ trifft „Zeitzonenfehler“", () => {
    // Der Ersatz für ein Stemming, das es für Deutsch ohne Bibliothek nicht seriös gibt.
    const index = openIndex(":memory:");
    index.put(note({ title: "Fehler", body: "Ein Zeitzonenfehler im Vorgabefenster." }));
    expect(index.search("zeitzonen", 5)).toHaveLength(1);
    index.close();
  });

  it("findet bei teilweiser Überschneidung — das ist der Zweck des OR", () => {
    // Mit AND fiele diese Notiz durch, sobald ein Wort der Frage in ihr fehlt. Genau das ist
    // der Fall, den S18 lösen soll.
    const index = openIndex(":memory:");
    index.put(
      note({
        title: "Kalenderfenster",
        body: "cal.list nimmt ohne Bereich die laufende Woche.",
        tags: ["cal"],
      }),
    );
    const hits = index.search("Wie berechnet der Kalender eigentlich die Sommerzeit?", 5);
    expect(hits).toHaveLength(1);
    index.close();
  });

  it("gewichtet Tags am höchsten, dann den Titel, dann den Rumpf", () => {
    const index = openIndex(":memory:");
    index.put(note({ id: "im-rumpf", title: "Irgendwas", body: "Am Rande fiel das Wort mail." }));
    index.put(note({ id: "im-titel", title: "mail und Anhänge", body: "Ein Text ohne Bezug." }));
    index.put(
      note({ id: "im-tag", title: "Anhänge", body: "Ein Text ohne Bezug.", tags: ["mail"] }),
    );

    const order = index.search("mail", 5).map((hit) => hit.note.id);
    expect(order[0]).toBe("im-tag");
    expect(order[1]).toBe("im-titel");
    expect(order[2]).toBe("im-rumpf");
    index.close();
  });

  it("gibt nichts zurück, wenn kein Wort trifft — und das ist eine Auskunft", () => {
    const index = openIndex(":memory:");
    index.put(note({ title: "Kalender", body: "Über Termine und Zeitzonen." }));
    expect(index.search("Bundesliga", 5)).toEqual([]);
    index.close();
  });

  it("findet ein deutsches Kompositum auch von hinten: „Terminkalender“ trifft „Kalender“", () => {
    // Der Fall aus dem Nachweis am echten Gedächtnis. FTS5 sucht mit Präfix, und der greift im
    // Deutschen nur in eine Richtung — „kalender" findet „Kalenderfenster", aber nicht
    // umgekehrt. Der Rückfall auf Teilwortsuche schließt genau diese Lücke.
    const index = openIndex(":memory:");
    index.put(
      note({
        title: "Kalenderfenster",
        body: "Das Vorgabefenster rechnet in der lokalen Zeit des Läufers.",
        tags: ["kalender"],
      }),
    );
    const hits = index.search("Wie berechnet der Terminkalender die Wochengrenze?", 5);
    expect(hits).toHaveLength(1);
    // Und der Treffer sagt, dass er aus dem unschärferen Durchgang stammt.
    expect(hits[0].matched).toBe("teilwort");
    expect(hits[0].snippet).toContain("«");
    index.close();
  });

  it("nimmt den Rückfall nur, wenn der Volltext gar nichts findet", () => {
    // Sonst verwässerten die unschärferen Treffer ein Ranking, das es sonst gäbe.
    const index = openIndex(":memory:");
    index.put(note({ id: "genau", title: "Kalender", body: "Über Termine.", tags: ["kalender"] }));
    index.put(note({ id: "unscharf", title: "Terminkalender", body: "Etwas anderes." }));

    const hits = index.search("kalender", 5);
    expect(hits.every((hit) => hit.matched === "volltext")).toBe(true);
    // `Terminkalender` ist als eigenes Wort indiziert und wird von `kalender*` nicht getroffen
    // — es steht hier also nur, wenn der Rückfall fälschlich mitgelaufen wäre.
    expect(hits.map((hit) => hit.note.id)).toEqual(["genau"]);
    index.close();
  });

  it("greift beim Rückfall nicht auf zu kurze Terme zurück", () => {
    // Ein Term wie „utc" träfe als Teilwort fast überall; drei Zeichen sind für eine
    // Teilwortsuche zu wenig Aussage.
    const index = openIndex(":memory:");
    index.put(note({ title: "Etwas", body: "Ein Text mit dem Wort Abcdefghij darin." }));
    expect(index.search("xyz", 5)).toEqual([]);
    index.close();
  });

  it("achtet das Limit", () => {
    const index = openIndex(":memory:");
    for (let i = 0; i < 10; i += 1) {
      index.put(note({ title: `Kalender ${i}`, body: "Zeitzone und Termine." }));
    }
    expect(index.search("kalender zeitzone", 3)).toHaveLength(3);
    index.close();
  });
});

describe("Volltextindex · pflegen", () => {
  it("ersetzt eine Notiz vollständig, statt sie doppelt zu führen", () => {
    // Ohne das Löschen im FTS-Teil stünde die geänderte Notiz zweimal im Index und träfe
    // doppelt — ein Fehler, den man erst an einer seltsamen Trefferliste bemerkt.
    const index = openIndex(":memory:");
    index.put(note({ id: "fest", title: "Erste Fassung", body: "Über Kalender." }));
    index.put(note({ id: "fest", title: "Zweite Fassung", body: "Über Kalender." }));

    expect(index.count()).toBe(1);
    const hits = index.search("kalender", 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].note.title).toBe("Zweite Fassung");
    index.close();
  });

  it("entfernt eine Notiz aus Tabelle und Volltext", () => {
    const index = openIndex(":memory:");
    index.put(note({ id: "weg", title: "Kalender", body: "Über Zeitzonen." }));
    index.remove("weg");
    expect(index.count()).toBe(0);
    expect(index.search("zeitzonen", 5)).toEqual([]);
    expect(index.get("weg")).toBeNull();
    index.close();
  });

  it("findet über Tags exakt, nicht über Wortanfänge", () => {
    // `cal` soll nicht auf `calendar` passen: ein Tag ist eine gewählte Kennung, kein Text.
    const index = openIndex(":memory:");
    index.put(note({ id: "a", title: "A", body: "Text", tags: ["cal"] }));
    index.put(note({ id: "b", title: "B", body: "Text", tags: ["calendar"] }));
    expect(index.byTags(["cal"], 10).map((entry) => entry.id)).toEqual(["a"]);
    expect(index.byTags(["CAL"], 10).map((entry) => entry.id)).toEqual(["a"]);
    expect(index.byTags([], 10)).toEqual([]);
    index.close();
  });

  it("gibt Widerspruchsverweise unverändert zurück", () => {
    const index = openIndex(":memory:");
    index.put(
      note({
        id: "neu",
        title: "Neue Lage",
        body: "Text",
        supersedes: ["alt"],
        supersededBy: [],
      }),
    );
    index.put(note({ id: "alt", title: "Alte Lage", body: "Text", supersededBy: ["neu"] }));
    expect(index.get("neu")?.supersedes).toEqual(["alt"]);
    expect(index.get("alt")?.supersededBy).toEqual(["neu"]);
    index.close();
  });

  it("gibt den Dateizustand für den Abgleich mit der Platte heraus", () => {
    const index = openIndex(":memory:");
    index.put(note({ id: "eins", title: "T", body: "Text", mtimeMs: 12_345, sizeBytes: 99 }));
    const state = index.fileState();
    expect(state.get("eins")).toEqual({
      mtimeMs: 12_345,
      sizeBytes: 99,
      path: "notizen/eins.md",
    });
    index.close();
  });
});
