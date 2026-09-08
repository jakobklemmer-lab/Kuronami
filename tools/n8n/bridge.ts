import type { JsonValue } from "../../runtime/steps/types.js";

/**
 * Die n8n-Brücke: der eine Weg, auf dem die Runtime einen n8n-Workflow anstößt.
 *
 * n8n ist **Tool-Schicht, nicht Loop** (Abschnitt "Assistenz-Tools über n8n"). Ein Workflow
 * ist eine Integration mit einem HTTP-Eingang; er hält keine Session, kein Protokoll, keine
 * Policy. All das bleibt in der Runtime. Diese Datei kennt genau eine Operation: einen
 * Webhook aufrufen, die Antwort als JSON zurückgeben oder mit einem benannten Fehler
 * scheitern. Die Übersetzung in die einheitliche Rückgabehülle steht eine Ebene höher
 * (`workflows.ts` baut den Handler, der Router macht die Hülle und lagert Großes aus).
 *
 * **Warum injiziert statt importiert** — dieselbe Überlegung wie bei `fetchImpl` in
 * `web.fetch` (S09) und `ModelClient` im Loop (S12): eine Brücke, die fest an einem
 * HTTP-Aufruf hängt, ist nicht prüfbar. Der Test stellt ein `fetchImpl`, das einen
 * n8n-Webhook nachbildet.
 *
 * **Timeout und Retry liegen hier, nicht (nur) in n8n** (Auftrag S13):
 *
 *   * **Timeout** je Aufruf, Vorgabe 30 s — deutlich unter dem 60-s-Fenster der
 *     Ausführungshülle (S05), damit ein hängender Workflow als sauberer Tool-Fehler endet
 *     und nicht als "unbekannter Ausgang" der Hülle. Gleiches Muster wie
 *     `WEB_FETCH_TIMEOUT_MS`.
 *   * **Retry mit Backoff** bei vorübergehenden Fehlern (Netzfehler ohne Antwort, HTTP 429,
 *     502, 503, 504) — **nur wenn der Workflow `repeatable` ist**. Ein nicht wiederholbarer
 *     Workflow bekommt genau einen Versuch; ob ein zweiter Anlauf sicher wäre, weiß nur der,
 *     der den Workflow schreibt, nicht die Brücke (dieselbe Haltung wie in der
 *     Ausführungshülle: "nicht wiederholbar heißt nicht wiederholbar").
 *   * **Kein Retry** bei 4xx außer 429 (deterministisch: falsche Eingabe, Workflow fehlt),
 *     beim Brücken-Timeout und bei Abbruch von außen (beides heißt "aufhören", nicht
 *     "nochmal").
 *
 * At-least-once bleibt die Zusage: ein 502/503/504 *kann* bedeuten, dass der Workflow lief
 * und nur die Antwort verlorenging. Der Retry setzt darauf, dass ein `repeatable`-Workflow
 * das aushält — genau die Verabredung, die der Autor mit dem Flag eingeht.
 */

/** Es ist keine Basis-URL für n8n konfiguriert; die Brücke ist nicht bedienbar. */
export class N8nUnavailableError extends Error {}
/** Das Zeitfenster der Brücke wurde überschritten, bevor die Antwort da war. */
export class N8nWebhookTimeoutError extends Error {}
/** Der Aufruf wurde von außen abgebrochen (Session-Abbruch, Prozess-Signal). */
export class N8nWebhookAbortedError extends Error {}
/** Die Antwort ist größer als erlaubt; das Lesen wurde abgebrochen. */
export class N8nResponseTooLargeError extends Error {}
/** Der Workflow hat mit einem HTTP-Fehler geantwortet (nach allen erlaubten Versuchen). */
export class N8nWorkflowHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly attempts: number,
    /** Der Antwortkörper, soweit lesbar — hilft beim Einordnen des Fehlers. */
    readonly body: string,
  ) {
    super(message);
  }
}
/** Die Antwort war kein JSON. Die Brücke reicht nur JSON weiter. */
export class N8nResponseFormatError extends Error {}

/** Vorgabe-Zeitfenster für einen Webhook-Aufruf. Unter dem 60-s-Fenster der Hülle (S05). */
export const N8N_WEBHOOK_TIMEOUT_MS = 30_000;
/** Vorgabe: ein erster Versuch plus zwei Wiederholungen (nur bei `repeatable`). */
export const N8N_MAX_ATTEMPTS = 3;
/** Grundwert des exponentiellen Backoffs; Versuch n wartet `base * 2^(n-1)` plus Jitter. */
export const N8N_BACKOFF_BASE_MS = 250;
/** Harte Obergrenze für den Antwortkörper. Größere Antworten werden abgebrochen. */
export const N8N_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/** HTTP-Status, bei denen ein erneuter Anlauf sinnvoll ist (der Workflow lief vermutlich nicht). */
const RETRYABLE_STATUS: ReadonlySet<number> = new Set([429, 502, 503, 504]);

