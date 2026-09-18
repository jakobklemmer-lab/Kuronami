/**
 * Wo die Oberfläche den Gateway erreicht (Nachtrag 2026-09-16, HTTPS über einen Reverse-Proxy).
 * Reine Funktion, damit sie ohne Browser geprüft werden kann (wie `deriveSessionState`,
 * `deriveLoopState`) — `ui/main.ts` bleibt der einzige Ort, der `location` tatsächlich liest.
 *
 * Zwei Betriebsarten:
 *  - Lokale Entwicklung (`localhost`, eine nackte IP, oder `?events=PORT` gesetzt): derselbe
 *    Host, ein anderer Port — das alte Schema aus S21.
 *  - Hinter dem Reverse-Proxy (Hostname beginnt mit `kuronami.`, z. B.
 *    `kuronami.<ip>.sslip.io`): der Gateway hat dort sein eigenes Zertifikat unter demselben
 *    Rest der Domain mit dem Präfix `gateway.` statt `kuronami.` (siehe Caddyfile). Nötig, weil
 *    ein Browser `ws://` von einer `https://`-Seite aus blockiert (Mixed Content) — der Gateway
 *    braucht also selbst HTTPS, nicht bloß einen Port dahinter.
 *
 * Für die Sprachschicht (S30/S31) gilt dasselbe in Grün: hinter dem Proxy liegt sie unter
 * `voice.` + demselben Rest, lokal auf Port 8790. Sie steht hier und nicht in
 * `ui/voice/session.ts`, weil die Herleitung dieselbe ist und zweimal geraten wird, was einmal
 * hergeleitet werden kann.
 */

export interface BackendOrigin {
  http: string;
  ws: string;
  /** Der WebSocket-Rand der Sprachschicht. Nur eine Vorgabe — die Einstellungen überstimmen sie. */
  voiceWs: string;
}

const GATEWAY_SUBDOMAIN_PREFIX = "kuronami.";
const DEFAULT_VOICE_PORT = "8790";

export function resolveBackendOrigin(
  hostname: string,
  isSecure: boolean,
  portOverride: string | null,
): BackendOrigin {
  const httpScheme = isSecure ? "https" : "http";
  const wsScheme = isSecure ? "wss" : "ws";

  if (portOverride === null && hostname.startsWith(GATEWAY_SUBDOMAIN_PREFIX)) {
    const rest = hostname.slice(GATEWAY_SUBDOMAIN_PREFIX.length);
    const gatewayHost = `gateway.${rest}`;
    return {
      http: `${httpScheme}://${gatewayHost}`,
      ws: `${wsScheme}://${gatewayHost}/events`,
      voiceWs: `${wsScheme}://voice.${rest}`,
    };
  }

  const port = portOverride ?? "3000";
  return {
    http: `${httpScheme}://${hostname}:${port}`,
    ws: `${wsScheme}://${hostname}:${port}/events`,
    voiceWs: `${wsScheme}://${hostname}:${DEFAULT_VOICE_PORT}`,
  };
}
