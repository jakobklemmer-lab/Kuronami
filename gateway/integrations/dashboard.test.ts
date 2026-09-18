import { describe, expect, it } from "vitest";
import type { IndexedNote } from "../../tools/memory/index-db.js";
import {
  displayNameOf,
  loadCalendar,
  mapCalendarEvents,
  notesAsFiles,
  summarizeNotes,
  todayRange,
} from "./dashboard.js";

describe("todayRange", () => {
  it("spannt lokal von Mitternacht bis Mitternacht", () => {
    const { start, end } = todayRange(new Date(2026, 8, 16, 15, 30));
    expect(new Date(start).getHours()).toBe(0);
    expect(new Date(end).getTime() - new Date(start).getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

describe("mapCalendarEvents", () => {
  it("bildet die cal-list-Form ab, sortiert nach Beginn und lässt Einträge ohne Start weg", () => {
    const events = mapCalendarEvents({
      events: [
        { id: "b", title: "Später", start: "2026-09-16T14:00:00Z", end: "", all_day: false },
        { id: "a", title: "", start: "2026-09-16T08:00:00Z", location: "Büro", account: "gmail_1" },
        { id: "x", title: "ohne Start" },
      ],
    });
    expect(events.map((e) => e.id)).toEqual(["a", "b"]);
    expect(events[0]).toMatchObject({
      title: "(kein Titel)",
      location: "Büro",
      account: "gmail_1",
    });
    expect(events[1]?.location).toBeNull();
  });

  it("verträgt Unsinn", () => {
    expect(mapCalendarEvents(null)).toEqual([]);
    expect(mapCalendarEvents({ events: "nein" })).toEqual([]);
  });
});

describe("loadCalendar", () => {
  it("meldet ohne Brücke: nicht verbunden", async () => {
    const result = await loadCalendar(undefined, new AbortController().signal);
    expect(result.connected).toBe(false);
    expect(result.events).toEqual([]);
  });

  it("übersetzt den inaktiven Workflow in einen verständlichen Grund", async () => {
    const bridge = {
      configured: true,
      async invoke() {
        throw new Error('n8n-Workflow hat mit HTTP 404 geantwortet ("not registered").');
      },
    } as unknown as Parameters<typeof loadCalendar>[0];
    const result = await loadCalendar(bridge, new AbortController().signal);
    expect(result.connected).toBe(false);
    expect(result.reason).toMatch(/noch nicht aktiv/);
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
