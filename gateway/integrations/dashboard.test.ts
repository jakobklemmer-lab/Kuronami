import { describe, expect, it } from "vitest";
import type { IndexedNote } from "../../tools/memory/index-db.js";
import { displayNameOf, loadCalendar, notesAsFiles, summarizeNotes } from "./dashboard.js";

describe("loadCalendar", () => {
  it("meldet: nicht verbunden", () => {
    const result = loadCalendar();
    expect(result.connected).toBe(false);
    expect(result.events).toEqual([]);
  });
});

describe("displayNameOf", () => {
  it("zieht den Anzeigenamen aus der Kopfzeile", () => {
    expect(displayNameOf('"Beispiel Kaffee" <info@example.com>')).toBe("Beispiel Kaffee");
    expect(displayNameOf("Beispielladen <shop@example.org>")).toBe("Beispielladen");
    expect(displayNameOf("<only@address.example>")).toBe("only@address.example");
    expect(displayNameOf("plain@address.example")).toBe("plain@address.example");
  });
});

describe("summarizeNotes/notesAsFiles", () => {
  const note = (id: string, mtimeMs: number, body: string): IndexedNote => ({
    id,
    path: `notes/${id}.md`,
    date: "2026-09-16",
    title: `Titel ${id}`,
    kind: "fact",
    tags: ["t"],
    body,
    supersedes: [],
    supersededBy: [],
    mtimeMs,
    sizeBytes: body.length,
  });

  it("sortiert neueste zuerst und kürzt den Auszug", () => {
    const notes = summarizeNotes([
      note("alt", 1_000, "kurz"),
      note("neu", 2_000, `${"x".repeat(200)}  mit   Leerraum`),
    ]);
    expect(notes.map((n) => n.id)).toEqual(["neu", "alt"]);
    expect(notes[0]?.excerpt.endsWith(" …")).toBe(true);
    expect(notes[0]?.excerpt.length).toBeLessThanOrEqual(182);
    expect(notes[1]?.excerpt).toBe("kurz");
    expect(notes[0]?.updatedAt).toBe(new Date(2_000).toISOString());
  });

  it("macht aus Notizen Dateieinträge", () => {
    const files = notesAsFiles(summarizeNotes([note("a", 1, "b")]));
    expect(files[0]).toMatchObject({ id: "note:a", kind: "note", path: "memory/notes/a.md" });
  });
});
