/**
 * Die Musterliste des Redaction-Filters (Architektur, Abschnitt 4.7).
 *
 * Bewusst eine eigene Datei mit einer einzigen Liste. Über den Code verstreute Prüfungen
 * wären nicht erweiterbar und, schlimmer, man sähe nirgends, was der Filter kann und was
 * nicht — und ein Filter, dessen Reichweite niemand überblickt, wird für sicher gehalten,
 * ohne es zu sein. Ein neuer Anbieter, ein neues Schlüsselformat: ein Eintrag hier, sonst
 * nichts.
 */

/**
 * Was statt des Geheimnisses dasteht. Der Regelname bleibt sichtbar, damit im Protokoll
 * erkennbar ist, *dass* und *warum* etwas ersetzt wurde. Ein spurloses Löschen wäre die
 * stille Variante und liefe dem Verbot aus AGENTS.md zuwider, Fehler zu verstecken.
 */
export function redactionMarker(id: string): string {
  return `[redacted:${id}]`;
}

export interface SecretPattern {
  /** Kurzname. Steht im Ersatztext. */
  id: string;
  /** Wozu das Muster da ist und woran es hängt. */
  description: string;
  /**
   * Muss das `g`-Flag tragen. Ohne es ersetzt `String.replace` nur den ersten Treffer, und
   * der zweite Schlüssel in derselben Zeichenkette stünde weiter im Klartext da. Das wird
   * beim Laden geprüft (siehe `assertPatternsUsable`), nicht der Sorgfalt überlassen.
   */
  pattern: RegExp;
  /**
   * Ersatztext. `$1`, `$2` … tragen die Teile, die stehen bleiben sollen: Schema, Benutzer,
   * `Bearer `. Ohne sie wäre die Zeile nach dem Filter nicht mehr zu deuten — und ein
   * Filter, der Fehlermeldungen unlesbar macht, wird über kurz oder lang abgeschaltet.
   */
  replacement: string;
}

