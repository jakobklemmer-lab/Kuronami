import { describe, expect, it } from "vitest";
import {
  SECRET_PATTERNS,
  assertPatternsUsable,
  isSecretFieldName,
  normalizeFieldName,
} from "./patterns.js";
import { RedactionCycleError, redactText, redactValue } from "./redact.js";

/** Erfundener Schlüssel in echter Form. Steht so in keinem Konto. */
const FAKE_ANTHROPIC_KEY =
  "sk-ant-api03-Aa0Bb1Cc2Dd3Ee4Ff5Gg6Hh7Ii8Jj9Kk0Ll1Mm2Nn3Oo4Pp5Qq6Rr7Ss8Tt9-TESTONLY";

describe("Redaction-Filter · Muster", () => {
  it("hält jedes Muster für global und eindeutig benannt", () => {
    // Die Zusage aus patterns.ts, hier noch einmal als Test: ein vergessenes g-Flag ist der
    // Fehler, der den Filter arbeitsfähig aussehen lässt und trotzdem durchlässt.
    expect(() => assertPatternsUsable()).not.toThrow();
    expect(SECRET_PATTERNS.every((entry) => entry.pattern.global)).toBe(true);
    expect(new Set(SECRET_PATTERNS.map((entry) => entry.id)).size).toBe(SECRET_PATTERNS.length);
  });

  it("ersetzt die bekannten Schlüsselformate", () => {
    const cases: [string, string][] = [
      [FAKE_ANTHROPIC_KEY, "anthropic-api-key"],
      ["sk-proj-Aa0Bb1Cc2Dd3Ee4Ff5Gg6Hh7Ii8Jj9Kk0", "openai-api-key"],
      ["sk_live_Aa0Bb1Cc2Dd3Ee4Ff5Gg6", "stripe-key"],
      ["ghp_Aa0Bb1Cc2Dd3Ee4Ff5Gg6Hh7Ii8Jj9Kk0Ll1", "github-token"],
      ["xoxb-1234567890-0987654321-AaBbCcDdEeFf", "slack-token"],
      ["AIzaSyA0Bb1Cc2Dd3Ee4Ff5Gg6Hh7Ii8Jj9Kk0L", "google-api-key"],
      ["AKIAIOSFODNN7EXAMPLE", "aws-access-key-id"],
      ["npm_Aa0Bb1Cc2Dd3Ee4Ff5Gg6Hh7Ii8Jj9Kk0Ll1", "npm-token"],
      ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r0", "jwt"],
    ];

    for (const [secret, expectedRule] of cases) {
      const line = `Aufruf mit ${secret} fehlgeschlagen`;
      const filtered = redactText(line);
      expect(filtered, `${expectedRule} muss greifen`).not.toContain(secret);
      expect(filtered).toContain(`[redacted:${expectedRule}]`);
      // Der Rest der Zeile bleibt lesbar: ein Filter, der Fehlermeldungen unbrauchbar macht,
      // wird abgeschaltet.
      expect(filtered.startsWith("Aufruf mit ")).toBe(true);
      expect(filtered.endsWith(" fehlgeschlagen")).toBe(true);
    }
  });

  it("nimmt aus einem Connection-String das Passwort und lässt Schema, Benutzer und Host stehen", () => {
    const filtered = redactText("postgres://kuronami:hunter2@localhost:5432/kuronami");
    expect(filtered).not.toContain("hunter2");
    expect(filtered).toBe("postgres://kuronami:[redacted:url-credentials]@localhost:5432/kuronami");

    // Ohne Schema-Liste: ein Dienst, den es beim Schreiben dieser Datei noch nicht gab,
    // sieht genauso aus.
    expect(redactText("clickhouse+native://svc:s3cr3t@db.intern:9000")).not.toContain("s3cr3t");
    expect(redactText("Password=hunter2;Server=db.intern")).not.toContain("hunter2");
  });

  it("ersetzt alle Vorkommen in einer Zeichenkette, nicht nur das erste", () => {
    const line = `erst ${FAKE_ANTHROPIC_KEY} und dann noch einmal ${FAKE_ANTHROPIC_KEY}`;
    const filtered = redactText(line);
    expect(filtered).not.toContain(FAKE_ANTHROPIC_KEY);
    expect(filtered.split("[redacted:anthropic-api-key]")).toHaveLength(3);
  });

  it("ist wiederholbar: gefilterter Text bleibt beim zweiten Lauf gleich", () => {
    // Ereignisse laufen durch mehrere Tore (Artefakt-Metadaten, dann das Protokoll). Fräse
    // der Filter an seinen eigenen Ersatztexten weiter, verlöre der Text mit jedem Tor mehr.
    const once = redactText(`key=${FAKE_ANTHROPIC_KEY} url=postgres://u:p@h/db`);
    expect(redactText(once)).toBe(once);
  });

  it("greift in einen Authorization-Header und lässt das Schema stehen", () => {
    expect(redactText(`Authorization: Bearer ${FAKE_ANTHROPIC_KEY}`)).toBe(
      "Authorization: Bearer [redacted:authorization-header]",
    );
  });

  it("greift auch auf Umgebungsvariablen-Schreibweise mit Präfix", () => {
    // In S11 gemessenes Leck: `\b` setzt keine Grenze zwischen `_` und einem Buchstaben, weil
    // der Unterstrich ein Wortzeichen ist. `api_key=…` wurde ersetzt, `ANTHROPIC_API_KEY=…`
    // nicht — also ausgerechnet die Schreibweise, in der Geheimnisse in .env-Dateien stehen.
    // Gefunden hat es der S11-Test, der eine echte .env liest.
    for (const line of [
      "ANTHROPIC_API_KEY=abc123nichtsBesonderes",
      "OPENAI_API_KEY: abc123",
      "DB_PASSWORD=hunter2",
      "MY_ACCESS_TOKEN=xyz",
    ]) {
      const filtered = redactText(line);
      expect(filtered).toContain("[redacted:credential-field]");
      expect(filtered).not.toMatch(/abc123|hunter2|xyz/);
    }
  });

  it("lässt ein Wort in Ruhe, das nur zufällig auf einen Feldnamen endet", () => {
    // Die Gegenprobe zur Lockerung oben: die Grenze fällt nur für `_` und `-`, nicht für
    // Buchstaben. Sonst wäre `monkey:` ein Geheimnis.
    expect(redactText("monkey: banane")).toBe("monkey: banane");
    expect(redactText("Turmfalke: Vogel")).toBe("Turmfalke: Vogel");
  });

  it("nimmt einen PEM-Block im Ganzen", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEAtZ3n0Kt7mKQm8v0R2Yh4",
      "9j2mKQm8v0R2Yh49j2mKQm8v0R2Yh49j2mKQ",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const filtered = redactText(`Schlüssel:\n${pem}\nEnde`);
    expect(filtered).toBe("Schlüssel:\n[redacted:private-key]\nEnde");
  });
});

