import { describe, expect, it } from "vitest";
import { loeseModulPfad, statischeImporte, versioniere } from "./serve.js";

describe("versioniere", () => {
  it("hängt relativen Modul-Angaben den Stand an, sonst nichts", () => {
    const code = [
      'import { a } from "./a.js";',
      "export { b } from '../b.js';",
      'import "./seite.js";',
      'const c = await import("./c.mjs");',
      'const text = "./kein-import.js";',
      'import x from "https://cdn.example/x.js";',
    ].join("\n");
    expect(versioniere(code, "s1")).toBe(
      [
        'import { a } from "./a.js?v=s1";',
        "export { b } from '../b.js?v=s1';",
        'import "./seite.js?v=s1";',
        'const c = await import("./c.mjs?v=s1");',
        'const text = "./kein-import.js";',
        'import x from "https://cdn.example/x.js";',
      ].join("\n"),
    );
  });
});

describe("statischeImporte", () => {
  it("findet statische Importe, nicht dynamische", () => {
    expect(
      statischeImporte(
        'import a from "./a.js";\nexport * from "../b.js";\nawait import("./c.js");',
      ),
    ).toEqual(["./a.js", "../b.js"]);
    expect(statischeImporte('import a from "./a.js?v=s1";')).toEqual(["./a.js"]);
  });
});

describe("loeseModulPfad", () => {
  it("löst wie der Browser auf", () => {
    expect(loeseModulPfad("/os/start.js", "../views/html.js")).toBe("/views/html.js");
    expect(loeseModulPfad("/os/start.js", "./os.js")).toBe("/os/os.js");
  });
});
