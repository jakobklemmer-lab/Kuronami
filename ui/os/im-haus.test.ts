import { describe, expect, it } from "vitest";
import {
  FERTIG_STEHT_MS,
  abgleichen,
  beginnt,
  dauer,
  fertig,
  leer,
  raeumeAuf,
  stand,
} from "./im-haus.js";

const boerse = {
  wer: "boerse",
  name: "Börse",
  farbe: "#56d2c2",
  auftrag: "DAX prüfen",
  jetzt: 1000,
};

describe("Im Haus", () => {
  it("führt Stände je Auftrag, ohne Wiederholung, höchstens drei", () => {
    let h = beginnt(leer(), boerse);
    for (const t of ["lädt Kerzen", "lädt Kerzen", "rechnet", "fragt den Strategen", "prüft CRV"]) {
      h = stand(h, "boerse", t);
    }
    expect(h.laeufe[0]?.staende).toEqual(["rechnet", "fragt den Strategen", "prüft CRV"]);
  });

  it("lässt Fertiges kurz stehen und schiebt es dann nach Zuletzt", () => {
    let h = fertig(beginnt(leer(), boerse), "boerse", 5000);
    expect(raeumeAuf(h, 5000 + FERTIG_STEHT_MS - 1).laeufe).toHaveLength(1);
    h = raeumeAuf(h, 5000 + FERTIG_STEHT_MS);
    expect(h.laeufe).toEqual([]);
    expect(h.zuletzt[0]).toMatchObject({ wer: "boerse", fertigUm: 5000 });
  });

  it("übernimmt beim Öffnen, was schon läuft", () => {
    const h = abgleichen(
      leer(),
      new Map([["werkstatt", { seit: 200, stand: "baut", auftrag: "Knopf reparieren" }]]),
      () => ({ name: "Werkstatt", farbe: "#8878ff" }),
    );
    expect(h.laeufe[0]).toMatchObject({ name: "Werkstatt", seit: 200, staende: ["baut"] });
  });

  it("zeigt die Laufzeit wie eine Uhr", () => {
    expect(dauer(7_000)).toBe("0:07");
    expect(dauer(252_000)).toBe("4:12");
    expect(dauer(3_723_000)).toBe("1:02:03");
  });
});
