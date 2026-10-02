import { describe, expect, it } from "vitest";
import type { AgendaEvent, CalendarData, MailMessage } from "../integrations/types.js";
import type { NachtbauStand } from "../views/system.js";
import {
  KALENDER_FEHLT,
  aboSatz,
  aufzaehlung,
  erledigtDieseNacht,
  kalenderSatz,
  nachtbauSatz,
  postSatz,
  vorZeit,
  zahlwort,
} from "./heute.js";

const jetzt = new Date(2026, 9, 3, 11, 0);
const um = (h: number, m = 0) => new Date(2026, 9, 3, h, m).toISOString();

function termin(titel: string, von: string, bis: string, allDay = false): AgendaEvent {
  return {
    id: titel,
    title: titel,
    startsAt: von,
    endsAt: bis,
    location: null,
    allDay,
    account: "Privat",
  };
}
const kalender = (events: AgendaEvent[]): CalendarData => ({
  connected: true,
  reason: null,
  events,
});

describe("zahlwort und aufzaehlung", () => {
  it("schreibt bis zwölf aus, darüber Ziffern", () => {
    expect(zahlwort(1)).toBe("ein");
    expect(zahlwort(1, "einer")).toBe("einer");
    expect(zahlwort(12)).toBe("zwölf");
    expect(zahlwort(20)).toBe("20");
  });

  it("setzt „und“ vor das letzte Glied", () => {
    expect(aufzaehlung(["N19a"])).toBe("N19a");
    expect(aufzaehlung(["N19a", "N19b", "N19c"])).toBe("N19a, N19b und N19c");
  });
});

describe("kalenderSatz", () => {
  it("sagt ohne Zugang, wo das App-Passwort hingehört", () => {
    const k: CalendarData = {
      connected: false,
      reason: "Noch kein Kalender verbunden: KALENDER_USER und KALENDER_PASS fehlen in der .env.",
      events: [],
    };
    expect(kalenderSatz(k, jetzt)).toBe(KALENDER_FEHLT);
  });

  it("gibt einen Fehler von CalDAV weiter, statt ihn zu glätten", () => {
    const k: CalendarData = { connected: false, reason: "HTTP 401", events: [] };
    expect(kalenderSatz(k, jetzt)).toBe("Der Kalender antwortet nicht: HTTP 401");
  });

  it("nennt den nächsten Termin", () => {
    const k = kalender([
      termin("Lernen", um(14), um(16)),
      termin("Sport", um(18), um(19)),
      termin("Frühstück", um(8), um(9)),
    ]);
    expect(kalenderSatz(k, jetzt)).toBe("Drei Termine heute, der nächste um 14:00 — Lernen.");
    expect(kalenderSatz(kalender([termin("Lernen", um(14), um(16))]), jetzt)).toBe(
      "Ein Termin heute, um 14:00 — Lernen.",
    );
  });

  it("sagt, was gerade läuft und was danach kommt", () => {
    const k = kalender([termin("Vorlesung", um(10), um(11, 30)), termin("Lernen", um(14), um(16))]);
    expect(kalenderSatz(k, jetzt)).toBe(
      "Zwei Termine heute: gerade Vorlesung, bis 11:30; danach um 14:00 — Lernen.",
    );
  });

  it("kennt leere, vergangene und ganztägige Tage", () => {
    expect(kalenderSatz(kalender([]), jetzt)).toBe("Heute stehen keine Termine an.");
    expect(kalenderSatz(kalender([termin("Frühstück", um(8), um(9))]), jetzt)).toBe(
      "Ein Termin heute, schon vorbei.",
    );
    expect(
      kalenderSatz(
        kalender([termin("Feiertag", "2026-10-03T00:00:00", "2026-10-04T00:00:00", true)]),
        jetzt,
      ),
    ).toBe("Heute ganztägig: Feiertag.");
  });
});

