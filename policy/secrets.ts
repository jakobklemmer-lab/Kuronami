/**
 * Geheimnisklassen — die vierte Achse der statischen Regeln aus Abschnitt 10 ("Allow/Deny/Ask
 * nach Tool, Pfad, Domain, **Geheimnisklasse**").
 *
 * Das hier ist die Ergänzung zum Redaction-Filter aus S07, nicht sein Ersatz. Die beiden
 * greifen an verschiedenen Stellen und keiner von ihnen kann die Arbeit des anderen tun:
 *
 *   * Der Filter (`runtime/redaction/`) sieht **Werte**, die schon gelesen wurden, und
 *     ersetzt sie, bevor sie ins Protokoll, in ein Artefakt oder in den Prompt gehen. Er
 *     verhindert das Durchsickern, nicht den Zugriff.
 *   * Diese Liste sieht **Träger**: Dateien, deren Inhalt per Bauart ein Geheimnis ist. Sie
 *     entscheidet vor dem Lesen mit und macht den Zugriff protokollpflichtig
 *     (`policy.secret_accessed`).
 *
 * Ohne die zweite Hälfte wäre "Secrets erreichen nie den Prompt" eine Aussage über die
 * Vollständigkeit der Musterliste in `patterns.ts`. Ein Wert, der dort nicht steht — ein
 * Firmen-Token in einem eigenen Format, ein Passwort ohne erkennbare Form — käme durch. Mit
 * ihr braucht es zusätzlich eine bewusste Freigabe, um die Datei überhaupt zu öffnen.
 */

export interface SecretClass {
  /** Kurzname, steht im Freigabepfad, im Subjektschlüssel und in `policy.secret_accessed`. */
  id: string;
  description: string;
  /** Geprüft gegen den anzeigbaren Pfad (relativ zur Quellzone, `/` als Trenner). */
  patterns: RegExp[];
}

/**
 * Die Klassen. Erweiterbar wie `runtime/redaction/patterns.ts` und aus demselben Grund als
 * eigene, versionierte Datei: Reichweite ändert man durch eine sichtbare Änderung hier, nicht
 * durch ein Aufrufargument.
 *
 * Bewusst **keine** Inhaltsheuristik ("Datei sieht nach Zugangsdaten aus"). Eine Datei, die
 * erst gelesen werden muss, um als geheim zu gelten, ist zum Zeitpunkt der Entscheidung schon
 * gelesen. Erkannt wird am Pfad, und der steht vor dem ersten Byte fest.
 */
export const SECRET_CLASSES: SecretClass[] = [
  {
    id: "dotenv",
    description: "Umgebungsdateien: .env und ihre Varianten.",
    patterns: [/(^|\/)\.env(\.[^/]+)?$/i, /(^|\/)\.envrc$/i],
  },
  {
    id: "private-key",
    description: "Private Schlüssel und Zertifikatsbündel.",
    patterns: [/\.(pem|key|p12|pfx|jks|keystore)$/i, /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i],
  },
  {
    id: "ssh",
    description: "SSH-Konfiguration und -Schlüsselverzeichnis.",
    patterns: [/(^|\/)\.ssh(\/|$)/i],
  },
  {
    id: "cloud-credentials",
    description: "Zugangsdaten von Cloud- und Paketwerkzeugen.",
    patterns: [
      /(^|\/)\.(aws|gcloud|azure|kube|docker)(\/|$)/i,
      /(^|\/)\.(npmrc|pypirc|netrc|pgpass)$/i,
      /(^|\/)credentials(\.[^/]+)?$/i,
      /(^|\/)service[-_]account.*\.json$/i,
    ],
  },
  {
    id: "token-store",
    description: "Abgelegte Sitzungen, Token und Passwortspeicher.",
    patterns: [/\.(kdbx|keychain)$/i, /(^|\/)(secrets?|tokens?)\.(json|ya?ml|toml|txt)$/i],
  },
];

/**
 * Vorlagen. Sie sehen aus wie Träger, sind aber genau das Gegenteil: Dateien, die im Repo
 * liegen **sollen**, damit jemand weiß, welche Schlüssel er setzen muss. `.env.example` steht
 * seit S01 in diesem Repo.
 *
 * Ohne diese Ausnahme wäre jedes Lesen von `.env.example` freigabepflichtig — eine Rückfrage
 * für eine Datei ohne ein einziges Geheimnis. Und eine Rückfrage, die offensichtlich unnötig
 * ist, ist teurer als keine: sie bringt dem Menschen bei, die nächste auch wegzuklicken.
 */
const TEMPLATE_PATTERNS: RegExp[] = [
  /(^|\/)\.env\.(example|sample|template|dist|defaults?)(\.[^/]*)?$/i,
  /(^|\/)credentials\.(example|sample|template)(\.[^/]*)?$/i,
];

/**
 * Die Geheimnisklasse eines Pfades, oder `null`. Der **erste** Treffer gewinnt; die Klassen
 * sind fachlich getrennt, eine Datei gehört zu höchstens einer, und eine Liste aller Treffer
 * hätte nur den Subjektschlüssel mehrdeutig gemacht.
 */
export function classifySecret(displayPath: string): string | null {
  if (TEMPLATE_PATTERNS.some((pattern) => pattern.test(displayPath))) return null;

  for (const secretClass of SECRET_CLASSES) {
    if (secretClass.patterns.some((pattern) => pattern.test(displayPath))) {
      return secretClass.id;
    }
  }
  return null;
}

/**
 * Jedes Muster ist ohne `g` gebaut, weil `test` auf einem globalen Regex einen Zustand
 * (`lastIndex`) mitschleppt und beim zweiten Aufruf mit demselben Pfad `false` liefern kann.
 * Genau ein solcher Fehler wäre still: die erste `.env` würde erkannt, die zweite nicht. Die
 * Prüfung läuft beim Laden des Moduls, nach dem Muster von `assertPatternsUsable` (S07) und
 * `assertInjectionPatternsUsable` (S09).
 */
export function assertSecretPatternsUsable(): void {
  const groups: [string, RegExp[]][] = [
    ...SECRET_CLASSES.map((entry): [string, RegExp[]] => [entry.id, entry.patterns]),
    ["vorlagen", TEMPLATE_PATTERNS],
  ];
  for (const [id, patterns] of groups) {
    for (const pattern of patterns) {
      if (pattern.global || pattern.sticky) {
        throw new Error(
          `Geheimnisklasse "${id}": Muster ${pattern} trägt g oder y. Diese Muster laufen über test() und dürfen keinen lastIndex mitschleppen.`,
        );
      }
    }
  }
}

assertSecretPatternsUsable();
