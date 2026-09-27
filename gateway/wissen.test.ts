import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WissenFehler, createWissen, pruefeTranskript, schluesselGilt } from "./wissen.js";

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
