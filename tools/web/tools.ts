import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { writeArtifact } from "../../runtime/artifacts/store.js";
import type { JsonValue } from "../../runtime/steps/types.js";
import type { ToolDefinition, ToolInvocation, ToolOutput } from "../types.js";
import { type EgressPolicy, EgressUrlError, assertEgressAllowed } from "./egress.js";
import { type InjectionFlag, normalizeContent, scanForInjection } from "./normalize.js";

/**
 * `web.search` und `web.fetch` (S09, Abschnitt 9). Beide laufen über `tools/router.ts` und
 * damit durch die Ausführungshülle aus S05 — Checkpoint davor und danach, Idempotenzschlüssel,
 * Zeitfenster. Diese Datei baut die Definitionen und Handler; die einheitliche Rückgabehülle
 * und die Ereignisse macht der Router.
 *
 * Die drei tragenden Entscheidungen von S09:
 *
 *   1. **Rohinhalt und normalisierte Fassung sind strikt getrennt.** Der Rohinhalt — die
 *      Bytes, wie sie über die Leitung kamen — geht immer und ausschließlich ins Artefakt
 *      (`readArtifact` gibt sie bytegleich zurück). In den Kontext geht nur eine knappe,
 *      tag-freie Zusammenfassung in `structured.excerpt`. Die beiden teilen sich kein Feld;
 *      es gibt in der Hülle keinen Weg an den vollständigen Rohinhalt.
 *
 *   2. **Abgerufener Inhalt ist nicht vertrauenswürdig** (Abschnitt 4.7). `structured.trust`
 *      ist `"untrusted"`, `summary` beginnt mit einer Markierung, und Injection-Muster im
 *      Text werden **markiert, nicht entfernt** (`scanForInjection` in `normalize.ts`): eine
 *      Anweisung aus externem Inhalt hebt nie eine Freigabe auf, und ein still gelöschtes
 *      Muster wäre ein verstecktes Signal.
 *
 *   3. **Egress ist deny-by-default** (`egress.ts`): nur http/https, nur freigegebene Hosts,
 *      keine lokalen/privaten Adressen. Dazu ein Zeitfenster und eine harte Größenbegrenzung,
 *      die den Download abbricht, bevor ein Artefakt entsteht.
 *
 * Die **Bytes** eines abgerufenen Inhalts laufen nicht durch den Redaction-Filter — dieselbe
 * bewusste Grenze wie bei den Artefaktbytes (S07) und den `fs.read`-Rohbytes (S08). Ein
 * Textmuster über beliebige Bytes beschädigte die SHA-256-Kette, und das Artefakt liegt auf
 * derselben lokalen Platte. Der Schutz greift an der anderen Stelle: der **excerpt** in
 * `structured`/`preview` geht durch `appendEventInTx` (Protokoll) und `buildPrompt` (Kontext),
 * und beide filtern. Ein `sk-ant-…` im Text einer Seite ist im Protokoll und im Prompt
 * ersetzt, bevor das Modell es sieht.
 */

/** Das Zeitfenster wurde überschritten, bevor die Antwort vollständig gelesen war. */
export class WebFetchTimeoutError extends Error {}
/** Die Antwort ist größer als erlaubt; der Download wurde abgebrochen. */
export class WebFetchTooLargeError extends Error {}
/** Der Abruf wurde von außen abgebrochen (Session-Abbruch, Prozess-Signal). */
export class WebFetchAbortedError extends Error {}
/** Die Weiterleitungskette war länger als erlaubt. */
export class WebFetchTooManyRedirectsError extends Error {}
/** `web.search` wurde ohne konfiguriertes Backend aufgerufen. */
export class WebSearchUnavailableError extends Error {}
/** Die Eingabe an `web.search` ist unbrauchbar (leer, zu lang). */
export class WebSearchInputError extends Error {}

