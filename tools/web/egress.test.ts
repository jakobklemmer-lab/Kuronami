import { describe, expect, it } from "vitest";
import {
  EgressBlockedError,
  EgressUrlError,
  assertEgressAllowed,
  buildEgressPolicy,
} from "./egress.js";

/**
 * Die Egress-Allowlist ohne Datenbank — der harte Riegel für S09, nach dem Muster von
 * `tools/fs/paths.test.ts`.
 */

const policy = buildEgressPolicy({ allowlist: ["example.com", "api.allowed.test"] });

describe("egress · Schema und Zugangsdaten", () => {
  it("lässt http und https auf einem freigegebenen Host durch", () => {
    expect(assertEgressAllowed(policy, "https://example.com/pfad?q=1").href).toBe(
      "https://example.com/pfad?q=1",
    );
    expect(assertEgressAllowed(policy, "http://example.com/").protocol).toBe("http:");
  });

  it("weist andere Schemata ab", () => {
    for (const url of [
      "ftp://example.com/x",
      "file:///etc/passwd",
      "data:text/plain,hi",
      "ws://example.com",
    ]) {
      expect(() => assertEgressAllowed(policy, url)).toThrow(EgressUrlError);
    }
  });

  it("weist Zugangsdaten in der URL ab", () => {
    expect(() => assertEgressAllowed(policy, "https://user:pass@example.com/")).toThrow(
      EgressUrlError,
    );
  });

  it("weist Müll und relative Eingaben ab", () => {
    for (const url of ["", "   ", "not a url", "/nur/pfad", "example.com/ohne/schema"]) {
      expect(() => assertEgressAllowed(policy, url)).toThrow(EgressUrlError);
    }
  });
});

describe("egress · Allowlist", () => {
  it("deckt Subdomains eines Eintrags mit ab", () => {
    expect(assertEgressAllowed(policy, "https://docs.example.com/a").hostname).toBe(
      "docs.example.com",
    );
    expect(assertEgressAllowed(policy, "https://deep.sub.example.com/a").hostname).toBe(
      "deep.sub.example.com",
    );
  });

  it("matcht nur auf Punktgrenze, nicht als bloßes Suffix", () => {
    expect(() => assertEgressAllowed(policy, "https://notexample.com/")).toThrow(
      EgressBlockedError,
    );
    expect(() => assertEgressAllowed(policy, "https://evil-example.com/")).toThrow(
      EgressBlockedError,
    );
  });

  it("weist einen nicht freigegebenen Host ab", () => {
    expect(() => assertEgressAllowed(policy, "https://evil.test/")).toThrow(EgressBlockedError);
  });

  it("erlaubt exakt den freigegebenen Unterhost", () => {
    expect(assertEgressAllowed(policy, "https://api.allowed.test/v1").hostname).toBe(
      "api.allowed.test",
    );
    // Der Elternhost ist damit NICHT automatisch frei.
    expect(() => assertEgressAllowed(policy, "https://allowed.test/")).toThrow(EgressBlockedError);
  });

  it("eine leere Allowlist erlaubt nichts (deny-by-default)", () => {
    const empty = buildEgressPolicy({ allowlist: [] });
    expect(() => assertEgressAllowed(empty, "https://example.com/")).toThrow(EgressBlockedError);
  });

  it("normalisiert Allowlist-Einträge (Groß/Klein, führendes *. und .)", () => {
    const p = buildEgressPolicy({ allowlist: ["  *.Example.COM ", ".foo.test", "foo.test"] });
    expect(assertEgressAllowed(p, "https://a.example.com/").hostname).toBe("a.example.com");
    expect(assertEgressAllowed(p, "https://foo.test/").hostname).toBe("foo.test");
  });
});

describe("egress · SSRF-Riegel gegen lokale Adressen", () => {
  const open = buildEgressPolicy({
    allowlist: ["example.com", "127.0.0.1", "10.0.0.5", "localhost"],
  });

  it("weist Loopback, RFC-1918, CGNAT und Link-Local ab — auch wenn sie auf der Allowlist stünden", () => {
    for (const url of [
      "http://127.0.0.1/",
      "http://127.9.9.9/",
      "http://10.0.0.5/x",
      "http://192.168.1.1/",
      "http://172.16.5.4/",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.100.0.1/",
      "http://0.0.0.0/",
    ]) {
      expect(() => assertEgressAllowed(open, url), url).toThrow(EgressBlockedError);
    }
  });

  it("weist localhost und *.localhost ab", () => {
    expect(() => assertEgressAllowed(open, "http://localhost:8080/")).toThrow(EgressBlockedError);
    expect(() => assertEgressAllowed(open, "http://db.localhost/")).toThrow(EgressBlockedError);
  });

  it("weist IPv6-Loopback und Unique-Local ab", () => {
    expect(() => assertEgressAllowed(open, "http://[::1]/")).toThrow(EgressBlockedError);
    expect(() => assertEgressAllowed(open, "http://[fd00::1]/")).toThrow(EgressBlockedError);
    expect(() => assertEgressAllowed(open, "http://[fe80::1]/")).toThrow(EgressBlockedError);
  });

  it("lässt eine freigegebene öffentliche Adresse in Ruhe", () => {
    // Der Riegel greift nur bei privaten/lokalen Bereichen, nicht pauschal bei IP-Literalen.
    const withPublic = buildEgressPolicy({ allowlist: ["93.184.216.34"] });
    expect(assertEgressAllowed(withPublic, "http://93.184.216.34/").hostname).toBe("93.184.216.34");
  });
});
