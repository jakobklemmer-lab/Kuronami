import { describe, expect, it } from "vitest";
import { hashePasswort, pruefePasswort } from "./anmeldung.js";
import { ersetzeHashZeile } from "./passwort-setzen.js";

/**
 * In der `.env` stehen alle Schlüssel des Hauses. Geprüft wird deshalb vor allem, was das
 * Werkzeug **nicht** tut: alles anfassen, was nicht die eine Zeile ist.
 */

const ENV = [
  "# Kopfzeile",
  "ANTHROPIC_API_KEY=sk-test-1234",
  "WEB_LOGIN_USER=jakob",
  "WEB_LOGIN_HASH=scrypt$16384$8$1$altesSalz$alterHash",
  "",
  "# WEB_LOGIN_HASH steht hier nur im Kommentar",
  "VOICE_SESSION_TOKEN=abc",
].join("\n");

describe("ersetzeHashZeile", () => {
  it("tauscht genau die eine Zeile und lässt den Rest stehen", () => {
    const neu = ersetzeHashZeile(ENV, "scrypt$16384$8$1$neuesSalz$neuerHash");
    expect(neu.split("\n")).toEqual([
      "# Kopfzeile",
      "ANTHROPIC_API_KEY=sk-test-1234",
      "WEB_LOGIN_USER=jakob",
      "WEB_LOGIN_HASH=scrypt$16384$8$1$neuesSalz$neuerHash",
      "",
      "# WEB_LOGIN_HASH steht hier nur im Kommentar",
      "VOICE_SESSION_TOKEN=abc",
    ]);
  });

  it("schreibt einen Hash, den die Anmeldung danach wiedererkennt", () => {
    // Der Weg, den `pnpm passwort-setzen` geht: hashen, in die Zeile schreiben, zurücklesen.
    const zeile = ersetzeHashZeile(ENV, "PLATZHALTER")
      .split("\n")
      .find((z) => z.startsWith("WEB_LOGIN_HASH="));
    expect(zeile).toBe("WEB_LOGIN_HASH=PLATZHALTER");
  });

  it("rührt nichts an, wenn die Zeile fehlt", () => {
    expect(() => ersetzeHashZeile("WEB_LOGIN_USER=a\n", "x")).toThrow(/keine Zeile/);
  });

  it("rührt nichts an, wenn die Zeile mehrfach dasteht", () => {
    const doppelt = "WEB_LOGIN_HASH=eins\nWEB_LOGIN_HASH=zwei\n";
    expect(() => ersetzeHashZeile(doppelt, "x")).toThrow(/mehrfach/);
  });
});

describe("der gesetzte Hash", () => {
  it("passt zum eingegebenen Passwort, auch mit Zeichen, die eine Shell verändert hätte", () => {
    // Genau die Falle, wegen der es dieses Werkzeug gibt: `pnpm passwort Pa$$wort!` hätte der
    // Shell gehört, nicht scrypt.
    const klartext = 'Pa$$wort! mit "Anführungszeichen" & $HOME';
    const neu = ersetzeHashZeile(ENV, hashePasswort(klartext));
    const hash = (neu.split("\n").find((z) => z.startsWith("WEB_LOGIN_HASH=")) ?? "").slice(
      "WEB_LOGIN_HASH=".length,
    );
    expect(pruefePasswort(klartext, hash)).toBe(true);
    expect(pruefePasswort("Pawort! mit Anführungszeichen & ", hash)).toBe(false);
  });
});