export type FetchLike = typeof globalThis.fetch;

export interface N8nBridgeConfig {
  /**
   * Wurzel der n8n-Instanz, z. B. `http://n8n:5678` im Compose-Netz oder
   * `http://localhost:5678` lokal. Fehlt sie, meldet jeder Aufruf `N8nUnavailableError` —
   * dieselbe Haltung wie bei einem fehlenden Suchanbieter in `web.search` (S09).
   */
  baseUrl?: string;
  /**
   * Gemeinsames Geheimnis, das als `x-kuronami-token`-Header mitgeht. Optional: im
   * abgeschotteten Compose-Netz trägt die Netzgrenze die Kontrolle. In einer Umgebung, in
   * der n8n weiter erreichbar ist, setzt man ihn und schaltet am Webhook-Knoten "Header
   * Auth" scharf.
   */
  token?: string;
  /** Vorgabe: globales `fetch`. Tests stellen einen Ersatz. */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  maxResponseBytes?: number;
}

export interface N8nInvokeRequest {
  /** Der `path` des Webhook-Knotens im Workflow. Ergibt `${baseUrl}/webhook/${webhookPath}`. */
  webhookPath: string;
  /** Wird als JSON-Körper gesendet. */
  input: Record<string, JsonValue>;
  /** Steuert, ob die Brücke einen vorübergehenden Fehler erneut versucht. */
  repeatable: boolean;
  /** Bricht bei Session-Abbruch und Prozess-Signal (S05). */
  signal: AbortSignal;
}

export interface N8nInvocation {
  status: number;
  /** Der geparste Antwortkörper. Immer JSON (sonst `N8nResponseFormatError`). */
  body: JsonValue;
  /** Wie viele HTTP-Versuche es gebraucht hat (1 = beim ersten Mal). */
  attempts: number;
  durationMs: number;
}

export interface N8nBridge {
  readonly configured: boolean;
  readonly baseUrl: string | null;
  invoke(request: N8nInvokeRequest): Promise<N8nInvocation>;
}

/** Ein Abbruch-artiger Fehler von `fetch` (Timeout-Controller oder äußeres Signal). */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/**
 * Liest den Antwortkörper und bricht ab, sobald `maxBytes` überschritten ist — ohne den Rest
 * zu laden. Muster aus `readBodyCapped` in `web/tools.ts` (S09).
 */
async function readCappedText(
  res: Response,
  maxBytes: number,
  controller: AbortController,
): Promise<string> {
  const body = res.body;
  if (!body) {
    const text = await res.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw tooLarge(maxBytes);
    return text;
  }
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        controller.abort();
        throw tooLarge(maxBytes);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function tooLarge(maxBytes: number): N8nResponseTooLargeError {
  return new N8nResponseTooLargeError(
    `n8n-Antwort überschreitet die Größenbegrenzung von ${maxBytes} Bytes. Das Lesen wurde abgebrochen.`,
  );
}

function joinUrl(baseUrl: string, webhookPath: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const path = webhookPath.replace(/^\/+/, "");
  return `${base}/webhook/${path}`;
}

/** Wartet `ms` und bricht sofort ab, wenn das Signal währenddessen feuert. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new N8nWebhookAbortedError("Aufruf während des Backoffs abgebrochen"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new N8nWebhookAbortedError("Aufruf während des Backoffs abgebrochen"));
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

interface AttemptResult {
  kind: "ok" | "http" | "transient";
  status: number;
  text: string;
  /** Nur bei `kind: "transient"`: der zugrunde liegende Netzfehler, falls einer vorlag. */
  cause?: unknown;
}

/**
 * Ein einzelner HTTP-Versuch mit eigenem Zeitfenster. Wirft `N8nWebhookTimeoutError` /
 * `N8nWebhookAbortedError` / `N8nResponseTooLargeError` direkt (kein Retry), gibt für alles
 * andere ein `AttemptResult` zurück, über das die Schleife in `invoke` entscheidet.
 */
