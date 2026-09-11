import { describe, expect, it } from "vitest";
import type { EventRecord } from "../runtime/events/log.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ToolCatalog, ToolDefinition } from "../tools/types.js";
import {
  ToolNameEncodingError,
  buildModelRequest,
  countCacheBreakpoints,
  deriveLoadedToolNames,
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

describe("Prompt-Aufbau · Verzögertes Tool-Laden (S18b)", () => {
  const DEFERRED_CATALOG = catalogOf(tool("fs.read", {}), {
    ...tool("mail.search", {}),
    deferred: true,
  });

  it("lässt ein deferred-Tool aus der Werkzeugliste, solange es nicht geladen ist", () => {
    const specs = toolSpecs(DEFERRED_CATALOG);
    expect(specs.map((entry) => entry.name)).toEqual(["fs__read"]);
  });

  it("nimmt ein deferred-Tool in die Werkzeugliste auf, sobald sein Name in loadedTools steht", () => {
    const specs = toolSpecs(DEFERRED_CATALOG, new Set(["mail.search"]));
    expect(specs.map((entry) => entry.name).sort()).toEqual(["fs__read", "mail__search"]);
    // Der letzte Eintrag trägt den Haltepunkt, wer auch immer er ist.
    expect(specs.at(-1)?.cache).toBe(true);
  });

  it("legt Name und Kurzbeschreibung eines noch nicht geladenen Tools neben die Konventionen", () => {
    const built = buildModelRequest({
      systemPrompt: "Du bist Kuronami.",
      conventions: "Konvention: kein ORM.",
      catalog: DEFERRED_CATALOG,
      messages: [{ role: "user", content: [{ type: "text", text: "los" }] }],
      maxTokens: 16_000,
    });
    expect(built.system).toHaveLength(2);
    expect(built.system[1].text).toContain("kein ORM");
    expect(built.system[1].text).toContain("<deferred_tools>");
    expect(built.system[1].text).toContain("mail.search");
    expect(built.system[1].text).toContain("Beschreibung von mail.search");
  });

  it("lässt den <deferred_tools>-Block ganz weg, sobald alles geladen ist", () => {
    const built = buildModelRequest({
      systemPrompt: "Du bist Kuronami.",
      conventions: "Konvention: kein ORM.",
      catalog: DEFERRED_CATALOG,
      messages: [{ role: "user", content: [{ type: "text", text: "los" }] }],
      maxTokens: 16_000,
      loadedTools: new Set(["mail.search"]),
    });
    expect(built.system[1].text).not.toContain("<deferred_tools>");
  });

  it("liest geladene Toolnamen aus einem tool.completed von tool.load zurück", () => {
    const events = [
      {
        eventId: "e1",
        sessionId: "s1",
        seq: 1,
        type: "tool.completed",
        payload: {
          call_id: "c1",
          tool_name: "tool.load",
          result: { status: "ok", summary: "geladen", structured: { loaded: ["mail.search"] } },
        },
        createdAt: new Date(),
      },
      // Ein tool.completed eines anderen Tools trägt keine `loaded`-Liste und wird ignoriert.
      {
        eventId: "e2",
        sessionId: "s1",
        seq: 2,
        type: "tool.completed",
        payload: { call_id: "c2", tool_name: "fs.read", result: { status: "ok" } },
        createdAt: new Date(),
      },
    ] as unknown as EventRecord[];

    expect(deriveLoadedToolNames(events)).toEqual(new Set(["mail.search"]));
  });
});

describe("Prompt-Aufbau · Skills (S18c)", () => {
  const MARKER = "VOLLSTAENDIGER-ANLEITUNGSTEXT-DER-NICHT-IN-DER-KURZLISTE-STEHEN-DARF";

  function skillsCatalog(count: number) {
    const skills = Array.from({ length: count }, (_, index) => {
      const n = index + 1;
      return {
        name: `dummy-${String(n).padStart(2, "0")}`,
        title: `Dummy-Skill ${n}`,
        description: `Testfähigkeit Nummer ${n}.`,
        when: `Wenn Dummy-Skill ${n} gebraucht wird.`,
        path: `dummy-${String(n).padStart(2, "0")}/SKILL.md`,
        // Ein langer Anleitungstext je Skill — steht nur im Katalogobjekt, nicht in der
        // Kurzliste. Der Marker macht das im Test unterscheidbar von Titel/Beschreibung.
        body: `${MARKER} für Skill ${n}. `.repeat(50),
      };
    });
    const byName = new Map(skills.map((skill) => [skill.name, skill]));
    return { root: "/nicht/benutzt", skills, get: (name: string) => byName.get(name) };
  }

  it("legt Titel, Beschreibung und Auslösebedingung jedes Skills neben die Konventionen", () => {
    const built = buildModelRequest({
      systemPrompt: "Du bist Kuronami.",
      conventions: "Konvention: kein ORM.",
      catalog: CATALOG,
      messages: [{ role: "user", content: [{ type: "text", text: "los" }] }],
      maxTokens: 16_000,
      skills: skillsCatalog(10),
    });

    expect(built.system).toHaveLength(2);
    expect(built.system[1].text).toContain("<skills>");
    for (let n = 1; n <= 10; n += 1) {
      const name = `dummy-${String(n).padStart(2, "0")}`;
      expect(built.system[1].text).toContain(`${name}: Testfähigkeit Nummer ${n}.`);
      expect(built.system[1].text).toContain(`wann: Wenn Dummy-Skill ${n} gebraucht wird.`);
    }
  });

  it("hält den Prompt-Präfix klein: die volle Anleitung steht nicht in der Kurzliste", () => {
    const built = buildModelRequest({
      systemPrompt: "Du bist Kuronami.",
      conventions: "Konvention: kein ORM.",
      catalog: CATALOG,
      messages: [{ role: "user", content: [{ type: "text", text: "los" }] }],
      maxTokens: 16_000,
      skills: skillsCatalog(10),
    });

    expect(built.system[1].text).not.toContain(MARKER);

    // Die Kurzliste bleibt klein, egal wie lang die volle Anleitung jedes Skills ist: zehn
    // Skills mit je ~1250 Zeichen Anleitung (50 × 25 Zeichen) ergäben über 12.000 Zeichen volle
    // Anleitung — die Kurzliste bleibt weit darunter.
    expect(built.system[1].text.length).toBeLessThan(3000);
  });

  it("lässt den <skills>-Block ganz weg, wenn kein Katalog übergeben wird", () => {
    const built = buildModelRequest({
      systemPrompt: "Du bist Kuronami.",
      conventions: "Konvention: kein ORM.",
      catalog: CATALOG,
      messages: [{ role: "user", content: [{ type: "text", text: "los" }] }],
      maxTokens: 16_000,
    });
    expect(built.system[1].text).not.toContain("<skills>");
  });

  it("lässt den <skills>-Block ganz weg, wenn der Katalog keine Skills trägt", () => {
    const built = buildModelRequest({
      systemPrompt: "Du bist Kuronami.",
      conventions: "Konvention: kein ORM.",
      catalog: CATALOG,
      messages: [{ role: "user", content: [{ type: "text", text: "los" }] }],
      maxTokens: 16_000,
      skills: skillsCatalog(0),
    });
    expect(built.system[1].text).not.toContain("<skills>");
  });

  it("filtert Titel, Beschreibung und Auslösebedingung durch den Redaction-Filter", () => {
    const catalog = skillsCatalog(1);
    const built = buildModelRequest({
      systemPrompt: "Du bist Kuronami.",
      conventions: "Konvention: kein ORM.",
      catalog: CATALOG,
      messages: [{ role: "user", content: [{ type: "text", text: "los" }] }],
      maxTokens: 16_000,
      skills: {
        ...catalog,
        skills: [
          {
            ...catalog.skills[0],
            description: `Schlüssel ${FAKE_KEY}`,
          },
        ],
      },
    });
    expect(built.system[1].text).not.toContain(FAKE_KEY);
    expect(built.system[1].text).toContain("[redacted:");
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