/**
 * Reihenfolge ist Teil der Aussage: das Speziellere zuerst, damit der Ersatztext den
 * Anbieter benennen kann, das allgemeine Schlüssel-Wert-Muster zuletzt als Fangnetz.
 *
 * Bewusst **nicht** dabei: eine Entropie-Heuristik der Art "lange Zeichenkette ohne
 * Leerzeichen". Sie fräse genau die Felder weg, von denen das Protokoll lebt — SHA-256-
 * Prüfsummen, UUIDs, Artefakt-Handles — und ein Protokoll voller `[redacted]` an den
 * Stellen, an denen die Wahrheit stehen soll, ist kein Protokoll mehr. Erkannt wird, was
 * eine erkennbare Form hat.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    id: "private-key",
    description:
      "PEM-Block eines privaten Schlüssels. Steht zuerst, weil sein Rumpf Base64 ist und ihn die engeren Muster sonst zerstückelten.",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: redactionMarker("private-key"),
  },
  {
    id: "url-credentials",
    description:
      "Zugangsdaten in einer URL, also jeder Connection-String der Form <schema>://<benutzer>:<passwort>@<host>. Bewusst ohne Liste erlaubter Schemata: postgres, mysql, mongodb, redis, amqp und das nächste, das dazukommt, sehen alle gleich aus. Schema und Benutzer bleiben stehen, damit eine Verbindungsfehlermeldung noch etwas aussagt.",
    pattern: /\b([a-z][a-z0-9+.-]{1,31}:\/\/)([^\s:/@]{1,256}):([^\s/@]{1,256})@/gi,
    replacement: `$1$2:${redactionMarker("url-credentials")}@`,
  },
  {
    id: "jwt",
    description:
      'JSON Web Token: drei Base64url-Teile, der erste beginnt immer mit dem kodierten \'{"\' — also mit "eyJ".',
    pattern: /\beyJ[A-Za-z0-9_=-]{4,}\.[A-Za-z0-9_=-]{4,}\.[A-Za-z0-9_=-]*/g,
    replacement: redactionMarker("jwt"),
  },
  {
    id: "authorization-header",
    description:
      "Authorization-Header mit Bearer- oder Basic-Schema. Nur diese beiden: `Token` als freistehendes Wort kommt auch in gewöhnlichem Text vor.",
    pattern: /\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{8,})/g,
    replacement: `$1 ${redactionMarker("authorization-header")}`,
  },
  {
    id: "anthropic-api-key",
    description:
      "Anthropic-API-Schlüssel (ANTHROPIC_API_KEY, Abschnitt 11). Steht vor dem allgemeinen sk--Muster, damit der Ersatztext den Anbieter benennt.",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
    replacement: redactionMarker("anthropic-api-key"),
  },
  {
    id: "openai-api-key",
    description: "OpenAI-Schlüssel und alles Übrige in der Form sk-<token> bzw. sk-proj-<token>.",
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g,
    replacement: redactionMarker("openai-api-key"),
  },
  {
    id: "stripe-key",
    description: "Stripe: sk_live_/sk_test_ (geheim) und rk_live_/rk_test_ (eingeschränkt).",
    pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
    replacement: redactionMarker("stripe-key"),
  },
  {
    id: "github-token",
    description:
      "GitHub Personal Access Token und seine Verwandten (ghp_, gho_, ghu_, ghs_, ghr_).",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
    replacement: redactionMarker("github-token"),
  },
  {
    id: "slack-token",
    description: "Slack-Token (xoxb-, xoxp-, xoxa-, xoxe-, xoxr-, xoxs-).",
    pattern: /\bxox[abeprs]-[A-Za-z0-9-]{10,}/g,
    replacement: redactionMarker("slack-token"),
  },
  {
    id: "google-api-key",
    description: "Google-API-Schlüssel, feste Länge von 39 Zeichen inklusive Präfix.",
    pattern: /\bAIza[A-Za-z0-9_-]{35}/g,
    replacement: redactionMarker("google-api-key"),
  },
  {
    id: "aws-access-key-id",
    description:
      "AWS Access Key ID. Der zugehörige Secret Access Key hat kein eigenes Format und wird vom Schlüssel-Wert-Muster unten gefangen.",
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AIPA|ANPA|ANVA|APKA|AROA)[A-Z0-9]{16}\b/g,
    replacement: redactionMarker("aws-access-key-id"),
  },
  {
    id: "npm-token",
    description: "npm-Zugriffstoken, feste Länge.",
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/g,
    replacement: redactionMarker("npm-token"),
  },
  {
    id: "credential-field",
    description:
      "Fangnetz für Schlüssel-Wert-Paare in freiem Text: `password=…`, `api_key: …`, `Password=…;` aus einem ADO-Connection-String. Greift dort, wo der Wert kein bekanntes Format hat — beim Anbieter also, dessen Präfix in dieser Liste noch fehlt. Steht zuletzt, damit die benannten Muster oben zuerst zum Zug kommen. Der Feldname bleibt stehen, nur der Wert verschwindet.",
    // Die drei Absicherungen um die Wertgruppe herum sind kein Zierrat, sie beheben einen
    // gemessenen Fehler: `Authorization: Bearer <schlüssel>` wird oben zu
    // `Authorization: Bearer [redacted:authorization-header]`, und dieses Fangnetz nahm
    // danach das Wort `Bearer` als Wert und ersetzte es gleich mit. Kein Leck, aber der
    // Ersatztext log über die Regel, die tatsächlich gegriffen hatte.
    //   (?!\[redacted:)      — nicht auf einem schon gesetzten Ersatztext ansetzen
    //   (?![^\s"',;)}\]])    — der Wert endet an einem Trenner; ohne das kürzte das
    //                          Backtracking `Bearer` still zu `Beare` und ersetzte das
    //   (?!\s*\[redacted:)   — nicht greifen, wo direkt dahinter schon gefiltert wurde
    //
    // Vorne steht `(?<![A-Za-z0-9])` statt `\b`, und das ist eine in S11 nachgetragene
    // Korrektur an einem gemessenen Leck: `\b` setzt keine Grenze zwischen `_` und einem
    // Buchstaben, weil der Unterstrich selbst ein Wortzeichen ist. Damit griff das Fangnetz
    // auf `api_key=…`, aber **nicht** auf `ANTHROPIC_API_KEY=…` — also ausgerechnet nicht auf
    // die Schreibweise, in der Geheimnisse tatsächlich in `.env`-Dateien und Umgebungen
    // stehen. Die Lookbehind-Fassung lässt einen führenden Namensteil zu (`FOO_API_KEY`,
    // `db-password`) und weist einen Wortanfang weiterhin ab (`monkey:` bleibt in Ruhe, weil
    // vor `key` ein Buchstabe steht).
    pattern:
      /(?<![A-Za-z0-9])(password|passwd|passphrase|pwd|secret|api[_-]?key|api[_-]?secret|access[_-]?key(?:[_-]?id)?|secret[_-]?access[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|client[_-]?secret|private[_-]?key|credentials?|authorization|token)(\s*[:=]\s*"?)(?!\[redacted:)([^\s"',;)}\]]{1,4096})(?![^\s"',;)}\]])(?!\s*\[redacted:)/gi,
    replacement: `$1$2${redactionMarker("credential-field")}`,
  },
] as const;