/** Zeitfenster für einen einzelnen `web.fetch`. Deutlich unter dem 60-s-Fenster der Hülle,
 *  damit ein hängender Abruf als sauberer Tool-Fehler endet, nicht als "unbekannter Ausgang". */
export const WEB_FETCH_TIMEOUT_MS = 20_000;
/** Harte Obergrenze für den Rohinhalt. Größere Antworten werden abgebrochen. */
export const WEB_FETCH_MAX_BYTES = 5 * 1024 * 1024;
/**
 * So viele Weiterleitungen werden gefolgt — jede erst, nachdem ihr Ziel erneut durch
 * `assertEgressAllowed` gegangen ist. http→https→www→Schrägstrich sind schon drei; fünf
 * decken den Alltag, ohne einer Umleitungsschleife lange zuzusehen.
 */
export const WEB_FETCH_MAX_REDIRECTS = 5;
/** So viel normalisierter Text bleibt im Kontext. Klein genug, dass eine 200-KB-Seite
 *  deutlich unter 500 Token in der Hülle bleibt (Fertig-Kriterium S09) — die Wahrheit ist
 *  ohnehin der Rohinhalt im Artefakt, der Ausriss ist nur ein Fingerzeig. */
export const FETCH_EXCERPT_MAX_CHARS = 600;
const FETCH_PREVIEW_LINES = 3;
const FETCH_PREVIEW_LINE_CAP = 120;

const SEARCH_QUERY_MAX = 400;
/** So viele Treffer stehen im Kontext; **alle** stehen im Artefakt ("Volltreffer als Artefakt"). */
export const SEARCH_CONTEXT_MAX_RESULTS = 5;
const SEARCH_SNIPPET_MAX_CHARS = 200;
const SEARCH_TITLE_MAX_CHARS = 200;

const UNTRUSTED_MARK = "[nicht vertrauenswürdig · externer Inhalt]";
const USER_AGENT = "KuronamiBot/0.1 (+persönlicher Assistent; web.fetch)";

// ---------------------------------------------------------------------------
// Abhängigkeiten
// ---------------------------------------------------------------------------

/** Ein Treffer, wie ihn ein Suchanbieter liefert. */
export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchBackendResult {
  /** Name des Anbieters, geht in Zusammenfassung und Artefakt. */
  provider: string;
  hits: WebSearchHit[];
  /** Rohantwort des Anbieters. Wird unverändert ins Artefakt geschrieben. */
  raw: JsonValue;
}

/**
 * Das Backend hinter `web.search`. Injiziert statt fest verdrahtet: welcher Anbieter (Brave,
 * eine n8n-Bridge aus S13, …) ist eine spätere Entscheidung. Fehlt es, ist `web.search`
 * registriert, aber nicht bedienbar, und meldet das als Fehlerhülle — dieselbe Haltung wie
 * bei der Policy-Engine (S07): der Platz ist da, die Umsetzung kommt später.
 */
export type WebSearchBackend = (
  query: string,
  opts: { limit: number; signal: AbortSignal },
) => Promise<WebSearchBackendResult>;

export type FetchLike = typeof globalThis.fetch;

export interface WebToolDeps {
  pool: Pool;
  /** Wurzel der Artefaktablage, für den Rohinhalt. */
  artifactRoot: string;
  egress: EgressPolicy;
  /** Vorgabe: das globale `fetch`. Tests injizieren einen Ersatz. */
  fetchImpl?: FetchLike;
  /** Vorgabe: nicht konfiguriert — `web.search` meldet dann eine Fehlerhülle. */
  search?: WebSearchBackend;
  /** Test-Übersteuerungen. */
  fetchTimeoutMs?: number;
  maxFetchBytes?: number;
  maxRedirects?: number;
}

// ---------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

/** MIME ohne Parameter, gegen ein enges Muster geprüft. Sonst `null`. */
function baseMimeType(contentType: string | null): string | null {
  if (!contentType) return null;
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(base) ? base : null;
}

