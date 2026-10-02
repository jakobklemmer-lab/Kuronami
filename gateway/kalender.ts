import { randomUUID } from "node:crypto";

/**
 * Jakobs Kalender über CalDAV (2026-10-02) — gedacht für iCloud: Apple-ID und ein
 * App-Passwort (appleid.apple.com › Anmelden und Sicherheit › App-spezifische Passwörter) in der
 * `.env`, dann sieht Kuro die Termine und trägt Zeitblöcke mit Erinnerung ein. Das iPhone meldet
 * sich dann von selbst — das ist die Planungshilfe, die Jakob wollte.
 *
 * Ohne Bibliothek: CalDAV ist WebDAV mit drei Anfragen (Principal → Kalender-Heim → Kalender),
 * und das bisschen iCalendar, das hier gebraucht wird, liest `leseIcs`. Wiederholungen rechnet
 * der Server aus (`<C:expand>`).
 */

export interface KalenderZugang {
  url: string;
  user: string;
  pass: string;
  /** Name des Kalenders, in den Kuro schreibt; sonst der erste, der Termine kann. */
  schreibIn: string | null;
}

export function kalenderZugang(env: NodeJS.ProcessEnv = process.env): KalenderZugang | null {
  const user = env.KALENDER_USER?.trim();
  const pass = env.KALENDER_PASS?.trim();
  if (!user || !pass) return null;
  return {
    url: env.KALENDER_URL?.trim() || "https://caldav.icloud.com/",
    user,
    pass,
    schreibIn: env.KALENDER_SCHREIBEN?.trim() || null,
  };
}

export interface Termin {
  id: string;
  titel: string;
  start: string;
  ende: string;
  ganztags: boolean;
  ort: string | null;
  kalender: string;
}

export interface Kalender {
  name: string;
  href: string;
}

// ----------------------------------------------------------------------- XML

function entities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#13;/g, "\r")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

/** Der Inhalt eines Elements, gleich mit welchem Namensraum-Präfix. */
function element(xml: string, name: string): string | null {
  const m = new RegExp(
    `<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`,
  ).exec(xml);
  return m ? m[1] : null;
}

/** Die `<response>`-Blöcke einer Multistatus-Antwort. */
export function antworten(xml: string): string[] {
  return [
    ...xml.matchAll(/<(?:[\w-]+:)?response(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w-]+:)?response>/g),
  ].map((m) => m[1]);
}

export function hrefIn(xml: string, huelle: string): string | null {
  const block = element(xml, huelle);
  const href = block ? element(block, "href") : null;
  return href ? entities(href.trim()) : null;
}

// ----------------------------------------------------------------- iCalendar

/** Die Zeit in einer Zone als UTC — ohne Bibliothek, über den Versatz, den Intl kennt. */
export function zeitInZone(lokal: string, zone: string): Date {
  const [d, t = "000000"] = lokal.split("T");
  const teile = [
    d.slice(0, 4),
    d.slice(4, 6),
    d.slice(6, 8),
    t.slice(0, 2),
    t.slice(2, 4),
    t.slice(4, 6),
  ].map(Number);
  const alsUtc = Date.UTC(teile[0], teile[1] - 1, teile[2], teile[3], teile[4], teile[5]);
  const versatz = (ms: number) => {
    const f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(ms));
    const w = (typ: string) => Number(f.find((p) => p.type === typ)?.value);
    return Date.UTC(w("year"), w("month") - 1, w("day"), w("hour"), w("minute"), w("second")) - ms;
  };
  // Zweimal: an Umstellungstagen liegt der richtige Versatz erst nach der ersten Korrektur fest.
  let ms = alsUtc - versatz(alsUtc);
  ms = alsUtc - versatz(ms);
  return new Date(ms);
}

/** „2026-10-02T14:00" in Wiener Zeit → Zeitpunkt. */
export function wienerZeit(lokal: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(lokal.trim());
  if (!m) throw new Error(`„${lokal}" ist keine Zeit im Format JJJJ-MM-TTTHH:MM.`);
  return zeitInZone(`${m[1]}${m[2]}${m[3]}T${m[4]}${m[5]}00`, "Europe/Vienna");
}

function zeitwert(
  wert: string,
  params: Record<string, string>,
  zone: string,
): { iso: string; ganztags: boolean } {
  if (params.VALUE === "DATE" || /^\d{8}$/.test(wert)) {
    return { iso: `${wert.slice(0, 4)}-${wert.slice(4, 6)}-${wert.slice(6, 8)}`, ganztags: true };
  }
  if (wert.endsWith("Z")) {
    const z = wert.slice(0, -1);
    const d = new Date(
      Date.UTC(
        +z.slice(0, 4),
        +z.slice(4, 6) - 1,
        +z.slice(6, 8),
        +z.slice(9, 11),
        +z.slice(11, 13),
        +z.slice(13, 15),
      ),
    );
    return { iso: d.toISOString(), ganztags: false };
  }
  return { iso: zeitInZone(wert, params.TZID ?? zone).toISOString(), ganztags: false };
}