/**
 * Feldnamen, deren **Wert** unabhängig von seiner Form verschwindet.
 *
 * Der Grund dafür, dass es diese zweite Liste überhaupt gibt: `{ "api_key": "hunter2" }`
 * enthält kein erkennbares Schlüsselformat. Über den Wert allein ist dieses Geheimnis nicht
 * zu finden — wohl aber über den Namen, unter dem es abgelegt wurde.
 *
 * Verglichen wird der auf Kleinbuchstaben und Ziffern normalisierte Name, `API_KEY`,
 * `api-key` und `apiKey` sind damit derselbe Eintrag.
 */
export const SECRET_FIELD_NAMES: ReadonlySet<string> = new Set([
  "password",
  "passwd",
  "passphrase",
  "pwd",
  "secret",
  "secretkey",
  "clientsecret",
  "apikey",
  "apisecret",
  "accesskey",
  "accesskeyid",
  "secretaccesskey",
  "privatekey",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "authtoken",
  "bearertoken",
  "sessiontoken",
  "authorization",
  "auth",
  "credential",
  "credentials",
  "cookie",
  "setcookie",
  "dsn",
  "connectionstring",
  "databaseurl",
  "anthropicapikey",
]);

/**
 * Endungen, die einen Feldnamen auch dann verdächtig machen, wenn er nicht wörtlich oben
 * steht: `db_password`, `smtp_auth_token`, `stripe_api_key`.
 *
 * Kurz gehalten und ohne `key`. Mit `key` fiele `idempotency_key` mit hinein — der
 * Schlüssel, an dem seit S05 die gesamte Wiederaufnahme hängt. Sein Wert im Protokoll
 * ersetzt hieße: Replay bricht, und zwar leise. Genau diese Art von Kollateralschaden ist
 * der Grund, warum hier exakte Namen und eine kurze Endungsliste stehen und keine
 * Ähnlichkeitsheuristik.
 */
export const SECRET_FIELD_SUFFIXES: readonly string[] = [
  "password",
  "passwd",
  "passphrase",
  "secret",
  "apikey",
  "accesskey",
  "privatekey",
  "token",
  "credentials",
  "authorization",
];

/** `API_KEY`, `api-key`, `apiKey` → `apikey`. */
export function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Trägt dieser Feldname ein Geheimnis, egal wie sein Wert aussieht? */
export function isSecretFieldName(name: string): boolean {
  const normalized = normalizeFieldName(name);
  if (SECRET_FIELD_NAMES.has(normalized)) return true;
  return SECRET_FIELD_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

/**
 * Prüft beim Laden des Moduls, dass jedes Muster global ist und einen eindeutigen Namen
 * trägt. Ein vergessenes `g` ist der teuerste Fehler in dieser Datei: der Filter sieht
 * weiter aus, als täte er seine Arbeit, ersetzt aber nur den jeweils ersten Treffer. Solche
 * Zusagen gehören nicht in einen Kommentar, sondern in eine Prüfung.
 */
export function assertPatternsUsable(patterns: readonly SecretPattern[] = SECRET_PATTERNS): void {
  const seen = new Set<string>();
  for (const entry of patterns) {
    if (!entry.pattern.global) {
      throw new Error(
        `Redaction-Muster "${entry.id}" hat kein g-Flag und ersetzte nur den ersten Treffer je Zeichenkette`,
      );
    }
    if (seen.has(entry.id)) {
      throw new Error(`Redaction-Muster "${entry.id}" ist doppelt vergeben`);
    }
    seen.add(entry.id);
  }
}

assertPatternsUsable();
