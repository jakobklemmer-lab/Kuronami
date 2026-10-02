import { describe, expect, it } from "vitest";
import { liesOrt, ortFuerRoute, raumFuerTaste, schreibeOrt } from "./raeume.js";

describe("Räume", () => {
  it("liest Raum und Teil und fällt auf Kuro zurück", () => {
    expect(liesOrt("")).toEqual({ raum: "kuro", teil: null, notiz: null });
    expect(liesOrt("#/handel/analysen")).toEqual({ raum: "handel", teil: "analysen", notiz: null });
    expect(liesOrt("#/quatsch")).toEqual({ raum: "kuro", teil: null, notiz: null });
  });

  it("nimmt ohne Teil den zuletzt gewählten, sonst den ersten", () => {
    expect(liesOrt("#/handel").teil).toBe("maerkte");
    expect(liesOrt("#/studium", { studium: "kalender" }).teil).toBe("kalender");
    expect(liesOrt("#/studium/falsch", { studium: "post" }).teil).toBe("post");
  });

  it("trägt Brain-Notizen mit Umlauten und Leerzeichen hin und zurück", () => {
    const o = {
      raum: "studium" as const,
      teil: "brain" as const,
      notiz: "Gespräche/Studium und Arbeit.md",
    };
    expect(liesOrt(schreibeOrt(o))).toEqual(o);
  });

  it("kennt ⌘1–3 und die Wege der Fachansichten", () => {
    expect(raumFuerTaste("2")).toBe("handel");
    expect(raumFuerTaste("4")).toBeNull();
    expect(ortFuerRoute("mail")).toEqual({ raum: "studium", teil: "post", notiz: null });
    expect(ortFuerRoute("settings")).toBe("blatt-einstellungen");
    expect(ortFuerRoute("files")).toBeNull();
  });
});
