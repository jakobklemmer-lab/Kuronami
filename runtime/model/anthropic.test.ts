import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { buildModelRequest } from "../../context/request.js";
import { ToolRegistry } from "../../tools/registry.js";
import type { ToolDefinition } from "../../tools/types.js";
import { MissingApiKeyError, createAnthropicClient } from "./anthropic.js";
import { ModelCallError, type ModelContentBlock, type ModelMessage } from "./types.js";

/**
 * Was der Anbieter wirklich zu sehen bekommt.
 *
 * Der Aufruf selbst kostet Geld und braucht Netz, also wird er nicht gefahren — geprüft wird
 * die **Abbildung** darauf: Werkzeugnamen ohne Punkt, Schema mit `strict`, die
 * `cache_control`-Marken an genau den drei Stellen, die `context/request.ts` bestimmt, und
 * die Blöcke einer Antwort unverändert zurück. Das sind die Stellen, an denen eine
 * Integration schiefgeht, und alle liegen diesseits des Netzes.
 *
 * Nicht geprüft, weil es ohne Schlüssel nicht geht: dass die API diese Anfrage annimmt und
 * dass der Cache wirklich greift. Das steht als offener Punkt in progress.md.
 */

type CreateParams = Anthropic.MessageCreateParamsNonStreaming;

function fakeSdk(reply: Partial<Anthropic.Message> = {}) {
  const calls: CreateParams[] = [];
  const sdk = {
    messages: {
      create: async (params: CreateParams) => {
        calls.push(params);
        return {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-opus-5",
          stop_reason: "end_turn",
          stop_sequence: null,
          content: [{ type: "text", text: "fertig" }],
          usage: { input_tokens: 10, output_tokens: 5 },
          ...reply,
        } as Anthropic.Message;
      },
    },
  } as unknown as Pick<Anthropic, "messages">;
  return { sdk, calls };
}

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `Beschreibung von ${name}`,
    risk: "read",
    repeatable: true,
    inputSchema: {
      fields: {
        path: { type: "string", required: true, description: "Ein Pfad." },
        limit: { type: "number", required: false, description: "Eine Grenze." },
      },
    },
    handler: async () => ({ summary: "ok" }),
  };
}

const CATALOG = new ToolRegistry().registerAll([tool("fs.read"), tool("web.fetch")]).freeze();

function request(
  messages: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: "los" }] }],
) {
  return buildModelRequest({
    systemPrompt: "Du bist Kuronami.",
    conventions: "Kein ORM.",
    catalog: CATALOG,
    messages,
    maxTokens: 16_000,
  });
}

