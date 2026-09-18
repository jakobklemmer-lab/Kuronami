import Anthropic from "@anthropic-ai/sdk";
import type { JsonValue } from "../steps/types.js";
import {
  ModelCallError,
  type ModelClient,
  type ModelContentBlock,
  type ModelRequest,
  type ModelResponse,
  type ModelToolCall,
} from "./types.js";

/**
 * Die echte Modellanbindung über die Claude API (Abschnitt 11: Kuronami läuft über die
 * Claude API, nutzungsbasiert abgerechnet).
 *
 * Das offizielle SDK und nicht rohes HTTP. Die Begründung ist dieselbe wie bei `pg` gegen
 * einen selbstgebauten Postgres-Treiber: das Drahtformat der Messages-API ist nichts, was man
 * nebenbei nachbaut — Blocktypen, `cache_control`, Werkzeugaufrufe, Fehlerklassen und deren
 * Wiederholverhalten. "Kein ORM" (Abschnitt 4.2) ist eine Aussage über Abstraktionen, die
 * sich zwischen den Code und sein Datenmodell stellen, keine über Anbieter-Clients.
 *
 * Diese Datei ist die **einzige** Stelle im Projekt, die das SDK kennt. Alles darüber sieht
 * nur `ModelClient` aus `types.ts` — deshalb kostet ein Anbieterwechsel oder ein zweites
 * Modell (Abschnitt 11, Modell-Routing) genau eine neue Datei neben dieser.
 */

/**
 * Vorgabe-Modell für den Orchestrator. Abschnitt 11 ordnet "Planen, mehrstufiges Reasoning,
 * Formulieren" der stärksten Klasse zu, und genau das tut die Schleife aus S12. Über
 * `ANTHROPIC_MODEL` überschreibbar — aber **nicht mitten in einer Session** (Abschnitt 7:
 * Modell nicht mitten in der Session wechseln, stattdessen Subagent starten).
 */
export const DEFAULT_MODEL = "claude-opus-5";

/**
 * Vorgabe für `max_tokens`. Eine Antwort in dieser Schleife ist kurz — etwas Text und ein bis
 * drei Werkzeugaufrufe —, aber der Deckel darf nicht mitten in einem Aufruf zuschlagen: eine
 * abgeschnittene Antwort ist ein verlorener Zug samt seiner Kosten. 16k ist der Wert, bei dem
 * eine nicht gestreamte Anfrage sicher unter dem HTTP-Zeitfenster des SDK bleibt.
 */
export const DEFAULT_MAX_TOKENS = 16_000;

export interface AnthropicClientOptions {
  apiKey?: string;
  model?: string;
  /**
   * `low` bis `max`. Ohne Angabe gilt die Vorgabe der API (`high`). Der Hebel steht hier,
   * weil er der erste ist, an dem man Qualität gegen Kosten tauscht (Abschnitt 11), und
   * nicht, weil er verstellt werden sollte: er gehört in eine Entscheidung, nicht in einen
   * Lauf.
   */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Für Tests, die den SDK-Aufruf abfangen wollen, ohne das Modul zu ersetzen. */
  sdk?: Pick<Anthropic, "messages">;
}

/** Kein Schlüssel gesetzt. Wird beim Bauen gemeldet und nicht erst beim ersten Zug. */
export class MissingApiKeyError extends Error {}

/** `undefined`/`""`/nur Leerraum werden gleich behandelt — eine leere `.env`-Zeile ist "nicht gesetzt". */
function trimmedOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function toApiBlocks(blocks: ModelContentBlock[]): unknown[] {
  // Unverändert durchgereicht. Was aus einer Antwort kam, geht so wieder hinein — inklusive
  // `thinking` samt Signatur, die bei der Fortsetzung eines Werkzeuglaufs stimmen muss.
  return blocks as unknown[];
}

function readUsage(usage: Anthropic.Usage | undefined) {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage?.cache_creation_input_tokens ?? 0,
  };
}

/**
 * Baut den Client. Fabrik statt Modul-Singleton, wie `createPool` (S03),
 * `artifactRootFromEnv` (S06) und `createPolicyEngine` (S11): die Konfiguration bleibt beim
 * Aufrufer.
 */
