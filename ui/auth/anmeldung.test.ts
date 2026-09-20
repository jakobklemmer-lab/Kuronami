import { describe, expect, it } from "vitest";
import { holeLage, melde } from "./anmeldung.js";

/** Die Browserseite der Anmeldung — ohne Browser geprüft, mit einem `fetch` aus der Hand. */

function antwort(status: number, koerper: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => koerper,
  } as unknown as Response;
}

describe("holeLage", () => {
  it("meldet eine eingerichtete Anmeldung samt Benutzer", async () => {
    const lage = await holeLage("http://gw", async () =>
      antwort(200, { anmeldung: true, benutzer: "jakob" }),
    );
    expect(lage).toEqual({ anmeldung: true, benutzer: "jakob" });
  });

  it("meldet keine Anmeldung, wenn der Gateway nicht antwortet", async () => {
    const lage = await holeLage("http://gw", async () => {
      throw new Error("offline");
    });
    expect(lage.anmeldung).toBe(false);
  });

  it("meldet keine Anmeldung bei einer Fehlerantwort", async () => {
    const lage = await holeLage("http://gw", async () => antwort(500, {}));
    expect(lage.anmeldung).toBe(false);
  });
});

describe("melde", () => {
  it("gibt das Ticket zurück", async () => {
    const ergebnis = await melde("http://gw", "jakob", "geheim", async (_url, init) => {
      expect(JSON.parse(String((init as RequestInit).body))).toEqual({
        benutzer: "jakob",
        passwort: "geheim",
      });
      return antwort(200, { token: "v1.abc.def" });
    });
    expect(ergebnis).toEqual({ ok: true, token: "v1.abc.def" });
  });

  it("reicht die Begründung des Gateways durch, statt sie zu glätten", async () => {
    const ergebnis = await melde("http://gw", "a", "b", async () =>
      antwort(401, { error: "Benutzername oder Passwort stimmt nicht." }),
    );
    expect(ergebnis).toEqual({ ok: false, fehler: "Benutzername oder Passwort stimmt nicht." });
  });

  it("reicht die Wartezeit der Bremse mit", async () => {
    const ergebnis = await melde("http://gw", "a", "b", async () =>
      antwort(429, { error: "Zu viele Fehlversuche.", wartenMs: 60_000 }),
    );
    expect(ergebnis).toEqual({ ok: false, fehler: "Zu viele Fehlversuche.", wartenMs: 60_000 });
  });

  it("sagt es, wenn niemand antwortet", async () => {
    const ergebnis = await melde("http://gw", "a", "b", async () => {
      throw new Error("offline");
    });
    expect(ergebnis).toEqual({ ok: false, fehler: "Der Gateway antwortet nicht." });
  });

  it("nimmt eine Antwort ohne Token nicht als Erfolg", async () => {
    const ergebnis = await melde("http://gw", "a", "b", async () => antwort(200, { token: "" }));
    expect(ergebnis.ok).toBe(false);
  });
});
