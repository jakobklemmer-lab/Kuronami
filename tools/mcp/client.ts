/**
 * Ein minimaler MCP-Client über stdio. Kein SDK (dieselbe Disziplin wie bei der
 * Telegram-Bot-API, S16, und der n8n-Brücke, S13): die Runtime kennt nur `pg` und
 * `@anthropic-ai/sdk`, ein MCP-SDK brächte einen eigenen Update-Loop und eine eigene
 * Vorstellung von Sitzung und Zustand mit — genau die Dinge, die dieses System selbst löst.
 *
 * **Rahmung:** MCPs Stdio-Transport ist zeilenweises JSON — ein JSON-RPC-2.0-Objekt pro Zeile,
 * `\n`-getrennt, keine eingebetteten Zeilenumbrüche. Keine LSP-artige `Content-Length`-Rahmung;
 * das ist ein verbreitetes Missverständnis, MCP nutzt sie nicht.
 *
 * **Warum Transport und Client getrennt sind** — dieselbe Überlegung wie `fetchImpl` bei
 * `web.fetch` (S09), der n8n-Brücke (S13) und der Telegram-Bot-API (S16): ein Client, der fest
 * an einem gespawnten Prozess hängt, ist nicht prüfbar. `McpTransport` ist das schmale,
 * austauschbare Stück (senden, empfangen, schließen); Tests setzen ein Paar verbundener
 * `PassThrough`-Ströme ein, ohne einen echten Prozess zu starten. `createStdioMcpClient` baut
 * die echte Fassung obendrauf (spawnt per `node:child_process.spawn`, injizierbar über
 * `spawnImpl` aus demselben Grund).
 */

import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

/** Kein Fernserver konfiguriert; der Client ist nicht bedienbar. */
export class McpUnavailableError extends Error {}
/** Die Gegenseite hat mit einem JSON-RPC-Fehlerobjekt geantwortet, oder die Antwort ist kaputt. */
export class McpProtocolError extends Error {}
/** Das Zeitfenster eines Aufrufs wurde überschritten. */
export class McpTimeoutError extends Error {}
/** `tools/call` kam zurück, aber der Server hat `isError: true` gemeldet. */
export class McpToolCallError extends Error {
  constructor(
    message: string,
    readonly toolName: string,
    readonly content: readonly McpContentBlock[],
  ) {
    super(message);
    this.name = "McpToolCallError";
  }
}

export interface McpContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** Ein Fern-Tool, so wie der Server es beschreibt — bewusst als Rohdaten geführt, nicht
 * vertraut: Name und Beschreibung sind Text von außen (Abschnitt 4.7), das Schema ist
 * JSON-Schema-artig und wird erst in `tools/mcp/tools.ts` auf das winzige lokale
 * `ToolInputSchema` abgebildet. */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface McpToolCallResult {
  content: McpContentBlock[];
  isError?: boolean;
}

export interface McpClient {
  readonly configured: boolean;
  listTools(signal?: AbortSignal): Promise<McpTool[]>;
  callTool(request: {
    name: string;
    arguments: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<McpToolCallResult>;
  close(): Promise<void>;
}

/** Vorgabe-Zeitfenster je Aufruf. Unter dem 60-s-Fenster der Ausführungshülle (S05), analog
 * `N8N_WEBHOOK_TIMEOUT_MS`: ein hängender MCP-Server darf einen Zug nicht unbegrenzt aufhalten. */
export const MCP_CALL_TIMEOUT_MS = 30_000;
/** Protokollversion, mit der `initialize` verhandelt wird. */
export const MCP_PROTOCOL_VERSION = "2024-11-05";

// ---------------------------------------------------------------------------------------------
// Rahmung: JSON-RPC-Zeilen kodieren/dekodieren. Reine Funktionen, ohne Transport — deshalb ohne
// Prozess oder Strom testbar.
// ---------------------------------------------------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Kodiert eine Nachricht als eine einzelne, mit `\n` abgeschlossene JSON-Zeile. */
export function encodeMessage(message: JsonRpcRequest | JsonRpcNotification): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Ein zeilenweiser Dekoder für über die Zeit eintreffende Bytes. Eine JSON-Zeile kann über
 * mehrere `data`-Ereignisse eines Stroms verteilt ankommen (TCP/Pipes garantieren keine
 * Nachrichtengrenzen) — dieser Dekoder puffert bis zum nächsten `\n` und liefert erst dann.
 * Eine kaputte Zeile (kein JSON) wird als `McpProtocolError` gemeldet, nicht stillschweigend
 * übersprungen (AGENTS.md: Fehler nie verstecken).
 */
export class LineJsonDecoder {
  private buffer = "";

  /** Nimmt einen neuen Chunk entgegen, gibt jede vollständige, geparste Zeile zurück. */
  push(chunk: string): JsonRpcResponse[] {
    this.buffer += chunk;
    const out: JsonRpcResponse[] = [];
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        try {
          out.push(JSON.parse(trimmed) as JsonRpcResponse);
        } catch (error) {
          throw new McpProtocolError(
            `MCP-Antwortzeile ist kein gültiges JSON: ${trimmed.slice(0, 200)} (${error instanceof Error ? error.message : String(error)})`,
          );
        }
      }
      index = this.buffer.indexOf("\n");
    }
    return out;
  }
}