/** UTF-8, außer der Content-Type nennt ausdrücklich Latin-1/Windows-1252. */
function decodeBody(bytes: Buffer, contentType: string | null): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType ?? "")?.[1]?.toLowerCase();
  if (charset === "iso-8859-1" || charset === "latin1" || charset === "windows-1252") {
    return bytes.toString("latin1");
  }
  return bytes.toString("utf8");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/**
 * Liest den Antwort-Body und bricht ab, sobald `maxBytes` überschritten ist — ohne den Rest
 * herunterzuladen. Bevorzugt den Stream (`res.body`); fällt auf `arrayBuffer()` zurück, wenn
 * keiner da ist (auch dann greift die Grenze, nur eben erst nach dem vollständigen Empfang).
 */
async function readBodyCapped(
  res: Response,
  maxBytes: number,
  controller: AbortController,
): Promise<Buffer> {
  const body = res.body;
  if (!body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw tooLarge(buf.length, maxBytes);
    return buf;
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
        throw tooLarge(total, maxBytes);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

function tooLarge(seen: number, max: number): WebFetchTooLargeError {
  return new WebFetchTooLargeError(
    `Antwort überschreitet die Größenbegrenzung: mindestens ${seen} Bytes, erlaubt sind ${max}. Der Download wurde abgebrochen, es entstand kein Artefakt.`,
  );
}

// ---------------------------------------------------------------------------
// web.fetch
// ---------------------------------------------------------------------------

interface FetchResult {
  res: Response;
  bytes: Buffer;
  /** Die Adresse, die die zurückgegebene Antwort geliefert hat (nach allen Weiterleitungen). */
  finalUrl: string;
}

const REDIRECT_STATUS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * Folgt Weiterleitungen **von Hand** und schickt jede Zwischenadresse erneut durch
 * `assertEgressAllowed`, bevor ihr gefolgt wird.
 *
 * `fetch(url, { redirect: "follow" })` prüft nur die erste Adresse. Eine freigegebene,
 * harmlose Seite könnte mit einem `302` auf eine interne Adresse antworten (Heimnetz,
 * Cloud-Metadaten, Server-Verwaltung), und der eingebaute Follower ginge brav hin — der
 * Egress-Riegel wäre mit einem einzigen Header umgangen. Deshalb `redirect: "manual"` plus
 * diese Schleife mit Obergrenze. (Schließt **nicht** DNS-Rebinding: ein öffentlicher Name,
 * der zur Verbindungszeit auf eine interne IP zeigt — das bräuchte einen eigenen
 * undici-Agent, dokumentierte Grenze in Abschnitt 4.7.)
 */
async function followWithGuardedRedirects(
  doFetch: FetchLike,
  egress: EgressPolicy,
  startUrl: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
  maxRedirects: number,
): Promise<{ res: Response; finalUrl: string }> {
  let url = assertEgressAllowed(egress, startUrl).href;

  for (let hop = 0; ; hop += 1) {
    const res = await doFetch(url, {
      redirect: "manual",
      signal: init.signal,
      headers: init.headers,
    });

    const location = res.headers.get("location");
    if (!REDIRECT_STATUS.has(res.status) || location === null || location.trim() === "") {
      return { res, finalUrl: url };
    }

    // Eine Zwischenantwort trägt nur Header; ihren Body brauchen wir nicht, aber der Socket
    // muss freigegeben werden.
    await res.body?.cancel().catch(() => {});

    if (hop >= maxRedirects) {
      throw new WebFetchTooManyRedirectsError(
        `web.fetch ${startUrl}: mehr als ${maxRedirects} Weiterleitungen (zuletzt ${url} → ${location})`,
      );
    }

    let next: URL;
    try {
      next = new URL(location, url); // eine relative Location gegen die aktuelle Adresse auflösen
    } catch {
      throw new EgressUrlError(
        `web.fetch: Weiterleitungsziel "${location}" (von ${url}) ist keine gültige URL`,
      );
    }
    // Wirft EgressBlockedError/EgressUrlError, wenn das Weiterleitungsziel nicht erlaubt ist —
    // genau der Riegel, den der eingebaute Follower übersprungen hätte.
    url = assertEgressAllowed(egress, next.href).href;
  }
}

async function performFetch(
  deps: WebToolDeps,
  inv: ToolInvocation,
  requestedUrl: string,
): Promise<FetchResult> {
  const doFetch = deps.fetchImpl ?? globalThis.fetch;
  const timeoutMs = deps.fetchTimeoutMs ?? WEB_FETCH_TIMEOUT_MS;
  const maxBytes = deps.maxFetchBytes ?? WEB_FETCH_MAX_BYTES;
  const maxRedirects = deps.maxRedirects ?? WEB_FETCH_MAX_REDIRECTS;

  const controller = new AbortController();
  let loseRace: (error: Error) => void = () => {};
  const raceLoser = new Promise<never>((_, reject) => {
    loseRace = reject;
  });
  const fail = (error: Error): void => {
    controller.abort(error);
    loseRace(error);
  };

  const timer = setTimeout(
    () =>
      fail(
        new WebFetchTimeoutError(
          `web.fetch ${requestedUrl}: Zeitfenster von ${timeoutMs} ms überschritten`,
        ),
      ),
    timeoutMs,
  );
  const onOuterAbort = (): void =>
    fail(new WebFetchAbortedError(`web.fetch ${requestedUrl} wurde abgebrochen`));
  if (inv.signal.aborted) onOuterAbort();
  else inv.signal.addEventListener("abort", onOuterAbort, { once: true });

  const work = (async (): Promise<FetchResult> => {
    const { res, finalUrl } = await followWithGuardedRedirects(
      doFetch,
      deps.egress,
      requestedUrl,
      {
        signal: controller.signal,
        headers: {
          accept:
            "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5",
          "user-agent": USER_AGENT,
        },
      },
      maxRedirects,
    );
    const bytes = await readBodyCapped(res, maxBytes, controller);
    return { res, bytes, finalUrl };
  })();
  // Der Verlierer des Rennens läuft weiter; ohne diesen Fänger risse eine späte Ablehnung
  // den Prozess ab (dasselbe Muster wie in der Ausführungshülle, S05).
  work.catch(() => {});

  try {
    return await Promise.race([work, raceLoser]);
  } catch (error) {
    const reason = controller.signal.reason;
    if (reason instanceof WebFetchTimeoutError || reason instanceof WebFetchAbortedError) {
      throw reason;
    }
    if (error instanceof WebFetchTooLargeError) throw error;
    if (isAbortError(error)) {
      throw new WebFetchAbortedError(`web.fetch ${requestedUrl} wurde abgebrochen`);
    }
    // EgressBlockedError/EgressUrlError (auch aus einer Weiterleitung),
    // WebFetchTooManyRedirectsError und Netzwerkfehler (DNS, Verbindung) laufen hier durch
    // → Router-Fehlerhülle.
    throw error;
  } finally {
    clearTimeout(timer);
    inv.signal.removeEventListener("abort", onOuterAbort);
  }
}

async function fetchHandler(deps: WebToolDeps, inv: ToolInvocation): Promise<ToolOutput> {
  const requestedUrl = inv.input.url as string;

  // Egress-Prüfung (Schema, Zugangsdaten, Allowlist, SSRF-Riegel) läuft in
  // followWithGuardedRedirects — für die Startadresse *und* jede Weiterleitung.
  const { res, bytes, finalUrl } = await performFetch(deps, inv, requestedUrl);

  const contentType = res.headers.get("content-type");
  const sha256 = sha256Hex(bytes);

  // Rohinhalt → Artefakt, immer und byteweise. Das ist die nicht vertrauenswürdige
  // Rohfassung; sie läuft nicht durch den Redaction-Filter (siehe Kopfkommentar).
  const meta = await writeArtifact(deps.pool, deps.artifactRoot, {
    content: bytes,
    mimeType: baseMimeType(contentType) ?? "application/octet-stream",
    summary: `Rohinhalt (nicht vertrauenswürdig) von ${finalUrl}: HTTP ${res.status}, ${bytes.length} Bytes`,
    source: { tool: "web.fetch", sessionId: inv.sessionId, stepId: inv.stepId },
  });

  // Normalisierte Fassung → nur in den Kontext. Trägt nie den vollständigen Rohinhalt.
  const decoded = decodeBody(bytes, contentType);
  const normalized = normalizeContent(decoded, contentType);
  const flags = scanForInjection(normalized.text);
  const excerpt = normalized.text.slice(0, FETCH_EXCERPT_MAX_CHARS);
  const excerptTruncated = normalized.text.length > excerpt.length;

  const summary = [
    `${UNTRUSTED_MARK} ${finalUrl} — HTTP ${res.status}, ${bytes.length} Bytes`,
    normalized.title ? `, „${normalized.title.slice(0, 120)}“` : "",
    flags.length > 0 ? `, ${flags.length} Injection-Muster markiert` : "",
    `. Rohinhalt im Artefakt ${meta.uri}.`,
  ].join("");

  return {
    summary,
    structured: {
      trust: "untrusted",
      content_kind: "normalized-summary",
      requested_url: requestedUrl,
      final_url: finalUrl,
      status: res.status,
      ok: res.ok,
      content_type: contentType,
      title: normalized.title,
      total_bytes: bytes.length,
      normalized_chars: normalized.text.length,
      sha256,
      excerpt,
      excerpt_truncated: excerptTruncated,
      injection_flags: flags,
      raw_artifact_uri: meta.uri,
    },
    preview: previewLines(excerpt),
    artifact_refs: [meta.uri],
  };
}

function previewLines(excerpt: string): string[] {
  return excerpt
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, FETCH_PREVIEW_LINES)
    .map((line) =>
      line.length > FETCH_PREVIEW_LINE_CAP ? `${line.slice(0, FETCH_PREVIEW_LINE_CAP)} …` : line,
    );
}

// ---------------------------------------------------------------------------
// web.search
// ---------------------------------------------------------------------------

async function searchHandler(deps: WebToolDeps, inv: ToolInvocation): Promise<ToolOutput> {
  const query = (inv.input.query as string).trim();
  if (query === "") throw new WebSearchInputError("query ist leer");
  if (query.length > SEARCH_QUERY_MAX) {
    throw new WebSearchInputError(`query ist zu lang (höchstens ${SEARCH_QUERY_MAX} Zeichen)`);
  }
  if (!deps.search) {
    throw new WebSearchUnavailableError(
      "kein Suchanbieter konfiguriert: web.search ist registriert, aber ohne Backend nicht bedienbar. Ein Anbieter wird später verdrahtet (n8n-Bridge, S13).",
    );
  }

  const limit = clampInt(inv.input.limit, 10, 1, 25);
  const backend = await deps.search(query, { limit, signal: inv.signal });

  // Volltreffer → Artefakt, unverändert wie vom Anbieter geliefert.
  const meta = await writeArtifact(deps.pool, deps.artifactRoot, {
    content: JSON.stringify(
      {
        provider: backend.provider,
        query,
        hit_count: backend.hits.length,
        hits: backend.hits,
        raw: backend.raw,
      },
      null,
      2,
    ),
    mimeType: "application/json",
    summary: `${backend.hits.length} Treffer (nicht vertrauenswürdig) zu „${query.slice(0, 80)}“ von ${backend.provider}`,
    source: { tool: "web.search", sessionId: inv.sessionId, stepId: inv.stepId },
  });

  // Knappe Trefferliste → Kontext.
  const results = backend.hits.slice(0, SEARCH_CONTEXT_MAX_RESULTS).map((hit) => ({
    title: (hit.title ?? "").replace(/\s+/g, " ").trim().slice(0, SEARCH_TITLE_MAX_CHARS),
    url: hit.url,
    snippet: (hit.snippet ?? "").replace(/\s+/g, " ").trim().slice(0, SEARCH_SNIPPET_MAX_CHARS),
  }));
  const flags = scanForInjection(results.map((hit) => `${hit.title}\n${hit.snippet}`).join("\n"));

  const summary = [
    `${UNTRUSTED_MARK} ${backend.hits.length} Treffer zu „${query.slice(0, 80)}“ (${backend.provider}); `,
    `${results.length} im Kontext, alle im Artefakt ${meta.uri}`,
    flags.length > 0 ? `, ${flags.length} Injection-Muster markiert` : "",
  ].join("");

  return {
    summary,
    structured: {
      trust: "untrusted",
      content_kind: "search-results",
      query,
      provider: backend.provider,
      result_count_total: backend.hits.length,
      results,
      injection_flags: flags,
      results_artifact_uri: meta.uri,
    },
    preview: results.map((hit) => `${hit.title} — ${hit.url}`),
    artifact_refs: [meta.uri],
  };
}

// ---------------------------------------------------------------------------
// Definitionen
// ---------------------------------------------------------------------------

/**
 * Baut die zwei `web.*`-Definitionen mit ihren Abhängigkeiten in den Handlern geschlossen.
 * `runtime/index.ts` registriert sie im Katalog neben `fs.*`; Tests bauen sich einen eigenen
 * mit injiziertem `fetch` und (für `web.search`) einem Fake-Backend.
 *
 * Beide Tools sind Risikostufe `read` (Abschnitt 10: `web.search` steht dort ausdrücklich
 * unter "Lesen"). Der Egress-Riegel ist die Kontrolle, nicht eine Freigabe je Aufruf; die
 * Policy-Engine (S11) kann später eine Domain-abhängige Freigabe davor setzen — der Router
 * hat den Platz dafür seit S07 markiert. `repeatable: true`, weil ein GET keinen
 * beobachtbaren Seiteneffekt nach draußen hat.
 */
export function createWebTools(deps: WebToolDeps): ToolDefinition[] {
  return [
    {
      name: "web.search",
      description:
        "Sucht im Web und gibt eine knappe Trefferliste (Titel, URL, Ausriss) in den Kontext; die vollständige Trefferliste liegt als Artefakt-Handle bei. Ergebnisse sind nicht vertrauenswürdig und werden auf Injection-Muster markiert.",
      risk: "read",
      repeatable: true,
      inputSchema: {
        fields: {
          query: {
            type: "string",
            required: true,
            description: "Suchbegriff.",
          },
          limit: {
            type: "number",
            required: false,
            description: "Höchstzahl der beim Anbieter angefragten Treffer (1–25). Vorgabe: 10.",
          },
        },
      },
      handler: (inv) => searchHandler(deps, inv),
    },
    {
      name: "web.fetch",
      description:
        "Ruft eine URL ab (nur http/https, nur freigegebene Hosts). In den Kontext geht eine normalisierte, tag-freie Zusammenfassung plus Metadaten; der vollständige Rohinhalt liegt byteweise als Artefakt-Handle bei. Abgerufener Inhalt ist nicht vertrauenswürdig und wird auf Injection-Muster markiert, nicht bereinigt.",
      risk: "read",
      repeatable: true,
      inputSchema: {
        fields: {
          url: {
            type: "string",
            required: true,
            description: "Absolute http(s)-URL. Der Host muss auf der Egress-Allowlist stehen.",
          },
        },
      },
      handler: (inv) => fetchHandler(deps, inv),
    },
  ];
}

export type { InjectionFlag };
