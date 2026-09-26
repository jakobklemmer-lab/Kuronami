import { describe, expect, it } from "vitest";
import { oberflaecheZiel } from "./oberflaeche.js";

describe("oberflaecheZiel", () => {
  it("bleibt, wo die gewählte Oberfläche schon steht", () => {
    expect(oberflaecheZiel("/", "#/mail", "standard")).toBeNull();
    expect(oberflaecheZiel("/welle/", "#/mail", "modern")).toBeNull();
  });

  it("wechselt samt Hash in die andere", () => {
    expect(oberflaecheZiel("/", "#/mail", "modern")).toBe("/welle/#/mail");
    expect(oberflaecheZiel("/index.html", "", "modern")).toBe("/welle/");
    expect(oberflaecheZiel("/welle/", "#/trading", "standard")).toBe("/#/trading");
    expect(oberflaecheZiel("/welle/index.html", "", "standard")).toBe("/");
  });
});
