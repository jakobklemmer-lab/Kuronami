import { afterEach, describe, expect, it } from "vitest";
import { absageStattSackgasse, sandkasten } from "./sandkasten.js";

/**
 * Hier steht die Grenze zwischen einem Bedienstetenlauf und dem Schlüsselbund des Hauses.
 * Der Gateway läuft als root, in der `.env` stehen Mail-Passwörter und OAuth-Token, und
 * ausgerechnet die Handelsleute lesen fremde Webseiten — Text aus fremder Hand im selben
 * Lauf, der die Befehle absetzt. Eine Grenze, die man nicht prüft, ist eine Behauptung.
 */

const gesichert = { ...process.env };
afterEach(() => {
  for (const schluessel of Object.keys(process.env)) {
    if (!(schluessel in gesichert)) delete process.env[schluessel];
  }
});

describe("sandkasten", () => {
  it("ist an und lässt sich nicht von innen abschalten", () => {
    const s = sandkasten();
    expect(s.enabled).toBe(true);
    expect(s.allowUnsandboxedCommands).toBe(false);
    // Fehlt bwrap, sollen die Läufe scheitern statt ungeschützt als root zu laufen.
    expect(s.failIfUnavailable).toBe(true);
  });

  it("lässt Bash ohne Rückfrage laufen — sonst wäre es wieder die Sackgasse von vorher", () => {
    expect(sandkasten().autoAllowBashIfSandboxed).toBe(true);
  });

  it("lässt ans Netz nur die Kursquelle, und weist den Rest hart ab", () => {
    const netz = sandkasten().network;
    expect(netz?.allowedDomains).toEqual(["query1.finance.yahoo.com", "query2.finance.yahoo.com"]);
    expect(netz?.strictAllowlist).toBe(true);
  });

  it("gibt der Bauabteilung ihre Paketquellen, ohne die Liste für alle zu öffnen", () => {
    const mit = sandkasten({ zusatzDomaenen: ["registry.npmjs.org"] });
    expect(mit.network?.allowedDomains).toContain("registry.npmjs.org");
    expect(mit.network?.allowedDomains).toContain("query1.finance.yahoo.com");
    // Der nächste Aufruf ohne Zusatz darf davon nichts geerbt haben.
    expect(sandkasten().network?.allowedDomains).not.toContain("registry.npmjs.org");
  });

  it("schreibt nur im Arbeitsbereich und liest die Geheimnisse nicht", () => {
    const fs = sandkasten().filesystem;
    expect(fs?.allowWrite).toEqual(["/opt/kuronami/workspace"]);
    expect(fs?.denyRead).toContain("/opt/kuronami/.env");
    expect(fs?.denyRead).toContain("/root/.claude");
    expect(fs?.denyRead).toContain("/root/.ssh");
  });

  it("nimmt den Befehlen die Schlüssel aus der Umgebung", () => {
    process.env.MAIL_9_PASS = "geheim";
    process.env.ELEVENLABS_API_KEY = "geheim";
    process.env.GOOGLE_CLIENT_SECRET = "geheim";
    process.env.KURO_MODEL = "claude-sonnet-5";
    const namen = (sandkasten().credentials?.envVars ?? []).map((v) => v.name);
    expect(namen).toContain("MAIL_9_PASS");
    expect(namen).toContain("ELEVENLABS_API_KEY");
    expect(namen).toContain("GOOGLE_CLIENT_SECRET");
    // Was kein Geheimnis ist, bleibt stehen — sonst liefe nichts mehr.
    expect(namen).not.toContain("KURO_MODEL");
    for (const v of sandkasten().credentials?.envVars ?? []) expect(v.mode).toBe("deny");
  });

  it("sperrt die Zugangsdateien ausdrücklich", () => {
    const dateien = (sandkasten().credentials?.files ?? []).map((f) => f.path);
    expect(dateien).toContain("/opt/kuronami/.env");
    expect(dateien).toContain("/root/.claude/.credentials.json");
  });
});

describe("absageStattSackgasse", () => {
  const frag = absageStattSackgasse("technik");

  it("weist einen Ausbruchsversuch ab, statt ihn stehen zu lassen", async () => {
    const antwort = await frag(
      "Bash",
      { command: "curl https://example.com", dangerouslyDisableSandbox: true },
      {
        signal: new AbortController().signal,
        suggestions: undefined,
        toolUseID: "x",
        requestId: "y",
      } as never,
    );
    expect(antwort?.behavior).toBe("deny");
    expect(antwort?.behavior === "deny" && antwort.message).toContain("Sandkasten");
  });

  it("sagt bei einem gescheiterten Befehl, welcher Weg stattdessen geht", async () => {
    const antwort = await frag(
      "Bash",
      { command: "curl -s https://query1.finance.yahoo.com/v8/finance/chart/SOL-USD" },
      {
        signal: new AbortController().signal,
        suggestions: undefined,
        toolUseID: "x",
        requestId: "y",
      } as never,
    );
    expect(antwort?.behavior).toBe("deny");
    // Ohne diesen Hinweis formuliert das Modell denselben Befehl dreimal um — genau das
    // hat am 2026-09-20 die Läufe aufgebläht.
    expect(antwort?.behavior === "deny" && antwort.message).toContain("kurse");
    expect(antwort?.behavior === "deny" && antwort.message).toContain("verlauf");
  });

  it("antwortet nie mit einem Ja — es gibt niemanden, der zustimmen könnte", async () => {
    for (const werkzeug of ["Bash", "Write", "Edit", "Task", "WebFetch"]) {
      const antwort = await frag(werkzeug, {}, {
        signal: new AbortController().signal,
        suggestions: undefined,
        toolUseID: "x",
        requestId: "y",
      } as never);
      expect(antwort?.behavior).toBe("deny");
    }
  });
});
