import { appendFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type Posten,
  type Verbrauchsbuch,
  ausErgebnis,
  createVerbrauch,
  fasse,
  letzteTage,
  tagVon,
} from "./verbrauch.js";

/**
 * Das Verbrauchsbuch ersetzt die Kostenseite. Was stimmen muss: die Tagesgrenze liegt in Wien
 * und nicht beim Server, und ein Lauf zählt genau einmal — bei Kuro und beim Bediensteten
 * getrennt, denn die Bediensteten laufen in eigenen Sitzungen, deren Token in Kuros
 * Schlussmeldung nicht vorkommen.
 */

function posten(teil: Partial<Posten> & Pick<Posten, "zeit" | "wer">): Posten {
  return {
    modell: "claude-sonnet-5",
    neu: 10,
    cacheGelesen: 1000,
    cacheGeschrieben: 100,
    ausgabe: 50,
    schritte: 1,
    dauerMs: 2000,
    ok: true,
    ...teil,
  };
}

describe("Tage", () => {
  it("rechnet den Tag in Wiener Zeit", () => {
    // 22:30 UTC ist in Wien (Sommerzeit) schon 00:30 des nächsten Tages.
    expect(tagVon(new Date("2026-09-26T22:30:00Z"))).toBe("2026-09-27");
    expect(tagVon(new Date("2026-09-26T21:59:00Z"))).toBe("2026-09-26");
  });

  it("zählt sieben Tage lückenlos, auch über die Zeitumstellung", () => {
    const tage = letzteTage(7, new Date("2026-10-28T10:00:00Z"));
    expect(tage).toEqual([
      "2026-10-22",
      "2026-10-23",
      "2026-10-24",
      "2026-10-25",
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
    ]);
  });
});

describe("ausErgebnis", () => {
  it("nimmt die Token aus der Schlussmeldung und das Modell mit der meisten Ausgabe", () => {
    const r = {
      type: "result",
      subtype: "success",
      num_turns: 3,
      usage: {
        input_tokens: 12,
        cache_read_input_tokens: 15_000,
        cache_creation_input_tokens: 800,
        output_tokens: 420,
      },
      modelUsage: {
        "claude-haiku-4-5": { outputTokens: 20, contextWindow: 200_000 },
        "claude-sonnet-5": { outputTokens: 400, contextWindow: 1_000_000 },
      },
    } as unknown as SDKResultMessage;
    expect(ausErgebnis(r)).toEqual({
      modell: "claude-sonnet-5",
      neu: 12,
      cacheGelesen: 15_000,
      cacheGeschrieben: 800,
      ausgabe: 420,
      schritte: 3,
      ok: true,
      fenster: 1_000_000,
    });
  });

  it("zählt einen gescheiterten Lauf mit, aber als gescheitert", () => {
    const r = {
      type: "result",
      subtype: "error_max_budget_usd",
      num_turns: 12,
      usage: { input_tokens: 1, output_tokens: 2 },
      modelUsage: {},
    } as unknown as SDKResultMessage;
    expect(ausErgebnis(r)).toMatchObject({ modell: "?", ok: false, schritte: 12 });
  });
});

describe("fasse", () => {
  const jetzt = new Date("2026-09-26T18:00:00Z");

  it("trennt heute von der Woche und Kuro vom Personal", () => {
    const u = fasse(
      [
        posten({ zeit: "2026-09-26T08:00:00Z", wer: "kuro", kontext: 40_000 }),
        posten({ zeit: "2026-09-26T09:00:00Z", wer: "kuro", kontext: 42_000 }),
        posten({ zeit: "2026-09-26T09:01:00Z", wer: "boerse", ok: false }),
        posten({ zeit: "2026-09-24T09:00:00Z", wer: "kuro" }),
        // Älter als sieben Tage: steht im Buch, zählt aber in keiner Summe.
        posten({ zeit: "2026-09-10T09:00:00Z", wer: "kuro" }),
      ],
      jetzt,
    );
    expect(u.heute.kuro.laeufe).toBe(2);
    expect(u.woche.kuro.laeufe).toBe(3);
    expect(u.heute.boerse.fehlgeschlagen).toBe(1);
    expect(u.kuro?.kontext).toBe(42_000);
    expect(u.woche.boerse.laeufe).toBe(1);
    expect(u.letzte[0].zeit).toBe("2026-09-26T09:01:00Z");
  });
});

describe("das Buch auf der Platte", () => {
  let buch: Verbrauchsbuch;
  let ordner: string;

  beforeEach(async () => {
    ordner = await mkdtemp(path.join(tmpdir(), "kuro-verbrauch-"));
    buch = createVerbrauch({ workdir: ordner });
  });

  it("ist leer, bevor etwas gebucht wurde", async () => {
    const u = await buch.uebersicht(new Date("2026-09-26T18:00:00Z"));
    expect(u.seit).toBeNull();
    expect(u.letzte).toEqual([]);
  });

  it("findet Gebuchtes wieder und übersteht eine halbe Zeile", async () => {
    await buch.buche(posten({ zeit: "2026-09-26T08:00:00Z", wer: "kuro" }));
    await buch.buche(posten({ zeit: "2026-09-25T08:00:00Z", wer: "recherche" }));
    await appendFile(
      path.join(ordner, "verbrauch", "2026-09-26.jsonl"),
      '{"zeit":"2026-09',
      "utf8",
    );
    const u = await buch.uebersicht(new Date("2026-09-26T18:00:00Z"));
    expect(u.seit).toBe("2026-09-25");
    expect(u.woche.kuro.laeufe).toBe(1);
    expect(u.woche.recherche.laeufe).toBe(1);
  });
});