describe("Redaction-Filter · Feldnamen", () => {
  it("erkennt geheime Feldnamen unabhängig von der Schreibweise", () => {
    for (const name of [
      "api_key",
      "API-KEY",
      "apiKey",
      "password",
      "DATABASE_URL",
      "db_password",
    ]) {
      expect(isSecretFieldName(name), name).toBe(true);
    }
    expect(normalizeFieldName("ANTHROPIC_API_KEY")).toBe("anthropicapikey");
  });

  it("lässt die Felder in Ruhe, von denen das Protokoll lebt", () => {
    // Das ist die eigentliche Gefahr dieser zweiten Liste. `idempotency_key` endet auf
    // "key" — nähme die Endungsliste `key` mit auf, verlöre das Protokoll den Schlüssel, an
    // dem seit S05 die gesamte Wiederaufnahme hängt, und zwar lautlos.
    for (const name of [
      "idempotency_key",
      "sha256",
      "session_id",
      "step_id",
      "artifact_id",
      "uri",
      "tool_name",
      "artifact_refs",
      "size_bytes",
      "mime_type",
      "summary",
      "thread_id",
      "runtime_id",
      "approval_mode",
      "tool_catalog_version",
    ]) {
      expect(isSecretFieldName(name), name).toBe(false);
    }
  });

  it("ersetzt den Wert eines geheimen Feldes unabhängig von seiner Form", () => {
    // "hunter2" trägt kein erkennbares Format. Über den Wert allein wäre es nicht zu finden.
    const filtered = redactValue({
      api_key: "hunter2",
      password: 1234,
      harmlos: "hunter2",
    }) as Record<string, unknown>;
    expect(filtered.api_key).toBe("[redacted:secret-field]");
    expect(filtered.password).toBe("[redacted:secret-field]");
    expect(filtered.harmlos).toBe("hunter2");
  });

  it("lässt null und undefined unter geheimen Feldnamen stehen", () => {
    // Ein Marker statt null änderte die Form, ohne etwas zu schützen.
    expect(redactValue({ token: null, secret: undefined })).toEqual({
      token: null,
      secret: undefined,
    });
  });
});

