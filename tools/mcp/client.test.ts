import { describe, expect, it } from "vitest";
import {
  type JsonRpcRequest,
  type JsonRpcResponse,
  LineJsonDecoder,
  McpProtocolError,
  McpTimeoutError,
  type McpTransport,
  createMcpClientFromTransport,
  createStdioMcpClient,
  encodeMessage,
} from "./client.js";

/**
 * Reine Rahmungstests (kein Prozess, kein echtes Netz) plus ein Ende-zu-Ende-Test gegen einen
 * echten, gespawnten Kindprozess — derselbe Geist wie `policy/policy-resume.process.ts`: ein
 * zweiter echter Prozess ist in diesem Repo ein etabliertes Testmuster, kein Sonderfall.
 */

describe("encodeMessage/LineJsonDecoder", () => {
  it("kodiert eine Anfrage als eine mit \\n abgeschlossene Zeile", () => {
    const line = encodeMessage({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line.trim())).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
  });

  it("liefert nichts, solange keine Zeile vollständig ist", () => {
    const decoder = new LineJsonDecoder();
    expect(decoder.push('{"jsonrpc":"2.0","id":1,"resu')).toEqual([]);
  });

  it("setzt eine über zwei Chunks verteilte Zeile korrekt zusammen", () => {
    const decoder = new LineJsonDecoder();
    expect(decoder.push('{"jsonrpc":"2.0","id":1,"resu')).toEqual([]);
    const out = decoder.push('lt":{"ok":true}}\n');
    expect(out).toEqual([{ jsonrpc: "2.0", id: 1, result: { ok: true } }]);
  });

  it("liefert mehrere vollständige Zeilen aus einem Chunk in Reihenfolge", () => {
    const decoder = new LineJsonDecoder();
    const out = decoder.push(
      '{"jsonrpc":"2.0","id":1,"result":1}\n{"jsonrpc":"2.0","id":2,"result":2}\n',
    );
    expect(out.map((r) => r.id)).toEqual([1, 2]);
  });

  it("wirft McpProtocolError bei einer Zeile, die kein JSON ist", () => {
    const decoder = new LineJsonDecoder();
    expect(() => decoder.push("das ist kein json\n")).toThrow(McpProtocolError);
  });
});

/** Eine In-Memory-Attrappe für `McpTransport`: `send` wird direkt gegen einen Handler
 * ausgewertet, keine echten Ströme. Notifications (ohne `id`) bekommen keine Antwort. */
function fakeTransport(handleRequest: (req: JsonRpcRequest) => unknown | Promise<unknown>) {
  let messageListener: ((response: JsonRpcResponse) => void) | null = null;
  let closeListener: ((error?: Error) => void) | null = null;
  const sent: JsonRpcRequest[] = [];

  const transport: McpTransport = {
    send(line: string): void {
      const message = JSON.parse(line) as JsonRpcRequest;
      sent.push(message);
      if (typeof message.id !== "number") return; // Notification, keine Antwort erwartet.
      // `handleRequest` erst im `.then` aufrufen: ein synchroner Wurf soll wie bei einem
      // echten Server als asynchrone JSON-RPC-Fehlerantwort ankommen, nicht als Wurf mitten
      // in `send()` (das würde die Zusage der Schnittstelle verletzen — `send` liefert nie
      // direkt eine Antwort, das tut immer erst ein späteres `onMessage`).
      Promise.resolve()
        .then(() => handleRequest(message))
        .then(
          (result) => messageListener?.({ jsonrpc: "2.0", id: message.id, result }),
          (error) =>
            messageListener?.({
              jsonrpc: "2.0",
              id: message.id,
              error: {
                code: -32000,
                message: error instanceof Error ? error.message : String(error),
              },
            }),
        );
    },
    onMessage(listener): void {
      messageListener = listener;
    },
    onClose(listener): void {
      closeListener = listener;
    },
    async close(): Promise<void> {
      closeListener?.();
    },
  };
  return { transport, sent };
}