async function runAttempt(
  doFetch: FetchLike,
  url: string,
  headers: Record<string, string>,
  input: Record<string, JsonValue>,
  timeoutMs: number,
  maxResponseBytes: number,
  outer: AbortSignal,
): Promise<AttemptResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onOuterAbort = (): void => controller.abort();
  if (outer.aborted) controller.abort();
  else outer.addEventListener("abort", onOuterAbort, { once: true });

  try {
    const res = await doFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
      signal: controller.signal,
      redirect: "error",
    });
    const text = await readCappedText(res, maxResponseBytes, controller);
    if (res.ok) return { kind: "ok", status: res.status, text };
    if (RETRYABLE_STATUS.has(res.status)) {
      return { kind: "transient", status: res.status, text };
    }
    return { kind: "http", status: res.status, text };
  } catch (error) {
    if (error instanceof N8nResponseTooLargeError) throw error;
    if (timedOut) {
      throw new N8nWebhookTimeoutError(
        `n8n-Webhook ${url}: Zeitfenster von ${timeoutMs} ms überschritten`,
      );
    }
    if (outer.aborted || isAbortError(error)) {
      throw new N8nWebhookAbortedError(`n8n-Webhook ${url} wurde abgebrochen`);
    }
    // Netzfehler ohne Antwort (DNS, Verbindung abgelehnt, Socket-Reset vor der Antwort):
    // der Workflow hat nicht gelaufen, ein erneuter Anlauf ist sicher.
    return { kind: "transient", status: 0, text: "", cause: error };
  } finally {
    clearTimeout(timer);
    outer.removeEventListener("abort", onOuterAbort);
  }
}

/**
 * Baut die Brücke. Fabrik statt Modul-Singleton, wie `createPool` (S03) und
 * `createPolicyEngine` (S11): die Konfiguration bleibt beim Aufrufer.
 */
export function createN8nBridge(config: N8nBridgeConfig): N8nBridge {
  const baseUrl = config.baseUrl?.trim() ? config.baseUrl.trim() : null;
  const doFetch = config.fetchImpl ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? N8N_WEBHOOK_TIMEOUT_MS;
  const maxAttempts = Math.max(1, config.maxAttempts ?? N8N_MAX_ATTEMPTS);
  const backoffBaseMs = config.backoffBaseMs ?? N8N_BACKOFF_BASE_MS;
  const maxResponseBytes = config.maxResponseBytes ?? N8N_MAX_RESPONSE_BYTES;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (config.token?.trim()) headers["x-kuronami-token"] = config.token.trim();

  return {
    configured: baseUrl !== null,
    baseUrl,

    async invoke(request: N8nInvokeRequest): Promise<N8nInvocation> {
      if (baseUrl === null) {
        throw new N8nUnavailableError(
          "keine n8n-Basis-URL konfiguriert (N8N_BASE_URL): die n8n-Brücke ist registriert, aber ohne Instanz nicht bedienbar.",
        );
      }
      if (request.signal.aborted) {
        throw new N8nWebhookAbortedError("Aufruf war schon vor dem ersten Versuch abgebrochen");
      }

      const url = joinUrl(baseUrl, request.webhookPath);
      const started = Date.now();
      const attemptCap = request.repeatable ? maxAttempts : 1;
      let last: AttemptResult | undefined;

      for (let attempt = 1; attempt <= attemptCap; attempt += 1) {
        if (attempt > 1) {
          const wait =
            backoffBaseMs * 2 ** (attempt - 2) + Math.floor(Math.random() * backoffBaseMs);
          await sleep(wait, request.signal);
        }

        last = await runAttempt(
          doFetch,
          url,
          headers,
          request.input,
          timeoutMs,
          maxResponseBytes,
          request.signal,
        );

        if (last.kind === "ok") {
          return {
            status: last.status,
            body: parseJsonBody(last.text, url),
            attempts: attempt,
            durationMs: Date.now() - started,
          };
        }
        if (last.kind === "http") {
          throw new N8nWorkflowHttpError(
            `n8n-Workflow unter ${url} hat mit HTTP ${last.status} geantwortet (Versuch ${attempt}). ${describeBody(last.text)}`,
            last.status,
            attempt,
            last.text,
          );
        }
        // kind === "transient": weiter zur nächsten Runde, sofern noch eine erlaubt ist.
      }

      // Alle erlaubten Versuche waren vorübergehende Fehler.
      const detail = last?.status
        ? `zuletzt HTTP ${last.status}`
        : `zuletzt Netzfehler${last?.cause instanceof Error ? `: ${last.cause.message}` : ""}`;
      throw new N8nWorkflowHttpError(
        `n8n-Workflow unter ${url} ist nach ${attemptCap} Versuch(en) nicht durchgekommen (${detail}).`,
        last?.status ?? 0,
        attemptCap,
        last?.text ?? "",
      );
    },
  };
}

function parseJsonBody(text: string, url: string): JsonValue {
  const trimmed = text.trim();
  if (trimmed === "") return {};
  try {
    return JSON.parse(trimmed) as JsonValue;
  } catch (error) {
    throw new N8nResponseFormatError(
      `n8n-Antwort von ${url} ist kein JSON (${error instanceof Error ? error.message : String(error)}). Der Webhook-Knoten muss JSON zurückgeben ("Respond to Webhook").`,
    );
  }
}

function describeBody(text: string): string {
  const short = text.trim().slice(0, 200);
  return short ? `Körper: ${short}` : "leerer Körper.";
}