describe("Redaction-Filter · Rekursion", () => {
  it("steigt durch verschachtelte Objekte und Arrays", () => {
    const filtered = redactValue({
      level1: {
        list: [
          { harmlos: "ok" },
          { tief: { tiefer: [`Aufruf mit ${FAKE_ANTHROPIC_KEY}`] } },
          ["auch im Array", `${FAKE_ANTHROPIC_KEY}`],
        ],
      },
    });

    const asText = JSON.stringify(filtered);
    expect(asText).not.toContain(FAKE_ANTHROPIC_KEY);
    expect(asText).toContain("[redacted:anthropic-api-key]");
    expect(asText).toContain("auch im Array");
    expect(asText).toContain("ok");
  });

  it("filtert auch den Schlüssel eines Objekts, nicht nur den Wert", () => {
    const filtered = redactValue({ [FAKE_ANTHROPIC_KEY]: "Metadaten dazu" }) as Record<
      string,
      unknown
    >;
    expect(Object.keys(filtered)).toEqual(["[redacted:anthropic-api-key]"]);
  });

  it("lässt Zahlen, Wahrheitswerte, null und Datumsangaben unverändert", () => {
    const date = new Date("2026-09-05T12:00:00.000Z");
    expect(redactValue({ a: 1, b: true, c: null, d: date })).toEqual({
      a: 1,
      b: true,
      c: null,
      // Date bestimmt über toJSON selbst, was von ihm in JSON landet; gefiltert wird das
      // Ergebnis, weil der Schreiber genau das serialisiert.
      d: "2026-09-05T12:00:00.000Z",
    });
  });

  it("lässt Bytes unangetastet", () => {
    const bytes = Buffer.from([0, 1, 2, 255]);
    const filtered = redactValue({ bytes }) as { bytes: Buffer };
    expect(filtered.bytes).toBe(bytes);
  });

  it("erlaubt denselben Teilbaum zweimal, bricht aber bei einem Zyklus ab", () => {
    const shared = { wert: "harmlos" };
    expect(redactValue({ a: shared, b: shared })).toEqual({ a: shared, b: shared });

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => redactValue(cyclic)).toThrow(RedactionCycleError);
  });

  it("lässt einen echten Ereignis-Payload aus S05/S06 unverändert", () => {
    // Die Gegenrichtung des Tests darüber: der Filter darf das Protokoll nicht beschädigen.
    // Ein Stacktrace mit absoluten Pfaden, eine SHA-256-Prüfsumme, ein Artefakt-Handle und
    // ein Idempotenzschlüssel müssen wörtlich stehen bleiben.
    const payload = {
      step_id: "step_5f2b1c9e-7d3a-4c1b-9f0e-2a6d8b4c1e7f",
      idempotency_key: "tool:call_42",
      attempt: 2,
      artifact_id: "artifact_9c1d2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f",
      uri: "artifact://sess_1a2b3c4d/artifact_9c1d2e3f",
      sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      size_bytes: 51_200,
      mime_type: "application/json",
      source: { tool: "web.fetch", session_id: "sess_1a2b3c4d", step_id: null },
      error:
        "StepTimeoutError: Schritt step_5f2b hat das Zeitfenster von 60000 ms überschritten\n    at runEffect (P:\\Kuronami\\runtime\\steps\\hull.ts:399:9)",
      effect_outcome: "unknown",
      effect_still_running: true,
    };
    expect(redactValue(payload)).toEqual(payload);
  });
});