describe("createMcpClientFromTransport", () => {
  it("führt den Handshake vor der ersten Anfrage aus (initialize, dann notifications/initialized)", async () => {
    const { transport, sent } = fakeTransport((req) => {
      if (req.method === "initialize") return { protocolVersion: "2024-11-05" };
      if (req.method === "tools/list") return { tools: [] };
      throw new Error(`unerwartete Methode ${req.method}`);
    });
    const client = createMcpClientFromTransport({ transport });

    await client.listTools();

    const requests = sent.filter((message) => typeof message.id === "number");
    expect(requests[0].method).toBe("initialize");
    expect(requests[1].method).toBe("tools/list");
  });

  it("liefert die von tools/list gemeldeten Tools", async () => {
    const { transport } = fakeTransport((req) => {
      if (req.method === "initialize") return {};
      if (req.method === "tools/list") {
        return {
          tools: [
            {
              name: "read_file",
              description: "Liest eine Datei.",
              inputSchema: { type: "object" },
            },
          ],
        };
      }
      throw new Error("unerwartet");
    });
    const client = createMcpClientFromTransport({ transport });
    const tools = await client.listTools();
    expect(tools).toEqual([
      { name: "read_file", description: "Liest eine Datei.", inputSchema: { type: "object" } },
    ]);
  });

  it("ruft tools/call mit Name und Argumenten auf und liefert den Inhalt", async () => {
    const { transport, sent } = fakeTransport((req) => {
      if (req.method === "initialize") return {};
      if (req.method === "tools/call") {
        return { content: [{ type: "text", text: "42" }] };
      }
      throw new Error("unerwartet");
    });
    const client = createMcpClientFromTransport({ transport });
    const result = await client.callTool({ name: "add", arguments: { a: 1, b: 2 } });
    expect(result).toEqual({ content: [{ type: "text", text: "42" }], isError: false });
    const requests = sent.filter((message) => typeof message.id === "number");
    expect(requests[1].params).toEqual({ name: "add", arguments: { a: 1, b: 2 } });
  });

  it("wirft McpProtocolError, wenn die Antwort ein JSON-RPC-Fehlerobjekt trägt", async () => {
    const { transport } = fakeTransport((req) => {
      if (req.method === "initialize") return {};
      throw new Error("Werkzeug unbekannt");
    });
    const client = createMcpClientFromTransport({ transport });
    await expect(client.callTool({ name: "unknown", arguments: {} })).rejects.toThrow(
      McpProtocolError,
    );
  });

  it("wirft McpTimeoutError, wenn keine Antwort innerhalb des Zeitfensters kommt", async () => {
    const transport: McpTransport = {
      send: () => undefined, // antwortet nie
      onMessage: () => undefined,
      onClose: () => undefined,
      close: async () => undefined,
    };
    const client = createMcpClientFromTransport({ transport, timeoutMs: 20 });
    await expect(client.listTools()).rejects.toThrow(McpTimeoutError);
  });
});

describe("createStdioMcpClient (echter Kindprozess)", () => {
  it("spricht den vollen Handshake plus tools/list und tools/call mit einem echten Prozess", async () => {
    // Ein winziges, inline geschriebenes Skript, das den minimalen MCP-Handshake nachspielt —
    // liest zeilenweise JSON-RPC von stdin, schreibt JSON-RPC-Antworten auf stdout.
    const script = `
      const readline = require("readline");
      const rl = readline.createInterface({ input: process.stdin, terminal: false });
      rl.on("line", (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        if (msg.method === "notifications/initialized") return;
        const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
        if (msg.method === "initialize") return reply({ protocolVersion: "2024-11-05" });
        if (msg.method === "tools/list") return reply({ tools: [{ name: "echo", description: "Gibt den Text zurueck.", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] });
        if (msg.method === "tools/call") return reply({ content: [{ type: "text", text: String(msg.params.arguments.text) }] });
      });
    `;
    const client = createStdioMcpClient({
      command: process.execPath,
      args: ["-e", script],
      timeoutMs: 5000,
    });

    try {
      const tools = await client.listTools();
      expect(tools).toEqual([
        {
          name: "echo",
          description: "Gibt den Text zurueck.",
          inputSchema: { type: "object", properties: { text: { type: "string" } } },
        },
      ]);

      const result = await client.callTool({ name: "echo", arguments: { text: "hallo mcp" } });
      expect(result).toEqual({ content: [{ type: "text", text: "hallo mcp" }], isError: false });
    } finally {
      await client.close();
    }
  }, 10_000);
});