export function createAnthropicClient(options: AnthropicClientOptions = {}): ModelClient {
  // `??` fiele bei einer leeren `.env`-Zeile (`ANTHROPIC_MODEL=`) nicht durch — process.env
  // liefert dann `""`, nicht `undefined`. Dieselbe Falle wie bei `apiKey` unten, hier über
  // leere Strings statt nur `undefined`/`null` geprüft, damit "Leer = claude-opus-5"
  // (.env.example) tatsächlich stimmt.
  const model =
    trimmedOrUndefined(options.model) ??
    trimmedOrUndefined(process.env.ANTHROPIC_MODEL) ??
    DEFAULT_MODEL;
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  // `ANTHROPIC_EFFORT` (2026-09-16): der Hebel aus der Doku oben, als Betriebsentscheidung in
  // der .env statt im Code. Ungültige Werte fallen auf die API-Vorgabe zurück, nicht auf einen
  // Absturz beim Start.
  const envEffort = trimmedOrUndefined(process.env.ANTHROPIC_EFFORT);
  const effort =
    options.effort ??
    (envEffort === "low" ||
    envEffort === "medium" ||
    envEffort === "high" ||
    envEffort === "xhigh" ||
    envEffort === "max"
      ? envEffort
      : undefined);

  if (!options.sdk && (!apiKey || apiKey.trim() === "")) {
    throw new MissingApiKeyError(
      "ANTHROPIC_API_KEY ist nicht gesetzt. Ohne Schlüssel gibt es keine Modellanbindung; ein Client, der das erst beim ersten Zug meldet, hätte bis dahin eine Session eröffnet und einen Turn begonnen.",
    );
  }

  const sdk = options.sdk ?? new Anthropic({ apiKey });

  return {
    model,

    async complete(request: ModelRequest): Promise<ModelResponse> {
      let message: Anthropic.Message;
      try {
        const params: Anthropic.MessageCreateParamsNonStreaming = {
            model,
            max_tokens: request.maxTokens,
            // Denken bleibt an. Auf dieser Modellklasse ist es die Vorgabe, und es
            // ausdrücklich abzuschalten hat zwei bekannte Fehlbilder — ein Werkzeugaufruf,
            // der als Fließtext statt als `tool_use` erscheint (der Aufruf läuft dann nie,
            // ohne dass irgendwo ein Fehler entsteht), und durchsickernde interne Marken.
            // Beides wäre in einer Schleife über 30 Schritte besonders teuer.
            thinking: { type: "adaptive" },
            ...(effort ? { output_config: { effort } } : {}),
            system: request.system.map((block) => ({
              type: "text" as const,
              text: block.text,
              ...(block.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
            })),
            tools: request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.inputSchema as unknown as Anthropic.Tool.InputSchema,
              // Kein `strict: true` mehr (Fund vom 2026-09-16, erster echter Modellaufruf
              // gegen den vollen Katalog: 23 Tools als strict lehnte die API ab — "The
              // compiled grammar is too large... reduce the number of strict tools". Bis
              // S16 war ANTHROPIC_API_KEY durchgehend leer, dieser Pfad also nie gegen die
              // echte API geprüft. Der Router prüft das Schema ohnehin (S07) — er ist das
              // Tor, nicht der Anbieter; `strict` war nur eine zusätzliche Zusage beim
              // Anbieter selbst, keine, auf die der Router angewiesen ist.
              ...(tool.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
            })),
            messages: request.messages.map((entry) => ({
              role: entry.role,
              content: toApiBlocks(entry.content) as Anthropic.ContentBlockParam[],
            })),
        };
        const requestOptions = request.signal ? { signal: request.signal } : undefined;

        if (request.onTextDelta) {
          // Streaming (2026-09-16): dieselben Parameter, aber die Textstücke gehen sofort an
          // den Aufrufer, statt erst mit dem Ganzen. `finalMessage()` liefert am Ende exakt
          // die Nachricht, die `create` geliefert hätte — der Rest dieser Funktion sieht
          // keinen Unterschied. Ohne Hook bleibt es beim einen Aufruf: die Test-Fakes kennen
          // nur `create`, und ein Streaming, das niemand abnimmt, wäre nur Aufwand.
          const onTextDelta = request.onTextDelta;
          const stream = sdk.messages.stream(params, requestOptions);
          stream.on("text", (delta) => onTextDelta(delta));
          message = await stream.finalMessage();
        } else {
          message = await sdk.messages.create(params, requestOptions);
        }
      } catch (error) {
        // Kein Glätten (AGENTS.md). Der Wortlaut des Anbieters ist die einzige Auskunft
        // darüber, was er beanstandet hat, und genau die braucht der Betreiber.
        throw new ModelCallError(
          `Modellaufruf an "${model}" ist gescheitert: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }

      const content = message.content as unknown as ModelContentBlock[];
      const toolCalls: ModelToolCall[] = [];
      const texts: string[] = [];

      for (const block of message.content) {
        if (block.type === "text") texts.push(block.text);
        if (block.type === "tool_use") {
          toolCalls.push({
            callId: block.id,
            name: block.name,
            input: (block.input ?? {}) as Record<string, JsonValue>,
          });
        }
      }

      return {
        model: message.model,
        stopReason: message.stop_reason ?? "end_turn",
        text: texts.join("\n").trim(),
        toolCalls,
        usage: readUsage(message.usage),
        content,
      };
    },
  };
}
