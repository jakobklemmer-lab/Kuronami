/**
 * Der authentifizierte HTTP-Client der Oberfläche (S22).
 *
 * Bündelt, was `/runs` (S22) und `/channels/web/pending`/`/answers` (S23) gemeinsam brauchen:
 * denselben Bearer-Token wie das Gateway ihn für jeden anderen Lesepfad verlangt
 * (`gateway/server.ts`, `webPrincipal`), und denselben Umgang mit den drei Wegen, auf denen
 * ein Aufruf scheitern kann — kein Token, ein abgelehnter Token, ein Netzwerk- oder
 * Serverfehler. AGENTS.md gilt auch hier: ein Fehler wird angezeigt, nicht stillschweigend zu
 * "lädt..." geglättet.
 *
 * Kein `fetch` fest verdrahtet: `fetchImpl` ist austauschbar, damit dieses Modul ohne Browser
 * und ohne echtes Netz prüfbar bleibt — dasselbe Muster wie `socketFactory` in
 * `ui/events/bus.ts`.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | "network" | "no_token",
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiClientOptions {
  /** Basis-URL ohne abschließenden Schrägstrich, z. B. `http://localhost:8788`. */
  baseUrl: string;
  /** Liefert den aktuellen Bearer-Token, oder `null`. Aufgerufen bei jeder Anfrage — ein in
   * den Einstellungen geänderter Token gilt damit sofort, ohne dass der Client neu gebaut
   * werden müsste. */
  token: () => string | null;
  fetchImpl?: typeof fetch;
}

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  delete<T>(path: string): Promise<T>;
}

async function toApiError(response: Response): Promise<ApiError> {
  let message = `${response.status} ${response.statusText}`;
  try {
    const body = (await response.json()) as { error?: unknown; message?: unknown };
    if (typeof body.error === "string") message = body.error;
    else if (typeof body.message === "string") message = body.message;
  } catch {
    // Kein JSON-Körper — die Statuszeile bleibt die Auskunft.
  }
  return new ApiError(message, response.status);
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  async function request<T>(path: string, init: RequestInit): Promise<T> {
    const token = options.token();
    if (token === null || token.length === 0) {
      throw new ApiError(
        "Kein Bearer-Token hinterlegt. Unter den Einstellungen eintragen.",
        "no_token",
      );
    }

    let response: Response;
    try {
      response = await fetchImpl(`${options.baseUrl}${path}`, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${token}` },
      });
    } catch (error) {
      throw new ApiError(
        `${options.baseUrl}${path} nicht erreichbar: ${error instanceof Error ? error.message : String(error)}`,
        "network",
      );
    }

    if (!response.ok) throw await toApiError(response);
    return (await response.json()) as T;
  }

  return {
    get: (path) => request(path, { method: "GET" }),
    post: (path, body) =>
      request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    delete: (path) => request(path, { method: "DELETE" }),
  };
}
