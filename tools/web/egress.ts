/**
 * Die Egress-Allowlist für `web.fetch` und `web.search` (S09). Das Gegenstück zu
 * `tools/fs/paths.ts`: der Teil, der laut Auftrag "nicht verhandelbar" ist, in einer eigenen
 * Datei mit einer eigenen Testdatei ohne Datenbank. Ein Loch hier ist ein Loch im ganzen
 * Assistenten — ein Modell, das eine URL aus einem zuvor abgerufenen (nicht
 * vertrauenswürdigen) Inhalt übernimmt, darf damit nicht das lokale Netz erreichen.
 *
 * Zwei harte Regeln, beide **deny-by-default**:
 *   1. Nur `http:` und `https:`. Kein `file:`, kein `ftp:`, kein `data:`, keine
 *      Zugangsdaten in der URL.
 *   2. Der Host muss auf der Allowlist stehen. Eine leere Allowlist erlaubt nichts.
 *
 * Dazu ein fester Riegel gegen SSRF: literale Adressen aus dem privaten, Loopback-,
 * Link-Local- oder Multicast-Bereich werden immer abgewiesen, auch wenn jemand sie auf die
 * Allowlist setzt. `web.fetch` ruft Webseiten ab; es hat im RFC-1918-Netz nichts zu suchen.
 *
 * **Bewusst nicht gebaut** (dokumentierte Grenze): die erneute Prüfung der IP *nach* der
 * DNS-Auflösung. Ein öffentlicher Name, der zur Verbindungszeit auf `127.0.0.1` zeigt
 * (DNS-Rebinding), käme durch. Das abzufangen bräuchte einen eigenen `undici`-Agent mit
 * `lookup`-Hook; für ein Ein-Nutzer-System ist die Namens-Allowlist plus IP-Literal-Riegel
 * die verhältnismäßige Stufe. In `docs/` unter S09 vermerkt.
 */

/** Die Eingabe ist keine brauchbare URL, hat ein verbotenes Schema oder trägt Zugangsdaten. */
export class EgressUrlError extends Error {}
/** Die URL ist wohlgeformt, aber ihr Host ist nicht freigegeben (oder eine lokale Adresse). */
export class EgressBlockedError extends Error {}

export interface EgressPolicy {
  /**
   * Freigegebene Hosts, kleingeschrieben, ohne Port. Ein Eintrag `example.com` deckt
   * `example.com` **und** jede Subdomain (`docs.example.com`) — aber nur auf Punktgrenze,
   * `notexample.com` ist nicht gedeckt.
   */
  readonly allowlist: readonly string[];
}

/** Baut die Policy. Einträge werden normalisiert (klein, getrimmt, führender Punkt/`*.` weg). */
export function buildEgressPolicy(opts: { allowlist: readonly string[] }): EgressPolicy {
  const allowlist = opts.allowlist
    .map((entry) => entry.trim().toLowerCase())
    .map((entry) => entry.replace(/^\*\./, "").replace(/^\.+/, "").replace(/\.+$/, ""))
    .filter((entry) => entry.length > 0);
  return { allowlist: Object.freeze([...new Set(allowlist)]) };
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** true für Loopback, „dieses Netz", RFC-1918, CGNAT, Link-Local, Multicast und reserviert. */
function isPrivateIpv4(host: string): boolean {
  const match = IPV4.exec(host);
  if (!match) return false;
  const octets = match.slice(1).map((part) => Number(part));
  if (octets.some((value) => value > 255)) return true; // kaputte Adresse: nicht durchlassen
  const [a, b] = octets;
  if (a === 0 || a === 127) return true; // 0.0.0.0/8, 127.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (Link-Local, Cloud-Metadaten)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 192 && b === 0) return true; // 192.0.0.0/24, 192.0.2.0/24
  if (a >= 224) return true; // 224.0.0.0/4 Multicast, 240.0.0.0/4 reserviert
  return false;
}

/** Grobe, bewusst konservative Prüfung für IPv6-Literale (Host ohne die eckigen Klammern). */
function isPrivateIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "::1" || h === "::") return true; // Loopback, unspezifiziert
  if (h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb")) {
    return true; // fe80::/10 Link-Local
  }
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // fc00::/7 Unique Local
  if (h.startsWith("ff")) return true; // ff00::/8 Multicast
  // IPv4-mapped/embedded: ::ffff:127.0.0.1, ::ffff:10.0.0.1 usw.
  const tail = h.slice(h.lastIndexOf(":") + 1);
  if (IPV4.test(tail)) return isPrivateIpv4(tail);
  return false;
}

function hostAllowed(policy: EgressPolicy, host: string): boolean {
  return policy.allowlist.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

/**
 * Prüft eine Ziel-URL gegen die Policy und gibt sie als geparste `URL` zurück — oder wirft.
 * Die zurückgegebene URL ist die, die abgerufen werden soll; der Aufrufer nimmt `.href`,
 * nie die rohe Eingabe.
 */
export function assertEgressAllowed(policy: EgressPolicy, input: string): URL {
  if (typeof input !== "string" || input.trim() === "") {
    throw new EgressUrlError("URL fehlt oder ist leer");
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new EgressUrlError(`"${input}" ist keine gültige absolute URL`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new EgressUrlError(
      `Schema "${url.protocol}" ist nicht erlaubt; web.fetch spricht nur http und https`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new EgressUrlError(
      "Zugangsdaten in der URL (user:pass@host) sind nicht erlaubt — sie liefen sonst ungefiltert ins Protokoll",
    );
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const bareHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

  if (bareHost === "localhost" || bareHost.endsWith(".localhost")) {
    throw new EgressBlockedError(
      `Host "${bareHost}" ist eine lokale Adresse und wird nicht abgerufen`,
    );
  }
  if (isPrivateIpv4(bareHost) || isPrivateIpv6(bareHost)) {
    throw new EgressBlockedError(
      `Host "${bareHost}" liegt im privaten/Loopback/Link-Local-Bereich; web.fetch ruft dort nichts ab (SSRF-Riegel)`,
    );
  }

  if (policy.allowlist.length === 0) {
    throw new EgressBlockedError(
      "Die Egress-Allowlist ist leer: web.fetch/web.search rufen ohne freigegebenen Host nichts ab. Hosts über WEB_EGRESS_ALLOWLIST freigeben.",
    );
  }
  if (!hostAllowed(policy, bareHost)) {
    throw new EgressBlockedError(
      `Host "${bareHost}" steht nicht auf der Egress-Allowlist (${policy.allowlist.join(", ")})`,
    );
  }

  return url;
}