function unescapeText(s: string): string {
  return s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
}

/** Die VEVENTs eines iCalendar-Texts. `zone` gilt für Zeiten ohne Zone und ohne `Z`. */
export function leseIcs(ics: string, kalender: string, zone = "Europe/Vienna"): Termin[] {
  const zeilen = ics.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const termine: Termin[] = [];
  let e: Record<string, { wert: string; params: Record<string, string> }> | null = null;
  for (const zeile of zeilen) {
    if (zeile === "BEGIN:VEVENT") {
      e = {};
      continue;
    }
    if (zeile === "END:VEVENT" && e) {
      const start = e.DTSTART ? zeitwert(e.DTSTART.wert, e.DTSTART.params, zone) : null;
      if (start) {
        const ende = e.DTEND
          ? zeitwert(e.DTEND.wert, e.DTEND.params, zone).iso
          : start.ganztags
            ? start.iso
            : start.iso;
        const rid = e["RECURRENCE-ID"]?.wert ?? "";
        termine.push({
          id: `${e.UID?.wert ?? randomUUID()}${rid ? `#${rid}` : ""}`,
          titel: unescapeText(e.SUMMARY?.wert ?? "(ohne Titel)"),
          start: start.iso,
          ende,
          ganztags: start.ganztags,
          ort: e.LOCATION?.wert ? unescapeText(e.LOCATION.wert) : null,
          kalender,
        });
      }
      e = null;
      continue;
    }
    if (!e) continue;
    const doppel = zeile.indexOf(":");
    if (doppel < 0) continue;
    const [name, ...rest] = zeile.slice(0, doppel).split(";");
    const params: Record<string, string> = {};
    for (const p of rest) {
      const [k, v = ""] = p.split("=");
      params[k.toUpperCase()] = v.replace(/^"|"$/g, "");
    }
    // In einem VALARM stehen eigene Felder; die gehören nicht zum Termin.
    if (!(name.toUpperCase() in e))
      e[name.toUpperCase()] = { wert: zeile.slice(doppel + 1), params };
  }
  return termine.sort((a, b) => a.start.localeCompare(b.start));
}

function icsZeit(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

function icsText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/([,;])/g, "\\$1");
}

export interface NeuerTermin {
  titel: string;
  start: Date;
  ende: Date;
  notiz?: string;
  /** Minuten vorher; 0 heißt beim Beginn, `null` keine Erinnerung. */
  erinnerung?: number | null;
}

