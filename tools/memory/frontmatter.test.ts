import { describe, expect, it } from "vitest";
import { FrontmatterError, parseNote, readList, renderNote, requireScalar } from "./frontmatter.js";

/**
 * Der Frontmatter-Parser, ohne Datenbank und ohne Dateisystem. Er ist die Stelle, an der eine
 * von Hand geschriebene Notiz auf den Index trifft — und damit die Stelle, an der ein stiller
 * Fehler eine Notiz unauffindbar machen würde.
 */

const NOTE = `---
id: 2026-09-09-cal-zeitzone
datum: 2026-09-09
titel: cal.list rechnet in der Zeitzone des Läufers
art: erkenntnis
tags: [cal, zeitzone, s15]
ersetzt: [2026-09-01-alte-annahme]
---

Das Vorgabefenster von cal.list ist lokale Zeit.

Zweiter Absatz.
`;

describe("Frontmatter · lesen", () => {
  it("zerlegt eine Notiz in Felder und Rumpf", () => {
    const parsed = parseNote(NOTE);
    expect(parsed.fields.id).toBe("2026-09-09-cal-zeitzone");
    expect(parsed.fields.datum).toBe("2026-09-09");
    expect(parsed.fields.titel).toBe("cal.list rechnet in der Zeitzone des Läufers");
    expect(parsed.fields.tags).toEqual(["cal", "zeitzone", "s15"]);
    expect(parsed.fields.ersetzt).toEqual(["2026-09-01-alte-annahme"]);
    expect(parsed.body).toBe("Das Vorgabefenster von cal.list ist lokale Zeit.\n\nZweiter Absatz.");
  });

  it("nimmt CRLF entgegen — eine Notiz kann aus einem Windows-Editor kommen", () => {
    const parsed = parseNote(NOTE.replace(/\n/g, "\r\n"));
    expect(parsed.fields.titel).toBe("cal.list rechnet in der Zeitzone des Läufers");
    expect(parsed.body).not.toContain("\r");
  });

  it("lässt einen Doppelpunkt im Wert stehen: nur der erste trennt", () => {
    const parsed = parseNote("---\ntitel: Regel: Zeitzonen sind lokal\n---\n\nText");
    expect(parsed.fields.titel).toBe("Regel: Zeitzonen sind lokal");
  });

  it("liest die leere Liste als leere Liste", () => {
    const parsed = parseNote("---\ntags: []\nersetzt: [ ]\n---\n\nText");
    expect(parsed.fields.tags).toEqual([]);
    expect(parsed.fields.ersetzt).toEqual([]);
  });

  it("weist eine Datei ohne Frontmatter ab, statt sie als feldlose Notiz zu nehmen", () => {
    // Sie käme sonst ohne Datum, Tags und Kennung in den Index und wäre nie wieder auffindbar
    // — ein Verlust, der wie ein Erfolg aussähe.
    expect(() => parseNote("# Nur eine Überschrift\n\nText")).toThrow(FrontmatterError);
  });

  it("weist ein unabgeschlossenes Frontmatter ab", () => {
    expect(() => parseNote("---\ntitel: x\n\nText ohne zweite Zaunlinie")).toThrow(
      FrontmatterError,
    );
  });

  it("weist eine Zeile ab, die keine Zuweisung ist", () => {
    expect(() => parseNote("---\ntitel: x\neinfach nur Text\n---\n\nRumpf")).toThrow(
      /keine Zuweisung/,
    );
  });

  it("weist ein doppeltes Feld ab, statt eine Lesereihenfolge zu erfinden", () => {
    expect(() => parseNote("---\ntitel: a\ntitel: b\n---\n\nRumpf")).toThrow(/zweimal/);
  });
});

describe("Frontmatter · schreiben", () => {
  it("schreibt und liest dasselbe zurück", () => {
    const fields = {
      id: "2026-09-09-x",
      datum: "2026-09-09",
      titel: "Ein Titel",
      art: "erkenntnis",
      tags: ["a", "b"],
    };
    const parsed = parseNote(renderNote(fields, "Der Rumpf."));
    expect(parsed.fields).toEqual(fields);
    expect(parsed.body).toBe("Der Rumpf.");
  });

  it("quotet einen Titel, der ganz wie eine Liste aussieht", () => {
    // Ohne Anführungszeichen läse `parseNote` ihn beim nächsten Mal als Liste zurück, und aus
    // einem Titel würden zwei Tags.
    const text = renderNote({ titel: "[cal, zeitzone]" }, "Rumpf");
    expect(text).toContain('titel: "[cal, zeitzone]"');
    expect(parseNote(text).fields.titel).toBe("[cal, zeitzone]");
  });

  it("lässt eine bloß angefangene Klammer in Ruhe — sie ist keine Liste", () => {
    // Die Gegenprobe zur Regel oben: `parseNote` verlangt Klammern auf **beiden** Seiten, ein
    // Titel wie dieser wird also ohnehin als Text gelesen. Zusätzliche Anführungszeichen wären
    // nur Lärm in einer Datei, die ein Mensch liest.
    const text = renderNote({ titel: "[Entwurf] Zeitzonen" }, "Rumpf");
    expect(text).toContain("titel: [Entwurf] Zeitzonen");
    expect(parseNote(text).fields.titel).toBe("[Entwurf] Zeitzonen");
  });

  it("weist einen mehrzeiligen Wert ab, statt ihn stillschweigend zu kürzen", () => {
    expect(() => renderNote({ titel: "Zeile eins\nZeile zwei" }, "Rumpf")).toThrow(/Zeilenumbruch/);
  });

  it("weist einen Listeneintrag mit Komma ab — er ließe sich nicht zurücklesen", () => {
    expect(() => renderNote({ tags: ["a,b"] }, "Rumpf")).toThrow(/Komma/);
  });
});

describe("Frontmatter · Pflichtfelder", () => {
  it("holt ein Pflichtfeld und wirft, wenn es fehlt oder leer ist", () => {
    const parsed = parseNote("---\ntitel: Da\nleer:\n---\n\nRumpf");
    expect(requireScalar(parsed, "titel")).toBe("Da");
    expect(() => requireScalar(parsed, "leer")).toThrow(FrontmatterError);
    expect(() => requireScalar(parsed, "fehlt")).toThrow(/fehlt/);
  });

  it("liest ein Listenfeld nachsichtig: fehlend leer, einzelner Wert einelementig", () => {
    const parsed = parseNote("---\ntags: [a, b]\neins: c\n---\n\nRumpf");
    expect(readList(parsed, "tags")).toEqual(["a", "b"]);
    expect(readList(parsed, "eins")).toEqual(["c"]);
    expect(readList(parsed, "gibtsnicht")).toEqual([]);
  });
});
