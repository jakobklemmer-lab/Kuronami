import { describe, expect, it } from "vitest";
import { type Konto, begrenzeAnzahl, konten, suchKriterium } from "./postfach.js";

const gmail = konten({ MAIL_1_USER: "a@example.com", MAIL_1_PASS: "x" })[0] as Konto;
const andere = konten({
  MAIL_1_USER: "b@example.org",
  MAIL_1_PASS: "x",
  MAIL_1_IMAP: "imap.example.org:993",
})[0] as Konto;

describe("suchKriterium", () => {
  it("sucht bei Gmail mit der Gmail-Syntax", () => {
    expect(suchKriterium(gmail, "from:tradinglab older_than:2y")).toEqual({
      gmraw: "from:tradinglab older_than:2y",
    });
  });

  it("sucht anderswo in Absender oder Betreff", () => {
    expect(suchKriterium(andere, "tradinglab")).toEqual({
      or: [{ from: "tradinglab" }, { subject: "tradinglab" }],
    });
  });
});

describe("begrenzeAnzahl", () => {
  it("hält die Anzahl zwischen 1 und 50", () => {
    expect(begrenzeAnzahl(undefined, 20)).toBe(20);
    expect(begrenzeAnzahl(0, 20)).toBe(1);
    expect(begrenzeAnzahl(500, 20)).toBe(50);
  });
});