/** Das schmale Stück, das der Client tatsächlich benutzt — austauschbar für Tests. */
export interface McpTransport {
  send(line: string): void;
  onMessage(listener: (response: JsonRpcResponse) => void): void;
  onClose(listener: (error?: Error) => void): void;
  close(): Promise<void>;
}

export interface McpClientOptions {
  transport: McpTransport;
  timeoutMs?: number;
  clientInfo?: { name: string; version: string };
}

/**
 * Baut den Client über einen beliebigen `McpTransport`. Führt den Handshake genau einmal beim
 * ersten Aufruf (`initialize` → Antwort → Notification `notifications/initialized`), danach
 * `tools/list`/`tools/call` als normale, über `id` korrelierte Requests.
 */
export function createMcpClientFromTransport(options: McpClientOptions): McpClient {
  const { transport } = options;
  const timeoutMs = options.timeoutMs ?? MCP_CALL_TIMEOUT_MS;
  const clientInfo = options.clientInfo ?? { name: "kuronami", version: "0.1.0" };

  let nextId = 1;
  let initialized: Promise<void> | null = null;
  let closed = false;
  const pending = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (error: Error) => void }
  >();

  transport.onMessage((response) => {
    const waiting = pending.get(response.id);
    if (!waiting) return; // Eine Antwort ohne wartenden Aufrufer wird ignoriert, nicht geworfen.
    pending.delete(response.id);
    if (response.error) {
      waiting.reject(
        new McpProtocolError(`MCP-Fehler ${response.error.code}: ${response.error.message}`),
      );
      return;
    }
    waiting.resolve(response.result);
  });

  transport.onClose((error) => {
    closed = true;
    const failure =
      error ??
      new McpProtocolError("MCP-Transport wurde geschlossen, während Anfragen offen waren.");
    for (const waiting of pending.values()) waiting.reject(failure);
    pending.clear();
  });

  function request(
    method: string,
    params: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (closed) {
      return Promise.reject(new McpUnavailableError(`MCP-Transport ist geschlossen (${method}).`));
    }
    const id = nextId;
    nextId += 1;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new McpTimeoutError(
            `MCP-Aufruf "${method}" hat das Zeitfenster von ${timeoutMs} ms überschritten.`,
          ),
        );
      }, timeoutMs);

      const onAbort = (): void => {
        pending.delete(id);
        clearTimeout(timer);
        reject(new McpProtocolError(`MCP-Aufruf "${method}" wurde abgebrochen.`));
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      });

      transport.send(encodeMessage({ jsonrpc: "2.0", id, method, params }));
    });
  }

  function notify(method: string, params?: Record<string, unknown>): void {
    transport.send(encodeMessage({ jsonrpc: "2.0", method, params }));
  }

  async function ensureInitialized(): Promise<void> {
    if (!initialized) {
      initialized = (async () => {
        await request("initialize", {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo,
        });
        notify("notifications/initialized");
      })();
    }
    return initialized;
  }

  return {
    configured: true,

    async listTools(signal?: AbortSignal): Promise<McpTool[]> {
      await ensureInitialized();
      const result = (await request("tools/list", {}, signal)) as { tools?: unknown };
      if (!result || !Array.isArray(result.tools)) {
        throw new McpProtocolError(
          'MCP-Antwort auf "tools/list" trägt kein Feld "tools" als Liste.',
        );
      }
      return result.tools.map((entry, index) => {
        const tool = entry as Partial<McpTool>;
        if (typeof tool.name !== "string" || tool.name.length === 0) {
          throw new McpProtocolError(`MCP-Tool an Position ${index} hat keinen Namen.`);
        }
        return {
          name: tool.name,
          description: typeof tool.description === "string" ? tool.description : "",
          inputSchema: tool.inputSchema ?? {},
        };
      });
    },

    async callTool(req): Promise<McpToolCallResult> {
      await ensureInitialized();
      const result = (await request(
        "tools/call",
        { name: req.name, arguments: req.arguments },
        req.signal,
      )) as Partial<McpToolCallResult>;
      if (!result || !Array.isArray(result.content)) {
        throw new McpProtocolError(
          `MCP-Antwort auf "tools/call" (${req.name}) trägt kein Feld "content" als Liste.`,
        );
      }
      return { content: result.content as McpContentBlock[], isError: result.isError === true };
    },

    async close(): Promise<void> {
      closed = true;
      await transport.close();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Die echte Fassung: ein gespawnter Prozess als Transport.
// ---------------------------------------------------------------------------------------------

export type SpawnLike = typeof spawn;

export interface StdioMcpClientConfig {
  command: string;
  args?: readonly string[];
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
  clientInfo?: { name: string; version: string };
  /** Vorgabe: `node:child_process.spawn`. Tests injizieren einen Ersatz. */
  spawnImpl?: SpawnLike;
}

function streamTransport(stdin: Writable, stdout: Readable, child: { kill(): void }): McpTransport {
  const decoder = new LineJsonDecoder();
  const messageListeners = new Set<(response: JsonRpcResponse) => void>();
  const closeListeners = new Set<(error?: Error) => void>();
  let closed = false;

  stdout.setEncoding("utf8");
  stdout.on("data", (chunk: string) => {
    let responses: JsonRpcResponse[];
    try {
      responses = decoder.push(chunk);
    } catch (error) {
      for (const listener of closeListeners)
        listener(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    for (const response of responses) {
      for (const listener of messageListeners) listener(response);
    }
  });
  stdout.on("close", () => {
    if (closed) return;
    closed = true;
    for (const listener of closeListeners) listener();
  });
  stdout.on("error", (error) => {
    if (closed) return;
    closed = true;
    for (const listener of closeListeners) listener(error);
  });

  return {
    send(line: string): void {
      stdin.write(line);
    },
    onMessage(listener): void {
      messageListeners.add(listener);
    },
    onClose(listener): void {
      closeListeners.add(listener);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      child.kill();
    },
  };
}

/**
 * Die echte Fassung: spawnt den MCP-Server als Kindprozess und spricht über dessen
 * stdin/stdout. `configured` ist immer `true` — anders als bei Telegram/n8n gibt es kein
 * "Basis-URL fehlt"-Szenario, ein Server ist entweder konfiguriert (Kommando bekannt) oder
 * wird gar nicht erst gebaut.
 */
export function createStdioMcpClient(config: StdioMcpClientConfig): McpClient {
  const doSpawn = config.spawnImpl ?? spawn;
  let child: ChildProcessByStdio<Writable, Readable, null> | null = null;
  let inner: McpClient | null = null;

  function ensureSpawned(): McpClient {
    if (inner) return inner;
    const proc = doSpawn(config.command, [...(config.args ?? [])], {
      cwd: config.cwd,
      env: { ...process.env, ...(config.env ?? {}) },
      stdio: ["pipe", "pipe", "inherit"],
    }) as ChildProcessByStdio<Writable, Readable, null>;
    child = proc;
    const transport = streamTransport(proc.stdin, proc.stdout, { kill: () => proc.kill() });
    inner = createMcpClientFromTransport({
      transport,
      timeoutMs: config.timeoutMs,
      clientInfo: config.clientInfo,
    });
    return inner;
  }

  return {
    configured: true,
    async listTools(signal?: AbortSignal): Promise<McpTool[]> {
      return ensureSpawned().listTools(signal);
    },
    async callTool(req): Promise<McpToolCallResult> {
      return ensureSpawned().callTool(req);
    },
    async close(): Promise<void> {
      await inner?.close();
      child?.kill();
    },
  };
}
