import { describe, expect, it } from "vitest";
import { DEV_BLOB, DEV_ECHO } from "./dummies.js";
import { DEFAULT_OFFLOAD_THRESHOLD_TOKENS, estimateTokens } from "./offload.js";
import {
  CATALOG_VERSION_PREFIX,
  DuplicateToolError,
  ToolNameError,
  ToolRegistry,
} from "./registry.js";
import type { ToolDefinition } from "./types.js";

function tool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: "dev.echo",
    description: "Prüf-Tool",
    risk: "read",
    repeatable: true,
    inputSchema: {
      fields: { message: { type: "string", required: true, description: "Text" } },
    },
    handler: async () => ({ summary: "ok" }),
    ...overrides,
  };
}

describe("Tool-Registry · Namen", () => {
  it("nimmt namensraum.aktion an", () => {
    const registry = new ToolRegistry();
    expect(() => registry.register(tool({ name: "fs.read" }))).not.toThrow();
    expect(() => registry.register(tool({ name: "web.fetch" }))).not.toThrow();
    expect(() => registry.register(tool({ name: "mail.draft" }))).not.toThrow();
  });

  it("weist falsche Namensformen und fremde Namensräume ab", () => {
    const registry = new ToolRegistry();
    for (const name of ["Read", "fs", "fs.", ".read", "fs.Read", "fs.read.all", "fs read"]) {
      expect(() => registry.register(tool({ name })), name).toThrow(ToolNameError);
    }
    // Der Namensraum steht in Abschnitt 4.8 und ist keine freie Wahl der Aufrufstelle.
    expect(() => registry.register(tool({ name: "database.query" }))).toThrow(/nicht erlaubt/);
  });

  it("weist ein zweites Tool unter demselben Namen ab", () => {
    const registry = new ToolRegistry().register(tool({ name: "fs.read" }));
    expect(() => registry.register(tool({ name: "fs.read" }))).toThrow(DuplicateToolError);
  });

  it("verlangt eine Beschreibung", () => {
    // Sie ist der Teil des Katalogs, an dem das Modell seine Auswahl trifft.
    expect(() => new ToolRegistry().register(tool({ description: "  " }))).toThrow(ToolNameError);
  });
});

describe("Tool-Registry · Katalogversion", () => {
  it("leitet die Version aus dem Inhalt ab, nicht aus der Registrierreihenfolge", () => {
    const a = new ToolRegistry().register(DEV_ECHO).register(DEV_BLOB).freeze();
    const b = new ToolRegistry().register(DEV_BLOB).register(DEV_ECHO).freeze();

    expect(a.version).toBe(b.version);
    expect(a.version.startsWith(`${CATALOG_VERSION_PREFIX}-`)).toBe(true);
    expect(a.tools.map((entry) => entry.name)).toEqual(["dev.blob", "dev.echo"]);
  });

  it("ändert die Version, sobald sich der Vertrag ändert", () => {
    const base = new ToolRegistry().register(tool()).freeze().version;

    // Alles, wonach das Modell seinen Aufruf baut, zählt.
    expect(new ToolRegistry().register(tool({ description: "anders" })).freeze().version).not.toBe(
      base,
    );
    expect(new ToolRegistry().register(tool({ risk: "hard_write" })).freeze().version).not.toBe(
      base,
    );
    expect(new ToolRegistry().register(tool({ repeatable: false })).freeze().version).not.toBe(
      base,
    );
    expect(
      new ToolRegistry()
        .register(
          tool({
            inputSchema: {
              fields: { message: { type: "string", required: false, description: "Text" } },
            },
          }),
        )
        .freeze().version,
    ).not.toBe(base);

    // Ein weiteres Tool im Katalog ebenfalls.
    expect(new ToolRegistry().register(tool()).register(DEV_BLOB).freeze().version).not.toBe(base);
  });

  it("lässt die Version unberührt, wenn sich nur der Handler ändert", () => {
    // Eine Fehlerbehebung im Rumpf soll keine laufende Session ungültig machen: der Vertrag
    // nach außen ist derselbe geblieben.
    const base = new ToolRegistry().register(tool()).freeze().version;
    const patched = new ToolRegistry()
      .register(tool({ handler: async () => ({ summary: "repariert" }) }))
      .freeze().version;
    expect(patched).toBe(base);
  });

  it("gibt ein Schema mit anderer Feldreihenfolge dieselbe Version", () => {
    const first = new ToolRegistry()
      .register(
        tool({
          inputSchema: {
            fields: {
              alpha: { type: "string", required: true, description: "a" },
              beta: { type: "number", required: false, description: "b" },
            },
          },
        }),
      )
      .freeze().version;
    const second = new ToolRegistry()
      .register(
        tool({
          inputSchema: {
            fields: {
              beta: { type: "number", required: false, description: "b" },
              alpha: { type: "string", required: true, description: "a" },
            },
          },
        }),
      )
      .freeze().version;
    expect(second).toBe(first);
  });
});

describe("Tool-Registry · Einfrieren", () => {
  it("lässt einen ausgegebenen Katalog von späteren Registrierungen unberührt", () => {
    const registry = new ToolRegistry().register(DEV_ECHO);
    const frozen = registry.freeze();

    registry.register(DEV_BLOB);

    expect(frozen.tools.map((entry) => entry.name)).toEqual(["dev.echo"]);
    expect(frozen.get("dev.blob")).toBeUndefined();
    expect(frozen.version).not.toBe(registry.freeze().version);
  });

  it("liefert Stubs für den Prompt-Katalog", () => {
    const stubs = new ToolRegistry().register(DEV_BLOB).register(DEV_ECHO).freeze().stubs();
    expect(stubs.map((entry) => entry.name)).toEqual(["dev.blob", "dev.echo"]);
    expect(stubs[0]).toMatchObject({ risk: "read" });
    expect(stubs[0].description.length).toBeGreaterThan(0);
    // Der Handler gehört nicht in den Prompt.
    expect(Object.keys(stubs[0]).sort()).toEqual(["description", "name", "risk"]);
  });
});

describe("Auslagerungsschwelle", () => {
  it("rechnet Bytes in Token-Äquivalente um", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(50 * 1024))).toBe(12_800);
    // Mehrbyte-Zeichen zählen nach Bytes, nicht nach Zeichen.
    expect(estimateTokens("ä")).toBe(1);
    expect(estimateTokens("ä".repeat(8))).toBe(4);
  });

  it("liegt am unteren Ende der Spanne aus Abschnitt 13", () => {
    expect(DEFAULT_OFFLOAD_THRESHOLD_TOKENS).toBe(8_000);
    // 50 KB liegen darüber, 200 Byte darunter — das Fertig-Kriterium dieser Session.
    expect(estimateTokens("x".repeat(50 * 1024))).toBeGreaterThan(DEFAULT_OFFLOAD_THRESHOLD_TOKENS);
    expect(estimateTokens("x".repeat(200))).toBeLessThan(DEFAULT_OFFLOAD_THRESHOLD_TOKENS);
  });
});
