import { describe, expect, it } from "vitest";
import {
  liesGemerkt,
  liesOrt,
  ortFuerRoute,
  raumFuerTaste,
  richtung,
  schreibeOrt,
} from "./raeume.js";

describe("Räume", () => {
  it("liest Raum und Teil und fällt auf Kuro zurück", () => {
    expect(liesOrt("")).toEqual({ raum: "kuro", teil: null, notiz: null });
    expect(liesOrt("#/handel/analysen")).toEqual({ raum: "handel", teil: "analysen", notiz: null });
    expect(liesOrt("#/quatsch")).toEqual({ raum: "kuro", teil: null, notiz: null });
  });

  it("nimmt ohne Teil den zuletzt gewählten, sonst den ersten", () => {
    expect(liesOrt("#/handel").teil).toBe("maerkte");
    expect(liesOrt("#/post", { post: "kalender" }).teil).toBe("kalender");
    expect(liesOrt("#/post/falsch", { post: "post" }).teil).toBe("post");
  });

  it("trägt Brain-Notizen mit Umlauten und Leerzeichen hin und zurück", () => {
    const o = {
      raum: "brain" as const,
      teil: "brain" as const,
      notiz: "Gespräche/Studium und Arbeit.md",
    };
    expect(liesOrt(schreibeOrt(o))).toEqual(o);
  });

  it("kennt ⌘1–5 und die Wege der Fachansichten", () => {
    expect(raumFuerTaste("2")).toBe("handel");
    expect(raumFuerTaste("5")).toBe("studium");
    expect(raumFuerTaste("6")).toBeNull();
    expect(ortFuerRoute("mail")).toEqual({ raum: "post", teil: "post", notiz: null });
    expect(ortFuerRoute("settings")).toBe("blatt-einstellungen");
    expect(ortFuerRoute("files")).toBeNull();
  });

  it("merkt nur Teile, die es im Raum gibt", () => {
    expect(liesGemerkt('{"handel":"analysen","post":"maerkte","fremd":"x"}')).toEqual({
      handel: "analysen",
    });
    expect(liesGemerkt("kaputt")).toEqual({});
    expect(liesGemerkt(null)).toEqual({});
    expect(liesGemerkt("[1,2]")).toEqual({});
  });

  it("gleitet nach der Reihenfolge der Räume und Teile", () => {
    const kuro = liesOrt("#/kuro");
    expect(richtung(kuro, liesOrt("#/post"))).toBe(1);
    expect(richtung(liesOrt("#/studium"), liesOrt("#/handel"))).toBe(-1);
    expect(richtung(liesOrt("#/handel/analysen"), liesOrt("#/handel/maerkte"))).toBe(-1);
    expect(richtung(kuro, kuro)).toBe(0);
  });
});
