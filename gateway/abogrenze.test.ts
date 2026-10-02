import { describe, expect, it } from "vitest";
import { grenzBericht, grenzSatz, istFloskel, istGrenzText, zurueckUm } from "./abogrenze.js";

// 27.09.2026, 15:49 UTC — wie im Verlauf, als die Grenze das erste Mal zuschlug.
const JETZT = new Date("2026-09-27T15:49:00Z");

describe("istGrenzText", () => {
  it("erkennt Sitzungs- und Wochengrenze, auch eingebettet", () => {
    expect(istGrenzText("You've hit your session limit · resets 5:20pm (UTC)")).toBe(true);
    expect(istGrenzText("You've hit your weekly limit · resets 10am (UTC)")).toBe(true);
    expect(
      istGrenzText(
        "boerse konnte den Auftrag nicht ausführen: Claude Code returned an error result: You've hit your session limit · resets 5:20pm (UTC)",
      ),
    ).toBe(true);
  });

  it("lässt normalen Text in Ruhe", () => {
    expect(istGrenzText("Der DAX steht bei 24.310 Punkten.")).toBe(false);
    expect(istGrenzText("You have reached the end.")).toBe(false);
  });
});

describe("istFloskel", () => {
  it("erkennt die beiden SDK-Floskeln, auch mit Leerraum", () => {
    expect(istFloskel("Continue from where you left off.")).toBe(true);
    expect(istFloskel("  No response requested.\n")).toBe(true);
    expect(istFloskel("Continue from where you left off. Und dann?")).toBe(false);
  });
});

describe("zurueckUm", () => {
  it("nimmt resetsAt vor dem Text", () => {
    const t = zurueckUm(
      "You've hit your session limit · resets 5:20pm (UTC)",
      { resetsAt: 1790000000 },
      JETZT,
    );
    expect(t?.toISOString()).toBe(new Date(1790000000 * 1000).toISOString());
  });

  it("liest 5:20pm als 17:20 UTC am selben Tag", () => {
    expect(zurueckUm("resets 5:20pm (UTC)", null, JETZT)?.toISOString()).toBe(
      "2026-09-27T17:20:00.000Z",
    );
  });

  it("nimmt den nächsten Tag, wenn die Uhrzeit schon vorbei ist", () => {
    const spaet = new Date("2026-09-27T23:50:00Z");
    expect(zurueckUm("resets 1am (UTC)", null, spaet)?.toISOString()).toBe(
      "2026-09-28T01:00:00.000Z",
    );
  });

  it("liest auch 24-Stunden-Zeit und 12am/12pm", () => {
    expect(zurueckUm("resets 17:20", null, JETZT)?.toISOString()).toBe("2026-09-27T17:20:00.000Z");
    expect(zurueckUm("resets 12pm", null, new Date("2026-09-27T08:00:00Z"))?.toISOString()).toBe(
      "2026-09-27T12:00:00.000Z",
    );
    expect(zurueckUm("resets 12am", null, JETZT)?.toISOString()).toBe("2026-09-28T00:00:00.000Z");
  });

  it("gibt null, wenn nichts lesbar ist", () => {
    expect(zurueckUm("You've hit your session limit", null, JETZT)).toBeNull();
    expect(zurueckUm("resets 25:00", null, JETZT)).toBeNull();
  });
});

describe("grenzSatz und grenzBericht", () => {
  it("nennt die Wiener Uhrzeit und kein englisches Wort", () => {
    const satz = grenzSatz(new Date("2026-09-27T17:20:00Z"), JETZT);
    expect(satz).toContain("ab 19:20 Uhr");
    expect(satz).not.toMatch(/limit|resets|session|You/i);
  });

  it("nennt das Datum, wenn die Grenze erst an einem anderen Tag fällt", () => {
    expect(grenzSatz(new Date("2026-10-09T10:00:00Z"), JETZT)).toContain("am 09.10. ab 12:00 Uhr");
  });

  it("kommt ohne Zeitpunkt aus", () => {
    expect(grenzSatz(null, JETZT)).toContain("Sobald es wieder frei ist");
  });

  it("meldet einen unterbrochenen Bediensteten auf Deutsch", () => {
    expect(grenzBericht("boerse", new Date("2026-09-27T17:20:00Z"), JETZT)).toBe(
      "boerse wurde vom Abo-Limit unterbrochen, weiter ab 19:20 Uhr.",
    );
    expect(grenzBericht("boerse", null, JETZT)).toBe("boerse wurde vom Abo-Limit unterbrochen.");
  });
});
