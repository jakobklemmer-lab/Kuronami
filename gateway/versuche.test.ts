import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Strategie } from "./backtest.js";
import {
  createVersuchsbuch,
  formatiereVersuch,
  regelSchluessel,
  strengeHuerde,
  zAusIntervall,
} from "./versuche.js";

const REGEL: Strategie = {
  name: "Kreuzung",
  richtung: "long",
  einstieg: [
    { links: { art: "kurs" }, vergleich: "kreuzt_ueber", rechts: { art: "sma", periode: 50 } },
  ],
  stopAtr: 2,
  zielR: 2,
};

async function buch() {
  return createVersuchsbuch({ workdir: await mkdtemp(path.join(tmpdir(), "versuche-")) });
}

describe("Versuchsbuch", () => {
  it("zählt dieselbe Regel auf denselben Märkten nur einmal", async () => {
    const b = await buch();
    const schluessel = regelSchluessel(REGEL, ["binance:BTCUSDT"], "1h");
    await b.zaehle({ wer: "t", werkzeug: "backtest", schluessel, name: "a", varianten: 1 });
    const zweimal = await b.zaehle({
      wer: "t",
      werkzeug: "ablage",
      schluessel,
      name: "a",
      varianten: 1,
    });
    expect(zweimal.versuche).toBe(1);
  });

  it("zählt eine andere Periode, einen anderen Markt oder andere Kosten als neuen Versuch", () => {
    const basis = regelSchluessel(REGEL, ["binance:BTCUSDT"], "1h");
    const andere: Strategie = {
      ...REGEL,
      einstieg: [{ ...REGEL.einstieg[0], rechts: { art: "sma", periode: 60 } }],
    };
    expect(regelSchluessel(andere, ["binance:BTCUSDT"], "1h")).not.toBe(basis);
    expect(regelSchluessel(REGEL, ["binance:ETHUSDT"], "1h")).not.toBe(basis);
    expect(regelSchluessel(REGEL, ["binance:BTCUSDT"], "1d")).not.toBe(basis);
    expect(regelSchluessel({ ...REGEL, gebuehrProzent: 0.02 }, ["binance:BTCUSDT"], "1h")).not.toBe(
      basis,
    );
  });

  it("zählt eine umbenannte Regel nicht neu, und die Reihenfolge der Märkte ist egal", () => {
    const basis = regelSchluessel(REGEL, ["a", "b"], "1d");
    expect(regelSchluessel({ ...REGEL, name: "Neuer Name" }, ["b", "a"], "1d")).toBe(basis);
  });

  it("zählt die Varianten einer Nachrechnung, und ein zweiter Lauf nicht doppelt", async () => {
    const b = await buch();
    await b.zaehle({
      wer: "n",
      werkzeug: "nachrechnung",
      schluessel: "n:1",
      name: "x",
      varianten: 155,
    });
    await b.zaehle({
      wer: "n",
      werkzeug: "nachrechnung",
      schluessel: "n:1",
      name: "x",
      varianten: 155,
    });
    const stand = await b.zaehle({
      wer: "t",
      werkzeug: "backtest",
      schluessel: "einzeln",
      name: "y",
      varianten: 1,
    });
    expect(stand.versuche).toBe(156);
    expect(stand.huerde).toBeCloseTo(strengeHuerde(156), 6);
  });

  it("hebt die Hürde mit jedem Versuch", () => {
    expect(strengeHuerde(1)).toBeCloseTo(1.96, 2);
    expect(strengeHuerde(1000)).toBeGreaterThan(strengeHuerde(100));
    expect(strengeHuerde(1000)).toBeGreaterThan(3.9);
  });

  it("schätzt z aus einem Intervall, wenn die Handel fehlen", () => {
    // ±1,96 Standardfehler um 0,2 bei einem Standardfehler von 0,1.
    expect(
      zAusIntervall(0.2, { unten: 0.004, oben: 0.396, anteilNegativ: 0, ziehungen: 1 }),
    ).toBeCloseTo(2, 2);
  });

  it("sagt unter dem Ergebnis, ob es nach allen Versuchen hält", () => {
    const stand = { versuche: 500, seit: "2026-09-28T18:00:00.000Z", huerde: strengeHuerde(500) };
    expect(formatiereVersuch(stand, 5)).toMatch(/\*\*hält\*\* auch nach allen Versuchen/);
    expect(formatiereVersuch(stand, 2.5)).toMatch(/hält \*\*nicht\*\*/);
  });
});
