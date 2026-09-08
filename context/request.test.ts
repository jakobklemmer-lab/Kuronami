import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../tools/registry.js";
import type { ToolCatalog, ToolDefinition } from "../tools/types.js";
import {
  ToolNameEncodingError,
  buildModelRequest,
  countCacheBreakpoints,
  encodeToolName,
  toolNameDecoder,
  toolSpecs,
} from "./request.js";

/**
 * Der Prompt-Aufbau ohne Datenbank und ohne Anbieter. Geprüft wird, was der Auftrag von S12
 * an dieser Datei festmacht: die Reihenfolge, die ausdrücklich gesetzten Cache-Haltepunkte,
 * der Filter — und die Bedingung, unter der Prompt-Caching überhaupt etwas bringt, nämlich
 * dass zwei Aufrufe mit demselben Inhalt byteweise dasselbe Präfix ergeben.
 */

/** Erfundener Schlüssel in echter Form. Steht so in keinem Konto. */
const FAKE_KEY =
  "sk-ant-api03-Aa0Bb1Cc2Dd3Ee4Ff5Gg6Hh7Ii8Jj9Kk0Ll1Mm2Nn3Oo4Pp5Qq6Rr7Ss8Tt9-TESTONLY";

function tool(name: string, fields: ToolDefinition["inputSchema"]["fields"]): ToolDefinition {
  return {
    name,
    description: `Beschreibung von ${name}`,
    risk: "read",
    repeatable: true,
    inputSchema: { fields },
    handler: async () => ({ summary: "ok" }),
  };
}

function catalogOf(...tools: ToolDefinition[]): ToolCatalog {
  return new ToolRegistry().registerAll(tools).freeze();
}

const CATALOG = catalogOf(
  tool("fs.read", {
    path: { type: "string", required: true, description: "Pfad der Datei." },
    limit: { type: "number", required: false, description: "Höchstzahl Zeilen." },
  }),
  tool("task.set", {
    tasks: { type: "array", required: true, description: "Die Aufgaben." },
  }),
);

function request(overrides: Partial<Parameters<typeof buildModelRequest>[0]> = {}) {
  return buildModelRequest({
    systemPrompt: "Du bist Kuronami.",
    conventions: "Konvention: kein ORM.",
    catalog: CATALOG,
    messages: [
      { role: "user", content: [{ type: "text", text: "erste Eingabe" }] },
      { role: "assistant", content: [{ type: "text", text: "erste Antwort" }] },
    ],
    maxTokens: 16_000,
    ...overrides,
  });
}

describe("Prompt-Aufbau · Toolnamen für die API", () => {
  it("übersetzt den Punkt, den die API in Toolnamen nicht zulässt", () => {
    expect(encodeToolName("fs.read")).toBe("fs__read");
    expect(encodeToolName("web.search")).toBe("web__search");
    expect(encodeToolName("user.ask")).toBe("user__ask");
  });

  it("übersetzt jeden Katalognamen verlustfrei zurück", () => {
    const decode = toolNameDecoder(CATALOG);
    for (const entry of CATALOG.tools) {
      expect(decode(encodeToolName(entry.name))).toBe(entry.name);
    }
  });

  it("weist zwei Tools ab, die denselben API-Namen ergäben", () => {
    // Kann mit der heutigen Namenskonvention nicht auftreten; die Prüfung fällt an dem Tag,
    // an dem ein Namensraum einen Unterstrich bekommt.
    const decode = () =>
      toolNameDecoder({
        version: "v1-test",
        tools: [tool("fs.a__b", {}), tool("fs__a.b", {})],
        get: () => undefined,
        stubs: () => [],
      });
    expect(decode).toThrow(ToolNameEncodingError);
  });
});