describe("Modellanbindung · was beim Anbieter ankommt", () => {
  it("meldet einen fehlenden Schlüssel beim Bauen, nicht beim ersten Zug", () => {
    expect(() => createAnthropicClient({ apiKey: "" })).toThrow(MissingApiKeyError);
  });

  it("schickt Werkzeugnamen ohne Punkt und mit geschlossenem Schema", async () => {
    const { sdk, calls } = fakeSdk();
    await createAnthropicClient({ sdk }).complete(request());

    const tools = calls[0].tools as Anthropic.Tool[];
    expect(tools.map((entry) => entry.name)).toEqual(["fs__read", "web__fetch"]);
    expect(tools[0].input_schema).toMatchObject({
      type: "object",
      required: ["path"],
      additionalProperties: false,
    });
    // `strict` macht aus der Schemaprüfung im Router eine Zusage schon beim Anbieter: ein
    // Zug, der nur an einem fehlenden Feld scheitert, kostet keinen Schritt.
    expect(tools.every((entry) => entry.strict === true)).toBe(true);
  });

  it("setzt die drei Cache-Marken genau dort, wo das Kontext-System sie bestimmt hat", async () => {
    const { sdk, calls } = fakeSdk();
    await createAnthropicClient({ sdk }).complete(request());

    const tools = calls[0].tools as Anthropic.Tool[];
    expect(tools.filter((entry) => entry.cache_control).length).toBe(1);
    expect(tools.at(-1)?.cache_control).toEqual({ type: "ephemeral" });

    const system = calls[0].system as Anthropic.TextBlockParam[];
    expect(system).toHaveLength(2);
    expect(system[0].cache_control).toBeUndefined();
    expect(system[1].cache_control).toEqual({ type: "ephemeral" });
    expect(system[0].text).toContain("Du bist Kuronami.");
  });

  it("lässt Denken an und gibt max_tokens weiter", async () => {
    const { sdk, calls } = fakeSdk();
    await createAnthropicClient({ sdk }).complete(request());

    expect(calls[0].thinking).toEqual({ type: "adaptive" });
    expect(calls[0].max_tokens).toBe(16_000);
    // Ohne ausdrückliche Angabe kein `output_config`: dann gilt die Vorgabe des Anbieters,
    // und es steht nicht ein zweiter Vorgabewert in diesem Projekt daneben.
    expect(calls[0]).not.toHaveProperty("output_config");
  });

  it("reicht die Blöcke einer Antwort unverändert wieder hinein, samt Signatur", async () => {
    const thinking: ModelContentBlock = { type: "thinking", thinking: "", signature: "sig-xyz" };
    const { sdk, calls } = fakeSdk();
    await createAnthropicClient({ sdk }).complete(
      request([
        { role: "user", content: [{ type: "text", text: "los" }] },
        { role: "assistant", content: [thinking] },
      ]),
    );

    // Genau so, wie er aus dem Protokoll kam. Der Anbieter prüft die Signatur beim
    // Zurückreichen — ein neu gebauter Block bräche den Zug.
    expect((calls[0].messages[1].content as unknown[])[0]).toEqual(thinking);
  });

  it("zerlegt eine Antwort in Text, Aufrufe und die rohen Blöcke", async () => {
    const content = [
      { type: "thinking", thinking: "", signature: "s" },
      { type: "text", text: "Ich lese die Datei." },
      { type: "tool_use", id: "call_1", name: "fs__read", input: { path: "a.txt" } },
    ];
    const { sdk } = fakeSdk({
      content: content as unknown as Anthropic.ContentBlock[],
      stop_reason: "tool_use",
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 0,
      } as Anthropic.Usage,
    });

    const response = await createAnthropicClient({ sdk }).complete(request());

    expect(response.stopReason).toBe("tool_use");
    expect(response.text).toBe("Ich lese die Datei.");
    expect(response.toolCalls).toEqual([
      { callId: "call_1", name: "fs__read", input: { path: "a.txt" } },
    ]);
    // Die rohen Blöcke bleiben vollständig — sie gehen so ins `model.responded`.
    expect(response.content).toEqual(content);
    expect(response.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 900,
      cacheCreationTokens: 0,
    });
  });

  it("zählt fehlende Cache-Angaben als null statt sie zu erfinden", async () => {
    const { sdk } = fakeSdk();
    const response = await createAnthropicClient({ sdk }).complete(request());
    expect(response.usage.cacheReadTokens).toBe(0);
    expect(response.usage.cacheCreationTokens).toBe(0);
  });

  it("behält den Wortlaut des Anbieters, wenn der Aufruf scheitert", async () => {
    const sdk = {
      messages: {
        create: async () => {
          throw new Error('400 tool_choice: type "any" is not supported for this model');
        },
      },
    } as unknown as Pick<Anthropic, "messages">;

    // Kein Glätten (AGENTS.md): die Beanstandung des Anbieters ist die einzige Auskunft
    // darüber, was er nicht mochte.
    await expect(createAnthropicClient({ sdk }).complete(request())).rejects.toThrow(
      ModelCallError,
    );
    await expect(createAnthropicClient({ sdk }).complete(request())).rejects.toThrow(/tool_choice/);
  });
});