export function baueIcs(t: NeuerTermin, uid: string, jetzt = new Date()): string {
  const zeilen = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Kuronami//Kuro//DE",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${icsZeit(jetzt)}`,
    `DTSTART:${icsZeit(t.start)}`,
    `DTEND:${icsZeit(t.ende)}`,
    `SUMMARY:${icsText(t.titel)}`,
    ...(t.notiz ? [`DESCRIPTION:${icsText(t.notiz)}`] : []),
    ...(t.erinnerung === null || t.erinnerung === undefined
      ? []
      : [
          "BEGIN:VALARM",
          "ACTION:DISPLAY",
          `DESCRIPTION:${icsText(t.titel)}`,
          `TRIGGER:-PT${Math.max(0, Math.round(t.erinnerung))}M`,
          "END:VALARM",
        ]),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${zeilen.join("\r\n")}\r\n`;
}

// --------------------------------------------------------------------- CalDAV

export interface KalenderDienst {
  kalender(): Promise<Kalender[]>;
  termine(von: Date, bis: Date): Promise<Termin[]>;
  lege(t: NeuerTermin): Promise<{ uid: string; kalender: string }>;
}

export function createKalender(z: KalenderZugang, fetchImpl: typeof fetch = fetch): KalenderDienst {
  const auth = `Basic ${Buffer.from(`${z.user}:${z.pass}`).toString("base64")}`;
  let liste: { stand: number; kalender: Kalender[] } | null = null;

  async function dav(
    url: string,
    methode: string,
    body: string,
    tiefe: "0" | "1",
  ): Promise<string> {
    const r = await fetchImpl(url, {
      method: methode,
      headers: {
        authorization: auth,
        depth: tiefe,
        "content-type": "application/xml; charset=utf-8",
      },
      body,
      redirect: "follow",
    });
    if (r.status === 401)
      throw new Error("Der Kalender lehnt die Anmeldung ab — App-Passwort prüfen.");
    if (!r.ok && r.status !== 207)
      throw new Error(`Kalender antwortet ${r.status} auf ${methode}.`);
    return r.text();
  }

  async function kalender(): Promise<Kalender[]> {
    if (liste && Date.now() - liste.stand < 60 * 60_000) return liste.kalender;
    const basis = z.url;
    const p1 = await dav(
      basis,
      "PROPFIND",
      '<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>',
      "0",
    );
    const principal = hrefIn(p1, "current-user-principal");
    if (!principal) throw new Error("Der Kalender nennt keinen Benutzer (current-user-principal).");
    const p2 = await dav(
      new URL(principal, basis).toString(),
      "PROPFIND",
      '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>',
      "0",
    );
    const heim = hrefIn(p2, "calendar-home-set");
    if (!heim) throw new Error("Der Kalender nennt kein Kalender-Heim (calendar-home-set).");
    const heimUrl = new URL(heim, new URL(principal, basis)).toString();
    const p3 = await dav(
      heimUrl,
      "PROPFIND",
      '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:resourcetype/><d:displayname/><c:supported-calendar-component-set/></d:prop></d:propfind>',
      "1",
    );
    const gefunden: Kalender[] = [];
    for (const a of antworten(p3)) {
      const typ = element(a, "resourcetype") ?? "";
      if (!/calendar/.test(typ)) continue;
      const komponenten = element(a, "supported-calendar-component-set");
      if (komponenten && !/VEVENT/.test(komponenten)) continue;
      const href = element(a, "href");
      if (!href) continue;
      gefunden.push({
        name: entities(element(a, "displayname")?.trim() || "Kalender"),
        href: new URL(entities(href.trim()), heimUrl).toString(),
      });
    }
    liste = { stand: Date.now(), kalender: gefunden };
    return gefunden;
  }

  async function termine(von: Date, bis: Date): Promise<Termin[]> {
    const zeit = `start="${icsZeit(von)}" end="${icsZeit(bis)}"`;
    const anfrage = `<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data><c:expand ${zeit}/></c:calendar-data></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range ${zeit}/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
    const alle = await Promise.all(
      (await kalender()).map(async (k) => {
        const xml = await dav(k.href, "REPORT", anfrage, "1");
        return antworten(xml).flatMap((a) => {
          const daten = element(a, "calendar-data");
          return daten ? leseIcs(entities(daten), k.name) : [];
        });
      }),
    );
    // Was ganz außerhalb liegt (manche Server liefern den ganzen Serientermin), fällt weg.
    const a = von.toISOString();
    const b = bis.toISOString();
    return alle
      .flat()
      .filter((t) => t.ende >= a.slice(0, t.ganztags ? 10 : 24) && t.start < b)
      .sort((x, y) => x.start.localeCompare(y.start));
  }

  async function lege(t: NeuerTermin): Promise<{ uid: string; kalender: string }> {
    const alle = await kalender();
    const ziel =
      (z.schreibIn
        ? alle.find((k) => k.name.toLowerCase() === z.schreibIn?.toLowerCase())
        : null) ?? alle[0];
    if (!ziel) throw new Error("Es gibt keinen Kalender, in den Kuro schreiben kann.");
    const uid = `${randomUUID()}@kuronami`;
    const r = await fetchImpl(
      new URL(`${uid}.ics`, ziel.href.endsWith("/") ? ziel.href : `${ziel.href}/`).toString(),
      {
        method: "PUT",
        headers: {
          authorization: auth,
          "content-type": "text/calendar; charset=utf-8",
          "if-none-match": "*",
        },
        body: baueIcs(t, uid),
      },
    );
    if (!r.ok) throw new Error(`Der Kalender nahm den Termin nicht an (${r.status}).`);
    return { uid, kalender: ziel.name };
  }

  return { kalender, termine, lege };
}

let geteilt: { schluessel: string; dienst: KalenderDienst } | null = null;

/** Ein Dienst für das ganze Haus, solange sich der Zugang nicht ändert — die Suche nach den
 *  Kalendern ist dann eine Stunde lang gemerkt. `null`, wenn kein Zugang in der `.env` steht. */
export function kalenderDienst(env: NodeJS.ProcessEnv = process.env): KalenderDienst | null {
  const z = kalenderZugang(env);
  if (!z) return null;
  const schluessel = [z.url, z.user, z.pass, z.schreibIn].join("|");
  if (geteilt?.schluessel !== schluessel) geteilt = { schluessel, dienst: createKalender(z) };
  return geteilt.dienst;
}
