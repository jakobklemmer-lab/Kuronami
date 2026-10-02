import { describe, expect, it } from "vitest";
import { beschreibeEintrag, terminZeile } from "./kalender-werkzeuge.js";
import {
  antworten,
  baueIcs,
  createKalender,
  hrefIn,
  kalenderZugang,
  leseIcs,
  wienerZeit,
  zeitInZone,
} from "./kalender.js";

const ICS = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "UID:abc",
  "DTSTART;TZID=Europe/Vienna:20261002T140000",
  "DTEND;TZID=Europe/Vienna:20261002T153000",
  "SUMMARY:Lernen\\, Statistik",
  "LOCATION:Bibliothek",
  "BEGIN:VALARM",
  "TRIGGER:-PT10M",
  "DESCRIPTION:Erinnerung",
  "END:VALARM",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:ganz",
  "DTSTART;VALUE=DATE:20261003",
  "DTEND;VALUE=DATE:20261004",
  "SUMMARY:Ausflug mit einem sehr langen Titel, der über",
  "  zwei Zeilen gefaltet ist",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:serie",
  "RECURRENCE-ID:20261005T070000Z",
  "DTSTART:20261005T070000Z",
  "DTEND:20261005T073000Z",
  "SUMMARY:Laufen",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("zeitInZone", () => {
  it("rechnet Wiener Sommer- und Winterzeit richtig nach UTC", () => {
    expect(zeitInZone("20261002T140000", "Europe/Vienna").toISOString()).toBe(
      "2026-10-02T12:00:00.000Z",
    );
    expect(zeitInZone("20261202T140000", "Europe/Vienna").toISOString()).toBe(
      "2026-12-02T13:00:00.000Z",
    );
    expect(wienerZeit("2026-10-25T09:00").toISOString()).toBe("2026-10-25T08:00:00.000Z");
  });
});

describe("leseIcs", () => {
  it("liest Zonenzeiten, ganze Tage, gefaltete Zeilen und Serientermine", () => {
    const t = leseIcs(ICS, "Privat");
    expect(t).toEqual([
      {
        id: "abc",
        titel: "Lernen, Statistik",
        start: "2026-10-02T12:00:00.000Z",
        ende: "2026-10-02T13:30:00.000Z",
        ganztags: false,
        ort: "Bibliothek",
        kalender: "Privat",
      },
      {
        id: "ganz",
        titel: "Ausflug mit einem sehr langen Titel, der über zwei Zeilen gefaltet ist",
        start: "2026-10-03",
        ende: "2026-10-04",
        ganztags: true,
        ort: null,
        kalender: "Privat",
      },
      {
        id: "serie#20261005T070000Z",
        titel: "Laufen",
        start: "2026-10-05T07:00:00.000Z",
        ende: "2026-10-05T07:30:00.000Z",
        ganztags: false,
        ort: null,
        kalender: "Privat",
      },
    ]);
  });
});

describe("baueIcs", () => {
  it("schreibt einen Termin mit Erinnerung, den leseIcs wieder liest", () => {
    const ics = baueIcs(
      {
        titel: "Fokus; Mathe",
        start: new Date("2026-10-03T07:00:00Z"),
        ende: new Date("2026-10-03T08:30:00Z"),
        erinnerung: 10,
      },
      "u1@kuronami",
      new Date("2026-10-02T00:00:00Z"),
    );
    expect(ics).toContain("TRIGGER:-PT10M");
    expect(ics).toContain("SUMMARY:Fokus\\; Mathe");
    expect(leseIcs(ics, "Kuro")[0]).toMatchObject({
      titel: "Fokus; Mathe",
      start: "2026-10-03T07:00:00.000Z",
      ende: "2026-10-03T08:30:00.000Z",
    });
  });
});

describe("Multistatus", () => {
  it("findet Antworten und Verweise mit beliebigem Präfix", () => {
    const xml = `<?xml version="1.0"?><multistatus xmlns="DAV:"><response><href>/</href><propstat><prop><current-user-principal><href>/123456/principal/</href></current-user-principal></prop></propstat></response></multistatus>`;
    expect(antworten(xml)).toHaveLength(1);
    expect(hrefIn(xml, "current-user-principal")).toBe("/123456/principal/");
  });
});

