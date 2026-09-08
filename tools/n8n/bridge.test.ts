import { describe, expect, it } from "vitest";
import {
  type FetchLike,
  N8nResponseFormatError,
  N8nResponseTooLargeError,
  N8nUnavailableError,
  N8nWebhookAbortedError,
  N8nWebhookTimeoutError,
  N8nWorkflowHttpError,
  createN8nBridge,
} from "./bridge.js";

/**
 * Die Brücke ohne Netz und ohne n8n. `fetch` ist injiziert (Muster aus `web/tools.test.ts`,
 * S09). Geprüft wird genau das, was S13 auf Brückenebene verlangt: Timeout, Retry mit
 * Backoff bei vorübergehenden Fehlern, kein Retry bei 4xx / Timeout / Abbruch, kein Retry
 * für nicht wiederholbare Workflows, harte Größenbegrenzung, nur JSON.
 */

type Responder = (url: string, init: RequestInit) => Response | Promise<Response>;

interface FakeFetch {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
  calls: number;
  lastUrl?: string;
  lastInit?: RequestInit;
}

/** Verbraucht die Responder der Reihe nach; beim letzten bleibt es, sobald er erreicht ist. */
function fakeFetch(...responders: Responder[]): FakeFetch & FetchLike {
  const queue = [...responders];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    impl.calls += 1;
    impl.lastUrl =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    impl.lastInit = init;
    const responder = queue.length > 1 ? (queue.shift() as Responder) : queue[0];
    return responder(impl.lastUrl, init ?? {});
  }) as FakeFetch & FetchLike;
  impl.calls = 0;
  return impl;
}

const jsonResponse =
  (bodyObj: unknown, status = 200): Responder =>
  () =>
    new Response(JSON.stringify(bodyObj), {
      status,
      headers: { "content-type": "application/json" },
    });

const statusResponse =
  (code: number, body = ""): Responder =>
  () =>
    new Response(body, { status: code });

const networkError = (): Responder => () => {
  throw new TypeError("fetch failed");
};

/** Antwortet nie von selbst — nur ein Abbruch des Signals bringt sie zurück. */
const hang = (): Responder => (_url, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init.signal;
    if (!signal) return;
    signal.addEventListener(
      "abort",
      () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
      { once: true },
    );
  });

function bridge(fetchImpl: FetchLike, extra: Record<string, unknown> = {}) {
  return createN8nBridge({
    baseUrl: "http://n8n.test",
    fetchImpl,
    backoffBaseMs: 1,
    ...extra,
  });
}