describe("postSatz", () => {
  const brief = (minutenHer: number, unread: boolean): MailMessage => ({
    id: String(minutenHer),
    konto: "Beispiel",
    from: "Beispiel",
    subject: "Beispiel",
    preview: "",
    receivedAt: new Date(jetzt.getTime() - minutenHer * 60_000).toISOString(),
    unread,
  });
  const post = (briefe: MailMessage[]) => ({
    messages: briefe,
    unreadCount: briefe.filter((b) => b.unread).length,
    konten: ["Beispiel"],
  });

  it("nennt die Ungelesenen unter den abgerufenen Briefen und den jüngsten", () => {
    const briefe = [brief(12, true), brief(40, true), brief(90, false), brief(300, false)];
    expect(postSatz(post(briefe), jetzt)).toBe(
      "Zwei der letzten vier Briefe sind ungelesen, der jüngste kam vor 12 Minuten.",
    );
    expect(postSatz(post([brief(1, true), brief(90, false)]), jetzt)).toBe(
      "Einer der letzten zwei Briefe ist ungelesen, er kam vor einer Minute.",
    );
  });

  it("sagt, wenn alles gelesen ist oder alles ungelesen", () => {
    expect(postSatz(post([brief(5, false), brief(9, false)]), jetzt)).toBe(
      "Die letzten zwei Briefe sind gelesen.",
    );
    expect(postSatz(post([brief(180, true), brief(200, true)]), jetzt)).toBe(
      "Die letzten zwei Briefe sind ungelesen, der jüngste kam vor 3 Stunden.",
    );
    expect(postSatz(post([]), jetzt)).toBe("Im Postfach liegt nichts.");
  });

  it("nennt ältere Briefe mit Tag und Uhrzeit", () => {
    expect(vorZeit(new Date(2026, 9, 2, 18, 20).toISOString(), jetzt)).toBe("gestern um 18:20");
  });
});

describe("nachtbauSatz", () => {
  const stand = (teil: Partial<NachtbauStand>): NachtbauStand => ({
    dienst: "inactive",
    naechsterStart: null,
    aufgaben: [
      { id: "N19a", titel: "Grundgerüst", status: "erledigt (2026-10-03, f8b9abb)" },
      { id: "N19b", titel: "Der Raum Kuro", status: "offen" },
      { id: "N18", titel: "Früher", status: "erledigt (2026-10-02, 1234567)" },
    ],
    protokoll: null,
    bericht: null,
    ...teil,
  });

  it("zählt nur, was in dieser Nacht erledigt wurde", () => {
    expect(erledigtDieseNacht(stand({}), jetzt)).toEqual(["N19a"]);
    expect(nachtbauSatz(stand({}), jetzt)).toBe("Letzte Nacht erledigt: N19a.");
  });

  it("sagt, woran er gerade arbeitet", () => {
    const s = stand({
      dienst: "activating",
      protokoll: {
        datei: "2026-10-03.log",
        zeilen: ["00:57:21 --- N19b mit claude-opus-5-5 beginnt (Sitzung 41 %)"],
      },
    });
    expect(nachtbauSatz(s, jetzt)).toBe(
      "Der Nachtbau arbeitet an N19b — Der Raum Kuro; fertig sind N19a.",
    );
  });

  it("sagt, worauf er wartet, und wann er sonst beginnt", () => {
    const s = stand({
      dienst: "active",
      protokoll: { datei: "x.log", zeilen: ["03:01:00 Sitzung voll — warte bis 03:35"] },
    });
    expect(nachtbauSatz(s, jetzt)).toBe(
      "Der Nachtbau wartet bis 03:35 auf das nächste Sitzungsfenster.",
    );
    const ruhig = stand({
      aufgaben: [],
      naechsterStart: new Date(2026, 9, 4, 0, 30).toISOString(),
    });
    expect(nachtbauSatz(ruhig, jetzt)).toBe("Der Nachtbau ruht; er beginnt morgen um 00:30.");
    expect(nachtbauSatz(stand({ dienst: "failed" }), jetzt)).toContain("abgebrochen");
  });
});

describe("aboSatz", () => {
  it("nennt Sitzung und Woche, und wann die Sitzung neu beginnt", () => {
    const a = aboSatz(
      {
        verfuegbar: true,
        fenster: [
          { id: "sitzung", prozent: 45, zurueck: um(13, 30), warnung: false },
          { id: "woche", prozent: 28.4, zurueck: null, warnung: false },
        ],
      },
      jetzt,
    );
    expect(a.text).toBe(
      "Vom Abo ist die Sitzung zu 45 % (neu um 13:30) und die Woche zu 28 % verbraucht.",
    );
    expect(a.knapp).toBe(false);
  });

  it("wird knapp ab 80 % oder auf Warnung des Anbieters", () => {
    const a = aboSatz(
      {
        verfuegbar: true,
        fenster: [{ id: "sitzung", prozent: 82, zurueck: null, warnung: false }],
      },
      jetzt,
    );
    expect(a).toEqual({ text: "Vom Abo ist die Sitzung zu 82 % verbraucht.", knapp: true });
  });

  it("gibt den Grund weiter, wenn der Stand fehlt", () => {
    expect(aboSatz({ verfuegbar: false, grund: "Zeitüberschreitung" }, jetzt).text).toBe(
      "Der Stand des Abos ist nicht abrufbar: Zeitüberschreitung",
    );
  });
});