describe("createKalender", () => {
  const zugang = kalenderZugang({ KALENDER_USER: "jakob@example.org", KALENDER_PASS: "abcd-efgh" });

  it("findet Principal, Heim und Kalender, liest Termine und trägt ein", async () => {
    const anfragen: Array<{ methode: string; url: string; body: string }> = [];
    const antwort = (status: number, body: string) =>
      new Response(body, { status, headers: { "content-type": "application/xml" } });
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const methode = init?.method ?? "GET";
      anfragen.push({ methode, url: u, body: String(init?.body ?? "") });
      if (methode === "PROPFIND" && u === "https://caldav.icloud.com/")
        return antwort(
          207,
          `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/123/principal/</d:href></d:current-user-principal></d:prop></d:propstat></d:response></d:multistatus>`,
        );
      if (methode === "PROPFIND" && u.endsWith("/123/principal/"))
        return antwort(
          207,
          `<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><response><href>/123/principal/</href><propstat><prop><C:calendar-home-set><href xmlns="DAV:">https://p42-caldav.icloud.com/123/calendars/</href></C:calendar-home-set></prop></propstat></response></multistatus>`,
        );
      if (methode === "PROPFIND" && u === "https://p42-caldav.icloud.com/123/calendars/")
        return antwort(
          207,
          `<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><response><href>/123/calendars/</href><propstat><prop><resourcetype><collection/></resourcetype></prop></propstat></response><response><href>/123/calendars/home/</href><propstat><prop><resourcetype><collection/><C:calendar/></resourcetype><displayname>Privat</displayname><C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set></prop></propstat></response><response><href>/123/calendars/tasks/</href><propstat><prop><resourcetype><collection/><C:calendar/></resourcetype><displayname>Erinnerungen</displayname><C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set></prop></propstat></response></multistatus>`,
        );
      if (methode === "REPORT")
        return antwort(
          207,
          `<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><response><href>/123/calendars/home/abc.ics</href><propstat><prop><C:calendar-data>${ICS.replace(/&/g, "&amp;")}</C:calendar-data></prop></propstat></response></multistatus>`,
        );
      if (methode === "PUT") return new Response("", { status: 201 });
      return new Response("", { status: 404 });
    }) as typeof fetch;

    expect(zugang).not.toBeNull();
    const k = createKalender(zugang as NonNullable<typeof zugang>, fetchImpl);
    expect(await k.kalender()).toEqual([
      { name: "Privat", href: "https://p42-caldav.icloud.com/123/calendars/home/" },
    ]);
    const termine = await k.termine(
      new Date("2026-10-02T00:00:00Z"),
      new Date("2026-10-04T00:00:00Z"),
    );
    expect(termine.map((t) => t.titel)).toEqual([
      "Lernen, Statistik",
      "Ausflug mit einem sehr langen Titel, der über zwei Zeilen gefaltet ist",
    ]);
    const r = await k.lege({
      titel: "Fokus",
      start: new Date("2026-10-03T07:00:00Z"),
      ende: new Date("2026-10-03T08:00:00Z"),
      erinnerung: 10,
    });
    expect(r.kalender).toBe("Privat");
    const put = anfragen.find((a) => a.methode === "PUT");
    expect(put?.url).toMatch(
      /^https:\/\/p42-caldav\.icloud\.com\/123\/calendars\/home\/.+@kuronami\.ics$/,
    );
    expect(put?.body).toContain("SUMMARY:Fokus");
  });

  it("sagt, wenn das App-Passwort nicht stimmt", async () => {
    const k = createKalender(
      zugang as NonNullable<typeof zugang>,
      (async () => new Response("", { status: 401 })) as typeof fetch,
    );
    await expect(k.kalender()).rejects.toThrow(/App-Passwort/);
  });
});

describe("Kuros Kalender-Sätze", () => {
  it("zeigt Termine in Wiener Zeit und fragt mit jedem Block", () => {
    expect(
      terminZeile({
        id: "a",
        titel: "Lernen",
        start: "2026-10-02T12:00:00.000Z",
        ende: "2026-10-02T13:30:00.000Z",
        ganztags: false,
        ort: null,
        kalender: "Privat",
      }),
    ).toBe("Fr., 02.10. 14:00–15:30 — Lernen · Privat");
    expect(
      beschreibeEintrag({
        termine: [
          { titel: "Mathe", start: "2026-10-03T09:00", dauerMin: 90 },
          { titel: "Pause", start: "2026-10-03T10:30", dauerMin: 15 },
        ],
      }),
    ).toBe(
      "Ich möchte in Ihren Kalender eintragen: Sa., 03.10. 09:00–10:30 Mathe; Sa., 03.10. 10:30–10:45 Pause",
    );
  });
});
