import { describe, expect, it } from "vitest";
import {
  anmeldungAusUmgebung,
  baueTicket,
  createAnmeldung,
  createBremse,
  hashePasswort,
  pruefePasswort,
  pruefeTicket,
} from "./anmeldung.js";

/**
 * Die Tür der Oberfläche. Geprüft wird beides: dass der richtige Schlüssel aufschließt und
 * dass der falsche es nicht tut — auch der fast richtige, der veränderte und der abgelaufene.
 */

const SCHLUESSEL = "betreiber-token-xyz";

describe("Passwort", () => {
  it("lässt sich hashen und wiedererkennen", () => {
    const hash = hashePasswort("ein sehr geheimes Wort");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(pruefePasswort("ein sehr geheimes Wort", hash)).toBe(true);
  });

  it("erkennt ein falsches Passwort", () => {
    const hash = hashePasswort("richtig");
    expect(pruefePasswort("Richtig", hash)).toBe(false);
    expect(pruefePasswort("", hash)).toBe(false);
  });

  it("bekommt bei zwei Aufrufen zwei verschiedene Hashes (eigenes Salz)", () => {
    expect(hashePasswort("gleich")).not.toBe(hashePasswort("gleich"));
  });

  it("stürzt an einem kaputten Hash nicht ab, sondern sagt Nein", () => {
    expect(pruefePasswort("egal", "")).toBe(false);
    expect(pruefePasswort("egal", "scrypt$nicht$genug$teile")).toBe(false);
    expect(pruefePasswort("egal", "argon2$1$2$3$c2FsdA==$aGFzaA==")).toBe(false);
  });
});

describe("Sitzungsticket", () => {
  it("gibt den Benutzer zurück, solange es gilt", () => {
    const ticket = baueTicket("jakob", SCHLUESSEL, 1000, 60_000);
    expect(pruefeTicket(ticket, SCHLUESSEL, 1000)).toBe("jakob");
    expect(pruefeTicket(ticket, SCHLUESSEL, 60_000)).toBe("jakob");
  });

  it("gilt nach Ablauf nicht mehr", () => {
    const ticket = baueTicket("jakob", SCHLUESSEL, 1000, 60_000);
    expect(pruefeTicket(ticket, SCHLUESSEL, 61_001)).toBeNull();
  });

  it("gilt mit einem anderen Schlüssel nicht — ein Tokenwechsel meldet alle ab", () => {
    const ticket = baueTicket("jakob", SCHLUESSEL, 1000, 60_000);
    expect(pruefeTicket(ticket, "anderer-token", 1000)).toBeNull();
  });

  it("gilt nicht, wenn jemand an der Nutzlast dreht", () => {
    const ticket = baueTicket("jakob", SCHLUESSEL, 1000, 60_000);
    const [version, nutzlast, signatur] = ticket.split(".");
    const gefaelscht = Buffer.from(JSON.stringify({ u: "jemand", exp: 9_999_999_999_999 }))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    expect(pruefeTicket(`${version}.${gefaelscht}.${signatur}`, SCHLUESSEL, 1000)).toBeNull();
    expect(pruefeTicket(`${version}.${nutzlast}.AAAA`, SCHLUESSEL, 1000)).toBeNull();
    expect(pruefeTicket("unsinn", SCHLUESSEL, 1000)).toBeNull();
  });
});

