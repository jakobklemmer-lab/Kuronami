import { describe, expect, it, vi } from "vitest";
import { createAboGrenzen, leseAbo } from "./abo.js";

/**
 * Die Abo-Grenzen entscheiden, ob Kuro morgen früh noch antwortet. Zwei Dinge müssen stimmen:
 * die Fenster kommen richtig heraus, egal in welcher der beiden Formen das SDK antwortet — und
 * eine Antwort ohne Grenzen wird nicht zu „0 %", sondern zu „nicht verfügbar".
 */

const JETZT = new Date("2026-09-26T20:30:00Z");

describe("leseAbo", () => {
  it("nimmt die geordnete Liste des Anbieters, wenn es sie gibt", () => {
    const stand = leseAbo(
      {
        subscription_type: "pro",
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 99, resets_at: "falsch" },
          limits: [
            {
              kind: "session",
              group: "session",
              percent: 6,
              severity: "normal",
              resets_at: "2026-09-27T01:19:59Z",
            },
            {
              kind: "weekly_all",
              group: "weekly",
              percent: 28,
              severity: "warning",
              resets_at: "2026-10-02T09:59:59Z",
            },
          ],
          seven_day_breakdown: {
            rows: [
              { display_name: "Claude Code", percent: 95 },
              { display_name: "Chats", percent: 5 },
              { display_name: "Cowork", percent: 0 },
            ],
          },
          extra_usage: { is_enabled: false },
        },
      },
      JETZT,
    );
    expect(stand).toEqual({
      verfuegbar: true,
      plan: "pro",
      fenster: [
        {
          id: "sitzung",
          name: "Sitzung",
          prozent: 6,
          zurueck: "2026-09-27T01:19:59Z",
          warnung: false,
        },
        { id: "woche", name: "Woche", prozent: 28, zurueck: "2026-10-02T09:59:59Z", warnung: true },
      ],
      aufteilung: [
        { name: "Claude Code", prozent: 95 },
        { name: "Chats", prozent: 5 },
      ],
      zusatz: false,
      stand: JETZT.toISOString(),
    });
  });

  it("fällt auf die festen Felder zurück, wenn die Liste fehlt", () => {
    const stand = leseAbo(
      {
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 85, resets_at: "2026-09-27T01:00:00Z" },
          seven_day: { utilization: 10, resets_at: null },
          seven_day_sonnet: null,
        },
      },
      JETZT,
    );
    expect(stand.verfuegbar && stand.fenster.map((f) => [f.id, f.prozent, f.warnung])).toEqual([
      ["sitzung", 85, true],
      ["woche", 10, false],
    ]);
  });

  it("sagt ehrlich, wenn es keine Grenzen gibt", () => {
    expect(
      leseAbo({ subscription_type: null, rate_limits_available: false, rate_limits: null }, JETZT),
    ).toMatchObject({ verfuegbar: false, grund: expect.stringContaining("API-Schlüssel") });
  });
});

describe("createAboGrenzen", () => {
  const roh = {
    subscription_type: "pro",
    rate_limits_available: true,
    rate_limits: { five_hour: { utilization: 1, resets_at: null } },
  };

  it("fragt in der Haltbarkeit nur einmal, auch bei gleichzeitigen Fragen", async () => {
    const frage = vi.fn(async () => roh);
    const abo = createAboGrenzen({ cwd: "/tmp", frage });
    await Promise.all([abo.lies(), abo.lies()]);
    await abo.lies();
    expect(frage).toHaveBeenCalledTimes(1);
  });

  it("liefert einen veralteten Stand sofort und frischt dahinter auf", async () => {
    let prozent = 1;
    const frage = vi.fn(async () => ({
      ...roh,
      rate_limits: { five_hour: { utilization: prozent++, resets_at: null } },
    }));
    const abo = createAboGrenzen({ cwd: "/tmp", frage, haltbarMs: 0 });
    const erste = await abo.lies();
    expect(erste.verfuegbar && erste.fenster[0].prozent).toBe(1);
    // Abgelaufen: die Antwort ist der alte Stand, ohne auf den Anbieter zu warten …
    const zweite = await abo.lies();
    expect(zweite.verfuegbar && zweite.fenster[0].prozent).toBe(1);
    expect(frage).toHaveBeenCalledTimes(2);
    // … und die nächste Frage bekommt, was die Auffrischung geholt hat.
    await new Promise((r) => setTimeout(r, 0));
    const dritte = await abo.lies();
    expect(dritte.verfuegbar && dritte.fenster[0].prozent).toBe(2);
  });

  it("hält einen Fehler nicht fest", async () => {
    const frage = vi
      .fn<() => Promise<typeof roh>>()
      .mockRejectedValueOnce(new Error("kein Netz"))
      .mockResolvedValueOnce(roh);
    const abo = createAboGrenzen({ cwd: "/tmp", frage });
    expect(await abo.lies()).toMatchObject({ verfuegbar: false, grund: "kein Netz" });
    expect(await abo.lies()).toMatchObject({ verfuegbar: true });
  });
});
