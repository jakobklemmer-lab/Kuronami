import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { describe, expect, it } from "vitest";
import {
  WissenFehler,
  createWissen,
  pruefeTranskript,
  schluesselGilt,
  wissenRouten,
} from "./wissen.js";

const LISTE = [
  { id: "qmsGqitE2LE", titel: "I Found a Secret To Orderblocks", dauer: 600 },
  { id: "9REzGB3R6HU", titel: "The Only Liquidity Guide You'll EVER NEED", dauer: 1200 },
];

async function ablage() {
  const workdir = await mkdtemp(path.join(tmpdir(), "wissen-"));
  await mkdir(path.join(workdir, "wissen", "tradinglab"), { recursive: true });
  await writeFile(
    path.join(workdir, "wissen", "tradinglab", "inventar.json"),
    JSON.stringify({ videos: LISTE }),
  );
  return createWissen({ workdir });
}

describe("pruefeTranskript", () => {
  it("nimmt den Titel aus der Liste, nicht vom Absender", () => {
    const t = pruefeTranskript(
      {
        id: "qmsGqitE2LE",
        titel: "etwas anderes",
        art: "automatisch",
        segmente: [
          { start: 5.25, text: " second  line " },
          { start: 1, text: "first" },
        ],
      },
      LISTE,
    );
    expect(t.titel).toBe("I Found a Secret To Orderblocks");
    expect(t.segmente).toEqual([
      { start: 1, text: "first" },
      { start: 5.3, text: "second line" },
    ]);
  });

  it("weist Videos ab, die nicht in der Liste stehen — sonst wäre das ein Weg für beliebigen Text", () => {
    expect(() =>
      pruefeTranskript({ id: "AAAAAAAAAAA", art: "manuell", segmente: [] }, LISTE),
    ).toThrow(WissenFehler);
  });

  it("verlangt `ohne`, wenn kein Text kam", () => {
    expect(() =>
      pruefeTranskript({ id: "qmsGqitE2LE", art: "automatisch", segmente: [] }, LISTE),
    ).toThrow(/ohne/);
    expect(pruefeTranskript({ id: "qmsGqitE2LE", art: "ohne", segmente: [] }, LISTE).art).toBe(
      "ohne",
    );
  });
});

describe("createWissen", () => {
  it("führt, was offen ist, und zählt Videos ohne Untertitel getrennt", async () => {
    const w = await ablage();
    expect((await w.offen("tradinglab")).map((v) => v.id)).toEqual(["qmsGqitE2LE", "9REzGB3R6HU"]);
    await w.lege("tradinglab", {
      id: "qmsGqitE2LE",
      art: "manuell",
      segmente: [{ start: 0, text: "hi" }],
    });
    await w.lege("tradinglab", { id: "9REzGB3R6HU", art: "ohne", segmente: [] });
    expect(await w.offen("tradinglab")).toEqual([]);
    expect(await w.stand("tradinglab")).toMatchObject({
      videos: 2,
      transkripte: 1,
      ohneUntertitel: 1,
      offen: 0,
      stunden: 0.5,
    });
  });

  it("legt Notizen ab, liest sie wieder und nimmt nur Video-IDs als Dateinamen", async () => {
    const w = await ablage();
    expect(await w.notiz("tradinglab", "qmsGqitE2LE")).toBeNull();
    await w.legeNotiz("tradinglab", "qmsGqitE2LE", "# Orderblocks\n");
    expect(await w.notiz("tradinglab", "qmsGqitE2LE")).toBe("# Orderblocks\n");
    expect([...(await w.notizen("tradinglab")).keys()]).toEqual(["qmsGqitE2LE"]);
    expect((await w.stand("tradinglab")).durchgearbeitet).toBe(1);
    await expect(w.legeNotiz("tradinglab", "../../x", "…")).rejects.toThrow(WissenFehler);
    await expect(w.notiz("tradinglab", "../inventar")).rejects.toThrow(WissenFehler);
  });

  it("lässt keinen Pfad als Kanal durch", async () => {
    const w = await ablage();
    await expect(w.offen("../../etc")).rejects.toThrow(WissenFehler);
  });
});

describe("schluesselGilt", () => {
  it("gilt nur mit eingerichtetem und gleichem Schlüssel", () => {
    expect(schluesselGilt(undefined, "x")).toBe(false);
    expect(schluesselGilt("abc", null)).toBe(false);
    expect(schluesselGilt("abc", "abd")).toBe(false);
    expect(schluesselGilt("abc", "abc")).toBe(true);
  });
});

describe("wissenRouten für die Oberfläche", () => {
  async function server(angemeldet: boolean) {
    const wissen = await ablage();
    await wissen.legeNotiz("tradinglab", "qmsGqitE2LE", "# Orderblocks\n");
    const app = express();
    wissenRouten(app, {
      wissen,
      lehrgang: { kanal: "tradinglab", stand: async () => ({ dieseNacht: { versuche: 1 } }) },
      schluessel: () => "pc",
      webPrincipal: (_req, res) => {
        if (!angemeldet) res.status(401).json({ error: "Anmeldung nötig." });
        return angemeldet ? { userId: "jakob" } : null;
      },
    });
    const s = app.listen(0);
    const basis = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    return { basis, schliesse: () => s.close() };
  }

  it("zeigt den Stand mit dem des Lehrgangs und liefert eine Notiz zum Lesen", async () => {
    const { basis, schliesse } = await server(true);
    try {
      const stand = await (await fetch(`${basis}/integrations/wissen/tradinglab`)).json();
      expect(stand).toMatchObject({
        videos: 2,
        durchgearbeitet: 1,
        lehrgang: { dieseNacht: { versuche: 1 } },
      });
      const notiz = await (
        await fetch(`${basis}/integrations/wissen/tradinglab/notizen/qmsGqitE2LE`)
      ).json();
      expect(notiz).toEqual({
        id: "qmsGqitE2LE",
        titel: "I Found a Secret To Orderblocks",
        text: "# Orderblocks\n",
      });
      expect(
        (await fetch(`${basis}/integrations/wissen/tradinglab/notizen/9REzGB3R6HU`)).status,
      ).toBe(404);
      expect((await fetch(`${basis}/integrations/wissen/tradinglab/notizen/..%2Fx`)).status).toBe(
        400,
      );
    } finally {
      schliesse();
    }
  });

  it("gibt ohne Anmeldung nichts heraus", async () => {
    const { basis, schliesse } = await server(false);
    try {
      expect(
        (await fetch(`${basis}/integrations/wissen/tradinglab/notizen/qmsGqitE2LE`)).status,
      ).toBe(401);
    } finally {
      schliesse();
    }
  });
});