describe("Prompt-Aufbau · Cache-Haltepunkte", () => {
  it("setzt genau drei Haltepunkte: hinter Tools, System und Historie", () => {
    const built = request();

    expect(countCacheBreakpoints(built)).toBe(3);
    expect(built.tools.filter((entry) => entry.cache)).toHaveLength(1);
    expect(built.tools.at(-1)?.cache).toBe(true);
    expect(built.system.filter((entry) => entry.cache)).toHaveLength(1);
    expect(built.system.at(-1)?.cache).toBe(true);
    expect(built.messages.filter((entry) => entry.cache)).toHaveLength(1);
    expect(built.messages.at(-1)?.cache).toBe(true);
    // Der vierte bleibt frei. Vier von vier belegt hieße, keinen mehr verschieben zu können.
    expect(countCacheBreakpoints(built)).toBeLessThan(4);
  });

  it("hält die Reihenfolge aus Abschnitt 7 ein: System-Prompt, dann Konventionen", () => {
    const built = request();
    expect(built.system).toHaveLength(2);
    expect(built.system[0].text).toContain("Du bist Kuronami.");
    expect(built.system[1].text).toContain("kein ORM");
  });

  it("ergibt bei gleichem Inhalt byteweise denselben Präfix", () => {
    // Das ist die Bedingung, unter der Prompt-Caching überhaupt greift. Ein Präfix, der sich
    // zwischen zwei Aufrufen um ein Byte unterscheidet, ist kein Präfix mehr.
    const first = request();
    const second = request();
    expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
    expect(JSON.stringify(second.system)).toBe(JSON.stringify(first.system));
  });

  it("sortiert Tools und Schemafelder, damit der Präfix nicht an der Schreibweise hängt", () => {
    const abc = toolSpecs(catalogOf(tool("fs.read", {}), tool("task.set", {})));
    const cba = toolSpecs(catalogOf(tool("task.set", {}), tool("fs.read", {})));
    expect(JSON.stringify(cba)).toBe(JSON.stringify(abc));

    const spec = toolSpecs(CATALOG).find((entry) => entry.name === "fs__read");
    expect(Object.keys(spec?.inputSchema.properties ?? {})).toEqual(["limit", "path"]);
  });
});

describe("Prompt-Aufbau · Schema für den Anbieter", () => {
  it("gibt Pflichtfelder an und schließt unbekannte aus", () => {
    const spec = toolSpecs(CATALOG).find((entry) => entry.name === "fs__read");
    expect(spec?.inputSchema.type).toBe("object");
    expect(spec?.inputSchema.required).toEqual(["path"]);
    // Deckt sich mit `validateToolInput` (S07), das unbekannte Felder abweist. Erst dadurch
    // ist `strict: true` beim Anbieter dieselbe Aussage wie die Prüfung im Router.
    expect(spec?.inputSchema.additionalProperties).toBe(false);
    expect(spec?.inputSchema.properties.path).toEqual({
      type: "string",
      description: "Pfad der Datei.",
    });
  });
});

describe("Prompt-Aufbau · Redaction", () => {
  it("filtert System-Prompt, Konventionen und Tool-Beschreibungen", () => {
    const built = buildModelRequest({
      systemPrompt: `Du bist Kuronami. ANTHROPIC_API_KEY=${FAKE_KEY}`,
      conventions: `Konvention: der Schlüssel lautet ${FAKE_KEY}`,
      catalog: catalogOf({
        ...tool("fs.read", {
          path: { type: "string", required: true, description: `Pfad, Bearer ${FAKE_KEY}` },
        }),
        description: `Liest eine Datei, Token ${FAKE_KEY}`,
      }),
      messages: [{ role: "user", content: [{ type: "text", text: "los" }] }],
      maxTokens: 16_000,
    });

    const serialized = JSON.stringify(built);
    expect(serialized).not.toContain(FAKE_KEY);
    expect(serialized).toContain("[redacted:");
    // Gegenprobe in dieselbe Richtung: das Unverdächtige steht noch da. Ein Filter, der alles
    // ersetzt, bestünde diesen Test auch — und wäre wertlos.
    expect(built.system[0].text).toContain("Du bist Kuronami.");
    expect(built.tools[0].description).toContain("Liest eine Datei");
  });
});