function req(overrides: Partial<Parameters<ReturnType<typeof bridge>["invoke"]>[0]> = {}) {
  return {
    webhookPath: "uppercase",
    input: { text: "hallo" },
    repeatable: true,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("n8n-Brücke", () => {
  it("meldet einen Fehler, wenn keine Basis-URL konfiguriert ist", async () => {
    const b = createN8nBridge({ fetchImpl: fakeFetch(jsonResponse({})) });
    expect(b.configured).toBe(false);
    await expect(b.invoke(req())).rejects.toBeInstanceOf(N8nUnavailableError);
  });

  it("ruft den Webhook per POST auf und gibt den geparsten Körper zurück", async () => {
    const fetchImpl = fakeFetch(jsonResponse({ text: "HALLO", summary: "eins" }));
    const result = await bridge(fetchImpl, { token: "sekret" }).invoke(req());

    expect(result).toMatchObject({ status: 200, attempts: 1 });
    expect(result.body).toEqual({ text: "HALLO", summary: "eins" });
    expect(fetchImpl.lastUrl).toBe("http://n8n.test/webhook/uppercase");
    expect(fetchImpl.lastInit?.method).toBe("POST");
    expect(JSON.parse(fetchImpl.lastInit?.body as string)).toEqual({ text: "hallo" });
    const headers = fetchImpl.lastInit?.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-kuronami-token"]).toBe("sekret");
  });

  it("leerer Körper wird zu einem leeren Objekt", async () => {
    const result = await bridge(fakeFetch(statusResponse(200, ""))).invoke(req());
    expect(result.body).toEqual({});
  });

  it("wiederholt einen vorübergehenden Fehler (503) und kommt beim zweiten Mal durch", async () => {
    const fetchImpl = fakeFetch(statusResponse(503), jsonResponse({ ok: true }));
    const result = await bridge(fetchImpl).invoke(req());
    expect(result.attempts).toBe(2);
    expect(fetchImpl.calls).toBe(2);
  });

  it("wiederholt auch bei HTTP 429", async () => {
    const fetchImpl = fakeFetch(statusResponse(429), jsonResponse({ ok: true }));
    const result = await bridge(fetchImpl).invoke(req());
    expect(result.attempts).toBe(2);
  });

  it("wiederholt einen Netzfehler ohne Antwort", async () => {
    const fetchImpl = fakeFetch(networkError(), jsonResponse({ done: 1 }));
    const result = await bridge(fetchImpl).invoke(req());
    expect(result.attempts).toBe(2);
    expect(fetchImpl.calls).toBe(2);
  });

  it("wiederholt einen 4xx-Fehler nicht (deterministisch)", async () => {
    const fetchImpl = fakeFetch(statusResponse(400, "kaputte Eingabe"));
    const error = await bridge(fetchImpl)
      .invoke(req())
      .catch((e) => e);
    expect(error).toBeInstanceOf(N8nWorkflowHttpError);
    expect(error.status).toBe(400);
    expect(error.attempts).toBe(1);
    expect(fetchImpl.calls).toBe(1);
  });

  it("wiederholt nichts, wenn der Workflow nicht wiederholbar ist", async () => {
    const fetchImpl = fakeFetch(statusResponse(503), jsonResponse({ ok: true }));
    const error = await bridge(fetchImpl)
      .invoke(req({ repeatable: false }))
      .catch((e) => e);
    expect(error).toBeInstanceOf(N8nWorkflowHttpError);
    expect(fetchImpl.calls).toBe(1);
  });

  it("gibt nach der letzten erlaubten Wiederholung auf", async () => {
    const fetchImpl = fakeFetch(statusResponse(503));
    const error = await bridge(fetchImpl)
      .invoke(req())
      .catch((e) => e);
    expect(error).toBeInstanceOf(N8nWorkflowHttpError);
    expect(error.attempts).toBe(3);
    expect(fetchImpl.calls).toBe(3);
  });

  it("hält den Backoff zwischen den Versuchen ein", async () => {
    const fetchImpl = fakeFetch(statusResponse(503), statusResponse(503), jsonResponse({ ok: 1 }));
    const started = Date.now();
    await bridge(fetchImpl, { backoffBaseMs: 40 }).invoke(req());
    // Versuch 2 wartet 40..80 ms, Versuch 3 wartet 80..120 ms — zusammen mindestens 120.
    expect(Date.now() - started).toBeGreaterThanOrEqual(110);
    expect(fetchImpl.calls).toBe(3);
  });

  it("endet am Zeitfenster, ohne zu wiederholen", async () => {
    const fetchImpl = fakeFetch(hang());
    const started = Date.now();
    const error = await bridge(fetchImpl, { timeoutMs: 30 })
      .invoke(req())
      .catch((e) => e);
    expect(error).toBeInstanceOf(N8nWebhookTimeoutError);
    expect(fetchImpl.calls).toBe(1);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("bricht ab, wenn das Signal schon vor dem ersten Versuch abgebrochen war", async () => {
    const fetchImpl = fakeFetch(jsonResponse({}));
    const controller = new AbortController();
    controller.abort();
    await expect(
      bridge(fetchImpl).invoke(req({ signal: controller.signal })),
    ).rejects.toBeInstanceOf(N8nWebhookAbortedError);
    expect(fetchImpl.calls).toBe(0);
  });

  it("bricht ab, wenn das Signal während eines laufenden Aufrufs feuert", async () => {
    const fetchImpl = fakeFetch(hang());
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const error = await bridge(fetchImpl, { timeoutMs: 10_000 })
      .invoke(req({ signal: controller.signal }))
      .catch((e) => e);
    expect(error).toBeInstanceOf(N8nWebhookAbortedError);
  });

  it("bricht das Lesen ab, wenn die Antwort zu groß ist", async () => {
    const big = "x".repeat(5000);
    const fetchImpl = fakeFetch(jsonResponse({ blob: big }));
    await expect(bridge(fetchImpl, { maxResponseBytes: 100 }).invoke(req())).rejects.toBeInstanceOf(
      N8nResponseTooLargeError,
    );
  });

  it("weist eine Antwort ab, die kein JSON ist", async () => {
    const fetchImpl = fakeFetch(
      () => new Response("<html>keine Antwort im Tool-Schema</html>", { status: 200 }),
    );
    await expect(bridge(fetchImpl).invoke(req())).rejects.toBeInstanceOf(N8nResponseFormatError);
  });
});