describe("Bremse", () => {
  it("lässt fünf Versuche frei und sperrt danach", () => {
    const bremse = createBremse();
    for (let i = 0; i < 5; i += 1) {
      expect(bremse.gesperrtFuer("1.2.3.4", 0)).toBeNull();
      bremse.merkeFehlschlag("1.2.3.4", 0);
    }
    expect(bremse.gesperrtFuer("1.2.3.4", 0)).toBeNull();
    bremse.merkeFehlschlag("1.2.3.4", 0);
    expect(bremse.gesperrtFuer("1.2.3.4", 0)).toBe(60_000);
  });

  it("verdoppelt die Sperre mit jedem weiteren Fehlversuch", () => {
    const bremse = createBremse();
    for (let i = 0; i < 7; i += 1) bremse.merkeFehlschlag("1.2.3.4", 0);
    expect(bremse.gesperrtFuer("1.2.3.4", 0)).toBe(120_000);
  });

  it("gibt nach Ablauf der Sperre wieder frei", () => {
    const bremse = createBremse();
    for (let i = 0; i < 6; i += 1) bremse.merkeFehlschlag("1.2.3.4", 0);
    expect(bremse.gesperrtFuer("1.2.3.4", 60_001)).toBeNull();
  });

  it("löscht den Zähler nach einer erfolgreichen Anmeldung", () => {
    const bremse = createBremse();
    for (let i = 0; i < 6; i += 1) bremse.merkeFehlschlag("1.2.3.4", 0);
    bremse.merkeErfolg("1.2.3.4");
    expect(bremse.gesperrtFuer("1.2.3.4", 0)).toBeNull();
  });

  it("greift auch, wenn die Versuche von lauter verschiedenen Adressen kommen", () => {
    const bremse = createBremse();
    for (let i = 0; i < 26; i += 1) bremse.merkeFehlschlag(`10.0.0.${i}`, 0);
    // Eine bis dahin unbeteiligte Adresse läuft jetzt ebenfalls in die gemeinsame Sperre.
    expect(bremse.gesperrtFuer("9.9.9.9", 0)).toBe(60_000);
  });
});

describe("createAnmeldung", () => {
  const anmeldung = createAnmeldung({
    benutzer: "jakob",
    hash: hashePasswort("richtig-und-lang"),
    schluessel: SCHLUESSEL,
  });

  it("gibt ein gültiges Ticket bei richtigen Daten", () => {
    const ticket = anmeldung.melde("jakob", "richtig-und-lang");
    expect(ticket).not.toBeNull();
    expect(anmeldung.ticketGilt(ticket as string)).toBe("jakob");
  });

  it("gibt nichts bei falschem Passwort oder falschem Namen", () => {
    expect(anmeldung.melde("jakob", "falsch")).toBeNull();
    expect(anmeldung.melde("jemand", "richtig-und-lang")).toBeNull();
    expect(anmeldung.melde("", "")).toBeNull();
  });

  it("erkennt ein Ticket auf einen anderen Benutzer nicht an", () => {
    const fremd = baueTicket("jemand", SCHLUESSEL);
    expect(anmeldung.ticketGilt(fremd)).toBeNull();
  });

  it("sagt fürs Journal, ob wenigstens der Name stimmte", () => {
    expect(anmeldung.nameGilt("jakob")).toBe(true);
    expect(anmeldung.nameGilt("ggYamiiko")).toBe(false);
    expect(anmeldung.nameGilt("ggYamiik")).toBe(false);
    expect(anmeldung.nameGilt("")).toBe(false);
  });

  it("lehnt einen Namen mit Umlaut ab, statt daran zu zerbrechen", () => {
    // `"größer".length` zählt sechs Zeichen, die UTF-8-Bytes sind sieben: würde nach Zeichen
    // verglichen, bekäme `timingSafeEqual` zwei ungleich lange Puffer und würfe — aus einem
    // falschen Namen würde ein Fehler 500.
    const mitUmlaut = createAnmeldung({
      benutzer: "groesser",
      hash: hashePasswort("richtig-und-lang"),
      schluessel: SCHLUESSEL,
    });
    expect(() => mitUmlaut.nameGilt("größer")).not.toThrow();
    expect(mitUmlaut.nameGilt("größer")).toBe(false);
    expect(mitUmlaut.melde("größer", "richtig-und-lang")).toBeNull();
  });
});

describe("anmeldungAusUmgebung", () => {
  it("gibt null, solange sie nicht eingerichtet ist", () => {
    expect(anmeldungAusUmgebung({}, "token")).toBeNull();
    expect(anmeldungAusUmgebung({ WEB_LOGIN_USER: "a" }, "token")).toBeNull();
    expect(
      anmeldungAusUmgebung({ WEB_LOGIN_USER: "a", WEB_LOGIN_HASH: hashePasswort("x") }, ""),
    ).toBeNull();
  });

  it("baut sie, wenn Benutzer, Hash und Signierschlüssel da sind", () => {
    const anmeldung = anmeldungAusUmgebung(
      { WEB_LOGIN_USER: " jakob ", WEB_LOGIN_HASH: hashePasswort("passwort123") },
      SCHLUESSEL,
    );
    expect(anmeldung?.benutzer).toBe("jakob");
    expect(anmeldung?.melde("jakob", "passwort123")).not.toBeNull();
  });
});
